const $ = (s) => document.querySelector(s);
// escape HTML untuk semua data eksternal (nama file, path, dll) sebelum masuk innerHTML
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let cache = {};
let flat = [];

// anti-FOUT icon: tampilkan .msr hanya setelah font icon siap
document.fonts.load('24px "Material Symbols Rounded"').then(() => {
  document.querySelectorAll(".msr").forEach(el => el.classList.add("msr-ready"));
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes)
      if (n.nodeType === 1) {
        if (n.classList?.contains("msr")) n.classList.add("msr-ready");
        n.querySelectorAll?.(".msr").forEach(el => el.classList.add("msr-ready"));
      }
  }).observe(document.body, { childList: true, subtree: true });
});

// guard: click setelah drag/select teks tidak dianggap click (fix: container nutup saat selesai select)
// selection TIDAK dibersihkan — biar highlight biru tetap ada untuk copy
(function () {
  let down = null;
  document.addEventListener("pointerdown", e => { down = { x: e.clientX, y: e.clientY }; });
  document.addEventListener("click", e => {
    if (down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      const interactive = e.target.closest("button, a, input, select, textarea, label, .dialog, .dialog-backdrop");
      if (!interactive && (dx * dx + dy * dy > 25 || String(getSelection()).length > 0)) {
        e.stopPropagation();
        e.preventDefault();
      }
    }
    down = null;
  }, true);
})();

// ===== Theme (dark mode) =====
function applyTheme(t) {
  document.body.classList.toggle("dark", t === "dark");
  $("#themeIcon").textContent = t === "dark" ? "light_mode" : "dark_mode";
  // matikan Chrome Auto Dark saat light mode biar warna asli yang tampil
  document.querySelector('meta[name="color-scheme"]').content = t === "dark" ? "dark" : "only light";
  localStorage.setItem("nigiro-theme", t);
}
$("#themeBtn").onclick = () => applyTheme(document.body.classList.contains("dark") ? "light" : "dark");
applyTheme(localStorage.getItem("nigiro-theme") ?? "light");
refreshProfiles().catch(() => {}); // avatar profile di topbar

// ===== Views =====
function showView(v) {
  $("#view-dashboard").style.display = v === "dashboard" ? "" : "none";
  $("#view-device").style.display = v === "device" ? "" : "none";
  $("#view-photos").style.display = v === "photos" ? "" : "none";
  if (v === "dashboard") loadStats();
  $("#view-videos").style.display = v === "videos" ? "" : "none";
  $("#view-files").style.display = v === "files" ? "" : "none";
  $("#view-trash").style.display = v === "trash" ? "" : "none";
  $("#view-dupes").style.display = v === "dupes" ? "" : "none";
  $("#view-maps").style.display = v === "maps" ? "" : "none";
  $("#view-favorites").style.display = v === "favorites" ? "" : "none";
  $("#view-recap").style.display = v === "recap" ? "" : "none";
  $("#view-archive").style.display = v === "archive" ? "" : "none";
  $("#view-albums").style.display = v === "albums" ? "" : "none";
  $("#view-documents").style.display = v === "documents" ? "" : "none";
  $("#view-settings").style.display = v === "settings" ? "" : "none";
  $("#view-monitoring").style.display = v === "monitoring" ? "" : "none";
  $("#view-apps").style.display = v === "apps" ? "" : "none";
  $("#view-app-downloader").style.display = v === "app-downloader" ? "" : "none";
  $("#view-app-pdf").style.display = v === "app-pdf" ? "" : "none";
  $("#view-app-image").style.display = v === "app-image" ? "" : "none";
  $("#view-app-mc").style.display = v === "app-mc" ? "" : "none";
  document.querySelectorAll("[data-nav]").forEach(a => a.classList.toggle("active", a.dataset.nav === v));
  if (v === "dashboard") loadStats();
  else if (v === "device") loadDevice();
  else if (v === "freeup") { showView("device"); devTab("freeup"); }
  else if (v === "photos") loadGallery($("#search").value);
  else if (v === "videos") loadVideoGallery();
  else if (v === "files") browse(currentDir);
  else if (v === "trash") showTrash();
  else if (v === "dupes") showDuplicates();
  else if (v === "maps") loadMaps();
  else if (v === "favorites") loadFavorites();
  else if (v === "recap") loadRecap();
  else if (v === "archive") loadArchive();
  else if (v === "albums") { loadAlbums(); loadManualAlbums(); }
  else if (v === "documents") loadDocuments();
  else if (v === "settings") loadSettingsAll();
  else if (v === "monitoring") startMonitoring();
  else if (v === "apps") loadAppsFiles();
  else if (v === "app-pdf" || v === "app-image") { loadAppsFiles(); wireDropzone("appsDropzone", "appsUploadPdf"); wireDropzone("appsDropzoneImg", "appsUploadImg"); }
}

// ===== Sidebar toggle =====
$("#menuBtn").onclick = () => {
  $("#sidebar").classList.toggle("collapsed");
  $("#main").classList.toggle("expanded");
};

// ===== Status polling =====
async function refreshStatus() {
  try {
    const s = await (await fetch("/api/status")).json();
    window._lastStatus = s;
    updateDeviceBackupPanel();
    updateChip("dash", s); // status device cuma tampil di Dashboard
    $("#syncBtn2").disabled = s.syncing || !s.device;
    if (s.syncing) {
      $("#progressWrap").style.display = "";
      const log = $("#log");
      log.style.display = "";
      log.textContent = s.log.join("\n");
      log.scrollTop = 1e9;
      // utamakan backupProgress object (byte-level — streaming file raksasa lapor progress real)
      const bp = s.backupProgress;
      const m = bp && bp.total ? { 1: bp.done, 2: bp.total, bp } : (s.log[s.log.length - 1] ?? "").match(/^(\d+)\/(\d+)/);
      if (m) {
        const done = +m[1], total = +m[2];
        const pct = m.bp ? m.bp.pct : Math.round((done / total) * 100);
        $("#progressBar").style.width = pct + "%";
        $("#progressPct").textContent = pct + "%";
        // transparansi penuh: APA yang dibackup + DARI MANA (folder asal di HP)
        if (m.bp && m.bp.bytesTotal) {
          const parts = (m.bp.file || "").split("/").filter(Boolean);
          const fname = parts.pop() ?? "";
          const phoneFolder = "/" + parts.slice(3).join("/"); // buang /storage/emulated/0
          $("#progressCount").innerHTML =
            `<span class='msr' style='font-size:14px;vertical-align:-2px'>smartphone</span> ${(m.bp.bytesTransferred / 1073741824).toFixed(2)} / ${(m.bp.bytesTotal / 1073741824).toFixed(2)} GB · ${done.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} Files` +
            `<br><span style='font-size:11px;opacity:.75'>${fname} — from ${phoneFolder || "/"} on phone</span>`;
        } else {
          $("#progressCount").textContent = `${done.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} Files`;
        }
        // ETA + speed: byte-based (akurat untuk streaming raksasa), fallback file-based
        const now = Date.now();
        if (m.bp && m.bp.bytesTotal) {
          if (!window._bkBytes || window._bkFile !== m.bp.file) { window._bkBytes = { t0: now, b0: m.bp.bytesTransferred }; window._bkFile = m.bp.file; }
          const el = (now - window._bkBytes.t0) / 1000;
          const mbps = (m.bp.bytesTransferred - window._bkBytes.b0) / 1048576 / Math.max(el, 1);
          if (mbps > 0.1) {
            const secs = Math.ceil((m.bp.bytesTotal - m.bp.bytesTransferred) / 1048576 / mbps);
            const h = Math.floor(secs / 3600), mn = Math.floor((secs % 3600) / 60);
            $("#progressEta").textContent = `${mbps.toFixed(1)} MB/s — ${h > 0 ? `${h}h ${mn}m` : mn > 0 ? `~${mn}m ${secs % 60}s` : `~${secs}s`} Remaining`;
          }
        } else {
          if (!window._bkStart || window._bkTotal !== total) { window._bkStart = now; window._bkDone0 = done; window._bkTotal = total; }
          const elapsed = (now - window._bkStart) / 1000;
          const rate = (done - window._bkDone0) / Math.max(elapsed, 1);
          if (rate > 0 && done < total) {
            const secs = Math.ceil((total - done) / rate);
            const h = Math.floor(secs / 3600), mn = Math.floor((secs % 3600) / 60);
            $("#progressEta").textContent = h > 0 ? `~${h}h ${mn}m Remaining` : mn > 0 ? `~${mn}m ${secs % 60}s Remaining` : `~${secs}s Remaining`;
          } else if (done >= total) {
            $("#progressEta").textContent = "Finishing…";
          }
        }
      }
    } else {
      window._bkStart = null; // reset timer saat backup selesai
    }
  } catch {}
}

function updateChip(prefix, s) {
  const dot = $(`#${prefix}-dot`), el = $(`#${prefix}-status`);
  // backup status card di dashboard
  const cardTitle = $("#backupCardTitle"), cardSub = $("#backupCardSub"), cardIcon = $("#backupCardIcon"), btn2 = $("#syncBtn2");
  if (cardTitle) {
    if (s.syncing) {
      cardTitle.textContent = "Backing Up…";
      cardSub.textContent = "Transferring Files From Device";
      cardIcon.textContent = "progress_activity";
    } else if (s.device) {
      cardTitle.textContent = s.device.model || "Device Connected";
      // detail lengkap dari adb-status cache (id · Authorized · Android · Battery)
      const d = window._adbInfo;
      cardTitle.textContent = d?.model || s.device.model || "Device Connected";
      cardSub.textContent = d
        ? [d.id, "Authorized", d.android ? `Android ${d.android}` : "", d.battery ? `Battery ${d.battery.level}%${d.battery.charging ? " (Charging)" : ""}` : ""].filter(Boolean).join(" | ")
        : `${s.device.id} · Authorized`;
      cardIcon.textContent = "smartphone";
    } else {
      cardTitle.textContent = "No Device";
      cardSub.textContent = "Connect Via USB Cable";
      cardIcon.textContent = "usb_off";
    }
    if (btn2) btn2.disabled = s.syncing || !s.device;
    // Free Up Space button dihapus dari dashboard (keputusan LO) — fitur masih ada via Device hub
  }
  if (dot) {
    if (s.device) {
      el.textContent = `${s.device.model || "Device"} Connected — ${s.syncing ? "Backing Up…" : "Ready to Backup"}`;
      dot.className = `dot ${s.syncing ? "busy" : "ok"}`;
    } else {
      el.textContent = s.error ?? "No Device — Connect via USB Cable";
      dot.className = "dot";
    }
  }
}

// ===== Sync =====
function showBackupDialog() {
  $("#backupDialog").style.display = "flex";
}
function closeBackupDialog() {
  $("#backupDialog").style.display = "none";
}

// ===== Year selector (backup berkala per rentang tahun — semua tipe file) =====
let yearCtx = null; // { paths, filter } atau { paths } dari picker

function closeYearDialog() {
  $("#yearDialog").style.display = "none";
  yearCtx = null;
}

async function quickSync(filter) {
  closeBackupDialog();
  const device = (await (await fetch("/api/status")).json()).device;
  if (!device) { toast("No Device — Connect Via USB Cable", "error"); return; }
  // scan root folder umum sesuai filter + WhatsApp Media (2 layout: legacy /WhatsApp & modern /Android/media/com.whatsapp — folder yang gak ada di-skip server)
  const WAL = "/storage/emulated/0/WhatsApp/Media";
  const WAM = "/storage/emulated/0/Android/media/com.whatsapp/WhatsApp/Media";
  const roots = filter === "photos" ? ["/storage/emulated/0/DCIM", "/storage/emulated/0/Pictures", WAL + "/WhatsApp Images", WAM + "/WhatsApp Images"]
    : filter === "videos" ? ["/storage/emulated/0/DCIM", "/storage/emulated/0/Movies", WAL + "/WhatsApp Video", WAM + "/WhatsApp Video"]
    : ["/storage/emulated/0/DCIM", "/storage/emulated/0/Download", "/storage/emulated/0/Pictures", "/storage/emulated/0/Movies", "/storage/emulated/0/Documents", "/storage/emulated/0/Screenshots", WAL, WAM];
  // preset Everything New: scan dulu → dialog konfirmasi (jumlah + GB + estimasi) → baru jalan
  if (filter === "new") { await confirmEverythingNew(roots); return; }
  await openYearSelector(roots.filter(p => true), filter);
}

let confirmCtx = null;
async function confirmEverythingNew(roots) {
  const body = $("#confirmBackupBody");
  $("#cfNewCount").textContent = "…"; $("#cfNewSize").textContent = "scanning"; $("#cfEta").textContent = "…";
  body.textContent = "Scanning Phone Contents — Do Not Disconnect The Cable.";
  $("#confirmBackupGo").disabled = true;
  $("#confirmBackupDialog").style.display = "flex";
  try {
    // onlyNew: server filter path yang belum di vault — sekali scan, estimasi akurat tanpa payload raksasa
    const scan = await (await fetch("/api/phone/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: roots, filter: "all", onlyNew: true }),
    })).json();
    if (scan.error) throw new Error(scan.error);
    const newCount = scan.count, newSize = scan.size;
    const mins = Math.ceil(newSize / 1048576 / 10); // asumsi ~10 MB/s USB — ETA kasar
    const eta = mins > 90 ? `~${Math.round(mins / 60)} Hours` : mins > 60 ? `~1 Hour ${mins % 60}m` : `~${mins} Minutes`;
    confirmCtx = { roots };
    $("#cfNewCount").textContent = newCount.toLocaleString("en-US");
    $("#cfNewSize").textContent = fmtSize(newSize);
    $("#cfEta").textContent = eta;
    const scanned = scan.scannedTotal ?? scan.count;
    body.innerHTML =
      `<span class="msr" style="font-size:13px;vertical-align:-2px;color:var(--n-primary)">check_circle</span> ${scanned.toLocaleString("en-US")} files scanned on phone` +
      `<br><span class="msr" style="font-size:13px;vertical-align:-2px;color:var(--n-secondary)">skip_next</span> ${scanned.toLocaleString("en-US") > 0 ? (scanned - newCount).toLocaleString("en-US") : "0"} already in the vault — they will be skipped instantly` +
      `<br><span class="msr" style="font-size:13px;vertical-align:-2px;color:var(--n-accent,#D71921)">usb</span> Keep The Cable Connected Until Finished`;
    $("#confirmBackupGo").disabled = false;
  } catch (e) {
    body.innerHTML = `<span style="color:var(--md-error)">${esc(e.message)}</span>`;
    $("#cfNewCount").textContent = "—"; $("#cfNewSize").textContent = "—"; $("#cfEta").textContent = "—";
  }
}
function closeConfirmBackup() {
  $("#confirmBackupDialog").style.display = "none";
  confirmCtx = null;
}
async function confirmBackupGo() {
  const roots = confirmCtx?.roots;
  closeConfirmBackup();
  if (roots?.length) await startBackupSelected(roots, null, "all");
}

async function openYearSelector(paths, filter = "all") {
  yearCtx = { paths, filter };
  $("#yearDialog").style.display = "flex";
  const list = $("#yearList");
  list.innerHTML = "";
  // terminal-style progress container
  const term = $("#yearScanTerm"), termLog = $("#yearScanLog"), bar = $("#yearScanBar"), pct = $("#yearScanPct");
  term.style.display = "block";
  termLog.textContent = "";
  bar.style.width = "0%"; pct.textContent = "0%";
  let lastLine = "";
  const poll = setInterval(async () => {
    try {
      const s = (await (await fetch("/api/status")).json()).scanProgress;
      if (!s) { clearInterval(poll); return; }
      const p = s.total ? Math.round((s.done / s.total) * 100) : 0;
      bar.style.width = p + "%";
      pct.textContent = `${p}% · ${s.done}/${s.total}`;
      const line = `[${s.phase}] ${s.done}/${s.total}  ${s.current ?? ""}`;
      if (line !== lastLine) {
        lastLine = line;
        termLog.textContent += line + "\n";
        termLog.scrollTop = termLog.scrollHeight;
      }
    } catch {}
  }, 500);
  try {
    const scan = await (await fetch("/api/phone/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, filter }),
    })).json();
    clearInterval(poll);
    term.style.display = "none";
    if (scan.error) throw new Error(scan.error);
    const years = Object.entries(scan.byYear ?? {}).sort((a, b) => b[0] - a[0]);
    if (!years.length) {
      list.innerHTML = '<p style="color:var(--md-on-surface-variant);font-size:13px">No files found.</p>';
      return;
    }
    // semua tahun kecentang default
    list.innerHTML = years.map(([y, d]) => `
      <label style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;background:var(--md-surface-container-low);margin-bottom:6px;cursor:pointer">
        <input type="checkbox" class="year-cb" value="${y}" checked style="width:18px;height:18px;accent-color:var(--md-primary)">
        <span style="flex:1;font-size:14px;font-weight:500">${y}</span>
        <span style="font-size:12px;color:var(--md-on-surface-variant)">${d.count} files · ${fmtSize(d.size)}</span>
      </label>`).join("");
    list.querySelectorAll(".year-cb").forEach(cb => cb.onchange = updateYearGo);
    updateYearGo();
  } catch (e) {
    clearInterval(poll);
    term.style.display = "none";
    list.innerHTML = `<p style="color:var(--md-error);font-size:13px">${e.message}</p>`;
  }
}

function updateYearGo() {
  const n = [...document.querySelectorAll(".year-cb:checked")].length;
  $("#yearGoBtn").disabled = n === 0;
  $("#yearGoBtn").textContent = n ? `Backup ${n} Year${n > 1 ? "s" : ""}` : "Backup";
}

async function confirmYearBackup() {
  const years = [...document.querySelectorAll(".year-cb:checked")].map(cb => +cb.value);
  const ctx = yearCtx;
  closeYearDialog();
  if (!ctx || !years.length) return;
  await startBackupSelected(ctx.paths, years, ctx.filter);
}

// ===== Custom picker (browse HP + preview + scan) =====
let pickerDir = "/storage/emulated/0";
let pickerEntries = [];
const pickerSel = new Set();
let pickerDevice = ""; // serial HP yang dipilih di picker ("" = auto/single device)

// load daftar device terhubung untuk dropdown picker (multi-device)
async function loadPickerDevices() {
  try {
    const list = await (await fetch("/api/devices")).json();
    const live = list.filter(d => d.connected);
    const sel = $("#pickerDevice");
    if (!sel) return;
    if (live.length <= 1) { sel.style.display = "none"; pickerDevice = live[0]?.serial ?? ""; return; }
    sel.style.display = "";
    sel.innerHTML = live.map(d => `<option value="${d.serial}">${esc(d.name || d.serial)}</option>`).join("");
    pickerDevice = sel.value;
  } catch {}
}

function onPickerDeviceChange() {
  pickerDevice = $("#pickerDevice").value;
  pickerBrowse("/storage/emulated/0");
}

function openPicker() {
  closeBackupDialog();
  $("#pickerDialog").style.display = "flex";
  pickerSel.clear();
  loadPickerDevices().then(() => pickerBrowse("/storage/emulated/0"));
}
function closePicker() {
  $("#pickerDialog").style.display = "none";
}

async function pickerBrowse(dir) {
  pickerDir = dir;
  const list = $("#pickerList");
  list.innerHTML = '<p style="color:var(--md-on-surface-variant);padding:20px">Loading…</p>';
  try {
    const r = await (await fetch(`/api/phone/browse?path=${encodeURIComponent(dir)}&serial=${encodeURIComponent(pickerDevice)}`)).json();
    if (r.error) { list.innerHTML = `<p style="color:var(--md-error);padding:20px">${r.error}</p>`; return; }
    pickerEntries = r.entries;
    // render crumbs
    let html = `<button class="crumb" onclick="pickerBrowse('/storage/emulated/0')">HP</button>`;
    let acc = "";
    for (const p of dir.split("/").filter(Boolean)) {
      if (p === "storage" || p === "0" && acc === "/storage") { acc += "/" + p; continue; }
      acc += "/" + p;
      if (acc === "/storage" || acc === "/storage/0" || acc === "/storage/emulated") continue;
      html += `<span class="crumb-sep">/</span><button class="crumb" onclick="pickerBrowse('${acc}')">${p}</button>`;
    }
    $("#pickerCrumbs").innerHTML = html;
    renderPickerList();
  } catch (e) {
    list.innerHTML = `<p style="color:var(--md-error);padding:20px">${e.message}</p>`;
  }
}

function renderPickerList() {
  const list = $("#pickerList");
  if (!pickerEntries.length) { list.innerHTML = '<p style="color:var(--md-on-surface-variant);padding:20px">Folder Is Empty.</p>'; return; }
  list.innerHTML = pickerEntries.map(e => {
    const esc2 = e.path.replace(/'/g, "\\'");
    const checked = pickerSel.has(e.path);
    const isImg = /\.(jpe?g|png|webp|gif)$/i.test(e.name);
    const isVid = /\.(mp4|webm|mkv)$/i.test(e.name);
    const preview = (isImg || isVid)
      ? `<img src="/api/phone/preview?w=200&path=${encodeURIComponent(e.path)}" loading="lazy" style="width:40px;height:40px;object-fit:cover;border-radius:6px" onerror="this.outerHTML='<span class=\\'msr\\'>${e.isDir ? 'folder' : 'draft'}</span>'">`
      : `<span class="msr" style="color:${e.isDir ? "var(--n-secondary)" : "var(--md-on-surface-variant)"}">${iconFor(e)}</span>`;
    return `<div class="frow ${checked ? "selected" : ""}" onclick="pickerToggle('${esc2}', ${e.isDir})">
      <input type="checkbox" ${checked ? "checked" : ""} onclick="event.stopPropagation();pickerToggle('${esc2}', ${e.isDir}, true)">
      ${preview}
      <span class="fname">${esc(e.name)}</span>
      <span class="fmeta">${e.isDir ? "" : fmtSize(e.size)}</span>
      ${e.isDir ? `<span class="msr" style="font-size:20px">chevron_right</span>` : ""}
    </div>`;
  }).join("");
}

function pickerToggle(p, isDir, fromCheckbox = false) {
  // klik baris folder = masuk; klik checkbox folder = pilih folder itu (rekursif saat scan)
  if (isDir && !fromCheckbox) { pickerBrowse(p); return; }
  pickerSel.has(p) ? pickerSel.delete(p) : pickerSel.add(p);
  renderPickerList();
  updatePickerSummary();
}

function updatePickerSummary() {
  const n = pickerSel.size;
  $("#pickerGo").disabled = n === 0;
  $("#pickerGoLabel").textContent = n ? `Backup ${n} item` : "Backup";
  $("#pickerSummary").textContent = n ? "" : "Click a folder to enter, check files/folders to select.";
}

async function pickerGo() {
  if (!pickerSel.size) return;
  const paths = [...pickerSel];
  $("#pickerGo").disabled = true;
  $("#pickerGoLabel").textContent = "Scanning…";
  try {
    const scan = await (await fetch("/api/phone/scan", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, filter: "all" }),
    })).json();
    if (scan.error) { errorToast(scan.error); return; }
    // tampilkan scan result dalam dialog, bukan confirm() Chrome
    const gb = (scan.size / 1e9).toFixed(2);
    const mb = (scan.size / 1e6).toFixed(1);
    $("#scanTitle").textContent = `Found ${scan.count} files (${scan.size > 1e9 ? gb + " GB" : mb + " MB"})`;
    const preview = scan.files.slice(0, 15).map(f => f.split("/").pop()).join("\n");
    $("#scanFiles").textContent = preview + (scan.count > 15 ? `\n… and ${scan.count - 15} more` : "");
    $("#scanConfirm").style.display = "";
    window._pendingBackup = paths;
  } catch (e) {
    errorToast(e.message);
  } finally {
    $("#pickerGo").disabled = false;
    $("#pickerGoLabel").textContent = "Backup";
  }
}

function cancelScan() {
  $("#scanConfirm").style.display = "none";
  window._pendingBackup = null;
}

async function confirmScan() {
  const paths = window._pendingBackup;
  cancelScan();
  if (!paths?.length) return;
  closePicker();
  // lewat year selector dulu — backup berkala per tahun
  await openYearSelector(paths, "all");
}

async function startBackupSelected(paths, years = null, filter = "all") {
  showView("photos"); // tampilin progress di photos view
  const r = await fetch("/api/backup-selected", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, years, filter, serial: pickerDevice || undefined }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); errorToast(e.error ?? "Failed To Start Backup"); return; }
  const poll = setInterval(async () => {
    const st = (await (await fetch("/api/status")).json());
    const p = st.backupProgress;
    if (p && p.total) {
      $("#progressWrap").style.display = "";
      $("#progressBar").style.width = p.pct + "%";
      $("#progressPct").textContent = p.pct + "%";
      $("#progressCount").textContent = `${p.done.toLocaleString("en-US")} / ${p.total.toLocaleString("en-US")} Files`;
    }
    await refreshStatus();
    if (!st.syncing) {
      clearInterval(poll);
      $("#progressBar").style.width = "100%";
      setTimeout(() => { $("#progressWrap").style.display = "none"; }, 2500);
      loadGallery($("#search").value);
      notify("Backup Completed Successfully");
      toast("Backup Completed Successfully");
    }
  }, 1000);
}

// #15 notifikasi desktop (Web Notifications, graceful kalau ditolak/belum diizinkan)
function notify(msg) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") new Notification("NigiroCORE", { body: msg });
  else if (Notification.permission !== "denied") Notification.requestPermission();
}

async function startSync(filter = "all") {
  closeBackupDialog();
  const r = await fetch("/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); errorToast(e.error ?? "Failed To Start Backup"); return; }
  const poll = setInterval(async () => {
    await refreshStatus();
    if (!(await (await fetch("/api/status")).json()).syncing) {
      clearInterval(poll);
      $("#progressBar").style.width = "100%";
      setTimeout(() => { $("#progressBar").style.width = "100%"; $("#progressWrap").style.display = "none"; }, 2500);
      loadGallery($("#search").value);
      notify("Backup Completed Successfully");
      toast("Backup Completed Successfully");
    }
  }, 1000);
}

// ===== Dashboard =====
function dashGreeting() {
  const h = new Date().getHours();
  const g = h < 11 ? "Good Morning" : h < 15 ? "Good Afternoon" : h < 19 ? "Good Evening" : "Good Night";
  $("#dash-greeting").textContent = `${g}, LO — Here Is Your Server Summary.`;
}

async function loadStats() {
  dashGreeting();
  // cache device detail buat Backup Card (id · Authorized · Android · Battery)
  try {
    const st = await (await fetch("/api/adb-status")).json();
    const live = st.devices.filter(d => d.state === "device");
    window._adbInfo = live[0] ?? null;
    window._adbDevices = live;
    if (window._adbInfo) updateChip("dash", { device: { id: window._adbInfo.id, model: live.length > 1 ? live.length + " Devices Connected" : window._adbInfo.model }, syncing: false });
    // device baru colok → toast sekali per sesi kalau belum terdaftar di registry
    if (!window._knownSerials) window._knownSerials = new Set(live.map(d => d.id));
    else for (const d of live) if (!window._knownSerials.has(d.id)) {
      window._knownSerials.add(d.id);
      fetch("/api/devices").then(r => r.json()).then(reg => {
        if (!reg.some(x => x.serial === d.id)) toast("New Device Detected: " + (d.model || d.id) + " — Assign Profile In Settings", "new_smartphone");
      }).catch(() => {});
    }
  } catch { window._adbInfo = null; }
  loadDisk();
  loadServerInfo();
  startLivePolling();
  checkVolumeHealth();
  const s = await (await fetch("/api/stats")).json();
  const fmt = (n) => n > 1e9 ? (n / 1e9).toFixed(1) + " GB" : n > 1e6 ? (n / 1e6).toFixed(0) + " MB" : (n / 1e3).toFixed(0) + " KB";
  $("#stat-count").textContent = s.count.toLocaleString("en-US");
  $("#stat-size").textContent = fmt(s.size);
  $("#stat-photos").textContent = (s.photos ?? 0).toLocaleString("en-US");
  $("#stat-videos").textContent = (s.videos ?? 0).toLocaleString("en-US");
  const max = Math.max(...s.years.map(y => y.n), 1);
  $("#stat-years").innerHTML = s.years.length ? s.years.map(y => `
    <div class="year-row">
      <span class="year-label">${y.y}</span>
      <div class="year-bar-track"><div class="year-bar" style="width:${Math.max((y.n / max) * 100, 4)}%"></div></div>
      <span class="year-count">${y.n}</span>
    </div>`).join("") : '<p style="font-size:13px;color:var(--md-on-surface-variant)">No Data Yet.</p>';
  try {
    const h = await (await fetch("/api/history")).json();
    $("#history-list").innerHTML = h.history.length ? h.history.map(r => {
      const warn = r.files_failed > 0;
      const d = new Date(r.started_at * 1000);
      const when = d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
      const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      return `
      <div class="hist-item ${warn ? "warn" : "ok"}">
        <div class="hist-icon"><span class="msr" style="font-size:20px">${warn ? "warning" : "check_circle"}</span></div>
        <div style="flex:1;min-width:0">
          <div class="hist-title">${when} · ${time}</div>
          <div class="hist-sub">${r.device_id} — ${r.files_ok} files${r.files_failed ? `, ${r.files_failed} failed` : ""} · ${fmtSize(r.bytes)}</div>
        </div>
        <span class="hist-badge ${warn ? "warn" : "ok"}">${warn ? "Sebagian" : "Sukses"}</span>
      </div>`;
    }).join("") : '<div class="panel"><p style="font-size:13px;color:var(--md-on-surface-variant);margin:0">No Backup History Yet. Plug In Your Phone And Press <b>Backup Device</b> To Start.</p></div>';
  } catch {}
}

// ===== Gallery =====
const label = (k) => {
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  if (k === today) return "Today";
  if (k === yest) return "Yesterday";
  return new Date(k).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};

// ===== Gallery filter: type chips + year dropdown =====
const FILTERS = [
  { key: "all", label: "All", icon: "grid_view" },
  { key: "photos", label: "Photos", icon: "image" },
  { key: "videos", label: "Videos", icon: "movie" },
  { key: "favorites", label: "Favorites", icon: "favorite" },
];
let galleryFilter = "all";

function renderFilterChips() {
  // chips kiri dihapus — state filter ditunjukin di label tombol Filter
  const f = FILTERS.find(f => f.key === galleryFilter);
  const active = galleryFilter !== "all" || filterYear;
  $("#filterBtnLabel").textContent = active ? `Filter: ${f.label}${filterYear ? " " + filterYear : ""}` : "Filter";
  $("#filterBtn").style.background = active ? "var(--n-display)" : "";
  $("#filterBtn").style.color = active ? "var(--n-bg)" : "";
}

// ===== Filter dialog (year + type) =====
let filterYear = "";
function showFilterDialog() {
  const years = [...new Set(flat.map(f => new Date(f.mtime * 1000).getFullYear()))].sort((a, b) => b - a);
  const pill = (label, active, onclick) => `<button class="n-btn" style="padding:6px 14px;font-size:12px;${active ? "background:var(--n-display);color:var(--n-bg)" : ""}" onclick="${onclick}">${label}</button>`;
  $("#filterYears").innerHTML = pill("All", !filterYear, `pickFilterYear('')`) + years.map(y => pill(y, filterYear == y, `pickFilterYear('${y}')`)).join("");
  $("#filterTypes").innerHTML = FILTERS.filter(f => f.key !== "all").map(f => pill(f.label, galleryFilter === f.key, `setGalleryFilter('${f.key}')`)).join("");
  $("#filterDialog").style.display = "flex";
}
function closeFilterDialog() { $("#filterDialog").style.display = "none"; }
function pickFilterYear(y) {
  filterYear = y;
  renderFilterChips();
  closeFilterDialog();
  updateResetBtn();
  loadGallery($("#search").value);
}
function resetFilters() {
  galleryFilter = "all"; filterYear = "";
  renderFilterChips();
  $("#search").value = "";
  $("#resetFilterBtn").style.display = "none";
  loadGallery();
}
function updateResetBtn() {
  $("#resetFilterBtn").style.display = (galleryFilter !== "all" || filterYear || $("#search").value) ? "inline-flex" : "none";
}
// dipanggil dari onclick chip & popup type pills (function declaration biar global)
function setGalleryFilter(k) { galleryFilter = k; renderFilterChips(); updateResetBtn(); closeFilterDialog(); loadGallery($("#search").value); }

async function loadGallery(q = "") {
  const data = await (await fetch("/api/gallery")).json();
  cache = Object.fromEntries(Object.values(data).flat().map(f => [f.id, f]));
  flat = Object.values(cache).sort((a, b) => b.mtime - a.mtime);
  renderFilterChips();
  const g = $("#gallery");
  g.innerHTML = "";
  const dates = Object.keys(data).sort().reverse();
  $("#empty").style.display = dates.length ? "none" : "block";

  const query = q.trim().toLowerCase();
  let shown = 0;
  for (const date of dates) {
    let files = data[date];
    if (query) files = files.filter(f => f.original_name.toLowerCase().includes(query));
    if (galleryFilter === "photos") files = files.filter(f => f.mime?.startsWith("image/"));
    else if (galleryFilter === "videos") files = files.filter(f => f.mime?.startsWith("video/"));
    else if (galleryFilter === "favorites") files = files.filter(f => f.favorite === 1);
    if (filterYear) files = files.filter(f => new Date(f.mtime * 1000).getFullYear() == filterYear);
    if (!files.length) continue;
    shown += files.length;
    g.insertAdjacentHTML("beforeend",
      `<div class="date-header" data-year="${date.slice(0, 4)}">${label(date)}</div><div class="rows"></div>`);
    await justifiedRows(g.lastElementChild, files);
  }
  if (!shown && dates.length) g.innerHTML = query
    ? `<p style="text-align:center;color:var(--md-on-surface-variant);padding:60px 0">No Results For "${esc(q)}"</p>`
    : `<p style="text-align:center;color:var(--md-on-surface-variant);padding:60px 0">No Items Match This Filter.</p>`;
  updateResetBtn();
  buildScrubber("galleryScrubber", g);
}

// Videos view — galeri khusus video, layout sama dengan Photos
async function loadVideoGallery() {
  const data = await (await fetch("/api/gallery")).json();
  const videoData = {};
  for (const [date, files] of Object.entries(data)) {
    const vids = files.filter(f => f.mime?.startsWith("video/"));
    if (vids.length) videoData[date] = vids;
  }
  cache = Object.fromEntries(Object.values(data).flat().map(f => [f.id, f]));
  flat = Object.values(videoData).flat().sort((a, b) => b.mtime - a.mtime);
  const g = $("#videoGallery");
  g.innerHTML = "";
  const dates = Object.keys(videoData).sort().reverse();
  $("#videos-empty").style.display = dates.length ? "none" : "block";
  for (const date of dates) {
    g.insertAdjacentHTML("beforeend",
      `<div class="date-header" data-year="${date.slice(0, 4)}">${label(date)}</div><div class="rows"></div>`);
    await justifiedRows(g.lastElementChild, videoData[date]);
  }
  buildScrubber("videoScrubber", g);
}

// ===== Year scrubber (Google Photos style) =====
// Tahun di sisi kanan; tahun aktif ke-expand nunjukin bulan-bulannya, bisa diklik buat lompat.
function buildScrubber(scrubberId, galleryEl) {
  const sc = $(`#${scrubberId}`);
  sc.innerHTML = "";
  sc.classList.remove("show");
  const headers = [...galleryEl.querySelectorAll(".date-header")];
  if (headers.length < 2) return;
  const years = [...new Set(headers.map(h => h.dataset.year))].filter(Boolean);
  if (years.length < 2) return;
  sc.classList.add("show");
  // grup per tahun, bulan dari header (format "October 2026" → "Oct")
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  sc.innerHTML = years.map(y => {
    const seen = new Set();
    const months = headers.filter(h => h.dataset.year === y)
      .map(h => {
        const mName = h.textContent.split(" ")[0];
        if (seen.has(mName)) return "";
        seen.add(mName);
        const mIdx = ["January","February","March","April","May","June","July","August","September","October","November","December"].indexOf(mName);
        return `<button class="mo" data-year="${y}" data-month="${mName}" data-idx="${mIdx}">${MONTHS[mIdx] ?? mName.slice(0,3)}</button>`;
      }).join("");
    return `<div class="yr-group" data-year="${y}">
      <button class="yr" data-year="${y}">${y}</button>
      <div class="yr-months">${months}</div>
    </div>`;
  }).join("");
  sc.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      const y = btn.dataset.year;
      // header sticky — rect-nya nggak bisa dipercaya. Hitung dari .rows (non-sticky) di bawahnya.
      const rows = btn.classList.contains("mo")
        ? headers.find(h => h.dataset.year === y && h.textContent.startsWith(btn.dataset.month))?.nextElementSibling
        : headers.find(h => h.dataset.year === y)?.nextElementSibling;
      if (!rows) return;
      const yy = rows.getBoundingClientRect().top + window.scrollY - 110; // 70 topbar + ~40 tinggi header
      window.scrollTo({ top: yy, behavior: Math.abs(yy - window.scrollY) > 3000 ? "auto" : "smooth" });
      setTimeout(() => updateSpys(), Math.abs(yy - window.scrollY) > 3000 ? 100 : 600);
    };
  });
  // scroll-spy: highlight tahun yang lagi terlihat.
  // date-header itu sticky jadi rect-nya nggak bisa dipercaya — ukur dari .rows di bawahnya.
  scrollSpys = scrollSpys.filter(s => s.sc !== sc);
  scrollSpys.push({ sc, sections: headers.map(h => ({ year: h.dataset.year, el: h.nextElementSibling })) });
}

