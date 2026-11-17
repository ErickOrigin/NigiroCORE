import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import crypto from "node:crypto";
const db = new DatabaseSync("E:/NigiroCORE_Data/metadata.db");
const rows = db.prepare("SELECT original_name, local_path, checksum, size FROM files WHERE local_path LIKE '%Pictures%' ORDER BY synced_at DESC LIMIT 12").all();
for (const r of rows) {
  if (!fs.existsSync(r.local_path)) { console.log("MISSING", r.original_name); continue; }
  const h = crypto.createHash("sha1").update(fs.readFileSync(r.local_path)).digest("hex");
  console.log((h === r.checksum ? "OK  " : "BAD ") + r.original_name + "  " + r.size);
}
