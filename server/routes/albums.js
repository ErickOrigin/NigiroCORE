// ===== Albums: manual + smart (rule-based), scoped per profile =====
import { Router, json } from "express";
import { db, getSetting } from "../db.js";

const r = Router();
const activeProfile = () => Number(getSetting("activeProfile", "1"));

// ===== Manual albums: kelompokkan foto manual (event, trip, dll) — scoped per profile =====
try { db.exec(`CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  profile_id INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`); } catch {}
try { db.exec("ALTER TABLE albums ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1"); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS album_files (
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL,
  PRIMARY KEY (album_id, file_id)
)`); } catch {}

// ===== Smart albums: album otomatis dari rule (place / year / favorite) =====
// rule JSON: { place?: "jogja", year?: 2025, favorite?: true }
try { db.exec(`CREATE TABLE IF NOT EXISTS smart_albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  rule TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`); } catch {}
const matchSmart = (row, rule) =>
  (!rule.place || (row.place ?? "").toLowerCase().includes(rule.place.toLowerCase())) &&
  (!rule.year || new Date(row.mtime * 1000).getFullYear() === rule.year) &&
  (!rule.favorite || row.favorite === 1);
const smartItems = (rule) =>
  db.prepare("SELECT id, original_name, mime, size, mtime FROM files WHERE archived = 0 AND profile_id = ?").all(activeProfile())
    .filter(row => matchSmart(row, rule));

r.get("/smart-albums", (_req, res) => {
  const albums = db.prepare("SELECT * FROM smart_albums ORDER BY id").all()
    .map(a => ({ ...a, rule: JSON.parse(a.rule), count: smartItems(JSON.parse(a.rule)).length }));
  res.json(albums);
});
r.post("/smart-albums", json(), (req, res) => {
  const { name, rule } = req.body ?? {};
  if (!name || !rule || typeof rule !== "object") return res.status(400).json({ error: "name + rule required" });
  try {
    const row = db.prepare("INSERT INTO smart_albums (name, rule) VALUES (?, ?)").run(name.trim(), JSON.stringify(rule));
    res.json({ ok: true, id: row.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message.includes("UNIQUE") ? "Name Already Used" : e.message }); }
});
r.delete("/smart-albums/:id", (req, res) => {
  db.prepare("DELETE FROM smart_albums WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
r.get("/smart-albums/:id/items", (req, res) => {
  const a = db.prepare("SELECT rule FROM smart_albums WHERE id = ?").get(req.params.id);
  if (!a) return res.sendStatus(404);
  res.json(smartItems(JSON.parse(a.rule)));
});

// ===== Manual albums =====
r.get("/albums", (_req, res) => {
  const albums = db.prepare(`SELECT a.id, a.name, a.created_at, COUNT(af.file_id) AS count
    FROM albums a LEFT JOIN album_files af ON af.album_id = a.id
    WHERE a.profile_id = ?
    GROUP BY a.id ORDER BY a.id`).all(activeProfile());
  res.json(albums);
});
r.post("/albums", json(), (req, res) => {
  const name = (req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "Name Required" });
  try {
    const row = db.prepare("INSERT INTO albums (name, profile_id) VALUES (?, ?)").run(name, activeProfile());
    res.json({ ok: true, id: row.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message.includes("UNIQUE") ? "Name Already Used" : e.message }); }
});
r.delete("/albums/:id", (req, res) => {
  db.prepare("DELETE FROM album_files WHERE album_id = ?").run(req.params.id);
  db.prepare("DELETE FROM albums WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
r.get("/albums/:id/items", (req, res) => {
  res.json(db.prepare(`SELECT f.id, f.original_name, f.mime, f.size, f.mtime FROM album_files af
    JOIN files f ON f.id = af.file_id WHERE af.album_id = ? AND f.profile_id = ? ORDER BY f.mtime DESC`).all(req.params.id, activeProfile()));
});
r.post("/albums/:id/files", json(), (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids Required" });
  const ins = db.prepare("INSERT OR IGNORE INTO album_files (album_id, file_id) VALUES (?, ?)");
  let added = 0;
  for (const id of ids) if (!db.prepare("SELECT 1 FROM files WHERE id = ?").get(id)) return res.status(400).json({ error: `File ${id} Not Found` });
  for (const id of ids) { const row = ins.run(req.params.id, id); added += row.changes; }
  res.json({ ok: true, added });
});
r.post("/albums/:id/remove", json(), (req, res) => {
  const ids = req.body?.ids;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "ids Required" });
  const del = db.prepare("DELETE FROM album_files WHERE album_id = ? AND file_id = ?");
  let removed = 0;
  for (const id of ids) removed += del.run(req.params.id, id).changes;
  res.json({ ok: true, removed });
});
// album mana saja yang memuat file ini (untuk badge di add-to-album dialog)
r.get("/albums-of/:fileId", (req, res) => {
  res.json(db.prepare("SELECT a.id FROM albums a JOIN album_files af ON af.album_id = a.id WHERE af.file_id = ?").all(req.params.fileId));
});

export default r;
