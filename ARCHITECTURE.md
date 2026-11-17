# NiroCore — Architecture

*Snapshot: 15 Nov 2026*

## Stack
Node 26.13.1, ESM (`"type": "module"`). Vanilla JS frontend, no build step. SQLite via built-in `node:sqlite`.

Dependencies (`server/package.json`): express 4, dotenv, sharp 0.35 (thumbnails), exifr (EXIF/GPS), @napi-rs-canvas, pdfjs-dist (document preview).

## Data Flow
```
Android phone ──USB/ADB──▶ server.js (express :3000)
                              │
                              ├─▶ metadata.db (SQLite)  ◀── db.js proxy
                              └─▶ E:\NigiroCore_Data\<profile>\<phone path>\  (files + YYYY/MM dirs)
                                     └─ thumbnails 250px WebP alongside
web/index.html + web/app.js ◀── REST + SSE (/api/events)
```

## Database Schema (NigiroCore_Data/metadata.db)
Tables: `files`, `sqlite_sequence`, `backup_log`, `settings`, `profiles` (1 row), `volumes`, `albums`, `album_files`, `smart_albums`.

- `volumes`: name (PK), root (UNIQUE), created_at — **no id column**, use `rowid AS id`.
- `main` volume is synthetic (from `STORAGE_PATH` env), never a table row.
- `settings` table holds persisted user prefs (trash retention, thumb quality, poll interval, theme).
- DB auto-backup: daily + rolling 7 days, first backup at startup.

## server.js (~69 KB, ~70 endpoints)
Groups:
- **Sync/backup**: `/api/sync`, `/api/phone/*` (browse/preview/scan), `/api/backup-selected`, `/api/backup-contacts`, `/api/history`
- **Gallery**: `/api/gallery`, `/api/search`, `/api/favorites`, `/api/archive`, `/api/stacks`, `/api/trash` (+restore/purge), `/api/duplicates`, `/api/recap/:year`
- **Albums**: `/api/albums*` (manual, scoped per profile), `/api/smart-albums*` (rule JSON)
- **Files**: `/api/file/:id`, `/media/:id` (+ `/thumb`), `/api/rawfile`, rename, documents
- **Infra**: `/api/volumes*` (health/primary/rename/move), `/api/breakdown`, `/api/verify`, `/api/integrity`, `/api/disk`
- **System**: `/api/live` (sync cached read), `/api/system`, `/api/status`, `/api/events` (SSE)
- **Setup**: `/api/profiles*` (CRUD/reassign/edit), `/api/prefs`, `/api/db-backup*`, `/api/adb-status`

## Live Monitoring (TrueNAS pattern)
- CPU: stdlib `os.cpus()` delta in a background sampler loop — zero subprocess.
- Network: ONE persistent `typeperf` streaming process (`windowsHide: true`), auto-restart 5s after exit.
- `/api/live` reads cached values only — synchronous, ~1–3 ms, never spawns.
- GPU/disk I/O: deliberately dropped (null). Legacy `_gpustats.ps1`/`_diskcounter.ps1` unused.
- Frontend: `cpuPctLast` global is the single source for pill AND graph.

## Frontend
- `web/app.js` (~133 KB) — single-file vanilla JS; SSE client reconnects on `/api/events`.
- `web/vendor/nothing-ui/` — design system (tokens.css, css, fonts: Geist, Doto, Newsreader, Material Symbols).
- Events: volume mutations broadcast via SSE → gallery/stats refresh without polling.

## Storage Layout
`<drive>:\<folder>\<profile>\<phone path>` — mirrors phone tree. Trash: 30-day retention, auto-purge. Safe writes: `.tmp` + rename.

## Config
`server/.env`: PORT=3000, STORAGE_PATH=E:\NigiroCore_Data, DB_PATH=E:\NigiroCore_Data\metadata.db, ADB_PATH=C:\platform-tools\adb.exe.
