import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { promisify } from "node:util";
import { knownPaths, insertFile } from "./db.js";

const run = promisify(execFile);
const ADB = process.env.ADB_PATH;
// default source dirs; per-device override di tabel devices (kolom source_dirs JSON)
const DEFAULT_SOURCE_DIRS = ["/sdcard/DCIM", "/sdcard/Download"];

export async function adb(...args) {
  const { stdout } = await run(ADB, args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const getModel = async (id) =>
  (await adb("-s", id, "shell", "getprop", "ro.product.model").catch(() => ""))?.replace(/\r/g, "").trim() || "";

// daftar semua serial yang terhubung (multi-device)
export async function getDevices() {
  const out = await adb("devices");
  return out.split("\n").filter(l => l.includes("\tdevice")).map(l => l.split("\t")[0]);
}

// serial opsional: tanpa serial + 1 device terhubung = backward compatible perilaku lama
export async function getDevice(serial) {
  const list = await getDevices();
  if (serial) return list.includes(serial) ? { id: serial, model: await getModel(serial) } : null;
  if (list.length !== 1) return null;
  return { id: list[0], model: await getModel(list[0]) };
}

export async function listRemoteFiles(serial, sourceDirs = DEFAULT_SOURCE_DIRS) {
  const files = [];
  for (const dir of sourceDirs) {
    const out = await adb("-s", serial, "shell",
      `find ${dir} -type f \\( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' -o -name '*.mp4' -o -name '*.heic' -o -name '*.webp' \\) 2>/dev/null`
    ).catch(() => "");
    const paths = out.split("\n").map(s => s.trim())
      .filter(p => p && !p.includes("/.")); // skip hidden dirs seperti .watermark
    // ponytail: stat per-file karena toybox find (Android 10) tak punya -printf;
    // upgrade path: batch stat saat target device support.
    for (const p of paths) {
      const st = await adb("-s", serial, "shell", `stat -c '%s %Y' '${p}' 2>/dev/null`).catch(() => "");
      const [size, mtime] = st.trim().split(" ");
      if (size && mtime) files.push({ path: p, size: +size, mtime: +mtime });
    }
  }
  return files;
}

// ===== Phone browsing (live via ADB, untuk custom backup picker) =====
export const listDir = listPhoneDir;
export async function listPhoneDir(dir) {
  const out = await adb("shell", `ls -lA '${dir}' 2>/dev/null`).catch(() => "");
  const entries = [];
  for (const line of out.split("\n")) {
    // format toybox ls -l: drwxrwx--x 2 root sdcard 4096 2024-03-21 14:03 dirname
    const m = line.replace(/\r$/, "").match(/^([-dl][-rwxsStT]{9})\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/);
    if (!m) continue;
    const [, perms, size, date, time, name] = m;
    if (!name || name.startsWith(".")) continue;
    const isDir = perms.startsWith("d");
    entries.push({
      name,
      isDir,
      size: isDir ? 0 : +size,
      mtime: Math.floor(new Date(`${date} ${time} +07:00`).getTime() / 1000) || 0,
      path: `${dir.replace(/\/$/, "")}/${name}`,
    });
  }
  return entries;
}

// ===== File bytes dari HP via ADB — exec-out = binary-safe =====
export async function phoneFile(deviceId, remotePath) {
  const { stdout } = await run(ADB, ["-s", deviceId, "exec-out", `cat '${remotePath}'`],
    { maxBuffer: 4 * 1024 * 1024 * 1024, encoding: "buffer" }); // 4 GB: video 4K panjang bisa >2 GB
  return stdout;
}

// batch pull via tar exec-out — 1 proses adb untuk N file (~1.3-2x lebih cepat dari per-file)
// return Map<basename, Buffer>. file >512MB total per batch: pecah caller.
export async function pullBatch(deviceId, remotePaths) {
  // tar -C dir hanya bisa 1 dir per batch — group by parent dir
  const byDir = new Map();
  for (const p of remotePaths) {
    const dir = path.dirname(p), name = path.basename(p);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)).push(name);
  }
  const out = new Map();
  for (const [dir, names] of byDir) {
    const { stdout } = await run(ADB, ["-s", deviceId, "exec-out",
      `tar -cf - -C '${dir}' ${names.map(n => `'${n}'`).join(" ")}`],
      { maxBuffer: 2 * 1024 * 1024 * 1024, encoding: "buffer" });
    // parse tar (ustar/gnu): 512-byte header + content padded ke 512
    let off = 0;
    while (off + 512 <= stdout.length) {
      const name = stdout.toString("utf8", off, off + 100).replace(/\0.*$/, "");
      if (!name) break;
      const size = parseInt(stdout.toString("ascii", off + 124, off + 136).replace(/\0| /g, ""), 8) || 0;
      const type = stdout.toString("ascii", off + 156, off + 157);
      const dataStart = off + 512;
      if (type === "0" || type === "\0") out.set(name, stdout.subarray(dataStart, dataStart + size));
      off = dataStart + Math.ceil(size / 512) * 512;
    }
  }
  return out;
}

// Pull path apapun (file/folder) dengan struktur mirror
export async function pullPath(deviceId, remotePath, onProgress) {
  const storage = process.env.STORAGE_PATH;
  // mirror: E:\NigiroCORE_Data\sdcard\DCIM\Camera\...
  const rel = remotePath.replace(/^\/sdcard\//, "sdcard\\").replace(/\//g, "\\");
  const localDir = path.join(storage, path.dirname(rel));
  fs.mkdirSync(localDir, { recursive: true });
  const localPath = path.join(storage, rel);
  await adb("-s", deviceId, "pull", remotePath, localPath);
  return localPath;
}

export async function syncFiles(serial, onProgress, filter = "all", sourceDirs = DEFAULT_SOURCE_DIRS) {
  if (!serial) throw new Error("No Device Connected");

  const known = knownPaths();
  let remote = await listRemoteFiles(serial, sourceDirs);
  if (filter === "photos") remote = remote.filter(f => /\.(jpe?g|png|webp|heic|gif)$/i.test(f.path));
  else if (filter === "videos") remote = remote.filter(f => /\.(mp4|mkv|webm|mov)$/i.test(f.path));
  const pending = remote.filter(f => !known.has(f.path));
  const storage = process.env.STORAGE_PATH;
  let done = 0;

  for (const f of pending) {
    // ponytail: pull per-file biar progress akurat & satu file gagal nggak
    // bunuh batch; bulk-pull per folder lebih cepat kalau nanti butuh.
    const localDir = path.join(storage, new Date(f.mtime * 1000).getFullYear().toString());
    fs.mkdirSync(localDir, { recursive: true });
    const localPath = path.join(localDir, path.basename(f.path));
    try {
      await adb("-s", serial, "pull", f.path, localPath);
      insertFile.run(f.path, path.basename(f.path), guessMime(f.path), f.size, f.mtime, localPath);
    } catch (e) {
      onProgress?.({ done, total: pending.length, error: `FAILED: ${f.path} — ${e.message}` });
    }
    onProgress?.({ done: ++done, total: pending.length, file: f.path });
  }
  return { total: remote.length, synced: pending.length };
}

const guessMime = (p) => {
  const ext = p.toLowerCase().split(".").pop();
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    heic: "image/heic", gif: "image/gif", mp4: "video/mp4", mkv: "video/x-matroska",
    webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav",
    ogg: "audio/ogg", pdf: "application/pdf", zip: "application/zip",
    rar: "application/vnd.rar", "7z": "application/x-7z-compressed",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain", csv: "text/csv", apk: "application/vnd.android.package-archive",
  };
  return map[ext] ?? "application/octet-stream";
};
