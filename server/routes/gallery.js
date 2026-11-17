// ===== Gallery & media: timeline, documents, memories, stats, streaming, thumbs, favorites, trash, GPS, recap, duplicates =====
import express from "express";
import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import exifr from "exifr";
import { db, hasPath, hasChecksum, insertFile, getSetting } from "../db.js";
import { guessMime, absPath, relPath } from "../util.js";

const r = Router();
const activeProfile = () => Number(getSetting("activeProfile", "1"));
const THUMB_DIR = path.join(process.env.STORAGE_PATH, ".thumbs");
const TRASH = () => path.join(process.env.STORAGE_PATH, ".trash");

r.get("/gallery", (_req, res) => {
  const profile = activeProfile();
  const rows = db.prepare("SELECT * FROM files WHERE profile_id = ? AND archived = 0 AND (mime LIKE 'image/%' OR mime LIKE 'video/%') ORDER BY mtime DESC").all(profile);
  const groups = {};
  for (const r of rows) {
    const key = new Date(r.mtime * 1000).toISOString().slice(0, 10);
    (groups[key] ??= []).push(r);
  }
  res.json(groups);
});

// ===== Documents view: dokumen beneran (PDF/DOC/XLS/PPT/TXT/CSV) — bukan APK/JAR/ZIP =====
const DOC_MIMES = ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument", "application/vnd.ms-", "application/rtf", "application/vnd.oasis.opendocument", "text/plain", "text/csv", "text/rtf"];
r.get("/documents", (_req, res) => {
  const profile = activeProfile();
  const rows = db.prepare("SELECT id, original_name, mime, size, mtime, local_path FROM files WHERE profile_id = ? AND archived = 0 AND mime NOT LIKE 'image/%' AND mime NOT LIKE 'video/%' ORDER BY mtime DESC").all(profile);
  const isDoc = (mime, name) => {
    const m = (mime ?? "").toLowerCase();
    if (DOC_MIMES.some(p => m.startsWith(p))) return true;
    // fallback kalau mime kosong: cek ekstensi
    const ext = name.split(".").pop().toLowerCase();
    return ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "rtf", "odt", "ods", "odp"].includes(ext);
  };
  res.json(rows.filter(r2 => isDoc(r2.mime, r2.original_name)));
});

