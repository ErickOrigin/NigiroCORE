// ===== Sync / Phone / Backup: ADB pull, phone browse/preview/scan, backup-selected, contacts, history, browse/search/rawfile =====
import { Router } from "express";
import express from "express";
import path from "node:path";
import childProcess from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import sharp from "sharp";
import exifr from "exifr";
import { db, hasPath, hasChecksum, insertFile, getSetting } from "../db.js";
import { getDevice, getDevices, syncFiles, listDir, adb, phoneFile, pullBatch } from "../adb.js";
import { guessMime, absPath, relPath } from "../util.js";
import { THUMB_DIR, videoThumb, isVideo, geocodeQueue } from "./gallery.js";
import { pullFileStream, hashFileStream } from "../stream.js";

const r = Router();
const activeProfile = () => Number(getSetting("activeProfile", "1"));
const TRASH = () => path.join(process.env.STORAGE_PATH, ".trash");

// state backup dibagi ke /api/status (masih di server.js) via export
export const state = { syncing: false, log: [], scanProgress: null, backingUp: false, backupProgress: null };

// volume pool (dipakai backup-selected) — di-import dari server.js via helper init
let pickVolume = () => ({ name: "main", root: process.env.STORAGE_PATH });
export function setVolumePicker(fn) { pickVolume = fn; }

// ===== Multi-device registry: serial ADB -> profile + source dirs =====
// upsert last_seen tiap kali device terlihat; device baru = belum ada di tabel
function touchDevice(serial, model) {
  db.prepare("INSERT INTO devices (serial, name, last_seen) VALUES (?, ?, unixepoch()) ON CONFLICT(serial) DO UPDATE SET last_seen = unixepoch(), name = COALESCE(NULLIF(excluded.name, ''), devices.name)")
    .run(serial, model || null);
}
const deviceProfile = (serial) =>
  db.prepare("SELECT profile_id, source_dirs FROM devices WHERE serial = ?").get(serial);

// GET /api/devices: semua device terdaftar + status koneksi live
r.get("/devices", async (_req, res) => {
  const connected = new Set(await getDevices().catch(() => []));
  const rows = db.prepare("SELECT d.serial, d.name, d.profile_id, d.source_dirs, d.last_seen, p.name AS profile_name FROM devices d LEFT JOIN profiles p ON p.id = d.profile_id").all();
  res.json(rows.map(d => ({ ...d, source_dirs: JSON.parse(d.source_dirs), connected: connected.has(d.serial) })));
});

// POST /api/devices: assign/rename device — { serial, name?, profileId?, sourceDirs? }
r.post("/devices", express.json(), async (req, res) => {
  const { serial, name, profileId, sourceDirs } = req.body ?? {};
  if (!serial) return res.status(400).json({ error: "serial wajib" });
  const existing = deviceProfile(serial);
  if (!existing) {
    // device baru: ambil model dari HP kalau terhubung biar name tersensi otomatis
    const model = (await getDevice(serial).catch(() => null))?.model;
    touchDevice(serial, name || model);
  }
  if (name != null) db.prepare("UPDATE devices SET name = ? WHERE serial = ?").run(String(name), serial);
  if (profileId != null) db.prepare("UPDATE devices SET profile_id = ? WHERE serial = ?").run(Number(profileId), serial);
  if (Array.isArray(sourceDirs) && sourceDirs.length) db.prepare("UPDATE devices SET source_dirs = ? WHERE serial = ?").run(JSON.stringify(sourceDirs), serial);
  res.json({ ok: true });
});

// DELETE /api/devices/:serial — unregister (file vault tidak disentuh)
r.delete("/devices/:serial", (req, res) => {
  db.prepare("DELETE FROM devices WHERE serial = ?").run(req.params.serial);
  res.json({ ok: true });
});

async function runSync(filter = "all") {
  if (state.syncing) return;
  state.syncing = true; state.log = [];
  if (filter !== "all") state.log.push(`Filter: ${filter} only`);
  try {
    const result = await syncFiles((await getDevices())[0], (p) => {
      const line = p.error ?? `${p.done}/${p.total}  ${p.file ?? ""}`;
      state.log.push(line);
      console.log(line);
    });
    state.log.push(`DONE — ${result.synced} New Files From ${result.total} Total`);
  } catch (e) {
    state.log.push(`ERROR: ${e.message}`);
  } finally {
    state.syncing = false;
  }
}

r.post("/sync", (req, res) => {
  if (state.syncing) return res.status(409).json({ error: "Sync Already In Progress" });
  runSync(req.body?.filter ?? "all");
  res.json({ started: true });
});

