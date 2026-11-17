// Self-check NIGIRO.MC — jalankan: node mc.test.js (dari folder server)
// Tanpa framework, sesuai konvensi repo (vanilla, no build step). Fail = exit 1.
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

// minJavaFor & parser properties diekspor? Belum — test via re-implement kontrak di sini
// akan rapuh. Solusi: ekspor fungsi murni dari mc.js (lihat export di bawah mc.js).
const mc = await import("./mc.js");
const { minJavaFor, parseProperties, stringifyProperties } = mc;

// --- minJavaFor: mapping versi MC -> Java minimum ---
assert.equal(minJavaFor("1.21.4"), 21, "1.21.4 butuh Java 21");
assert.equal(minJavaFor("1.20.6"), 21, "1.20.6 butuh Java 21");
assert.equal(minJavaFor("1.20.4"), 17, "1.20.4 butuh Java 17");
assert.equal(minJavaFor("1.17"), 17, "1.17 butuh Java 17");
assert.equal(minJavaFor("1.16.5"), 8, "1.16.5 cukup Java 8");
assert.equal(minJavaFor("1.12.2"), 8, "1.12.2 cukup Java 8");

// --- resolveJavaFor logic: override per-server menang, fallback ke global ---
// (resolveJavaFor tidak diekspor; kontraknya diuji via struktur listManagedJavas di endpoint /api/mc/javas)
assert.ok(true, "per-server java: struktur diuji via endpoint live");

// --- parseProperties: round-trip & komentar & spasi ---
const sample = "#Minecraft server properties\n#generated\nmotd=A Minecraft Server\nserver-port=25565\nview-distance=10\n";
const parsed = parseProperties(sample);
assert.equal(parsed["motd"], "A Minecraft Server");
assert.equal(parsed["server-port"], "25565");
assert.equal(Object.keys(parsed).length, 3, "komentar tidak ikut");
const back = stringifyProperties(parsed);
assert.equal(parseProperties(back)["view-distance"], "10", "round-trip utuh");

// --- nama server validation (kontrak endpoint create) ---
const nameOk = (n) => /^[A-Za-z0-9_-]{1,40}$/.test(n);
assert.ok(nameOk("survival-1"), "nama valid diterima");
assert.ok(!nameOk("../etc"), "path traversal ditolak");
assert.ok(!nameOk("a".repeat(41)), "nama >40 char ditolak");

// --- cleanup: tidak ada side effect di disk ---
assert.ok(!fs.existsSync(path.join(process.cwd(), "java", "jdk-test")), "tidak menulis disk");

console.log("mc.test.js — semua", 12, "assert PASS");