// ===== Memories "On This Day": foto/video tahun-tahun lalu di tanggal yang sama =====
r.get("/memories", (_req, res) => {
  const profile = activeProfile();
  const today = new Date();
  const mmdd = `${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const thisYear = today.getFullYear();
  const rows = db.prepare(`
    SELECT id, original_name, mime, mtime FROM files
    WHERE profile_id = ? AND CAST(strftime('%Y', mtime, 'unixepoch') AS INTEGER) < ?
      AND strftime('%m-%d', mtime, 'unixepoch') = ?
    ORDER BY mtime DESC`).all(profile, thisYear, mmdd);
  res.json({ date: mmdd, count: rows.length, items: rows });
});

r.get("/stats", (_req, res) => {
  const { c, size, photos } = db.prepare(
    "SELECT COUNT(*) c, COALESCE(SUM(size),0) size, SUM(mime LIKE 'image/%') photos FROM files"
  ).get();
  const videos = db.prepare("SELECT COUNT(*) v FROM files WHERE mime LIKE 'video/%'").get().v;
  const years = db.prepare(
    "SELECT strftime('%Y', mtime, 'unixepoch') y, COUNT(*) n FROM files GROUP BY y ORDER BY y"
  ).all();
  res.json({ count: c, size, photos, videos, years });
});

// streaming dengan Range request (video seek tanpa download penuh)
r.get("/media/:id", (req, res) => {
  const row = db.prepare("SELECT local_path, mime FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.sendStatus(404);
  const fp = absPath(row.local_path);
  const stat = fs.statSync(fp);
  const range = req.headers.range;
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Accept-Ranges", "bytes");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = m && m[1] ? parseInt(m[1]) : 0;
    let end = m && m[2] ? parseInt(m[2]) : stat.size - 1;
    if (isNaN(start) || start >= stat.size) { res.setHeader("Content-Range", `bytes */${stat.size}`); return res.sendStatus(416); }
    end = Math.min(end, stat.size - 1);
    res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", end - start + 1);
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", stat.size);
    fs.createReadStream(fp).pipe(res);
  }
});

// PDF thumbnail: render halaman 1 via pdfjs-dist + @napi-rs/canvas
let _pdfjs = null;
async function pdfThumb(pdfPath, outPath) {
  _pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await _pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const page = await doc.getPage(1);
  const scale = 250 / page.getViewport({ scale: 1 }).width;
  const vp = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const webp = await sharp(canvas.toBuffer("image/png")).webp({ quality: 80 }).toBuffer();
  fs.writeFileSync(outPath + ".tmp", webp);
  fs.renameSync(outPath + ".tmp", outPath);
}
// video thumbnail via ffmpeg (ffmpeg -ss 1 -i in -frames:v 1), cache .webp sama seperti foto
function videoThumb(src, dest) {
  return new Promise(resolve => {
    exec(`ffmpeg -y -ss 1 -i "${src}" -frames:v 1 -vf "scale=250:-2" "${dest}.tmp.webp"`, { timeout: 30000, windowsHide: true }, err => {
      if (err) return resolve(false);
      try { fs.renameSync(dest + ".tmp.webp", dest); resolve(true); } catch { resolve(false); }
    });
  });
}
const isVideo = (p) => /\.(mp4|mkv|webm|mov|avi|m4v|3gp)$/i.test(p);
// render PDF thumbnail satu-satu (render ~1s/file, jangan biarin 261 request numpuk)
let pdfQueue = Promise.resolve();
function queuePdfThumb(row, cached) {
  pdfQueue = pdfQueue.then(async () => {
    if (fs.existsSync(cached)) return true;
    try { await pdfThumb(row.local_path, cached); return true; } catch { return false; }
  });
  return pdfQueue;
}

r.get("/media/:id/thumb", async (req, res) => {
  const row = db.prepare("SELECT id, local_path, mime FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.sendStatus(404);
  const fp = absPath(row.local_path);
  const cached = path.join(THUMB_DIR, row.id + ".webp");
  if (fs.existsSync(cached)) {
    res.setHeader("Content-Type", "image/webp");
    return res.sendFile(cached);
  }
  try {
    if (isVideo(fp) || row.mime.startsWith("video")) {
      fs.mkdirSync(THUMB_DIR, { recursive: true });
      const ok = await videoThumb(fp, cached);
      if (!ok) return res.sendStatus(404);
      res.setHeader("Content-Type", "image/webp");
      return res.sendFile(cached);
    }
    // PDF: render halaman 1 (queued — satu-satu, hasil di-cache)
    if (row.mime === "application/pdf" || /\.pdf$/i.test(fp)) {
      fs.mkdirSync(THUMB_DIR, { recursive: true });
      const ok = await queuePdfThumb({ ...row, local_path: fp }, cached);
      if (!ok) return res.sendStatus(404);
      res.setHeader("Content-Type", "image/webp");
      return res.sendFile(cached);
    }
    if (!row.mime.startsWith("image") || !/\.(jpe?g|png|webp|heic|gif|bmp)$/i.test(fp))
      return res.sendStatus(404);
    const thumb = await sharp(fs.readFileSync(fp)).rotate().resize(250, 250, { fit: "inside" }).webp({ quality: 80 }).toBuffer();
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    fs.writeFileSync(cached, thumb);
    res.setHeader("Content-Type", "image/webp");
    res.send(thumb);
  } catch {
    res.sendStatus(500);
  }
});

// favorite toggle + file info
r.post("/favorite/:id", (req, res) => {
  const row = db.prepare("SELECT favorite FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.sendStatus(404);
  db.prepare("UPDATE files SET favorite = ? WHERE id = ?").run(row.favorite ? 0 : 1, req.params.id);
  res.json({ favorite: row.favorite ? 0 : 1 });
});

// archive toggle (hide from timeline without delete) + archive list
r.post("/archive/:id", (req, res) => {
  const row = db.prepare("SELECT archived FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.sendStatus(404);
  db.prepare("UPDATE files SET archived = ? WHERE id = ?").run(row.archived ? 0 : 1, req.params.id);
  res.json({ archived: row.archived ? 0 : 1 });
});
r.get("/archived", (_req, res) => {
  const profile = activeProfile();
  res.json(db.prepare("SELECT id, original_name, mime, size, mtime, local_path FROM files WHERE archived = 1 AND profile_id = ? ORDER BY mtime DESC").all(profile));
});

// stack: burst grouping — file dalam jendela 2 detik + nama pola sama (IMG_xxxx burst) digrup
r.get("/stacks", (_req, res) => {
  const profile = activeProfile();
  const rows = db.prepare("SELECT id, original_name, mime, mtime FROM files WHERE archived = 0 AND profile_id = ? AND mime LIKE 'image/%' ORDER BY mtime").all(profile);
  const stacks = [];
  let cur = null;
  for (const r2 of rows) {
    const base = r2.original_name.replace(/[_-]?\d+\.\w+$/, "");
    if (cur && cur.base === base && r2.mtime - cur.last <= 2) { cur.items.push(r2.id); cur.last = r2.mtime; }
    else { if (cur && cur.items.length > 1) stacks.push(cur); cur = { base, last: r2.mtime, items: [r2.id] }; }
  }
  if (cur && cur.items.length > 1) stacks.push(cur);
  res.json({ stacks: stacks.map(s => ({ cover: s.items[0], count: s.items.length, items: s.items })) });
});

r.get("/file/:id", (req, res) => {
  const f = db.prepare("SELECT id, device_path, original_name, mime, size, mtime, favorite, synced_at, place, width, height FROM files WHERE id = ?").get(req.params.id);
  if (!f) return res.sendStatus(404);
  res.json(f);
});

r.post("/media-trash/:id", (req, res) => {
  // simpan row lengkap dulu — restore butuh metadata asli (mtime, GPS, checksum, profile, dll)
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.sendStatus(404);
  const fp = absPath(row.local_path);
  const rel = path.relative(process.env.STORAGE_PATH, fp).replaceAll("\\", "/");
  if (rel.startsWith("..")) return res.sendStatus(400);
  const dest = path.join(TRASH(), rel.replaceAll("/", "%2F"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(fp, dest);
  // metadata asli diselipkan sebagai sidecar JSON di .trash
  fs.writeFileSync(dest + ".meta.json", JSON.stringify(row));
  db.prepare("DELETE FROM files WHERE id = ?").run(req.params.id);
  res.json({ trashed: rel });
});

// rename dokumen: file di disk + DB row + thumb cache
r.post("/files/:id/rename", express.json(), (req, res) => {
  const name = (req.body?.name ?? "").trim();
  if (!name || /[\\/:*?"<>|]/.test(name)) return res.status(400).json({ error: "Invalid File Name." });
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(req.params.id);
  if (!row) return res.sendStatus(404);
  const fp = absPath(row.local_path);
  const dest = path.join(path.dirname(fp), name);
  if (fs.existsSync(dest)) return res.status(400).json({ error: "A File With That Name Already Exists." });
  try { fs.renameSync(fp, dest); } catch (e) { return res.status(500).json({ error: "Rename Failed: " + e.message }); }
  db.prepare("UPDATE files SET original_name = ?, local_path = ? WHERE id = ?").run(name, relPath(dest), req.params.id);
  // thumb lama gak valid lagi (nama beda — render bisa beda), buang
  try { fs.rmSync(path.join(THUMB_DIR, req.params.id + ".webp"), { force: true }); } catch {}
  res.json({ ok: true, name });
});

// ===== GPS extraction (Maps view) =====
const gpsCache = new Map(); // id → { lat, lng } | null

r.get("/photo-gps/:id", async (req, res) => {
  try {
    const row = db.prepare("SELECT local_path, mime FROM files WHERE id = ?").get(req.params.id);
    if (!row || !row.mime.startsWith("image")) return res.json({ gps: null });
    if (gpsCache.has(+req.params.id)) return res.json({ gps: gpsCache.get(+req.params.id) });
    const buf = await fs.promises.readFile(absPath(row.local_path));
    const g = await exifr.gps(buf).catch(() => null);
    const gps = g?.latitude ? { lat: g.latitude, lng: g.longitude } : null;
    gpsCache.set(+req.params.id, gps);
    res.json({ gps });
  } catch {
    res.json({ gps: null });
  }
});

// semua foto ber-GPS sekaligus (untuk Maps view) — instan dari DB (Immich-style)
try { db.exec("ALTER TABLE files ADD COLUMN place TEXT"); } catch {}

// reverse geocode via Nominatim (gratis, tanpa key) — cache di DB biar cuma 1 request per koordinat unik
const geoCache = new Map();
async function reverseGeocode(lat, lng) {
  lat = Number(lat); lng = Number(lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const k = lat.toFixed(4) + "," + lng.toFixed(4);
  if (geoCache.has(k)) return geoCache.get(k);
  const hit = db.prepare("SELECT place FROM files WHERE lat IS NOT NULL AND ROUND(lat,4)=ROUND(?,4) AND ROUND(lng,4)=ROUND(?,4) AND place IS NOT NULL LIMIT 1").get(lat, lng);
  if (hit) { geoCache.set(k, hit.place); return hit.place; }
  try {
    const resp = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10&accept-language=en`, {
      headers: { "User-Agent": "NigiroCORE/1.0 (personal photo vault)" },
    });
    const j = await resp.json();
    const name = j.address ? [j.address.city ?? j.address.town ?? j.address.village ?? j.address.county, j.address.state].filter(Boolean).join(", ") : null;
    if (name) db.prepare("UPDATE files SET place=? WHERE ROUND(lat,4)=ROUND(?,4) AND ROUND(lng,4)=ROUND(?,4)").run(name, lat, lng);
    geoCache.set(k, name);
    return name;
  } catch { return null; }
}

