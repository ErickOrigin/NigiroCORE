// ===== Storage Volumes (NAS-style pool) + SSE events =====
import { Router, json } from "express";
import path from "node:path";
import fs from "node:fs";
import { db, getSetting, setSetting } from "../db.js";

const r = Router();

// volume "main" = STORAGE_PATH dari .env; volume tambahan di tabel volumes
const MAIN = process.env.STORAGE_PATH;
const mainDisplayName = () => getSetting("mainVolumeName", "main");
const volumeRoots = () => [
  { name: "main", root: MAIN, builtin: true, display: mainDisplayName() },
  ...db.prepare("SELECT name, root FROM volumes").all(),
];
const volumeRoot = (name) => volumeRoots().find(v => v.name === name)?.root ?? MAIN;
const getPrimaryVolume = () => getSetting("primaryVolume", "main");
const setPrimaryVolume = (n) => setSetting("primaryVolume", n);
// backup baru masuk ke volume primary; kalau primary offline, fallback least-filled
function pickVolume() {
  const primary = volumeRoots().find(v => v.name === getPrimaryVolume());
  if (primary) {
    try { fs.statfsSync(primary.root); return { name: primary.name, root: primary.root }; } catch {}
  }
  let best = { name: "main", root: MAIN, free: -1 };
  for (const v of volumeRoots()) {
    try {
      const st = fs.statfsSync(v.root);
      const free = st.bfree * st.bsize;
      if (free > best.free) best = { name: v.name, root: v.root, free };
    } catch {}
  }
  return best;
}