// ===== Phone browsing API (custom backup picker) =====
r.get("/phone/browse", async (req, res) => {
  try {
    const device = await getDevice(req.query.serial);
    if (!device) return res.status(400).json({ error: "No Device Connected" });
    const dir = (req.query.path || "/storage/emulated/0").toString();
    const entries = await listDir(dir);
    res.json({ path: dir, entries, device: device.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// preview file dari HP — thumbnail di-cache ke disk biar nggak re-download full file
r.get("/phone/preview", async (req, res) => {
  try {
    const device = await getDevice(req.query.serial);
    if (!device) return res.sendStatus(400);
    const p = (req.query.path || "").toString();
    if (!p.startsWith("/storage/emulated/")) return res.sendStatus(400);
    const w = Math.min(parseInt(req.query.w) || 0, 512);

    // bukan gambar kecil diminta → stream langsung (video preview dsb)
    if (!w || !/\.(jpe?g|png|webp|gif|heic|bmp)$/i.test(p)) {
      const buf = await phoneFile(device.id, p);
      res.setHeader("Content-Type", guessMime(p));
      return res.send(buf);
    }

    // cache key: path + mtime biar file yang berubah di-HP tetap fresh
    const stat = await adb("shell", `stat -c '%Y %s' '${p}' 2>/dev/null`).catch(() => "");
    const mtime = stat.trim().split(" ")[0] || "0";
    const cached = path.join(THUMB_DIR, Buffer.from(p + "|" + mtime).toString("base64url") + ".jpg");
    if (fs.existsSync(cached)) {
      res.setHeader("Content-Type", "image/jpeg");
      return res.sendFile(cached);
    }

    const buf = await phoneFile(device.id, p);
    const thumb = await sharp(buf).rotate().resize(w, w, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    fs.writeFileSync(cached, thumb);
    res.setHeader("Content-Type", "image/jpeg");
    res.send(thumb);
  } catch {
    res.sendStatus(500);
  }
});

// scan: hitung total file & size dari daftar path yang dipilih
r.post("/phone/scan", async (req, res) => {
  try {
    const device = await getDevice(req.body?.serial);
    if (!device) return res.status(400).json({ error: "No Device Connected" });
    const { paths, filter } = req.body;
    const all = [];
    state.scanProgress = { phase: "list", done: 0, total: (paths ?? []).length, current: "" };
    for (const p of paths ?? []) {
      state.scanProgress.current = p;
      const stat = await adb("shell", `stat -c '%F %s' '${p}' 2>/dev/null`).catch(() => "");
      const [type, size] = stat.trim().split(" ");
      if (type?.startsWith("directory")) {
        // satu proses adb: find -exec stat batch (bukan stat per file)
        const out = (await adb("shell", `find '${p}' -type f -not -path '*/.*' -not -path '*/Android/data/*' -not -path '*/Android/obb/*' -exec stat -c '%s %Y %n' {} + 2>/dev/null`).catch(() => "")).replace(/\r/g, "");
        for (const line of out.split("\n")) {
          const sp1 = line.indexOf(" "), sp2 = line.indexOf(" ", sp1 + 1);
          if (sp1 < 1 || sp2 < 0) continue;
          all.push({ path: line.slice(sp2 + 1), size: +line.slice(0, sp1), mtime: +line.slice(sp1 + 1, sp2) });
        }
      } else if (size) {
        all.push({ path: p, size: +size });
      }
      state.scanProgress.done++;
    }
    const filtered = filter === "photos" ? all.filter(f => /\.(jpe?g|png|webp|heic|gif)$/i.test(f.path))
      : filter === "videos" ? all.filter(f => /\.(mp4|mkv|webm|mov)$/i.test(f.path))
      : all;
    // onlyNew: hanya file yang belum ada di vault (untuk preset Everything New — estimasi tanpa kirim 24rb path bolak-balik)
    const finalList = req.body?.onlyNew ? filtered.filter(f => !hasPath.get(f.path.replace(/^\/sdcard\//, "/storage/emulated/0/"))) : filtered;
    // breakdown per tahun (mtime) untuk year selector
    const byYear = {};
    for (const f of all) {
      const y = f.mtime ? new Date(f.mtime * 1000).getFullYear() : 0;
      (byYear[y] ??= { count: 0, size: 0 });
      byYear[y].count++;
      byYear[y].size += f.size;
    }
    state.scanProgress = null;
    res.json({ count: finalList.length, size: finalList.reduce((a, f) => a + f.size, 0), files: finalList.map(f => f.path), byYear, scannedTotal: filtered.length });
  } catch (e) {
    state.scanProgress = null;
    res.status(500).json({ error: e.message });
  }
});

// ===== HDD browse API (Files view — hasil backup) =====
r.get("/browse", async (req, res) => {
  try {
    // root Files = folder profile aktif (E:\NigiroCORE_Data\profile\<Nama>) — bukan root storage
    const profileName = db.prepare("SELECT name FROM profiles WHERE id = ?").get(activeProfile())?.name ?? "Default";
    const root = path.join(process.env.STORAGE_PATH, "profile", profileName.replace(/[\\/:*?"<>|]/g, "_"));
    // rel = "" → root profile; selain itu subfolder di dalamnya
    const rel = (req.query.path ?? "").toString().replace(/^\/+/, "");
    const abs = path.join(root, rel);
    // security: cegah path traversal keluar folder profile
    if (!path.resolve(abs).startsWith(path.resolve(root))) return res.status(400).json({ error: "Invalid path" });
    if (!fs.existsSync(abs)) return res.json({ path: rel, entries: [] });
    const dirents = fs.readdirSync(abs, { withFileTypes: true })
      .filter(d => !d.name.startsWith("."));
    const entries = dirents.map(d => {
      const full = path.join(abs, d.name);
      const st = fs.statSync(full);
      return {
        name: d.name,
        isDir: d.isDirectory(),
        size: d.isDirectory() ? 0 : st.size,
        mtime: Math.floor(st.mtimeMs / 1000),
        path: rel ? rel + "/" + d.name : d.name,
      };
    });
    res.json({ path: rel, entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// global search: semua file di vault (nama file, rekursif)
r.get("/search", (req, res) => {
  const q = (req.query.q ?? "").toString().toLowerCase().trim();
  if (!q) return res.json({ results: [] });
  // vault dulu: nama file / place / favorit dari DB (instan)
  const vault = db.prepare(
    `SELECT id, original_name AS name, 'vault' AS src, mime, size, place FROM files
     WHERE LOWER(original_name) LIKE ? OR LOWER(COALESCE(place,'')) LIKE ? LIMIT 40`
  ).all(`%${q}%`, `%${q}%`);
  // file explorer: walk HDD
  const root = process.env.STORAGE_PATH;
  const results = [];
  const walk = (dir, rel) => {
    if (results.length >= 60) return;
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (d.name.startsWith(".") || results.length >= 60) continue;
      const full = path.join(dir, d.name);
      const rel2 = rel ? rel + "/" + d.name : d.name;
      if (d.isDirectory()) walk(full, rel2);
      else if (d.name.toLowerCase().includes(q)) {
        const st = fs.statSync(full);
        results.push({ name: d.name, path: rel2, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
      }
    }
  };
  walk(root, "");
  results.sort((a, b) => b.mtime - a.mtime);
  res.json({ vault, results });
});

// ===== Free Up Space: hapus file di HP yang sudah ter-backup =====
// scan: file di HP yang device_path-nya ada di DB (terverifikasi ter-backup)
r.post("/phone/cleanup-folders", (req, res) => {
  // daftar top-level folder dari struktur profile HDD — cepat, tanpa ADB
  try {
    const profName = db.prepare("SELECT name FROM profiles WHERE id = ?").get(activeProfile())?.name ?? "Default";
    const profRoot = path.join(process.env.STORAGE_PATH, "profile", profName.replace(/[\\/:*?"<>|]/g, "_"));
    const folders = fs.readdirSync(profRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("."))
      .map(d => d.name);
    res.json({ folders, profile: profName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

r.post("/phone/cleanup-scan", async (req, res) => {
  try {
    const device = await getDevice(req.body?.serial);
    if (!device) return res.status(400).json({ error: "No Device Connected" });
    if (state.syncing || state.backingUp) return res.status(409).json({ error: "Backup In Progress — Wait For It To Finish" });
    const { paths, years } = req.body ?? {};
    // single-root scan untuk progress per folder: body { paths: [satu root] } → return partial
    const single = Array.isArray(paths) && paths.length === 1 ? paths[0] : null;
    // roots mengikuti struktur folder yang ter-backup di profile device (multi-device: bukan selalu profile aktif) —
    // top-level folder di profile/<Nama> dipetakan balik ke path HP
    const devReg = deviceProfile(device.id);
    const scanProfile = devReg?.profile_id ?? activeProfile();
    const profName = db.prepare("SELECT name FROM profiles WHERE id = ?").get(scanProfile)?.name ?? "Default";
    const profRoot = path.join(process.env.STORAGE_PATH, "profile", profName.replace(/[\\/:*?"<>|]/g, "_"));
    let roots = (single ? [single] : null);
    if (!roots) {
      try {
        roots = fs.readdirSync(profRoot, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith("."))
          .map(d => "/storage/emulated/0/" + d.name);
      } catch { roots = []; }
    }
    if (!roots.length) return res.json({ count: 0, size: 0, files: [], byYear: {}, byFolder: {}, totalOnDevice: 0, note: "Profile Folder Empty — Nothing Was Backed Up Yet" });
    // years = [from, to] (range), bukan Set — filter opsional
    const yr = Array.isArray(years) && years.length === 2 ? years.map(n => +n || 0) : null;
    const all = [];
    for (const p of roots) {
      const out = (await adb("shell", `find '${p}' -type f -not -path '*/.*' -not -path '*/Android/data/*' -not -path '*/Android/obb/*' -exec stat -c '%s %Y %n' {} + 2>/dev/null`).catch(() => "")).replace(/\r/g, "");
      for (const line of out.split("\n")) {
        const sp1 = line.indexOf(" "), sp2 = line.indexOf(" ", sp1 + 1);
        if (sp1 < 1 || sp2 < 0) continue;
        all.push({ path: line.slice(sp2 + 1), size: +line.slice(0, sp1), mtime: +line.slice(sp1 + 1, sp2) });
      }
    }
    // hanya file yang ter-backup (device_path ada di DB) + filter tahun opsional
    const backed = all.filter(f => hasPath.get(f.path) && (!yr || (() => { const y = new Date(f.mtime * 1000).getFullYear(); return y >= yr[0] && y <= yr[1]; })()));
    // breakdown per folder asal (root yang discan) + per tahun
    const byYear = {};
    const byFolder = {};
    for (const f of backed) {
      const y = f.mtime ? new Date(f.mtime * 1000).getFullYear() : 0;
      (byYear[y] ??= { count: 0, size: 0 });
      byYear[y].count++; byYear[y].size += f.size;
      // folder = segmen pertama path HP (mis. DCIM, Download) — rapih per folder
      const rel = f.path.replace(/^\/storage\/emulated\/0\//, "");
      const folder = rel.split("/")[0];
      (byFolder[folder] ??= { count: 0, size: 0 });
      byFolder[folder].count++; byFolder[folder].size += f.size;
    }
    res.json({
      root: single ?? null, count: backed.length, size: backed.reduce((a, f) => a + f.size, 0),
      files: backed.map(f => f.path), byYear, byFolder, totalOnDevice: all.length,
      deviceModel: device.model,
      fileDetails: backed.map(f => ({ path: f.path, folder: f.path.replace(/^\/storage\/emulated\/0\//, "").split("/")[0], size: f.size, mtime: f.mtime })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// delete: per-path, double-verify di DB sebelum rm — file tidak ter-backup TIDAK PERNAH dihapus
r.post("/phone/cleanup-delete", async (req, res) => {
  try {
    const device = await getDevice(req.body?.serial);
    if (!device) return res.status(400).json({ error: "No Device Connected" });
    if (state.syncing || state.backingUp) return res.status(409).json({ error: "Backup In Progress — Wait For It To Finish" });
    const { paths, years, folders, keepFolders } = req.body ?? {};
    if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ error: "No Files Selected" });
    // years = [from, to] range
    const yr = Array.isArray(years) && years.length === 2 ? years.map(n => +n || 0) : null;
    const folderRes = Array.isArray(folders) && folders.length ? folders.map(f => "/storage/emulated/0/" + f + "/") : null;
    let deleted = 0, freed = 0, failed = 0;
    for (const p of paths) {
      // guard 5 lapis: path HP valid + ada di DB + milik profile device ini + tahun sesuai + folder sesuai
      if (!/^\/storage\/emulated\/0\//.test(String(p))) { failed++; continue; }
      const delProfile = deviceProfile(device.id)?.profile_id ?? activeProfile();
      const row = db.prepare("SELECT id, size, mtime FROM files WHERE device_path = ? AND profile_id = ?").get(p, delProfile);
      if (!row) { failed++; continue; }
      if (yr) { const y = new Date(row.mtime * 1000).getFullYear(); if (y < yr[0] || y > yr[1]) continue; }
      if (folderRes && !folderRes.some(f => String(p).startsWith(f))) continue;
      try {
        await adb("shell", `rm '${String(p).replace(/'/g, "'\\''")}'`);
        deleted++; freed += row.size;
        // opsi keepFolders: default = hapus folder kosong (rmdir hanya berhasil kalau benar2 kosong — aman)
        if (!keepFolders) {
          const dir = String(p).replace(/\/[^/]+$/, "");
          if (/^\/storage\/emulated\/0\/.+/.test(dir)) await adb("shell", `rmdir '${dir.replace(/'/g, "'\\''")}' 2>/dev/null`).catch(() => {});
        }
      } catch { failed++; }
    }
    res.json({ ok: true, deleted, freed, failed, foldersRemoved: keepFolders ? 0 : "auto" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// serve file dari HDD untuk preview (by relative path dari vault)
r.get("/rawfile", (req, res) => {  const rel = (req.query.path ?? "").toString();
  // trash preview: ?trash=name (nama file di .trash)
  const root = req.query.trash
    ? TRASH()
    : path.join(process.env.STORAGE_PATH, "profile", (db.prepare("SELECT name FROM profiles WHERE id = ?").get(activeProfile())?.name ?? "Default").replace(/[\\/:*?"<>|]/g, "_"));
  const abs = path.resolve(path.join(root, rel));
  if (!abs.startsWith(path.resolve(root))) return res.sendStatus(400);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.sendStatus(404);
  const ext = abs.toLowerCase().split(".").pop();
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    gif: "image/gif", heic: "image/heic", mp4: "video/mp4", webm: "video/webm",
    mkv: "video/x-matroska", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    pdf: "application/pdf", txt: "text/plain", csv: "text/csv", html: "text/html",
  };
  res.setHeader("Content-Type", map[ext] ?? "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(path.basename(abs))}"`);
  res.sendFile(abs);
});

r.post("/backup-selected", async (req, res) => {
  const { paths, years, filter } = req.body;
  if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ error: "paths kosong" });
  if (state.backingUp) return res.status(409).json({ error: "Backup Already In Progress" });
  const device = await getDevice(req.body?.serial);
  if (!device) return res.status(400).json({ error: "No Device Connected" });
  // profile target: mapping device dari registry, fallback profile aktif (backward compatible)
  const devReg = deviceProfile(device.id);
  const targetProfile = devReg?.profile_id ?? activeProfile();
  const yearSet = Array.isArray(years) && years.length ? new Set(years.map(Number)) : null;
  const extRe = filter === "photos" ? /\.(jpe?g|png|webp|heic|gif)$/i
    : filter === "videos" ? /\.(mp4|mkv|webm|mov)$/i : null;

  state.backingUp = true; state.log = [];
  res.json({ started: true, count: paths.length });
  state.backupProgress = { done: 0, total: 0, file: "", pct: 0 };

  // kumpulkan file recursively dari folder yang dipilih
  const allFiles = [];
  for (const p of paths) {
    try {
      const stat = await adb("shell", `stat -c '%F %s %Y' '${p}' 2>/dev/null`);
      // %F = "regular file"/"directory" (bisa 2 kata) — ambil dari KANAN: mtime, size, sisanya type
      const parts = stat.trim().split(" ");
      const mtime = parts.pop(), size = parts.pop(), type = parts.join(" ");
      if (type.startsWith("directory")) {
        // satu proses adb: find -exec stat batch (bukan stat per file — 100x lebih cepat)
        const out = (await adb("shell", `find '${p}' -type f -not -path '*/.*' -not -path '*/Android/data/*' -not -path '*/Android/obb/*' -exec stat -c '%s %Y %n' {} + 2>/dev/null`).catch(() => "")).replace(/\r/g, "");
        for (const line of out.split("\n")) {
          const sp1 = line.indexOf(" "), sp2 = line.indexOf(" ", sp1 + 1);
          if (sp1 < 1 || sp2 < 0) continue;
          allFiles.push({ path: line.slice(sp2 + 1), size: +line.slice(0, sp1), mtime: +line.slice(sp1 + 1, sp2) });
        }
      } else if (size && mtime) {
        allFiles.push({ path: p, size: +size, mtime: +mtime });
      }
    } catch {}
  }
  // filter by selected years (kalau user milih rentang tahun) + tipe (photos/videos)
  const filesToBackup = allFiles.filter(f =>
    (!yearSet || yearSet.has(new Date(f.mtime * 1000).getFullYear())) &&
    (!extRe || extRe.test(f.path)));

  let done = 0, ok = 0, fail = 0, bytes = 0, dupes = 0, skipped = 0;
  state.backupProgress.total = filesToBackup.length;
  // progress byte-based: file-count menyesatkan kalau campuran file 3 KB & 3.5 GB (1/24511 = 0%)
  const totalBytes = filesToBackup.reduce((a, f) => a + f.size, 0);
  let doneBytes = 0;
  const updateProgress = (file, bytesTransferred, bytesTotal) => {
    state.backupProgress = {
      done, total: filesToBackup.length, file, pct: totalBytes ? Math.min(99, Math.round((doneBytes + (bytesTransferred ?? 0)) / totalBytes * 100)) : 0,
      bytesTransferred: doneBytes + (bytesTransferred ?? 0), bytesTotal: totalBytes,
      fileBytesTransferred: bytesTransferred, fileBytesTotal: bytesTotal,
    };
  };
  // filter yang benar-benar perlu di-pull (path belum ada di DB)
  const pending = [];
  for (const f of filesToBackup) {
    const devPath = f.path.replace(/^\/sdcard\//, "/storage/emulated/0/");
    if (hasPath.get(devPath)) { skipped++; done++; doneBytes += f.size; updateProgress(f.devPath); continue; }
    pending.push({ ...f, devPath });
  }
  // batch pull via tar — batch size dinamis by BYTES bukan jumlah file:
  // video HP bisa 100-500 MB/file, 50 file video = 25 GB di RAM = OOM crash.
  // ceiling 512 MB per batch; file > ceiling tetap masuk tar (pullBatch maxBuffer 2 GB).
  const BATCH_BYTES = 512 * 1024 * 1024;
  // counter via ref biar bisa diubah dari backupOne (closure const binding)
  const ctr = { done: 0, ok: 0, fail: 0, bytes: 0, dupes: 0, skipped };
  const backupOne = async (f) => {
    try {
      const vol = pickVolume();
      const profName = db.prepare("SELECT name FROM profiles WHERE id = ?").get(targetProfile)?.name ?? "Default";
      const rel = path.join("profile", profName, f.path.replace(/^\/storage\/emulated\/0\/|^\/sdcard\//, "").replace(/[^\\/]+$/, ""));
      const localDir = path.join(vol.root, rel);
      fs.mkdirSync(localDir, { recursive: true });
      const localPath = path.join(localDir, path.basename(f.path));
      try {
        const src = await pullFileStream(device.id, f.path, localPath + ".tmp", (transferred) => updateProgress(f.path, transferred, f.size));
        if (src.size === 0n) throw new Error("empty file from device");
        const dst = await hashFileStream(localPath + ".tmp");
        if (dst.sha1 !== src.sha1 || dst.size !== src.size) throw new Error("verify failed: copy differs from source");
        fs.renameSync(localPath + ".tmp", localPath);
        if (hasChecksum.get(src.sha1)) {
          ctr.dupes++;
          fs.rmSync(localPath, { force: true });
          state.log.push(`SKIP DUP: ${f.path} (identical file already in the vault)`);
          ctr.done++; doneBytes += f.size;
          return;
        }
        insertFile.run(f.devPath, path.basename(f.path), guessMime(f.path), Number(src.size), f.mtime, relPath(localPath), src.sha1, null, null, null, null);
        const fileId = db.prepare("SELECT id FROM files WHERE checksum = ?").get(src.sha1)?.id;
        if (fileId) db.prepare("UPDATE files SET volume = ?, profile_id = ? WHERE id = ?").run(vol.name, targetProfile, fileId);
        ctr.ok++; ctr.bytes += Number(src.size);
        state.log.push(`STREAM OK (${(Number(src.size) / 1073741824).toFixed(2)} GB): ${f.path}`);
      } catch (e) {
        fs.rmSync(localPath + ".tmp", { force: true });
        throw e;
      }
      updateProgress(f.path);
      state.log.push(`${++ctr.done}/${filesToBackup.length}  ${f.path}`);
    } catch (e) {
      ctr.fail++;
      state.log.push(`FAILED: ${f.path} — ${e.message.split("\n")[0]}`);
      updateProgress(f.path);
    }
  };
  const batches = [];
  let cur = [], curBytes = 0;
  for (const f of pending) {
    if (f.size > BATCH_BYTES) { if (cur.length) { batches.push(cur); cur = []; curBytes = 0; } batches.push([f]); continue; }
    if (cur.length && curBytes + f.size > BATCH_BYTES) { batches.push(cur); cur = []; curBytes = 0; }
    cur.push(f); curBytes += f.size;
  }
  if (cur.length) batches.push(cur);
  for (const chunk of batches) {
    // chunk raksasa (1 file > BATCH_BYTES): skip tar — pullBatch maxBuffer 2GB pasti gagal, langsung streaming
    if (chunk.length === 1 && chunk[0].size > BATCH_BYTES) { await backupOne(chunk[0]); continue; }
    let buffers;
    try {
      buffers = await pullBatch(device.id, chunk.map(f => f.path));
    } catch (e) {
      // tar gagal (mis. file hilang mid-batch) → fallback per-file untuk chunk ini
      buffers = null;
      state.log.push(`BATCH FALLBACK: ${e.message.split("\n")[0]}`);
    }
    for (const f of chunk) {
      try {
        // jalur streaming utk file raksasa (> 512 MB): HP -> disk tanpa buffer penuh, RAM konstan rendah.
        if (f.size > BATCH_BYTES) {
          const vol = pickVolume();
          const profName = db.prepare("SELECT name FROM profiles WHERE id = ?").get(targetProfile)?.name ?? "Default";
          const rel = path.join("profile", profName, f.path.replace(/^\/storage\/emulated\/0\/|^\/sdcard\//, "").replace(/[^\\/]+$/, ""));
          const localDir = path.join(vol.root, rel);
          fs.mkdirSync(localDir, { recursive: true });
          const localPath = path.join(localDir, path.basename(f.path));
          try {
            // progress byte-level: callback tiap chunk biar UI gak 0% selama transfer file raksasa
            const src = await pullFileStream(device.id, f.path, localPath + ".tmp", (transferred) => updateProgress(f.path, transferred, f.size));
            if (src.size === 0n) throw new Error("empty file from device");
            // verify: hash ulang file di disk, harus sama dengan hash sumber yang dihitung saat streaming
            const dst = await hashFileStream(localPath + ".tmp");
            if (dst.sha1 !== src.sha1 || dst.size !== src.size) throw new Error("verify failed: copy differs from source");
            fs.renameSync(localPath + ".tmp", localPath);
            const checksum = src.sha1;
            if (hasChecksum.get(checksum)) {
              dupes++;
              fs.rmSync(localPath, { force: true });
              state.log.push(`SKIP DUP: ${f.path} (identical file already in the vault)`);
              done++;
              continue;
            }
            insertFile.run(f.devPath, path.basename(f.path), guessMime(f.path), Number(src.size), f.mtime, relPath(localPath), checksum, null, null, null, null);
            const fileId = db.prepare("SELECT id FROM files WHERE checksum = ?").get(checksum)?.id;
            if (fileId) db.prepare("UPDATE files SET volume = ?, profile_id = ? WHERE id = ?").run(vol.name, targetProfile, fileId);
            ok++; bytes += Number(src.size);
            state.log.push(`STREAM OK (${(Number(src.size) / 1073741824).toFixed(2)} GB): ${f.path}`);
          } catch (e) {
            fs.rmSync(localPath + ".tmp", { force: true });
            throw e;
          }
          updateProgress(f.path);
          doneBytes += f.size;
        state.log.push(`${++done}/${filesToBackup.length}  ${f.path}`);
          continue;
        }
        const buf = buffers?.get(path.basename(f.path)) ?? (await phoneFile(device.id, f.path));
        if (!buf?.length) throw new Error("empty file from device");
        // sanity check: tolak file korup sebelum masuk vault (PDF truncated/protected, ukuran 0)
        if (/\.(pdf)$/i.test(f.path) && !buf.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
          state.log.push(`SKIP CORRUPT: ${f.path} (not a valid PDF — truncated or protected)`);
          fail++;
          done++;
          continue;
        }
        // pilih volume dengan free space terbesar (NAS-style pooling)
        const vol = pickVolume();
        const profName = db.prepare("SELECT name FROM profiles WHERE id = ?").get(targetProfile)?.name ?? "Default";
        // mirror path HP: profile/<Profile>/<path asli di HP> (Download/FolderPenting/data.pdf, DCIM/Camera/x.jpg, dll)
        const rel = path.join("profile", profName, f.path.replace(/^\/storage\/emulated\/0\/|^\/sdcard\//, "").replace(/[^\\/]+$/, ""));
        const localDir = path.join(vol.root, rel);
        fs.mkdirSync(localDir, { recursive: true });
        const localPath = path.join(localDir, path.basename(f.path));
        // temp-write + rename: file korup (disk dicabut mid-write) nggak akan pernah jadi localPath
        fs.writeFileSync(localPath + ".tmp", buf);
        fs.renameSync(localPath + ".tmp", localPath);
        // verifikasi copy: baca balik dari disk, hash harus sama dengan buffer dari HP
        const verifyBuf = fs.readFileSync(localPath);
        if (!verifyBuf.equals(buf)) throw new Error("verify failed: copy on disk differs from source (disk problem?)");
        // Immich-style: checksum + EXIF sekali saat ingest
        const checksum = crypto.createHash("sha1").update(buf).digest("hex");
        if (hasChecksum.get(checksum)) {
          dupes++;
          fs.rmSync(localPath, { force: true });
          state.log.push(`SKIP DUP: ${f.path} (identical file already in the vault)`);
          done++;
          continue;
        }
        let lat = null, lng = null, width = null, height = null;
        try {
          if (/\.(jpe?g|png|webp|heic)$/i.test(f.path)) {
            const meta = await exifr.parse(buf, { gps: true, tiff: true });
            if (meta) {
              if (meta.latitude != null) { lat = meta.latitude; lng = meta.longitude; }
              width = meta.ExifImageWidth ?? meta.ImageWidth ?? null;
              height = meta.ExifImageHeight ?? meta.ImageHeight ?? null;
            }
          }
        } catch {}
        insertFile.run(f.devPath, path.basename(f.path), guessMime(f.path), f.size, f.mtime, relPath(localPath), checksum, lat, lng, width, height);
        const fileId = db.prepare("SELECT id FROM files WHERE checksum = ?").get(checksum).id;
        db.prepare("UPDATE files SET volume = ?, profile_id = ? WHERE id = ?").run(vol.name, targetProfile, fileId);
        // thumbnail 250px WebP langsung saat backup (Immich-style); video pakai ffmpeg
        fs.mkdirSync(THUMB_DIR, { recursive: true });
        const thumbPath = path.join(THUMB_DIR, fileId + ".webp");
        if (isVideo(localPath)) {
          videoThumb(localPath, thumbPath).catch(() => {});
        } else if (/\.(jpe?g|png|webp|heic|gif|bmp)$/i.test(localPath)) {
          try {
            const thumb = await sharp(buf).rotate().resize(250, 250, { fit: "inside" }).webp({ quality: 80 }).toBuffer();
            fs.writeFileSync(thumbPath + ".tmp", thumb);
            fs.renameSync(thumbPath + ".tmp", thumbPath);
          } catch {}
        }
        ok++; bytes += f.size;
      } catch (e) {
        fail++;
        state.log.push(`FAILED: ${f.path} — ${e.message.split("\n")[0]} | ${e.stack.split("\n")[1]?.trim() ?? ""}`);
      }
      updateProgress(f.path);
      state.log.push(`${++done}/${filesToBackup.length}  ${f.path}`);
    }
  }
  state.log.push(`DONE — ${filesToBackup.length} Files Processed${dupes ? `, ${dupes} Duplicates Skipped` : ""}${skipped ? `, ${skipped} Already In Vault` : ""}`);
  db.prepare("INSERT INTO backup_log (device_id, profile_id, files_total, files_ok, files_failed, bytes) VALUES (?, ?, ?, ?, ?, ?)")
    .run(device.id, targetProfile, filesToBackup.length, ok, fail, bytes);
  state.backingUp = false; state.backupProgress = null;
  geocodeQueue().then(n => { if (n) console.log(`Geocode: ${n} lokasi baru di-resolve di background`); });
});

// backup kontak + SMS dari content provider Android → VCF + JSON
function parseContentRows(out) {
  return out.split("\n").filter(l => l.startsWith("Row:")).map(row => {
    const o = {};
    for (const part of row.replace(/^Row:\s*\d+\s*/, "").split(/,\s(?=[a-zA-Z_0-9]+=)/)) {
      const eq = part.indexOf("=");
      if (eq > 0) o[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return o;
  });
}

r.post("/backup-contacts", async (_req, res) => {
  try {
    const device = await getDevice();
    if (!device) return res.status(400).json({ error: "No Device Connected" });
    const q = async (uri, proj) =>
      parseContentRows(await adb("shell", `content query --uri ${uri} --projection ${proj} 2>/dev/null`).catch(() => ""));

    // kontak: gabung data rows per nama
    const rows = await q("content://com.android.contacts/data", "display_name:mimetype:data1");
    const contacts = new Map();
    for (const row of rows) {
      const name = row.display_name?.replace(/NULL/g, "").trim() || "(tanpa nama)";
      if (!contacts.has(name)) contacts.set(name, { name, phones: [], emails: [] });
      const c = contacts.get(name);
      const val = (row.data1 || "").replace(/^NULL$/, "");
      if (!val) continue;
      if (row.mimetype?.includes("phone_v2")) c.phones.push(val);
      if (row.mimetype?.includes("email")) c.emails.push(val);
    }

    // SMS (semua box)
    const sms = await q("content://sms", "_id:address:body:date:type");
    const smsClean = sms.map(s => ({ address: s.address, body: s.body, date: +s.date || 0, type: +s.type || 0 }))
      .filter(s => s.address && s.address !== "NULL");

    // call log (boleh gagal kalau permission belum ada)
    const calls = await q("content://call_log/calls", "number:duration:date:type");
    const callsClean = calls.map(c => ({ number: c.number, duration: +c.duration || 0, date: +c.date || 0, type: +c.type || 0 }))
      .filter(c => c.number && c.number !== "NULL");

    const profName = db.prepare("SELECT name FROM profiles WHERE id = ?").get(activeProfile())?.name ?? "Default";
    const dir = path.join(process.env.STORAGE_PATH, "profile", profName, "contacts");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);

    // vCard 3.0 — bisa di-import ke HP lain / Gmail / Outlook
    const vcf = [...contacts.values()].map(c => {
      let v = "BEGIN:VCARD\nVERSION:3.0\n";
      v += `FN:${c.name}\nN:${c.name.split(" ").reverse().join(";")}\n`;
      c.phones.forEach(p => { v += `TEL;TYPE=CELL:${p.replace(/\s/g, "")}\n`; });
      c.emails.forEach(e => { v += `EMAIL:${e}\n`; });
      v += "END:VCARD\n";
      return v;
    }).join("\n");
    fs.writeFileSync(path.join(dir, `contacts-${stamp}.vcf`), vcf);
    fs.writeFileSync(path.join(dir, `sms-${stamp}.json`), JSON.stringify(smsClean, null, 2));
    if (callsClean.length) fs.writeFileSync(path.join(dir, `calls-${stamp}.json`), JSON.stringify(callsClean, null, 2));

    res.json({
      contacts: contacts.size, sms: smsClean.length, calls: callsClean.length,
      callLogDenied: callsClean.length === 0,
      files: [`contacts/contacts-${stamp}.vcf`, `contacts/sms-${stamp}.json`],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// backup history
r.get("/history", (_req, res) => {
  res.json({ history: db.prepare("SELECT * FROM backup_log ORDER BY id DESC LIMIT 30").all() });
});

// ===== File Explorer operations (rename/mkdir/move/copy/delete) =====
// root = folder profile aktif, guard traversal + path relatif saja
function fmRoot() {
  const profileName = db.prepare("SELECT name FROM profiles WHERE id = ?").get(activeProfile())?.name ?? "Default";
  return path.join(process.env.STORAGE_PATH, "profile", profileName.replace(/[\\/:*?"<>|]/g, "_"));
}
function fmSafe(rel) {
  const root = fmRoot();
  const abs = path.resolve(path.join(root, String(rel ?? "")));
  return (abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep)) ? abs : null;
}

r.post("/fm/rename", express.json(), (req, res) => {
  const abs = fmSafe(req.body?.path);
  const name = String(req.body?.name ?? "").trim();
  if (!abs || !name || /[\\/:*?"<>|]/.test(name) || name.startsWith(".")) return res.status(400).json({ error: "Invalid Name Or Path" });
  if (!fs.existsSync(abs)) return res.sendStatus(404);
  const dest = path.join(path.dirname(abs), name);
  if (fs.existsSync(dest)) return res.status(409).json({ error: "A File With That Name Already Exists" });
  try {
    fs.renameSync(abs, dest);
    // update DB kalau file backup-an (local_path lama → baru)
    const oldRel = path.relative(fmRoot(), abs);
    const newRel = path.relative(fmRoot(), dest);
    db.prepare("UPDATE files SET local_path = ?, device_path = REPLACE(device_path, ?, ?), original_name = ? WHERE local_path = ?")
      .run(relPath(dest), oldRel, newRel, name, relPath(abs));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

r.post("/fm/mkdir", express.json(), (req, res) => {
  const abs = fmSafe(req.body?.path);
  if (!abs) return res.status(400).json({ error: "Invalid Path" });
  try {
    fs.mkdirSync(abs, { recursive: false });
    res.json({ ok: true });
  } catch (e) { res.status(e.code === "EEXIST" ? 409 : 500).json({ error: e.code === "EEXIST" ? "Folder Already Exists" : e.message }); }
});

r.post("/fm/transfer", express.json(), async (req, res) => {
  // body: { paths: [rel...], dest: relFolder, mode: "copy" | "move" }
  const { paths, dest, mode } = req.body ?? {};
  const destAbs = fmSafe(dest);
  if (!destAbs || !fs.existsSync(destAbs) || !fs.statSync(destAbs).isDirectory()) return res.status(400).json({ error: "Invalid Destination" });
  if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ error: "No Files Selected" });
  let done = 0, failed = 0, lastError = null;
  for (const p of paths) {
    const abs = fmSafe(p);
    if (!abs || !fs.existsSync(abs)) { failed++; continue; }
    if (abs === destAbs || path.dirname(abs) === destAbs && mode === "move") { failed++; continue; }
    const target = path.join(destAbs, path.basename(abs));
    if (fs.existsSync(target)) { failed++; lastError = `${path.basename(abs)}: name exists in destination`; continue; }
    try {
      if (mode === "copy") fs.cpSync(abs, target, { recursive: true });
      else {
        fs.renameSync(abs, target);
        // update DB path kalau file backup-an dipindah
        const oldRel = path.relative(fmRoot(), abs), newRel = path.relative(fmRoot(), target);
        db.prepare("UPDATE files SET local_path = ?, device_path = REPLACE(device_path, ?, ?) WHERE local_path = ?").run(relPath(target), oldRel, newRel, relPath(abs));
      }
      done++;
    } catch (e) { failed++; lastError = e.message; }
  }
  res.json({ ok: failed === 0, done, failed, error: lastError });
});

// batch download: zip multiple paths (file/folder) → stream ke browser
r.get("/fm/zip", async (req, res) => {
  const paths = (req.query.paths ?? "").toString().split(",").filter(Boolean).map(decodeURIComponent);
  if (!paths.length) return res.status(400).json({ error: "No Files Selected" });
  const root = fmRoot();
  const abs = paths.map(p => fmSafe(p)).filter(a => a && fs.existsSync(a));
  if (!abs.length) return res.sendStatus(404);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="nigiro-files-${Date.now()}.zip"`);
  // zip via tar.exe builtin Windows (bsdtar, -a = auto zip by extension) — jauh lebih cepat dari Compress-Archive
  const tmpZip = path.join(process.env.TEMP ?? ".", `nigiro-zip-${Date.now()}.zip`);
  const tmpDir = path.join(process.env.TEMP ?? ".", `nigiro-zip-${Date.now()}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const a of abs) {
      const target = path.join(tmpDir, path.basename(a));
      if (fs.statSync(a).isDirectory()) fs.cpSync(a, target, { recursive: true });
      else fs.copyFileSync(a, target);
    }
    await new Promise((ok, fail) => {
      childProcess.execFile("tar.exe", ["-a", "-c", "-f", tmpZip, "-C", tmpDir, "."],
        { windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024 }, (err) => err ? fail(err) : ok());
    });
    const stream = fs.createReadStream(tmpZip);
    stream.pipe(res);
    stream.on("end", () => { fs.rmSync(tmpDir, { recursive: true, force: true }); fs.rmSync(tmpZip, { force: true }); });
    stream.on("error", () => { fs.rmSync(tmpDir, { recursive: true, force: true }); fs.rmSync(tmpZip, { force: true }); });
  } catch (e) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpZip, { force: true });
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

r.post("/fm/delete", express.json(), (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
  if (!paths.length) return res.status(400).json({ error: "No Files Selected" });
  const trash = TRASH();
  fs.mkdirSync(trash, { recursive: true });
  let done = 0, failed = 0;
  for (const p of paths) {
    const abs = fmSafe(p);
    if (!abs || !fs.existsSync(abs)) { failed++; continue; }
    try {
      fs.renameSync(abs, path.join(trash, path.relative(fmRoot(), abs).replaceAll("/", "%2F")));
      db.prepare("DELETE FROM files WHERE local_path = ?").run(relPath(abs));
      done++;
    } catch { failed++; }
  }
  res.json({ ok: failed === 0, done, failed });
});

export default r;