// geocode-at-backup: queue koordinat unik baru → Nominatim 1 req/detik di background
export async function geocodeQueue() {
  const rows = db.prepare("SELECT DISTINCT ROUND(lat,4) lat, ROUND(lng,4) lng FROM files WHERE lat IS NOT NULL AND place IS NULL").all();
  for (const row of rows) {
    await reverseGeocode(row.lat, row.lng);
    await new Promise(res => setTimeout(res, 1100)); // Nominatim: max 1 req/detik
  }
  return rows.length;
}

r.get("/photos-gps", async (_req, res) => {
  const photos = db.prepare(
    "SELECT id, original_name AS name, lat, lng, place, mtime FROM files WHERE lat IS NOT NULL AND lng IS NOT NULL AND typeof(lat) IN ('real','integer') AND typeof(lng) IN ('real','integer') AND profile_id = ? ORDER BY mtime DESC"
  ).all(activeProfile());
  // geocode koordinat unik yang belum punya place (max 5/request biar sopan ke Nominatim)
  const uniq = [...new Map(photos.map(p => [Number(p.lat).toFixed(4) + "," + Number(p.lng).toFixed(4), p])).values()];
  let quota = 5;
  for (const p of uniq) {
    if (!p.place && quota-- > 0) await reverseGeocode(p.lat, p.lng);
  }
  res.json({ photos });
});

