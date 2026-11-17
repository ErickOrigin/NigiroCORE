// debug: jalankan logika scan backup-selected secara manual
import "dotenv/config";
import { getDevice, adb } from "./adb.js";
const device = await getDevice();
console.log("device:", device?.id);
const p = "/storage/emulated/0/Pictures";
const stat = await adb("shell", `stat -c '%F %s %Y' '${p}' 2>/dev/null`);
console.log("stat:", JSON.stringify(stat));
const out = await adb("shell", `find '${p}' -type f -not -path '*/.*' -exec stat -c '%s %Y %n' {} + 2>/dev/null`).catch(e => "ERR " + e.message);
const lines = out.split("\n").filter(Boolean);
console.log("lines:", lines.length, "first:", lines[0]);
const allFiles = [];
for (const line of lines) {
  const sp1 = line.indexOf(" "), sp2 = line.indexOf(" ", sp1 + 1);
  if (sp1 < 1 || sp2 < 0) continue;
  allFiles.push({ path: line.slice(sp2 + 1), size: +line.slice(0, sp1), mtime: +line.slice(sp1 + 1, sp2) });
}
const y2026 = allFiles.filter(f => new Date(f.mtime * 1000).getFullYear() === 2026);
console.log("2026 files:", y2026);