function updateSpys() {
  for (const { sc, sections } of scrollSpys) {
    let active = null;
    for (const s of sections) {
      if (s.el && s.el.getBoundingClientRect().top <= 160) active = s.year;
    }
    if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 5) {
      active = sections.at(-1)?.year ?? active;
    }
    // tahun aktif: highlight + expand bulannya; lainnya collapse
    sc.querySelectorAll(".yr-group").forEach(grp => {
      const is = grp.dataset.year === active;
      grp.classList.toggle("active", is);
      grp.querySelector(".yr").classList.toggle("active", is);
    });
  }
}

let scrollSpys = [];
let spyTick = false;
window.addEventListener("scroll", () => {
  if (spyTick) return;
  spyTick = true;
  requestAnimationFrame(() => {
    spyTick = false;
    updateSpys();
  });
}, { passive: true });

// Justified layout: baris se-tinggi, lebar proporsional rasio asli.
// ponytail: rasio diukur dari decoded image; simpan width/height di DB saat
// sync kalau mau render instan tanpa decode.
async function justifiedRows(container, files) {
  const TARGET = window.innerWidth < 640 ? 110 : 220;
  const GAP = 4;
  let row = [];

  const ratio = (f) => {
    const k = `r${f.id}`;
    if (cache[k] instanceof Promise) return cache[k];
    return (cache[k] = new Promise((res) => {
      // video: ambil rasio dari metadata (preload=metadata, murah — nggak download full file)
      if (f.mime.startsWith("video")) {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () => res(Math.max(0.4, (v.videoWidth || 16) / (v.videoHeight || 9)));
        v.onerror = () => res(1);
        v.src = `/media/${f.id}`;
        return;
      }
      const img = new Image();
      img.onload = () => res(Math.max(0.4, img.naturalWidth / img.naturalHeight));
      img.onerror = () => res(1);
      img.src = `/media/${f.id}/thumb`;
    }));
  };

  const flush = async () => {
    if (!row.length) return;
    const div = document.createElement("div");
    div.className = "photo-row";
    const ratios = await Promise.all(row.map(ratio));
    row.forEach((f, i) => {
      const el = document.createElement("div");
      el.className = "photo";
      el.style.flex = `${ratios[i]} 1 0`;
      el.style.height = TARGET + "px";
      // video: thumbnail = frame di detik ke-1 via video element preload=metadata (nggak download full)
      const thumb = f.mime.startsWith("video")
        ? `<video preload="metadata" muted src="/media/${f.id}#t=1"></video>`
        : `<img loading="lazy" src="/media/${f.id}/thumb" alt="">`;
      el.innerHTML = `${thumb}
        ${f.mime.startsWith("video") ? '<svg class="vid-badge" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>' : ""}`;
      el.onclick = () => openLB(f);
      div.append(el);
    });
    container.append(div);
    row = [];
  };

  let sum = 0;
  for (const f of files) {
    row.push(f);
    sum += await ratio(f);
    if (sum * TARGET >= (window.innerWidth - 260) * 1.02) { await flush(); sum = 0; }
  }
  await flush();
}

// ===== Lightbox =====
let lbZoom = 1, lbFile = null, lbPan = { x: 0, y: 0 }, lbDrag = null;

function openLB(f) {
  $("#lightbox").classList.add("open");
  $("#lightbox").dataset.current = f.id;
  lbFile = f;
  lbZoom = 1;
  applyZoom();
  $("#lb-info").style.display = "none";
  $("#lb-info-btn").textContent = "info";
  $("#lb-fav").textContent = f.favorite ? "favorite" : "favorite_border";
  $("#lb-fav").style.color = f.favorite ? "#ea4335" : "";
  $("#lb-arch").textContent = f.archived ? "unarchive" : "archive";
  show(f);
}

// buka lightbox dari search result (fetch file info dulu)
async function openMediaById(id) {
  $("#searchResults").style.display = "none";
  $("#search").value = "";
  try {
    const f = await (await fetch(`/api/file/${id}`)).json();
    if (f.id) {
      // dari view lain (maps, docs, dst): tetap di view itu — cukup buka lightbox di atasnya
      if (document.querySelector("#view-photos")?.offsetParent === null) openLB(f);
      else { showView("photos"); openLB(f); }
    }
  } catch {}
}

// clamp pan: gambar tidak boleh tergeser melebihi tepinya (viewport selalu menempel gambar)
function clampPan() {
  const img = $("#lb-img");
  if (!img || lbZoom <= 1) { lbPan = { x: 0, y: 0 }; return; }
  const stage = $("#lb-stage").getBoundingClientRect();
  const maxX = Math.max(0, (img.offsetWidth * lbZoom - stage.width) / 2);
  const maxY = Math.max(0, (img.offsetHeight * lbZoom - stage.height) / 2);
  lbPan.x = Math.max(-maxX, Math.min(maxX, lbPan.x));
  lbPan.y = Math.max(-maxY, Math.min(maxY, lbPan.y));
}
function applyZoom() {
  clampPan();
  const el = $("#lb-img");
  el.style.transform = `translate(${lbPan.x}px, ${lbPan.y}px) scale(${lbZoom})`;
  // zoom mode: pan aktif, klik antar-foto dimatikan
  el.style.cursor = lbZoom > 1 ? "grab" : "default";
  $("#lb-zoom-btn").textContent = lbZoom > 1 ? "zoom_out" : "zoom_in";
  updateMinimap();
}

// ===== Zoom Navigator (minimap + viewport box + slider) =====
function updateMinimap() {
  const panel = $("#lb-minimap"), img = $("#lb-img"), mm = $("#mm-img"), box = $("#mm-box");
  if (!panel) return;
  if (lbZoom <= 1 || !lbFile || lbFile.mime?.startsWith("video")) { panel.style.display = "none"; return; }
  if (mm.getAttribute("src") !== `/media/${lbFile.id}`) mm.src = `/media/${lbFile.id}`;
  panel.style.display = "block";
  // geometri: gambar fit di stage, transform-origin center
  const stage = $("#lb-stage").getBoundingClientRect();
  const ir = img.getBoundingClientRect(); // ukuran TAMPILAN gambar saat ini (sudah termasuk scale? tidak — getBoundingClientRect termasuk transform!)
  // pakai ukuran dasar: untransform via offsetWidth/Height (layout, tanpa transform)
  const bw = img.offsetWidth, bh = img.offsetHeight;
  const shownW = bw * lbZoom, shownH = bh * lbZoom;
  // viewport terlihat = area stage dalam koordinat gambar dasar
  const viewW = Math.min(bw, stage.width / lbZoom), viewH = Math.min(bh, stage.height / lbZoom);
  const offX = (shownW - stage.width) / 2 - lbPan.x, offY = (shownH - stage.height) / 2 - lbPan.y;
  // posisi viewport (kiri-atas) dalam koordinat dasar gambar
  const vx = Math.max(0, Math.min(bw - viewW, offX / lbZoom));
  const vy = Math.max(0, Math.min(bh - viewH, offY / lbZoom));
  const mmRect = mm.getBoundingClientRect();
  if (!mmRect.width) return;
  const sx = mmRect.width / bw, sy = mmRect.height / bh;
  box.style.left = vx * sx + "px";
  box.style.top = vy * sy + "px";
  box.style.width = viewW * sx + "px";
  box.style.height = viewH * sy + "px";
  // slider ikut
  $("#mm-slider").value = lbZoom;
}
// drag viewport box di minimap → pan gambar utama
(function () {
  const box = $("#mm-box"), mm = $("#mm-img");
  let drag = null;
  box.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    drag = { sx: e.clientX, sy: e.clientY, ox: lbPan.x, oy: lbPan.y };
    box.setPointerCapture(e.pointerId);
  });
  box.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const mmRect = mm.getBoundingClientRect();
    const img = $("#lb-img");
    const sx = mmRect.width / img.offsetWidth, sy = mmRect.height / img.offsetHeight;
    // gerak box di minimap (px minimap) → px gambar dasar → px layar (× zoom)
    lbPan.x = drag.ox - ((e.clientX - drag.sx) / sx) * lbZoom;
    lbPan.y = drag.oy - ((e.clientY - drag.sy) / sy) * lbZoom;
    applyZoom();
  });
  box.addEventListener("pointerup", () => { drag = null; });
  box.addEventListener("pointercancel", () => { drag = null; });
  box.addEventListener("pointerleave", () => { drag = null; });
})();
function mmZoomStep(d) {
  lbZoom = Math.min(5, Math.max(1, lbZoom + d));
  if (lbZoom <= 1) lbPan = { x: 0, y: 0 };
  applyZoom();
}
document.getElementById("mm-slider").addEventListener("input", (e) => {
  lbZoom = parseFloat(e.target.value);
  if (lbZoom <= 1) lbPan = { x: 0, y: 0 };
  applyZoom();
});

// ===== Zoom mode: toggle via tombol di topbar. Aktif = pan drag + wheel zoom. =====
function toggleZoomMode() {
  if (lbZoom > 1) { lbZoom = 1; lbPan = { x: 0, y: 0 }; }
  else lbZoom = 2.5;
  applyZoom();
}

const stage = $("#lb-stage");
// pan: hold & drag, release = berhenti. Release di luar stage / pointercancel juga bersih.
function endPan() {
  lbDrag = null;
  if ($("#lb-img")) $("#lb-img").style.cursor = lbZoom > 1 ? "grab" : "default";
}
stage.addEventListener("pointerdown", (e) => {
  if (e.target.id !== "lb-img" || lbZoom <= 1) return;
  e.preventDefault();
  lbDrag = { sx: e.clientX, sy: e.clientY, ox: lbPan.x, oy: lbPan.y };
  $("#lb-img").style.cursor = "grabbing";
});
stage.addEventListener("pointermove", (e) => {
  if (!lbDrag) return;
  lbPan.x = lbDrag.ox + (e.clientX - lbDrag.sx);
  lbPan.y = lbDrag.oy + (e.clientY - lbDrag.sy);
  applyZoom();
});
stage.addEventListener("pointerup", endPan);
stage.addEventListener("pointercancel", endPan);
stage.addEventListener("pointerleave", endPan);
window.addEventListener("blur", endPan);

function toggleInfo() {
  const panel = $("#lb-info");
  const open = panel.style.display !== "none";
  panel.style.display = open ? "none" : "block";
  $("#lb-info-btn").textContent = open ? "info" : "info";
  if (!open && lbFile) {
    $("#lb-info-body").innerHTML = '<span style="color:#9aa0a6">Loading…</span>';
    fetch(`/api/file/${lbFile.id}`).then(r => r.json()).then(f => {
      const d = new Date((f.mtime ?? 0) * 1000);
      const rows = [
        ["Name", f.original_name],
        ["Type", f.mime],
        ["Size", fmtSize(f.size)],
        ["Date", isNaN(d) ? "—" : d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })],
        ["Time", isNaN(d) ? "—" : d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })],
        ["Backed Up", new Date(f.synced_at * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })],
        ["Source", f.device_path],
        ...(f.place ? [["Location", f.place]] : []),
        ...(f.width ? [["Dimensions", `${f.width} × ${f.height}`]] : []),
        ["Favorite", f.favorite ? "Yes" : "No"],
      ];
      $("#lb-info-body").innerHTML = rows.map(([k, v]) =>
        `<div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid #333">
          <span style="width:90px;color:#9aa0a6;flex-shrink:0">${k}</span>
          <span style="word-break:break-all">${v}</span>
        </div>`).join("");
    });
  }
}

async function toggleFav() {
  if (!lbFile) return;
  const r = await (await fetch(`/api/favorite/${lbFile.id}`, { method: "POST" })).json();
  lbFile.favorite = r.favorite;
  $("#lb-fav").textContent = r.favorite ? "favorite" : "favorite_border";
  $("#lb-fav").style.color = r.favorite ? "#ea4335" : "";
  toast(r.favorite ? "Added To Favorites" : "Removed From Favorites", "favorite");
  // refresh view di belakang lightbox biar realtime
  const v = document.querySelector("[data-nav].active")?.dataset.nav;
  if (v === "favorites") loadFavorites();
  else if (v === "photos") loadGallery($("#search").value);
  else if (v === "videos") loadVideoGallery();
}

async function archiveCurrent() {
  if (!lbFile) return;
  const r = await (await fetch(`/api/archive/${lbFile.id}`, { method: "POST" })).json();
  lbFile.archived = r.archived;
  $("#lb-arch").textContent = r.archived ? "unarchive" : "archive";
  toast(r.archived ? "Archived" : "Unarchived", "archive");
  // refresh view di belakang — archive/unarchive ngubah isi gallery & archive view
  const v = document.querySelector("[data-nav].active")?.dataset.nav;
  if (v === "archive") loadArchive();
  else if (v === "photos") loadGallery($("#search").value);
  else if (v === "favorites") loadFavorites();
  else if (v === "videos") loadVideoGallery();
}

async function lbTrash() {
  if (!lbFile) return;
  const name = lbFile.original_name;
  showConfirmDialog("Move To Trash", `Move "${name}" To Trash? You Can Restore It Later.`, async () => {
    closeConfirmDialog();
    const r = await (await fetch(`/api/media-trash/${lbFile.id}`, { method: "POST" })).json();
    if (r.error) return errorToast(r.error);
    toast(`Moved To Trash: ${name}`, "delete");
    closeLB();
    // refresh view di belakang — file ilang dari semua view media
    const v = document.querySelector("[data-nav].active")?.dataset.nav;
    if (v === "favorites") loadFavorites();
    else if (v === "videos") loadVideoGallery();
    else if (v === "archive") loadArchive();
    else loadGallery($("#search").value);
  });
}

// zoom: wheel zoom hanya saat zoom mode aktif (via tombol)
$("#lb-stage")?.addEventListener("wheel", (e) => {
  if (!$("#lb-img").style.display || $("#lb-img").style.display === "none") return; // video skip
  if (lbZoom <= 1) return; // zoom mode off — biarkan halaman normal
  e.preventDefault();
  lbZoom = Math.min(5, Math.max(1, lbZoom + (e.deltaY < 0 ? 0.25 : -0.25)));
  if (lbZoom <= 1) lbPan = { x: 0, y: 0 };
  applyZoom();
}, { passive: false });

function show(f) {
  $("#lb-name").textContent = f.original_name;
  $("#lb-download").href = `/media/${f.id}`;
  lbFile = f;
  lbZoom = 1;
  lbPan = { x: 0, y: 0 };
  applyZoom();
  // zoom button cuma untuk foto
  $("#lb-zoom-btn").parentElement.style.display = f.mime.startsWith("video") ? "none" : "";
  $("#lb-fav").textContent = f.favorite ? "favorite" : "favorite_border";
  $("#lb-fav").style.color = f.favorite ? "#ea4335" : "";
  const isVid = f.mime.startsWith("video");
  $("#lb-img").style.display = isVid ? "none" : "";
  $("#lb-vid").style.display = isVid ? "" : "none";
  (isVid ? $("#lb-vid") : $("#lb-img")).src = `/media/${f.id}`;
}

function nav(dir) {
  const i = flat.findIndex(x => x.id === Number($("#lightbox").dataset.current));
  const next = flat[i + dir];
  if (next) { $("#lightbox").dataset.current = next.id; show(next); }
}

function closeLB() {
  $("#lightbox").classList.remove("open");
  $("#lb-vid").pause?.();
}

document.addEventListener("keydown", (e) => {
  // "/" fokus search (kalau nggak sedang ngetik)
  if (e.key === "/" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)) {
    e.preventDefault();
    $("#search").focus();
    return;
  }
  if (!$("#filePreview").classList.contains("open") && $("#filePreview").style.display === "flex") {
    if (e.key === "Escape") { closePreview(); return; }
    return;
  }
  if ($("#toolDialog").style.display === "flex" && e.key === "Escape") { closeToolDialog(); return; }
  if (!$("#lightbox").classList.contains("open")) return;
  if (e.key === "Escape") closeLB();
  if (e.key === "ArrowRight") nav(1);
  if (e.key === "ArrowLeft") nav(-1);
});

// ===== Toast notification =====
// error toast (pengganti alert() — aturan: never Chrome alert())
function errorToast(msg) { toast(msg, "error"); }
function toast(msg, icon = "check_circle") {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    t.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--n-display);color:var(--n-bg);padding:12px 20px;border-radius:8px;font-family:var(--n-f-mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;font-weight:500;display:flex;align-items:center;gap:10px;box-shadow:none;z-index:500;transition:transform .3s var(--ease-emph),opacity .3s;opacity:0;max-width:min(480px,90vw)";
    document.body.appendChild(t);
  }
  t.innerHTML = `<span class="msr" style="font-size:20px">${icon}</span><span>${msg}</span>`;
  setTimeout(() => {
    t.style.transform = "translateX(-50%) translateY(0)";
    t.style.opacity = "1";
  }, 20);
  clearTimeout(t._hide);
  t._hide = setTimeout(() => {
    t.style.transform = "translateX(-50%) translateY(80px)";
    t.style.opacity = "0";
  }, 3500);
}

$("#search").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  if ($("#view-photos").style.display !== "none" && !q) return loadGallery("");
  if (q.length < 2) { $("#searchResults").style.display = "none"; return; }
  clearTimeout(window.__searchT);
  window.__searchT = setTimeout(() => globalSearch(q), 250);
});

// anti-autofill Chrome: readonly saat blur = Chrome gak nawarin kredensial; hilangkan saat focus biar bisa ngetik
$("#search").addEventListener("focus", () => $("#search").removeAttribute("readonly"));
$("#search").addEventListener("blur", () => { if (!$("#search").value) $("#search").setAttribute("readonly", "readonly"); });

async function globalSearch(q) {
  const box = $("#searchResults");
  try {
    const r = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json();
    const vaultHtml = r.vault?.length ? `
      <div style="padding:6px 16px;font-size:10px;font-weight:600;letter-spacing:.5px;color:var(--md-on-surface-variant);text-transform:uppercase">Vault</div>
      ${r.vault.map(f => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer" onmouseover="this.style.background='var(--md-surface-container)'" onmouseout="this.style.background=''" onclick="openMediaById(${f.id})">
          <img src="/media/${f.id}/thumb" style="width:36px;height:36px;object-fit:cover;border-radius:8px" onerror="this.style.visibility='hidden'">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</div>
            ${f.place ? `<div style="font-size:11px;color:var(--md-on-surface-variant)"><span class="msr" style="font-size:12px;vertical-align:-2px">location_on</span> ${esc(f.place)}</div>` : ""}
          </div>
          <span style="font-size:11px;color:var(--md-on-surface-variant)">${fmtSize(f.size)}</span>
        </div>`).join("")}` : "";
    if (!r.results.length && !r.vault?.length) {
      box.innerHTML = '<p style="padding:10px 16px;color:var(--md-on-surface-variant);font-size:13px">No Results.</p>';
    } else {
      const filesHtml = r.results.slice(0, 25).map(f => {
        const pathEsc = f.path.replace(/'/g, "\\'");
        return `<div style="display:flex;align-items:center;gap:10px;padding:8px 16px;cursor:pointer" onmouseover="this.style.background='var(--md-surface-container)'" onmouseout="this.style.background=''" onclick="pickSearchResult('${pathEsc}')">
          <span class="msr" style="color:var(--md-primary);font-size:20px">${iconFor({ name: f.name, isDir: false })}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</div>
            <div style="font-size:11px;color:var(--md-on-surface-variant);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.path)}</div>
          </div>
          <span style="font-size:11px;color:var(--md-on-surface-variant)">${fmtSize(f.size)}</span>
        </div>`;
      }).join("") + (r.results.length > 25 ? `<p style="padding:8px 16px;font-size:11px;color:var(--md-on-surface-variant)">… +${r.results.length - 25} More</p>` : "");
      box.innerHTML = vaultHtml + (r.results.length ? `<div style="padding:6px 16px;font-size:10px;font-weight:600;letter-spacing:.5px;color:var(--md-on-surface-variant);text-transform:uppercase">Files</div>` + filesHtml : "");
    }
    box.style.display = "block";
  } catch { box.style.display = "none"; }
}

function pickSearchResult(p) {
  $("#searchResults").style.display = "none";
  $("#search").value = "";
  showView("files");
  openPreview(p);
}

document.addEventListener("click", (e) => {
  if (!e.target.closest("#search") && !e.target.closest("#searchResults")) $("#searchResults").style.display = "none";
});

// ===== File Explorer (browse HDD / hasil backup) =====
let currentDir = "";
let fileEntries = [];
let fileView = "details";
// selection & clipboard state (pola clipboard store filebrowser, versi minimal)
let selPaths = new Set();
let lastClicked = null; // untuk shift+click range
let clip = null; // { mode: "copy"|"cut", paths: [...] }

const ICONS = [
  [/\.jpe?g$|\.png$|\.webp$|\.gif$|\.heic$/i, "image"],
  [/\.mp4$|\.mkv$|\.webm$|\.mov$/i, "movie"],
  [/\.mp3$|\.wav$|\.ogg$/i, "music_note"],
  [/\.pdf$/i, "picture_as_pdf"],
  [/\.zip$|\.rar$|\.7z$/i, "folder_zip"],
  [/\.docx?$|\.odt$/i, "description"],
  [/\.xlsx?$|\.csv$/i, "table_chart"],
  [/\.pptx?$/i, "slideshow"],
  [/\.apk$/i, "android"],
  [/\.txt$/i, "article"],
];

function iconFor(e) {
  if (e.isDir) return "folder";
  for (const [re, icon] of ICONS) if (re.test(e.name)) return icon;
  return "draft";
}

const fmtSize = (n) => !n ? "—" : n > 1e9 ? (n/1e9).toFixed(1)+" GB" : n > 1e6 ? (n/1e6).toFixed(1)+" MB" : n > 1e3 ? (n/1e3).toFixed(0)+" KB" : n+" B";

async function browse(dir = "") {
  currentDir = dir;
  selPaths.clear(); lastClicked = null;
  const list = $("#fileList");
  list.innerHTML = '<p style="color:var(--md-on-surface-variant);padding:20px 12px">Loading…</p>';
  try {
    const r = await (await fetch(`/api/browse?path=${encodeURIComponent(dir)}`)).json();
    if (r.error) { list.innerHTML = `<p style="color:var(--md-error);padding:20px 12px">${r.error}</p>`; return; }
    fileEntries = r.entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    renderCrumbs();
    renderFiles();
  } catch (e) {
    list.innerHTML = `<p style="color:var(--md-error);padding:20px 12px">${e.message}</p>`;
  }
}

function renderCrumbs() {
  // root crumb = nama profil aktif (mirrors E:\NigiroCORE_Data\profile\<Name>)
  const prof = profilesCache?.find(p => p.id === activeProfileId)?.name ?? "My Backup";
  let html = `<button class="crumb" onclick="browse('')">${prof}</button>`;
  let acc = "";
  for (const p of currentDir.split("/").filter(Boolean)) {
    acc += (acc ? "/" : "") + p;
    html += `<span class="crumb-sep">/</span><button class="crumb" onclick="browse('${acc}')">${p}</button>`;
  }
  $("#crumbs").innerHTML = html;
}

function visibleEntries() {
  const sort = $("#sortSel")?.value ?? "name";
  const filter = $("#filterSel")?.value ?? "all";
  let items = [...fileEntries];
  if (filter !== "all") {
    items = items.filter(e => {
      if (e.isDir) return true;
      const ext = e.name.toLowerCase().split(".").pop();
      if (filter === "img") return ["jpg","jpeg","png","webp","gif","heic","bmp"].includes(ext);
      if (filter === "vid") return ["mp4","webm","mkv","mov","avi"].includes(ext);
      if (filter === "doc") return ["pdf","doc","docx","txt","csv","md","json","xlsx","pptx","odt"].includes(ext);
      return true;
    });
  }
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (sort === "size") return b.size - a.size;
    if (sort === "date") return (b.mtime ?? 0) - (a.mtime ?? 0);
    return a.name.localeCompare(b.name);
  });
  return items;
}

function renderFiles() {
  updateSelBar();
  const list = $("#fileList");
  const items = visibleEntries();
  if (!items.length) {
    list.innerHTML = '<p style="color:var(--md-on-surface-variant);padding:20px 12px">' + (fileEntries.length ? "No Files Match This Filter." : "Folder Is Empty.") + '</p>';
    return;
  }
  if (fileView === "details") {
    list.className = "file-list";
    list.innerHTML = `<div class="frow fhead" style="user-select:none">
      <span class="msr" style="visibility:hidden">folder</span>
      <span class="fname fsort" data-sort="name">Name</span>
      <span class="fmeta fsort" data-sort="size">Size</span>
      <span class="fmeta fsort" data-sort="date">Date Modified</span>
      <span style="width:32px"></span></div>` + items.map(e => {
      const q = esc(e.path);
      return `<div class="frow${selPaths.has(e.path) ? " selected" : ""}" data-path="${q}" data-dir="${e.isDir ? 1 : 0}">
        <span class="msr" style="color:${e.isDir ? "var(--n-secondary)" : "var(--md-on-surface-variant)"}">${iconFor(e)}</span>
        <span class="fname">${esc(e.name)}</span>
        <span class="fmeta">${e.isDir ? "—" : fmtSize(e.size)}</span>
        <span class="fmeta">${e.mtime ? new Date(e.mtime * 1000).toLocaleDateString("en-US") : ""}</span>
        <button class="icon-btn" title="Move To Trash" style="width:32px;height:32px" onclick="event.stopPropagation();fmDelete(['${q}'])"><span class="msr" style="font-size:18px">delete</span></button>
      </div>`;
    }).join("");
  } else {
    list.className = "file-grid";
    list.innerHTML = items.map(e => {
      const q = esc(e.path);
      return `<div class="fcard${selPaths.has(e.path) ? " selected" : ""}" data-path="${q}" data-dir="${e.isDir ? 1 : 0}">
        <span class="msr" style="color:${e.isDir ? "var(--n-secondary)" : "var(--md-on-surface-variant)"}">${iconFor(e)}</span>
        <span class="fname">${esc(e.name)}</span>
        <span class="fmeta">${e.isDir ? "Folder" : fmtSize(e.size)}</span>
      </div>`;
    }).join("");
  }
}

// ===== Explorer: selection, context menu, keyboard, clipboard =====
const entryByPath = (p) => fileEntries.find(e => e.path === p);

function fmClick(e, el) {
  const p = el.dataset.path;
  const isDir = el.dataset.dir === "1";
  if (e.shiftKey && lastClicked) {
    // shift+click: range dari lastClicked ke item ini (urutan visible)
    const items = visibleEntries().map(x => x.path);
    const i1 = items.indexOf(lastClicked), i2 = items.indexOf(p);
    if (i1 >= 0 && i2 >= 0) for (let i = Math.min(i1, i2); i <= Math.max(i1, i2); i++) selPaths.add(items[i]);
  } else if (e.ctrlKey || e.metaKey) {
    selPaths.has(p) ? selPaths.delete(p) : selPaths.add(p);
    lastClicked = p;
  } else {
    selPaths.clear(); selPaths.add(p);
    lastClicked = p;
  }
  // update class langsung (bukan renderFiles) — re-render mendetach elemen sebelum dblclick fire → folder gak bisa dibuka
  for (const el2 of fileListEl().querySelectorAll(".frow[data-path], .fcard[data-path]"))
    el2.classList.toggle("selected", selPaths.has(el2.dataset.path));
  updateSelBar();
}

function fmDblClick(el) {
  const p = el.dataset.path;
  if (el.dataset.dir === "1") browse(p);
  else openPreview(p);
}

// rubber band (marquee) selection — kotak translucent merah, drag di area kosong fileList
// rubber band (marquee) selection — DIMATIKAN (banyak konflik klik/dblclick di produksi).
// Kode dikeluarkan; seleksi cukup via klik/Ctrl+click/Shift+click/Ctrl+A/context menu.
// Kalau mau diaktifkan lagi: restore dari git history (commit sebelum "matikan rubber band").
let rubber = null; // { x0, y0, el }
const fileListEl = () => $("#fileList");

function fmClearSel() { selPaths.clear(); renderFiles(); }

// selection bar: update tampilan tiap render
function updateSelBar() {
  const bar = $("#selBar");
  if (!bar) return;
  if (!selPaths.size) { bar.style.display = "none"; return; }
  bar.style.display = "flex";
  $("#selCount").textContent = `${selPaths.size} Selected`;
  // paste hanya aktif kalau clipboard ada
  $("#selPaste").style.opacity = clip ? "1" : ".35";
}

function fmSelectAll() { visibleEntries().forEach(e => selPaths.add(e.path)); renderFiles(); }

// context menu — satu elemen global, diisi per konteks
function openCtxMenu(x, y, items) {
  let m = $("#ctxMenu");
  if (!m) {
    m = document.createElement("div");
    m.id = "ctxMenu";
    m.style.cssText = "position:fixed;z-index:600;background:var(--n-bg);border:1px solid var(--n-line);border-radius:10px;padding:6px;min-width:180px;box-shadow:0 8px 32px rgba(0,0,0,.25);display:none";
    document.body.appendChild(m);
    document.addEventListener("click", () => m.style.display = "none");
    document.addEventListener("scroll", () => m.style.display = "none", true);
  }
  m.innerHTML = items.map(i =>
    `<button style="display:flex;align-items:center;gap:10px;width:100%;padding:8px 12px;border:none;background:transparent;color:var(--md-on-surface);font-family:inherit;font-size:13px;border-radius:6px;cursor:pointer;text-align:left" onmouseover="this.style.background='var(--n-raised)'" onmouseout="this.style.background='transparent'" onclick="(${i.fn})()">
      <span class="msr" style="font-size:18px;color:var(--md-on-surface-variant)">${i.icon}</span>${i.label}</button>`).join("");
  m.style.display = "block";
  // posisi: jangan keluar viewport
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
}

function fmItemMenu(e, el) {
  e.preventDefault(); e.stopPropagation();
  const p = el.dataset.path;
  if (!selPaths.has(p)) { selPaths.clear(); selPaths.add(p); lastClicked = p; renderFiles(); }
  const targets = [...selPaths];
  const many = targets.length > 1;
  openCtxMenu(e.clientX, e.clientY, [
    ...(!many ? [{ label: "Open", icon: "open_in_new", fn: `() => { const el = document.querySelector('[data-path="${esc(p)}"]'); el.dataset.dir === "1" ? browse('${esc(p)}') : openPreview('${esc(p)}'); }` }] : []),
    { label: "Rename", icon: "edit", fn: `() => fmRename('${esc(p)}')` },
    { label: "Copy", icon: "content_copy", fn: `() => fmClip('copy', ${JSON.stringify(targets).replace(/"/g, "&quot;")})` },
    { label: "Cut", icon: "content_cut", fn: `() => fmClip('cut', ${JSON.stringify(targets).replace(/"/g, "&quot;")})` },
    { label: `Delete${many ? ` (${targets.length})` : ""}`, icon: "delete", fn: `() => fmDelete(${JSON.stringify(targets).replace(/"/g, "&quot;")})` },
    { label: "Download", icon: "download", fn: `() => { location.href = '/api/rawfile?path=${encodeURIComponent(p)}'; }` },
  ]);
}

function fmEmptyMenu(e) {
  e.preventDefault();
  openCtxMenu(e.clientX, e.clientY, [
    { label: "New Folder", icon: "create_new_folder", fn: "() => fmMkdir()" },
    { label: "Paste", icon: "content_paste", fn: "() => fmPaste()" },
    { label: "Select All", icon: "select_all", fn: "() => fmSelectAll()" },
    { label: "Refresh", icon: "refresh", fn: "() => browse(currentDir)" },
  ]);
}

async function fmRename(p) {
  const entry = entryByPath(p);
  if (!entry) return;
  // inline rename: ganti nama jadi input di row/card
  const el = document.querySelector(`[data-path="${CSS.escape(p)}"] .fname`);
  if (!el) return;
  const old = el.textContent;
  el.innerHTML = `<input value="${esc(old)}" style="width:100%;font:inherit;padding:2px 6px;border:1px solid var(--n-accent,#D71921);border-radius:4px;background:var(--n-bg);color:var(--n-display)" id="fmRenameInput">`;
  const input = $("#fmRenameInput");
  input.focus(); input.select();
  const commit = async () => {
    const name = input.value.trim();
    el.textContent = old; // restore dulu
    if (!name || name === old) return renderFiles();
    const r = await (await fetch("/api/fm/rename", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p, name }) })).json();
    if (r.error) errorToast(r.error); else toast(`Renamed To ${name}`, "edit");
    browse(currentDir);
  };
  input.onkeydown = (ev) => {
    if (ev.key === "Enter") commit();
    else if (ev.key === "Escape") { el.textContent = old; }
  };
  input.onblur = commit;
}

function fmClip(mode, paths) { clip = { mode, paths }; toast(`${mode === "cut" ? "Cut" : "Copied"} ${paths.length} Item${paths.length > 1 ? "s" : ""}`, "content_paste"); }

async function fmPaste() {
  if (!clip?.paths?.length) return;
  const r = await (await fetch("/api/fm/transfer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: clip.paths, dest: currentDir, mode: clip.mode }) })).json();
  if (r.error) return errorToast(r.error);
  if (r.failed) errorToast(`${r.done} Done, ${r.failed} Failed${r.error ? " — " + r.error : ""}`);
  else toast(`${clip.mode === "cut" ? "Moved" : "Copied"} ${r.done} Item${r.done > 1 ? "s" : ""}`, "check_circle");
  if (clip.mode === "cut") clip = null;
  browse(currentDir);
}

// konfirmasi delete multi pakai dialog M3 custom
function fmDelete(paths) {
  const names = paths.map(p => p.split("/").pop());
  $("#td-icon").textContent = "delete_forever";
  $("#td-title").textContent = paths.length > 1 ? `Move ${paths.length} Items To Trash?` : "Move To Trash?";
  $("#td-body").innerHTML = `
    <p style="margin:0 0 6px"><b>${esc(names.slice(0, 3).join(", "))}${names.length > 3 ? `, +${names.length - 3} more` : ""}</b> will be moved to Trash (can be restored).</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button class="crumb" onclick="closeToolDialog()">Cancel</button>
      <button class="sync-btn" style="background:var(--md-error,#d93025)" onclick="doFmDelete(${JSON.stringify(paths).replace(/"/g, "&quot;")})">Move To Trash</button>
    </div>`;
  $("#toolDialog").style.display = "flex";
}

async function doFmDelete(paths) {
  closeToolDialog();
  const r = await (await fetch("/api/fm/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) })).json();
  if (r.error) return errorToast(r.error);
  if (r.failed) errorToast(`${r.done} Moved, ${r.failed} Failed`);
  else toast(`Moved ${r.done} Item${r.done > 1 ? "s" : ""} To Trash`, "delete");
  selPaths.clear();
  browse(currentDir);
}

function fmMkdir() {
  // folder baru: langsung inline di list atas
  const name = "New Folder";
  fetch("/api/fm/mkdir", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: (currentDir ? currentDir + "/" : "") + name }) })
    .then(r => r.json())
    .then(async (r) => {
      if (r.error) return errorToast(r.error);
      await browse(currentDir);
      // rename inline langsung biar user bisa ganti nama
      setTimeout(() => fmRename((currentDir ? currentDir + "/" : "") + name), 100);
    });
}

// wiring tombol selection bar
document.addEventListener("click", (e) => {
  const bar = e.target.closest("#selBar");
  if (!bar) return;
  const targets = [...selPaths];
  if (e.target.closest("#selCopy")) fmClip("copy", targets);
  else if (e.target.closest("#selCut")) fmClip("cut", targets);
  else if (e.target.closest("#selPaste")) fmPaste();
  else if (e.target.closest("#selDelete")) fmDelete(targets);
  else if (e.target.closest("#selDownload")) {
    if (!targets.length) return;
    location.href = "/api/fm/zip?paths=" + targets.map(encodeURIComponent).join(",");
    toast(`Preparing ZIP Of ${targets.length} Item${targets.length > 1 ? "s" : ""}…`, "download");
  }
  else if (e.target.closest("#selCancel")) fmClearSel();
});

// keyboard navigation di Files view
document.addEventListener("keydown", (e) => {
  if ($("#view-files").style.display === "none" || (e.target instanceof Element && e.target.matches("input, textarea, select"))) return;
  const items = visibleEntries();
  if (e.key === "F2" && selPaths.size === 1) fmRename([...selPaths][0]);
  else if (e.key === "Delete" && selPaths.size) fmDelete([...selPaths]);
  else if (e.key === "a" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fmSelectAll(); }
  else if (e.key === "c" && (e.ctrlKey || e.metaKey) && selPaths.size) fmClip("copy", [...selPaths]);
  else if (e.key === "x" && (e.ctrlKey || e.metaKey) && selPaths.size) fmClip("cut", [...selPaths]);
  else if (e.key === "v" && (e.ctrlKey || e.metaKey)) fmPaste();
  else if (e.key === "Escape") fmClearSel();
  else if (e.key === "Enter" && selPaths.size === 1) { const el = document.querySelector(`[data-path="${CSS.escape([...selPaths][0])}"]`); if (el) fmDblClick(el); }
  else if (["ArrowDown", "ArrowUp"].includes(e.key) && items.length) {
    e.preventDefault();
    const idx = lastClicked ? items.findIndex(x => x.path === lastClicked) : -1;
    const next = items[Math.max(0, Math.min(items.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)))];
    if (!e.shiftKey) selPaths.clear();
    selPaths.add(next.path); lastClicked = next.path;
    renderFiles();
    document.querySelector(`[data-path="${CSS.escape(next.path)}"]`)?.scrollIntoView({ block: "nearest" });
  }
});

