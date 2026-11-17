// ===== NIGIRO.MC — Minecraft server panel (Phase 1) =====
// Clean-room: pola referensi dari Kubek/hostcraft (lifecycle + task progress + console buffer),
// implementasi sendiri di atas pola NigiroCORE (spawn windowsHide, node:sqlite, no new deps).
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import express from "express";
import { spawn, execFile, execSync } from "node:child_process";
import { promisify } from "node:util";
import { db, getSetting, setSetting } from "./db.js";

const execFileP = promisify(execFile);
const MC_ROOT = () => path.join(process.env.STORAGE_PATH, "minecraft");
const JAVA_ROOT = () => path.join(process.env.STORAGE_PATH, "java");

try {
  db.exec(`CREATE TABLE IF NOT EXISTS mc_servers (
    name TEXT PRIMARY KEY,
    loader TEXT NOT NULL,
    mc_version TEXT NOT NULL,
    jar TEXT NOT NULL,
    java_major INTEGER,
    pid INTEGER,
    ram_mb INTEGER NOT NULL DEFAULT 2048,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
} catch {}
try { db.exec("ALTER TABLE mc_servers ADD COLUMN ram_mb INTEGER NOT NULL DEFAULT 2048"); } catch {}
try { db.exec("ALTER TABLE mc_servers ADD COLUMN java_id TEXT"); } catch {}

const mcJobs = {};   // id -> { pct, line, done, error, out }
const procs = {};    // name -> child process
const consoles = {}; // name -> { buf: [], dropped }
const pendingRestart = {}; // name -> true (restart setelah exit terjadwal)
const lineBuf = {};  // name -> partial line (line-buffering pola kubek instance-log.ts)

// persist console ke disk — survive panel restart (SSE INIT load dari sini)
const consoleLogFile = (name) => path.join(process.env.STORAGE_PATH, "minecraft", name.replace(/[\\/:*?"<>|]/g, "_"), "logs", "panel-console.log");
function consoleLoad(name) {
  try { return fs.readFileSync(consoleLogFile(name), "utf8").split("\n").filter(Boolean).slice(-500); } catch { return []; }
}
function consoleAppend(name, line) {
  try { fs.mkdirSync(path.dirname(consoleLogFile(name)), { recursive: true }); fs.appendFileSync(consoleLogFile(name), line + "\n"); } catch {}
}
const mcState = {};  // name -> { online, startedAt } (dari pola log, bukan polling)
const crashAttempts = {}; // name -> count (CrashRestartPolicy kubek)
const mcLogListeners = {}; // name -> Set(fn) untuk SSE console live (anti-dobel: satu Set per server)
const mcDash = {}; // name -> { players: [], maxPlayers, motd, joinedAt } (dari pola log: list command & join/leave)
const mcMetrics = {}; // name -> { cpu: [], mem: [], lastCpuTime, lastAt } — sampler JVM (CPU% + RSS)

// sampler JVM global: satu interval untuk semua server (pola persistent sampler, bukan spawn per request)
setInterval(() => {
  for (const [name, p] of Object.entries(procs)) {
    if (!p || p.killed || !p.pid) continue;
    execFileP("powershell", ["-NoProfile", "-Command",
      `$p = Get-Process -Id ${p.pid} -ErrorAction SilentlyContinue; if ($p) { "{0}:{1}" -f $p.TotalProcessorTime.TotalMilliseconds, $p.WorkingSet64 } else { "gone" }`],
    { windowsHide: true, timeout: 8000 }).then(({ stdout }) => {
      if (stdout.trim() === "gone") return;
      const [cpuMs, ws] = stdout.trim().split(":").map(Number);
      const m = (mcMetrics[name] ??= { cpu: [], mem: [], lastCpuTime: 0, lastAt: 0 });
      const now = Date.now();
      if (m.lastCpuTime && now > m.lastAt) {
        const cores = os.cpus().length;
        m.cpu.push(Math.min(100, Math.round(((cpuMs - m.lastCpuTime) / (now - m.lastAt) / cores) * 100)));
        if (m.cpu.length > 60) m.cpu.shift();
      }
      m.mem.push(Math.round(ws / 1048576)); // MB
      if (m.mem.length > 60) m.mem.shift();
      m.lastCpuTime = cpuMs; m.lastAt = now;
    }).catch(() => {});
  }
}, 5000).unref();

function job(id, patch) { const j = mcJobs[id]; if (j) Object.assign(j, patch); }
function newJob() { const id = Date.now().toString(36); mcJobs[id] = { pct: 0, line: "starting", done: false, error: null }; return id; }

// --- helpers ---
async function downloadTo(url, dest, onPct) {
  const fr = await fetch(url, { redirect: "follow" });
  if (!fr.ok) throw new Error(`download gagal HTTP ${fr.status}`);
  const total = +fr.headers.get("content-length") || 0;
  let got = 0; const chunks = [];
  for await (const ch of fr.body) {
    chunks.push(ch); got += ch.length;
    if (total && onPct) onPct(Math.round((got / total) * 100));
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

async function findJavaExe(dir) {
  // cari bin/java.exe di hasil extract (ada nesting jdk-21.x/bin)
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === "java.exe" && path.basename(d) === "bin") return full;
    }
  }
  return null;
}

async function detectJavaVersion(javaExe) {
  try {
    const { stdout, stderr } = await execFileP(javaExe, ["-version"]).catch(e => ({ stderr: e.message }));
    const out = (stdout || "") + (stderr || "");
    const m = out.match(/version "(\d+)/);
    return m ? +m[1] : null;
  } catch { return null; }
}

// java eksplisit (yang di-install panel) menang; kalau tidak ada, coba system java
async function resolveJava() {
  const managed = getSetting("mcJavaPath", "");
  if (managed && fs.existsSync(managed)) return { exe: managed, major: await detectJavaVersion(managed), managed: true };
  try {
    const { stderr } = await execFileP("java", ["-version"]);
    const m = stderr.match(/version "(\d+)/);
    if (m) return { exe: "java", major: +m[1], managed: false };
  } catch {}
  return null;
}

// daftar JDK ter-install panel (folder jdk-<major>-<vendor>)
function listManagedJavas() {
  try {
    return fs.readdirSync(JAVA_ROOT(), { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith("jdk-"))
      .map(e => {
        const exe = path.join(JAVA_ROOT(), e.name, "bin", "java.exe");
        if (!fs.existsSync(exe)) return null;
        const m = e.name.match(/^jdk-(\d+)-(\w+)$/);
        return { id: e.name, major: m ? +m[1] : null, vendor: m ? m[2] : "?", exe };
      })
      .filter(Boolean);
  } catch { return []; }
}

// resolve java untuk server: override per-server (java_id) menang, lalu global, lalu system
async function resolveJavaFor(s) {
  if (s.java_id) {
    const j = listManagedJavas().find(x => x.id === s.java_id);
    if (j) return { exe: j.exe, major: j.major, managed: true, perServer: true };
  }
  return resolveJava();
}

const minJavaFor = (mcVer) => {
  const parts = String(mcVer).split(".");
  const a = +parts[0], b = parts.length > 1 ? +parts[1] : 0;
  if (a > 1 || b > 20 || (b === 20 && (+parts[2] || 0) >= 5)) return 21; // 1.20.5+ butuh Java 21
  if (a === 1 && b >= 17) return 17;
  return 8;
};

// --- pure helpers (diekspor untuk self-check) ---
export function parseProperties(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return out;
}
export function stringifyProperties(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

export { minJavaFor };

// --- endpoints ---
export function registerMc(app) {
  const json = app; // express instance

  json.get("/api/mc/status", async (_req, res) => {
    try {
      const servers = db.prepare("SELECT rowid AS id, name, loader, mc_version, jar, pid, ram_mb, java_id FROM mc_servers ORDER BY created_at DESC").all();
      for (const s of servers) {
        if (procs[s.name] && !procs[s.name].killed) { s.running = true; s.online = !!mcState[s.name]?.online; continue; }
        // proses tidak dikenal di memori — cek pid tersisa (mis. setelah restart panel)
        s.running = false; s.online = false;
        if (s.pid) {
          try { process.kill(s.pid, 0); s.running = true; s.orphan = true; } catch {}
        }
      }
      res.json({ java: await resolveJava(), servers, installing: Object.entries(mcJobs).filter(([, j]) => !j.done).map(([id, j]) => ({ id, ...j })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  json.get("/api/mc/job/:id", (req, res) => {
    const j = mcJobs[req.params.id];
    if (!j) return res.status(404).json({ error: "Job Not Found" });
    res.json(j);
  });

  // install Java — Adoptium Marketplace (multi-vendor: temurin, microsoft, corretto/ibm, azul, alibaba)
  const JAVA_VENDORS = {
    temurin: "adoptium",
    microsoft: "microsoft",
    azul: "azul",
  };
  json.get("/api/mc/java/vendors", async (_req, res) => {
    try {
      const rels = await fetch("https://api.adoptium.net/v3/info/available_releases").then(r => r.json()).catch(() => null);
      res.json({ vendors: Object.keys(JAVA_VENDORS), lts: rels?.available_lts_releases ?? [8, 11, 17, 21, 25] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  json.post("/api/mc/java/install", async (req, res) => {    const { major, vendor } = req.body ?? {};
    const vendorId = JAVA_VENDORS[vendor ?? "temurin"];
    if (!vendorId) return res.status(400).json({ error: "Unknown Vendor" });
    const rels = await fetch("https://api.adoptium.net/v3/info/available_releases").then(r => r.json()).catch(() => null);
    const lts = rels?.available_lts_releases ?? [8, 11, 17, 21, 25];
    if (!lts.includes(+major)) return res.status(400).json({ error: "Version Is Not LTS" });
    // v3 binary endpoint: redirect langsung ke zip (pola kubek) — tanpa parse JSON asset
    const url = `https://api.adoptium.net/v3/binary/latest/${+major}/ga/windows/x64/jre/hotspot/normal/eclipse`;
    const dir = path.join(JAVA_ROOT(), "jdk-" + major + "-" + (vendor ?? "temurin"));
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, "java.zip");
    const id = newJob();
    job(id, { line: "downloading temurin " + (+major) + " (v3 binary)" });
    try { await downloadTo(url, zip, (pct) => job(id, { pct })); }
    catch (e) { job(id, { done: true, error: e.message }); return res.status(500).json({ error: e.message }); }
    job(id, { line: "extracting" });
    execSync(`powershell -NoProfile -Command "Expand-Archive -Force '${zip}' '${dir}'"`, { windowsHide: true, stdio: "ignore" });
    fs.rmSync(zip, { force: true });
    const exe = await findJavaExe(dir);
    if (!exe) {
      fs.rmSync(dir, { recursive: true, force: true }); // bersihkan sisa extract gagal
      job(id, { done: true, error: "java.exe Not Found After Extract — Folder Cleaned, Try Again" });
      return res.status(500).json({ error: "java.exe Not Found" });
    }
    setSetting("mcJavaPath", exe);
    setSetting("mcJavaMajor", String(+major));
    job(id, { done: true, line: "java " + (+major) + " ready", pct: 100 });
    res.json({ ok: true, major: +major, exe });
  });

  // --- server lifecycle ---
  const serverDir = (name) => path.join(MC_ROOT(), name.replace(/[\\/:*?"<>|]/g, "_"));

  json.post("/api/mc/create", async (req, res) => {
    const { name, loader, mcVersion } = req.body ?? {};
    if (!name || !/^[A-Za-z0-9_-]{1,40}$/.test(name)) return res.status(400).json({ error: "Invalid Name (Letters/Numbers/-/_)" });
    if (!["vanilla", "paper", "fabric"].includes(loader)) return res.status(400).json({ error: "Loader Not Supported" });
    if (!/^\d+\.\d+(\.\d+)?$/.test(mcVersion ?? "")) return res.status(400).json({ error: "Invalid Version" });
    const dir = serverDir(name);
    if (fs.existsSync(dir)) return res.status(400).json({ error: "A Server With That Name Already Exists" });
    const id = newJob();
    res.json({ id });
    (async () => {
      try {
        fs.mkdirSync(dir, { recursive: true });
        job(id, { line: "fetching " + loader + " " + mcVersion });
        let jarUrl;
        if (loader === "vanilla") {
          const manifest = await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json").then(r => r.json());
          const v = manifest.versions.find(v => v.id === mcVersion);
          if (!v) throw new Error("Vanilla Version Not Found");
          const detail = await fetch(v.url).then(r => r.json());
          jarUrl = detail.downloads.server.url;
        } else if (loader === "paper") {
          const builds = await fetch(`https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds`).then(r => r.json());
          if (!builds?.builds?.length) throw new Error("Paper Build Not Found");
          const b = builds.builds.at(-1).build;
          jarUrl = `https://api.papermc.io/v2/projects/paper/versions/${mcVersion}/builds/${b}/downloads/paper-${mcVersion}-${b}.jar`;
        } else {
          const v2 = await fetch(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`).then(r => r.json());
          if (!v2?.length) throw new Error("Fabric Loader Not Found");
          jarUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${v2[0].loader.version}/${v2[0].intermediary.version}/server/jar`;
        }
        const jarPath = path.join(dir, loader + ".jar");
        job(id, { line: "downloading jar" });
        await downloadTo(jarUrl, jarPath, (pct) => job(id, { pct }));
        fs.writeFileSync(path.join(dir, "eula.txt"), "eula=true\n");
        if (!fs.existsSync(path.join(dir, "server.properties"))) {
          fs.writeFileSync(path.join(dir, "server.properties"), "# generated by NigiroCORE\n");
        }
        db.prepare("INSERT INTO mc_servers (name, loader, mc_version, jar, java_major) VALUES (?,?,?,?,?)")
          .run(name, loader, mcVersion, loader + ".jar", minJavaFor(mcVersion));
        job(id, { done: true, pct: 100, line: "server " + name + " created" });
      } catch (e) {
        job(id, { done: true, error: e.message });
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    })();
  });

  json.post("/api/mc/start", (req, res) => {
    const { name } = req.body ?? {};
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(name);
    if (!s) return res.status(404).json({ error: "Server Not Found" });
    if (procs[name] && !procs[name].killed) return res.status(400).json({ error: "Already Running" });
    const dir = serverDir(name);
    if (!fs.existsSync(path.join(dir, s.jar))) return res.status(404).json({ error: "Jar Missing On Disk" });
    (async () => {
      const java = await resolveJavaFor(s);
      if (!java) return res.status(400).json({ error: "Java Not Installed Yet (Install It In The Panel First)" });
      if (java.major && s.java_major && java.major < s.java_major) return res.status(400).json({ error: `Java ${s.java_major}+ Required, Installed ${java.major}` });
      if (java.perServer) pushLog(name, `[using ${s.java_id}]`);
      const ram = Math.min(Math.max(+s.ram_mb || 2048, 512), 32768);
      const p = spawn(java.exe, [`-Xmx${ram}M`, "-jar", s.jar, "nogui"], { cwd: dir, windowsHide: true });
      procs[name] = p;
      consoles[name] = { buf: [], dropped: 0 };
      p.stdout.on("data", d => pushLog(name, d.toString()));
      p.stderr.on("data", d => pushLog(name, d.toString()));
      p.on("exit", (code) => {
        pushLog(name, `[process exited with code ${code}]`);
        db.prepare("UPDATE mc_servers SET pid = NULL WHERE name = ?").run(name);
        delete procs[name];
        const wasOnline = mcState[name]?.online;
        mcState[name] = { online: false, startedAt: mcState[name]?.startedAt };
        // CrashRestartPolicy (kubek crash-restart.ts): count crash, reset saat pernah ONLINE, cap attempts
        if (pendingRestart[name]) {
          delete pendingRestart[name];
          setTimeout(() => globalThis.__mcRestart(name), 5000);
          pushLog(name, "[scheduled restart in 5s]");
        } else if (code !== 0 && mcTasksGet(name)?.action === "restart") {
          const n = (crashAttempts[name] = wasOnline ? 1 : (crashAttempts[name] ?? 0) + 1);
          if (n <= 3) {
            setTimeout(() => globalThis.__mcRestart(name), 10000);
            pushLog(name, `[crash detected — auto restart ${n}/3 in 10s]`);
          } else {
            pushLog(name, "[crash loop — auto restart disabled (3 attempts exhausted)]");
          }
        }
      });
      p.on("spawn", () => db.prepare("UPDATE mc_servers SET pid = ? WHERE name = ?").run(p.pid, name));
      res.json({ ok: true, pid: p.pid ?? null });
    })().catch(e => res.status(500).json({ error: e.message }));
  });

  json.post("/api/mc/stop", (req, res) => {
    const { name } = req.body ?? {};
    const p = procs[name];
    if (!p) return res.status(400).json({ error: "Not Running" });
    // PendingStop (kubek pending-stop.ts): graceful stdin "stop" → timeout 30s → kill → 3s lagi → give-up flag
    try { p.stdin.write("stop\n"); } catch {}
    const t1 = setTimeout(() => { try { p.kill(); } catch {} }, 30000);
    const t2 = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 33000);
    p.once("exit", () => { clearTimeout(t1); clearTimeout(t2); });
    res.json({ ok: true });
  });

  json.post("/api/mc/cmd", (req, res) => {
    const { name, cmd } = req.body ?? {};
    const p = procs[name];
    if (!p || p.killed) return res.status(400).json({ error: "Not Running" });
    try { p.stdin.write(cmd + "\n"); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  json.get("/api/mc/console/:name", (req, res) => {
    const c = consoles[req.params.name];
    if (!c) return res.json({ log: [], running: !!procs[req.params.name] });
    res.json({ log: c.buf, dropped: c.dropped, running: !!procs[req.params.name], online: !!mcState[req.params.name]?.online });
  });

  // SSE console stream (pola opanel TerminalEndpoint): INIT = replay buffer, lalu live per baris
  json.get("/api/mc/console-stream/:name", (req, res) => {
    const name = req.params.name;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const c = consoles[name];
    // INIT-with-replay: disk history (survive restart) + in-memory buffer, baru live — tanpa gap
    const seen = new Set();
    for (const line of [...consoleLoad(name), ...(c?.buf ?? [])]) {
      if (seen.has(line)) continue; seen.add(line); // dedupe (buffer in-memory overlap disk)
      res.write(`data: ${JSON.stringify({ line })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ init: true, online: !!mcState[name]?.online })}\n\n`);
    const push = (line) => { try { res.write(`data: ${JSON.stringify({ line })}\n\n`); } catch {} };
    mcLogListeners[name] = (mcLogListeners[name] ?? new Set());
    mcLogListeners[name].add(push);
    const keepalive = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 25000);
    req.on("close", () => { clearInterval(keepalive); mcLogListeners[name]?.delete(push); if (!mcLogListeners[name]?.size) delete mcLogListeners[name]; });
  });

  // server.properties schema-driven (pola hostcraft properties.py): UI render form, bukan raw text
  const MC_PROPS_SCHEMA = [
    { section: "Gameplay", items: [
      { k: "gamemode", type: "enum", opts: ["survival", "creative", "adventure", "spectator"] },
      { k: "difficulty", type: "enum", opts: ["peaceful", "easy", "normal", "hard"] },
      { k: "hardcore", type: "bool" },
      { k: "pvp", type: "bool" },
      { k: "allow-flight", type: "bool" },
      { k: "allow-nether", type: "bool" },
      { k: "force-gamemode", type: "bool" },
      { k: "enable-command-block", type: "bool" },
      { k: "spawn-protection", type: "int", min: 0, max: 256 },
      { k: "max-tick-time", type: "int", min: 0, max: 2147483647 },
    ]},
    { section: "World", items: [
      { k: "level-seed", type: "text" },
      { k: "level-type", type: "enum", opts: ["minecraft\\:normal", "minecraft\\:flat", "minecraft\\:large_biomes", "minecraft\\:amplified"] },
      { k: "generate-structures", type: "bool" },
      { k: "max-world-size", type: "int", min: 1, max: 29999984 },
      { k: "view-distance", type: "int", min: 3, max: 32 },
      { k: "simulation-distance", type: "int", min: 5, max: 32 },
    ]},
    { section: "Players", items: [
      { k: "max-players", type: "int", min: 1, max: 2147483647 },
      { k: "white-list", type: "bool" },
      { k: "enforce-whitelist", type: "bool" },
      { k: "online-mode", type: "bool" },
      { k: "op-permission-level", type: "int", min: 0, max: 4 },
      { k: "player-idle-timeout", type: "int", min: 0, max: 2147483647 },
      { k: "spawn-protection", type: "int", min: 0, max: 256 },
    ]},
    { section: "Network", items: [
      { k: "server-port", type: "int", min: 1, max: 65535 },
      { k: "query.port", type: "int", min: 1, max: 65535 },
      { k: "rcon.port", type: "int", min: 1, max: 65535 },
      { k: "enable-rcon", type: "bool" },
      { k: "enable-query", type: "bool" },
      { k: "enable-status", type: "bool" },
      { k: "motd", type: "text" },
      { k: "network-compression-threshold", type: "int", min: -1, max: 2147483647 },
    ]},
  ];
  json.get("/api/mc/props-schema/:name", (req, res) => {
    const file = path.join(serverDir(req.params.name), "server.properties");
    if (!fs.existsSync(file)) return res.status(404).json({ error: "File Not Found" });
    const values = parseProperties(fs.readFileSync(file, "utf8"));
    const known = new Set(MC_PROPS_SCHEMA.flatMap(s => s.items.map(i => i.k)));
    const unknown = Object.keys(values).filter(k => !known.has(k)).map(k => [k, values[k]]);
    res.json({ values, schema: MC_PROPS_SCHEMA, unknown });
  });

  json.get("/api/mc/properties/:name", (req, res) => {
    const file = path.join(serverDir(req.params.name), "server.properties");
    if (!fs.existsSync(file)) return res.status(404).json({ error: "File Not Found" });
    res.type("text/plain").send(fs.readFileSync(file, "utf8"));
  });

  json.post("/api/mc/properties/:name", express.text({ type: () => true, limit: "1mb" }), (req, res) => {
    const file = path.join(serverDir(req.params.name), "server.properties");
    // guard path traversal: resolve harus tetap di dalam serverDir
    if (!path.resolve(file).startsWith(path.resolve(serverDir(req.params.name)))) return res.status(400).json({ error: "invalid" });
    fs.writeFileSync(file, String(req.body ?? ""));
    res.json({ ok: true });
  });

  // Dashboard per server (pola opanel InfoCard/PlayersCard/TimeCard): status + players + uptime + meta
  json.get("/api/mc/dashboard/:name", async (req, res) => {
    const name = req.params.name;
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(name);
    if (!s) return res.status(404).json({ error: "Server Not Found" });
    const running = !!procs[name] && !procs[name].killed;
    const online = running && !!mcState[name]?.online;
    const startedAt = mcState[name]?.startedAt ?? null;
    const dash = mcDash[name] ?? { players: [], maxPlayers: null, motd: null };
    // motd & port dari server.properties
    let motd = dash.motd, port = null;
    try {
      const props = parseProperties(fs.readFileSync(path.join(serverDir(name), "server.properties"), "utf8"));
      motd = props["motd"] ?? motd;
      port = props["server-port"] ?? null;
    } catch {}
    let players = dash.players;
    const maxPlayers = dash.maxPlayers;
    // kalau server online, refresh daftar player via `list` (hasilnya masuk pushLog → mcDash)
    if (online) mcCommandOrQueue(name, "list");
    res.json({
      name, loader: s.loader, mcVersion: s.mc_version, javaMajor: s.java_major,
      running, online, orphan: !running && s.pid ? await (async () => { try { process.kill(s.pid, 0); return true; } catch { return false; } })() : false,
      pid: s.pid, ramMb: s.ram_mb,
      uptimeSec: online && startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
      players, maxPlayers: maxPlayers ?? 20, motd, port,
      metrics: mcMetrics[name] ?? { cpu: [], mem: [] },
    });
  });

  json.post("/api/mc/delete", (req, res) => {
    const { name, confirm } = req.body ?? {};
    // konfirmasi ketik-nama (kubek server-deletion.service.ts) — cegah fat-finger
    if (confirm !== name) return res.status(400).json({ error: "Type The Server Name To Confirm Delete" });
    if (procs[name]) return res.status(400).json({ error: "Stop The Server Before Delete" });
    db.prepare("DELETE FROM mc_servers WHERE name = ?").run(name);
    try { fs.rmSync(serverDir(name), { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  });

  // --- Phase 2: Modrinth (mods + plugins) ---
  const MODRINTH = "https://api.modrinth.com/v2";

  json.get("/api/mc/modrinth/search", async (req, res) => {
    try {
      const q = String(req.query.q ?? "").slice(0, 80);
      const type = req.query.type === "plugin" ? "plugin" : "mod";
      const loader = ["paper", "fabric"].includes(req.query.loader) ? req.query.loader : null;
      const params = new URLSearchParams({ limit: "20", facets: JSON.stringify([["project_type:" + type]]) });
      if (loader) params.set("facets", JSON.stringify([["project_type:" + type], ["categories:" + loader]]));
      if (q) params.set("query", q);
      const r = await fetch(`${MODRINTH}/search?${params}`, { headers: { "User-Agent": "NigiroCORE/1.0" } }).then(r => r.json());
      res.json((r.hits ?? []).map(h => ({ slug: h.slug, title: h.title, desc: h.description, downloads: h.downloads, icon: h.icon_url, page: `https://modrinth.com/${h.project_type}/${h.slug}`, versions: h.versions?.slice(-3) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  json.post("/api/mc/modrinth/install", async (req, res) => {
    const { name, slug, version } = req.body ?? {};
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(name);
    if (!s) return res.status(404).json({ error: "Server Not Found" });
    if (procs[name]) return res.status(400).json({ error: "Stop The Server Before Installing Mods" });
    try {
      const v = version
        ? { files: (await fetch(`${MODRINTH}/version/${encodeURIComponent(version)}`, { headers: { "User-Agent": "NigiroCORE/1.0" } }).then(r => r.json())).files }
        : (await fetch(`${MODRINTH}/project/${encodeURIComponent(slug)}/version?loaders=["${s.loader}"]`, { headers: { "User-Agent": "NigiroCORE/1.0" } }).then(r => r.json()))[0];
      const file = v?.files?.find(f => f.primary) ?? v?.files?.[0];
      if (!file?.url) return res.status(404).json({ error: "No Version Found For Loader " + s.loader });
      const isPlugin = ["paper"].includes(s.loader);
      const dir = path.join(serverDir(name), isPlugin ? "plugins" : "mods");
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, file.filename.replace(/[\\/:*?"<>|]/g, "_"));
      await downloadTo(file.url, dest);
      res.json({ ok: true, file: file.filename, size: file.size });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  json.get("/api/mc/modrinth/list/:name", (req, res) => {
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(req.params.name);
    if (!s) return res.status(404).json({ error: "Server Not Found" });
    const dirs = s.loader === "paper" ? ["plugins"] : ["mods"];
    const out = [];
    for (const d of dirs) {
      const full = path.join(serverDir(req.params.name), d);
      let entries; try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) if (e.isFile() && /\.(jar|disabled)$/.test(e.name)) out.push({ file: e.name, dir: d });
    }
    res.json(out);
  });

  json.post("/api/mc/modrinth/remove", (req, res) => {
    const { name, dir, file } = req.body ?? {};
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(name);
    if (!s) return res.status(404).json({ error: "Server Not Found" });
    if (procs[name]) return res.status(400).json({ error: "Stop The Server First" });
    if (!["mods", "plugins"].includes(dir)) return res.status(400).json({ error: "Invalid Dir" });
    const f = path.basename(String(file)).replace(/[\\/:*?"<>|]/g, "_");
    try { fs.rmSync(path.join(serverDir(name), dir, f), { force: true }); } catch {}
    res.json({ ok: true });
  });

  // --- Hangar (PaperMC) — plugin Paper native, tanpa API key (pelajaran hostcraft) ---
  const HANGAR = "https://hangar.papermc.io/api/v1";
  // whitelist domain download (anti-SSRF, pola hostcraft)
  const HANGAR_DL_OK = /https:\/\/(hangarcdn\.papermc\.io|github\.com|objects\.githubusercontent\.com)\//;

  json.get("/api/mc/hangar/search", async (req, res) => {
    try {
      const q = String(req.query.q ?? "").slice(0, 80);
      const page = Math.max(1, Math.min(100, Math.round(+req.query.page) || 1)); // 1-based
      const perPage = Math.max(1, Math.min(20, Math.round(+req.query.perPage) || 10));
      const params = new URLSearchParams({ limit: String(perPage), offset: String((page - 1) * perPage) });
      if (q) params.set("query", q);
      const r = await fetch(`${HANGAR}/projects?${params}`, { headers: { "User-Agent": "NigiroCORE/1.0" } }).then(r => r.json());
      const items = (r.result ?? []).map(p => ({
        slug: `${p.namespace.owner}/${p.namespace.slug}`,
        title: p.name,
        desc: p.description,
        downloads: p.stats?.downloads ?? 0,
        icon: p.avatarUrl,
        page: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
        hangar: true,
      }));
      const total = r.pagination?.count ?? items.length;
      res.json({ items, page, perPage, total, hasMore: page * perPage < total });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  json.post("/api/mc/hangar/install", async (req, res) => {
    const { name, slug } = req.body ?? {};
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(name);
    if (!s) return res.status(404).json({ error: "Server Not Found" });
    if (s.loader !== "paper") return res.status(400).json({ error: "Hangar Is Paper-Only" });
    if (procs[name]) return res.status(400).json({ error: "Stop The Server Before Installing Plugins" });
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug ?? "")) return res.status(400).json({ error: "Invalid Slug" });
    try {
      const vs = await fetch(`${HANGAR}/projects/${encodeURIComponent(slug)}/versions?limit=1`, { headers: { "User-Agent": "NigiroCORE/1.0" } }).then(r => r.json());
      const v = vs.result?.[0];
      const dl = v?.downloads?.PAPER?.downloadUrl;
      const ext = v?.downloads?.PAPER?.externalUrl;
      const url = dl || ext;
      if (!url || !HANGAR_DL_OK.test(url)) return res.status(404).json({ error: "Paper Version Not Found (Or Download Outside Whitelist)" });
      const file = url.split("/").pop().split("?")[0].replace(/[\\/:*?"<>|]/g, "_");
      const dir = path.join(serverDir(name), "plugins");
      fs.mkdirSync(dir, { recursive: true });
      await downloadTo(url, path.join(dir, file));
      res.json({ ok: true, file });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // --- Phase 3: ngrok TCP tunnel (pengganti playit) ---
  const NGROK_DIR = () => path.join(process.env.STORAGE_PATH, "ngrok");
  let ngrokProc = null;
  let ngrokLog = [];

  async function ngrokExe() {
    const dir = NGROK_DIR();
    const exe = path.join(dir, "ngrok.exe");
    if (fs.existsSync(exe)) return exe;
    fs.mkdirSync(dir, { recursive: true });
    // resolve asset terbaru dari ngrok download API (windows amd64 zip)
    const rel = await fetch("https://ngrok-download.s3.us-west-2.amazonaws.com/stable.json").then(r => r.json()).catch(() => null);
    const url = rel?.windows?.amd64 ?? "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip";
    job("ngrok-dl", { pct: 0, line: "downloading ngrok", done: false, error: null });
    const zip = path.join(dir, "ngrok.zip");
    await downloadTo(url, zip, pct => job("ngrok-dl", { pct }));
    execSync(`powershell -NoProfile -Command "Expand-Archive -Force '${zip}' '${dir}'"`, { windowsHide: true, stdio: "ignore" });
    fs.rmSync(zip, { force: true });
    job("ngrok-dl", { done: true, pct: 100, line: "ngrok ready" });
    return exe;
  }

  async function ngrokTunnels() {
    try {
      const j = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(3000) }).then(r => r.json());
      return (j.tunnels ?? []).map(t => t.public_url).filter(u => u?.startsWith("tcp://"));
    } catch { return []; }
  }

  async function ngrokStart(port, token) {
    if (ngrokProc && !ngrokProc.killed) return;
    ngrokLog = [];
    const exe = await ngrokExe();
    const args = token ? ["config", "add-authtoken", token] : null;
    if (args) await new Promise((ok, err) => {
      const p = spawn(exe, args, { cwd: NGROK_DIR(), windowsHide: true });
      p.on("exit", c => c === 0 ? ok() : err(new Error("authtoken ditolak (code " + c + ")")));
      p.on("error", err);
    });
    ngrokProc = spawn(exe, ["tcp", String(port || 25565), "--log", "stdout", "--log-format", "logfmt"], { cwd: NGROK_DIR(), windowsHide: true });
    const feed = (d) => {
      const lines = d.toString().split("\n").filter(l => l.trim()).map(l => l.slice(0, 300));
      ngrokLog.push(...lines);
      if (ngrokLog.length > 200) ngrokLog.splice(0, ngrokLog.length - 200);
    };
    ngrokProc.stdout.on("data", feed);
    ngrokProc.stderr.on("data", feed);
    ngrokProc.on("exit", (code) => { ngrokLog.push(`[ngrok exited code ${code}]`); ngrokProc = null; });
  }

  json.get("/api/mc/tunnel/status", async (_req, res) => {
    const urls = ngrokProc && !ngrokProc.killed ? await ngrokTunnels() : [];
    res.json({
      running: !!ngrokProc && !ngrokProc.killed,
      address: urls[0] ? urls[0].replace("tcp://", "") : null,
      log: ngrokLog.slice(-30),
    });
  });

  json.post("/api/mc/tunnel/start", async (req, res) => {
    try {
      const { token, port } = req.body ?? {};
      // token wajib sekali (disimpan ke config ngrok) — setelah itu start ulang tanpa token
      if (!token && !fs.existsSync(path.join(process.env.APPDATA ?? "", "ngrok", "ngrok.yml"))) {
        const saved = getSetting("ngrokToken");
        if (!saved) return res.status(400).json({ error: "Authtoken Required — Sign Up Free At dashboard.ngrok.com" });
      }
      await ngrokStart(port, token || getSetting("ngrokToken"));
      if (token) setSetting("ngrokToken", token);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  json.post("/api/mc/tunnel/stop", (_req, res) => {
    if (ngrokProc) { try { ngrokProc.kill(); } catch {} }
    res.json({ ok: true });
  });

  // --- Per-server Java runtime ---
  json.get("/api/mc/javas", (_req, res) => res.json(listManagedJavas()));
  json.post("/api/mc/java-set", (req, res) => {
    const { name, javaId } = req.body ?? {};
    if (!db.prepare("SELECT name FROM mc_servers WHERE name = ?").get(name)) return res.status(404).json({ error: "Server Not Found" });
    if (javaId && !listManagedJavas().some(j => j.id === javaId)) return res.status(400).json({ error: "Runtime Not Found" });
    db.prepare("UPDATE mc_servers SET java_id = ? WHERE name = ?").run(javaId || null, name);
    res.json({ ok: true });
  });

  // --- RAM per server ---
  json.post("/api/mc/ram", (req, res) => {
    const { name, ramMb } = req.body ?? {};
    const ram = Math.min(Math.max(Math.round(+ramMb), 512), 32768);
    if (!Number.isFinite(ram)) return res.status(400).json({ error: "Invalid RAM" });
    db.prepare("UPDATE mc_servers SET ram_mb = ? WHERE name = ?").run(ram, name);
    res.json({ ok: true, ramMb: ram });
  });

  // --- Backup / restore world (zip snapshot per tanggal) ---
  const BACKUP_ROOT = () => path.join(MC_ROOT(), "_backups");
  function zipDir(src, dest) {
    // ponytail: PowerShell Compress-Archive — cukup untuk world kecil-menengah; upgrade ke yazl kalau world >2GB
    execSync(`powershell -NoProfile -Command "Compress-Archive -Force -Path '${src}\\*' -DestinationPath '${dest}'"`, { windowsHide: true, stdio: "ignore", timeout: 600000 });
  }
  function unzipTo(zip, dest) {
    execSync(`powershell -NoProfile -Command "Expand-Archive -Force -Path '${zip}' -DestinationPath '${dest}'"`, { windowsHide: true, stdio: "ignore", timeout: 600000 });
  }
  json.get("/api/mc/backups/:name", (req, res) => {
    const dir = path.join(BACKUP_ROOT(), req.params.name);
    let out = [];
    try { out = fs.readdirSync(dir).filter(f => f.endsWith(".zip")).map(f => ({ file: f, size: fs.statSync(path.join(dir, f)).size, at: fs.statSync(path.join(dir, f)).mtimeMs })); } catch {}
    res.json(out.sort((a, b) => b.at - a.at));
  });
  json.post("/api/mc/backup", (req, res) => {
    const { name } = req.body ?? {};
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(name);
    if (!s) return res.status(404).json({ error: "Server Not Found" });
    if (procs[name]) return res.status(400).json({ error: "Stop The Server Before Backup (Avoids World Corruption)" });
    const dir = serverDir(name);
    const bdir = path.join(BACKUP_ROOT(), name);
    fs.mkdirSync(bdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const dest = path.join(bdir, `${name}-${stamp}.zip`);
    try { zipDir(dir, dest); } catch (e) { return res.status(500).json({ error: e.message }); }
    res.json({ ok: true, file: path.basename(dest), size: fs.statSync(dest).size });
  });
  json.post("/api/mc/restore", (req, res) => {
    const { name, file } = req.body ?? {};
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(name);
    if (!s) return res.status(404).json({ error: "Server Not Found" });
    if (procs[name]) return res.status(400).json({ error: "Stop The Server Before Restore" });
    const zip = path.join(BACKUP_ROOT(), name, path.basename(String(file)).replace(/[\\/:*?"<>|]/g, "_"));
    if (!fs.existsSync(zip)) return res.status(404).json({ error: "Backup Not Found" });
    const dir = serverDir(name);
    try {
      // hapus world & configs lama, lalu extract snapshot (jar tidak ikut di-backup? ikut — snapshot full dir)
      for (const e of fs.readdirSync(dir)) {
        if (e === "java.zip") continue;
        fs.rmSync(path.join(dir, e), { recursive: true, force: true });
      }
      unzipTo(zip, dir);
    } catch (e) { return res.status(500).json({ error: e.message }); }
    res.json({ ok: true });
  });
  json.post("/api/mc/backup/delete", (req, res) => {
    const { name, file } = req.body ?? {};
    const f = path.basename(String(file)).replace(/[\\/:*?"<>|]/g, "_");
    try { fs.rmSync(path.join(BACKUP_ROOT(), name, f), { force: true }); } catch {}
    res.json({ ok: true });
  });

  // --- Scheduled tasks (interval-based; loop dijalankan sekali saat register) ---
  const mcTasks = {}; // name -> { action: "restart"|"stop", intervalMin, nextAt }
  const mcTasksGet = (n) => mcTasks[n];
  // ekspor akses untuk exit-handler (didefinisikan di luar registerMc — lihat bawah)
  globalThis.__mcTasks = mcTasks;
  globalThis.__mcPendingRestart = pendingRestart;
  globalThis.__mcRestart = (name) => {
    // trigger ulang endpoint start secara internal
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(name);
    if (!s) return;
    const dir = serverDir(name);
    if (!fs.existsSync(path.join(dir, s.jar))) return;
    (async () => {
      const java = await resolveJavaFor(s);
      if (!java) return;
      const ram = Math.min(Math.max(+s.ram_mb || 2048, 512), 32768);
      const p = spawn(java.exe, [`-Xmx${ram}M`, "-jar", s.jar, "nogui"], { cwd: dir, windowsHide: true });
      procs[name] = p;
      if (!consoles[name]) consoles[name] = { buf: [], dropped: 0 };
      p.stdout.on("data", d => pushLog(name, d.toString()));
      p.stderr.on("data", d => pushLog(name, d.toString()));
      p.on("exit", (code) => {
        pushLog(name, `[process exited with code ${code}]`);
        db.prepare("UPDATE mc_servers SET pid = NULL WHERE name = ?").run(name);
        delete procs[name];
        if (globalThis.__mcPendingRestart[name]) {
          delete globalThis.__mcPendingRestart[name];
          setTimeout(() => globalThis.__mcRestart(name), 5000);
        } else if (code !== 0 && globalThis.__mcTasks[name]?.action === "restart") {
          setTimeout(() => globalThis.__mcRestart(name), 10000);
        }
      });
      p.on("spawn", () => db.prepare("UPDATE mc_servers SET pid = ? WHERE name = ?").run(p.pid, name));
    })();
  };
  json.get("/api/mc/tasks/:name", (req, res) => res.json(mcTasks[req.params.name] ?? null));
  json.post("/api/mc/tasks", (req, res) => {
    const { name, action, intervalMin } = req.body ?? {};
    if (!db.prepare("SELECT name FROM mc_servers WHERE name = ?").get(name)) return res.status(404).json({ error: "Server Not Found" });
    if (!["restart", "stop"].includes(action)) return res.status(400).json({ error: "Invalid Action" });
    const min = Math.min(Math.max(Math.round(+intervalMin), 5), 1440);
    if (!Number.isFinite(min)) return res.status(400).json({ error: "Invalid Interval" });
    mcTasks[name] = { action, intervalMin: min, nextAt: Date.now() + min * 60000 };
    res.json({ ok: true, ...mcTasks[name] });
  });
  json.post("/api/mc/tasks/clear", (req, res) => { delete mcTasks[(req.body ?? {}).name]; res.json({ ok: true }); });
  setInterval(() => {
    const now = Date.now();
    for (const [name, t] of Object.entries(mcTasks)) {
      if (now < t.nextAt) continue;
      t.nextAt = now + t.intervalMin * 60000;
      const p = procs[name];
      if (t.action === "stop") {
        if (p) { try { p.stdin.write("stop\n"); } catch {} }
        delete mcTasks[name];
      } else if (p) {
        try { p.stdin.write("stop\n"); } catch {}
        // restart setelah exit — flag dibaca di handler exit
        pendingRestart[name] = true;
      }
    }
  }, 30000).unref();

  // --- Whitelist / ops manager ---
  function mcCommandOrQueue(name, cmd) {
    const p = procs[name];
    if (p && !p.killed) { try { p.stdin.write(cmd + "\n"); return true; } catch {} }
    return false;
  }
  json.post("/api/mc/players", (req, res) => {
    const { name, op, player } = req.body ?? {};
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(name);
    if (!s) return res.status(404).json({ error: "Server Not Found" });
    if (!/^[A-Za-z0-9_]{3,16}$/.test(player ?? "")) return res.status(400).json({ error: "Invalid Player Name" });
    const cmd = { "whitelist-add": `whitelist add ${player}`, "whitelist-remove": `whitelist remove ${player}`, "op": `op ${player}`, "deop": `deop ${player}` }[op];
    if (!cmd) return res.status(400).json({ error: "Invalid OP Command" });
    if (!mcCommandOrQueue(name, cmd)) {
      // server mati — tulis langsung ke file json
      const dir = serverDir(name);
      const fileMap = { "whitelist-add": ["whitelist.json", true], "whitelist-remove": ["whitelist.json", false], "op": ["ops.json", true], "deop": ["ops.json", false] };
      const [file, add] = fileMap[op];
      const fp = path.join(dir, file);
      let arr = [];
      try { arr = JSON.parse(fs.readFileSync(fp, "utf8")); } catch {}
      if (add) { if (!arr.some(e => e.name?.toLowerCase() === player.toLowerCase())) arr.push({ uuid: "", name: player }); }
      else arr = arr.filter(e => e.name?.toLowerCase() !== player.toLowerCase());
      fs.writeFileSync(fp, JSON.stringify(arr, null, 2));
    }
    res.json({ ok: true });
  });
  json.get("/api/mc/players/:name", (req, res) => {
    const dir = serverDir(req.params.name);
    const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return []; } };
    const online = mcDash[req.params.name]?.players ?? [];
    res.json({
      whitelist: read("whitelist.json"),
      ops: read("ops.json"),
      online,
      // gabung: semua player yang dikenal server (whitelist + ops + online), status online ditandai
      all: (() => {
        const seen = new Map();
        for (const w of read("whitelist.json")) if (w.name) seen.set(w.name.toLowerCase(), { name: w.name, uuid: w.uuid ?? "", online: online.includes(w.name), whitelisted: true, op: false });
        for (const o of read("ops.json")) if (o.name) { const k = o.name.toLowerCase(); const e = seen.get(k) ?? { name: o.name, uuid: o.uuid ?? "", online: online.includes(o.name), whitelisted: false, op: false }; e.op = true; seen.set(k, e); }
        for (const p of online) { const k = p.toLowerCase(); const e = seen.get(k) ?? { name: p, uuid: "", online: true, whitelisted: false, op: false }; e.online = true; seen.set(k, e); }
        return [...seen.values()];
      })(),
    });
  });
  // kick/ban via console (hanya saat server jalan — kick/ban butuh server hidup)
  json.post("/api/mc/players/action", (req, res) => {
    const { name, action, player, reason } = req.body ?? {};
    const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(name);
    if (!s) return res.status(404).json({ error: "Server Not Found" });
    if (!/^[A-Za-z0-9_]{3,16}$/.test(player ?? "")) return res.status(400).json({ error: "Invalid Player Name" });
    const cmdMap = {
      kick: `kick ${player}${reason ? " " + reason.replace(/[\r\n]/g, " ").slice(0, 120) : ""}`,
      ban: `ban ${player}${reason ? " " + reason.replace(/[\r\n]/g, " ").slice(0, 120) : ""}`,
      pardon: `pardon ${player}`,
    };
    const cmd = cmdMap[action];
    if (!cmd) return res.status(400).json({ error: "Invalid Action" });
    if (!mcCommandOrQueue(name, cmd)) return res.status(400).json({ error: "Server Must Be Running For " + action });
    res.json({ ok: true });
  });

  // --- File manager (browse/upload/download/delete, guard traversal) ---
  function safeServePath(name, rel) {
    const base = path.resolve(serverDir(name));
    const full = path.resolve(base, String(rel ?? ""));
    return (full === base || full.startsWith(base + path.sep)) ? full : null;
  }
  json.get("/api/mc/files/:name", (req, res) => {
    const rel = req.query.path ?? "";
    const full = safeServePath(req.params.name, rel);
    if (!full || !fs.existsSync(full)) return res.status(404).json({ error: "Not Found" });
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      res.json({ dir: true, entries: fs.readdirSync(full, { withFileTypes: true }).map(e => ({ name: e.name, dir: e.isDirectory(), size: e.isFile() ? fs.statSync(path.join(full, e.name)).size : 0 })) });
    } else {
      res.type("text/plain").send(fs.readFileSync(full, "utf8"));
    }
  });
  json.post("/api/mc/files/:name", (req, res) => {
    const { path: rel, content } = req.body ?? {};
    const full = safeServePath(req.params.name, rel);
    if (!full) return res.status(400).json({ error: "Invalid Path" });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(content ?? ""));
    res.json({ ok: true });
  });
  json.post("/api/mc/files/:name/delete", (req, res) => {
    const { path: rel } = req.body ?? {};
    const full = safeServePath(req.params.name, rel);
    if (!full || full === path.resolve(serverDir(req.params.name))) return res.status(400).json({ error: "Invalid Path" });
    fs.rmSync(full, { recursive: true, force: true });
    res.json({ ok: true });
  });

  // --- Modrinth: pilih versi MC spesifik ---
  json.get("/api/mc/modrinth/versions/:slug", async (req, res) => {
    try {
      const s = db.prepare("SELECT * FROM mc_servers WHERE name = ?").get(req.query.server);
      const loader = s?.loader ?? "fabric";
      const r = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(req.params.slug)}/version?loaders=["${loader}"]`, { headers: { "User-Agent": "NigiroCORE/1.0" } }).then(r => r.json());
      res.json((r ?? []).slice(0, 15).map(v => ({ id: v.id, name: v.version_number, mc: v.game_versions?.filter(g => /^\d+\.\d+(\.\d+)?$/.test(g)).slice(0, 4), at: v.date_published })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // deskripsi project (markdown body) — untuk dialog detail
  json.get("/api/mc/modrinth/description/:slug", async (req, res) => {
    try {
      const j = await fetch(`${MODRINTH}/project/${encodeURIComponent(req.params.slug)}`, { headers: { "User-Agent": "NigiroCORE/1.0" } }).then(r => r.json());
      res.json({ title: j.title, desc: j.description, body: j.body, page: `https://modrinth.com/${j.project_type}/${j.slug}`, icon: j.icon_url, license: j.license?.name ?? null });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

function pushLog(name, text) {
  const c = consoles[name];
  if (!c) return;
  // line-buffering (kubek): chunk stdout bisa memotong baris — jangan emit setengah baris
  lineBuf[name] = (lineBuf[name] ?? "") + text;
  const lines = lineBuf[name].split("\n");
  lineBuf[name] = lines.pop() ?? "";
  for (const raw of lines) {
    // strip ANSI escape + CR-repaint (JLine), buang baris kosong & prompt echo (kubek instance-log.ts)
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "").trim();
    if (!line || line === ">") continue;
    c.buf.push(line.slice(0, 300));
    if (c.buf.length > 500) { c.buf.shift(); c.dropped++; }
    consoleAppend(name, line.slice(0, 300));
    // status detection dari pola log (kubek status-detector) — bukan polling port
    if (/\bDone \([\d.]+s?\)![\s/]/.test(line) || line.includes("Done (")) {
      mcState[name] = { online: true, startedAt: mcState[name]?.startedAt ?? Date.now() };
      crashAttempts[name] = 0;
    }
    // dashboard tracking dari log (pola opanel in-process events, tapi via stdout):
    // "Done (2.5s)! For help, type help" → reset startedAt; join/leave → update players
    if (!mcDash[name]) mcDash[name] = { players: [], maxPlayers: null, motd: null };
    let m;
    if ((m = line.match(/^(?:\[[\d:]+\] \[[^/\]]+\/INFO\]: )?(\w+) (?:joined|left) the game$/))) {
      const who = m[1];
      const arr = mcDash[name].players;
      if (line.includes("joined") && !arr.includes(who)) arr.push(who);
      if (line.includes("left")) { const i = arr.indexOf(who); if (i >= 0) arr.splice(i, 1); }
    } else if ((m = line.match(/There are (\d+) of a max of (\d+) players online: ?(.*)$/))) {
      mcDash[name].players = m[3] && m[3].trim() ? m[3].split(", ").map(s => s.trim()).filter(Boolean) : [];
      mcDash[name].maxPlayers = +m[2];
    }
    // fan-out ke SSE console listeners (opanel broadcast LOG per baris)
    for (const fn of mcLogListeners[name] ?? []) { try { fn(line); } catch {} }
  }
  // flush saat proses mati: sisa partial line tetap tampil
}
