// setup.js — First-Run Setup Wizard: Detect Drive + ADB, Write .env
// Run: node setup.js
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, a => r(a.trim())));
const confirm = async (q) => (await ask(q)).toLowerCase().startsWith("y");

const C = { reset: "\x1b[0m", dim: "\x1b[90m", bold: "\x1b[1m", cyan: "\x1b[96m", green: "\x1b[92m", yellow: "\x1b[93m", red: "\x1b[91m", white: "\x1b[97m" };
// deteksi SSD/HDD per drive letter (via PowerShell Get-PhysicalDisk; fallback "Unknown")
const _driveTypeCache = {};
const driveType = async (letter) => {
  letter = letter.toUpperCase();
  if (_driveTypeCache[letter]) return _driveTypeCache[letter];
  let t = "Unknown";
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync(
      `powershell -NoProfile -Command "(Get-PhysicalDisk | Where-Object DeviceId -eq (Get-Partition -DriveLetter ${letter} -ErrorAction SilentlyContinue).DiskNumber).MediaType"`,
      { timeout: 8000 }
    ).toString().trim();
    if (/SSD/i.test(out)) t = "SSD";
    else if (/HDD/i.test(out)) t = "HDD";
  } catch {}
  _driveTypeCache[letter] = t;
  return t;
};
const line = () => console.log(`${C.dim}  ────────────────────────────────────────────────${C.reset}`);
const fail = (msg) => { console.log(`\n  ${C.red}✗ ${msg}${C_reset()}`); process.exit(1); };
const C_reset = () => C.reset;
process.stdout.write("[2J[H");

const bannerText = `
${C.cyan}${C.bold}███╗   ██╗██╗ ██████╗ ██╗██████╗  ██████╗ 
████╗  ██║██║██╔════╝ ██║██╔══██╗██╔═══██╗
██╔██╗ ██║██║██║  ███╗██║██████╔╝██║   ██║
██║╚██╗██║██║██║   ██║██║██╔══██╗██║   ██║
██║ ╚████║██║╚██████╔╝██║██║  ██║╚██████╔╝${C.reset}
┌─┐┌─┐┬─┐┌─┐  ${C.dim}═══════════════════════════════════${C.reset}
│  │ │├┬┘├┤   ${C.dim}══════════════ v 1.0 ══════════════${C.reset}
└─┘└─┘┴└─└─┘  ${C.dim}═══════════════════════════════════${C.reset}
${C.dim}  ────────────────────────────────────────────────${C.reset}
${C.white}${C.bold}       F I R S T   R U N   S E T U P${C.reset}
${C.dim}       Personal Cloud · Backup · Media Server${C.reset}
${C.dim}  ────────────────────────────────────────────────${C.reset}
`;
console.log(bannerText);

// ─── 1. Detect All Local Drives + Sizes ─────────────────────────────
const drives = [];
for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
  try {
    const st = await fs.promises.statfs(`${letter}:\\`);
    const totalGb = Math.round((st.blocks * st.bsize) / 1e9);
    const freeGb = Math.round((st.bfree * st.bsize) / 1e9);
    if (totalGb > 50) drives.push({ letter, totalGb, freeGb });
  } catch {}
}
if (!drives.length) fail("No Suitable Drives Found.");

// ─── 2. Folder Browser (arrow keys, drill down/back) ───────────────
const listDirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => e.name).sort();
  } catch { return []; }
};

