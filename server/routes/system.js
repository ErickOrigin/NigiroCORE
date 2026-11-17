// ===== System monitoring: /api/system, /api/live, /api/telemetry, /api/alerts, samplers (pola TrueNAS) =====
import { Router, json } from "express";
import os from "node:os";
import fs from "node:fs";
import { exec, spawn } from "node:child_process";
import si from "systeminformation";
import { getSetting, setSetting } from "../db.js";

const r = Router();

// Server Info: OS, uptime, CPU, RAM, GPU — buat panel kesehatan server
let gpuCache = null;
function getGpus() {
  if (gpuCache && Date.now() - gpuCache.at < 60_000) return gpuCache.list;
  return new Promise(resolve => {
    // Windows: WMI; Linux: lspci; macOS/lain: kosong
    const cmd = os.platform() === "win32"
      ? "powershell -NoProfile -Command \"Get-CimInstance Win32_VideoController | Select-Object Name, @{n='GB';e={[math]::Round($_.AdapterRAM/1GB,1)}} | ConvertTo-Json\""
      : os.platform() === "linux"
        ? "lspci 2>/dev/null | grep -iE 'vga|3d controller|display controller'"
        : "true";
    exec(cmd, (err, out) => {
      let list = [];
      try {
        if (os.platform() === "win32") {
          const j = JSON.parse(out);
          list = (Array.isArray(j) ? j : [j]).filter(g => g.Name).map(g => ({ name: g.Name, gb: g.GB > 0 ? g.GB : null }));
        } else if (os.platform() === "linux") {
          // "01:00.0 VGA compatible controller: NVIDIA GA107 [GeForce RTX 3050]" → nama setelah ": "
          list = out.split("\n").filter(Boolean).map(l => {
            const name = l.split(":").slice(1).join(":").trim().replace(/\[|\]/g, "");
            return { name, gb: null };
          });
        }
      } catch {}
      gpuCache = { at: Date.now(), list };
      resolve(list);
    });
  });
}

// nama distro: Windows → os.version(); Linux → PRETTY_NAME dari /etc/os-release
function getDistro() {
  if (os.platform() !== "linux") return os.version();
  try {
    return fs.readFileSync("/etc/os-release", "utf8").match(/PRETTY_NAME="(.+)"/)?.[1] ?? os.type();
  } catch { return os.type(); }
}

r.get("/system", async (_req, res) => {
  let st = null;
  try { st = fs.statfsSync(process.env.STORAGE_PATH); } catch {} // volume offline → null, jangan crash
  const total = st ? st.blocks * st.bsize : 0, free = st ? st.bfree * st.bsize : 0;
  res.json({
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    distro: getDistro(),
    cpuModel: os.cpus()[0]?.model?.trim() ?? "—",
    cpuCores: os.cpus().length,
    cpuLoad: Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100)), // unix only; win selalu 0
    memTotal: os.totalmem(),
    memFree: os.freemem(),
    uptime: os.uptime(),
    node: process.version,
    hddTotal: total,
    hddFree: free,
    gpus: await getGpus(),
  });
});