// ===== SSE =====
const sseClients = new Set();
let eventCount = 0, lastBroadcast = 0;
r.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "hello" })}\n\n`);
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});
function broadcastVolumes() {
  const volumes = db.prepare("SELECT rowid AS id, name, root FROM volumes").all()
    .concat([{ id: "main", name: "main", root: MAIN }]);
  const payload = JSON.stringify({ type: "volumes", volumes, checkedAt: Date.now() });
  eventCount++; lastBroadcast = Date.now();
  for (const client of sseClients) {
    try { client.write(`data: ${payload}\n\n`); } catch { sseClients.delete(client); }
  }
}
// alert broadcaster dari routes/system.js — forward ke SSE clients
function broadcastAlerts(payloadObj) {
  const payload = JSON.stringify(payloadObj);
  for (const client of sseClients) { try { client.write(`data: ${payload}\n\n`); } catch { sseClients.delete(client); } }
}
export function getAlertBroadcaster() {
  return (active) => broadcastAlerts({ type: "alerts", active });
}
// deteksi unmount/plug fisik — watch tiap root, debounce 200ms biar gak spam
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function watchRoots() {
  for (const v of volumeRoots()) {
    try { fs.watch(v.root, { persistent: false }, debounce(broadcastVolumes, 200)); } catch {}
  }
}
watchRoots();

r.get("/volumes", (_req, res) => {
  const primary = getPrimaryVolume();
  const vols = volumeRoots().map(v => {
    let free = 0, total = 0, files = 0, used = 0, online = true;
    try {
      const st = fs.statfsSync(v.root);
      total = st.blocks * st.bsize; free = st.bfree * st.bsize;
    } catch { online = false; }
    try { files = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(size),0) used FROM files WHERE volume = ?").get(v.name); files = files.n; used = files ? db.prepare("SELECT COALESCE(SUM(size),0) s FROM files WHERE volume = ?").get(v.name).s : 0; } catch {}
    return { ...v, free, total, files, used, online, primary: v.name === primary };
  });
  res.json({ volumes: vols });
});
// health realtime — statfs tiap root, dipakai frontend polling fallback
r.get("/volumes/health", async (_req, res) => {
  const volumes = db.prepare("SELECT rowid AS id, name, root FROM volumes").all()
    .concat([{ id: "main", name: "main", root: MAIN }]);
  const health = await Promise.all(volumes.map(async v => {
    let online = false, free = 0, total = 0;
    try {
      const st = fs.statfsSync(v.root);
      online = true; total = st.blocks * st.bsize; free = st.bfree * st.bsize;
    } catch {}
    return { id: v.id, name: v.name, root: v.root, online, free, total };
  }));
  res.json({ volumes: health, checkedAt: Date.now(), sseClients: sseClients.size, events: eventCount, lastBroadcast });
});

// set volume primary (tujuan konsolidasi)
r.post("/volumes/:name/primary", (req, res) => {
  if (!volumeRoots().some(v => v.name === req.params.name)) return res.status(404).json({ error: "Volume Not Found" });
  setPrimaryVolume(req.params.name);
  broadcastVolumes();
  res.json({ ok: true, primary: req.params.name });
});

// rename volume (nama doang — root/path tidak berubah)
r.post("/volumes/:name/rename", json(), (req, res) => {
  const { name } = req.body ?? {};
  if (!name || !/^[a-zA-Z0-9_-]{1,8}$/.test(name)) return res.status(400).json({ error: "Name: Letters/Numbers/-/_ Max 8" });
  const old = req.params.name;
  try {
    const isBuiltin = old === "main";
    // main built-in: nama disimpan di settings (display name), root tetap STORAGE_PATH
    if (isBuiltin) {
      if (name === "main") { setSetting("mainVolumeName", "main"); return res.json({ ok: true }); }
      setSetting("mainVolumeName", name);
      return res.json({ ok: true });
    }
    if (name === "main") return res.status(400).json({ error: '"main" Is Reserved' });
    db.prepare("UPDATE volumes SET name = ? WHERE name = ?").run(name, old);
    db.prepare("UPDATE files SET volume = ? WHERE volume = ?").run(name, old);
    if (getPrimaryVolume() === old) setPrimaryVolume(name);
    broadcastVolumes();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message.includes("UNIQUE") ? "Name Already Used" : e.message });
  }
});

r.post("/volumes", json(), (req, res) => {
  const { name, root } = req.body ?? {};
  if (!name || !/^[a-zA-Z0-9_-]{1,8}$/.test(name)) return res.status(400).json({ error: "Nama volume: huruf/angka/-/_ max 8" });
  if (!root || !path.isAbsolute(root)) return res.status(400).json({ error: "Path harus absolut (mis. D:\\NigiroData atau /mnt/disk2)" });
  if (name === "main") return res.status(400).json({ error: '"main" adalah volume bawaan' });
  try { fs.mkdirSync(root, { recursive: true }); } catch (e) { return res.status(400).json({ error: `Tidak bisa membuat folder: ${e.message}` }); }
  try {
    db.prepare("INSERT INTO volumes (name, root) VALUES (?, ?)").run(name, root);
    broadcastVolumes();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message.includes("UNIQUE") ? "Path atau nama sudah dipakai" : e.message });
  }
});

r.delete("/volumes/:name", (req, res) => {
  // hanya boleh hapus kalau volume kosong (nggak ada file terdaftar) — data safety
  const n = db.prepare("SELECT COUNT(*) c FROM files WHERE volume = ?").get(req.params.name).c;
  if (n > 0) return res.status(400).json({ error: `Volume masih berisi ${n} file — kosongkan dulu (pindahkan/hapus)` });
  db.prepare("DELETE FROM volumes WHERE name = ?").run(req.params.name);
  broadcastVolumes();
  res.json({ ok: true });
});

// pindahkan file fisik antar volume + update DB (NAS-style migration)
r.post("/volumes/:name/move", json(), async (req, res) => {
  const { ids } = req.body ?? {};
  const target = volumeRoot(req.params.name);
  try { fs.statfsSync(target); } catch { return res.status(400).json({ error: "Volume target offline" }); }
  const rows = Array.isArray(ids) && ids.length
    ? db.prepare(`SELECT id, local_path, volume FROM files WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids)
    : db.prepare("SELECT id, local_path, volume FROM files").all();
  let moved = 0, failed = 0; const errors = [];
  for (const row of rows) {
    const fromRoot = volumeRoot(row.volume ?? "main");
    if (row.local_path.startsWith(target)) continue; // sudah di volume target
    try {
      if (!fs.existsSync(row.local_path)) { failed++; errors.push(`missing: ${row.local_path}`); continue; }
      const rel = path.relative(fromRoot, row.local_path);
      const dest = path.join(target, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { fs.renameSync(row.local_path, dest); } // cepat kalau same-drive
      catch (e) {
        if (e.code !== "EXDEV") throw e;
        fs.copyFileSync(row.local_path, dest); // cross-drive: copy + delete
        fs.rmSync(row.local_path);
      }
      db.prepare("UPDATE files SET local_path = ?, volume = ? WHERE id = ?").run(dest, req.params.name, row.id);
      moved++;
    } catch (e) {
      failed++;
      errors.push(`${path.basename(row.local_path)}: ${e.message}`);
    }
  }
  res.json({ moved, failed, errors: errors.slice(0, 10) });
  broadcastVolumes();
});

// browse direktori untuk tree picker volume (drive root pakai ?drive=1)
r.get("/volbrowse", (req, res) => {
  const p = String(req.query.path ?? "");
  try {
    if (req.query.drive) {
      const drives = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"]
        .map(d => d + ":\\").filter(d => fs.existsSync(d));
      return res.json({ path: "", dirs: drives.map(d => ({ name: d, path: d, isDrive: true })), storagePath: process.env.STORAGE_PATH ?? "" });
    }
    if (!path.isAbsolute(p) || p.length < 3) return res.status(400).json({ error: "Invalid Path" });
    const entries = fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith("."));
    res.json({ path: p, dirs: entries.map(e => ({ name: e.name, path: path.join(p, e.name) })) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

export { volumeRoots, volumeRoot, getPrimaryVolume, setPrimaryVolume, pickVolume, MAIN, broadcastVolumes };
export default r;