// konfirmasi delete pakai dialog M3, bukan confirm() Chrome
function confirmTrash(p) {
  const name = p.split("/").pop();
  $("#td-icon").textContent = "delete_forever";
  $("#td-title").textContent = "Move To Trash?";
  $("#td-body").innerHTML = `
    <p style="margin:0 0 6px"><b>${name}</b> will be moved to Trash (can be restored).</p>
    <p style="margin:0 0 16px;font-size:12px;color:var(--md-on-surface-variant)">${p}</p>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="crumb" onclick="closeToolDialog()">Cancel</button>
      <button class="sync-btn" style="background:var(--md-error,#d93025)" onclick="doTrash('${p.replace(/'/g, "\\'")}')">Move To Trash</button>
    </div>`;
  $("#toolDialog").style.display = "flex";
}

async function doTrash(p) {
  closeToolDialog();
  await trashFile(p);
}

// ===== Trash & Duplicates & Disk =====

async function trashFile(p) {
  const r = await (await fetch("/api/trash", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }),
  })).json();
  if (r.error) return errorToast(r.error);
  toast(`Moved To Trash: ${p.split("/").pop()}`, "delete");
  browse(currentDir);
}

function closeToolDialog() { $("#toolDialog").style.display = "none"; }

async function showTrash() {
  const body = $("#trashBody");
  body.innerHTML = "<p style='color:var(--md-on-surface-variant);padding:20px 0'>Loading…</p>";
  const { items } = await (await fetch("/api/trash")).json();
  if (!items.length) {
    body.innerHTML = `<div style="text-align:center;padding:80px 0;color:var(--md-on-surface-variant)">
      <span class="msr" style="font-size:64px;color:var(--md-outline)">delete</span>
      <p>Trash Is Empty.</p></div>`;
    return;
  }
  body.innerHTML = items.map(i => `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:16px;margin-bottom:8px;background:var(--md-surface-container-low)">
      ${/\.(jpe?g|png|webp|gif|bmp|mp4|mkv|webm|mov)$/i.test(i.name)
        ? `<img loading="lazy" src="/api/rawfile?trash=1&path=${encodeURIComponent(i.name)}" onerror="this.outerHTML='<span class=\\'msr\\' style=\\'color:var(--md-on-surface-variant)\\'>draft</span>'" style="width:44px;height:44px;object-fit:cover;border-radius:10px">`
        : `<span class="msr" style="color:var(--md-on-surface-variant)">draft</span>`}
      <div style="flex:1;min-width:0">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i.name.replaceAll("%2F", " / ")}</div>
        <div style="font-size:11px;color:var(--md-on-surface-variant)">${fmtSize(i.size)} · deleted ${new Date(i.deleted_at*1000).toLocaleString("en-US")}</div>
      </div>
      <button class="crumb" onclick="restoreTrash('${i.name.replace(/'/g, "\\'")}')">Restore</button>
    </div>`).join("") + `
    <div style="margin-top:14px;text-align:right">
      <button class="crumb" style="color:var(--md-error)" onclick="purgeTrash()">Empty Trash Permanently</button>
    </div>`;
}

async function restoreTrash(name) {
  await fetch("/api/trash/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  showTrash();
}

async function purgeTrash() {
  await fetch("/api/trash/purge", { method: "POST" });
  showTrash();
}

async function showDuplicates() {
  const body = $("#dupesBody");
  body.innerHTML = "<p style='color:var(--md-on-surface-variant);padding:20px 0'>Checking Vault…</p>";
  try {
    const { groups, wasted } = await (await fetch("/api/duplicates")).json();
    if (!groups.length) {
      body.innerHTML = `<div style="text-align:center;padding:80px 0;color:var(--md-on-surface-variant)">
        <span class="msr" style="font-size:64px;color:var(--md-outline)">task_alt</span>
        <p>No Duplicates. Your Vault Is Efficient!</p></div>`;
      return;
    }
    body.innerHTML = `<div class="card" style="padding:14px 18px;margin-bottom:16px"><b>${groups.length} Duplicate Groups</b> — ${fmtSize(wasted)} Can Be Saved. Delete All But One Per Group?</div>` +
      groups.map((g, gi) => `
      <div style="padding:14px 16px;border-radius:16px;margin-bottom:8px;background:var(--md-surface-container-low)">
        <div style="font-size:11px;color:var(--md-on-surface-variant);margin-bottom:6px">Group ${gi+1} · ${fmtSize(g.files[0].size)} each</div>
        ${g.files.map((f, fi) => `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
          <span class="msr" style="font-size:16px;color:var(--md-on-surface-variant)">draft</span>
          <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${esc(f.original_name)}</span>
          ${fi > 0 ? `<button class="crumb" style="font-size:11px;color:var(--md-error)" onclick="trashFileFromDup(${f.id})">Delete</button>` : '<span style="font-size:11px;color:#137333;font-weight:500">Kept</span>'}
        </div>`).join("")}
      </div>`).join("");
  } catch (e) {
    body.innerHTML = `<p style="color:var(--md-error)">Scan Failed: ${e.message}</p>`;
  }
}

// ===== Favorites =====
// ===== Archive =====
async function loadArchive() {
  const g = $("#archGallery");
  g.innerHTML = "";
  const files = await (await fetch("/api/archived")).json();
  $("#archEmpty").style.display = files.length ? "none" : "block";
  if (!files.length) return;
  const byMonth = {};
  for (const f of files) (byMonth[new Date(f.mtime * 1000).toISOString().slice(0, 7)] ??= []).push(f);
  for (const [month, list] of Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0]))) {
    g.insertAdjacentHTML("beforeend", `<div class="date-header">${label(month + "-01")}</div><div class="rows"></div>`);
    await justifiedRows(g.lastElementChild, list);
  }
}
async function unarchive(id) {
  await fetch(`/api/archive/${id}`, { method: "POST" });
  toast("Unarchived", "unarchive");
  loadArchive();
}

// ===== Smart Albums =====
let openAlbumId = null;
async function loadAlbums() {
  const albums = await (await fetch("/api/smart-albums")).json();
  $("#albumList").innerHTML = albums.length ? albums.map(a => `
    <div class="card" style="padding:16px;cursor:pointer" onclick="openAlbum(${a.id}, '${esc(a.name.replaceAll("'", "\\'"))}')">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="msr" style="font-size:26px;color:var(--md-primary)">collections</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600">${esc(a.name)}</div>
          <div style="font-size:11px;color:var(--md-on-surface-variant)">${a.count.toLocaleString("en-US")} Items · ${esc(Object.entries(a.rule).map(([k, v]) => `${k}: ${v}`).join(", "))}</div>
        </div>
        <span class="msr" style="color:var(--md-on-surface-variant);font-size:18px;cursor:pointer" onclick="event.stopPropagation(); deleteAlbum(${a.id}, '${esc(a.name.replaceAll("'", "\\'"))}')">delete</span>
      </div>
    </div>`).join("") : '<p style="grid-column:1/-1;color:var(--md-on-surface-variant);font-size:13px">No Smart Albums Yet.</p>';
}
function showAddAlbum() { $("#albName").value = ""; $("#albPlace").value = ""; $("#albYear").value = ""; $("#albFav").checked = false; $("#albError").textContent = ""; $("#albumDialog").style.display = "flex"; }
function closeAddAlbum() { $("#albumDialog").style.display = "none"; }
async function createAlbum() {
  const rule = {};
  if ($("#albPlace").value.trim()) rule.place = $("#albPlace").value.trim();
  if ($("#albYear").value) rule.year = Number($("#albYear").value);
  if ($("#albFav").checked) rule.favorite = true;
  if (!rule.place && !rule.year && !rule.favorite) { $("#albError").textContent = "Isi Minimal Satu Rule"; return; }
  const r = await fetch("/api/smart-albums", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("#albName").value.trim(), rule }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("#albError").textContent = j.error ?? "Failed"; return; }
  closeAddAlbum();
  toast("Smart Album Created", "collections");
  loadAlbums();
}
async function deleteAlbum(id, name) {
  showConfirmDialog("Delete Smart Album", `Delete Album "${name}"? Files Are Not Affected.`, async () => {
    await fetch(`/api/smart-albums/${id}`, { method: "DELETE" });
    closeConfirmDialog();
    $("#albumItems").innerHTML = "";
    toast("Smart Album Deleted", "delete");
    loadAlbums();
  });
}
async function openAlbum(id, name) {
  openAlbumId = id;
  const items = await (await fetch(`/api/smart-albums/${id}/items`)).json();
  const box = $("#albumItems");
  if (!items.length) { box.innerHTML = `<div class="date-header">${name}</div><p style="color:var(--md-on-surface-variant);font-size:13px">No Items Match This Rule.</p>`; return; }
  box.innerHTML = `<div class="date-header">${name} — ${items.length.toLocaleString("en-US")} Items</div><div class="rows"></div>`;
  await justifiedRows(box.lastElementChild, items);
}

// ===== Manual albums =====
async function loadManualAlbums() {
  const albums = await (await fetch("/api/albums")).json();
  $("#manualAlbumList").innerHTML = albums.length ? albums.map(a => `
    <div class="card" style="padding:16px;cursor:pointer" onclick="openManualAlbum(${a.id}, '${esc(a.name.replaceAll("'", "\\'"))}')">
      <div style="display:flex;align-items:center;gap:10px">
        <span class="msr" style="font-size:26px;color:var(--md-primary)">photo_album</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:600">${esc(a.name)}</div>
          <div style="font-size:11px;color:var(--md-on-surface-variant)">${a.count.toLocaleString("en-US")} Items</div>
        </div>
        <span class="msr" style="color:var(--md-on-surface-variant);font-size:18px;cursor:pointer" onclick="event.stopPropagation(); deleteManualAlbum(${a.id}, '${esc(a.name.replaceAll("'", "\\'"))}')">delete</span>
      </div>
    </div>`).join("") : '<p style="grid-column:1/-1;color:var(--md-on-surface-variant);font-size:13px">No Albums Yet — Create One, Then Add Photos From The Lightbox.</p>';
}
function showNewAlbum() { $("#mAlbName").value = ""; $("#mAlbError").textContent = ""; $("#manualAlbumDialog").style.display = "flex"; }
function closeNewAlbum() { $("#manualAlbumDialog").style.display = "none"; }
async function createManualAlbum() {
  const r = await fetch("/api/albums", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("#mAlbName").value.trim() }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("#mAlbError").textContent = j.error ?? "Failed"; return; }
  closeNewAlbum();
  toast("Album Created", "photo_album");
  loadManualAlbums();
}
function deleteManualAlbum(id, name) {
  showConfirmDialog("Delete Album", `Delete Album "${name}"? Photos Are Not Affected.`, async () => {
    await fetch(`/api/albums/${id}`, { method: "DELETE" });
    closeConfirmDialog();
    $("#manualAlbumItems").innerHTML = "";
    toast("Album Deleted", "delete");
    loadManualAlbums();
  });
}
async function openManualAlbum(id, name) {
  const items = await (await fetch(`/api/albums/${id}/items`)).json();
  const box = $("#manualAlbumItems");
  if (!items.length) { box.innerHTML = `<div class="date-header">${name}</div><p style="color:var(--md-on-surface-variant);font-size:13px">Empty Album — Add Photos From The Lightbox.</p>`; return; }
  box.innerHTML = `<div class="date-header">${name} — ${items.length.toLocaleString("en-US")} Items</div><div class="rows"></div>`;
  await justifiedRows(box.lastElementChild, items);
}

// add-to-album dari lightbox: pilih album, file aktif masuk album itu
let addToAlbumFileId = null;
async function showAddToAlbum(fileId) {
  addToAlbumFileId = fileId;
  const albums = await (await fetch("/api/albums")).json();
  const inAlbums = new Set((await (await fetch(`/api/albums-of/${fileId}`)).json()).map(a => a.id));
  $("#addToAlbumList").innerHTML = albums.length ? albums.map(a => `
    <button class="opt" onclick="addToAlbum(${a.id})">
      <span class="msr" style="color:var(--md-primary)">photo_album</span>
      <span style="flex:1;text-align:left"><b>${esc(a.name)}</b><br><small style="color:var(--md-on-surface-variant)">${a.count.toLocaleString("en-US")} Items${inAlbums.has(a.id) ? " · Already In" : ""}</small></span>
      <span class="msr" style="color:${inAlbums.has(a.id) ? "#137333" : "var(--md-on-surface-variant)"}">${inAlbums.has(a.id) ? "check_circle" : "add"}</span>
    </button>`).join("") : '<p style="color:var(--md-on-surface-variant);font-size:13px">No Albums Yet — Create One In The Albums View First.</p>';
  $("#addToAlbumDialog").style.display = "flex";
}
function closeAddToAlbum() { $("#addToAlbumDialog").style.display = "none"; }
async function addToAlbum(albumId) {
  const r = await fetch(`/api/albums/${albumId}/files`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [addToAlbumFileId] }) });
  if (r.ok) { toast("Added To Album", "photo_album"); closeAddToAlbum(); }
}

async function loadFavorites() {
  const g = $("#favGallery");
  g.innerHTML = "";
  const { files } = await (await fetch("/api/favorites")).json();
  $("#favEmpty").style.display = files.length ? "none" : "block";
  if (!files.length) return;
  // kelompokkan per bulan biar konsisten sama galeri
  const byMonth = {};
  for (const f of files) {
    const k = new Date(f.mtime * 1000).toISOString().slice(0, 7);
    (byMonth[k] ??= []).push({ ...f, mime: f.mime });
  }
  for (const [month, list] of Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0]))) {
    g.insertAdjacentHTML("beforeend", `<div class="date-header">${label(month + "-01")}</div><div class="rows"></div>`);
    await justifiedRows(g.lastElementChild, list);
  }
}

// ===== Maps (lokasi foto dari EXIF GPS) =====
let mapObj = null, mapMarkers = [];

async function loadMaps() {
  // init ulang tiap kali masuk view (ukuran container berubah saat display:none)
  if (mapObj) { mapObj.remove(); mapObj = null; mapMarkers = []; }
  $("#mapsLoading").style.display = "block";
  $("#mapCanvas").style.display = "none";
  let photos = [];
  try {
    photos = (await (await fetch("/api/photos-gps")).json()).photos ?? [];
  } catch {}
  $("#mapsLoading").style.display = "none";
  if (!photos.length) {
    $("#mapCanvas").style.display = "none";
    $("#mapsLoading").style.display = "block";
    $("#mapsLoading").innerHTML = `<div style="text-align:center;padding:80px 0;color:var(--md-on-surface-variant)">
      <span class="msr" style="font-size:64px;color:var(--md-outline)">location_off</span>
      <p>No Photos With Location Yet.</p>
      <p style="font-size:12px">Turn On Camera Location When Capturing — Photos With EXIF GPS Will Appear Here Automatically.</p></div>`;
    return;
  }
  $("#mapCanvas").style.display = "block";
  mapObj = L.map("mapCanvas", { zoomControl: false }).setView([photos[0].lat, photos[0].lng], 12);
  // popup buka → simpan closer global (dipakai onclick thumbnail popup: closeMapPopup();openMediaById(id))
  mapObj.on("popupopen", e => { window.closeMapPopup = () => e.popup.close(); });
  // tile gagal load (grid kosong) → retry otomatis: Leaflet menandai tile error, kita refresh layer
  mapObj.on("tileerror", () => {
    clearTimeout(mapObj._tileRetry);
    mapObj._tileRetry = setTimeout(() => {
      mapObj.eachLayer(l => { if (l._url) { mapObj.removeLayer(l); l.addTo(mapObj); } });
    }, 1500);
  });
  // ===== Layer switcher (Nothing style) =====
  const LAYERS = {
    standard: { name: "Standard", url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', max: 19 },
    satellite: { name: "Satellite", url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", attr: "Tiles &copy; Esri", max: 19, native: 18 },
  };
  let baseLayer = null;
  function setLayer(key) {
    if (baseLayer) mapObj.removeLayer(baseLayer);
    const l = LAYERS[key];
    baseLayer = L.tileLayer(l.url, { attribution: l.attr, maxZoom: l.max, maxNativeZoom: l.native }).addTo(mapObj);
    document.querySelectorAll(".map-layer-btn").forEach(b => b.classList.toggle("active", b.dataset.layer === key));
  }
  setLayer("standard");
  // kontrol layer: pojok kanan atas, Nothing mono uppercase
  const layerCtrl = L.control({ position: "topright" });
  layerCtrl.onAdd = () => {
    const div = L.DomUtil.create("div", "map-layer-switcher");
    div.innerHTML = Object.entries(LAYERS).map(([k, l]) =>
      `<button class="map-layer-btn" data-layer="${k}">${l.name}</button>`).join("");
    L.DomEvent.disableClickPropagation(div);
    div.querySelectorAll(".map-layer-btn").forEach(b => b.onclick = () => setLayer(b.dataset.layer));
    return div;
  };
  layerCtrl.addTo(mapObj);
  setLayer("standard"); // panggil ulang setelah control ada di DOM supaya class active ter-set
  // zoom control: pojok kanan bawah
  L.control.zoom({ position: "bottomright" }).addTo(mapObj);
  // cluster sederhana: kelompokkan koordinat identik (bulatkan 4 desimal)
  const groups = {};
  for (const p of photos) {
    const k = p.lat.toFixed(4) + "," + p.lng.toFixed(4);
    (groups[k] ??= { lat: p.lat, lng: p.lng, photos: [] }).photos.push(p);
  }
  for (const g of Object.values(groups)) {
    const thumb = `/media/${g.photos[0].id}`;
    const icon = L.divIcon({
      className: "",
      html: `<div style="width:52px;height:52px;border-radius:8px;border:2px solid var(--n-display,#000);box-shadow:0 4px 16px rgba(0,0,0,.35);overflow:hidden">
        <img src="${thumb}" style="width:100%;height:100%;object-fit:cover;display:block"></div>`,
      iconSize: [52, 52], iconAnchor: [26, 52],
    });
    const m = L.marker([g.lat, g.lng], { icon }).addTo(mapObj);
    const list = g.photos.slice(0, 6).map(p =>
      `<img src="/media/${p.id}/thumb" style="width:80px;height:80px;object-fit:cover;border-radius:4px;cursor:pointer" onclick="closeMapPopup();openMediaById(${p.id})">`).join("");
    const place = g.photos.find(p => p.place)?.place;
    // popup offset ke atas melewati tinggi marker (52px anchor bawah) supaya tidak menutupi gambar marker
    m.bindPopup(`<div style="font:600 13px Geist,sans-serif;margin-bottom:2px">${g.photos.length} Photo${g.photos.length > 1 ? "s" : ""} Here</div>
      ${place ? `<div style="font:400 11px 'Geist Mono',monospace;color:#8C8C8C;margin-bottom:6px"><span class="msr" style="font-size:12px;vertical-align:-2px">location_on</span> ${esc(place)}</div>` : ""}
      <div style="display:flex;gap:4px;flex-wrap:wrap">${list}</div>`, { offset: [0, -38], autoPan: true, closeButton: true });
    mapMarkers.push(m);
  }
  // fit bounds kalau lebih dari satu lokasi
  if (mapMarkers.length > 1) {
    mapObj.fitBounds(L.featureGroup(mapMarkers).getBounds().pad(0.15));
  }
  setTimeout(() => {
    if (!mapObj) return;
    mapObj.invalidateSize();
    // init saat view transition → render ulang tile setelah layout settle (anti grid kosong)
    setTimeout(() => mapObj?.invalidateSize(), 350);
  }, 150);
}

function trashFileFromDup(id) {
  fetch(`/api/media-trash/${id}`, { method: "POST" }).then(() => showDuplicates());
}

// ===== Live monitoring (CPU / Memory / Network) =====
let liveTimer = null;
const liveHistory = { cpu: [], mem: [], net: [] }; // ring buffer per metrik; disk dinamis → liveDiskHistory
const LIVE_MAX = 60;
function pushHist(key, v) {
  const h = liveHistory[key];
  h.push(v);
  if (h.length > LIVE_MAX) h.shift();
}
// auto-scale: 85 Mbps → "85.0 Mbps" · 400 Mbps → "50.0 MB/s" · 9000 Mbps → "1.12 GB/s"
function fmtMbps(v) {
  if (v >= 8000) return (v / 8000).toFixed(2) + " GB/s";
  if (v >= 100) return (v / 8).toFixed(1) + " MB/s";
  return v >= 10 ? v.toFixed(1) + " Mbps" : v.toFixed(2) + " Mbps";
}
let cpuPctLast = 0;
let liveGpus = null; // cache GPU usage dari pollLive terakhir
let liveCores = null; // cache per-core CPU dari pollLive terakhir
const liveDiskHistory = {}; // per-disk ring buffer: "0 Physical Drive" → [samples]
async function pollLive() {
  try {
    const d = await (await fetch("/api/live")).json();
    liveCores = d.cpuCores ?? null;
    liveGpus = d.gpus ?? null;
    for (const disk of d.disks ?? []) {
      (liveDiskHistory[disk.name] ??= []).push(disk.rMbps + disk.wMbps);
      if (liveDiskHistory[disk.name].length > LIVE_MAX) liveDiskHistory[disk.name].shift();
    }
    pushHist("cpu", d.cpuPct);
    cpuPctLast = d.cpuPct;
    pushHist("mem", d.memPct);
    pushHist("net", d.net ? d.net.rxMbps + d.net.txMbps : 0);
    renderLiveList();
    drawLiveGraph();
    renderCpuCard();
    renderGpuCard();
  } catch {}
}
// ===== Task Manager-style: list kiri + graph kanan =====
let liveKey = "cpu";
const LIVE_META = {
  cpu: { icon: "memory_alt", title: "CPU" },
  mem: { icon: "memory", title: "Memory" },
  net: { icon: "wifi", title: "Network" },
  disk: { icon: "save", title: "Disk I/O" },
};
function renderLiveList() {
  const fmt = (k) => {
    const h = k.startsWith("disk:") ? liveDiskHistory[k.slice(5)] : liveHistory[k];
    if (!h?.length) return "—";
    return fmtMbps(h[h.length - 1]);
  };
  // GPU pill: satu per GPU dari cache polling terakhir
  const gpuPills = (liveGpus ?? []).map((g, i) => ({
    key: `gpu:${i}`, icon: "videocam", title: /radeon/i.test(g.name) ? "iGPU" : "GPU",
    value: () => g.utilPct + "%",
  }));
  const diskPills = Object.keys(liveDiskHistory).map(name => ({
    key: `disk:${name}`, icon: "save", title: "Disk " + name.replace(/^(\d+)\s.*$/, "$1"), value: () => fmt(`disk:${name}`),
  }));
  const base = [
    { key: "cpu", icon: "memory_alt", title: "CPU", value: () => Math.round(liveHistory.cpu.at(-1) ?? 0) + "%" },
    { key: "mem", icon: "memory", title: "Memory", value: () => Math.round(liveHistory.mem.at(-1) ?? 0) + "%" },
    { key: "net", icon: "wifi", title: "Network", value: () => fmt("net") },
  ];
  const all = [...base, ...gpuPills, ...diskPills];
  // Nothing pill vertikal kiri: kolom penuh lebar, aktif inversi. Struktur mendukung metrik baru
  // (multi-disk → pill tambahan otomatis).
  $("#liveList").innerHTML = all.map(p => `
    <button onclick="selectLive('${p.key.replace(/'/g, "\\'")}')" style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 14px;border-radius:6px;cursor:pointer;border:1px solid ${p.key === liveKey ? "transparent" : "var(--n-line)"};background:${p.key === liveKey ? "var(--n-display)" : "transparent"};color:${p.key === liveKey ? "var(--n-bg)" : "var(--n-secondary)"};font-family:var(--n-f-mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;text-align:left;transition:background .15s ease-in-out,color .15s ease-in-out">
      <span class="msr" style="font-size:15px">${p.icon}</span>
      <span style="flex:1">${p.title}</span>
      <span style="font-variant-numeric:tabular-nums;opacity:.7;margin-left:auto;text-align:right;white-space:nowrap;text-transform:none">${p.value()}</span>
    </button>`).join("");
}
function selectLive(k) { liveKey = k; renderLiveList(); drawLiveGraph(); renderCpuCard(); renderGpuCard(); }
// card detail GPU (nama + VRAM) — tampil hanya saat pill GPU aktif
function renderGpuCard() {
  const el = $("#liveCpuCard"), hero = $("#liveHero");
  if (!el || !hero) return;
  if (!liveKey.startsWith("gpu:")) { if (liveKey !== "cpu") { el.style.display = "none"; hero.style.display = "block"; } return; }
  const idx = Number(liveKey.slice(4));
  const g = (liveGpus ?? [])[idx];
  hero.style.display = "none";
  el.style.display = "block";
  el.innerHTML = g ? `
    <div style="display:flex;align-items:baseline;justify-content:flex-end;gap:8px;margin-bottom:6px">
      <span style="font-family:var(--n-f-mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--n-secondary)">GPU</span>
      <span style="font-family:var(--n-f-display);font-variation-settings:'ROND' 100;font-size:40px;line-height:1;color:var(--n-display)">${g.utilPct}%</span>
    </div>
    <div style="border-radius:6px;background:var(--n-raised);padding:16px">
      <div class="n-ds" style="margin-bottom:6px">${g.name.replace(/^(NVIDIA|AMD)\s+/i, "").replace(/\(TM\)/gi, "")}</div>
      <div style="display:flex;justify-content:space-between" class="n-ds">
        <span>VRAM Used</span><span style="font-variant-numeric:tabular-nums">${g.memUsedMb} MB</span>
      </div>
    </div>` : "";
}
// #13: card per-core CPU — tampil hanya saat pill CPU aktif
function renderCpuCard() {
  const el = $("#liveCpuCard"), hero = $("#liveHero");
  if (!el || !hero) return;
  const show = liveKey === "cpu";
  hero.style.display = show ? "none" : hero.style.display;
  el.style.display = show ? "block" : el.style.display;
  if (!show) return;
  const cores = liveCores ?? [];
  const avg = cpuPctLast;
  el.innerHTML = `
    <div style="display:flex;align-items:baseline;justify-content:flex-end;gap:8px;margin-bottom:6px">
      <span style="font-family:var(--n-f-mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--n-secondary)">CPU</span>
      <span style="font-family:var(--n-f-display);font-variation-settings:'ROND' 100;font-size:40px;line-height:1;color:var(--n-display)">${cores.length ? avg + "%" : "—"}</span>
    </div>
    <div style="border-radius:6px;background:var(--n-raised);padding:16px">
      <div class="n-ds" style="margin-bottom:10px">CPU Per Core${cores.length ? ` · ${cores.length} Cores` : ""}</div>
      <div style="display:flex;gap:3px;align-items:flex-end;height:64px">${cores.map(u => `
        <div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%" title="Core ${cores.indexOf(u)}: ${u}%">
          <div style="height:${Math.max(u, 2)}%;background:${u > 80 ? "#D71921" : "var(--n-display)"};border-radius:2px 2px 0 0;transition:height .4s var(--ease-emph)"></div>
        </div>`).join("") || '<span class="n-ds">Waiting For Data…</span>'}
      </div>
    </div>`;
}
function drawLiveGraph() {
  if (!document.getElementById("lg-canvas")) return;
  const h = liveKey.startsWith("disk:") ? liveDiskHistory[liveKey.slice(5)] : liveHistory[liveKey];
  if (!h) return;
  const c = $("#lg-canvas"), ctx = c.getContext("2d");
  const W = c.width, H = c.height, pad = 12;
  ctx.clearRect(0, 0, W, H);
  // grid hairline horizontal 4 baris
  ctx.strokeStyle = "rgba(128,128,128,.14)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, (H / 4) * i); ctx.lineTo(W, (H / 4) * i); ctx.stroke(); }
  // nilai & label di header pill (lg-title/lg-icon tidak dipakai lagi di layout baru)
  const isNet = liveKey === "net";
  const isDisk = liveKey.startsWith("disk:");
  const isPct = !isNet && !isDisk;
  const fmt = isPct ? (v) => Math.round(v) + "%" : fmtMbps;
  const dark = document.body.classList.contains("dark");
  const line = dark ? "#FFF" : "#000";       // garis monokrom ikut theme
  const accent = "#D71921";                  // dot merah: satu-satunya warna
  const title = isDisk ? "Disk " + liveKey.slice(5).replace(/^(\d+)\s.*$/, "$1") : LIVE_META[liveKey]?.title ?? liveKey;
  if (h.length < 2) {
    $("#lg-value").textContent = "—";
    $("#lg-title").textContent = title;
    $("#lg-min").textContent = ""; $("#lg-max").textContent = "";
    $("#lg-sub").textContent = "Waiting For Data…";
    return;
  }
  // skala: pct 0-100; throughput auto-scale ke max (min 10 Mbps biar nggak flat)
  const max = isPct ? 100 : Math.max(10, ...h) * 1.15;
  const px = (i) => pad + (i / (LIVE_MAX - 1)) * (W - pad * 2);
  const py = (v) => H - pad - (v / max) * (H - pad * 2);
  // area fill nyaris transparan (Nothing: tanpa gradient mencolok)
  ctx.beginPath();
  ctx.moveTo(px(0), py(h[0]));
  h.forEach((v, i) => ctx.lineTo(px(i), py(v)));
  ctx.lineTo(px(h.length - 1), H - pad); ctx.lineTo(px(0), H - pad); ctx.closePath();
  ctx.fillStyle = dark ? "rgba(255,255,255,.06)" : "rgba(0,0,0,.05)";
  ctx.fill();
  // garis tipis monokrom
  ctx.beginPath();
  h.forEach((v, i) => i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v)));
  ctx.strokeStyle = line; ctx.lineWidth = 1.5; ctx.stroke();
  // dot merah accent di titik terakhir (satu-satunya warna)
  const lx = px(h.length - 1), ly = py(h[h.length - 1]);
  ctx.beginPath(); ctx.arc(lx, ly, 5, 0, 7); ctx.fillStyle = accent; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 2, 0, 7); ctx.fillStyle = dark ? "#000" : "#FFF"; ctx.fill();
  $("#lg-value").textContent = fmt(h[h.length - 1]);
  $("#lg-title").textContent = title;
  $("#lg-sub").textContent = isNet ? "Throughput (Rx + Tx)" : isDisk ? "Throughput (Read + Write)" : "Utilization";
  $("#lg-min").textContent = "Min " + fmt(Math.min(...h));
  $("#lg-max").textContent = "Max " + fmt(Math.max(...h));
}
function startLivePolling() {
  clearInterval(liveTimer);
  pollLive();
  setTimeout(pollLive, 2500);
  liveTimer = setInterval(pollLive, 5000);
}

// ===== Year In Review =====
async function loadRecap(year) {
  // year picker: semua tahun yang punya file
  if (!year) {
    try {
      const s = await (await fetch("/api/stats")).json();
      year = s.years?.length ? s.years[s.years.length - 1].y : new Date().getFullYear();
    } catch { year = new Date().getFullYear(); }
  }
  const statsAll = await (await fetch("/api/stats")).json();
  $("#recapYearPicker").innerHTML = `<div class="rc-years">${statsAll.years
    .map(y => `<button class="rc-yr ${+y.y === +year ? "sel" : ""}" onclick="loadRecap('${y.y}')">${y.y}</button>`).join("")}</div>`;
  const r = await (await fetch(`/api/recap/${year}`)).json();
  if (!r.total) {
    $("#recapBody").innerHTML = `<div class="rc-sec"><div class="rc-empty">No Items In ${year} — Pick Another Year.</div></div>`;
    return;
  }
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const maxMonth = Math.max(...r.perMonth.map(m => m.n), 1);
  const busiestM = r.perMonth.reduce((a, b) => b.n > (a?.n ?? 0) ? b : a, null)?.m;
  const stats = [
    { label: "Total Items", value: r.total.toLocaleString("en-US") },
    { label: "Photos", value: (r.photos ?? 0).toLocaleString("en-US") },
    { label: "Videos", value: (r.videos ?? 0).toLocaleString("en-US") },
    { label: "In Vault", value: fmtSize(r.size) },
    { label: "Busiest Month", value: r.busiestMonth ?? "—" },
  ];
  $("#recapBody").innerHTML = `
    <div class="rc-hero">
      <div class="rc-year">${year}</div>
      <div>
        <div class="rc-year-sub">// YEAR IN REVIEW</div>
        <div style="font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary);margin-top:6px;letter-spacing:.06em">${r.total.toLocaleString("en-US")} ITEMS · ${fmtSize(r.size)} · CAPTURED ACROSS ${r.perMonth.filter(m => m.n > 0).length} MONTHS</div>
      </div>
    </div>
    <div class="rc-stats">${stats.map(s => `
      <div class="rc-stat"><div class="rc-stat-v">${s.value}</div><div class="rc-stat-l">${s.label}</div></div>`).join("")}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">
      <div class="rc-sec">
        <div class="rc-sec-t"><span class="msr">bar_chart</span> Items Per Month</div>
        <div class="rc-bar">
          ${monthNames.map((m, i) => {
            const n = r.perMonth.find(x => +x.m === i + 1)?.n ?? 0;
            const peak = i + 1 === +busiestM && n > 0;
            return `<div class="rc-bar-col">
              <span class="rc-bar-v">${n || ""}</span>
              <div class="rc-bar-b ${peak ? "peak" : ""}" style="height:${n ? Math.max((n / maxMonth) * 80, 4) : 2}px;${n ? "" : "background:var(--md-outline-variant);height:2px"}"></div>
              <span class="rc-bar-m">${m}</span>
            </div>`;
          }).join("")}
        </div>
      </div>
      <div class="rc-sec">
        <div class="rc-sec-t"><span class="msr">location_on</span> Top Places</div>
        ${r.topPlaces.length ? r.topPlaces.map((p, i) => `
          <div class="rc-row">
            <span class="rc-row-n">${String(i + 1).padStart(2, "0")}</span>
            <span class="rc-row-nm">${esc(p.place)}</span>
            <span class="rc-row-v">${p.n.toLocaleString("en-US")} ITEMS</span>
          </div>`).join("") : `<div class="rc-empty">No Geotagged Items In ${year}.</div>`}
      </div>
    </div>
    <div class="rc-sec" style="margin-top:16px">
      <div class="rc-sec-t"><span class="msr">diamond</span> Largest Files</div>
      ${r.largest.map(f => `
        <div class="rc-row">
          <span class="msr" style="font-size:16px;color:var(--n-secondary)">${f.mime.startsWith("video") ? "movie" : "image"}</span>
          <span class="rc-row-nm">${esc(f.original_name)}</span>
          <span class="rc-row-v">${fmtSize(f.size)}</span>
        </div>`).join("")}
    </div>`;
}

// ===== Verify Vault =====
async function verifyVault() {
  const box = $("#verifyResult");
  box.style.display = "block";
  box.innerHTML = `<div class="card" style="padding:14px 18px"><span class="msr" style="vertical-align:-4px">hourglass_top</span> Verifying Vault…</div>`;
  try {
    const r = await (await fetch("/api/verify")).json();
    const offline = Object.entries(r.volumes ?? {}).filter(([, s]) => !s.online);
    if (!r.missing.length && !r.sizeMismatch.length && !offline.length) {
      box.innerHTML = `<div class="card" style="padding:16px 18px;border-left:4px solid #1e8e3e">
        <b><span class="msr" style="vertical-align:-4px;color:#1e8e3e">verified</span> Vault Healthy</b>
        <div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:4px">All ${r.total} Files Verified Present — All Volumes Online.</div>
      </div>`;
      return;
    }
    const rows = [
      ...offline.map(([n]) => `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px"><span class="msr" style="font-size:14px;color:#f9ab00">save_off</span><span>Volume "${n}" Is Offline — Files On It Cannot Be Verified.</span></div>`),
      ...r.missing.map(m => `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px"><span class="msr" style="font-size:14px;color:var(--md-error)">file_missing</span><span style="word-break:break-all">${m.path}</span></div>`),
      ...r.sizeMismatch.map(m => `<div style="display:flex;gap:8px;padding:4px 0;font-size:12px"><span class="msr" style="font-size:14px;color:#f9ab00">warning</span><span style="word-break:break-all">${m.path} — Expected ${fmtSize(m.expected)}, Found ${fmtSize(m.actual)}</span></div>`),
    ].join("");
    box.innerHTML = `<div class="card" style="padding:16px 18px;border-left:4px solid ${r.missing.length || r.sizeMismatch.length ? "var(--md-error)" : "#f9ab00"}">
      <b><span class="msr" style="vertical-align:-4px;color:var(--md-error)">report</span> Issues Found</b>
      <div style="font-size:12px;color:var(--md-on-surface-variant);margin:4px 0 10px">${r.missing.length} Missing, ${r.sizeMismatch.length} Size Mismatch${offline.length ? `, ${offline.length} Volume Offline` : ""} — ${r.ok}/${r.total} Files OK.</div>
      <div style="max-height:260px;overflow:auto">${rows}</div>
    </div>`;
  } catch (e) {
    box.innerHTML = `<div class="card" style="padding:14px 18px;color:var(--md-error)">Verify Failed: ${e.message}</div>`;
  }
}

