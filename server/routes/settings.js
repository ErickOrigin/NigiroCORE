// ===== Settings & maintenance: prefs, db-backup, adb-status, profiles, integrity, disk, verify =====
import { Router, json } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { db, getSetting, setSetting, backupDB } from "../db.js";
import { adb } from "../adb.js";
import { volumeRoots } from "./volumes.js";
import { THUMB_DIR, videoThumb } from "./gallery.js";
import { guessMime, absPath, relPath } from "../util.js";

const r = Router();

// ===== Disk usage HDD =====
r.get("/disk", (_req, res) => {
  let st = null;
  try { st = fs.statfsSync(process.env.STORAGE_PATH); } catch {} // volume offline → 0, jangan crash
  const total = st ? st.blocks * st.bsize : 0, free = st ? st.bfree * st.bsize : 0;
  res.json({ total, free, used: total - free });
});

// Verify Vault: cocokkan DB vs file fisik — tahu file hilang SEBELUM bencana
r.get("/verify", (_req, res) => {
  const rows = db.prepare("SELECT id, local_path, size, volume FROM files").all();
  const missing = [], sizeMismatch = [];
  // per volume: offline detection (root tak bisa di-stat = disk dicabut)
  const volStats = {};
  for (const v of volumeRoots()) {
    try { const st = fs.statfsSync(v.root); volStats[v.name] = { online: true, free: st.bfree * st.bsize, total: st.blocks * st.bsize }; }
    catch { volStats[v.name] = { online: false }; }
  }
  for (const row of rows) {
    const fp = absPath(row.local_path);
    if (!fs.existsSync(fp)) { missing.push({ id: row.id, path: row.local_path, volume: row.volume ?? "main" }); continue; }
    const actual = fs.statSync(fp).size;
    if (actual !== row.size) sizeMismatch.push({ id: row.id, path: row.local_path, expected: row.size, actual });
  }
  res.json({ total: rows.length, ok: rows.length - missing.length - sizeMismatch.length, missing, sizeMismatch, volumes: volStats, checkedAt: Date.now() });
});

// ===== Rescan Vault: file manual via Explorer masuk DB (job-based, sama pola integrity) =====
// file di vault yang belum terdaftar di DB -> import: checksum + EXIF + thumb, dedup via checksum
const rescanJob = { running: false, done: 0, total: 0, imported: 0, dupes: 0, failed: 0, log: [], finishedAt: null };