r.get("/favorites", (_req, res) => {
  const rows = db.prepare("SELECT id, original_name, mime, size, mtime, local_path FROM files WHERE favorite = 1 AND archived = 0 ORDER BY mtime DESC").all();
  res.json({ files: rows });
});

r.get("/trash", (_req, res) => {
  const dir = TRASH();
  if (!fs.existsSync(dir)) return res.json({ items: [] });
  const items = fs.readdirSync(dir).filter(n => !n.endsWith(".meta.json")).map(name => {
    const st = fs.statSync(path.join(dir, name));
    return { name, size: st.size, deleted_at: Math.floor(st.mtimeMs / 1000) };
  });
  res.json({ items });
});

r.post("/trash", express.json(), (req, res) => {
  const rel = (req.body?.path ?? "").toString();
  const root = process.env.STORAGE_PATH;
  const abs = path.resolve(path.join(root, rel));
  if (!abs.startsWith(path.resolve(root)) || abs === path.resolve(root)) return res.sendStatus(400);
  if (!fs.existsSync(abs)) return res.sendStatus(404);
  const dest = path.join(TRASH(), rel.replaceAll("/", "%2F"));
  fs.mkdirSync(TRASH(), { recursive: true });
  fs.renameSync(abs, dest);
  // update DB kalau file backup-an
  db.prepare("DELETE FROM files WHERE local_path = ?").run(relPath(abs));
  res.json({ trashed: rel });
});