async function browseFolder(finalFolderName = null) {
  // finalFolderName: kalau diisi, preview "+ NigiroCORE_Data" saat milih root drive
  let cwd = null;            // null = drive list level
  let sel = 0;
  let items = drives.map(d => ({ name: d.letter + ":", path: d.letter + ":\\", drive: d }));

  const render = () => {
    // full clear + banner redraw — logo always intact
    process.stdout.write("\x1b[2J\x1b[H");
    console.log(bannerText);
    const header = cwd === null ? `${C.white}  Available Drives${C.reset}` : `${C.white}  Navigating:${C.reset} ${C.cyan}${cwd}${C.reset}`;
    console.log(header);
    // preview lokasi final: drive + subfolder otomatis (biar user tau "ooo nanti dibikinin di situ")
    if (finalFolderName) {
      const preview = cwd === null
        ? `${items[sel]?.path ?? ""}${finalFolderName}`
        : cwd.replace(/[\\\/]+$/, "") + "\\" + finalFolderName;
      console.log(`\x1b[2K  ${C.green}→ Will Create:${C.reset} ${C.bold}${preview}${C.reset}`);
    } else if (cwd !== null) {
      console.log(`\x1b[2K  ${C.green}→ Selected:${C.reset} ${C.bold}${cwd}${C.reset}`);
    }
    // sliding window over DIR rows only; back + use-here stay pinned
    const MAX = 10;
    const firstDir = items.findIndex(it => !it.isBack && !it.isHere);
    const lastDir = items.length - 1; // dirs are last
    const dirCount = lastDir - firstDir + 1;
    let start = firstDir;
    if (dirCount > MAX) {
      // cursor position relative to dirs; keep sel visible
      if (sel < firstDir) start = firstDir;                     // cursor on pinned rows
      else start = Math.max(firstDir, Math.min(sel - Math.floor(MAX / 2), lastDir - MAX + 1));
    }
    const end = Math.min(items.length, start + MAX);
    // pinned rows (back, use-here) render above/below the window
    items.forEach((it, i) => {
      if (!it.isBack && !it.isHere) {
        if (i < start || i >= end) return; // outside window
      }
      const cur = i === sel;
      const marker = cur ? `${C.cyan}>${C.reset} ` : "  ";
      const style = cur ? C.bold : "";
      let label;
      if (cwd === null) {
        const d = it.drive;
        label = `${it.name.padEnd(4)}  ${String(d.totalGb.toLocaleString("en-US")).padStart(7)} GB  ${C.dim}(Free ${d.freeGb.toLocaleString("en-US")} GB)${C.reset}`;
      } else if (it.isBack) {
        label = `${C.dim}.. (Back)${C.reset}`;
      } else if (it.isHere) {
        label = `${C.cyan}[ Use This Folder ]${C.reset}`;
      } else {
        label = `${C.dim}[DIR]${C.reset} ${it.name}`;
      }
      console.log(`\x1b[2K  ${marker}${style}${label}${C.reset}`);
    });
    const hidden = dirCount - (end - start);
    if (hidden > 0) console.log(`\x1b[2K  ${C.dim}  ▼ ${hidden} more below${C.reset}`);
    console.log(`\x1b[2K\n  ${C.dim}↑/↓ Move · → Open · ← Back · Enter Select · Esc Cancel${C.reset}`);
  };

  const enterDir = (dir) => {
    cwd = dir;
    const dirs = listDirs(dir);
    items = [{ isBack: true, name: ".." }, { isHere: true, name: "." }, ...dirs.map(n => ({ name: n, path: dir + n + "\\" }))];
    sel = 0;
    render();
  };

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    render();
    const onKey = (str, key) => {
      if (key.name === "up")   { sel = (sel - 1 + items.length) % items.length; render(); }
      else if (key.name === "down") { sel = (sel + 1) % items.length; render(); }
      else if (key.name === "right" || (key.name === "return" && cwd !== null && items[sel] && !items[sel].isHere && !items[sel].isBack)) {
        // open folder (or drive)
        if (cwd === null) enterDir(items[sel].path);
        else if (!items[sel].isBack && !items[sel].isHere) enterDir(items[sel].path);
      }
      else if (key.name === "left") {
        if (cwd === null) return;
        const parent = cwd.slice(0, -1);
        const i = Math.max(parent.lastIndexOf("\\"), parent.lastIndexOf("/"));
        if (i < 2) { // back to drive list
          cwd = null;
          items = drives.map(d => ({ name: d.letter + ":", path: d.letter + ":\\", drive: d }));
          sel = 0; render();
        } else enterDir(parent.slice(0, i + 1));
      }
      else if (key.name === "return") {
        if (cwd === null) { enterDir(items[sel].path); return; }
        if (items[sel].isBack) { onKey(null, { name: "left" }); return; }
        if (items[sel].isHere) {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.removeListener("keypress", onKey);
          process.stdout.write("\x1b[2K\x1b[1A\x1b[2K");
          resolve(cwd);
        }
        // Enter on a folder row = open it (handled above by right-arrow branch)
      }
      else if (key.name === "escape") {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        console.log("\n  Setup Cancelled.");
        process.exit(0);
      }
    };
    process.stdin.on("keypress", onKey);
  });
}