// banner otomatis di Dashboard kalau ada volume offline (cek tiap load stats)
async function checkVolumeHealth() {
  try {
    const { volumes } = await (await fetch("/api/volumes")).json();
    const off = volumes.filter(v => !v.online);
    let banner = $("#volOfflineBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "volOfflineBanner";
      $("#view-dashboard .dash-header").after(banner);
    }
    banner.outerHTML = off.length
      ? `<div id="volOfflineBanner" class="card" style="padding:12px 16px;margin-bottom:16px;border-left:4px solid #f9ab00;max-width:1200px">
          <b style="font-size:13px"><span class="msr" style="font-size:16px;vertical-align:-3px;color:#f9ab00">save_off</span> Volume Offline: ${off.map(v => v.name).join(", ")}</b>
          <div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:2px">Files On These Volumes Are Not Accessible. Reconnect The Drive And Verify The Vault.</div>
        </div>`
      : `<div id="volOfflineBanner" style="display:none"></div>`;
  } catch {}
}

async function loadDisk() {
  try {
    // Storage cards: satu kartu per volume (Nothing UI, di dalam [data-nothing])
    const { volumes } = await (await fetch("/api/volumes")).json();
    $("#storageCards").innerHTML = volumes.map((v, i) => {
      const usedPct = v.online && v.total ? Math.round(((v.total - v.free) / v.total) * 100) : 0;
      return `<div class="n-card">
        <div class="card-top" style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <div class="card-icon" style="width:46px;height:46px;flex-shrink:0"><span class="msr" style="font-size:26px">${v.online ? "save" : "save_off"}</span></div>
          <div style="flex:1">
            <div class="n-ttl" style="font-size:20px;line-height:1.1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${(v.display || v.name).charAt(0).toUpperCase() + (v.display || v.name).slice(1)}${v.online ? "" : " · Offline"}</div>
            <div class="n-ds" style="margin-top:1px;font-size:12px">Volume ${i + 1}</div>
          </div>
        </div>
        <div class="n-metric" style="font-size:32px">${v.online ? fmtSize(v.free) : "Offline"}</div>
        <div class="n-ds" style="margin-top:6px">${v.online ? `Free Of ${fmtSize(v.total)}` : "Drive Not Reachable"}</div>
        <div class="n-progress" style="margin-top:10px"><div style="width:${v.online ? usedPct : 0}%"></div></div>
        <div class="n-ds" style="margin-top:6px;text-align:right">${v.online ? usedPct + "% Used" : ""}</div>
      </div>`;
    }).join("");
    // storage breakdown
    const b = await (await fetch("/api/breakdown")).json();
    const items = [
      { label: "Photos", size: b.photos, color: "var(--md-primary)", icon: "image" },
      { label: "Videos", size: b.videos, color: "#ea4335", icon: "movie" },
      { label: "Documents", size: b.documents, color: "#f9ab00", icon: "description" },
      { label: "Other", size: b.others, color: "var(--md-outline)", icon: "draft" },
    ];
    const total = items.reduce((a, i) => a + i.size, 0) || 1;
    $("#breakdown").innerHTML = items.map(i => `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <span class="msr" style="font-size:20px;color:var(--md-on-surface-variant)">${i.icon}</span>
        <span style="width:90px;font-size:13px;font-weight:500">${i.label}</span>
        <div style="flex:1;height:8px;background:var(--md-surface-container);border-radius:4px;overflow:hidden">
          <div style="height:100%;width:${Math.max((i.size / total) * 100, i.size > 0 ? 2 : 0)}%;background:${i.color};border-radius:4px;transition:width .5s var(--ease-emph)"></div>
        </div>
        <span style="width:70px;text-align:right;font-size:12px;color:var(--md-on-surface-variant);font-variant-numeric:tabular-nums">${fmtSize(i.size)}</span>
      </div>`).join("");
  } catch {}
}

// ===== Server Info (OS, uptime, CPU, RAM) =====
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function loadServerInfo() {
  const el = $("#serverInfo");
  if (!el) return;
  try {
    const [s] = [await (await fetch("/api/system")).json()];
    const memUsed = s.memTotal - s.memFree;
    const memPct = Math.round((memUsed / s.memTotal) * 100);
    const hddPct = Math.round(((s.hddTotal - s.hddFree) / s.hddTotal) * 100);
    const bar = (pct, color) => `<div style="flex:1;height:8px;background:var(--md-surface-container);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${color};border-radius:4px;transition:width .5s var(--ease-emph)"></div></div>`;
    // hardware cards (ala Vault cards)
    const gpus = (s.gpus ?? []).filter(g => !/virtual|basic/i.test(g.name));
    const gpuShort = (n) => n.replace(/^(NVIDIA|AMD)\s+/i, "").replace(/\(TM\)/gi, "").replace(/\s+with\s+Radeon\s+Graphics/i, "");
    const hwCards = [
      { icon: "memory", label: "CPU", value: s.cpuCores + " Cores", sub: gpuShort(s.cpuModel) },
      ...gpus.map(g => ({ icon: "videocam", label: /radeon/i.test(g.name) && /with radeon/i.test(s.cpuModel) ? "iGPU" : "GPU", value: g.gb ? g.gb + " GB" : "—", sub: gpuShort(g.name) })),
    ];
    const hwHtml = hwCards.map(h => `
      <div style="border:1px solid var(--n-line);background:var(--n-surface);padding:14px 16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span class="msr" style="font-size:16px;color:var(--n-secondary)">${h.icon}</span>
          <span style="font-family:var(--n-f-mono);font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:var(--n-secondary)">${h.label}</span>
        </div>
        <div style="font-family:var(--n-f-head);font-size:20px;font-weight:700;color:var(--n-primary);letter-spacing:.02em">${h.value}</div>
        <div style="font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary);margin-top:4px;word-break:break-all;text-transform:uppercase;letter-spacing:.06em">${esc(h.sub)}</div>
      </div>`).join("");
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <span class="msr" style="font-size:20px;color:var(--n-secondary)">computer</span>
        <div style="flex:1">
          <div style="font-family:var(--n-f-head);font-size:14px;font-weight:700;color:var(--n-primary);text-transform:uppercase;letter-spacing:.05em">${esc(s.distro || s.os)}</div>
          <div style="font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary);letter-spacing:.04em">${esc(s.os)} · NODE ${esc(s.node)}</div>
        </div>
        <span style="font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary);letter-spacing:.06em"><span class="msr" style="font-size:13px;vertical-align:-2px">schedule</span> UP ${fmtUptime(s.uptime)}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:16px">${hwHtml}</div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        <span class="msr" style="font-size:18px;color:var(--n-secondary)">memory</span>
        <span style="width:70px;font-family:var(--n-f-mono);font-size:11px;font-weight:500;color:var(--n-primary);text-transform:uppercase;letter-spacing:.06em">RAM ${memPct}%</span>
        ${bar(memPct, memPct > 90 ? "var(--n-accent,#D71921)" : "var(--n-display)")}
        <span style="width:110px;text-align:right;font-family:var(--n-f-mono);font-size:10px;color:var(--n-secondary);font-variant-numeric:tabular-nums;letter-spacing:.04em">${fmtSize(memUsed)} / ${fmtSize(s.memTotal)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="msr" style="font-size:18px;color:var(--n-secondary)">save</span>
        <span style="width:70px;font-family:var(--n-f-mono);font-size:11px;font-weight:500;color:var(--n-primary);text-transform:uppercase;letter-spacing:.06em">HDD ${hddPct}%</span>
        ${bar(hddPct, hddPct > 90 ? "var(--n-accent,#D71921)" : hddPct > 75 ? "var(--n-secondary)" : "var(--n-display)")}
        <span style="width:110px;text-align:right;font-family:var(--n-f-mono);font-size:10px;color:var(--n-secondary);font-variant-numeric:tabular-nums;letter-spacing:.04em">${fmtSize(s.hddFree)} FREE</span>
      </div>
      </div>`;
  } catch {
    el.innerHTML = `<div style="color:var(--md-error);font-size:12px">Failed To Load Server Info</div>`;
  }
}

// ===== Confirm dialog (M3) =====
let cdCallback = null;
function showConfirmDialog(title, body, onOk) {
  $("#cd-title").textContent = title;
  $("#cd-body").textContent = body;
  $("#cd-body").style.display = "";
  $("#cd-body").style.maxHeight = "";
  $("#cd-body").style.overflowY = "";
  $("#cd-ok").textContent = "OK";
  $("#cd-ok").onclick = () => { closeConfirmDialog(); onOk?.(); };
  $("#confirmDialog").style.display = "flex";
}
function closeConfirmDialog() { $("#confirmDialog").style.display = "none"; }

// Info dialog dengan body HTML (untuk detail mod, dll) — full-screen feel, auto-fit viewport
function showInfoDialogHtml(title, htmlBody) {
  $("#cd-title").textContent = title;
  $("#cd-body").innerHTML = htmlBody;
  $("#cd-body").style.display = "block";
  $("#cd-body").style.maxHeight = "calc(86vh - 140px)";
  $("#cd-body").style.overflowY = "auto";
  $("#cd-ok").textContent = "CLOSE";
  $("#cd-ok").onclick = closeConfirmDialog;
  $("#confirmDialog").style.display = "flex";
}

// ===== Settings: Storage Volumes =====
async function loadVolumes() {
  const el = $("#volumeList");
  el.innerHTML = `<div class="set-note" style="padding:8px 0">Loading…</div>`;
  try {
    const { volumes } = await (await fetch("/api/volumes")).json();
    if (!volumes.length) { el.innerHTML = `<div class="set-note">No Volumes.</div>`; return; }
    el.innerHTML = volumes.map(v => {
      const pct = v.total ? Math.round(((v.total - v.free) / v.total) * 100) : 0;
      const barColor = !v.online ? "var(--n-muted)" : pct > 90 ? "var(--n-accent,#D71921)" : pct > 75 ? "#f9ab00" : "#1e8e3e";
      return `<div class="set-card">
        <div style="display:flex;align-items:center;gap:12px;padding:14px 18px 10px">
          <span class="msr" style="font-size:22px;color:${v.online ? "var(--n-display)" : "var(--n-accent,#D71921)"}">${v.online ? "save" : "save_off"}</span>
          <div style="flex:1;min-width:0">
            <div style="font-family:var(--n-f-mono);font-size:13px;font-weight:700;color:var(--n-primary)">${esc(v.builtin ? (v.display || v.name) : v.name)}${v.primary ? ' <span class="set-badge" style="background:var(--n-display);color:var(--n-bg)">PRIMARY</span>' : ""}${v.builtin && !v.primary ? ' <span class="set-badge" style="border:1px solid var(--n-line-2);color:var(--n-secondary)">BUILT-IN</span>' : ""}</div>
            <div class="set-row-sub">${esc(v.root)}</div>
          </div>
          <button class="set-btn-ghost" onclick="showRenameVolume('${esc(v.name)}')">Rename</button>
          ${!v.builtin ? `<button class="set-btn-ghost danger" onclick="removeVolume('${esc(v.name)}')">Remove</button>` : ""}
        </div>
        <div style="display:flex;align-items:center;gap:12px;padding:0 18px 8px">
          <div class="set-bar"><div style="width:${v.online ? pct : 0}%;background:${barColor}"></div></div>
          <span class="set-row-sub" style="white-space:nowrap">${v.online ? `${fmtSize(v.free)} Free · ${pct}%` : "Offline"}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;padding:4px 18px 14px">
          <span class="set-row-sub" style="flex:1">${v.files.toLocaleString("en-US")} Files · ${fmtSize(v.used)} Stored</span>
          ${v.online && !v.primary ? `<button class="set-btn-ghost" onclick="setPrimaryVolume('${esc(v.name)}')">Make Primary</button>` : ""}
          ${v.online && !v.primary && v.files > 0 ? `<button class="set-btn-ghost" onclick="moveAllTo('${esc(v.name.replace(/'/g, ""))}')">Move All Files Here</button>` : ""}
        </div>
      </div>`;
    }).join("");
  } catch (e) {
    el.innerHTML = `<div class="set-note" style="color:var(--n-accent,#D71921)">Failed To Load Volumes: ${e.message}</div>`;
  }
}

function showAddVolume() {
  $("#volName").value = ""; $("#volPath").value = ""; $("#volError").textContent = "";
  $("#volumeDialog").style.display = "flex";
  renderVolTree();
}

// ===== Volume path picker: dropdown per level (drive → folder → subfolder) =====
async function renderVolTree() {
  const tree = $("#volTree");
  tree.innerHTML = '<span style="color:var(--md-on-surface-variant);font-size:12px">Loading Drives…</span>';
  try {
    const r = await (await fetch("/api/volbrowse?drive=1")).json();
    tree.innerHTML = `<div data-level="0">${r.dirs.map(d => volRow(d, 0)).join("")}</div>`;
  } catch (e) {
    tree.innerHTML = `<span style="color:var(--md-error);font-size:12px">${e.message}</span>`;
  }
}
const volRow = (d, depth) => `
  <div data-p="${encodeURIComponent(d.path)}" style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;cursor:pointer" onmouseover="this.style.background='var(--md-surface-container-high)'" onmouseout="this.style.background=''">
    <span class="msr" style="font-size:18px;color:var(--n-secondary)">${d.isDrive ? "hard_drive" : "folder"}</span>
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" onclick="pickVolPath('${encodeURIComponent(d.path).replace(/'/g, "%27")}')">${esc(d.name)}</span>
    <span class="msr" style="font-size:16px;color:var(--md-on-surface-variant)" onclick="event.stopPropagation(); volDrill(this, '${encodeURIComponent(d.path).replace(/'/g, "%27")}', ${depth + 1})">chevron_right</span>
  </div>`;
// drill down: ganti isi panel dengan isi folder yang diklik (dropdown bertingkat, bukan tree yang membuka semua)
async function volDrill(icon, encPath, depth) {
  const panel = icon.closest("[data-level]");
  if (decodeURIComponent(encPath) === "ROOT") { renderVolTree(); return; }
  try {
    const r = await (await fetch(`/api/volbrowse?path=${encPath}`)).json();
    // tombol back ke level atas (strip folder terakhir; drive root → balik ke daftar drive)
    const cur = decodeURIComponent(encPath);
    const stripped = cur.replace(/[\\/]+$/, "");
    const idx = Math.max(stripped.lastIndexOf("\\"), stripped.lastIndexOf("/"));
    const parent = idx > 2 ? stripped.slice(0, idx + 1) : "";
    const back = `<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:8px;cursor:pointer;color:var(--n-secondary)" onclick="volDrill(this, '${encodeURIComponent(parent || "ROOT").replace(/'/g, "%27")}', ${depth - 1})">
      <span class="msr" style="font-size:18px">arrow_back</span><span style="font-size:12px;font-family:var(--n-f-mono)">${parent || "Drives"}</span></div>`;
    panel.innerHTML = back + (r.dirs.length ? r.dirs.map(d => volRow(d, depth)).join("")
      : '<div style="padding:6px 8px;font-size:11px;color:var(--md-on-surface-variant)">Empty Folder</div>');
  } catch (e) { toast(e.message, "error"); }
}
function pickVolPath(encPath) {
  $("#volPath").value = decodeURIComponent(encPath);
  document.querySelectorAll("#volTree [data-p]").forEach(el => el.style.background = "");
  const el = document.querySelector(`#volTree [data-p="${encPath}"]`);
  if (el) el.style.background = "var(--md-surface-container-highest)";
}

// ===== Profiles =====
let profilesCache = null, activeProfileId = 1;
let appsFilesCache = null;
const PROFILE_COLORS = ["#D71921", "#1a73e8", "#137333", "#f9ab00", "#9334e6", "#e8710a"];
async function refreshProfiles() {
  const r = await (await fetch("/api/profiles")).json();
  profilesCache = r.profiles;
  activeProfileId = r.active;
  const p = profilesCache.find(p => p.id === activeProfileId);
  const av = $("#profileAvatar"), nm = $("#profileName");
  if (av && p) { av.textContent = p.emoji ?? p.name[0].toUpperCase(); av.style.background = p.color; av.style.border = "none"; }
  if (nm && p) nm.textContent = p.name;
  return r;
}
function openProfileDialog() { renderProfileList(); $("#profileDialog").style.display = "flex"; }
function closeProfileDialog() { $("#profileDialog").style.display = "none"; }
function renderProfileList() {
  $("#profileList").innerHTML = profilesCache.map(p => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;cursor:pointer;border:1px solid ${p.id === activeProfileId ? "var(--md-primary)" : "var(--md-outline-variant)"}" onclick="switchProfile(${p.id})">
      <div class="avatar" style="background:${p.color};width:36px;height:36px;font-size:${p.emoji ? "18px" : "15px"}">${p.emoji ?? p.name[0].toUpperCase()}</div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:500">${esc(p.name)}${p.id === activeProfileId ? ' <span style="font-size:10px;color:var(--md-primary);font-weight:600">ACTIVE</span>' : ""}</div>
        <div style="font-size:11px;color:var(--md-on-surface-variant)">${(p.files ?? 0).toLocaleString("en-US")} Files · ${fmtSize(p.size ?? 0)}</div>
      </div>
      <span class="msr" style="color:var(--md-on-surface-variant);font-size:18px;cursor:pointer" onclick="event.stopPropagation(); showEditProfile(${p.id})">edit</span>
      ${p.id !== 1 ? `<span class="msr" style="color:var(--md-on-surface-variant);font-size:18px;cursor:pointer" onclick="event.stopPropagation(); showConfirmDialog('Delete Profile', 'Delete Profile &quot;${esc(p.name.replaceAll('"', ''))}&quot;?', () => deleteProfile(${p.id}))">delete</span>` : ""}    </div>`).join("");
}
function showEditProfile(id) {
  const p = profilesCache.find(p => p.id === id);
  if (!p) return;
  $("#editProfId").value = id;
  $("#editProfName").value = p.name;
  $("#editProfEmoji").value = p.emoji ?? "";
  $("#editProfError").textContent = "";
  $("#editProfColors").innerHTML = PROFILE_COLORS.map(c => `
    <div class="avatar" data-color="${c}" style="background:${c};width:32px;height:32px;font-size:0;cursor:pointer;border:2px solid ${c === p.color ? "var(--md-on-surface)" : "transparent"}" onclick="pickEditColor(this)">${c}</div>`).join("");
  window._editColor = p.color;
  closeProfileDialog();
  $("#editProfileDialog").style.display = "flex";
}
function closeEditProfile() { $("#editProfileDialog").style.display = "none"; }
function pickEditColor(el) {
  window._editColor = el.dataset.color;
  document.querySelectorAll("#editProfColors .avatar").forEach(a => a.style.border = "2px solid transparent");
  el.style.border = "2px solid var(--md-on-surface)";
}
async function saveEditProfile() {
  const id = $("#editProfId").value;
  const body = { name: $("#editProfName").value.trim(), color: window._editColor, emoji: $("#editProfEmoji").value.trim() || null };
  const r = await fetch(`/api/profiles/${id}/edit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("#editProfError").textContent = j.error ?? "Failed"; return; }
  closeEditProfile();
  await refreshProfiles();
  toast("Profile Updated", "edit");
  if ($("#view-dashboard").style.display === "") loadStats();
}
async function switchProfile(id) {
  await fetch("/api/profiles/active", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
  await refreshProfiles();
  closeProfileDialog();
  toast("Profile Switched", "swap_horiz");
  // reload view aktif — semua data scoped per profile
  loadStats(); if ($("#view-dashboard").style.display === "") loadDisk();
  const v = document.querySelector("[data-nav].active")?.dataset.nav;
  if (v === "files") currentDir = ""; // reset explorer root ke profil baru
  if (v && v !== "dashboard") showView(v);
}
async function deleteProfile(id) {
  const r = await fetch(`/api/profiles/${id}`, { method: "DELETE" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return errorToast(j.error ?? "Failed To Delete Profile");
  closeConfirmDialog(); await refreshProfiles(); renderProfileList(); toast("Profile Deleted", "delete");
}
function showAddProfile() {
  closeProfileDialog();
  $("#profName").value = ""; $("#profError").textContent = "";
  $("#profColors").innerHTML = PROFILE_COLORS.map((c, i) => `
    <div class="avatar" data-color="${c}" style="background:${c};width:32px;height:32px;font-size:0;cursor:pointer;border:2px solid ${i === 0 ? "var(--md-on-surface)" : "transparent"}" onclick="pickProfileColor(this)">${c}</div>`).join("");
  window._profColor = PROFILE_COLORS[0];
  $("#addProfileDialog").style.display = "flex";
}
function closeAddProfileDialog() { $("#addProfileDialog").style.display = "none"; }
function pickProfileColor(el) {
  window._profColor = el.dataset.color;
  document.querySelectorAll("#profColors .avatar").forEach(a => a.style.border = "2px solid transparent");
  el.style.border = "2px solid var(--md-on-surface)";
}
async function addProfile() {
  const name = $("#profName").value.trim();
  const r = await fetch("/api/profiles", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, color: window._profColor }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("#profError").textContent = j.error ?? "Failed"; return; }
  closeAddProfileDialog();
  await refreshProfiles();
  openProfileDialog();
  toast("Profile Created", "person_add");
}

// ===== QOL Settings: Phone & ADB + Preferences + Appearance =====
async function loadAdbStatus() {
  const el = $("#adbStatus");
  if (!el) return;
  el.innerHTML = `<div class="set-note" style="padding:8px 0">Loading…</div>`;
  try {
    const st = await (await fetch("/api/adb-status")).json();
    const row = (icon, label, value, color) => `
      <div class="set-row">
        <span class="msr" style="color:${color ?? "var(--n-secondary)"}">${icon}</span>
        <span style="width:150px;font-family:var(--n-f-mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--n-secondary)">${label}</span>
        <span style="flex:1;font-family:var(--n-f-mono);font-size:12px;color:var(--n-primary);text-align:right;word-break:break-all">${value}</span>
      </div>`;
    let html = `<div class="set-card">`;
    html += row(st.adbExists ? "check_circle" : "error", "ADB Binary", st.adbPath || "Not Configured", st.adbExists ? "#1e8e3e" : "var(--n-accent,#D71921)");
    if (st.error) html += row("warning", "ADB Error", st.error, "var(--n-accent,#D71921)");
    if (!st.devices.length) html += row("smartphone", "Devices", "No Device Connected — Plug In Via USB");
    for (const d of st.devices) {
      const ok = d.state === "device";
      html += row(ok ? "smartphone" : "usb_off", d.model || d.id,
        `${d.id} · ${ok ? "Authorized" : d.state}${d.android ? ` · Android ${d.android}` : ""}${d.battery ? ` · Battery ${d.battery.level}%${d.battery.charging ? " (Charging)" : ""}` : ""}`,
        ok ? "#1e8e3e" : "#f9ab00");
    }
    html += `</div>`;
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<div class="set-note" style="color:var(--n-accent,#D71921)">Failed To Load ADB Status: ${e.message}</div>`;
  }
  loadDevicesList();
}

// ===== Multi-device: registry UI (device -> profile mapping) =====
async function loadDevicesList() {
  const el = $("#devicesList");
  if (!el) return;
  try {
    const [devices, profiles] = await Promise.all([
      (await fetch("/api/devices")).json(),
      (await fetch("/api/profiles")).json(),
    ]);
    const profs = profiles.profiles ?? profiles;
    if (!devices.length) {
      el.innerHTML = `<div class="set-card set-note" style="padding:14px 18px">No Devices Registered — Connect A Phone And Back Up Once To Register It.</div>`;
      return;
    }
    el.innerHTML = `<div class="set-card">` + devices.map(d => `
      <div class="set-row" style="align-items:center">
        <span class="msr" style="color:${d.connected ? "#1e8e3e" : "var(--n-secondary)"}">${d.connected ? "smartphone" : "usb_off"}</span>
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--n-f-mono);font-size:12px;color:var(--n-primary)">${esc(d.name || d.serial)}</div>
          <div class="set-row-sub">${d.serial} · ${d.connected ? "Connected" : "Offline"}${d.profile_name ? ` → Profile ${esc(d.profile_name)}` : " → No Profile (Uses Active)"}</div>
        </div>
        <select onchange="assignDeviceProfile('${d.serial}', this.value)" style="padding:5px 8px;border:1px solid var(--n-line);border-radius:0;background:var(--n-surface);color:var(--n-primary);font-family:var(--n-f-mono);font-size:11px">
          <option value="">No Profile</option>
          ${profs.map(p => `<option value="${p.id}" ${p.id === d.profile_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        </select>
        <button class="set-btn-ghost" style="margin-left:8px" onclick="unregisterDevice('${d.serial}')"><span class="msr" style="font-size:16px">delete</span></button>
      </div>`).join("") + `</div>`;
  } catch (e) {
    el.innerHTML = `<div class="set-note" style="color:var(--n-accent,#D71921)">Failed To Load Devices: ${e.message}</div>`;
  }
}

async function assignDeviceProfile(serial, profileId) {
  await fetch("/api/devices", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serial, profileId: profileId ? Number(profileId) : null }) });
  toast(profileId ? "Device Profile Assigned" : "Device Profile Cleared", "devices_other");
  loadDevicesList();
}

async function unregisterDevice(serial) {
  showConfirmDialog(`Unregister Device ${serial}?`, "Backup files in the vault are not affected.", async () => {
    await fetch(`/api/devices/${encodeURIComponent(serial)}`, { method: "DELETE" });
    toast("Device Unregistered", "devices_other");
    loadDevicesList();
  });
}