r.post("/trash/restore", express.json(), (req, res) => {
  const name = (req.body?.name ?? "").toString();
  const src = path.join(TRASH(), name);
  if (!fs.existsSync(src)) return res.sendStatus(404);
  // nama di trash = path asli dengan / diganti %2F, balikin ke struktur semula
  const parts = decodeURIComponent(name).split("/").filter(Boolean);
  const dest = path.join(process.env.STORAGE_PATH, ...parts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  // restore metadata asli dari sidecar (mtime, GPS, checksum, profile, dll) kalau ada
  const metaPath = src + ".meta.json";
  if (fs.existsSync(metaPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      // restore pakai ID ASLI dari sidecar — thumb cache per-id tetap valid, tidak jadi sampah stale
      db.prepare(`INSERT OR IGNORE INTO files (id, device_path, original_name, mime, size, mtime, local_path, checksum, lat, lng, width, height, volume, profile_id, favorite, archived, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(m.id, m.device_path, m.original_name, m.mime, m.size, m.mtime, relPath(dest), m.checksum, m.lat, m.lng, m.width, m.height, m.volume, m.profile_id, m.favorite, m.archived ?? 0, m.synced_at ?? Math.floor(Date.now() / 1000));
    } catch {}
    fs.rmSync(metaPath, { force: true });
  } else if (!db.prepare("SELECT id FROM files WHERE local_path = ?").get(relPath(dest))) {
    // fallback: sidecar hilang — register minimal
    const st = fs.statSync(dest);
    db.prepare("INSERT OR IGNORE INTO files (device_path, original_name, mime, size, mtime, local_path, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("/restored/" + decodeURIComponent(name).replaceAll("\\", "/"), path.basename(dest), guessMime(dest), st.size, Math.floor(st.mtimeMs / 1000), relPath(dest), activeProfile());
  }
  res.json({ restored: dest });
});

r.post("/trash/purge", (req, res) => {
  const dir = TRASH();
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  res.json({ purged: true });
});

// trash retention: auto-purge item > 30 hari (cek tiap 6 jam)
const TRASH_RETENTION_MS = 30 * 864e5;
function purgeOldTrash() {
  const dir = TRASH();
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    try {
      if (Date.now() - fs.statSync(path.join(dir, name)).mtimeMs > TRASH_RETENTION_MS) {
        fs.rmSync(path.join(dir, name), { force: true });
        n++;
      }
    } catch {}
  }
  if (n) console.log(`Trash retention: ${n} item > 30 hari dihapus`);
  return n;
}
purgeOldTrash();
setInterval(purgeOldTrash, 6 * 3600 * 1000);

// Year in Review: recap per tahun (scoped profile aktif — konsisten dengan gallery & maps)
r.get("/recap/:year", (req, res) => {
  const y = parseInt(req.params.year);
  if (!/^\d{4}$/.test(String(y))) return res.sendStatus(400);
  const prof = activeProfile();
  const total = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(size),0) size, SUM(mime LIKE 'image/%') photos, SUM(mime LIKE 'video/%') videos FROM files WHERE strftime('%Y', mtime, 'unixepoch') = ? AND profile_id = ?").get(String(y), prof);
  const busiest = db.prepare("SELECT strftime('%m', mtime, 'unixepoch') m, COUNT(*) n FROM files WHERE strftime('%Y', mtime, 'unixepoch') = ? AND profile_id = ? GROUP BY m ORDER BY n DESC LIMIT 1").get(String(y), prof);
  const topPlaces = db.prepare("SELECT COALESCE(place, 'Unknown') place, COUNT(*) n FROM files WHERE strftime('%Y', mtime, 'unixepoch') = ? AND lat IS NOT NULL AND profile_id = ? GROUP BY COALESCE(place, ROUND(lat,1)||','||ROUND(lng,1)) ORDER BY n DESC LIMIT 5").all(String(y), prof);
  const largest = db.prepare("SELECT id, original_name, size, mime FROM files WHERE strftime('%Y', mtime, 'unixepoch') = ? AND profile_id = ? ORDER BY size DESC LIMIT 5").all(String(y), prof);
  const perMonth = db.prepare("SELECT strftime('%m', mtime, 'unixepoch') m, COUNT(*) n FROM files WHERE strftime('%Y', mtime, 'unixepoch') = ? AND profile_id = ? GROUP BY m ORDER BY m").all(String(y), prof);
  res.json({
    year: y, total: total.c, size: total.size, photos: total.photos, videos: total.videos,
    busiestMonth: busiest ? ["January","February","March","April","May","June","July","August","September","October","November","December"][+busiest.m - 1] : null,
    topPlaces, largest, perMonth,
  });
});

// ===== Duplicate detector: hash MD5 semua file di vault, cari yang sama =====
r.get("/duplicates", (_req, res) => {
  // Immich-style: instan dari checksum di DB
  const groups = db.prepare(
    `SELECT checksum, COUNT(*) n FROM files WHERE checksum IS NOT NULL GROUP BY checksum HAVING n > 1`
  ).all();
  const dupes = groups.map(g => ({
    files: db.prepare("SELECT id, original_name, size, local_path FROM files WHERE checksum = ?").all(g.checksum)
  }));
  const wasted = dupes.reduce((a, g) => a + g.files[0].size * (g.files.length - 1), 0);
  res.json({ groups: dupes, wasted });
});

export { THUMB_DIR, videoThumb, isVideo, guessMime };
export default r;