// ─── 2b. Scan Existing Install (NigiroCORE_Data di semua drive) ──────
const scanExisting = async () => {
  const found = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const marker = `${letter}:\\NigiroCORE_Data\\metadata.db`;
    try {
      await fs.promises.access(marker);
      const dbSize = (await fs.promises.stat(marker)).size;
      // hitung file media (murah: recursive walk tanpa stat per file)
      let nFiles = 0;
      const walk = (d) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (nFiles > 50000) return; if (e.isDirectory()) { if (!e.name.startsWith(".") || e.name === ".thumbs") walk(path.join(d, e.name)); } else nFiles++; } } catch {} };
      walk(`${letter}:\\NigiroCORE_Data\\profile`);
      found.push({ path: `${letter}:\\NigiroCORE_Data`, dbSize, nFiles });
    } catch {}
  }
  return found;
};
console.log(`\n  ${C.dim}Scanning For Existing Install...${C.reset}`);
const existing = await scanExisting();
let existingPath = null;
if (existing.length) {
  console.log(`\n  ${C.white}${C.bold}EXISTING INSTALL FOUND${C.reset}`);
  existing.forEach((x, i) => console.log(`    ${i + 1}. ${C.cyan}${x.path}${C.reset}  ${C.dim}(${x.nFiles.toLocaleString("en-US")} files, DB ${Math.round(x.dbSize / 1e6)} MB)${C.reset}`));
  console.log(`    0. ${C.dim}Start Fresh (new install)${C.reset}`);
  const choice = await ask(`  ${C.cyan}Use Which Install?${C.reset} [0-${existing.length}, Enter=fresh]: `);
  const idx = parseInt(choice);
  if (idx >= 1 && idx <= existing.length) existingPath = existing[idx - 1].path;
}

// ─── 3. Storage Location (media backup — HDD recommended) ───────────
let storagePath = existingPath;
if (!storagePath) {
  console.log(`\n  ${C.white}${C.bold}MEDIA BACKUP LOCATION${C.reset}`);
  console.log(`  ${C.dim}Folder NigiroCORE_Data — semua foto/video hasil backup HP disimpan di sini.${C.reset}`);
  console.log(`  ${C.dim}Recommended: HDD besar (1TB+), karena isinya bisa ratusan GB.${C.reset}`);
  const picked = await browseFolder("NigiroCORE_Data");
  // root drive → bikin subfolder biar gak nulis di root (Windows EPERM) + rapi
  storagePath = /^[A-Za-z]:\\?$/.test(picked) ? path.join(picked, "NigiroCORE_Data") : picked;
}
const storageDrive = storagePath[0].toUpperCase();
const storageType = await driveType(storageDrive);

// ─── 4. DB Location (metadata + thumbs — SSD recommended) ───────────
console.log(`\n  ${C.white}${C.bold}DATABASE LOCATION (The Brain)${C.reset}`);
console.log(`  ${C.dim}Folder NigiroCORE_DB — metadata.db (index semua file) + thumbnail cache.${C.reset}`);
console.log(`  ${C.dim}Ini "otak"-nya: dipanggil terus tiap buka gallery/scan. Recommended: SSD biar cepet.${C.reset}`);
console.log(`  ${C.dim}Media backup tetap aman di HDD — yang di SSD cuma index kecil (${C.reset}${C.dim}±MB${C.reset}${C.dim}).${C.reset}`);
let dbPath;
if (existingPath) {
  dbPath = `${existingPath[0]}:\\NigiroCORE_DB`;
  if (fs.existsSync(`${existingPath[0]}:\\NigiroCORE_DB\\metadata.db`)) {
    dbPath = `${existingPath[0]}:\\NigiroCORE_DB`; // old install: DB sudah ada di drive yang sama
  }
  dbPath = await ask(`  ${C.cyan}DB Location${C.reset} ${C.dim}(Enter=${dbPath})${C.reset}: `) || dbPath;
} else {
  const picked = await browseFolder("NigiroCORE_DB");
  dbPath = /^[A-Za-z]:\\?$/.test(picked) ? path.join(picked, "NigiroCORE_DB") : picked;
}
const dbDrive = dbPath[0].toUpperCase();
const dbType = await driveType(dbDrive);
if (storageDrive === dbDrive) console.log(`  ${C.yellow}!${C.reset} DB and media share drive ${dbDrive}: — OK, but separate disks are faster.`);
else console.log(`  ${C.green}✓${C.reset} DB on ${dbDrive}: (${dbType}), media on ${storageDrive}: (${storageType}) — ${dbType === "SSD" ? "ideal" : "OK"}.`);