const PREF_LABELS = {
  trashRetentionDays: { label: "Trash Retention", hint: "Days Before Trash Auto-Purge", min: 1, max: 365 },
  notifyOnBackup: { label: "Desktop Notifications", hint: "Notify When Backup Completes" },
  thumbQuality: { label: "Thumbnail Quality", hint: "WebP Quality 1–100 (Lower = Smaller)", min: 1, max: 100 },
  livePollInterval: { label: "Live Poll Interval", hint: "Ms Between Live Samples (2000–30000)", min: 2000, max: 30000 },
};
let prefs = null;
async function loadServerPrefs() {
  const el = $("#serverPrefs");
  if (!el) return;
  try {
    prefs = await (await fetch("/api/prefs")).json();
    el.innerHTML = `<div class="set-card">${Object.entries(PREF_LABELS).map(([k, p]) => `
      <div class="set-row">
        <div style="flex:1">
          <div class="set-row-name">${p.label}</div>
          <div class="set-row-sub">${p.hint}</div>
        </div>
        ${typeof prefs[k] === "boolean"
          ? `<button class="set-btn-ghost" style="min-width:70px;${prefs[k] ? "background:var(--n-display);color:var(--n-bg);border-color:var(--n-display)" : ""}" onclick="togglePref('${k}')">${prefs[k] ? "On" : "Off"}</button>`
          : `<input type="number" class="set-input-num" value="${prefs[k]}" min="${p.min}" max="${p.max}" onchange="savePref('${k}', this.value)">
             <span class="msr" style="font-size:16px;color:var(--n-accent,#D71921);cursor:pointer" title="Save" onclick="savePref('${k}', this.previousElementSibling.value)">check</span>`}
      </div>`).join("")}</div>`;
  } catch (e) {
    el.innerHTML = `<div class="set-note" style="color:var(--n-accent,#D71921)">Failed To Load Preferences: ${e.message}</div>`;
  }
}
async function savePref(k, v) {
  const p = PREF_LABELS[k];
  if (p.min != null) v = Math.max(p.min, Math.min(p.max, Number(v) || p.min));
  if (typeof prefs[k] === "boolean") v = !prefs[k];
  const r = await fetch("/api/prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [k]: v }) });
  if (r.ok) { prefs[k] = v; toast(`${p.label} Saved`, "tune"); loadServerPrefs(); }
  else errorToast("Failed To Save Preference");
}
const togglePref = (k) => savePref(k, !prefs[k]);

function loadAppearancePrefs() {
  const el = $("#appearancePrefs");
  if (!el) return;
  const theme = localStorage.getItem("nigiro-theme") ?? "light";
  const notifPerm = "Notification" in window ? Notification.permission : "unsupported";
  el.innerHTML = `<div class="set-card">
    <div class="set-row">
      <div style="flex:1">
        <div class="set-row-name">Theme</div>
        <div class="set-row-sub">Light Or Dark, Applied Instantly</div>
      </div>
      <button class="set-btn-ghost" style="min-width:110px;${theme === "dark" ? "background:var(--n-display);color:var(--n-bg);border-color:var(--n-display)" : ""}" onclick="applyTheme('${theme === "dark" ? "light" : "dark"}'); loadAppearancePrefs();">Switch To ${theme === "dark" ? "Light" : "Dark"}</button>
    </div>
    <div class="set-row">
      <div style="flex:1">
        <div class="set-row-name">Notification Permission</div>
        <div class="set-row-sub">Browser Permission For "Backup Completed" Notifications</div>
      </div>
      <span class="set-row-sub" style="font-weight:700;color:${notifPerm === "granted" ? "#1e8e3e" : notifPerm === "denied" ? "var(--n-accent,#D71921)" : "var(--n-secondary)"}">${notifPerm === "granted" ? "Granted" : notifPerm === "denied" ? "Blocked" : notifPerm === "unsupported" ? "Unsupported" : "Not Asked"}</span>
      ${notifPerm === "default" ? `<button class="set-btn-ghost" style="min-width:90px" onclick="Notification.requestPermission().then(() => loadAppearancePrefs())">Allow</button>` : ""}
    </div>
    <div class="set-row">
      <div style="flex:1">
        <div class="set-row-name">Keyboard Shortcuts</div>
        <div class="set-row-sub">← → Navigate · F Favorite · I Info · Esc Close · / Search</div>
      </div>
    </div>
  </div>`;
}
async function loadSettingsAll() { loadVolumes(); loadAdbStatus(); loadServerPrefs(); loadAppearancePrefs(); refreshProfiles(); loadDbBackupStatus(); loadRecoveryStatus(); }

// ===== Password recovery (security question) =====
async function loadRecoveryStatus() {
  const el = $("#recoveryExisting");
  if (!el) return;
  try {
    const r = await (await fetch("/api/recovery/question"));
    if (!r.ok) throw 0;
    const j = await r.json();
    el.innerHTML = `Question Set: <b style="color:var(--n-primary)">${esc(j.question)}</b>`;
  } catch { el.textContent = "No Recovery Question Set Yet."; }
}
async function saveRecovery() {
  const q = $("#recQ").value.trim(), a = $("#recA").value;
  const st = $("#recStatus");
  if (q.length < 3 || a.trim().length < 2) { st.textContent = "Question 3+ Characters, Answer 2+ Characters."; st.style.color = "var(--n-accent,#D71921)"; return; }
  const r = await fetch("/api/recovery/set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q, answer: a }) });
  if (r.ok) { st.textContent = "Recovery Question Saved."; st.style.color = "#1e8e3e"; $("#recQ").value = ""; $("#recA").value = ""; toast("Recovery Question Saved", "shield"); loadRecoveryStatus(); }
  else { st.textContent = (await r.json().catch(() => ({}))).error ?? "Failed To Save"; st.style.color = "var(--n-accent,#D71921)"; }
}

// ===== Folder migration =====
// ===== Documents view =====
const DOC_ICONS = { doc: "article", docx: "article", xls: "table_chart", xlsx: "table_chart", ppt: "slideshow", pptx: "slideshow", txt: "text_snippet", csv: "csv", rtf: "article", odt: "article", ods: "table_chart", odp: "slideshow" };
const DOC_TYPES = [
  { key: "pdf", label: ".PDF", match: f => f.mime === "application/pdf" || f.original_name.toLowerCase().endsWith(".pdf") },
  { key: "word", label: ".DOC / .DOCX", match: f => /\.(docx?|odt|rtf)$/i.test(f.original_name) },
  { key: "excel", label: ".XLS / .XLSX / .CSV", match: f => /\.(xlsx?|ods|csv)$/i.test(f.original_name) },
  { key: "ppt", label: ".PPT / .PPTX", match: f => /\.(pptx?|odp)$/i.test(f.original_name) },
  { key: "text", label: ".TXT", match: f => /\.txt$/i.test(f.original_name) },
];
let docsFilter = [];
let docsLayout = localStorage.getItem("docsLayout") || "grid";
let docsPage = 1;
const DOCS_PER_PAGE = 20;

let _docsCache = [];
async function loadDocuments() {
  _docsCache = await (await fetch("/api/documents")).json();
  renderDocs();
}
function renderDocs() {
  const list = $("#docsList");
  list.innerHTML = "";
  const q = ($("#docsSearch")?.value ?? "").toLowerCase();
  let files = docsFilter.length ? _docsCache.filter(f => DOC_TYPES.filter(t => docsFilter.includes(t.key)).some(t => t.match(f))) : _docsCache;
  if (q) files = files.filter(f => f.original_name.toLowerCase().includes(q));
  // pagination 20/page — reset ke halaman 1 kalau halaman sekarang lewat batas
  const totalPages = Math.max(1, Math.ceil(files.length / DOCS_PER_PAGE));
  if (docsPage > totalPages) docsPage = 1;
  const pageFiles = files.slice((docsPage - 1) * DOCS_PER_PAGE, docsPage * DOCS_PER_PAGE);
  $("#docsEmpty").style.display = files.length ? "none" : "block";
  $("#docsEmpty").querySelector("p").textContent = q ? "No Documents Match Your Search." : "No Documents Backed Up Yet.";
  // pager (sembunyikan kalau cuma 1 halaman)
  const pager = $("#docsPager");
  if (totalPages <= 1) { pager.style.display = "none"; }
  else {
    pager.style.display = "flex";
    $("#docsPageInfo").textContent = `Page ${docsPage.toLocaleString("en-US")} Of ${totalPages.toLocaleString("en-US")} — ${files.length.toLocaleString("en-US")} Documents`;
    $("#docsPrevBtn").disabled = docsPage <= 1;
    $("#docsNextBtn").disabled = docsPage >= totalPages;
  }
  // filter button label (mirip gallery)
  const active = docsFilter.length > 0;
  $("#docsFilterLabel").textContent = active
    ? `Filter: ${DOC_TYPES.filter(t => docsFilter.includes(t.key)).map(t => t.label).join(", ")}`
    : "Filter";
  // aktif = inversi Nothing (n-btn-outline jadi solid)
  const fb = $("#docsFilterBtn");
  fb.style.background = active ? "var(--n-display)" : "transparent";
  fb.style.color = active ? "var(--n-bg)" : "var(--n-primary)";
  fb.style.borderColor = active ? "var(--n-display)" : "var(--n-line-2)";
  // layout: grid = kartu kotak Nothing; details = hairline rows (kayak Files view)
  const grid = docsLayout === "grid";
  $("#docsLayoutIcon").textContent = grid ? "view_list" : "grid_view";
  if (grid) {
    list.style.display = "grid";
    list.style.gridTemplateColumns = "repeat(auto-fill,minmax(280px,1fr))";
    list.style.gap = "0";
    list.style.border = "1px solid var(--n-line)";
    for (const f of pageFiles) {
      const ext = f.original_name.split(".").pop().toLowerCase();
      const isPdf = ext === "pdf";
      const nm = esc(f.original_name.replaceAll("'", "\\'"));
      list.insertAdjacentHTML("beforeend", `
        <div class="doc-card" style="padding:14px 16px;border-right:1px solid var(--n-line);border-bottom:1px solid var(--n-line);cursor:${isPdf ? "pointer" : "default"}" ${isPdf ? `onclick="previewPdf(${f.id}, '${nm}')"` : ""}>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
            ${isPdf
              ? `<img src="/media/${f.id}/thumb" style="width:44px;height:58px;object-fit:cover;border:1px solid var(--n-line);display:block" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'msr',textContent:'picture_as_pdf',style:'font-size:26px;color:var(--n-secondary)'}))">`
              : `<span class="msr" style="font-size:26px;color:var(--n-secondary)">${DOC_ICONS[ext] ?? "article"}</span>`}
            <span style="font-family:var(--n-f-mono);font-size:9px;letter-spacing:.1em;color:var(--n-secondary);border:1px solid var(--n-line);padding:2px 7px">${ext.toUpperCase()}</span>
          </div>
          <div style="font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--n-primary)">${esc(f.original_name)}</div>
          <div style="font-family:var(--n-f-mono);font-size:10px;color:var(--n-secondary);letter-spacing:.04em;margin-top:5px">${fmtSize(f.size)} · ${new Date(f.mtime * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
          <div style="display:flex;gap:2px;margin-top:10px;opacity:.85">
            <button class="crumb" title="Info" onclick="event.stopPropagation();showDocInfo(${f.id})"><span class="msr" style="font-size:15px;vertical-align:-3px">info</span></button>
            <button class="crumb" title="Rename" onclick="event.stopPropagation();showDocRename(${f.id},'${nm}')"><span class="msr" style="font-size:15px;vertical-align:-3px">edit</span></button>
            <button class="crumb" title="Move To Trash" onclick="event.stopPropagation();docTrash(${f.id},'${nm}')"><span class="msr" style="font-size:15px;vertical-align:-3px">delete</span></button>
            <a href="/media/${f.id}" download="${esc(f.original_name)}" style="text-decoration:none" onclick="event.stopPropagation()"><button class="crumb" title="Download"><span class="msr" style="font-size:15px;vertical-align:-3px">download</span></button></a>
          </div>
        </div>`);
    }
  } else {
    list.style.display = "block";
    list.style.border = "1px solid var(--n-line)";
    // thumbnail di kiri (kotak), nama + info di kanan (nama di atas info) — tanpa nomor urut
    pageFiles.forEach((f) => {
      const ext = f.original_name.split(".").pop().toLowerCase();
      const isPdf = ext === "pdf";
      const nm = esc(f.original_name.replaceAll("'", "\\'"));
      list.insertAdjacentHTML("beforeend", `
        <div class="doc-row" style="display:flex;align-items:center;gap:14px;padding:10px 14px;cursor:${isPdf ? "pointer" : "default"}" ${isPdf ? `onclick="previewPdf(${f.id}, '${nm}')"` : ""}>
          ${isPdf
            ? `<img src="/media/${f.id}/thumb" style="width:44px;height:58px;object-fit:cover;border:1px solid var(--n-line);flex-shrink:0" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'msr',textContent:'picture_as_pdf',style:'font-size:30px;color:var(--n-secondary)'}))">`
            : `<span style="width:44px;height:58px;border:1px solid var(--n-line);display:grid;place-items:center;flex-shrink:0"><span class="msr" style="font-size:26px;color:var(--n-secondary)">${DOC_ICONS[ext] ?? "article"}</span></span>`}
          <span style="flex:1;min-width:0">
            <span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--n-primary)">${esc(f.original_name)}</span>
            <span style="display:block;font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary);letter-spacing:.04em;margin-top:4px">${fmtSize(f.size)} · ${new Date(f.mtime * 1000).toLocaleDateString("en-US")} · <span style="border:1px solid var(--n-line);padding:1px 6px">${ext.toUpperCase()}</span></span>
          </span>
          <span style="display:flex;gap:2px;flex-shrink:0">
            <button class="crumb" title="Info" onclick="event.stopPropagation();showDocInfo(${f.id})"><span class="msr" style="font-size:15px;vertical-align:-3px">info</span></button>
            <button class="crumb" title="Rename" onclick="event.stopPropagation();showDocRename(${f.id},'${nm}')"><span class="msr" style="font-size:15px;vertical-align:-3px">edit</span></button>
            <button class="crumb" title="Move To Trash" onclick="event.stopPropagation();docTrash(${f.id},'${nm}')"><span class="msr" style="font-size:15px;vertical-align:-3px">delete</span></button>
            <a href="/media/${f.id}" download="${esc(f.original_name)}" style="text-decoration:none" onclick="event.stopPropagation()"><button class="crumb" title="Download"><span class="msr" style="font-size:15px;vertical-align:-3px">download</span></button></a>
          </span>
        </div>`);
    });
  }
  // img lazy yang dibuat saat view hidden kadang gak pernah trigger load — re-set src setelah view tampil
  setTimeout(() => [...list.querySelectorAll("img")].forEach(i => { if (!i.complete && !i.dataset.retried) { i.dataset.retried = 1; i.src = i.src; } }), 500);
}
function toggleDocsLayout() {
  docsLayout = docsLayout === "grid" ? "details" : "grid";
  localStorage.setItem("docsLayout", docsLayout);
  renderDocs();
}
function docsGoPage(d) {
  docsPage = Math.max(1, docsPage + d);
  renderDocs();
  $("#docsList").scrollIntoView({ behavior: "smooth", block: "start" });
}
function showDocsFilterDialog() {
  const pill = (label, active, onclick) => `<button class="n-btn" style="padding:6px 14px;font-size:12px;${active ? "background:var(--n-display);color:var(--n-bg)" : ""}" onclick="${onclick}">${active ? '<span class="msr" style="font-size:14px;vertical-align:-3px;margin-right:4px">check</span>' : ""}${label}</button>`;
  $("#docsFilterTypes").innerHTML = DOC_TYPES.map(t => pill(t.label, docsFilter.includes(t.key), `setDocsFilter('${t.key}')`)).join("");
  $("#docsFilterReset").style.display = docsFilter.length ? "inline-block" : "none";
  $("#docsFilterDialog").style.display = "flex";
}
function closeDocsFilterDialog() { $("#docsFilterDialog").style.display = "none"; }

// realtime volume health via SSE — re-render penuh list saat ada perubahan
const es = new EventSource("/api/events");
// alert badge di topbar — dot merah dengan jumlah alert aktif
function updateAlertBadge(active) {
  const slot = $("#alertBadgeSlot");
  if (!slot) return;
  slot.innerHTML = active?.length
    ? `<span title="${active.length} Active Alert(s)" style="font-family:var(--n-f-mono);font-size:9px;letter-spacing:.06em;background:var(--n-accent,#D71921);color:#fff;padding:2px 7px;border-radius:999px">${active.length}</span>`
    : "";
}
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "alerts") {
    // realtime alert push — refresh banner + card colors if monitoring visible
    if ($("#view-monitoring")?.style.display !== "none") { fetch("/api/alerts").then(r => r.json()).then(() => drawMonitoring()).catch(() => {}); }
    updateAlertBadge(msg.active);
    return;
  }
  if (msg.type !== "volumes") return;
  // rebuild tiap row dari payload — add/remove/rename langsung kebentuk ulang
  for (const v of msg.volumes) {
    let row = document.querySelector(`#volumeList .card[data-id="${v.id}"]`);
    if (!row) {
      // volume baru — render row lengkap
      row = document.createElement("div");
      row.className = "card";
      row.dataset.id = v.id;
      row.style.cssText = "padding:12px 14px;display:flex;align-items:center;gap:12px";
      row.innerHTML = `
        <span class="msr" style="font-size:18px;color:var(--md-primary)">hard_drive</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500">${esc(v.name)}${v.primary ? ' <span class="n-btn" style="padding:1px 6px;font-size:9px">Primary</span>' : ""}</div>
          <div style="font-size:11px;color:var(--md-on-surface-variant)">${esc(v.root)}</div>
        </div>
        <span class="vol-status" style="font-family:var(--n-f-mono);font-size:11px">○ checking…</span>`;
      $("#volumeList").appendChild(row);
    }
    const dot = row.querySelector(".vol-status");
    if (dot) {
      dot.textContent = v.online ? "● online" : "○ offline";
      dot.classList.toggle("offline", !v.online);
      if (v.online) {
        const el = row.querySelector("[data-free]");
        if (el) el.textContent = fmtSize(v.free);
      }
    }
  }
  // hapus row yang gak ada lagi di payload (volume dihapus di tempat lain / HP dicabut)
  const ids = new Set(msg.volumes.map(v => String(v.id)));
  document.querySelectorAll("#volumeList .card[data-id]").forEach(row => {
    if (!ids.has(row.dataset.id)) row.remove();
  });
};
function setDocsFilter(k) {
  docsFilter = docsFilter.includes(k) ? docsFilter.filter(x => x !== k) : [...docsFilter, k];
  docsPage = 1;
  showDocsFilterDialog();
  renderDocs();
}
function resetDocsFilter() { docsFilter = []; docsPage = 1; closeDocsFilterDialog(); renderDocs(); }

// rename + trash dokumen
function showDocRename(id, name) {
  showPromptDialog("Rename Document", "Enter A New Name For This File.", name, async (newName) => {
    if (!newName || newName === name) return;
    const r = await (await fetch(`/api/files/${id}/rename`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newName })
    })).json();
    if (r.error) return errorToast(r.error);
    toast(`Renamed To: ${newName}`, "edit");
    _docsCache = await (await fetch("/api/documents")).json();
    renderDocs();
  });
}
function docTrash(id, name) {
  showConfirmDialog("Move To Trash", `Move "${name}" To Trash? You Can Restore It Later.`, async () => {
    closeConfirmDialog();
    const r = await (await fetch(`/api/media-trash/${id}`, { method: "POST" })).json();
    if (r.error) return errorToast(r.error);
    toast(`Moved To Trash: ${name}`, "delete");
    _docsCache = await (await fetch("/api/documents")).json();
    renderDocs();
  });
}
// info dialog: lokasi file di HDD + metadata
function showDocInfo(id) {
  const f = _docsCache.find(x => x.id === id);
  if (!f) return;
  showInfoDialog("File Info", [
    ["Name", f.original_name],
    ["Location", f.local_path],
    ["Size", fmtSize(f.size)],
    ["Modified", new Date(f.mtime * 1000).toLocaleString("en-US")],
    ["Type", f.mime || "Unknown"],
  ]);
}
// dialog info generik: daftar label/value, value mono + selectable (lokasi perlu bisa di-copy)
function showInfoDialog(title, rows) {
  let m = $("#infoDialog");
  if (!m) {
    m = document.createElement("div");
    m.id = "infoDialog";
    m.className = "dialog-backdrop";
    m.style.display = "none";
    m.innerHTML = `<div class="dialog" style="width:min(560px,92vw)">
      <h3 id="ifd-title" style="margin:0 0 14px;font-size:17px;font-weight:500"></h3>
      <div id="ifd-rows" style="display:flex;flex-direction:column;gap:0;border:1px solid var(--n-line);margin-bottom:18px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="crumb" onclick="closeInfoDialog()">Close</button></div>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener("click", (e) => { if (e.target === m) closeInfoDialog(); });
  }
  $("#ifd-title").textContent = title;
  $("#ifd-rows").innerHTML = rows.map(([k, v], i) => `
    <div style="display:grid;grid-template-columns:110px 1fr;gap:12px;padding:9px 12px;${i < rows.length - 1 ? "border-bottom:1px solid var(--n-line);" : ""}">
      <span style="font-family:var(--n-f-mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--n-secondary);padding-top:2px">${esc(k)}</span>
      <span style="font-family:var(--n-f-mono);font-size:12px;color:var(--n-primary);word-break:break-all;user-select:text">${esc(v)}</span>
    </div>`).join("");
  m.style.display = "flex";
}
function closeInfoDialog() { const m = $("#infoDialog"); if (m) m.style.display = "none"; }

// prompt dialog global (pengganti prompt(), M3)
let _promptCb = null;
function showPromptDialog(title, body, value, onOk, hint) {
  _promptCb = onOk;
  $("#pd-title").textContent = title;
  $("#pd-body").textContent = body;
  const hintEl = $("#pd-hint");
  if (hintEl) { hintEl.textContent = hint ?? ""; hintEl.style.display = hint ? "block" : "none"; }
  const inp = $("#pd-input");
  inp.value = value ?? "";
  $("#promptDialog").style.display = "flex";
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
}
function closePromptDialog() { $("#promptDialog").style.display = "none"; _promptCb = null; }
function _promptOk() { const v = $("#pd-input").value.trim(); const cb = _promptCb; closePromptDialog(); cb?.(v); }
document.addEventListener("keydown", e => {
  if ($("#promptDialog")?.style.display !== "flex") return;
  if (e.key === "Enter") _promptOk();
  if (e.key === "Escape") closePromptDialog();
});
function previewPdf(id, name) {
  $("#pdfTitle").textContent = name;
  $("#pdfDownload").href = `/media/${id}`;
  $("#pdfFrame").src = `/media/${id}`;
  $("#pdfDialog").style.display = "flex";
}
function closePdfDialog() { $("#pdfFrame").src = ""; $("#pdfDialog").style.display = "none"; }

// ===== DB backup =====
async function loadDbBackupStatus() {
  const el = $("#dbBackupStatus");
  if (!el) return;
  try {
    const r = await (await fetch("/api/db-backup")).json();
    $("#dbBackupPath").value = r.dir;
    el.innerHTML = r.last
      ? `Last Backup: <b>${new Date(r.last).toLocaleString("en-US")}</b> · ${r.backups.length} Backup(s) — ${r.dir}`
      : "No Backup Yet.";
  } catch { el.textContent = "Status Unavailable."; }
  // tree picker (reuse volbrowse, tapi klik = pilih folder backup)
  const tree = $("#dbBackupTree");
  try {
    const r = await (await fetch("/api/volbrowse?drive=1")).json();
    tree.innerHTML = `<div data-level="0">${r.dirs.map(d => dbBkRow(d, 0)).join("")}</div>`;
  } catch { tree.innerHTML = '<span style="color:var(--n-accent,#D71921);font-size:12px">Failed To Load Drives</span>'; }
}
const dbBkRow = (d, depth) => `
  <div data-p="${encodeURIComponent(d.path)}" style="display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer" onmouseover="this.style.background='var(--n-raised)'" onmouseout="this.style.background=''">
    <span class="msr" style="font-size:18px;color:var(--n-secondary)">${d.isDrive ? "hard_drive" : "folder"}</span>
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" onclick="pickDbBkPath('${encodeURIComponent(d.path).replace(/'/g, "%27")}')">${esc(d.name)}</span>
    <span class="msr" style="font-size:16px;color:var(--n-muted)" onclick="event.stopPropagation(); dbBkDrill(this, '${encodeURIComponent(d.path).replace(/'/g, "%27")}', ${depth + 1})">chevron_right</span>
  </div>`;
async function dbBkDrill(icon, encPath, depth) {
  const panel = icon.closest("[data-level]");
  if (decodeURIComponent(encPath) === "ROOT") { loadDbBackupStatus(); return; }
  try {
    const r = await (await fetch(`/api/volbrowse?path=${encPath}`)).json();
    const cur = decodeURIComponent(encPath);
    const stripped = cur.replace(/[\\/]+$/, "");
    const idx = Math.max(stripped.lastIndexOf("\\"), stripped.lastIndexOf("/"));
    const parent = idx > 2 ? stripped.slice(0, idx + 1) : "";
    const back = `<div style="display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;color:var(--n-secondary)" onclick="dbBkDrill(this, '${encodeURIComponent(parent || "ROOT").replace(/'/g, "%27")}', ${depth - 1})">
      <span class="msr" style="font-size:18px">arrow_back</span><span style="font-size:12px;font-family:var(--n-f-mono)">${parent || "Drives"}</span></div>`;
    panel.innerHTML = back + (r.dirs.length ? r.dirs.map(d => dbBkRow(d, depth)).join("")
      : '<div style="padding:6px 8px;font-size:11px;color:var(--n-secondary)">Empty Folder</div>');
  } catch (e) { toast(e.message, "error"); }
}
function pickDbBkPath(encPath) {
  $("#dbBackupPath").value = decodeURIComponent(encPath);
  document.querySelectorAll("#dbBackupTree [data-p]").forEach(el => el.style.background = "");
  const el = document.querySelector(`#dbBackupTree [data-p="${encPath}"]`);
  if (el) el.style.background = "var(--n-line)";
}
async function saveDbBackupPath() {
  const r = await fetch("/api/db-backup/location", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dir: $("#dbBackupPath").value.trim() }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return toast(j.error ?? "Failed", "error");
  toast("Backup Location Saved", "save");
  loadDbBackupStatus();
}
async function runDbBackup() {
  const r = await (await fetch("/api/db-backup", { method: "POST" })).json();
  if (r.ok) toast("Database Backed Up", "database");
  else toast("Backup Failed: " + r.error, "error");
  loadDbBackupStatus();
}

// ===== Integrity report =====
async function doLogout() {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
}

async function changePassword(btn) {
  const oldPass = $("#pwOld").value, newPass = $("#pwNew").value;
  const st = $("#pwStatus");
  if (!oldPass || !newPass) { st.textContent = "Isi Kedua Field"; st.style.color = "var(--n-accent,#D71921)"; return; }
  btn.disabled = true;
  const r = await fetch("/api/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ oldPass, newPass }) }).then(r => r.json()).catch(() => ({ error: "gagal" }));
  btn.disabled = false;
  st.textContent = r.error ?? "Password Changed";
  st.style.color = r.error ? "var(--n-accent,#D71921)" : "var(--md-on-surface-variant)";
  if (!r.error) { $("#pwOld").value = ""; $("#pwNew").value = ""; toast("Password Changed"); }
}

// ===== Rescan Vault UI: kick off + poll progress =====
async function runRescan() {
  const el = $("#rescanResult");
  const start = await fetch("/api/rescan", { method: "POST" });
  if (!start.ok) { el.innerHTML = `<div class="set-card set-note" style="padding:14px 18px;color:var(--n-accent,#D71921)">${((await start.json().catch(() => ({}))).error) ?? "Failed To Start"}</div>`; return; }
  toast("Rescan Started", "folder_open");
  const render = (j) => {
    if (j.running || !j.finishedAt) {
      el.innerHTML = `<div class="set-card set-note" style="padding:14px 18px" id="rescanProg">Scanning Vault… ${j.done.toLocaleString("en-US")} / ${j.total.toLocaleString("en-US")} Files · ${j.imported.toLocaleString("en-US")} Imported · ${j.dupes.toLocaleString("en-US")} Duplicates</div>`;
      return;
    }
    const rows = j.log.map(l => `<div style="padding:1px 0;color:${l.startsWith("GAGAL") || l.startsWith("FATAL") ? "var(--n-accent,#D71921)" : l.startsWith("SKIP") || l.startsWith("DUP") ? "var(--n-secondary)" : "var(--n-primary)"}">${esc(l)}</div>`).join("");
    el.innerHTML = `<div class="set-card" style="padding:14px 18px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span class="msr" style="color:${j.failed ? "#f9ab00" : "#1e8e3e"}">${j.failed ? "warning" : "check_circle"}</span>
        <span class="set-row-name">Rescan Complete</span>
        <span class="set-row-sub" style="margin-left:auto">${j.imported.toLocaleString("en-US")} Imported · ${j.dupes.toLocaleString("en-US")} Duplicates · ${j.failed.toLocaleString("en-US")} Failed</span>
      </div>
      ${rows ? `<div class="set-row-sub" style="max-height:160px;overflow-y:auto;font-size:10px">${rows}</div>` : "Nothing New — Vault Already In Sync."}
    </div>`;
  };
  let j = await (await fetch("/api/rescan/status")).json();
  render(j);
  while (j.running) {
    await new Promise(res => setTimeout(res, 1000));
    j = await (await fetch("/api/rescan/status")).json();
    render(j);
  }
}

async function runIntegrity() {
  const el = $("#integrityResult");
  // kick off job (atau dapat status job yang sedang jalan)
  let r = await (await fetch("/api/integrity")).json();
  if (r.running) {
    el.innerHTML = `<div class="set-card set-note" style="padding:14px 18px" id="integProg">Scanning… 0 / 0 Files</div>`;
    // poll sampai selesai (job-based, server tetap responsif selama scan)
    while (r.running) {
      await new Promise(res => setTimeout(res, 1000));
      r = await (await fetch("/api/integrity")).json();
      const p = $("#integProg");
      if (p && r.running) p.textContent = `Scanning… ${r.done.toLocaleString("en-US")} / ${r.total.toLocaleString("en-US")} Files`;
      if (!p && !r.running) break;
    }
    if (r.running) return; // tab Ditutup mid-poll
  }
  const item = (t, list) => list.length ? `<div style="margin-bottom:10px">
    <div style="font-family:var(--n-f-mono);font-size:11px;font-weight:700;color:var(--n-accent,#D71921)">${t} (${list.length.toLocaleString("en-US")})</div>
    <div class="set-row-sub" style="max-height:140px;overflow-y:auto">${list.slice(0, 100).map(x => typeof x === "string" ? x : x.path).join("<br>")}</div></div>` : "";
  if (r.error) { el.innerHTML = `<div class="set-card set-note" style="padding:14px 18px;color:var(--n-accent,#D71921)">Scan Failed: ${r.error}</div>`; return; }
  const healthy = !r.missing.length && !r.mismatch.length && !r.untrackedCount;
  el.innerHTML = `<div class="set-card" style="padding:14px 18px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:${healthy ? 0 : 12}px">
      <span class="msr" style="color:${healthy ? "#1e8e3e" : "var(--n-accent,#D71921)"}">${healthy ? "check_circle" : "warning"}</span>
      <span class="set-row-name">${healthy ? "All Healthy" : "Issues Found"}</span>
      <span class="set-row-sub" style="margin-left:auto">${r.total.toLocaleString("en-US")} Files Tracked</span>
    </div>
    ${item("Missing On Disk", r.missing)}${item("Checksum Mismatch", r.mismatch)}${item(`Untracked On Disk (${r.untrackedCount} total, showing ${Math.min(r.untrackedCount, 100)})`, r.untracked)}
  </div>`;
}
function closeVolumeDialog() { $("#volumeDialog").style.display = "none"; }

async function addVolume() {
  const name = $("#volName").value.trim(), root = $("#volPath").value.trim();
  const r = await (await fetch("/api/volumes", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, root }),
  })).json();
  if (r.error) { $("#volError").textContent = r.error; return; }
  closeVolumeDialog();
  toast(`Volume Added: ${name}`, "save");
  loadVolumes();
}

async function removeVolume(name) {
  const r = await (await fetch(`/api/volumes/${encodeURIComponent(name)}`, { method: "DELETE" })).json();
  if (r.error) { toast(r.error, "error"); return; }
  toast(`Volume Removed: ${name}`, "delete");
  loadVolumes();
}

async function setPrimaryVolume(name) {
  await fetch(`/api/volumes/${encodeURIComponent(name)}/primary`, { method: "POST" });
  toast(`${name} Is Now Primary`, "save");
  loadVolumes();
}

function showRenameVolume(oldName) {
  $("#rvOld").value = oldName;
  $("#rvName").value = oldName;
  $("#rvError").textContent = "";
  $("#renameVolumeDialog").style.display = "flex";
}
function closeRenameVolume() { $("#renameVolumeDialog").style.display = "none"; }
async function saveRenameVolume() {
  const oldName = $("#rvOld").value;
  const r = await fetch(`/api/volumes/${encodeURIComponent(oldName)}/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: $("#rvName").value.trim() }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { $("#rvError").textContent = j.error ?? "Failed"; return; }
  closeRenameVolume();
  toast("Volume Renamed", "edit");
  loadVolumes();
  if ($("#view-dashboard").style.display === "") loadStats(); // storage cards di dashboard ikut
}

async function moveAllTo(name) {
  showConfirmDialog(`Move All Files To "${name}"?`, `All Files From Every Volume Will Be Moved To "${name}". This May Take A While For Large Vaults.`, async () => {    toast(`Moving Files To ${name}…`, "save");
    const r = await (await fetch(`/api/volumes/${encodeURIComponent(name)}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
    if (r.error) { toast(r.error, "error"); return; }
    toast(r.failed ? `Moved ${r.moved}, Failed ${r.failed}` : `Moved ${r.moved} Files To ${name}`, r.failed ? "error" : "save");
    loadVolumes();
  });
}

