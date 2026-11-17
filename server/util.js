// util bersama antar route module
import path from "node:path";

// local_path di DB disimpan RELATIF ke STORAGE_PATH (portabel — huruf drive boleh berubah).
// helper ini resolve ke absolut saat akses file. Path absolut lama (pre-migrasi) tetap lolos.
export const absPath = (p) => (path.isAbsolute(p) ? p : path.join(process.env.STORAGE_PATH ?? "", p));
// simpan: absolut → relatif (dipakai semua titik tulis local_path)
export const relPath = (p) => {
  const sp = process.env.STORAGE_PATH ?? "";
  const abs = path.resolve(p);
  return abs.toLowerCase().startsWith(sp.toLowerCase() + path.sep) ? abs.slice(sp.length + 1) : abs;
};

export const guessMime = (p) => {
  const ext = p.toLowerCase().split(".").pop();
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    heic: "image/heic", gif: "image/gif", mp4: "video/mp4", mkv: "video/x-matroska",
    webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav",
    pdf: "application/pdf", zip: "application/zip",
    doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain", csv: "text/csv", apk: "application/vnd.android.package-archive",
  };
  return map[ext] ?? "application/octet-stream";
};