// ─── 4b. Write Test (kedua lokasi — nulis di dalam subfolder, bukan root) ──
for (const p of [storagePath, dbPath]) {
  try {
    fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, ".nigiro-write-test");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    console.log(`  ${C.green}✓${C.reset} Write Test Passed: ${C.dim}${p}${C.reset}`);
  } catch (e) {
    fail(`Cannot Write To ${p} (${e.code ?? e.message}). Check Permissions Or Disk Health.`);
  }
}


// ─── 5. Existing Data Check (skip kalau existing install) ────────────
if (!existingPath && fs.existsSync(storagePath)) {
  const entries = fs.readdirSync(storagePath);
  if (entries.length) {
    console.log(`\n  ${C.yellow}!${C.reset} ${C.bold}${storagePath}${C.reset} already exists with ${C.white}${entries.length}${C.reset} item(s).`);
    const useExisting = await confirm(`  Use Existing Data? [y/N]: `);
    if (!useExisting) fail(`Set A Different Drive Or Remove ${storagePath} Manually.`);
    console.log(`  ${C.green}✓${C.reset} Keeping Existing Data.`);
  }
}

// ─── 6. Detect adb.exe In Common Locations ──────────────────────────
const adbCandidates = [
  "C:\\platform-tools\\adb.exe",
  path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk", "platform-tools", "adb.exe"),
  "C:\\Android\\platform-tools\\adb.exe",
];
const adbFound = adbCandidates.find(p => p && fs.existsSync(p));
let adb = adbFound;
if (adbFound) {
  console.log(`  ${C.green}✓${C.reset} ADB Found: ${C.dim}${adbFound}${C.reset}`);
} else {
  console.log(`\n  ${C.dim}ADB Not Found In Common Locations.${C.reset}`);
  adb = await ask(`  ${C.cyan}Path To adb.exe${C.reset} ${C.dim}(Enter To Skip, Phone Backup Disabled)${C.reset}: `);
  if (adb && !fs.existsSync(adb)) fail(`ADB Not Found At: ${adb}`);
}

// ─── 6b. Existing .env Check ─────────────────────────────────────────
const envPath = path.join(process.cwd(), "server", ".env");
if (fs.existsSync(envPath)) {
  console.log(`\n  ${C.yellow}!${C.reset} Existing Config Found: ${C.dim}${envPath}${C.reset}`);
  const overwrite = await confirm(`  Overwrite Existing Config? [y/N]: `);
  if (!overwrite) { console.log(`\n  ${C.dim}Setup Cancelled — Config Unchanged.${C.reset}\n`); process.exit(0); }
}

// ─── 7. Write .env ──────────────────────────────────────────────────
fs.writeFileSync(envPath, [
  "PORT=3000",
  `STORAGE_PATH=${storagePath}`,
  `DB_PATH=${dbPath}\\metadata.db`,
  `ADB_PATH=${adb || ""}`,
].join("\n") + "\n");

line();
console.log(`
  ${C.green}✓${C.reset} ${C.bold}Setup Complete${C.reset} — Config Written To ${C.dim}${envPath}${C.reset}
    Storage:  ${C.white}${storagePath}${C.reset} ${C.dim}(${storageType})${C.reset}
    Database: ${C.white}${dbPath}\\metadata.db${C.reset} ${C.dim}(${dbType})${C.reset}
    ADB:      ${C.white}${adb || "Not Configured (Phone Backup Disabled)"}${C.reset}

  ${C.dim}Start Server:${reset}
    ${C.white}cd server && node server.js${reset}
`);
rl.close();