async function backupContacts() {
  closeBackupDialog();
  const btn = $("#syncBtn2");
  btn.disabled = true;
  $("#status").textContent = "Backing Up Contacts & SMS…";
  try {
    const r = await (await fetch("/api/backup-contacts", { method: "POST" })).json();
    if (r.error) throw new Error(r.error);
    let msg = `✅ ${r.contacts} Contacts (VCF), ${r.sms} SMS Saved To Contacts Folder`;
    if (r.calls) msg += `, ${r.calls} Call Log`;
    if (r.callLogDenied) msg += " — Call Log Requires Permission On The Phone, Skipped.";
    $("#status").textContent = msg;
    toast(`${r.contacts} Contacts · ${r.sms} SMS Backed Up`, "contacts");
  } catch (e) {
    $("#status").textContent = "❌ " + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ===== File preview (PDF/TXT/gambar/video/audio dari HDD) =====
const PREVIEWABLE = {
  pdf: "pdf", jpg: "img", jpeg: "img", png: "img", webp: "img", gif: "img", heic: "img",
  mp4: "vid", webm: "vid", mkv: "vid", mov: "vid",
  mp3: "aud", wav: "aud", ogg: "aud", m4a: "aud",
  txt: "text", csv: "text", log: "text", md: "text", json: "text", html: "text", xml: "text", js: "text", py: "text",
};

function openPreview(relPath) {
  const name = relPath.split("/").pop();
  const ext = name.toLowerCase().split(".").pop();
  const kind = PREVIEWABLE[ext];
  const url = `/api/rawfile?path=${encodeURIComponent(relPath)}`;
  const body = $("#fp-body");
  $("#fp-name").textContent = name;
  $("#fp-download").href = url;
  $("#fp-icon").textContent = iconFor({ name, isDir: false });
  body.innerHTML = "";

  if (!kind) {
    body.style.background = "var(--md-surface)";
    body.innerHTML = `<div style="text-align:center;color:var(--md-on-surface-variant);padding:40px">
      <span class="msr" style="font-size:56px">visibility_off</span>
      <p style="margin-top:8px">No preview available for <b>.${ext}</b></p>
      <p style="font-size:12px">Use the download button to save this file.</p></div>`;
  } else if (kind === "pdf") {
    body.style.background = "#525659";
    body.innerHTML = `<iframe src="${url}" style="width:100%;height:100%;border:none"></iframe>`;
  } else if (kind === "img") {
    body.style.background = "#131314";
    body.innerHTML = `<img src="${url}" style="max-width:100%;max-height:100%;object-fit:contain">`;
  } else if (kind === "vid") {
    body.style.background = "#131314";
    body.innerHTML = `<video src="${url}" controls autoplay style="max-width:100%;max-height:100%"></video>`;
  } else if (kind === "aud") {
    body.style.background = "var(--md-surface)";
    body.innerHTML = `<div style="text-align:center;padding:40px">
      <span class="msr" style="font-size:64px;color:var(--md-primary)">audio_file</span>
      <audio src="${url}" controls autoplay style="display:block;margin:16px auto 0;width:min(400px,80%)"></audio></div>`;
  } else if (kind === "text") {
    body.style.background = "var(--md-surface)";
    fetch(url).then(r => r.text()).then(t => {
      body.innerHTML = `<pre style="margin:0;padding:20px;font-size:13px;font-family:'JetBrains Mono',monospace;white-space:pre-wrap;word-break:break-word;width:100%;box-sizing:border-box">${t.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</pre>`;
    }).catch(() => { body.innerHTML = '<p style="padding:20px;color:var(--md-error)">Failed to load file.</p>'; });
  }
  $("#filePreview").style.display = "flex";
}

function closePreview() {
  $("#filePreview").style.display = "none";
  $("#fp-body").innerHTML = ""; // stop video/audio playback
}

function setFileView(v) {
  fileView = v;
  $("#vt-details").classList.toggle("active", v === "details");
  $("#vt-grid").classList.toggle("active", v === "grid");
  renderFiles();
}

// event delegation: satu listener untuk seluruh listing (click/dblclick/ctxmenu)
document.addEventListener("click", (e) => {
  const row = e.target.closest("#fileList .frow, #fileList .fcard");
  if (row && !row.classList.contains("fhead") && !e.target.closest("input, button")) fmClick(e, row);
  else if (e.target.closest("#fileList") && !e.target.closest("input, button")) fmClearSel();
});
document.addEventListener("dblclick", (e) => {
  const row = e.target.closest("#fileList .frow, #fileList .fcard");
  if (row && !row.classList.contains("fhead")) {
    // elemen mungkin detached (re-render setelah rubber band) — resolve ulang by path biar tetap buka
    const live = document.querySelector(`#fileList [data-path="${CSS.escape(row.dataset.path)}"]`) ?? row;
    fmDblClick(live);
  }
});
document.addEventListener("contextmenu", (e) => {
  const row = e.target.closest("#fileList .frow, #fileList .fcard");
  if (row && !row.classList.contains("fhead")) fmItemMenu(e, row);
  else if (e.target.closest("#view-files")) fmEmptyMenu(e);
});

refreshStatus();
setInterval(refreshStatus, 3000);
// devices list auto-refresh tiap 15s: device baru nyolok langsung muncul di Settings tanpa manual reload
setInterval(() => { if ($("#devicesList")) loadDevicesList(); }, 15000);
showView("dashboard");

// ===== Monitoring — Windows Task Manager style =====
let monTimer = null, monSel = "cpu";
const monHist = {}; // key -> ring buffer (60 samples = 120s @2s tick)
const pushH = (k, v) => { (monHist[k] ??= []).push(v); if (monHist[k].length > 60) monHist[k].shift(); };
const MON_MODEL = { cpu: "", mem: "" }; // filled from telemetry
async function startMonitoring() {
  renderMonStage();
  monInitThr();
  if (monTimer) return;
  monTimer = setInterval(async () => {
    try {
      const t = await (await fetch("/api/telemetry")).json();
      if (!t) return;
      pushH("cpu", t.cpu?.load ?? 0);
      pushH("mem", t.mem?.pct ?? 0);
      for (const d of t.drives ?? []) { pushH("drive:" + d.letter, d.pct); pushH("driveio:" + d.letter, (d.readMBs ?? 0) + (d.writeMBs ?? 0)); }
      for (const [i, g] of (t.gpus ?? []).entries()) if (g.util != null) pushH("gpu:" + i, g.util);
      for (const [i, n] of (t.net ?? []).entries()) pushH("net:" + i, (n.rxMbps ?? 0) + (n.txMbps ?? 0));
      renderMonStage(t);
    } catch {}
  }, 2000);
}
function monSpark(data, active) {
  const w = 120, h = 30, c = active ? "currentColor" : "var(--n-secondary)";
  if (!data?.length) return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
  const pts = data.map((v, i) => `${(i / Math.max(1, data.length - 1)) * w},${h - (Math.min(v, 100) / 100) * (h - 4) - 2}`).join(" ");
  return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`;
}
function monArea(data) {
  const w = 600, h = 200, c = "var(--n-display)";
  if (!data?.length) return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`;
  const pts = data.map((v, i) => `${(i / Math.max(1, data.length - 1)) * w},${h - (Math.min(v, 100) / 100) * (h - 14) - 7}`).join(" ");
  // dot-matrix fill khas Nothing: kolom titik di bawah garis
  const dots = [];
  for (let x = 10; x < w; x += 20) {
    const idx = Math.round((x / w) * (data.length - 1));
    const v = Math.min(data[idx] ?? 0, 100);
    for (let y = h - 7; y > h - (v / 100) * (h - 14) - 7; y -= 10) dots.push(`<circle cx="${x}" cy="${y}" r="1.2" fill="${c}" opacity=".35"/>`);
  }
  return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="var(--n-line)" stroke-width="1" vector-effect="non-scaling-stroke"/>
    <line x1="0" y1="${h - 7}" x2="${w}" y2="${h - 7}" stroke="var(--n-line)" stroke-width="1" vector-effect="non-scaling-stroke"/>
    ${dots.join("")}
    <polyline points="${pts}" fill="none" stroke="${c}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    <circle cx="${pts.split(" ").pop()?.split(",")[0] ?? 0}" cy="${pts.split(" ").pop()?.split(",")[1] ?? 0}" r="3" fill="var(--n-accent, #D71921)"/>
  </svg>`;
}
function monItems(t) {
  const wifiStd = (s) => { const m = /wi-?fi\s*(\d)/i.exec(s ?? ""); if (/BE/i.test(s ?? "")) return "Wi-Fi 7"; if (m) return "Wi-Fi " + ({"5":"5","6":"6/6E"}[m[1]] ?? m[1]); return "Wi-Fi"; };
  const items = [
    { key: "cpu", title: t?.cpu?.model?.replace(/\(R\)|\(TM\)|@.*|CPU/g, "").trim().slice(0, 28) || "CPU", sub: `${t?.cpu?.load ?? 0}%`, icon: "memory_alt" },
    { key: "mem", title: `RAM ${t?.mem?.type ?? ""}`.trim() + (t?.mem?.speedMhz ? ` ${Math.round(t.mem.speedMhz)}` : ""), sub: `${t?.mem?.pct ?? 0}%`, icon: "memory" },
  ];
  for (const d of t?.drives ?? []) items.push({ key: "drive:" + d.letter, title: `${d.mediaType || (/nvme|ssd|mtdk/i.test(d.name ?? "") ? "SSD" : "HDD")} ${d.disk} (${d.letter}:)`, sub: d.pct + "%", icon: "save" });
  (t?.gpus ?? []).forEach((g, i) => { if (g.util != null) items.push({ key: "gpu:" + i, title: g.name?.replace(/NVIDIA|GeForce|AMD|Radeon\(TM\)|Radeon/gi, "").trim().slice(0, 24) || `GPU ${i}`, sub: g.util + "%", icon: "videocam" }); });
  for (const [i, n] of (t?.net ?? []).entries()) items.push({ key: "net:" + i, title: /wi-?fi/i.test(n.iface) ? wifiStd(n.iface) : /realtek|gbE|ethernet/i.test(n.iface) ? "Ethernet" : n.iface.slice(0, 18), sub: fmtMbps((n.rxMbps ?? 0) + (n.txMbps ?? 0)), icon: "wifi" });
  return items;
}
async function renderMonStage(t) {
  if (!t) { try { t = await (await fetch("/api/telemetry")).json(); } catch { return; } }
  // alert banner
  let alerts = { active: [] };
  try { alerts = await (await fetch("/api/alerts")).json(); } catch {}
  const banner = $("#monAlertBanner");
  const fmtAlert = (m) => m.startsWith("drive:") ? `Disk ${m.slice(6)}:` : m;
  if (alerts.active?.length) {
    banner.style.display = "flex";
    banner.innerHTML = alerts.active.map(x => `<div style="display:flex;align-items:center;gap:8px"><span class="msr" style="font-size:15px">warning</span><span>Alert — ${fmtAlert(x.metric)} Usage At ${Math.round(x.value)}% (Threshold ${x.threshold}%)</span></div>`).join("");
  } else banner.style.display = "none";
  const items = monItems(t);
  // left list — inversi khas Nothing
  $("#monList").innerHTML = items.map(it => {
    const act = it.key === monSel;
    const cat = it.key === "cpu" ? "Processor" : it.key === "mem" ? "Memory" : it.key.startsWith("drive:") ? "Storage" : it.key.startsWith("gpu:") ? "Graphics" : "Network";
    return `<button class="mon-item${act ? " act" : ""}" onclick="monSelect('${it.key}')">
      <div class="mon-top"><span class="mon-title">${it.title}</span><span class="mon-sub">${it.sub}</span></div>
      ${monSpark(monHist[it.key], act)}
      <span class="mon-cat">${cat}</span>
    </button>`;
  }).join("");
  // detail stage
  const it = items.find(x => x.key === monSel) ?? items[0];
  const hist = monHist[it.key] ?? [];
  const detail = $("#monDetail");
  const modelName = it.key === "cpu" ? (t.cpuModel ?? "") : it.key.startsWith("drive:") ? ((t.drives ?? []).find(d => "drive:" + d.letter === it.key)?.name ?? "") : it.key.startsWith("gpu:") ? ((t.gpus ?? [])[Number(it.key.slice(4))]?.name ?? "") : "";
  const drive = (t.drives ?? []).find(d => "drive:" + d.letter === it.key);
  let body = monArea(hist);
  let stats = "";
  if (it.key === "cpu") {
    const up = t.procs?.uptimeS ?? 0;
    const upStr = `${Math.floor(up / 3600)}:${String(Math.floor((up % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(up % 60)).padStart(2, "0")}`;
    stats = [["Load", t.cpu?.load ?? 0, "%"], ["Speed", (t.cpu?.speedGhz ?? 0).toFixed(2), "GHz"], ["Cores", t.cpu?.cores ?? "—", ""], ["Processes", t.procs?.processes ?? "—", ""], ["Uptime", upStr, ""]];
  }
  else if (it.key === "mem") stats = [["In Use", t.mem?.usedGb ?? 0, `GB <small>/ ${t.mem?.totalGb ?? 0} GB</small>`], ["Usage", t.mem?.pct ?? 0, "%"], ["Cached", t.mem?.cachedGb ?? 0, "GB"]];
  else if (drive) stats = [["Capacity", drive.totalGb.toLocaleString("en-US"), "GB"], ["Free", drive.freeGb.toLocaleString("en-US"), "GB"], ["Used", drive.pct, "%"], ["Read", (drive.readMBs ?? 0).toFixed(2), "MB/s"], ["Write", (drive.writeMBs ?? 0).toFixed(2), "MB/s"]];
  else if (it.key.startsWith("gpu:")) { const g = (t.gpus ?? [])[Number(it.key.slice(4))]; stats = [["Utilization", g?.util ?? "—", "%"], ["Temperature", g?.temp != null ? g.temp : "—", "°C"]]; }
  else if (it.key.startsWith("net:")) { const n = (t.net ?? [])[Number(it.key.slice(4))]; stats = [["Receive", fmtMbps(n?.rxMbps ?? 0), ""], ["Send", fmtMbps(n?.txMbps ?? 0), ""], ["IPv4", n?.ip ?? "—", ""]]; }
  detail.innerHTML = `
    <div class="mon-head">
      <h3>${it.title}</h3>
      <span class="model">${modelName}</span>
    </div>
    <div style="padding:14px 18px">${body}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));border-top:1px solid var(--n-line)">
      ${stats.map(([k2, v2, u2]) => `<div class="mon-stat" style="border-top:none;border-right:1px solid var(--n-line);border-left:none;border-bottom:none">
        <div class="k">${k2}</div>
        <div class="v">${v2}${u2 ? `<small>${u2}</small>` : ""}</div>
      </div>`).join("")}
    </div>`;
}
function monSelect(k) { monSel = k; renderMonStage(); }
// ===== Threshold panel (selalu tampil di atas) =====
let monThrData = null;
async function monInitThr() {
  if (monThrData) return monRenderThr();
  const a = await (await fetch("/api/alerts")).json();
  monThrData = a.thresholds;
  monRenderThr();
}
function monRenderThr() {
  $("#monThrPanel").innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid var(--n-line);margin-bottom:14px">
      <span style="font-family:var(--n-f-mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--n-muted)">Alert Thresholds — CPU</span>
      <input type="number" id="thrCpu" min="1" max="100" value="${monThrData.cpu}" style="width:70px;background:transparent;border:1px solid var(--n-line);color:var(--n-display);font-family:var(--n-f-mono);font-size:13px;padding:6px 8px">
      <span style="font-family:var(--n-f-mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--n-muted)">Storage</span>
      <input type="number" id="thrStorage" min="1" max="100" value="${monThrData.storage}" style="width:70px;background:transparent;border:1px solid var(--n-line);color:var(--n-display);font-family:var(--n-f-mono);font-size:13px;padding:6px 8px">
      <span style="font-family:var(--n-f-mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--n-muted)">%</span>
      <button class="n-btn" onclick="monSaveThr()">Save</button>
      <span id="thrSaved" style="font-family:var(--n-f-mono);font-size:10px;color:var(--n-secondary);opacity:0;transition:opacity .3s">Saved</span>
    </div>`;
}
async function monSaveThr() {
  const body = { cpu: +$("#thrCpu").value, storage: +$("#thrStorage").value };
  await fetch("/api/alerts/thresholds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const s = $("#thrSaved");
  s.style.opacity = "1";
  setTimeout(() => s.style.opacity = "0", 1500);
}
// ===== Apps: media downloader + PDF/image tools =====
function showApp(id) {
  if (id === "mc") { showView("app-mc"); mcRefresh(); return; }
  showView("app-" + id);
}
let appsDlPoll = null;
let appsModeSel = null; // belum ada pilihan — user harus klik dulu
let appsVfmtSel = "mp4";
let appsVresSel = 1080;
let appsAfmtSel = "mp3";
let appsAqSel = "0";
function appsPickMode(btn) {
  appsModeSel = btn.dataset.mode;
  document.querySelectorAll(".nui-opt").forEach(b => {
    if (b.closest("#appsVideoFmtRow") || b.closest("#appsVideoResRow") || b.closest("#appsAudioFmtRow") || b.closest("#appsAudioQRow")) return;
    b.classList.toggle("sel", b === btn);
  });
  const isVideo = appsModeSel === "video", isAudio = appsModeSel === "audio";
  const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? "flex" : "none"; };
  show("#appsVideoFmtRow", isVideo); show("#appsVideoResRow", isVideo);
  show("#appsAudioFmtRow", isAudio); show("#appsAudioQRow", isAudio);
}
function appsPickVfmt(btn) {
  appsVfmtSel = btn.dataset.vfmt;
  btn.parentElement.querySelectorAll(".nui-opt").forEach(b => b.classList.toggle("sel", b === btn));
  appsVideoSubUpdate();
}
function appsPickVres(btn) {
  appsVresSel = +btn.dataset.vres;
  btn.parentElement.querySelectorAll(".nui-opt").forEach(b => b.classList.toggle("sel", b === btn));
  appsVideoSubUpdate();
}
function appsPickAfmt(btn) {
  appsAfmtSel = btn.dataset.afmt;
  btn.parentElement.querySelectorAll(".nui-opt").forEach(b => b.classList.toggle("sel", b === btn));
  appsAudioSubUpdate();
}
function appsPickAq(btn) {
  appsAqSel = btn.dataset.aq;
  btn.parentElement.querySelectorAll(".nui-opt").forEach(b => b.classList.toggle("sel", b === btn));
  appsAudioSubUpdate();
}
// label tombol AUDIO ikut pilihan user: "MP3 · BEST"
function appsAudioSubUpdate() {
  const sub = $("#appsAudioSub");
  const q = { "0": "BEST", "5": "MEDIUM", "9": "SMALL" }[appsAqSel] ?? "BEST";
  if (sub) sub.textContent = `${appsAfmtSel.toUpperCase()} · ${q}`;
}
// label tombol VIDEO ikut pilihan user: "1080P · MP4"
function appsVideoSubUpdate() {
  const sub = $("#appsVideoSub");
  const label = { 2160: "4K", 1440: "1440P", 1080: "1080P", 720: "720P", 480: "480P", 360: "360P" }[appsVresSel] ?? appsVresSel + "P";
  if (sub) sub.textContent = `${label} · ${appsVfmtSel.toUpperCase()}`;
}

async function loadAppsFiles() {
  try {
    const files = await (await fetch("/api/apps/downloads")).json();
    appsFilesCache = files;
    const fmt = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e3).toFixed(0) + " KB";
    const icon = (n) => /\.pdf$/i.test(n) ? "picture_as_pdf" : /\.(mp3|wav|m4a|opus)$/i.test(n) ? "music_note" : /\.(mp4|mkv|webm)$/i.test(n) ? "movie" : /\.(jpe?g|png|webp|avif)$/i.test(n) ? "image" : "draft";
    const row = (f) => `
      <div class="nui-row">
        <span class="msr" style="font-size:18px;color:var(--n-secondary)">${icon(f.name)}</span>
        <span class="nui-row-name">${esc(f.name)}</span>
        <span class="nui-row-meta">${fmt(f.size)} · ${new Date(f.mtime).toLocaleDateString("en-US", { month: "short", day: "numeric" }).toUpperCase()}</span>
        <a href="/api/apps/file?name=${encodeURIComponent(f.name)}" title="Download" class="msr">download</a>
        <span class="act msr" onclick="appsDelete('${esc(f.name.replace(/'/g, ""))}')" title="Delete">delete</span>
      </div>`;
    const vids = files.filter(f => /\.(mp4|mkv|webm|mov|avi|flv)$/i.test(f.name));
    const auds = files.filter(f => /\.(mp3|wav|m4a|opus|flac|ogg)$/i.test(f.name));
    const media = [...vids, ...auds];
    const pdfs = files.filter(f => /\.pdf$/i.test(f.name));
    const imgs = files.filter(f => /\.(jpe?g|png|webp|avif|bmp|gif|tiff)$/i.test(f.name));
    const empty = (t) => `<p style="color:var(--md-on-surface-variant);font-size:13px;margin:0">${t}</p>`;
    const el = (id) => document.getElementById(id);
    if (el("appsMediaFiles")) el("appsMediaFiles").innerHTML = media.length ? `<div class="nui-filegroup">${media.map(row).join("")}</div>` : '<span class="nui-empty">No Media Files — Download Or Upload Something</span>';
    if (el("appsVideoFiles")) el("appsVideoFiles").innerHTML = vids.length ? `<div class="nui-filegroup">${vids.map(vidCompressRow).join("")}</div>` : '<span class="nui-empty">No Videos Yet</span>';
    if (el("appsAudioFiles")) el("appsAudioFiles").innerHTML = auds.length ? `<div class="nui-filegroup">${auds.map(vidRow).join("")}</div>` : '<span class="nui-empty">No Audio Files Yet</span>';
    // flat rows: satu list per halaman, aksi inline per file
    const actBtn = (label, fn, cls = "ghost") => `<button class="nui-btn ${cls}" style="padding:8px 14px;font-size:10px" onclick="${fn}">${label}</button>`;
    const pdfRow = (f) => `
      <div class="nui-row">
        <span class="msr" style="font-size:18px;color:var(--n-secondary)">picture_as_pdf</span>
        <span class="nui-row-name">${esc(f.name)}</span>
        <span class="nui-row-meta">${fmt(f.size)}</span>
        ${actBtn("COMPRESS", `appsPdfCompress('${esc(f.name.replace(/'/g, ""))}', this)`, "accent")}
        ${actBtn("SPLIT", `appsPdfSplit('${esc(f.name.replace(/'/g, ""))}')`)}
        <span class="act msr" onclick="appsDelete('${esc(f.name.replace(/'/g, ""))}')" title="Delete">delete</span>
      </div>`;
    const imgRow = (f) => `
      <div class="nui-row">
        <span class="msr" style="font-size:18px;color:var(--n-secondary)">image</span>
        <span class="nui-row-name">${esc(f.name)}</span>
        <span class="nui-row-meta">${fmt(f.size)}</span>
        <select class="nui-num" style="width:100px;padding:6px" onchange="appsImageConvert('${esc(f.name.replace(/'/g, ""))}', this.value)">
          <option value="">FORMAT…</option>
          <option value="webp">WEBP</option>
          <option value="jpeg">JPEG</option>
          <option value="png">PNG</option>
          <option value="avif">AVIF</option>
        </select>
      </div>`;
    const vidRow = (f) => `
      <div class="nui-row">
        <span class="msr" style="font-size:18px;color:var(--n-secondary)">movie</span>
        <span class="nui-row-name">${esc(f.name)}</span>
        <span class="nui-row-meta">${fmt(f.size)}</span>
        <select class="nui-num" style="width:110px;padding:6px" onchange="appsMediaConvert('${esc(f.name.replace(/'/g, ""))}', this.value)">
          <option value="">FORMAT…</option>
          <option value="mp4">MP4</option>
          <option value="mkv">MKV</option>
          <option value="webm">WEBM</option>
          <option value="mp3">MP3</option>
          <option value="m4a">M4A</option>
          <option value="wav">WAV</option>
        </select>
      </div>`;
    const vidCompressRow = (f) => `
      <div class="nui-row">
        <span class="msr" style="font-size:18px;color:var(--n-secondary)">movie</span>
        <span class="nui-row-name">${esc(f.name)}</span>
        <span class="nui-row-meta">${fmt(f.size)}</span>
        ${actBtn("COMPRESS", `appsVideoCompress('${esc(f.name.replace(/'/g, ""))}', this)`, "accent")}
        <span class="act msr" onclick="appsDelete('${esc(f.name.replace(/'/g, ""))}')" title="Delete">delete</span>
      </div>`;
    const renderList = (id, items, rowFn, emptyMsg) => {
      const list = el(id);
      if (!list) return;
      list.innerHTML = items.length ? `<div class="nui-filegroup">${items.map(rowFn).join("")}</div>` : `<span class="nui-empty">${emptyMsg}</span>`;
    };
    if (el("appsPdfFiles")) {
      // halaman compress: PDF rows + video compress section
      renderList("appsPdfFiles", pdfs, pdfRow, "No PDFs Yet — Upload One");
      const vc = el("appsVideoFiles");
      if (vc) renderList("appsVideoFiles", vids, vidCompressRow, "No Videos Yet");
    }
    if (el("appsImageFiles")) renderList("appsImageFiles", imgs, imgRow, "No Images Yet — Upload One");
    if (el("appsAudioFiles")) renderList("appsAudioFiles", auds, vidRow, "No Audio Files Yet");
  } catch {}
}

async function appsPreview() {
  const url = $("#appsUrl").value.trim();
  if (!url) { toast("Paste A URL First", "error"); return; }
  const box = $("#appsPreviewBox"), media = $("#appsPreviewMedia"), meta = $("#appsPreviewMeta");
  box.style.display = "block";
  media.innerHTML = '<div style="display:grid;place-items:center;height:200px;color:var(--n-secondary)"><span class="msr" style="font-size:32px">hourglass_top</span></div>';
  meta.textContent = "Fetching metadata…";
  try {
    const r = await fetch("/api/apps/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    const j = await r.json();
    if (j.error) { media.innerHTML = ""; meta.textContent = "Preview Failed: " + j.error; return; }
    const dur = j.duration ? Math.floor(j.duration / 60) + ":" + String(Math.floor(j.duration % 60)).padStart(2, "0") : null;
    media.innerHTML = j.thumbnail
      ? `<img src="${esc(j.thumbnail)}" style="width:100%;display:block;object-fit:contain;max-height:340px;background:#000" onerror="this.remove()">`
      : "";
    const bits = [esc(j.title ?? ""), j.uploader ? esc(j.uploader) : null, dur, j.view_count ? j.view_count.toLocaleString("en-US") + " Views" : null, j.is_live ? "LIVE" : null].filter(Boolean);
    meta.textContent = bits.join("  ·  ");
    // YouTube: bisa play inline via iframe embed (kualitas preview, tanpa download)
    const ytId = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(url)?.[1];
    const playBtn = $("#appsPlayBtn");
    if (ytId && playBtn) {
      playBtn.style.display = "flex";
      playBtn.dataset.ytId = ytId;
    } else if (playBtn) playBtn.style.display = "none";
  } catch (e) { media.innerHTML = ""; meta.textContent = "Preview Failed: " + e.message; }
}

// play inline: ganti thumbnail jadi iframe embed YouTube (klik PLAY dulu — embed autoplay butuh gesture user)
function appsPlayInline() {
  const btn = $("#appsPlayBtn");
  const ytId = btn?.dataset.ytId;
  if (!ytId) return;
  $("#appsPreviewMedia").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${esc(ytId)}?autoplay=1" style="width:100%;aspect-ratio:16/9;display:block;border:none" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
  btn.style.display = "none";
}

async function appsDownload() {
  const url = $("#appsUrl").value.trim();
  if (!url) { toast("Paste A URL First", "error"); return; }
  if (!appsModeSel) { toast("Pick A Format First — Video Or Audio", "error"); return; }
  const mode = appsModeSel;
  const r = await (await fetch("/api/apps/download", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, mode, vfmt: appsVfmtSel, vres: appsVresSel, afmt: appsAfmtSel, aq: appsAqSel }),
  })).json();
  if (r.error) { errorToast(r.error); return; }
  const goBtn = $("#appsGoBtn"); if (goBtn) { goBtn.disabled = true; goBtn.style.opacity = ".5"; goBtn.style.pointerEvents = "none"; }
  $("#appsDlStatus").style.display = "block";
  if (appsDlPoll) clearInterval(appsDlPoll);
  appsDlPoll = setInterval(async () => {
    try {
      const j = await (await fetch("/api/apps/download/" + r.id)).json();
      $("#appsDlPct").textContent = String(j.pct).padStart(3, "0") + "%";
      $("#appsDlBar") && ($("#appsDlBar").style.width = j.pct + "%");
      // LED segment bar (Nothing style): 24 segmen
      const led = $("#appsDlLed");
      if (led) {
        const on = Math.round((j.pct / 100) * 24);
        led.innerHTML = Array.from({ length: 24 }, (_, i) => `<i${i < on ? ' class="on"' : ""}></i>`).join("");
      }
      $("#appsDlLine").textContent = j.line ?? "";
      if (j.done) {
        clearInterval(appsDlPoll); appsDlPoll = null;
        const gb = $("#appsGoBtn"); if (gb) { gb.disabled = false; gb.style.opacity = ""; gb.style.pointerEvents = ""; }
        setTimeout(() => { $("#appsDlStatus").style.display = "none"; }, 1500);
        if (j.error) { loadAppsFiles(); errorToast("Download Failed —” " + j.error); }
        else { toast("Download Completed"); $("#appsUrl").value = ""; loadAppsFiles(); }
      }
    } catch {}
  }, 700);
}

async function appsUpload(input) {
  if (input._busy) return;
  input._busy = true;
  const dz = input.closest(".nui-dropzone");
  dz?.classList.add("drag");
  try {
    let ok = 0, failed = 0;
    for (const f of input.files) {
      try {
        const buf = await f.arrayBuffer();
        const r = await fetch("/api/apps/upload?name=" + encodeURIComponent(f.name), { method: "POST", body: buf });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
        ok++;
        toast("Uploaded: " + f.name);
      } catch (e) { failed++; errorToast("Upload Failed: " + f.name + " — " + e.message); }
    }
    if (ok && failed) toast(`Done — ${ok} Uploaded, ${failed} Failed`, failed ? "error" : undefined);
    else if (!ok && failed) errorToast(`All ${failed} Uploads Failed`);
  } finally {
    input.value = "";
    input._busy = false;
    dz?.classList.remove("drag");
    loadAppsFiles();
  }
}

// drag & drop untuk dropzone (label saja tidak menangani drop)
function wireDropzone(zoneId, inputId) {
  const zone = document.getElementById(zoneId), inp = document.getElementById(inputId);
  if (!zone || !inp || zone._wired) return;
  zone._wired = true;
  ["dragover", "dragenter"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("drag"); }));
  ["dragleave", "dragend"].forEach(ev => zone.addEventListener(ev, () => zone.classList.remove("drag")));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("drag");
    if (e.dataTransfer?.files?.length) {
      inp.files = e.dataTransfer.files;
      appsUpload(inp);
    }
  });
}

async function appsDelete(name) {
  await fetch("/api/apps/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  loadAppsFiles();
}

// ===== Device hub: tab Overview + Free Up Space dalam satu halaman =====
function devTab(t) {
  const on = (el, active) => {
    if (!el) return;
    el.style.background = active ? "var(--n-display)" : "transparent";
    el.style.color = active ? "var(--n-bg)" : "var(--n-primary)";
  };
  on($("#devTabOverview"), t === "overview");
  on($("#devTabBackup"), t === "backup");
  on($("#devTabFreeup"), t === "freeup");
  $("#devPaneOverview").style.display = t === "overview" ? "" : "none";
  $("#devPaneBackup").style.display = t === "backup" ? "" : "none";
  $("#devPaneFreeup").style.display = t === "freeup" ? "" : "none";
  const titles = {
    overview: ['DEVICE<span class="nui-dot">.</span>', "Connected Phone — Status, Backup, And Space Management In One Place."],
    backup: ['BACKUP<span class="nui-dot">.</span>', "Transfer Files From Phone To Vault — Live Progress, Speed, And Source Folder."],
    freeup: ['FREE UP SPACE<span class="nui-dot">.</span>', "Delete Files On Your Phone That Are Already Backed Up. Files Without A Backup Are Never Shown As Selectable."],
  };
  $("#deviceTitle").innerHTML = titles[t][0];
  $("#deviceSub").textContent = titles[t][1];
  if (t === "freeup") loadFreeUp();
  if (t === "backup") renderDeviceBackup();
}

// ===== Device > Backup tab: progress panel pindah dari Dashboard + log live =====
function renderDeviceBackup() {
  const root = $("#deviceBackupPanel");
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = "1";
    root.innerHTML = `
      <div class="nui-card" style="margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="msr" style="font-size:26px;color:var(--n-accent,#D71921)">backup</span>
          <div style="flex:1">
            <div style="font-family:var(--n-f-mono);font-size:13px;font-weight:700;color:var(--n-display)" id="devBkTitle">Ready To Backup</div>
            <div style="font-family:var(--n-f-mono);font-size:10px;color:var(--n-secondary);margin-top:2px" id="devBkSub">Open The Backup Picker From The Dashboard Or Press Backup Device.</div>
          </div>
          <button onclick="showBackupDialog()" style="background:var(--n-accent,#D71921);color:#fff;border:none;font-family:var(--n-f-mono);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:10px 18px;cursor:pointer;display:flex;align-items:center;gap:6px;flex-shrink:0">
            <span class="msr" style="font-size:15px;vertical-align:-3px">backup</span> Backup Device
          </button>
        </div>
      </div>
      <div id="devBkProgress" style="margin-bottom:14px"></div>
      <div class="nui-card" style="padding:0">
        <div style="padding:10px 14px;border-bottom:1px solid var(--n-line);font-family:var(--n-f-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--n-secondary)">Backup Log</div>
        <div id="devBkLog" style="padding:10px 14px;max-height:260px;overflow-y:auto;font-family:var(--n-f-mono);font-size:10px;line-height:1.7;color:var(--n-secondary);white-space:pre-wrap;word-break:break-all"></div>
      </div>`;
  }
  updateDeviceBackupPanel();
}

// dipanggil dari refreshStatus polling — render state backup real-time ke tab Backup
function updateDeviceBackupPanel() {
  const root = $("#deviceBackupPanel");
  if (!root || root.style.display === "none") return;
  const st = window._lastStatus;
  if (!st) return;
  const title = $("#devBkTitle"), sub = $("#devBkSub");
  if (st.syncing) {
    if (title) title.textContent = "Backing Up…";
    if (sub) sub.textContent = "Transferring Files From Device — Keep The Cable Connected.";
  } else {
    if (title) title.textContent = "Ready To Backup";
    if (sub) sub.textContent = "Open The Backup Picker From The Dashboard Or Press Backup Device.";
  }
  // progress: sama seperti dashboard (byte-level utk file raksasa)
  const prog = $("#devBkProgress");
  if (prog && st.syncing) {
    const bp = st.backupProgress;
    const m = bp && bp.total ? { bp } : (st.log[st.log.length - 1] ?? "").match(/^(\d+)\/(\d+)/);
    if (m && m.bp) {
      const parts = (m.bp.file || "").split("/").filter(Boolean);
      const fname = parts.pop() ?? "";
      const phoneFolder = "/" + parts.slice(3).join("/");
      const big = m.bp.bytesTotal > 512 * 1024 * 1024;
      prog.innerHTML = `
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:6px">
          <span style="font-family:var(--n-f-mono);font-size:22px;font-weight:700;color:var(--n-display)">${m.bp.pct}%</span>
          <span style="font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary)">${big ? `${(m.bp.bytesTransferred / 1073741824).toFixed(2)} / ${(m.bp.bytesTotal / 1073741824).toFixed(2)} GB` : `${m.bp.done} / ${m.bp.total} Files`}</span>
        </div>
        <div style="height:6px;background:var(--n-line);margin-bottom:6px"><div style="height:100%;width:${m.bp.pct}%;background:var(--n-accent,#D71921);transition:width .5s"></div></div>
        <div style="font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary)">
          <span class="msr" style="font-size:13px;vertical-align:-2px">smartphone</span> ${fname}${phoneFolder ? ` — from ${phoneFolder} on phone` : ""}
        </div>`;
    } else {
      prog.innerHTML = `<div style="font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary)">Preparing…</div>`;
    }
  } else if (prog) prog.innerHTML = "";
  // log live
  const log = $("#devBkLog");
  if (log && st.log?.length) log.textContent = st.log.join("\n");
}

async function loadDevice() {
  const root = $("#devPaneOverview");
  let st;
  try { st = await (await fetch("/api/adb-status")).json(); } catch { root.innerHTML = '<p style="color:var(--md-error);font-family:var(--n-f-mono);font-size:12px">Failed To Load Device Status</p>'; return; }
  const d = st.devices.find(x => x.state === "device") ?? st.devices[0] ?? null;
  const connected = d && d.state === "device";
  const status = window._adbInfo;
  const row = (icon, label, value, color) => `
    <div style="display:flex;align-items:center;gap:14px;padding:11px 24px;border-bottom:1px solid var(--n-line)">
      <span class="msr" style="font-size:18px;color:${color ?? "var(--n-secondary)"}">${icon}</span>
      <span style="width:130px;font-family:var(--n-f-mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--n-secondary)">${label}</span>
      <span style="flex:1;font-family:var(--n-f-mono);font-size:12px;color:var(--n-primary);text-align:right">${value}</span>
    </div>`;
  let info = "";
  if (connected) {
    info = row("tag", "Serial", d.id)
      + row("verified_user", "Authorization", d.state === "device" ? "Authorized" : d.state, d.state === "device" ? "#137333" : "var(--md-error)")
      + (d.android ? row("android", "Android", d.android) : "")
      + (d.battery ? row("battery_charging_full", "Battery", `${d.battery.level}%${d.battery.charging ? " (Charging)" : ""}`, d.battery.level <= 20 && !d.battery.charging ? "var(--md-error)" : "#137333") : "");
  } else {
    info = row("usb_off", "Status", "No Device Connected — Plug In Via USB", "var(--md-error)");
  }
  // quick stats: total file & size ter-backup untuk profil aktif (kalau terkoneksi)
  let statsHtml = "";
  if (connected) {
    try {
      const s2 = await (await fetch("/api/stats", { headers: { "Content-Type": "application/json" } })).json().catch(() => null);
      if (s2) {
        const docs = (s2.count ?? 0) - (s2.photos ?? 0) - (s2.videos ?? 0);
        const cell = (v, l) => `<div style="flex:1;padding:16px 0 14px;text-align:center;border-right:1px solid var(--n-line)"><div style="font-family:var(--n-f-display);font-variation-settings:'DNAM' 0;font-size:24px;font-weight:600;color:var(--n-display)">${v}</div><div style="font-family:var(--n-f-mono);font-size:8px;letter-spacing:.14em;text-transform:uppercase;color:var(--n-secondary);margin-top:4px">${l}</div></div>`;
        statsHtml = `<div style="display:flex;align-items:stretch;border-top:1px solid var(--n-line);background:var(--n-raised)">
          ${cell((s2.photos ?? 0).toLocaleString("en-US"), "Photos")}
          ${cell((s2.videos ?? 0).toLocaleString("en-US"), "Videos")}
          ${cell(Math.max(0, docs).toLocaleString("en-US"), "Others")}
          ${cell(fuFmt(s2.size ?? 0), "Backed Up")}
        </div>`;
      }
    } catch {}
  }
  root.innerHTML = `
    <div class="nui-box" style="padding:0;margin-bottom:14px;overflow:hidden">
      <div style="display:flex;align-items:center;gap:16px;padding:22px 24px">
        <div class="nui-led" style="width:52px;height:52px;border:1px solid var(--md-outline-variant);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin:0">
          <span class="msr" style="font-size:30px;color:${connected ? "var(--n-display)" : "var(--n-muted)"}">${connected ? "smartphone" : "usb_off"}</span>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-family:var(--n-f-head);font-weight:700;font-size:19px;color:var(--n-display);letter-spacing:-.01em">${connected ? (d.model || d.id) : "NO DEVICE"}</div>
          <div style="font-family:var(--n-f-mono);font-size:9px;letter-spacing:.1em;color:var(--n-secondary);text-transform:uppercase;margin-top:4px">${connected ? [d.id, d.android ? `ANDROID ${d.android}` : "", d.battery ? `${d.battery.level}%${d.battery.charging ? " CHARGING" : ""}` : ""].filter(Boolean).join(" · ") : "CONNECT VIA USB CABLE"}</div>
        </div>
        <div class="nui-led pill"><i class="${connected ? "on" : ""}"></i><span style="font-family:var(--n-f-mono);font-size:9px;letter-spacing:.1em;margin-left:6px;color:${connected ? "var(--n-primary)" : "var(--n-muted)"}">${connected ? "READY" : "OFFLINE"}</span></div>
      </div>
      ${statsHtml}
    </div>
    <div class="nui-box" style="margin-bottom:14px">
      <div style="padding:10px 24px;border-bottom:1px solid var(--n-line);font-family:var(--n-f-mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--n-secondary)">Device Information</div>
      ${info.replace(/border-bottom:1px solid var\(--n-line\)">$/, "border-bottom:none\">")}
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px">
      <div class="dev-cta" ${connected ? "onclick=\"showBackupDialog()\"" : "style='opacity:.45;cursor:not-allowed'"}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <span class="msr" style="font-size:30px;color:var(--n-display)">backup</span>
          <span class="msr" style="font-size:20px;color:var(--n-secondary)">arrow_forward</span>
        </div>
        <div style="font-family:var(--n-f-head);font-weight:700;font-size:15px;color:var(--n-primary)">Want To Backup Your Device?</div>
        <div style="font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary);margin-top:5px;line-height:1.6">Pull New Photos, Videos &amp; Files From Your Phone To The Vault — Duplicates Are Skipped Automatically.</div>
        <div style="font-family:var(--n-f-mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--n-display);margin-top:12px">Start Backup →</div>
      </div>
      <div class="dev-cta" ${connected ? "onclick=\"devTab('freeup')\"" : "style='opacity:.45;cursor:not-allowed'"}>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <span class="msr" style="font-size:30px;color:var(--n-accent,#D71921)">cleaning_services</span>
          <span class="msr" style="font-size:20px;color:var(--n-secondary)">arrow_forward</span>
        </div>
        <div style="font-family:var(--n-f-head);font-weight:700;font-size:15px;color:var(--n-primary)">Want To Free Up Space?</div>
        <div style="font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary);margin-top:5px;line-height:1.6">Delete Photos &amp; Files On Your Phone That Are Already Safe In The Vault — Nothing Un-Backed Up Can Ever Be Selected.</div>
        <div style="font-family:var(--n-f-mono);font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--n-accent,#D71921);margin-top:12px">Clean Up →</div>
      </div>
    </div>`;
}

// ===== Free Up Space: full page — folders cascade + dual explorer (HDD vs HP) =====
let fuData = null;        // hasil scan { files, fileDetails, byYear, byFolder, totalOnDevice }
let fuVolume = "HDD";     // nama volume HDD (dari nama profil)
let fuDevice = "";        // model HP (ro.product.model)
let fuSel = new Set();    // device_path yang dicentang (hanya file B)
let fuActive = "";        // folder aktif (mis. "DCIM")
let fuSub = "";           // subpath aktif dalam folder (mis. "DCIM/Camera")
let fuFilter = "all";     // all | b | unb
let fuPreview = null;     // file yang di-preview

const fuFmt = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : (b / 1e3).toFixed(0) + " KB";
const fuEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const fuIcon = (p) => /\.(jpe?g|png|gif|webp|heic)$/i.test(p) ? "image" : /\.(mp4|mov|mkv|avi|3gp)$/i.test(p) ? "play_arrow" :
  /\.(pdf|docx?|pptx?|xlsx?)$/i.test(p) ? "description" : /\.(zip|apk|jar|bin|rar|7z)$/i.test(p) ? "package" : "draft";

async function loadFreeUp() {
  fuSel.clear(); fuActive = ""; fuSub = ""; fuFilter = "all"; fuPreview = null;
  // progress: scan per folder sequential, tiap folder update bar
  $("#freeupRoot").innerHTML = `
    <div style="max-width:520px;margin:40px auto;text-align:center">
      <div style="font-family:var(--n-f-mono);font-size:11px;letter-spacing:.1em;color:var(--n-secondary);text-transform:uppercase;margin-bottom:12px" id="fuScanLabel">STARTING SCAN…</div>
      <div style="height:3px;background:var(--n-line);position:relative;overflow:hidden">
        <div id="fuScanBar" style="position:absolute;inset:0;right:100%;background:var(--n-accent,#D71921);transition:right .3s"></div>
      </div>
      <div style="font-family:var(--n-f-mono);font-size:9px;color:var(--n-muted);margin-top:8px;letter-spacing:.08em" id="fuScanSub"></div>
    </div>`;
  const setProg = (pct, label, sub) => {
    const bar = $("#fuScanBar"); if (!bar) return;
    bar.style.right = (100 - pct) + "%";
    if (label) $("#fuScanLabel").textContent = label;
    if (sub !== undefined) $("#fuScanSub").textContent = sub;
  };
  setProg(3, "CONNECTING TO DEVICE…");
  // daftar folder dari HDD profile (cepat), lalu scan HP per folder dengan progress
  const fl = await (await fetch("/api/phone/cleanup-folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json().catch(() => null);
  if (!fl || fl.error) {
    $("#freeupRoot").innerHTML = `<p style="color:var(--md-error);font-family:var(--n-f-mono);font-size:12px;padding:20px;text-align:center">${fl?.error ?? "Scan Failed"}</p>`;
    return;
  }
  const folderNames = fl.folders ?? [];
  if (!folderNames.length) {
    $("#freeupRoot").innerHTML = '<p style="color:var(--n-secondary);font-family:var(--n-f-mono);font-size:12px;padding:20px;text-align:center">Nothing To Free — Nothing Was Backed Up Yet</p>';
    return;
  }
  // per-folder sequential scan dengan progress
  const results = [];
  for (let i = 0; i < folderNames.length; i++) {
    const f = folderNames[i];
    setProg(Math.round(5 + (i / folderNames.length) * 90), `SCANNING ${f.toUpperCase()}…`, `${i + 1} / ${folderNames.length} FOLDERS`);
    const r = await (await fetch("/api/phone/cleanup-scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: ["/storage/emulated/0/" + f], serial: pickerDevice || undefined }) })).json().catch(() => null);
    if (r && !r.error) results.push(r);
  }
  setProg(97, "MERGING RESULTS…");
  // merge
  fuData = { count: 0, size: 0, files: [], byYear: {}, byFolder: {}, totalOnDevice: 0, fileDetails: [] };
  for (const r of results) {
    fuData.count += r.count; fuData.size += r.size;
    fuData.files.push(...r.files);
    fuData.totalOnDevice += r.totalOnDevice;
    for (const x of r.fileDetails ?? []) fuData.fileDetails.push(x);
    for (const [y, d] of Object.entries(r.byYear)) { (fuData.byYear[y] ??= { count: 0, size: 0 }); fuData.byYear[y].count += d.count; fuData.byYear[y].size += d.size; }
    for (const [fo, d] of Object.entries(r.byFolder)) { (fuData.byFolder[fo] ??= { count: 0, size: 0 }); fuData.byFolder[fo].count += d.count; fuData.byFolder[fo].size += d.size; }
  }
  if (!fuData.count) {
    $("#freeupRoot").innerHTML = '<p style="color:var(--n-secondary);font-family:var(--n-f-mono);font-size:12px;padding:20px;text-align:center">Nothing To Free — Every File Is Either Not Backed Up Or Already Deleted</p>';
    return;
  }
  // nama volume HDD: primary volume (bisa multi HDD) — display name dari settings
  try {
    const { volumes } = await (await fetch("/api/volumes")).json();
    fuVolume = volumes.find(v => v.primary)?.display ?? volumes.find(v => v.primary)?.name ?? fuVolume;
  } catch {}
  // model HP dari endpoint scan pertama yang sukses (deviceModel dari ADB getprop)
  fuDevice = results.find(r => r.deviceModel)?.deviceModel ?? "";
  fuRender();
}

function fuAllYears() { return Object.keys(fuData.byYear).map(Number).filter(Boolean).sort((a, b) => b - a); }

function fuRender() {
  // pertahankan nilai year dropdown — fuRender rebuild footer, select ke-reset
  const prevFrom = $("#fuYearFrom")?.value ?? "";
  const prevTo = $("#fuYearTo")?.value ?? "";
  const years = fuAllYears();
  const folders = Object.entries(fuData.byFolder).sort((a, b) => b[1].size - a[1].size);
  const yearOpts = years.map(y => `<option value="${y}">${y}</option>`).join("");
  const foldersHtml = folders.map(([f, d]) => {
    const total = fuData.fileDetails.filter(x => x.folder === f).length;
    const unb = fuData.fileDetails.filter(x => x.folder === f && !fuData.files.includes(x.path)).length; // fallback
    // cascade state folder: checked jika semua file B di folder terpilih
    const bFiles = fuData.fileDetails.filter(x => x.folder === f && fuData.files.includes(x.path));
    const selCount = bFiles.filter(x => fuSel.has(x.path)).length;
    const cbState = selCount === 0 ? "" : selCount === bFiles.length ? "checked" : "indeterminate";
    const covCls = selCount === bFiles.length && selCount > 0 ? "cov-full" : "cov-part";
    return `
    <div class="fu-folder ${fuActive === f ? "active" : ""}" data-folder="${fuEsc(f)}" onclick="fuOpenFolder('${fuEsc(f).replace(/'/g, "\\'")}')">
      <input type="checkbox" ${cbState === "checked" ? "checked" : ""} data-fu-cb="${fuEsc(f)}" onclick="event.stopPropagation()" onchange="fuFolderToggle('${fuEsc(f).replace(/'/g, "\\'")}', this.checked)">
      <span class="msr">folder</span>
      <span class="fu-nm">${fuEsc(f)}</span>
      <span class="fu-note" id="fu-note-${fuEsc(f)}">${cbState === "indeterminate" ? `// ${selCount} OF ${bFiles.length} SAFE FILES SELECTED` : ""}</span>
      <span class="fu-cov ${covCls}">${bFiles.length}/${total}</span>
      <span class="fu-sz">${fuFmt(d.size)}</span>
    </div>`;
  }).join("");

  $("#freeupRoot").innerHTML = `
    <div class="fu-banner"><span class="msr">verified_user</span>DELETING BACKED-UP FILES IS SAFE — EVERY SELECTED FILE IS ALREADY STORED ON ${fuEsc(fuVolume.toUpperCase())}. FILES WITHOUT A BACKUP CANNOT BE SELECTED.</div>
    <div style="display:flex;align-items:baseline;gap:12px;padding:0 0 10px">
      <span style="font-family:var(--n-f-mono);font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--n-secondary)">Folders</span>
      <span style="font-family:var(--n-f-mono);font-size:9px;color:var(--n-muted)">${fuData.count.toLocaleString("en-US")} deletable · ${fuFmt(fuData.size)} reclaimable</span>
    </div>
    <div class="fu-folders">${foldersHtml}</div>
    <div class="fu-lvl">${fuActive ? fuEsc(fuActive) : "Select A Folder"} <span class="fu-badge">// DUAL EXPLORER — FOLDERS SYNCED · CLICK A FILE NAME TO PREVIEW</span></div>
    <div class="fu-split">
      <div class="fu-explorer">
        <div class="fu-exp-title">💾 ${fuEsc(fuVolume.toUpperCase())}<span class="fu-src">E:\\...\\${fuEsc(fuActive || "PROFILE")}</span></div>
        <div class="fu-crumbs" id="fuCrumbsHdd"></div>
        <div class="fu-exp-head"><span class="fu-c-nm">NAME</span><span class="fu-c-sz">SIZE</span><span class="fu-c-st">STATUS</span></div>
        <div class="fu-list" id="fuListHdd"></div>
      </div>
      <div class="fu-explorer">
        <div class="fu-exp-title">📱 ${fuEsc((fuDevice || "PHONE").toUpperCase())}<span class="fu-src">/STORAGE/EMULATED/0</span></div>
        <div class="fu-crumbs" id="fuCrumbsPhone"></div>
        <div class="fu-toolbar">
          <button class="fu-chip ${fuFilter === "all" ? "on-all" : ""}" onclick="fuSetFilter('all')">ALL</button>
          <button class="fu-chip ${fuFilter === "b" ? "on-b" : ""}" onclick="fuSetFilter('b')">SAFE</button>
          <button class="fu-chip ${fuFilter === "unb" ? "on-unb" : ""}" onclick="fuSetFilter('unb')">LOSS</button>
          <button class="fu-selectall" onclick="fuSelectAllB()">Select All Safe</button>
          <span class="fu-legend"><span class="fu-tag fu-b">SAFE</span> BACKED UP · <span class="fu-tag fu-unb">LOSS</span> NOT BACKED UP</span>
        </div>
        <div class="fu-exp-head"><span class="fu-c-nm">NAME</span><span class="fu-c-sz">SIZE</span><span class="fu-c-st">STATUS</span></div>
        <div class="fu-list" id="fuListPhone"></div>
      </div>
    </div>
    <div id="fuPreviewBox"></div>
    <div id="fuWarnBox"></div>
    <div class="fu-divider"></div>
    <div class="fu-footer">
      <span class="fu-foot-label">YEAR</span>
      <select id="fuYearFrom" class="fu-select" onchange="fuYearChanged()"><option value="">All Years</option>${yearOpts}</select>
      <span class="fu-foot-to">TO</span>
      <select id="fuYearTo" class="fu-select" onchange="fuYearChanged()"><option value="">All Years</option>${yearOpts}</select>
      <span class="fu-count" id="fuCount">0 SELECTED</span>
      <label style="display:flex;align-items:center;gap:6px;font-family:var(--n-f-mono);font-size:10px;letter-spacing:.06em;color:var(--n-secondary);cursor:pointer;user-select:none;margin-right:8px" title="Keep Empty Folders On The Phone After Deleting Files">
        <input type="checkbox" id="fuKeepFolders"> KEEP EMPTY FOLDERS
      </label>
      <button class="fu-btn fu-ghost" onclick="loadFreeUp()">Cancel</button>
      <button class="fu-btn fu-primary" id="fuDeleteBtn" onclick="fuConfirmDelete()" disabled>Delete</button>
    </div>`;
  // restore nilai year dropdown setelah rebuild
  $("#fuYearFrom").value = prevFrom;
  $("#fuYearTo").value = prevTo;
  fuRenderSplit();
  fuUpdateFooter();
}

function fuOpenFolder(f) { fuActive = f; fuSub = f; fuRender(); }

function fuFolderToggle(f, checked, wasIndeterminate) {
  // cascade: folder checked → semua file B di folder (sesuai year filter) masuk seleksi; unchecked → keluar semua
  const years = fuSelectedYears();
  const [yFrom, yTo] = years ?? [null, null];
  for (const x of fuData.fileDetails) {
    if (x.folder !== f || !fuData.files.includes(x.path)) continue;
    const y = new Date(x.mtime * 1000).getFullYear();
    if (yFrom && y < yFrom) continue;
    if (yTo && y > yTo) continue;
    if (checked) fuSel.add(x.path); else fuSel.delete(x.path);
  }
  fuRender();
}

function fuSelectedYears() {
  const from = parseInt($("#fuYearFrom")?.value) || null;
  const to = parseInt($("#fuYearTo")?.value) || null;
  return from || to ? [from ?? 0, to ?? 9999] : null;
}

function fuSetFilter(f) {
  fuFilter = f;
  // update chip class tanpa full re-render
  document.querySelectorAll(".fu-chip").forEach(c => {
    const k = c.textContent.trim().toLowerCase();
    c.classList.toggle("on-all", k === "all" && f === "all");
    c.classList.toggle("on-b", k === "b" && f === "b");
    c.classList.toggle("on-unb", k === "unb" && f === "unb");
  });
  fuRenderSplit();
}

// navigasi folder di dalam explorer (sinkron antar panel) — nav ke root = balik ke folder aktif
function fuNav(rel) { fuSub = rel || fuActive; fuRenderSplit(); }

function fuRenderSplit() {
  const hddRoot = fuActive || "";
  const phoneRoot = fuActive || "";
  // crumbs
  const crumbHtml = (root, rel, rootLabel) => {
    const parts = rel ? rel.split("/") : [];
    let acc = "";
    const links = [`<span class="fu-cr" onclick="fuNav('')">${rootLabel}</span>`];
    for (const p of parts) {
      acc += (acc ? "/" : "") + p;
      const isLast = acc === rel;
      links.push(`<span class="fu-sep">/</span><span class="fu-cr ${isLast ? "here" : ""}" onclick="fuNav('${fuEsc(acc).replace(/'/g, "\\'")}')">${fuEsc(p)}</span>`);
    }
    return links.join("");
  };
  $("#fuCrumbsHdd").innerHTML = crumbHtml(hddRoot, fuSub, "ERICKO");
  $("#fuCrumbsPhone").innerHTML = crumbHtml(phoneRoot, fuSub, "/");
  // files in current subpath — curDir "" = root folder aktif (tampilkan subfolder + file langsung)
  const relOf = (x) => x.path.replace(/^\/storage\/emulated\/0\//, "");
  const curDir = fuSub === fuActive ? "" : fuSub;
  const inSub = fuData.fileDetails.filter(x => {
    if (!fuActive) return false;
    const dir = relOf(x).split("/").slice(0, -1).join("/");
    // root view: file langsung di folder aktif; subview: file di subpath
    return dir === (curDir || fuActive);
  });
  const isB = (x) => fuData.files.includes(x.path);
  const rows = (list, side) => {
    // root view: tampilkan subfolder (dari SEMUA file folder aktif, bukan hanya file langsung di root)
    let dirHtml = "";
    if (!curDir) {
      const allInFolder = fuData.fileDetails.filter(x => x.folder === fuActive);
      // hanya file yang benar-benar di dalam subfolder (rel mengandung "/")
      const inDirs = allInFolder.filter(x => relOf(x).slice(fuActive.length + 1).includes("/"));
      const dirs = [...new Set(inDirs.map(x => relOf(x).slice(fuActive.length + 1).split("/")[0]))].sort();
      dirHtml = dirs.map(d => {
        const dFiles = allInFolder.filter(x => relOf(x).split("/")[1] === d);
        const dSize = dFiles.reduce((a, x) => a + x.size, 0);
        // status folder: B jika semua file ter-backup, UNB jika belum ada yang di-backup, PART jika sebagian
        const dB = dFiles.filter(x => isB(x)).length;
        const st = dB === 0 ? `<span class="fu-tag fu-unb">LOSS</span>`
          : dB < dFiles.length ? `<span class="fu-tag fu-part">PART</span>`
          : `<span class="fu-tag fu-b">SAFE</span>`;
        return `<div class="fu-frow dir" onclick="fuNav('${fuEsc(fuActive + "/" + d).replace(/'/g, "\\'")}')">
          <span class="msr">folder</span>
          <span class="fu-nm">${fuEsc(d)}</span>
          <span class="fu-sz">${fuFmt(dSize)}</span>
          <span class="fu-st">${st}</span>
        </div>`;
      }).join("");
    }
    let items = list.filter(x => side === "hdd" ? isB(x) : (fuFilter === "all" || (fuFilter === "b" ? isB(x) : !isB(x))));
    // sort size desc default
    items.sort((a, b) => b.size - a.size);
    // tag tipe file dari ekstensi
    const fuType = (p) => {
      const e = p.split(".").pop().toLowerCase();
      if (["jpg","jpeg","png","gif","webp","heic","bmp"].includes(e)) return "IMG";
      if (["mp4","mov","mkv","avi","3gp","webm"].includes(e)) return "VID";
      if (e === "pdf") return "PDF";
      if (["doc","docx"].includes(e)) return "DOC";
      if (["xls","xlsx"].includes(e)) return "XLS";
      if (["ppt","pptx"].includes(e)) return "PPT";
      if (["zip","rar","7z","tar","gz"].includes(e)) return "ZIP";
      if (e === "apk") return "APK";
      if (["jar","bin","dat"].includes(e)) return "BIN";
      if (["mp3","wav","ogg","m4a","flac"].includes(e)) return "AUD";
      if (["txt","md","csv","log"].includes(e)) return "TXT";
      return e.slice(0, 4).toUpperCase() || "FILE";
    };
    return dirHtml + items.map(x => {
      const rel = x.path.replace(/^\/storage\/emulated\/0\//, "");
      const name = rel.split("/").pop();
      const b = isB(x);
      const typeTag = `<span class="fu-tag fu-type">${fuType(x.path)}</span>`;
      if (side === "hdd") {
        const onPhone = fuData.fileDetails.some(y => y.path === x.path);
        return `<div class="fu-frow ${onPhone ? "" : "hdd-del"}">
          <span class="msr">${fuIcon(x.path)}</span>
          <span class="fu-nm">${fuEsc(name)}</span>
          <span class="fu-sz">${fuFmt(x.size)}</span>
          <span class="fu-st">${typeTag}<span class="fu-tag fu-safe">SAFE</span></span>
        </div>`;
      }
      return `<div class="fu-frow ${b ? "" : "unb"}">
        <input type="checkbox" ${fuSel.has(x.path) ? "checked" : ""} ${b && inYear(x) ? "" : "disabled"} ${!inYear(x) ? 'title="Outside Year Filter"' : ""} onchange="fuFileToggle('${fuEsc(x.path).replace(/'/g, "\\'")}', this.checked)">
        <span class="msr">${fuIcon(x.path)}</span>
        <span class="fu-nm fu-click" onclick="fuPreviewFile('${fuEsc(x.path).replace(/'/g, "\\'")}')">${fuEsc(name)}</span>
        <span class="fu-sz">${fuFmt(x.size)}</span>
        <span class="fu-st">${typeTag}<span class="fu-tag ${b ? "fu-safe" : "fu-loss"}">${b ? "SAFE" : "LOSS"}</span></span>
      </div>`;
    }).join("");
  };
  // year filter aktif → file di luar rentang tidak bisa dicentang (checkbox disabled) & sel lama dilepas
  const yr = fuSelectedYears();
  const inYear = (x) => {
    if (!yr) return true;
    const y = new Date(x.mtime * 1000).getFullYear();
    return y >= yr[0] && y <= yr[1];
  };
  if (yr) for (const p of [...fuSel]) {
    const x = fuData.fileDetails.find(f => f.path === p);
    if (x && !inYear(x)) fuSel.delete(p);
  }
  $("#fuListHdd").innerHTML = fuActive ? rows(inSub, "hdd") : '<p style="color:var(--n-secondary);font-size:12px;padding:16px;text-align:center">Select A Folder Above</p>';
  $("#fuListPhone").innerHTML = fuActive ? rows(inSub, "phone") : '<p style="color:var(--n-secondary);font-size:12px;padding:16px;text-align:center">Select A Folder Above</p>';
  // hdd-del note
  document.querySelectorAll("#fuListHdd .hdd-del .fu-nm").forEach(el => el.title = "Deleted From Phone");
  fuUpdateFooter();
}

function fuFileToggle(path, checked) {
  if (checked) fuSel.add(path); else fuSel.delete(path);
  // tanpa full re-render — scroll posisi tetap; update folder cascade + footer saja
  const x = fuData.fileDetails.find(f => f.path === path);
  if (x) {
    const bFiles = fuData.fileDetails.filter(y => y.folder === x.folder && fuData.files.includes(y.path));
    const selCount = bFiles.filter(y => fuSel.has(y.path)).length;
    const cb = document.querySelector(`[data-fu-cb="${CSS.escape(x.folder)}"]`);
    if (cb) { cb.checked = selCount === bFiles.length; cb.indeterminate = selCount > 0 && selCount < bFiles.length; }
    const note = document.getElementById("fu-note-" + CSS.escape(x.folder));
    if (note) note.textContent = cb?.indeterminate ? `// ${selCount} OF ${bFiles.length} SAFE FILES SELECTED` : "";
  }
  fuUpdateFooter();
}

function fuSelectAllB() {
  if (!fuActive) return;
  const years = fuSelectedYears();
  const [yFrom, yTo] = years ?? [null, null];
  for (const x of fuData.fileDetails) {
    if (x.folder !== fuActive || !fuData.files.includes(x.path)) continue;
    const rel = x.path.replace(/^\/storage\/emulated\/0\//, "");
    const dir = rel.split("/").slice(0, -1).join("/");
    if (dir !== fuSub) continue;
    const y = new Date(x.mtime * 1000).getFullYear();
    if (yFrom && y < yFrom) continue;
    if (yTo && y > yTo) continue;
    fuSel.add(x.path);
  }
  fuRender();
}

function fuPreviewFile(path) {
  fuPreview = path;
  const x = fuData.fileDetails.find(f => f.path === path);
  const name = path.split("/").pop();
  const isImg = /\.(jpe?g|png|gif|webp|heic)$/i.test(path);
  const isVid = /\.(mp4|mov|mkv|avi|3gp)$/i.test(path);
  const isPdf = /\.pdf$/i.test(path);
  // file B = preview dari HDD (rawfile), UNB = langsung dari HP (phone/preview)
  const src = fuData.files.includes(path)
    ? "/api/rawfile?path=" + encodeURIComponent(path.replace(/^\/storage\/emulated\/0\//, ""))
    : "/api/phone/preview?path=" + encodeURIComponent(path);
  let media = `<div class="fu-thumb"><span class="msr" style="font-size:32px">${fuIcon(path)}</span></div>`;
  if (isImg) media = `<img class="fu-thumb-img" src="${src}" alt="">`;
  else if (isVid) media = `<video class="fu-thumb-img" src="${src}" controls></video>`;
  else if (isPdf) media = `<a class="fu-thumb" href="${src}" target="_blank">PDF ↗</a>`;
  $("#fuPreviewBox").innerHTML = `
    <div class="fu-preview">
      ${media}
      <div class="fu-pv-info">
        <b>${fuEsc(name)}</b>
        <span>${fuFmt(x?.size ?? 0)} · ${x ? new Date(x.mtime * 1000).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase() : ""} · ${fuData.files.includes(path) ? "B — BACKED UP ON DRIVE" : "UNB — NOT BACKED UP"}</span>
      </div>
      <span class="fu-pv-close" onclick="fuPreviewClose()">✕</span>
    </div>`;
}

function fuPreviewClose() { fuPreview = null; $("#fuPreviewBox").innerHTML = ""; }

// year dropdown berubah → lepas seleksi di luar rentang + re-render penuh (checkbox state ikut)
function fuYearChanged() {
  const yr = fuSelectedYears();
  if (yr) for (const p of [...fuSel]) {
    const x = fuData.fileDetails.find(f => f.path === p);
    if (x) { const y = new Date(x.mtime * 1000).getFullYear(); if (y < yr[0] || y > yr[1]) fuSel.delete(p); }
  }
  fuRender();
}

function fuUpdateFooter() {  const years = fuSelectedYears();
  const [yFrom, yTo] = years ?? [null, null];
  let count = 0, size = 0;
  for (const x of fuData?.fileDetails ?? []) {
    if (!fuSel.has(x.path)) continue;
    const y = new Date(x.mtime * 1000).getFullYear();
    if (yFrom && y < yFrom) continue;
    if (yTo && y > yTo) continue;
    count++; size += x.size;
  }
  $("#fuCount").textContent = `${count} SELECTED · ${fuFmt(size)} WILL BE FREED`;
  $("#fuDeleteBtn").disabled = count === 0;
  $("#fuDeleteBtn").textContent = count ? `Delete ${count} Files` : "Delete";
}

async function fuConfirmDelete() {
  if (!fuData || !fuSel.size) return;
  showPromptDialog("Confirm Delete", `Type DELETE To Remove ${fuSel.size} Backed-Up Files From Your Phone (This Cannot Be Undone):`, "", async (v) => {
    if (v !== "DELETE") { errorToast("Confirmation Does Not Match"); return; }
    const years = fuSelectedYears();
    const keepFolders = $("#fuKeepFolders")?.checked ?? false;
    const r = await (await fetch("/api/phone/cleanup-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [...fuSel], ...(years ? { years } : {}), keepFolders, serial: pickerDevice || undefined }) })).json().catch(() => null);
    if (!r || r.error) { errorToast(r?.error ?? "Delete Failed"); return; }
    toast(`Deleted ${r.deleted} Files — ${fuFmt(r.freed)} Freed${keepFolders ? " · Empty Folders Kept" : " · Empty Folders Removed"}${r.failed ? ` · ${r.failed} Failed` : ""}`, r.failed ? "warning" : "delete");
    loadFreeUp();
  });
}

async function appsPdfCompress(name, btn) {
  if (!name) { toast("Missing File", "error"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "WORKING…"; }
  toast("Compressing — This May Take A While");
  try {
    const r = await (await fetch("/api/apps/pdf-compress", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, quality: 70 }),
    })).json();
    if (r.error) errorToast(r.error);
    else {
      const mb = (b) => (b / 1e6).toFixed(1) + " MB";
      toast(`Compressed: ${r.out} — ${mb(r.srcSize)} → ${mb(r.outSize)}`);
      loadAppsFiles();
    }
  } catch (e) { errorToast("Compress Failed — " + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "COMPRESS"; } }
}

async function appsVideoCompress(name, btn) {
  if (!name) { toast("Missing File", "error"); return; }
  const f = (appsFilesCache ?? []).find(x => x.name === name);
  const srcMb = f ? f.size / 1e6 : 0;
  showPromptDialog("Compress Video — " + name, "Target Size (MB):", srcMb ? String(Math.max(1, Math.round(srcMb / 2))) : "8", (v) => {
    const mb = parseFloat(v);
    if (!mb || mb <= 0) { toast("Invalid Size", "error"); return; }
    if (srcMb && mb >= srcMb) { toast("Target Must Be Smaller Than Source (" + srcMb.toFixed(1) + " MB)", "error"); return; }
    appsVideoCompressDo(name, mb, btn);
  }, srcMb ? `Source: ${srcMb.toFixed(1)} MB — Suggested: ${Math.max(1, Math.round(srcMb / 2))} MB` : "");
}
async function appsVideoCompressDo(name, targetMb, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "0%"; }
  try {
    const { id, error } = await (await fetch("/api/apps/video-compress", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, targetMb }),
    })).json();
    if (error) { errorToast(error); return; }
    // poll job sampai done
    while (true) {
      await new Promise(res => setTimeout(res, 1000));
      const j = await fetch("/api/apps/download/" + id).then(r => r.json()).catch(() => null);
      if (!j) { errorToast("Job Lost"); return; }
      if (btn) btn.textContent = (j.pct ?? 0) + "%";
      if (j.done) {
        if (j.error) errorToast("Compress Failed — " + j.error);
        else { toast("Compressed: " + name.replace(/\.[^.]+$/, "") + ".compressed.mp4"); loadAppsFiles(); }
        return;
      }
    }
  } catch (e) { errorToast("Compress Failed — " + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "COMPRESS"; } }
}