// ===== Live monitoring — pola TrueNAS: sampler stdlib + satu proses streaming, nol spawn per request =====
// CPU/RAM: os.cpus() delta. Network: SATU typeperf streaming (auto-restart), stdout dibaca per baris.
let liveCache = {};
let cpuPrev = null;
function sampleCpu() {
  const cur = os.cpus();
  if (!cpuPrev) { cpuPrev = cur; return { cpuPct: 0, cpuCores: cur.slice(1).map(() => 0) }; }
  const delta = (p, c) => {
    const idle = c.times.idle - p.times.idle;
    const total = Object.keys(c.times).reduce((a, k) => a + c.times[k] - p.times[k], 0);
    return total > 0 ? Math.min(100, Math.max(0, Math.round((1 - idle / total) * 100))) : 0;
  };
  const out = { cpuPct: delta(cpuPrev[0], cur[0]), cpuCores: cur.slice(1).map((c, i) => delta(cpuPrev[i + 1] ?? cpuPrev[0], c)) };
  cpuPrev = cur;
  return out;
}
if (process.platform === "win32") {
  const startNet = () => {
    const child = spawn("typeperf", ["\\Network Interface(*)\\Bytes Received/sec", "\\Network Interface(*)\\Bytes Sent/sec"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let buf = "";
    child.stdout.on("data", d => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.includes('","')) continue;
        const v = line.split('","').slice(1).map(x => parseFloat(x.replaceAll('"', "")) || 0);
        const h = v.length / 2;
        liveCache.net = { rxMbps: Math.max(0, v.slice(0, h).reduce((a, b) => a + b, 0) * 8 / 1e6), txMbps: Math.max(0, v.slice(h).reduce((a, b) => a + b, 0) * 8 / 1e6) };
      }
    });
    child.on("exit", () => setTimeout(startNet, 5000));
  };
  startNet();
}
r.get("/live", (_req, res) => {
  const { cpuPct, cpuCores } = sampleCpu();
  const memTotal = os.totalmem(), memFree = os.freemem();
  res.json({
    cpuPct, cpuCores,
    memPct: Math.round(((memTotal - memFree) / memTotal) * 100),
    memUsed: memTotal - memFree,
    memTotal,
    net: liveCache.net ?? null,
    disks: null,   // ponytail: disk I/O + GPU dibuang — add back via typeperf streaming reader kalau dashboard kangen
    gpus: null,
    at: Date.now(),
  });
});

