// Auth sederhana: user+pass dari .env, session cookie bertanda tangan (HMAC), tanpa dep baru.
import crypto from "node:crypto";
import "dotenv/config";

const USER = process.env.PANEL_USER ?? "admin";
let PASS = process.env.PANEL_PASS ?? "admin";
import { getSetting, setSetting } from "./db.js";
// password dari DB menang atas .env (ganti-password-UI bekerja lintas restart)
PASS = getSetting("panelPass") ?? PASS;
const SECRET = process.env.PANEL_SECRET ?? crypto.randomBytes(32).toString("hex");
const COOKIE = "nigiro_session";

function sign(value) {
  return crypto.createHmac("sha256", SECRET).update(value).digest("hex");
}

function makeToken() {
  const exp = Date.now() + 30 * 24 * 3600 * 1000; // 30 hari
  const payload = `${USER}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

function valid(token) {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const payload = parts.slice(0, 2).join(".");
  const exp = +parts[1];
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  try { return crypto.timingSafeEqual(Buffer.from(sign(payload)), Buffer.from(parts[2])); } catch { return false; }
}

function parseCookies(req) {
  const out = {};
  for (const c of (req.headers.cookie ?? "").split(";")) {
    const i = c.indexOf("=");
    if (i > 0) out[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  }
  return out;
}

export function authMiddleware(req, res, next) {
  // login endpoint & halaman login & static assets bebas
  if (req.path === "/api/login" || req.path === "/login" || !req.path.startsWith("/api/")) return next();
  if (valid(parseCookies(req)[COOKIE])) return next();
  res.status(401).json({ error: "unauthorized" });
}

// rate-limit login: 5 percobaan / 15 menit per IP
const attempts = new Map(); // ip -> { n, until }
function limited(ip) {
  const a = attempts.get(ip);
  return a && a.n >= 5 && Date.now() < a.until;
}
function recordFail(ip) {
  const a = attempts.get(ip) ?? { n: 0, until: Date.now() + 15 * 60 * 1000 };
  a.n++;
  attempts.set(ip, a);
}
const ipOf = (req) => req.socket.remoteAddress ?? "?";

export function loginHandler(req, res) {
  const ip = ipOf(req);
  if (limited(ip)) return res.status(429).json({ error: "Terlalu Banyak Percobaan — Coba Lagi Nanti" });
  const { user, pass } = req.body ?? {};
  const ok = user === USER && pass === PASS;
  if (!ok) { recordFail(ip); return res.status(401).json({ error: "Username atau password salah" }); }
  attempts.delete(ip);
  res.setHeader("Set-Cookie", `${COOKIE}=${makeToken()}; HttpOnly; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`);
  res.json({ ok: true });
}

// ganti password (butuh session valid + pass lama)
export function changePassHandler(req, res) {
  const { oldPass, newPass } = req.body ?? {};
  if (oldPass !== PASS) return res.status(401).json({ error: "Password Lama Salah" });
  if (typeof newPass !== "string" || newPass.length < 4 || newPass.length > 128) return res.status(400).json({ error: "Password Baru 4–128 Karakter" });
  setSetting("panelPass", newPass);
  PASS = newPass;
  res.json({ ok: true });
}

// ===== Recovery: security question (self-hosted, tanpa email) =====
// jawaban disimpan sebagai SHA-256 (case-insensitive, trim) — bukan plaintext
const hashAns = (s) => crypto.createHash("sha256").update(String(s ?? "").trim().toLowerCase()).digest("hex");

export function setRecoveryHandler(req, res) {
  const { question, answer } = req.body ?? {};
  if (typeof question !== "string" || question.trim().length < 3 || question.trim().length > 200) return res.status(400).json({ error: "Question 3–200 Characters" });
  if (typeof answer !== "string" || answer.trim().length < 2) return res.status(400).json({ error: "Answer At Least 2 Characters" });
  setSetting("recoveryQuestion", question.trim());
  setSetting("recoveryAnswer", hashAns(answer));
  res.json({ ok: true });
}

export function recoveryQuestionHandler(_req, res) {
  const q = getSetting("recoveryQuestion");
  if (!q) return res.status(404).json({ error: "No Recovery Question Set" });
  res.json({ question: q });
}

export function recoveryResetHandler(req, res) {
  const ip = ipOf(req);
  if (limited(ip)) return res.status(429).json({ error: "Too Many Attempts — Try Again Later" });
  const { answer, newPass } = req.body ?? {};
  const stored = getSetting("recoveryAnswer");
  if (!stored) { recordFail(ip); return res.status(404).json({ error: "No Recovery Question Set" }); }
  // timingSafeEqual butuh buffer sama panjang — hash dulu input-nya
  if (hashAns(answer) !== stored) { recordFail(ip); return res.status(401).json({ error: "Answer Does Not Match" }); }
  if (typeof newPass !== "string" || newPass.length < 4 || newPass.length > 128) return res.status(400).json({ error: "New Password 4–128 Characters" });
  attempts.delete(ip);
  setSetting("panelPass", newPass);
  PASS = newPass;
  res.json({ ok: true });
}

export function logoutHandler(_req, res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
}