async function appsPdfMerge() {
  const names = [...document.querySelectorAll(".apps-pdf-merge-cb:checked")].map(cb => cb.value);
  if (names.length < 2) { toast("Select At Least 2 PDFs", "error"); return; }
  const r = await (await fetch("/api/apps/pdf-merge", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names }),
  })).json();
  if (r.error) errorToast(r.error); else { toast("Merged: " + r.out); loadAppsFiles(); }
}

async function appsPdfSplit(name) {
  if (!name) { toast("Missing File", "error"); return; }
  showPromptDialog("Split PDF — " + name, "Page Range (e.g. 1-5, Or 3- For Until Last Page):", "1-", (v) => {
    const m = v.match(/^(\d+)\s*-\s*(\d*)$/);
    if (!m || (m[2] && +m[2] < +m[1])) { toast("Invalid Range", "error"); return; }
    appsPdfSplitDo(name, +m[1], m[2] ? +m[2] : 0);
  });
}
async function appsPdfSplitDo(name, from, to) {
  const r = await (await fetch("/api/apps/pdf-split", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, from, to }),
  })).json();
  if (r.error) errorToast(r.error); else { toast("Split: " + r.out); loadAppsFiles(); }
}

async function appsImageConvert(name, format) {
  if (!name || !format) return;
  const r = await (await fetch("/api/apps/image-convert", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, format, quality: 80 }),
  })).json();
  if (r.error) errorToast(r.error); else { toast("Converted: " + r.out); loadAppsFiles(); }
}



// ===== NigiroConvert: video/audio convert =====
async function appsMediaConvert(name, format) {
  if (!name || !format) return;
  toast("Converting — This May Take A While");
  const r = await (await fetch("/api/apps/media-convert", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, format }),
  })).json();
  if (r.error) errorToast(r.error); else { toast("Converted: " + r.out); loadAppsFiles(); }
}

// ===== NIGIRO.MC — Minecraft panel =====
let mcPoll = null, mcConsoleFor = null, mcPropsFor = null;
function mcOpen() { showView("app-mc"); mcRefresh(); }

async function mcRefresh() {
  const j = await (await fetch("/api/mc/status")).json().catch(() => null);
  if (!j) return;
  // java status
  const st = $("#mcJavaStatus"), box = $("#mcJavaInstall");
  const dot = (cls) => `<span class="mc-status-dot ${cls}"></span>`;
  if (j.java) {
    st.innerHTML = dot("on") + "JAVA " + j.java.major + (j.java.managed ? " (MANAGED)" : " (SYSTEM)") + " ✓";
    st.style.color = "var(--n-accent,#D71921)"; box.style.display = "none";
    $("#mcJavaStats").style.display = "flex";
    $("#mcStatVer").textContent = "JRE " + j.java.major;
    $("#mcStatVendor").textContent = (j.java.exe?.match(/jdk-\d+-(\w+)/) ?? [])[1]?.toUpperCase() ?? (j.java.managed ? "MANAGED" : "SYSTEM");
    $("#mcStatType").textContent = j.java.managed ? "PANEL-INSTALLED" : "SYSTEM PATH";
  } else { st.innerHTML = dot("off") + "NOT INSTALLED"; st.style.color = "var(--n-secondary)"; box.style.display = "flex"; $("#mcJavaStats").style.display = "none"; }
  // installing jobs
  if (j.installing?.length) {
    $("#mcJavaProgress").style.display = "block";
    const job = j.installing[0];
    $("#mcJavaPct").textContent = String(job.pct).padStart(3, "0") + "%";
    $("#mcJavaLine").textContent = job.line ?? "";
    const led = $("#mcJavaLed");
    led.innerHTML = Array.from({ length: 24 }, (_, i) => `<i${i < Math.round(job.pct / 100 * 24) ? ' class="on"' : ""}></i>`).join("");
  } else {
    $("#mcJavaProgress").style.display = "none";
  }
  // servers
  const running = j.servers.filter(s => s.running).length;
  $("#mcServerCount").textContent = j.servers.length ? `${j.servers.length} TOTAL · ${running} RUNNING` : "";
  // badge running di sidebar
  const sb = document.querySelector("#mcSidebar .mc-nav[data-tab='servers']");
  const oldBadge = sb?.querySelector(".badge"); if (oldBadge) oldBadge.remove();
  if (running && sb) sb.insertAdjacentHTML("beforeend", `<span class="badge">${running}</span>`);
  const list = $("#mcServers");
  // sinkron server aktif + picker list
  if (!mcActive) mcActive = localStorage.getItem("mcActive") || null;
  if (mcActive && !j.servers.some(s => s.name === mcActive)) { mcActive = null; localStorage.removeItem("mcActive"); }
  if (!mcActive && j.servers.length) mcActive = j.servers[0].name;
  localStorage.setItem("mcActive", mcActive ?? "");
  mcActiveRender(j.servers.find(s => s.name === mcActive));
  mcActiveSync(j.servers);
  list.innerHTML = j.servers.length ? j.servers.map(s => `
    <div class="nui-row">
      <span class="msr" style="font-size:18px;color:${s.running ? "var(--n-accent,#D71921)" : "var(--n-secondary)"}">sports_esports</span>
      <span class="nui-row-name">${s.name}</span>
      <span class="nui-row-meta">${s.loader.toUpperCase()} ${s.mc_version} · ${s.running ? "RUNNING" : "STOPPED"}${s.orphan ? " (ORPHAN)" : ""}</span>
      ${s.running
        ? `<button class="nui-btn" style="padding:8px 14px;font-size:10px" onclick="mcStop('${s.name}')">STOP</button>`
        : `<button class="nui-btn accent" style="padding:8px 14px;font-size:10px" onclick="mcStart('${s.name}')">START</button>`}
      <span class="act msr" onclick="mcShowConsole('${s.name}')" title="Console">terminal</span>
      <span class="act msr" onclick="mcShowProps('${s.name}')" title="Properties">settings</span>
      <span class="act msr" onclick="mcModsSelectServer('${s.name}')" title="Mods">extension</span>
      <span class="act msr" onclick="mcFilesSelectServer('${s.name}')" title="Files">folder_open</span>
      <span class="act msr" onclick="mcManageSelectServer('${s.name}')" title="Manage">settings_suggest</span>
      <span class="act msr" onclick="mcDelete('${s.name}')" title="Delete">delete</span>
    </div>`).join("") : '<span class="nui-empty">No Servers — Create One Above</span>';
}