// drive letter -> physical disk info (one-shot at startup, cached; PowerShell via Get-Partition)
let diskInfoCache = {};
let scanDisks = () => {};
if (process.platform === "win32") {
  scanDisks = () => {
  const ps = spawn("powershell", ["-NoProfile", "-Command",
    "Get-Partition | Where-Object DriveLetter | Select DriveLetter,DiskNumber | ConvertTo-Json -Compress; Get-PhysicalDisk | Select DeviceId,FriendlyName,MediaType | ConvertTo-Json -Compress"],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let buf = "";
  ps.stdout.on("data", d => buf += d);
  ps.on("close", () => {
    try {
      const jsons = buf.trim().split("\n").filter(x => x.trim().startsWith("["));
      const [parts, disks] = jsons.map(x => JSON.parse(x));
      const byId = Object.fromEntries((Array.isArray(disks) ? disks : [disks]).map(d => [String(d.DeviceId), d]));
      for (const part of (Array.isArray(parts) ? parts : [parts])) {
        const d = byId[String(part.DiskNumber)];
        if (d) diskInfoCache[part.DriveLetter] = { disk: part.DiskNumber, name: d.FriendlyName.trim(), type: d.MediaType === "SSD" ? "SSD" : d.MediaType === "HDD" ? "HDD" : (d.MediaType || "Disk") };
      }
    } catch {}
  });
  };
}
if (process.platform === "win32") { scanDisks(); setInterval(scanDisks, 60000); }

// ===== Monitoring: telemetry (Task Manager style) + threshold alerts =====
// network per-interface: one typeperf stream (rx/tx per NIC), parsed to netCache
let netCache = [];
// iface -> IPv4 map (refreshed every 30s, cheap)
let ifaceIps = {};
const refreshIfaceIps = async () => { try { const list = await si.networkInterfaces(); ifaceIps = Object.fromEntries(list.filter(x => !x.internal && x.ip4).map(x => [x.iface.replace(/\[R?\]/g, "").slice(0, 12), x.ip4])); } catch {} };
refreshIfaceIps(); setInterval(refreshIfaceIps, 30000);
if (process.platform === "win32") {
  const startNet2 = () => {
    const c = spawn("typeperf", ["\\Network Interface(*)\\Bytes Received/sec", "\\Network Interface(*)\\Bytes Sent/sec"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let b = "", netLabels = [];
    c.stdout.on("data", d => {
      b += d;
      let i;
      while ((i = b.indexOf("\n")) >= 0) {
        const line = b.slice(0, i).trim(); b = b.slice(i + 1);
        if (!line.includes('","')) continue;
        const segs = line.split('","').map(x => x.replaceAll('"', ""));
        // header line: (PDH-CSV 4.0) + counter paths with (iface) names
        if (segs[0].includes("PDH-CSV")) {
          netLabels = segs.slice(1).map(x => { const m = x.match(/\(([^)]+)\)/); return m ? m[1] : x; });
          continue;
        }
        const vals = segs.slice(1).map(parseFloat);
        const h = vals.length / 2;
        const out = [];
        for (let k = 0; k < h; k++) {
          const rawIface = netLabels[k] ?? "iface" + k;
          const iface = rawIface;
          const ip = (() => {
            const norm = rawIface.replace(/\[R?\]/g, "");
            if (/wi-?fi/i.test(norm)) return ifaceIps["Wi-Fi"] ?? "";
            const direct = Object.entries(ifaceIps).find(([k]) => norm.toLowerCase().includes(k.toLowerCase().slice(0, 8)));
            return direct?.[1] ?? "";
          })();
          if (/loopback/i.test(iface)) continue;
          out.push({ iface, ip, rxMbps: +(((vals[k] || 0) / 1e6) * 8).toFixed(2), txMbps: +(((vals[h + k] || 0) / 1e6) * 8).toFixed(2) });
        }
        if (out.length) netCache = out;
      }
    });
    c.on("exit", () => setTimeout(startNet2, 5000));
  };
  startNet2();
}
const ALERT_DEFAULTS = { cpu: 90, storage: 85 }; // per-drive storage uses 'storage' default
const alertState = {};
const alertThreshold = (k) => JSON.parse(getSetting("alert_" + k, JSON.stringify(k.startsWith("drive:") ? alertThreshold("storage") : ALERT_DEFAULTS[k])));
// telemetry cache: one snapshot per tick, consumed by /api/telemetry
let telemetry = null;
async function sampleTelemetry() {
  try {
    const [cpu, mem, gfx, memInfo, diskLayout] = await Promise.all([si.currentLoad(), si.mem(), si.graphics(), si.memLayout(), si.diskLayout()]);
    const diskTypes = Object.fromEntries(diskLayout.map(d => [Number(d.device?.match(/(\d+)$/)?.[1] ?? -1), /ssd|nvme/i.test(d.type ?? "") ? "SSD" : "HDD"]));
    const drives = [];
    for (const [letter, info] of Object.entries(diskInfoCache)) {
      try {
        const st = fs.statfsSync(letter + ':\\');
        drives.push({ letter, ...info, mediaType: diskTypes[Number(info.disk)] ?? "", pct: Math.round((1 - st.bfree / st.blocks) * 100), freeGb: Math.round(st.bfree * st.bsize / 1e9), totalGb: Math.round(st.blocks * st.bsize / 1e9) });
      } catch {}
    }
    const cpuInfo = telemetry?.cpuInfo ?? (await si.cpu());
    const liveSpeed = await si.cpuCurrentSpeed();
    const [procs, osInfo] = await Promise.all([si.processes(), si.time()]);
    telemetry = {
      cpuInfo: { model: cpuInfo.brand || telemetry?.cpuInfo?.model || "", cores: cpuInfo.cores, physicalCores: cpuInfo.physicalCores },
      cpu: { load: Math.round(cpu.currentLoad), speedGhz: +(liveSpeed?.avg ?? 0).toFixed(2), minGhz: +(cpuInfo.speedMin ?? 0).toFixed(2), maxGhz: +(cpuInfo.speedMax ?? 0).toFixed(2), cores: cpuInfo.cores, model: cpuInfo.brand },
      mem: { pct: Math.round((mem.active / mem.total) * 100), usedGb: +(mem.active / 1e9).toFixed(1), totalGb: +(mem.total / 1e9).toFixed(1), cachedGb: +(mem.buffercache / 1e9).toFixed(1), type: memInfo?.[0]?.type ?? "", speedMhz: memInfo?.[0]?.clockSpeed ?? null },
      drives,
      gpus: (gfx.controllers ?? []).map((g, i) => ({ name: g.model, util: g.utilizationGpu ?? null, temp: g.temperatureGpu ?? null })),
      net: netCache,
      procs: { processes: procs.all, threads: procs.threads, uptimeS: osInfo.uptime },
      at: Date.now(),
    };
    // evaluate alerts: cpu + per-drive
    const evalMetric = (key, value) => {
      const thr = alertThreshold(key);
      const prev = alertState[key];
      if (value >= thr && !prev?.active) { alertState[key] = { active: true, since: Date.now(), value, threshold: thr }; broadcastAlerts(); }
      else if (value < thr * 0.95 && prev?.active) { alertState[key] = { ...prev, active: false, value }; broadcastAlerts(); }
      else if (prev) alertState[key] = { ...prev, value };
    };
    evalMetric('cpu', telemetry.cpu.load);
    for (const d of telemetry.drives) evalMetric('drive:' + d.letter, d.pct);
  } catch {}
}
sampleTelemetry();
setInterval(sampleTelemetry, 2000);

r.get("/alerts", (_req, res) => {
  res.json({
    active: Object.entries(alertState).filter(([, st]) => st.active).map(([k, st]) => ({ metric: k, ...st })),
    thresholds: { cpu: alertThreshold("cpu"), storage: alertThreshold("storage") },
  });
});
r.post("/alerts/thresholds", json(), (req, res) => {
  for (const k of Object.keys(req.body ?? {}).filter(k => k === "cpu" || k === "storage" || k.startsWith("drive:"))) {
    const v = req.body?.[k];
    if (typeof v === "number" && v > 0 && v <= 100) setSetting("alert_" + k, JSON.stringify(Math.round(v)));
  }
  // re-evaluasi: alert yang udah di bawah threshold baru langsung diclear
  for (const [k, st] of Object.entries(alertState)) {
    const thr = alertThreshold(k);
    if (!st.active) continue;
    const val = k.startsWith("drive:") ? (telemetry?.drives ?? []).find(d => d.letter === k.slice(6))?.pct : telemetry?.cpu?.load;
    if (val == null || val < thr) delete alertState[k];
  }
  broadcastAlerts();
  res.json({ ok: true });
});

r.get("/telemetry", (_req, res) => res.json(telemetry));

// disk I/O per drive: one typeperf stream, parsed per physical disk
if (process.platform === "win32") {
  const startDiskIO = () => {
    const c = spawn("typeperf", ["\\PhysicalDisk(*)\\Disk Read Bytes/sec", "\\PhysicalDisk(*)\\Disk Write Bytes/sec"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let b = "";
    c.stdout.on("data", d => {
      b += d;
      let i;
      while ((i = b.indexOf("\n")) >= 0) {
        const line = b.slice(0, i).trim(); b = b.slice(i + 1);
        if (!line.includes('\",\"')) continue;
        const vals = line.split('\",\"').slice(1).map(x => parseFloat(x.replaceAll('"', "")) || 0);
        const h = vals.length / 2;
        const names = line.split("\",\"");
        // map instance names ("0 C:" etc) to telemetry
        if (telemetry) {
          for (let k = 0; k < h; k++) {
            const label = names[k] ?? "";
            const m = label.match(/(\d+)\s+([A-Z]:)$/);
            if (!m) continue;
            const letter = m[2][0];
            const drv = telemetry.drives?.find(d => d.letter === letter);
            if (drv) { drv.readMBs = +((vals[k] || 0) / 1e6).toFixed(2); drv.writeMBs = +((vals[h + k] || 0) / 1e6).toFixed(2); }
          }
        }
      }
    });
    c.on("exit", () => setTimeout(startDiskIO, 5000));
  };
  startDiskIO();
}

// alert broadcaster: system.js evaluate alerts → SSE clients (routes/volumes.js)
let _broadcastAlerts = () => {};
export function setAlertBroadcaster(fn) { _broadcastAlerts = fn; }
function broadcastAlerts() { _broadcastAlerts(); }

// sampleTelemetry diekspos biar module lain bisa trigger manual (mis. setelah disk rescan)
export { sampleTelemetry };

export default r;
