import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// fallback: kalau .env gak ke-load (mis. dijalankan dari folder root), set path default
process.env.DB_PATH ??= path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "NigiroCORE_Data", "metadata.db");
process.env.STORAGE_PATH ??= "E:\\NigiroCORE_Data";
fs.mkdirSync(path.dirname(process.env.DB_PATH), { recursive: true });
function open() { return new DatabaseSync(process.env.DB_PATH); }
let real = open();
// Proxy: kalau disk E: sempat offline, koneksi SQLite jadi permanen rusak ("disk I/O error").
// Deteksi error itu, buka koneksi baru, retry sekali — endpoint lain nggak ikut mati.
const isIOErr = (e) => {
  const m = String(e?.message || e);
  return m.includes("disk I/O error") || m.includes("database is not open") || m.includes("SQLITE_CANTOPEN");
};
const reopen = () => { try { real.close(); } catch {} real = open(); };
const wrapStmt = (stmt, sql) => new Proxy(stmt, {
  get(t, k) {
    const v = t[k];
    if (typeof v !== "function") return v;
    return (...a) => {
      try { return v.apply(t, a); }
      catch (e) {
        if (!isIOErr(e)) throw e;
        reopen();
        return real.prepare(sql)[k](...a); // statement lama mati → prepare ulang dari koneksi baru
      }
    };
  },
});
export const db = new Proxy({}, {
  get(_, k) {
    if (k === "prepare") return (...a) => { try { return wrapStmt(real.prepare(...a), a[0]); } catch (e) { if (!isIOErr(e)) throw e; reopen(); return wrapStmt(real.prepare(...a), a[0]); } };
    const v = real[k];
    return typeof v === "function"
      ? (...a) => { try { return v.apply(real, a); } catch (e) { if (!isIOErr(e)) throw e; reopen(); return real[k](...a); } }
      : v;
  },
});
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_path TEXT UNIQUE NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    local_path TEXT NOT NULL,
    synced_at INTEGER NOT NULL DEFAULT (unixepoch()),
    favorite INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_mtime ON files(mtime DESC);
  CREATE TABLE IF NOT EXISTS backup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    device_id TEXT NOT NULL,
    files_total INTEGER NOT NULL,
    files_ok INTEGER NOT NULL,
    files_failed INTEGER NOT NULL,
    bytes INTEGER NOT NULL
  );
`);

// migrasi: kolom Immich-style (checksum dedup + EXIF ingest) kalau DB lama belum punya
try { db.exec("ALTER TABLE files ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE files ADD COLUMN checksum TEXT"); } catch {}
try { db.exec("ALTER TABLE files ADD COLUMN lat REAL"); } catch {}
try { db.exec("ALTER TABLE files ADD COLUMN lng REAL"); } catch {}
try { db.exec("ALTER TABLE files ADD COLUMN width INTEGER"); } catch {}
try { db.exec("ALTER TABLE files ADD COLUMN height INTEGER"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_checksum ON files(checksum) WHERE checksum IS NOT NULL"); } catch {}
// multi-volume: kolom volume mencatat storage mana file disimpan (NAS-style storage pool)
try { db.exec("ALTER TABLE files ADD COLUMN volume TEXT DEFAULT 'main'"); } catch {}

// multi-device: registry device HP (serial ADB -> profile + source dirs per device)
try { db.exec(`CREATE TABLE IF NOT EXISTS devices (
  serial TEXT PRIMARY KEY,
  name TEXT,
  profile_id INTEGER,
  source_dirs TEXT NOT NULL DEFAULT '["/sdcard/DCIM","/sdcard/Download"]',
  last_seen INTEGER
)`); } catch {}

// QOL Settings: key-value preferences (trash retention, notif, dll)
try { db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`); } catch {}
export const getSetting = (k, dflt = null) => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value ?? dflt;
export const setSetting = (k, v) => db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v));

// ===== Profiles: pisahkan backup per orang (aku / ortu / teman) =====
try { db.exec(`CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  device_id TEXT,
  color TEXT NOT NULL DEFAULT '#D71921',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
)`); } catch {}
try { db.exec("ALTER TABLE files ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1"); } catch {}
try { db.exec("ALTER TABLE backup_log ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1"); } catch {}
// profile default "LO" (id 1) — dibuat sekali
try { db.prepare("INSERT OR IGNORE INTO profiles (id, name) VALUES (1, 'LO')").run(); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_profile ON files(profile_id)"); } catch {}
try { db.exec("ALTER TABLE profiles ADD COLUMN emoji TEXT"); } catch {}
// Archive (sembunyikan dari timeline tanpa delete) + Stack (burst grouping)
try { db.exec("ALTER TABLE files ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_archived ON files(archived)"); } catch {}

export const knownPaths = () =>
  new Set(db.prepare("SELECT device_path FROM files").all().map(r => r.device_path));

// ===== DB backup otomatis: metadata.db = nyawa semua fitur; HDD rawan, jadi diselamatkan ke C: =====
// backup harian + rolling 7 file; backup ditulis ke folder lokal (C:) biar gak ikut mati bareng HDD E:
const DB_BACKUP_DIR = () => getSetting("dbBackupDir") || path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE, "AppData", "Local"), "NigiroCORE", "db-backups");
export function backupDB() {
  try {
    const dir = DB_BACKUP_DIR();
    fs.mkdirSync(dir, { recursive: true });
    // checkpoint WAL dulu biar backup consistent
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    const dest = path.join(dir, `metadata-${new Date().toISOString().slice(0, 10)}.db`);
    fs.copyFileSync(process.env.DB_PATH, dest + ".tmp");
    fs.renameSync(dest + ".tmp", dest);
    // rolling: sisain 7 terbaru
    const files = fs.readdirSync(dir).filter(f => f.startsWith("metadata-") && f.endsWith(".db")).sort();
    for (const f of files.slice(0, -7)) fs.rmSync(path.join(dir, f), { force: true });
    setSetting("lastDbBackup", Date.now());
    return { ok: true, dest, count: files.length };
  } catch (e) { return { ok: false, error: e.message }; }
}
// jalan sekali per hari, cek tiap jam
let lastBackupDay = new Date().toISOString().slice(0, 10);
setInterval(() => {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== lastBackupDay) { lastBackupDay = today; const r = backupDB(); if (!r.ok) console.error("DB backup failed:", r.error); }
}, 60 * 60 * 1000).unref?.();
// backup pertama saat startup (kalau hari ini belum ada)
const _bkDir = DB_BACKUP_DIR();
if (!fs.existsSync(path.join(_bkDir, `metadata-${new Date().toISOString().slice(0, 10)}.db`))) {
  const r = backupDB();
  if (!r.ok) console.error("DB backup failed at startup:", r.error);
  else console.log(`DB backup: ${r.dest}`);
}

export const insertFile = db.prepare(
  "INSERT OR IGNORE INTO files (device_path, original_name, mime, size, mtime, local_path, checksum, lat, lng, width, height) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
);

export const hasPath = db.prepare("SELECT 1 FROM files WHERE device_path = ?");
export const hasChecksum = db.prepare("SELECT 1 FROM files WHERE checksum = ?");