r.post("/rescan", (_req, res) => {
  if (rescanJob.running) return res.status(409).json({ error: "Rescan Already Running" });
  rescanJob.running = true;
  rescanJob.done = 0; rescanJob.imported = 0; rescanJob.dupes = 0; rescanJob.failed = 0;
  rescanJob.log = []; rescanJob.finishedAt = null;
  res.json({ started: true });
  (async () => {
    try {
      const storagePath = path.resolve(process.env.STORAGE_PATH ?? "");
      // scope rescan: folder profile/ saja — situ satu-satunya vault sah.
      // STORAGE_PATH juga berisi Apps/java/minecraft dll yang BUKAN vault — jangan disentuh.
      const profileRoot = path.resolve(storagePath, "profile");
      const profileRows = db.prepare("SELECT id, name FROM profiles").all();
      // map: <lowercase path folder profile> -> profileId  (file di bawah profile/<Nama>/ milik profile itu)
      const profByDir = profileRows.map(p => ({ id: p.id, dir: path.resolve(profileRoot, p.name.replace(/[\\/:*?"<>|]/g, "_")).toLowerCase() }));
      // 1. kumpulkan semua file fisik yang belum terdaftar di DB (by local_path)
      const known = new Set(db.prepare("SELECT local_path FROM files").all().map(x => path.resolve(x.local_path).toLowerCase()));
      const candidates = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name.startsWith(".") || /^\d{4}$/.test(e.name)) continue; // skip .trash/.thumbs/recycle
            walk(p);
          } else {
            if (p.toLowerCase().includes("thumb") || known.has(path.resolve(p).toLowerCase())) continue;
            candidates.push(p);
          }
        }
      };
      try { walk(profileRoot); } catch {}
      rescanJob.total = candidates.length;
      const insertStmt = db.prepare(`INSERT OR IGNORE INTO files (device_path, original_name, mime, size, mtime, local_path, checksum, lat, lng, width, height, volume, profile_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const p of candidates) {
        try {
          const st = fs.statSync(p);
          if (!st.size) { rescanJob.failed++; rescanJob.log.push(`SKIP EMPTY: ${p}`); rescanJob.done++; continue; }
          const buf = fs.readFileSync(p);
          const checksum = crypto.createHash("sha1").update(buf).digest("hex");
          // dedup: checksum sudah ada di DB = file sama (copy manual) -> jangan insert
          if (db.prepare("SELECT id FROM files WHERE checksum = ?").get(checksum)) {
            rescanJob.dupes++;
            rescanJob.log.push(`DUP: ${p} (checksum sama dengan file terdaftar)`);
            rescanJob.done++;
            continue;
          }
          // profile: cari folder profile/<Nama> di path — fallback profile aktif
          const lower = path.resolve(p).toLowerCase();
          const prof = profByDir.find(x => lower.startsWith(x.dir + path.sep)) ?? { id: Number(getSetting("activeProfile", "1")) };
          // device_path sintetis (file bukan dari HP): /manual/<relpath dari folder profile itu>
          const profDir = profByDir.find(x => x.id === prof.id)?.dir;
          const relInProfile = profDir ? path.relative(profDir, p).replaceAll("\\", "/") : path.basename(p);
          let lat = null, lng = null, width = null, height = null;
          try {
            if (/\.(jpe?g|png|webp|heic)$/i.test(p)) {
              const meta = await exifr.parse(buf, { gps: true, tiff: true });
              if (meta) {
                if (meta.latitude != null) { lat = meta.latitude; lng = meta.longitude; }
                width = meta.ExifImageWidth ?? meta.ImageWidth ?? null;
                height = meta.ExifImageHeight ?? meta.ImageHeight ?? null;
              }
            }
          } catch {}
          const vol = volumeRoots().find(v => path.resolve(p).toLowerCase().startsWith(path.resolve(v.root).toLowerCase()));
          insertStmt.run("/manual/" + relInProfile, path.basename(p), guessMime(p), st.size, Math.floor(st.mtimeMs / 1000), relPath(p), checksum, lat, lng, width, height, vol?.name ?? "main", prof.id);
          const fileId = db.prepare("SELECT id FROM files WHERE checksum = ?").get(checksum)?.id;
          // thumbnail (pola sama dengan backup)
          if (fileId) {
            fs.mkdirSync(THUMB_DIR, { recursive: true });
            const thumbPath = path.join(THUMB_DIR, fileId + ".webp");
            if (/\.(jpe?g|png|webp|heic|gif|bmp)$/i.test(p)) {
              try {
                const thumb = await sharp(buf).rotate().resize(250, 250, { fit: "inside" }).webp({ quality: 80 }).toBuffer();
                fs.writeFileSync(thumbPath + ".tmp", thumb);
                fs.renameSync(thumbPath + ".tmp", thumbPath);
              } catch {}
            } else if (/\.(mp4|mov|mkv|avi|3gp)$/i.test(p)) {
              videoThumb(p, thumbPath).catch(() => {});
            }
          }
          rescanJob.imported++;
          rescanJob.log.push(`IMPORTED: ${p}`);
        } catch (e) {
          rescanJob.failed++;
          rescanJob.log.push(`FAILED: ${p} — ${e.message.split("\n")[0]}`);
        }
        rescanJob.done++;
        if (rescanJob.done % 10 === 0) await new Promise(r2 => setImmediate(r2));
      }
    } catch (e) { rescanJob.log.push(`FATAL: ${e.message}`); }
    rescanJob.running = false;
    rescanJob.finishedAt = Date.now();
  })();
});

r.get("/rescan/status", (_req, res) => {
  const { running, done, total, imported, dupes, failed, log, finishedAt } = rescanJob;
  res.json({ running, done, total, imported, dupes, failed, log: log.slice(-30), finishedAt });
});

// ===== QOL Settings: preferences =====
const PREF_DEFAULTS = { trashRetentionDays: 30, notifyOnBackup: true, thumbQuality: 80, livePollInterval: 5000 };
r.get("/prefs", (_req, res) => {
  const out = { ...PREF_DEFAULTS };
  for (const k of Object.keys(PREF_DEFAULTS)) out[k] = JSON.parse(getSetting(k, JSON.stringify(PREF_DEFAULTS[k])));
  res.json(out);
});
r.post("/prefs", json(), (req, res) => {
  for (const [k, v] of Object.entries(req.body ?? {})) {
    if (!(k in PREF_DEFAULTS)) return res.status(400).json({ error: `Unknown key: ${k}` });
    setSetting(k, JSON.stringify(v));
  }
  res.json({ ok: true });
});

// DB backup: lokasi dari setting (default AppData\Local), status + manual trigger
const dbBackupDir = () => getSetting("dbBackupDir") || path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE, "AppData", "Local"), "NigiroCORE", "db-backups");
r.get("/db-backup", (_req, res) => {
  const dir = dbBackupDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".db")).sort().reverse() : [];
  res.json({ last: Number(getSetting("lastDbBackup", 0)) || null, backups: files, dir });
});
r.post("/db-backup", (_req, res) => {
  res.json(backupDB());
});
r.post("/db-backup/location", json(), (req, res) => {
  const dir = String(req.body?.dir ?? "").trim();
  if (!path.isAbsolute(dir) || dir.length < 3) return res.status(400).json({ error: "Path Must Be Absolute" });
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); } catch (e) { return res.status(400).json({ error: `Cannot Write To Folder: ${e.message}` }); }
  setSetting("dbBackupDir", dir);
  res.json({ ok: true, dir });
});

r.get("/adb-status", async (_req, res) => {
  const st = { adbPath: process.env.ADB_PATH ?? "", adbExists: fs.existsSync(process.env.ADB_PATH ?? ""), devices: [], error: null };
  try {
    const out = await adb("devices");
    st.devices = out.split("\n").slice(1).filter(l => l.trim()).map(l => {
      const [id, state] = l.split("\t");
      return { id, state: state?.trim() ?? "unknown" };
    });
    // model + battery + storage untuk device yang authorized (adb() return string langsung, bukan {stdout})
    for (const d of st.devices.filter(d => d.state === "device")) {
      d.model = (await adb("-s", d.id, "shell", "getprop", "ro.product.model").catch(() => "")).trim?.() || d.id;
      d.android = (await adb("-s", d.id, "shell", "getprop", "ro.build.version.release").catch(() => "")).trim?.() || "";
      const bat = await adb("-s", d.id, "shell", "dumpsys", "battery").catch(() => "");
      const level = /level:\s*(\d+)/.exec(bat)?.[1];
      const charging = /AC powered: true|USB powered: true/.test(bat);
      d.battery = level != null ? { level: +level, charging } : null;
    }
  } catch (e) { st.error = e.message.split("\n")[0]; }
  res.json(st);
});

// ===== Profiles API =====
r.get("/profiles", (_req, res) => {
  const profiles = db.prepare(`
    SELECT p.*, COUNT(f.id) files, COALESCE(SUM(f.size),0) size
    FROM profiles p LEFT JOIN files f ON f.profile_id = p.id
    GROUP BY p.id ORDER BY p.id`).all();
  res.json({ profiles, active: Number(getSetting("activeProfile", "1")) });
});
r.post("/profiles", json(), (req, res) => {
  const { name, color } = req.body ?? {};
  if (!name || !/^[a-zA-Z0-9 _-]{1,32}$/.test(name.trim())) return res.status(400).json({ error: "Nama: huruf/angka/spasi max 32" });
  try {
    const row = db.prepare("INSERT INTO profiles (name, color) VALUES (?, ?)").run(name.trim(), color || "#D71921");
    // folder profil langsung dibuat — biar kelihatan rapi di Explorer sebelum backup pertama
    fs.mkdirSync(path.join(process.env.STORAGE_PATH, "profile", name.trim().replace(/[\\/:*?"<>|]/g, "_")), { recursive: true });
    res.json({ ok: true, id: row.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message.includes("UNIQUE") ? "Nama sudah dipakai" : e.message }); }
});
r.delete("/profiles/:id", (req, res) => {
  if (+req.params.id === 1) return res.status(400).json({ error: "Profile default tidak bisa dihapus" });
  const files = db.prepare("SELECT COUNT(*) c FROM files WHERE profile_id = ?").get(req.params.id).c;
  if (files > 0) return res.status(400).json({ error: `Profile masih punya ${files} file — pindahkan dulu` });
  db.prepare("DELETE FROM profiles WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
r.post("/profiles/active", json(), (req, res) => {
  const id = Number(req.body?.id);
  if (!db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(id)) return res.status(400).json({ error: "Profile tidak ada" });
  setSetting("activeProfile", String(id));
  res.json({ ok: true });
});
r.post("/profiles/:id/reassign", json(), (req, res) => {
  const to = Number(req.body?.to);
  if (!db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(to)) return res.status(400).json({ error: "Profile target tidak ada" });
  const row = db.prepare("UPDATE files SET profile_id = ? WHERE profile_id = ?").run(to, req.params.id);
  res.json({ ok: true, moved: row.changes });
});

// edit profile: rename (+ folder di disk ikut pindah), emoji avatar, warna
r.post("/profiles/:id/edit", json(), (req, res) => {
  const p = db.prepare("SELECT * FROM profiles WHERE id = ?").get(req.params.id);
  if (!p) return res.sendStatus(404);
  const { name, color, emoji } = req.body ?? {};
  const root = process.env.STORAGE_PATH;
  const safe = (n) => n.replace(/[\\/:*?"<>|]/g, "_");
  const oldDir = path.join(root, "profile", safe(p.name));
  const newName = (name ?? p.name).trim();
  if (!/^[a-zA-Z0-9 _-]{1,32}$/.test(newName)) return res.status(400).json({ error: "Nama: huruf/angka/spasi max 32" });
  const newDir = path.join(root, "profile", safe(newName));
  try {
    // rename folder di disk kalau nama berubah dan folder lama ada
    if (safe(newName) !== safe(p.name) && fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
      // update semua local_path di DB
      const rows = db.prepare("SELECT id, local_path FROM files WHERE profile_id = ?").all(p.id);
      for (const row of rows) {
        const np = row.local_path.replace(oldDir, newDir);
        db.prepare("UPDATE files SET local_path = ? WHERE id = ?").run(np, row.id);
      }
    }
    db.prepare("UPDATE profiles SET name = ?, color = ?, emoji = ? WHERE id = ?")
      .run(newName, color ?? p.color, emoji ?? p.emoji ?? null, p.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message.includes("UNIQUE") ? "Name Already Used" : e.message }); }
});

// ===== Integrity report: DB vs disk (missing / untracked / checksum mismatch) =====
// job-based: jalan di background (bisa makan menit di vault besar), progress dipoll via /integrity/status
const integrityJob = { running: false, done: 0, total: 0, result: null, startedAt: null };

async function runIntegrityJob() {
  integrityJob.running = true;
  integrityJob.startedAt = Date.now();
  integrityJob.done = 0;
  integrityJob.result = null;
  try {
    const rows = db.prepare("SELECT id, local_path, checksum FROM files").all();
    integrityJob.total = rows.length;
    const tracked = new Set(rows.map(row => path.resolve(row.local_path).toLowerCase()));
    const missing = [], mismatch = [];
    for (const row of rows) {
      try {
        if (!fs.existsSync(row.local_path)) { missing.push({ id: row.id, path: row.local_path }); }
        else {
          const sum = crypto.createHash("sha1").update(fs.readFileSync(row.local_path)).digest("hex");
          if (sum !== row.checksum) mismatch.push({ id: row.id, path: row.local_path });
        }
      } catch {}
      integrityJob.done++;
      // beri napas ke event loop tiap 25 file biar server tetap responsif
      if (integrityJob.done % 25 === 0) await new Promise(r => setImmediate(r));
    }
    const storagePath = path.resolve(process.env.STORAGE_PATH ?? "");
    // scope: folder profile/ saja (vault sah) — Apps/java/minecraft di STORAGE_PATH bukan vault
    const profileRoot = path.resolve(storagePath, "profile");
    const untracked = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.startsWith(".") || /^\d{4}$/.test(e.name)) continue;
          walk(p);
        }
        else if (!p.toLowerCase().includes("thumb") && !tracked.has(p.toLowerCase())) untracked.push(p);
      }
    };
    try { walk(profileRoot); } catch {}
    integrityJob.result = { total: rows.length, missing, mismatch, untracked: untracked.slice(0, 200), untrackedCount: untracked.length, finishedAt: Date.now() };
  } catch (e) {
    integrityJob.result = { error: e.message };
  }
  integrityJob.running = false;
}

r.get("/integrity", (_req, res) => {
  if (integrityJob.running) return res.json({ running: true, done: integrityJob.done, total: integrityJob.total });
  if (integrityJob.result && Date.now() - integrityJob.startedAt < 10 * 60 * 1000) {
    return res.json({ running: false, ...integrityJob.result });
  }
  // belum ada hasil (atau sudah > 10 menit) → mulai job baru
  runIntegrityJob();
  res.json({ running: true, done: 0, total: 0 });
});

// storage breakdown per kategori (dari DB + scan folder non-media)
r.get("/breakdown", (_req, res) => {
  const media = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN mime LIKE 'image/%' THEN size END),0) photos,
       COALESCE(SUM(CASE WHEN mime LIKE 'video/%' THEN size END),0) videos,
       COALESCE(SUM(CASE WHEN mime NOT LIKE 'image/%' AND mime NOT LIKE 'video/%' THEN size END),0) others
     FROM files`
  ).get();
  // folder non-media di vault (sdcard/Documents dll) — scan top-level
  const root = process.env.STORAGE_PATH;
  let docs = 0;
  const sizeDir = (d) => {
    let t = 0;
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return 0; }
    for (const i of items) {
      const f = path.join(d, i.name);
      if (i.isDirectory()) t += sizeDir(f);
      else { try { t += fs.statSync(f).size; } catch {} }
    }
    return t;
  };
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith(".") || /^\d{4}$/.test(d.name)) continue;
    docs += sizeDir(path.join(root, d.name));
  }
  res.json({ photos: media.photos, videos: media.videos, documents: docs, others: media.others });
});

export default r;
