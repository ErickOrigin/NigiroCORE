// streaming pull untuk file raksasa: HP -> disk tanpa buffer penuh di RAM.
// RAM konstan ~puluhan MB berapapun ukuran file. Verify via dual streaming hash.
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";

const ADB = process.env.ADB_PATH;

/**
 * Pull satu file remote via `adb exec-out cat` langsung ke file disk (streaming).
 * Return { sha1, size } — hash sumber, dihitung sambil mengalir.
 * Gagal mid-stream = reject; caller hapus partial .tmp.
 */
export function pullFileStream(deviceId, remotePath, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(ADB, ["-s", deviceId, "exec-out", `cat '${remotePath}'`], { windowsHide: true });
    const hash = crypto.createHash("sha1");
    let size = 0n;
    let lastTick = 0;
    // staleness watchdog: adb mati diam-diam (USB drop) = pipe gak pernah close → gagalkan dalam 30 detik
    let watchdog = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("stream stalled: no data for 30s (USB drop?)")); }, 30000);
    const bumpWatchdog = () => { clearTimeout(watchdog); watchdog = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("stream stalled: no data for 30s (USB drop?)")); }, 30000); };
    const out = fs.createWriteStream(destPath, { flags: "w" });
    child.stdout.on("data", (chunk) => {
      hash.update(chunk); size += BigInt(chunk.length);
      // throttle callback: max 1x per detik biar gak banjir object allocation
      const now = Date.now();
      bumpWatchdog(); // reset watchdog tiap data masuk (transfer 12 GB = menit, bukan 30 detik)
      if (onProgress && now - lastTick > 1000) { lastTick = now; onProgress(Number(size)); }
    });
    child.stdout.pipe(out);
    child.on("error", reject);
    out.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(watchdog);
      out.end(() => code === 0 ? resolve({ sha1: hash.digest("hex"), size }) : reject(new Error(`adb exit ${code}`)));
    });
  });
}

/**
 * Hash streaming file lokal (verify read-back tanpa load ke RAM).
 */
export function hashFileStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    let size = 0n;
    const s = fs.createReadStream(filePath);
    s.on("data", (c) => { hash.update(c); size += BigInt(c.length); });
    s.on("error", reject);
    s.on("end", () => resolve({ sha1: hash.digest("hex"), size }));
  });
}
