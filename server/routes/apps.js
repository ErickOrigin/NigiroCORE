// ===== Apps: media downloader (yt-dlp) + PDF/image tools =====
import { Router } from "express";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { spawn, execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";

const execFileP = promisify(execFile);
const r = Router();

const APPS_DIR = path.join(process.env.STORAGE_PATH, "Apps");
// TTL 24 jam: file di Apps dir dianggap temp — sweep tiap 30 menit (keputusan LO)
const APPS_TTL_MS = 24 * 60 * 60 * 1000;
function sweepAppsFiles() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(APPS_DIR, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const full = path.join(APPS_DIR, f.name);
      try { if (now - fs.statSync(full).mtimeMs > APPS_TTL_MS) fs.rmSync(full, { force: true }); } catch {}
    }
  } catch {}
}
setInterval(sweepAppsFiles, 30 * 60 * 1000);
sweepAppsFiles();
fs.mkdirSync(APPS_DIR, { recursive: true });
const ytDlp = () => {
  const cands = ["yt-dlp", process.env.YTDLP_PATH];
  for (const c of cands) { if (c) try { execFileSync(c, ["--version"], { stdio: "ignore", windowsHide: true }); return c; } catch {} }
  return null;
};

// list apps downloads
r.get("/downloads", (_req, res) => {
  try {
    const files = [];
    for (const f of fs.readdirSync(APPS_DIR, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const st = fs.statSync(path.join(APPS_DIR, f.name));
      files.push({ name: f.name, size: st.size, mtime: st.mtimeMs });
    }
    files.sort((a, b) => b.mtime - a.mtime);
    res.json(files);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// preview metadata: yt-dlp --dump-json (tanpa download media — cuma info + thumbnail)
r.post("/preview", express.json(), async (req, res) => {
  const url = (req.body?.url ?? "").toString().trim().replace(/^["']|["']$/g, "").trim();
  if (!url || !/^https?:\/\/[^\s]+$/.test(url)) return res.status(400).json({ error: "URL tidak valid" });
  const bin = ytDlp();
  if (!bin) return res.status(500).json({ error: "yt-dlp tidak ditemukan" });
  const c = spawn(bin, ["--no-playlist", "--dump-json", "--skip-download", url], { windowsHide: true });
  let out = "", err = "";
  const kill = setTimeout(() => c.kill("k"), 30000);
  c.stdout.on("data", d => { out += d; });
  c.stderr.on("data", d => { err = (err + d).slice(-300); });
  c.on("exit", () => {
    clearTimeout(kill);
    try {
      const line = out.split("\n").find(l => l.trim().startsWith("{"));
      if (!line) return res.status(404).json({ error: (err || "Metadata tidak ditemukan").split("\n").pop().slice(0, 180) });
      const j = JSON.parse(line);
      res.json({
        title: j.title, uploader: j.uploader ?? j.channel, duration: j.duration,
        thumbnail: j.thumbnail, webpage_url: j.webpage_url,
        view_count: j.view_count, upload_date: j.upload_date,
        is_live: !!j.is_live,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// download media: url + mode (video/bestaudio/mp3)
const dlJobs = {};
r.post("/download", express.json(), async (req, res) => {
  const { mode } = req.body;
  const vfmt = ["mp4", "mkv", "webm", "mov"].includes(req.body?.vfmt) ? req.body.vfmt : "mp4";
  const vres = [2160, 1440, 1080, 720, 480, 360].includes(+req.body?.vres) ? +req.body.vres : 1080;
  const afmt = ["mp3", "m4a", "opus", "wav", "flac"].includes(req.body?.afmt) ? req.body.afmt : "mp3";
  const aq = ["0", "5", "9"].includes(String(req.body?.aq)) ? String(req.body.aq) : "0";
  const url = (req.body?.url ?? "").toString().trim().replace(/^["']|["']$/g, "").trim();
  if (!url || !/^https?:\/\/[^\s]+$/.test(url)) return res.status(400).json({ error: "URL tidak valid — paste link lengkap (https://...)" });
  const bin = ytDlp();
  if (!bin) return res.status(500).json({ error: "yt-dlp tidak ditemukan (winget install yt-dlp.yt-dlp atau set YTDLP_PATH di .env)" });

  // cobalt fallback: coba dulu kalau URL TikTok/IG/FB/Pinterest (yt-dlp sering block), kalau bukan langsung yt-dlp
  const socialRe = /tiktok\.com|instagram\.com|facebook\.com|fb\.watch|pinterest\./i;
  if (socialRe.test(url)) {
    try {
      const cr = await fetch("https://api.cobalt.tools/", {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          // cobalt: videoQuality = resolusi maks (string "2160".."360"), audioFormat = codec container audio
          videoQuality: mode === "video" ? String(vres) : "1080",
          audioFormat: mode === "audio" ? afmt : "best",
          // youtubeNoCookie etc tidak perlu; downloadMode default auto
        }),
        signal: AbortSignal.timeout(15000),
      });
      const cj = await cr.json().catch(() => null);
      const mediaUrl = cj?.url;
      if (cr.ok && mediaUrl) {
        // langsung fetch file dari cobalt tunnel
        const id = Date.now().toString(36);
        // ext dari content-disposition cobalt kalau ada, fallback pilihan user
        const cd = (cj.filename ?? "").match(/\.(\w{2,5})$/)?.[1];
        const ext = mode === "audio" ? (cd ?? afmt) : (cd ?? vfmt);
        const outPath = path.join(APPS_DIR, "cobalt-" + id + "." + ext);
        dlJobs[id] = { pct: 0, line: "fetching via cobalt", done: false, error: null };
        res.json({ id });
        (async () => {
          try {
            const fr = await fetch(mediaUrl, { signal: AbortSignal.timeout(600000) });
            const total = +fr.headers.get("content-length") || 0;
            let got = 0; const chunks = [];
            for await (const ch of fr.body) {
              chunks.push(ch); got += ch.length;
              if (total) dlJobs[id].pct = Math.round((got / total) * 100);
              dlJobs[id].line = (got / 1e6).toFixed(1) + " MB";
            }
            fs.writeFileSync(outPath, Buffer.concat(chunks));
            dlJobs[id].done = true; dlJobs[id].pct = 100; dlJobs[id].line = "done";
          } catch (e) { dlJobs[id].done = true; dlJobs[id].error = e.message; }
        })();
        return;
      }
    } catch {}
    // cobalt gagal -> jatuh ke yt-dlp di bawah
  }
  const id = Date.now().toString(36);
  const args = ["--no-playlist", "--newline", "-o", path.join(APPS_DIR, "%(title).80B.%(ext)s")];
  if (mode === "audio") args.push("-x", "--audio-format", afmt, "--audio-quality", aq);
  else {
    args.push("-f", `bv*[height<=${vres}]+ba/b[height<=${vres}]/b`);
    // remux/convert ke format pilihan user (mp4 default); webm/mkv/mov via remux cepat tanpa re-encode
    args.push("--merge-output-format", vfmt, "--remux-video", vfmt);
  }
  args.push(url);
  const c = spawn(bin, args, { windowsHide: true });
  dlJobs[id] = { pct: 0, line: "url: " + url.slice(0, 80), done: false, error: null };
  c.stdout.on("data", d => {
    for (const line of d.toString().split("\n")) {
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) { dlJobs[id].pct = Math.round(+m[1]); dlJobs[id].line = line.trim().slice(0, 120); }
      else if (line.includes("[ExtractAudio]")) dlJobs[id].line = "converting audio";
    }
  });
  c.stderr.on("data", d => { dlJobs[id].line = d.toString().trim().slice(0, 120); });
  let stderrTail = "";
  c.stderr.on("data", d => { stderrTail = (stderrTail + d.toString()).slice(-400); });
  c.on("exit", code => {
    dlJobs[id].done = true; dlJobs[id].pct = 100;
    dlJobs[id].error = code ? ("exit " + code + " — " + stderrTail.trim().split("\n").pop()).slice(0, 180) : null;
  });
  res.json({ id });
});
r.get("/download/:id", (req, res) => {
  const j = dlJobs[req.params.id];
  if (!j) return res.status(404).json({ error: "job tidak ada" });
  res.json(j);
});

// PDF compress: render pages via pdfjs -> sharp webp -> rebuild pdf
r.post("/pdf-compress", express.json(), async (req, res) => {
  try {
    const { name, quality } = req.body; // name = file di Apps dir; quality 0-100
    const src = path.join(APPS_DIR, path.basename(name));
    if (!fs.existsSync(src)) return res.status(404).json({ error: "file tidak ada" });
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(fs.readFileSync(src));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
    const out = await PDFDocument.create();
    const q = Math.max(30, Math.min(95, +quality || 70));
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      // render -> webp (kompres) -> jpeg (embeddable di PDF, lossy sesuai target)
      const jpg = await sharp(canvas.toBuffer("image/png")).webp({ quality: q }).jpeg({ quality: q }).toBuffer();
      const emb = await out.embedJpg(jpg);
      const pg = out.addPage([vp.width, vp.height]);
      pg.drawImage(emb, { x: 0, y: 0, width: vp.width, height: vp.height });
    }
    // hindari suffix numpuk: .compressed.compressed.pdf -> timpa suffix lama
    const outName = name.replace(/(\.compressed)*\.pdf$/i, "") + ".compressed.pdf";
    fs.writeFileSync(path.join(APPS_DIR, outName), await out.save());
    const srcSize = fs.statSync(src).size, outSize = fs.statSync(path.join(APPS_DIR, outName)).size;
    res.json({ ok: true, out: outName, pages: doc.numPages, srcSize, outSize });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// video compress: ffmpeg two-pass ke target size MB
// video compress: ffmpeg two-pass ke target size MB — job-based (progress via /download/:id)
r.post("/video-compress", express.json(), async (req, res) => {
  const { name, targetMb } = req.body;
  const src = path.join(APPS_DIR, path.basename(name));
  if (!fs.existsSync(src)) return res.status(404).json({ error: "file tidak ada" });
  const outName = name.replace(/\.[^.]+$/, "") + ".compressed.mp4";
  const outPath = path.join(APPS_DIR, outName);
  // durasi via ffprobe (frontend tidak perlu kirim durationSec)
  let durSec = 0;
  try {
    const { stdout } = await execFileP("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]);
    durSec = Math.round(parseFloat(stdout.trim()));
  } catch {}
  durSec = Math.max(1, durSec || +req.body.durationSec || 0);
  if (!durSec) return res.status(400).json({ error: "tidak bisa membaca durasi video (ffprobe tidak ada?)" });
  const totalKb = (+targetMb || 8) * 8192; // target MB -> total kb (video+audio)
  if (totalKb <= 8192) return res.status(400).json({ error: "target size too small" });
  const audioKb = 128;
  const videoKb = Math.max(100, Math.round(totalKb / durSec) - audioKb);
  const id = Date.now().toString(36);
  dlJobs[id] = { pct: 0, line: "analyzing (pass 1)", done: false, error: null };
  res.json({ id });
  // progress dari ffmpeg "time=" output, diskalakan: pass1 = 0-10%, pass2 = 10-100%
  const track = (job, c, base, span) => {
    c.stderr.on("data", d => {
      const m = d.toString().match(/time=(\d+):(\d+):(\d+)/);
      if (m) {
        const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
        job.pct = Math.min(99, Math.round(base + (t / durSec) * span));
        job.line = (base ? "compressing" : "pass 1") + " — " + job.pct + "%";
      }
    });
  };
  const pass1 = spawn("ffmpeg", ["-y", "-i", src, "-c:v", "libx264", "-b:v", videoKb + "k", "-pass", "1", "-an", "-f", "null", "NUL"], { windowsHide: true });
  track(dlJobs[id], pass1, 0, 10);
  pass1.on("exit", () => {
    const pass2 = spawn("ffmpeg", ["-y", "-i", src, "-c:v", "libx264", "-b:v", videoKb + "k", "-pass", "2", "-c:a", "aac", "-b:a", audioKb + "k", outPath], { windowsHide: true });
    track(dlJobs[id], pass2, 10, 90);
    pass2.on("exit", (code) => {
      try { fs.rmSync(path.join(APPS_DIR, "ffmpeg2pass-0.log"), { force: true }); } catch {}
      dlJobs[id].done = true;
      if (code === 0) { dlJobs[id].pct = 100; dlJobs[id].line = "done"; }
      else dlJobs[id].error = "ffmpeg exit " + code;
    });
  });
});

// video/audio convert: ffmpeg preset
r.post("/media-convert", express.json(), (req, res) => {
  const { name, format } = req.body; // format: mp4|mkv|webm|mp3|wav|m4a
  const src = path.join(APPS_DIR, path.basename(name));
  if (!fs.existsSync(src)) return res.status(404).json({ error: "file tidak ada" });
  const args = { mp4: ["-c:v", "libx264", "-c:a", "aac"], mkv: ["-c", "copy"], webm: ["-c:v", "libvpx-vp9", "-c:a", "libopus"], mp3: ["-vn", "-c:a", "libmp3lame", "-q:a", "0"], wav: ["-vn", "-c:a", "pcm_s16le"], m4a: ["-vn", "-c:a", "aac", "-b:a", "192k"] };
  const preset = args[format];
  if (!preset) return res.status(400).json({ error: "format tidak didukung" });
  const outName = name.replace(/\.[^.]+$/, "") + "." + format;
  const c = spawn("ffmpeg", ["-y", "-i", src, ...preset, path.join(APPS_DIR, outName)], { windowsHide: true });
  let err = "";
  c.stderr.on("data", d => err += d);
  c.on("exit", (code) => code === 0 ? res.json({ ok: true, out: outName }) : res.status(500).json({ error: (err.split("\n").slice(-3).join(" ") || "ffmpeg exit " + code).slice(0, 200) }));
});

// PDF merge
r.post("/pdf-merge", express.json(), async (req, res) => {
  try {
    const { names } = req.body;
    if (!Array.isArray(names) || names.length < 2) return res.status(400).json({ error: "pilih minimal 2 PDF" });
    const out = await PDFDocument.create();
    for (const n of names) {
      const src = await PDFDocument.load(fs.readFileSync(path.join(APPS_DIR, path.basename(n))));
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(pg => out.addPage(pg));
    }
    const outName = "merged-" + Date.now() + ".pdf";
    fs.writeFileSync(path.join(APPS_DIR, outName), await out.save());
    res.json({ ok: true, out: outName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PDF split: halaman a-b jadi file baru
r.post("/pdf-split", express.json(), async (req, res) => {
  try {
    const { name, from, to } = req.body;
    const src = await PDFDocument.load(fs.readFileSync(path.join(APPS_DIR, path.basename(name))));
    const total = src.getPageCount();
    const a = Math.max(1, +from || 1), b = Math.min(total, +to || total);
    if (a > b) return res.status(400).json({ error: "range tidak valid" });
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));
    pages.forEach(pg => out.addPage(pg));
    const outName = name.replace(/\.pdf$/i, "") + `-p${a}-${b}.pdf`;
    fs.writeFileSync(path.join(APPS_DIR, outName), await out.save());
    res.json({ ok: true, out: outName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// image compress/convert via sharp
r.post("/image-convert", express.json(), async (req, res) => {
  try {
    const { name, format, quality } = req.body; // format: webp|jpeg|png|avif
    const srcPath = path.join(APPS_DIR, path.basename(name));
    const q = Math.max(30, Math.min(95, +quality || 80));
    let img = sharp(srcPath).rotate();
    const ext = format === "jpeg" ? "jpg" : format;
    const outName = name.replace(/\.[^.]+$/, "") + "." + ext;
    if (format === "webp") img = img.webp({ quality: q });
    else if (format === "jpeg") img = img.jpeg({ quality: q });
    else if (format === "avif") img = img.avif({ quality: q });
    else if (format === "png") img = img.png({ compressionLevel: 9 });
    else return res.status(400).json({ error: "format tidak didukung" });
    await img.toFile(path.join(APPS_DIR, outName));
    res.json({ ok: true, out: outName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// upload file ke Apps dir (untuk pdf/image tools)
r.post("/upload", express.raw({ type: () => true, limit: "200mb" }), (req, res) => {
  const name = (req.query.name ?? "upload.bin").toString().replace(/[\\/:*?"<>|]/g, "_");
  try {
    if (!req.body?.length) throw new Error("Empty Body");
    fs.writeFileSync(path.join(APPS_DIR, name), Buffer.from(req.body));
    res.json({ ok: true, name, size: req.body.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// serve apps file (download ke browser)
r.get("/file", (req, res) => {
  const abs = path.resolve(path.join(APPS_DIR, path.basename(req.query.name.toString())));
  if (!fs.existsSync(abs)) return res.sendStatus(404);
  res.download(abs);
});

// delete apps file
r.post("/delete", express.json(), (req, res) => {
  fs.rmSync(path.join(APPS_DIR, path.basename(req.body?.name ?? "")), { force: true });
  res.json({ ok: true });
});

export default r;