async function mcInstallJava(btn) {
  btn.disabled = true; btn.textContent = "STARTING…";
  const r = await (await fetch("/api/mc/java/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ major: +$("#mcJavaVer").value, vendor: $("#mcJavaVendor").value }) })).json().catch(() => ({ error: "gagal" }));
  btn.disabled = false; btn.textContent = "INSTALL";
  if (r.error) { errorToast(r.error); return; }
  $("#mcJavaProgress").style.display = "block";
  if (mcPoll) clearInterval(mcPoll);
  mcPoll = setInterval(async () => {
    const j = await (await fetch("/api/mc/job/" + r.id ?? "")).json().catch(() => null);
    if (!j) return;
    $("#mcJavaPct").textContent = String(j.pct).padStart(3, "0") + "%";
    $("#mcJavaLine").textContent = j.line ?? "";
    const led = $("#mcJavaLed");
    led.innerHTML = Array.from({ length: 24 }, (_, i) => `<i${i < Math.round(j.pct / 100 * 24) ? ' class="on"' : ""}></i>`).join("");
    if (j.done) {
      clearInterval(mcPoll); mcPoll = null;
      if (j.error) errorToast("Java Install Failed — " + j.error);
      else { toast("Java Ready"); mcRefresh(); }
    }
  }, 700);
}

async function mcCreate(btn) {
  const name = $("#mcName").value.trim(), loader = $("#mcLoader").value, mcVersion = $("#mcVersion").value.trim();
  if (!name) { toast("Enter Server Name", "error"); return; }
  btn.disabled = true;
  const r = await (await fetch("/api/mc/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, loader, mcVersion }) })).json().catch(() => ({ error: "gagal" }));
  btn.disabled = false;
  if (r.error) { errorToast(r.error); return; }
  toast("Creating " + name + "…");
  $("#mcName").value = "";
  if (mcPoll) clearInterval(mcPoll);
  mcPoll = setInterval(async () => {
    const j = await (await fetch("/api/mc/job/" + r.id)).json().catch(() => null);
    if (j?.done) {
      clearInterval(mcPoll); mcPoll = null;
      if (j.error) errorToast("Create Failed — " + j.error);
      else toast("Server " + name + " Ready");
      mcRefresh();
    }
  }, 900);
}

async function mcStart(name) {
  const r = await (await fetch("/api/mc/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })).json();
  if (r.error) errorToast(r.error); else { toast("Starting " + name); mcShowConsole(name); }
  mcRefresh();
}

async function mcStop(name) {
  const r = await (await fetch("/api/mc/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })).json();
  if (r.error) errorToast(r.error); else toast("Stopping " + name + " — Graceful");
  // restart terjadwal dari dashboard Restart button
  if (pendingRestartFlag === name) {
    pendingRestartFlag = null;
    const wait = setInterval(async () => {
      const st = await (await fetch("/api/mc/status")).json();
      if (!st.servers.find(s => s.name === name)?.running) {
        clearInterval(wait);
        setTimeout(() => mcStart(name), 2000);
      }
    }, 1000);
    return;
  }
  mcRefresh();
}

async function mcDelete(name) {
  // konfirmasi ketik-nama (pola kubek) — dialog custom M3, bukan prompt native
  showPromptDialog("Delete Server — " + name, `Type "${name}" To Confirm (World Data Will Be Lost Permanently):`, "", (v) => {
    if (v !== name) { errorToast("Name Does Not Match"); return; }
    mcDeleteDo(name);
  });
}
async function mcDeleteDo(name) {
  const r = await (await fetch("/api/mc/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, confirm: name }) })).json();
  if (r.error) errorToast(r.error); else toast("Deleted " + name);
  mcRefresh();
}

function mcTab(tab) {
  document.querySelectorAll("#view-app-mc .mc-pane").forEach(p => p.style.display = p.dataset.pane === tab ? "" : "none");
  document.querySelectorAll("#view-app-mc .mc-nav").forEach(b => b.classList.toggle("sel", b.dataset.tab === tab));
  $("#mcActivePicker").style.display = (tab === "servers" && mcActiveServers.length) ? "" : "none";
  // auto-load per tab (survive refresh — state dari localStorage)
  if (tab === "console") { mcConsoleFor = mcConsoleFor || localStorage.getItem("mcConsoleFor") || mcActive; if (mcConsoleFor) { $("#mcConsoleName").textContent = mcConsoleFor; mcStreamConsole(); } }
  if (tab === "files" && mcActive) mcFilesOpen(mcFilesRel || "");
  if (tab === "props") { const p = localStorage.getItem("mcPropsFor") || mcActive; if (p) mcShowProps(p); }
}
document.getElementById("mcMenuBtn").onclick = () => document.getElementById("mcSidebar").classList.toggle("collapsed");

// --- Active server (global, seperti profile) ---
let mcActive = null; // nama server aktif
let mcActiveServers = [];
function mcSetActive(name) {
  mcActive = name || null;
  localStorage.setItem("mcActive", name ?? "");
  mcActiveRender(mcActiveServers.find(s => s.name === mcActive));
  mcActiveSync(mcActiveServers);
}
function mcActiveRender(s) {
  if (!mcActive) { $("#mcActiveName").textContent = "NO SERVER SELECTED"; $("#mcActiveMeta").textContent = "Create Or Select A Server First"; $("#mcActiveBadge").style.display = "none"; $("#mcDashCard").style.display = "none"; return; }
  $("#mcActiveName").textContent = mcActive.toUpperCase();
  $("#mcActiveMeta").textContent = s ? `${s.loader.toUpperCase()} ${s.mc_version} · ${s.running ? "RUNNING" : "STOPPED"}` : "";
  $("#mcActiveBadge").style.display = "";
  const dot = $("#mcActiveBadge").querySelector(".mc-dot");
  // badge status ala opanel: hijau online, kuning running-tapi-belum-ready, merah stopped
  const st = s?.online ? "on" : s?.running ? "warn" : "off";
  dot.className = "mc-dot " + st;
  $("#mcActiveBadgeTxt").textContent = s?.online ? "ONLINE" : s?.running ? "STARTING" : s?.orphan ? "ORPHAN" : "STOPPED";
  $("#mcDashCard").style.display = mcActive ? "block" : "none";
  mcDashLoad();
}

// ===== Dashboard card (pola opanel InfoCard/PlayersCard/TimeCard) =====
let mcDashTimer = null, mcDashShowJava = false, mcDashLast = null;
async function mcDashLoad() {
  if (!mcActive) return;
  const j = await fetch("/api/mc/dashboard/" + encodeURIComponent(mcActive)).then(r => r.json()).catch(() => null);
  if (!j || j.error) return;
  mcDashLast = j;
  $("#mcDashVersion").textContent = mcDashShowJava ? `JAVA ${j.javaMajor ?? "?"}` : `${j.loader.toUpperCase()} ${j.mcVersion}`;
  $("#mcDashPort").textContent = j.port ?? "—";
  $("#mcDashMotd").textContent = j.motd ?? "";
  $("#mcDashPlayers").textContent = (j.players ?? []).length;
  $("#mcDashMax").textContent = "/" + (j.maxPlayers ?? 20);
  $("#mcDashPlayerList").textContent = (j.players ?? []).join(", ");
  const up = j.uptimeSec ?? 0;
  $("#mcDashUptime").textContent = j.online ? `${Math.floor(up / 3600)}:${String(Math.floor((up % 3600) / 60)).padStart(2, "0")}:${String(up % 60).padStart(2, "0")}` : "—";
  mcMonDraw(j.metrics ?? {});
  // refresh uptime tiap detik selama online (tanpa refetch — lokal tick)
  clearTimeout(mcDashTimer);
  if (j.online) mcDashTimer = setTimeout(() => { if (mcDashLast?.online && mcActive) { mcDashLast.uptimeSec++; mcDashUptimeTick(); } }, 1000);
}
// sparkline area chart (pola opanel MonitorCard — grid horizontal only, gradient fill, axis hidden)
function mcMonDraw(m) {
  const draw = (id, data, valId, unit, max) => {
    const c = document.getElementById(id);
    if (!c) return;
    const ctx = c.getContext("2d");
    const w = c.width = c.clientWidth * devicePixelRatio, h = c.height = 48 * devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--n-accent") || "#D71921";
    const line = getComputedStyle(document.documentElement).getPropertyValue("--n-line") || "#333";
    // grid horizontal saja (opanel)
    ctx.strokeStyle = line.trim(); ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(0, h * i / 3); ctx.lineTo(w, h * i / 3); ctx.stroke(); }
    if (!data?.length) return;
    const top = Math.max(max, ...data);
    const px = (i) => (i / (data.length - 1 || 1)) * w;
    const py = (v) => h - (v / top) * (h - 4) - 2;
    // gradient fill
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, accent.trim() + "44"); g.addColorStop(1, accent.trim() + "00");
    ctx.beginPath(); ctx.moveTo(0, h);
    data.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.lineTo(w, h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    // stroke 2px
    ctx.beginPath();
    data.forEach((v, i) => i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v)));
    ctx.strokeStyle = accent.trim(); ctx.lineWidth = 2 * devicePixelRatio; ctx.stroke();
    const el = document.getElementById(valId);
    if (el) el.textContent = data.at(-1) + (unit ?? "");
  };
  draw("mcMonCpu", m.cpu, "mcMonCpuVal", "%", 100);
  draw("mcMonMem", m.mem, "mcMonMemVal", " MB", 1024);
}
function mcDashUptimeTick() {
  const up = mcDashLast.uptimeSec;
  $("#mcDashUptime").textContent = `${Math.floor(up / 3600)}:${String(Math.floor((up % 3600) / 60)).padStart(2, "0")}:${String(up % 60).padStart(2, "0")}`;
  mcDashTimer = setTimeout(() => { if (mcDashLast?.online && mcActive) { mcDashLast.uptimeSec++; mcDashUptimeTick(); } }, 1000);
}
function mcDashToggleVer() { mcDashShowJava = !mcDashShowJava; if (mcDashLast) $("#mcDashVersion").textContent = mcDashShowJava ? `JAVA ${mcDashLast.javaMajor ?? "?"}` : `${mcDashLast.loader.toUpperCase()} ${mcDashLast.mcVersion}`; }
function mcRestartConfirm() {
  if (!mcActive) return;
  showConfirmDialog("Restart Server", `Restart "${mcActive}"? Players Will Be Disconnected.`, async () => {
    await fetch("/api/mc/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive }) });
    pendingRestartFlag = mcActive; // di-set agar start ulang setelah stop selesai
    toast("Restarting — Graceful Stop First");
  });
}
let pendingRestartFlag = null;
function mcStopConfirm() {
  if (!mcActive) return;
  showConfirmDialog("Stop Server", `Stop "${mcActive}"? World Will Be Saved Gracefully.`, async () => {
    await fetch("/api/mc/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive }) });
    toast("Stopping — Graceful");
    mcRefresh();
  });
}
function mcActiveRequire() {
  if (!mcActive) { errorToast("Select A Server First (List Above)"); return false; }
  return true;
}
// isi list server ke picker (dipanggil dari mcRefresh setiap status update)
function mcActiveSync(servers) {
  mcActiveServers = servers;
  const box = $("#mcActivePicker"), list = $("#mcActiveList");
  const tab = document.querySelector("#view-app-mc .mc-nav.sel")?.dataset.tab;
  box.style.display = (servers.length && tab === "servers") ? "" : "none";
  list.innerHTML = servers.map(s => `
    <div class="nui-row" style="cursor:pointer;${s.name === mcActive ? "background:var(--n-raised);border-radius:10px" : ""}" onclick="mcSetActive('${s.name}')">
      <span class="msr" style="font-size:18px;color:${s.running ? "var(--n-accent,#D71921)" : "var(--n-secondary)"}">sports_esports</span>
      <span class="nui-row-name">${s.name}</span>
      <span class="nui-row-meta">${s.loader.toUpperCase()} ${s.mc_version} · ${s.running ? "RUNNING" : "STOPPED"}</span>
      ${s.name === mcActive ? '<span class="msr" style="font-size:16px;color:var(--n-accent,#D71921)">check_circle</span>' : ""}
    </div>`).join("");
}

// --- Phase 2: Modrinth — pola opanel players page: tabs (Installed default) ---
let mcModsFor = null;
let mcModsTab = "installed";
function mcModsTabSet(t) {
  mcModsTab = t;
  $("#mcModsTabInst").classList.toggle("sel", t === "installed");
  $("#mcModsTabBrowse").classList.toggle("sel", t === "browse");
  $("#mcModsBrowse").style.display = t === "browse" ? "block" : "none";
  $("#mcModsInstalledWrap").style.display = t === "installed" ? "block" : "none";
  if (t === "installed") mcModsList();
}
async function mcModsRefresh() {
  $("#mcModsServerName").textContent = (mcActive ?? "").toUpperCase();
  mcModsTabSet(mcModsTab); // persist tab antar kunjungan
  if (mcModsTab === "browse" && !$("#mcModsResults").innerHTML.trim()) mcModsSearch();
}
function mcModsSelectServer(name) {
  mcSetActive(name);
  mcTab("mods");
  mcModsList();
}
let mcProvider = "all";
let mcHangarPage = 1, mcHangarTotal = 0;
const MC_HANGAR_PER = 10;
function mcHangarGo(p) { mcHangarPage = p; mcModsSearch(); }
function mcProviderSet(p) {
  mcProvider = p;
  for (const [id, v] of [["mcProvAll", "all"], ["mcProvModrinth", "modrinth"], ["mcProvHangar", "hangar"]]) {
    const b = $("#" + id);
    b.style.background = v === p ? "var(--n-accent,#D71921)" : "";
    b.style.color = v === p ? "#fff" : "";
  }
  mcModsSearch();
}
async function mcModsSearch() {
  if (!mcActiveRequire()) return;
  const q = $("#mcModsQuery").value.trim();
  const loader = (await (await fetch("/api/mc/status")).json()).servers.find(s => s.name === mcActive)?.loader;
  const provider = mcProvider;
  const [mr, hg] = await Promise.allSettled([
    provider !== "hangar" ? fetch("/api/mc/modrinth/search?q=" + encodeURIComponent(q) + "&type=" + (loader === "paper" ? "plugin" : "mod") + (loader ? "&loader=" + loader : "")).then(r => r.json()) : Promise.resolve([]),
    provider !== "modrinth" ? fetch(`/api/mc/hangar/search?q=${encodeURIComponent(q)}&page=${mcHangarPage}&perPage=${MC_HANGAR_PER}`).then(r => r.json()) : Promise.resolve({ items: [] }),
  ]);
  const r = mr.status === "fulfilled" ? mr.value : { error: "gagal" };
  if (r.error) { errorToast(r.error); return; }
  const hgres = hg.status === "fulfilled" && hg.value?.items ? hg.value : { items: [], total: 0 };
  const hangar = Array.isArray(hgres.items) ? hgres.items : [];
  mcHangarTotal = hgres.total ?? hangar.length;
  const page = mcHangarPage, perPage = MC_HANGAR_PER;
  const all = [...hangar, ...r]; // Hangar dulu (plugin Paper native)
  if (!all.length) {
    $("#mcModsResults").innerHTML = `<span class="nui-empty">${provider === "hangar" ? "No Hangar Results" : "No Results"}</span>`;
    $("#mcHangarPaging").innerHTML = "";
    return;
  }
  $("#mcHangarPaging").innerHTML = (provider !== "modrinth" && mcHangarTotal > perPage) ? `
    <button class="nui-btn" ${page <= 1 ? "disabled" : ""} onclick="mcHangarGo(${page - 1})">← PREV</button>
    <span class="nui-label" style="padding:0 12px">PAGE ${page} / ${Math.ceil(hangarTotal / perPage)}</span>
    <button class="nui-btn" ${page * perPage >= mcHangarTotal ? "disabled" : ""} onclick="mcHangarGo(${page + 1})">NEXT →</button>` : "";
  $("#mcModsResults").innerHTML = all.length ? all.map(m => `
    <div class="nui-row" style="align-items:flex-start;display:flex;gap:12px;padding:12px">
      ${m.icon
        ? `<img src="${m.icon}" loading="lazy" style="width:56px;height:56px;border-radius:10px;cursor:pointer;flex-shrink:0;object-fit:cover;background:var(--n-raised)" onclick="window.open('${m.page}','_blank')" title="Open On ${m.hangar ? "Hangar" : "Modrinth"}">`
        : `<span class="msr" style="font-size:28px;color:var(--n-secondary);width:56px;height:56px;display:flex;align-items:center;justify-content:center;background:var(--n-raised);border-radius:10px;flex-shrink:0;cursor:pointer" onclick="window.open('${m.page}','_blank')">extension</span>`}
      <div style="flex:1;min-width:0;cursor:pointer" onclick="${m.hangar ? `window.open('${m.page}','_blank')` : `mcModsDetail('${m.slug}')`}">
        <div style="font-family:var(--n-f-ui);font-weight:600;font-size:14px;color:var(--n-primary)">${esc(m.title)} <span style="font-size:9px;font-family:var(--n-f-mono);background:var(--n-raised);color:var(--n-secondary);padding:2px 6px;border-radius:6px;vertical-align:2px;letter-spacing:.06em">${m.hangar ? "HANGAR" : "MODRINTH"}</span></div>
        <div style="font-family:var(--n-f-mono);font-size:10px;color:var(--n-secondary);margin:3px 0 6px;text-transform:uppercase;letter-spacing:.06em">${(m.downloads ?? 0).toLocaleString("en-US")} DOWNLOADS</div>
        <div style="font-size:12px;color:var(--n-secondary);line-height:1.4;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(m.desc ?? "")}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
        ${m.hangar
          ? `<button class="nui-btn accent" style="padding:8px 14px;font-size:10px" onclick="mcHangarInstall('${m.slug}',this)">INSTALL</button>`
          : `<button class="nui-btn" style="padding:8px 14px;font-size:10px" onclick="mcModsDetail('${m.slug}')">DETAIL</button>
             <button class="nui-btn accent" style="padding:8px 14px;font-size:10px" onclick="mcModsInstall('${m.slug}',this)">INSTALL</button>`}
      </div>
    </div>`).join("") : '<span class="nui-empty">No Results</span>';
}
async function mcHangarInstall(slug, btn) {
  if (!mcActiveRequire()) return;
  btn.disabled = true; btn.textContent = "…";
  const r = await (await fetch("/api/mc/hangar/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive, slug }) })).json().catch(() => ({ error: "gagal" }));
  btn.disabled = false; btn.textContent = "INSTALL";
  if (r.error) { errorToast(r.error); return; }
  toast("Installed " + r.file);
  mcModsList();
}
async function mcModsDetail(slug) {
  const j = await (await fetch("/api/mc/modrinth/description/" + slug)).json().catch(() => null);
  if (!j || j.error) { errorToast(j?.error ?? "Failed To Load Details"); return; }
  // render markdown penuh — marked + DOMPurify (CDN), gambar & YouTube embed jalan
  const raw = String(j.body ?? "");
  let clean = raw;
  try { clean = DOMPurify.sanitize(marked.parse(raw, { breaks: true }), { ADD_ATTR: ["target", "allow", "allowfullscreen", "frameborder", "width", "height", "style"], ADD_TAGS: ["iframe"] }); } catch {}
  // link YouTube → iframe embed
  clean = clean.replace(/\[([^\]]*)\]\((https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)[^)]*)\)/g,
    (_, t, __, id) => `<iframe width="100%" height="315" src="https://www.youtube.com/embed/${id}" title="${t || id}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="border-radius:8px;margin:8px 0"></iframe>`);
  // link YouTube telanjang (tanpa markdown) → embed juga
  clean = clean.replace(/(?<!href="|src=")(https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)[^\s<]*)/g,
    (_, __, id) => `<iframe width="100%" height="315" src="https://www.youtube.com/embed/${id}" title="YouTube video" frameborder="0" allowfullscreen style="border-radius:8px;margin:8px 0"></iframe>`);
  showInfoDialogHtml(j.title, `
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:12px">
      ${j.icon ? `<img src="${j.icon}" style="width:56px;height:56px;border-radius:12px;object-fit:cover">` : ""}
      <div style="flex:1">
        <div class="nui-label">${j.license ? "LICENSE: " + j.license : ""}</div>
        <div class="nui-sub" style="margin:2px 0 0">${j.desc ?? ""}</div>
      </div>
      <a class="nui-btn ghost" href="${j.page}" target="_blank" style="text-decoration:none">MODRINTH ↗</a>
    </div>
    <div style="font-size:13px;line-height:1.6;color:var(--n-primary);border-top:1px solid var(--n-line);padding-top:10px">${clean}</div>`);
}
async function mcModsInstall(slug, btn) {
  if (!mcActiveRequire()) return;
  const name = mcActive;
  btn.disabled = true; btn.textContent = "…";
  // ambil versi terbaru yang kompatibel dengan versi MC server
  const r = await (await fetch("/api/mc/modrinth/install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, slug }) })).json().catch(() => ({ error: "gagal" }));
  btn.disabled = false; btn.textContent = "INSTALL";
  if (r.error) { errorToast(r.error); return; }
  toast("Installed " + r.file);
  mcModsList();
}
function mcModsVersions(slug) {
  window.open(`/api/mc/modrinth/versions/${slug}?server=${mcActive}`, "_blank");
}
async function mcModsList() {
  if (!mcActive) { $("#mcModsInstalled").innerHTML = '<span class="nui-empty">Select A Server First</span>'; return; }
  const r = await (await fetch("/api/mc/modrinth/list/" + mcActive)).json().catch(() => []);
  $("#mcModsTabInst").innerHTML = `INSTALLED <span class="mc-tbadge">${r.length}</span>`;
  $("#mcModsInstalled").innerHTML = r.length ? r.map(m => `
    <div class="nui-row">
      <span class="msr" style="font-size:18px;color:var(--n-secondary)">description</span>
      <span class="nui-row-name">${m.file}</span>
      <span class="nui-row-meta">${m.dir.toUpperCase()}</span>
      <button class="nui-btn" style="padding:8px 14px;font-size:10px" onclick="mcModsRemove('${mcActive}','${m.dir}','${m.file}')">REMOVE</button>
    </div>`).join("") : '<span class="nui-empty">No Mods Installed — Browse To Install</span>';
}
async function mcModsRemove(name, dir, file) {
  showConfirmDialog("Remove Mod", `Remove "${file}"?`, async () => {
    await fetch("/api/mc/modrinth/remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, dir, file }) });
    mcModsList();
  });
}

// --- Files manager ---
let mcFilesRel = "";
function mcFilesSelectServer(name) { mcSetActive(name); mcTab("files"); mcFilesOpen(""); }
let mcFilesEntries = []; // cache untuk filter
async function mcFilesOpen(rel) {
  if (!mcActive) { $("#mcFilesList").innerHTML = '<span class="nui-empty">Select A Server First</span>'; return; }
  const name = mcActive;
  mcFilesRel = rel;
  $("#mcFilesPath").textContent = "/" + rel;
  $("#mcFileEdit").style.display = "none";
  $("#mcFilesUp").style.display = rel ? "" : "none";
  const j = await (await fetch(`/api/mc/files/${name}?path=${encodeURIComponent(rel)}`)).json().catch(() => null);
  if (!j || !j.dir) { errorToast("Cannot Read Folder"); return; }
  mcFilesEntries = j.entries.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
  mcFilesRender();
}
function mcFilesRender() {
  const q = ($("#mcFilesFilter").value || "").toLowerCase();
  const rows = mcFilesEntries.filter(e => e.name.toLowerCase().includes(q));
  const fmtSize = (s) => s >= 1048576 ? (s / 1048576).toFixed(1) + " MB" : s >= 1024 ? (s / 1024).toFixed(1) + " KB" : s + " B";
  $("#mcFilesList").innerHTML = rows.length ? rows.map(e => `
    <div class="nui-row">
      <span class="msr" style="font-size:18px;color:${e.dir ? "var(--n-accent,#D71921)" : "var(--n-secondary)"}">${e.dir ? "folder" : "draft"}</span>
      <span class="nui-row-name" style="cursor:pointer" ${e.dir ? `onclick="mcFilesOpen('${esc((mcFilesRel ? mcFilesRel + "/" : "") + e.name)}')"` : `onclick="mcFileEdit('${esc((mcFilesRel ? mcFilesRel + "/" : "") + e.name)}')"`}>${esc(e.name)}</span>
      <span class="nui-row-meta" style="width:90px;text-align:right">${e.dir ? "—" : fmtSize(e.size)}</span>
      <span style="width:70px;text-align:right;display:flex;gap:6px;justify-content:flex-end">
        ${e.dir ? "" : `<span class="act msr" onclick="mcFileEdit('${esc((mcFilesRel ? mcFilesRel + "/" : "") + e.name)}')" title="Edit">edit</span>`}
        <span class="act msr" onclick="mcFileDelete('${esc((mcFilesRel ? mcFilesRel + "/" : "") + e.name)}')" title="Delete">delete</span>
      </span>
    </div>`).join("") : '<span class="nui-empty">' + (q ? "No Match" : "Empty Folder") + '</span>';
}
function mcFilesApplyFilter() { mcFilesRender(); }
function mcFileEditClose() { $("#mcFileEdit").style.display = "none"; }
async function mcFileNew() {
  showPromptDialog("New File", "File Name", "", (fname) => {
    if (!fname) return;
    fetch(`/api/mc/files/${mcActive}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: (mcFilesRel ? mcFilesRel + "/" : "") + fname, content: "" }) }).then(() => mcFilesOpen(mcFilesRel));
  });
}
function mcFilesUp() { const parts = mcFilesRel.split("/"); parts.pop(); mcFilesOpen(parts.join("/")); }
async function mcFileEdit(rel) {
  const name = mcActive; if (!name) return;
  const t = await (await fetch(`/api/mc/files/${name}?path=${encodeURIComponent(rel)}`)).text();
  mcFilesRel = rel;
  $("#mcFileEditName").textContent = rel;
  $("#mcFileText").value = t;
  $("#mcFileEdit").style.display = "";
}
async function mcFileSave(btn) {
  const name = mcActive; if (!name) return;
  btn.disabled = true;
  const r = await (await fetch(`/api/mc/files/${name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: mcFilesRel, content: $("#mcFileText").value }) })).json().catch(() => ({ error: "gagal" }));
  btn.disabled = false;
  if (r.error) errorToast(r.error); else toast("Saved " + mcFilesRel);
}
function mcFileDelete(rel) {
  const name = mcActive; if (!name) return;
  showConfirmDialog("Delete File", `Delete "${rel}"? This Cannot Be Undone.`, async () => {
    await fetch(`/api/mc/files/${name}/delete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: rel }) });
    mcFilesOpen(path.dirname(rel) === "." ? "" : path.dirname(rel));
  });
}

// --- Manage (RAM / tasks / players / backups) ---
function mcManageSelectServer(name) { mcSetActive(name); mcTab("manage"); mcManageLoad(); }
async function mcManageLoad() {
  const name = mcActive; if (!name) return;
  const servers = (await (await fetch("/api/mc/status")).json()).servers;
  const s = servers.find(x => x.name === name);
  if (s) { $("#mcRamSlider").value = s.ram_mb ?? 2048; $("#mcRamVal").textContent = ((s.ram_mb ?? 2048) / 1024).toFixed(1) + " GB"; }
  // java runtime per server
  const javas = await (await fetch("/api/mc/javas")).json().catch(() => []);
  const sel = $("#mcServerJava");
  sel.innerHTML = '<option value="">AUTO (RECOMMENDED)</option>' + javas.map(j => `<option value="${esc(j.id)}">JAVA ${j.major} - ${esc(j.vendor.toUpperCase())}</option>`).join("");
  sel.value = s?.java_id ?? "";
  $("#mcServerJavaMeta").textContent = s?.java_id ? "" : "Uses Best Installed Runtime Automatically";
  const t = await (await fetch(`/api/mc/tasks/${name}`)).json();
  $("#mcTaskState").textContent = t ? `${t.action.toUpperCase()} EVERY ${t.intervalMin} MIN` : "";
  mcPlayersRefresh(); mcBackupsRefresh();
}
async function mcJavaSet(javaId) {
  const r = await (await fetch("/api/mc/java-set", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive, javaId }) })).json();
  if (r.error) errorToast(r.error); else toast(javaId ? `Runtime Set To ${javaId}` : "Runtime Set To Auto");
  mcManageLoad();
}
async function mcRamSave(btn) {
  btn.disabled = true;
  const r = await (await fetch("/api/mc/ram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive, ramMb: +$("#mcRamSlider").value }) })).json();
  btn.disabled = false;
  if (r.error) errorToast(r.error); else toast(`RAM Set To ${(r.ramMb / 1024).toFixed(1)} GB — Restart Server To Apply`);
}
async function mcTaskSet(btn) {
  const r = await (await fetch("/api/mc/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive, action: $("#mcTaskAction").value, intervalMin: +$("#mcTaskMin").value }) })).json();
  if (r.error) errorToast(r.error); else { toast("Task Scheduled"); mcManageLoad(); }
}
async function mcTaskClear() {
  await fetch("/api/mc/tasks/clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive }) });
  toast("Task Cleared"); mcManageLoad();
}
async function mcPlayersRefresh() {
  const name = mcActive; if (!name) return;
  const j = await (await fetch(`/api/mc/players/${name}`)).json();
  const all = j.all ?? [];
  $("#mcPlayersCount").textContent = all.length ? `${all.filter(p => p.online).length} ONLINE / ${all.length} KNOWN` : "";
  $("#mcPlayersList").innerHTML = all.length ? all.map(p => `
    <div class="nui-row" style="align-items:center">
      <img src="https://mc-heads.net/avatar/${encodeURIComponent(p.name)}/17" alt="" width="17" height="17" style="image-rendering:pixelated;border-radius:2px;flex-shrink:0" loading="lazy" onerror="this.style.visibility='hidden'">
      <span class="nui-row-name">${esc(p.name)}</span>
      <span class="nui-row-meta">${p.op ? "OP" : p.whitelisted ? "WHITELIST" : "PLAYER"}</span>
      <span class="mc-badge" style="padding:2px 8px"><i class="mc-dot ${p.online ? "on" : "off"}"></i>${p.online ? "ONLINE" : "OFFLINE"}</span>
      ${p.op
        ? `<button class="nui-btn" style="padding:6px 12px;font-size:9px" onclick="mcPlayerOpDirect('deop','${esc(p.name)}')">DE-OP</button>`
        : `<button class="nui-btn" style="padding:6px 12px;font-size:9px" onclick="mcPlayerOpDirect('op','${esc(p.name)}')">OP</button>`}
      ${p.online ? `<button class="nui-btn" style="padding:6px 12px;font-size:9px;border-color:oklch(0.6 0.21 25);color:oklch(0.6 0.21 25)" onclick="mcPlayerKick('${esc(p.name)}')">KICK</button>` : ""}
    </div>`).join("") : '<span class="nui-empty">No Players Known Yet — Add Via Whitelist Above</span>';
}
async function mcPlayerOpDirect(op, player) {
  const r = await (await fetch("/api/mc/players", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive, op, player }) })).json();
  if (r.error) errorToast(r.error); else toast((op === "op" ? "Opped " : "De-opped ") + player);
  mcPlayersRefresh();
}
function mcPlayerKick(player) {
  showPromptDialog("Kick Player — " + player, "Reason (Optional):", "", async (v) => {
    const r = await (await fetch("/api/mc/players/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive, action: "kick", player, reason: v }) })).json();
    if (r.error) errorToast(r.error); else toast("Kicked " + player);
  });
}
async function mcPlayerOp(op) {
  const player = $("#mcPlayerName").value.trim();
  if (!player) { errorToast("Enter Player Name"); return; }
  const r = await (await fetch("/api/mc/players", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive, op, player }) })).json();
  if (r.error) errorToast(r.error); else toast((op.startsWith("whitelist") ? "Whitelist" : "Op") + " Updated");
  $("#mcPlayerName").value = "";
  mcPlayersRefresh();
}
async function mcBackupsRefresh() {
  const name = mcActive; if (!name) return;
  const j = await (await fetch(`/api/mc/backups/${name}`)).json().catch(() => []);
  $("#mcBackupsList").innerHTML = j.length ? j.map(b => `
    <div class="nui-row">
      <span class="msr" style="font-size:18px;color:var(--n-secondary)">backup</span>
      <span class="nui-row-name">${esc(b.file)}</span>
      <span class="nui-row-meta">${(b.size / 1048576).toFixed(1)} MB · ${new Date(b.at).toLocaleString("en-US")}</span>
      <button class="nui-btn accent" style="padding:8px 14px;font-size:10px" onclick="mcRestore('${esc(name)}','${esc(b.file)}')">RESTORE</button>
      <span class="act msr" onclick="mcBackupDelete('${esc(name)}','${esc(b.file)}')" title="Delete">delete</span>
    </div>`).join("") : '<span class="nui-empty">No Backups Yet</span>';
}
async function mcBackupNow(btn) {
  btn.disabled = true; btn.textContent = "ZIPPING…";
  const r = await (await fetch("/api/mc/backup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcActive }) })).json();
  btn.disabled = false; btn.textContent = "BACKUP NOW";
  if (r.error) errorToast(r.error); else toast(`Backup Created — ${(r.size / 1048576).toFixed(1)} MB`);
  mcBackupsRefresh();
}
function mcRestore(name, file) {
  showConfirmDialog("Restore Backup", `Restore "${file}"? Current World Will Be Replaced.`, async () => {
    const r = await (await fetch("/api/mc/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, file }) })).json();
    if (r.error) errorToast(r.error); else toast("Restored From " + file);
  });
}
function mcBackupDelete(name, file) {
  showConfirmDialog("Delete Backup", `Delete "${file}"?`, async () => {
    await fetch("/api/mc/backup/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, file }) });
    mcBackupsRefresh();
  });
}

// --- Phase 3: ngrok TCP tunnel ---
let mcPlayitPoll = null;
let mcNgrokWasRunning = false;
async function mcPlayitRefresh() {
  if (mcPlayitPoll) return;
  const tick = async () => {
    const j = await (await fetch("/api/mc/tunnel/status")).json().catch(() => null);
    if (!j) return;
    const st = $("#mcPlayitState"), btn = $("#mcPlayitBtn");
    st.innerHTML = (j.running ? '<span class="mc-status-dot on"></span>AGENT RUNNING' : '<span class="mc-status-dot off"></span>AGENT STOPPED');
    st.style.color = j.running ? "var(--n-accent,#D71921)" : "var(--n-secondary)";
    btn.textContent = j.running ? "STOP AGENT" : "START AGENT";
    btn.dataset.running = j.running ? "1" : "";
    const addr = $("#mcNgrokAddr");
    if (j.address) { $("#mcNgrokAddrVal").textContent = j.address; addr.style.display = "flex"; }
    else addr.style.display = "none";
    const log = $("#mcPlayitLog");
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.textContent = j.log.join("\n");
    if (atBottom) log.scrollTop = log.scrollHeight;
    mcNgrokWasRunning = j.running;
  };
  await tick();
  mcPlayitPoll = setInterval(tick, 2000);
}
async function mcPlayitToggle(btn) {
  const running = btn.dataset.running === "1";
  if (running) {
    await fetch("/api/mc/tunnel/stop", { method: "POST" });
  } else {
    const token = $("#mcNgrokToken").value.trim();
    const r = await (await fetch("/api/mc/tunnel/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, port: 25565 }) })).json().catch(() => ({ error: "gagal" }));
    if (r.error) { errorToast(r.error); return; }
    $("#mcNgrokToken").value = ""; // jangan tinggal di DOM
  }
  setTimeout(mcPlayitRefresh, 800);
}

// ===== Console OPanel-style: colored log parser + filter + history + shortcuts =====
let mcLogFilter = "all"; // all | info | warn | error
let mcCmdHist = [];      // riwayat command (persist localStorage)
let mcCmdHistIdx = -1;
try { mcCmdHist = JSON.parse(localStorage.getItem("mcCmdHist") ?? "[]"); } catch {}
function mcCmdHistSave() { try { localStorage.setItem("mcCmdHist", JSON.stringify(mcCmdHist.slice(-50))); } catch {} }

// parse satu baris log MC: [HH:mm:ss] [Thread/LEVEL] (Source): message
function mcLogParse(line) {
  const m = line.match(/^\[([\d:]+)\] \[([^/\]]+)\/(\w+)\](?: \(([^)]+)\))?: (.*)$/s);
  if (!m) return { plain: line, level: "other" };
  const [, ts, thread, level, src, msg] = m;
  return { ts, thread, level: level.toUpperCase(), src, msg, plain: line };
}
function mcLogFilterToggle() {
  mcLogFilter = { all: "info", info: "warn", warn: "error", error: "all" }[mcLogFilter];
  const btn = $("#mcFilterBtn");
  btn.textContent = "FILTER: " + mcLogFilter.toUpperCase();
  btn.classList.toggle("active", mcLogFilter !== "all");
  mcConsoleReapplyFilter();
}
function mcConsoleReapplyFilter() {
  // re-filter baris yang sudah dirender (data-lv attribute)
  for (const p of document.querySelectorAll("#mcConsoleLog p")) {
    p.style.display = mcLogFilter === "all" || p.dataset.lv === mcLogFilter.toUpperCase() ? "" : "none";
  }
}
// render satu baris log jadi <p> berwarna (struktur opanel: ts + thread/level + source + msg)
function mcLogLine(line) {
  const d = mcLogParse(line);
  const p = document.createElement("p");
  p.dataset.lv = d.level ?? "OTHER";
  if (mcLogFilter !== "all" && (d.level ?? "OTHER") !== mcLogFilter.toUpperCase()) p.style.display = "none";
  if (d.msg === undefined) { p.textContent = line; return p; }
  const lvCls = { INFO: "lv-info", WARN: "lv-warn", ERROR: "lv-error" }[d.level] ?? "lv-other";
  p.innerHTML = `<span class="ts">[${esc(d.ts)}]</span> <span class="${lvCls}">[${esc(d.thread)}/${esc(d.level)}]</span>` +
    (d.src ? ` <span class="src">(${esc(d.src)})</span>` : "") +
    ` <span class="msg">${esc(d.msg)}</span>`;
  return p;
}
function mcShortcutFill(cmd) { $("#mcCmd").value = "/" + cmd; $("#mcCmd").focus(); }
function mcShortcutSend(cmd) { $("#mcCmd").value = "/" + cmd; mcSendCmd(); }
function mcCmdHistShow() {
  const box = $("#mcCmdHistory");
  box.style.display = box.style.display === "none" ? "block" : "none";
  if (box.style.display === "block") mcCmdHistRender();
}
function mcCmdHistRender() {
  const box = $("#mcCmdHistory");
  box.innerHTML = mcCmdHist.length
    ? [...mcCmdHist].reverse().map(c => `<div class="nui-row" style="cursor:pointer;padding:6px 10px" onclick="mcShortcutFill('${esc(c.replace(/'/g, ""))}')"><span class="nui-row-name" style="font-family:var(--n-f-mono);font-size:11px">${esc(c)}</span></div>`).join("")
    : '<span class="nui-empty">No Command History Yet</span>';
}
function mcCmdHistPrev() {
  if (!mcCmdHist.length) return;
  mcCmdHistIdx = Math.min(mcCmdHistIdx + 1, mcCmdHist.length - 1);
  $("#mcCmd").value = "/" + mcCmdHist[mcCmdHist.length - 1 - mcCmdHistIdx];
}
function mcCmdHistNext() {
  mcCmdHistIdx = Math.max(mcCmdHistIdx - 1, -1);
  $("#mcCmd").value = mcCmdHistIdx < 0 ? "" : "/" + mcCmdHist[mcCmdHist.length - 1 - mcCmdHistIdx];
}

function mcShowConsole(name) {
  mcConsoleFor = name;
  localStorage.setItem("mcConsoleFor", name ?? "");
  mcTab("console");
  $("#mcConsoleName").textContent = name;
  $("#mcConsoleLog").textContent = ""; // reset log antar server
  mcStreamConsole();
}
// SSE console (init-with-replay): buffer dikirim server saat connect, lalu live per baris — tanpa polling
let mcConsoleEs = null;
function mcStreamConsole() {
  mcConsoleEs?.close(); mcConsoleEs = null;
  if (!mcConsoleFor) return;
  const es = new EventSource("/api/mc/console-stream/" + encodeURIComponent(mcConsoleFor));
  mcConsoleEs = es;
  const log = $("#mcConsoleLog");
  let online = false;
  es.onmessage = (ev) => {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    if (d.init) { online = d.online; }
    if (d.line) {
      // auto-scroll pintar (opanel): hanya scroll kalau user di dekat bawah
      const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      log.appendChild(mcLogLine(d.line));
      // cap 500 baris DOM (paralel dengan ring buffer server)
      while (log.children.length > 500) log.removeChild(log.firstChild);
      if (atBottom) log.scrollTop = log.scrollHeight;
      if (/Done \([\d.]+s?\)!/.test(d.line)) online = true;
    }
    $("#mcConsoleState").innerHTML = online ? '<span class="mc-status-dot on"></span>LIVE' : '<span class="mc-status-dot off"></span>STOPPED';
    $("#mcConsoleState").style.color = online ? "var(--n-accent,#D71921)" : "var(--n-secondary)";
    const ts = $("#mcTopState"); if (ts) { ts.textContent = (mcConsoleFor || "") + (online ? " — LIVE" : " — STOPPED"); ts.style.color = online ? "var(--n-accent,#D71921)" : "var(--n-muted)"; }
  };
  es.onerror = () => { es.close(); mcConsoleEs = null; setTimeout(() => { if (mcConsoleFor) mcStreamConsole(); }, 3000); };
}

async function mcSendCmd() {
  const inp = $("#mcCmd");
  let cmd = inp.value.trim();
  if (!cmd || !mcConsoleFor) return;
  if (cmd.startsWith("/")) cmd = cmd.slice(1); // panel kirim tanpa slash
  inp.value = "";
  mcCmdHistIdx = -1;
  if (mcCmdHist[mcCmdHist.length - 1] !== cmd) { mcCmdHist.push(cmd); mcCmdHistSave(); }
  await fetch("/api/mc/cmd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: mcConsoleFor, cmd }) });
}

// --- Properties editor: schema form (default) + raw mode (advanced) ---
let mcPropsMode = "form", mcPropsData = null; // { values, schema, unknown }
// default vanilla MC untuk key yang belum ada di file (server belum pernah jalan)
const MC_PROPS_DEFAULTS = {
  "gamemode": "survival", "difficulty": "easy", "hardcore": "false", "pvp": "true",
  "allow-flight": "false", "allow-nether": "true", "force-gamemode": "false",
  "enable-command-block": "false", "spawn-protection": "16", "max-tick-time": "60000",
  "level-seed": "", "level-type": "minecraft\\:normal", "generate-structures": "true",
  "max-world-size": "29999984", "view-distance": "10", "simulation-distance": "10",
  "max-players": "20", "white-list": "false", "enforce-whitelist": "false",
  "online-mode": "true", "op-permission-level": "4", "player-idle-timeout": "0",
  "server-port": "25565", "query.port": "25565", "rcon.port": "25575",
  "enable-rcon": "false", "enable-query": "false", "enable-status": "true",
  "motd": "A Minecraft Server", "network-compression-threshold": "256",
};
async function mcShowProps(name) {
  mcPropsFor = name;
  localStorage.setItem("mcPropsFor", name ?? "");
  mcTab("props");
  $("#mcPropsName").textContent = name;
  mcPropsData = await (await fetch("/api/mc/props-schema/" + name)).json().catch(() => null);
  if (!mcPropsData || mcPropsData.error) { errorToast(mcPropsData?.error ?? "Gagal Load Properties"); return; }
  mcPropsRender();
}
function mcPropsToggleMode() {
  // form → raw: serialize form state dulu biar tidak kehilangan editan
  if (mcPropsMode === "form") { mcPropsCollect(); mcPropsMode = "raw"; $("#mcPropsText").value = mcPropsSerialize(); }
  else { mcPropsMode = "form"; }
  mcPropsRender();
}
function mcPropsRender() {
  const form = $("#mcPropsForm"), raw = $("#mcPropsText"), btn = $("#mcPropsModeBtn");
  if (mcPropsMode === "raw") {
    form.style.display = "none"; raw.style.display = "block"; btn.textContent = "FORM";
    return;
  }
  raw.style.display = "none"; form.style.display = "flex"; btn.textContent = "RAW";
  const { values, schema, unknown } = mcPropsData;
  const inp = (item, val) => {
    const id = "mcprop_" + item.k.replace(/[^\w-]/g, "_");
    if (item.type === "bool") return `<button class="nui-btn ${val === "true" ? "accent" : ""}" id="${id}" data-k="${esc(item.k)}" data-type="bool" style="padding:6px 14px;font-size:10px;min-width:70px" onclick="mcPropBool(this)">${val === "true" ? "ON" : "OFF"}</button>`;
    if (item.type === "enum") return `<select class="nui-num" id="${id}" data-k="${esc(item.k)}" data-type="enum" style="padding:6px 10px" onchange="mcPropDirty(this)">${item.opts.map(o => `<option value="${esc(o)}"${o === val ? " selected" : ""}>${esc(o.replaceAll("minecraft\\:", "").toUpperCase())}</option>`).join("")}</select>`;
    if (item.type === "int") return `<input class="nui-num" id="${id}" data-k="${esc(item.k)}" data-type="int" data-min="${item.min}" data-max="${item.max}" value="${esc(val)}" style="width:110px;padding:6px 10px" onchange="mcPropDirty(this)">`;
    return `<input class="nui-input" id="${id}" data-k="${esc(item.k)}" data-type="text" value="${esc(val)}" style="flex:1;padding:6px 10px;font-family:var(--n-f-mono);font-size:11px" onchange="mcPropDirty(this)">`;
  };
  let html = "";
  for (const sec of schema) {
    const items = sec.items.filter(i => i.k in values || ["bool", "int"].includes(i.type));
    if (!items.length) continue;
    html += `<div><div class="nui-label" style="margin-bottom:8px;color:var(--n-accent,#D71921)">${esc(sec.section.toUpperCase())}</div>
      <div style="display:flex;flex-direction:column;gap:6px">${items.map(i => `
        <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--n-line)">
          <span style="flex:1;font-family:var(--n-f-mono);font-size:11px;color:var(--n-primary)">${esc(i.k)}</span>
          ${inp(i, values[i.k] ?? MC_PROPS_DEFAULTS[i.k] ?? (i.type === "bool" ? "false" : ""))}
        </div>`).join("")}</div></div>`;
  }
  if (unknown?.length) {
    html += `<div><div class="nui-label" style="margin-bottom:8px;color:var(--n-secondary)">UNKNOWN / ADVANCED</div>
      <div style="display:flex;flex-direction:column;gap:6px">${unknown.map(([k, v]) => `
        <div style="display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid var(--n-line)">
          <span style="flex:1;font-family:var(--n-f-mono);font-size:11px;color:var(--n-secondary)">${esc(k)}</span>
          <input class="nui-input" data-k="${esc(k)}" data-type="unknown" value="${esc(v)}" style="flex:1;padding:6px 10px;font-family:var(--n-f-mono);font-size:11px" onchange="mcPropDirty(this)">
        </div>`).join("")}</div></div>`;
  }
  form.innerHTML = html || '<span class="nui-empty">No Properties Loaded</span>';
}
function mcPropBool(btn) {
  const on = btn.textContent.trim() === "ON";
  btn.textContent = on ? "OFF" : "ON";
  btn.classList.toggle("accent", !on);
  btn.dataset.dirty = "1";
}
function mcPropDirty(el) { el.dataset.dirty = "1"; }
function mcPropsCollect() {
  // baca semua elemen ber-data-k, tulis balik ke mcPropsData.values (hanya yang dirty)
  for (const el of document.querySelectorAll("#mcPropsForm [data-k]")) {
    const k = el.dataset.k, t = el.dataset.type;
    let v;
    if (t === "bool") v = el.textContent.trim() === "ON" ? "true" : "false";
    else v = el.value;
    if (t === "int") {
      const n = parseInt(v, 10);
      if (Number.isFinite(n)) v = String(Math.min(Math.max(n, +el.dataset.min || -2147483648), +el.dataset.max || 2147483647));
    }
    mcPropsData.values[k] = v;
  }
}
function mcPropsSerialize() {
  mcPropsCollect();
  const { values, unknown } = mcPropsData;
  const all = { ...values, ...Object.fromEntries(unknown ?? []) };
  return Object.entries(all).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}
async function mcSaveProps(btn) {
  if (!mcPropsFor) return;
  btn.disabled = true;
  const body = mcPropsMode === "form" ? mcPropsSerialize() : $("#mcPropsText").value;
  const r = await (await fetch("/api/mc/properties/" + mcPropsFor, { method: "POST", headers: { "Content-Type": "text/plain" }, body })).json().catch(() => ({ error: "gagal" }));
  btn.disabled = false;
  if (r.error) errorToast(r.error); else toast("Properties Saved — Restart Server To Apply");
}

