// migrasi sekali jalan: /sdcard/ → /storage/emulated/0/ (canonical device path)
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("E:/NigiroCORE_Data/metadata.db");
db.exec("UPDATE files SET device_path = REPLACE(device_path, '/sdcard/', '/storage/emulated/0/') WHERE device_path LIKE '/sdcard/%'");
console.log(JSON.stringify({
  canonical: db.prepare("SELECT COUNT(*) n FROM files WHERE device_path LIKE '/storage/emulated/0/%'").get(),
  old: db.prepare("SELECT COUNT(*) n FROM files WHERE device_path LIKE '/sdcard/%'").get(),
}));
