# AGENTS.md — NigiroCore

Self-hosted personal cloud/backup: Node.js backend pulls media from Android via ADB (USB) to a local HDD; Google Photos-style web UI (Nothing UI aesthetics).

## Stack
Vanilla JS, no build step. Node 26 `node:sqlite`. Deps (see `server/package.json`): express, dotenv, sharp, exifr, @napi-rs/canvas, pdfjs-dist — propose before adding.

## Conventions (hard rules)
- UI text English Title Case; dates/numbers `en-US`.
- Custom M3 dialogs only — build a styled dialog where a native `confirm`/`alert`/`prompt` would go.
- Every child_process call sets `windowsHide: true`; background loops spawn once at startup, never per request.
- Backup copies only — user triggers it; source files on the phone are read-only to this app.
- Storage layout: `<drive>:\<folder>\<profile>\<phone path>`.
- Dashboard order: Server → Live → Storage → Vault → Breakdown → Items Per Year → History.

## Gotchas (not discoverable from code alone)
- `volumes` table has no `id` column — select `rowid AS id`.
- `main` volume comes from `STORAGE_PATH` env and lives outside the volumes table.
- CPU metrics come from an `os.cpus()` delta sampler; network from one persistent `type`perf stream. GPU/disk metrics were deliberately dropped — restore via an extra typeperf stream if asked.
- Multiline template-literal edits: use a one-off patch script saved OUTSIDE the repo (e.g. `%TEMP%\opencode\`), build `${` via `String.fromCharCode(36)`; delete repo-root scratch files after use.
- DB config lives in `server\.env` (PORT, STORAGE_PATH, DB_PATH, ADB_PATH). Running `setup.js` again overwrites it.
- `server/_gpustats.ps1` / `_diskcounter.ps1` are legacy leftovers (GPU/disk metrics dropped) — safe to delete.
- Full architecture details: see `ARCHITECTURE.md`. Session history & decisions: see `DEVLOG.md`.

## Layout
- `server/server.js` — all ~70 endpoints; SSE at `/api/events`.
- `server/db.js` — SQLite proxy; widened I/O error detection (disk I/O + not-open + SQLITE_CANTOPEN).
- `web/app.js` (~133 KB) + `web/index.html` — frontend; `cpuPctLast` feeds both the CPU pill and graph (single source).
- `setup.js` — first-run wizard writing `server/.env`.
- `start-nigiro.vbs` — silent launcher (no console window).

## Reference
TrueNAS middleware pattern for background samplers: `C:\NigiroProject\truenas-middleware\src\middlewared\middlewared\plugins\reporting\realtime.py`.
