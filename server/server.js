import "dotenv/config";
import express from "express";
import path from "node:path";
import { getDevice } from "./adb.js";
import { preflight } from "./preflight.js";

await preflight(); // pre-flight: storage/DB/port/ADB — blok start kalau storage/DB gagal (retry disk tiap 5s)

const app = express();
app.use(express.json());
import { authMiddleware, loginHandler, logoutHandler, changePassHandler, setRecoveryHandler, recoveryQuestionHandler, recoveryResetHandler } from "./auth.js";
app.post("/api/login", loginHandler);
app.post("/api/logout", logoutHandler);
app.post("/api/password", changePassHandler);
// recovery: set question perlu session; get question & reset bebas (dilindungi rate-limit + jawaban)
app.post("/api/recovery/set", setRecoveryHandler);
app.get("/api/recovery/question", recoveryQuestionHandler);
app.post("/api/recovery/reset", recoveryResetHandler);
// halaman terpisah: /login (bebas) dan /core (butuh session, di-handle authMiddleware)
app.get("/login", (_req, res) => res.sendFile("login.html", { root: "../web" }));
app.get("/core", (req, res) => {
  const hasSession = (req.headers.cookie ?? "").includes("nigiro_session=");
  if (!hasSession) return res.redirect("/login");
  res.sendFile("index.html", { root: "../web" });
});
app.get("/", (req, res) => {
  const hasSession = (req.headers.cookie ?? "").includes("nigiro_session=");
  res.redirect(hasSession ? "/core" : "/login");
});
app.use(authMiddleware);
app.use(express.static("../web", {
  etag: true, lastModified: true,
  setHeaders: (res, filePath) => {
    // vendor/fonts/gambar: cache lama (jarang berubah) — app.js/index.html: no-store biar edit UI langsung keliatan
    if (/[\\/](vendor|fonts|img|assets)[\\/]/.test(filePath) || /\.(woff2?|ttf|png|jpg|svg|ico)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    } else {
      res.setHeader("Cache-Control", "no-store");
    }
  },
}));

import { registerMc } from "./mc.js";
registerMc(app);

// ===== Sync/phone/backup routes =====
import syncRouter, { state as syncState, setVolumePicker } from "./routes/sync.js";
import { pickVolume } from "./routes/volumes.js";
app.use("/api", syncRouter);
setVolumePicker(pickVolume);


// ===== Gallery & media routes (gallery/media/thumbs/trash/gps/recap/duplicates) =====
import galleryRouter from "./routes/gallery.js";
// frontend memanggil /media/:id tanpa prefix /api — rewrite lalu lanjut stack (JANGAN panggil router langsung:
// router ter-mount di /api, dipanggil langsung = url /api/media/... tidak match route /media/:id ? 404)
app.use((req, res, next) => {
  if (req.path.startsWith("/media/")) req.url = "/api" + req.url;
  next();
});
app.use("/api", galleryRouter);



// ===== Apps: media downloader (yt-dlp) + PDF/image tools =====
import appsRouter from "./routes/apps.js";
app.use("/api/apps", appsRouter);



// ===== Settings & maintenance routes =====
import settingsRouter from "./routes/settings.js";
app.use("/api", settingsRouter);

// ===== Albums routes (manual + smart) =====
import albumsRouter from "./routes/albums.js";
app.use("/api", albumsRouter);

// ===== System monitoring + Volumes/SSE routes =====
import volumesRouter, { getAlertBroadcaster } from "./routes/volumes.js";
import systemRouter, { setAlertBroadcaster } from "./routes/system.js";
app.use("/api", systemRouter);
app.use("/api", volumesRouter);
setAlertBroadcaster(getAlertBroadcaster());


app.get("/api/status", async (_req, res) => {
  try {
    const device = await getDevice();
    res.json({ device, syncing: syncState.syncing || syncState.backingUp, backupProgress: syncState.backupProgress, log: syncState.log.slice(-50), scanProgress: syncState.scanProgress });
  } catch (e) {
    res.json({ device: null, syncing: syncState.syncing || syncState.backingUp, backupProgress: syncState.backupProgress, error: e.message, log: syncState.log.slice(-50), scanProgress: syncState.scanProgress });
  }
});

app.listen(process.env.PORT ?? 3000, () =>
  console.log(`NigiroCORE: http://localhost:${process.env.PORT ?? 3000}`));



