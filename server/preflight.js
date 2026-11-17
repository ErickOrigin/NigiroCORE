// ===== Pre-flight checks (pilot-style): storage, DB, port, ADB =====
// Server nolak start kalau storage/DB gagal — retry otomatis tiap 5s (disk bisa dicolok belakangan).
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const log = (icon, msg) => console.log(`  ${icon}  ${msg}`);
const wait = (s) => new Promise(r => setTimeout(r, s * 1000));

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once("error", () => resolve(false));
  s.once("listening", () => s.close(() => resolve(true)));
  s.listen(port);
});

export async function preflight() {
  console.log("\n  ┌─ PRE-FLIGHT CHECKS ─────────────────────────────");
  const results = { storage: false, db: false, port: false, adb: false };

  // 1. storage path (media backup)
  const sp = process.env.STORAGE_PATH;
  let diskWaited = false;
  while (true) {
    if (sp && fs.existsSync(sp)) { results.storage = true; log("✓", `Storage: ${sp}`); break; }
    if (!diskWaited) {
      diskWaited = true;
      log("✗", `Storage Not Found: ${sp ?? "(STORAGE_PATH not set)"}`);
      log("…", "Connect your data disk — retrying every 5s (Ctrl+C to quit)");
    }
    await wait(5);
  }

  // 1b. DB path (bisa beda drive dari storage — SSD recommended)
  const dbDir = path.dirname(process.env.DB_PATH ?? "");
  let dbWaited = false;
  while (true) {
    if (fs.existsSync(dbDir)) { results.dbDir = true; log("✓", `DB Dir: ${dbDir}`); break; }
    if (!dbWaited) {
      dbWaited = true;
      log("✗", `DB Dir Not Found: ${dbDir}`);
      log("…", "Connect the disk holding the database — retrying every 5s");
    }
    await wait(5);
  }

  // 2. database SQLite
  const dbp = process.env.DB_PATH;
  try {
    fs.accessSync(dbp, fs.constants.W_OK);
    results.db = true;
    log("✓", `Database: ${dbp} (${Math.round(fs.statSync(dbp).size / 1e6)} MB)`);
  } catch {
    // DB belum ada = first run, cek foldernya bisa dibuat
    try { fs.mkdirSync(path.dirname(dbp), { recursive: true }); results.db = true; log("✓", `Database: ${dbp} (new)`); }
    catch { log("✗", `Database Not Writable: ${dbp}`); }
  }
  if (!results.db) { log("•", "Fix the database path and restart."); process.exit(1); }

  // 3. port
  const port = Number(process.env.PORT ?? 3000);
  if (await portFree(port)) { results.port = true; log("✓", `Port: ${port} free`); }
  else log("⚠", `Port: ${port} in use — server may fail to bind`);

  // 4. ADB (opsional — warning saja)
  const adb = process.env.ADB_PATH;
  if (adb && fs.existsSync(adb)) { results.adb = true; log("✓", `ADB: ${adb}`); }
  else log("⚠", `ADB Not Found: ${adb ?? "(ADB_PATH not set)"} — phone backup will not work`);

  console.log("  └─────────────────────────────────────────────────\n");
  return results;
}
