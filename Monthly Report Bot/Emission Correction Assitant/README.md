# DNV Emissions Validation & Intelligence (NeraVeda Workspace 07)

A read-only validation and investigation workspace for DNV emissions reporting data. It reads the
vessel-submitted Log Abstract (LA) and Bunker Report (BR) CSV files and the system-generated OVDLA workbook.
It then:

- reconciles the LA with the OVDLA;
- recalculates fuel balances in exact decimal arithmetic;
- checks structure, chronology, voyage continuity, cargo, duration and distance;
- relates DNV Emissions Connect errors and warnings to independent findings;
- produces diagnostic reports.

> **It never modifies, corrects, overwrites, deletes, regenerates or writes back any original reporting
> file.** Every result is a separate diagnostic record.

The folder is named "Emission Correction Assitant" as requested. The module itself corrects nothing.

## Opening it

- **From NeraVeda:** choose **Open Emissions Validation** on card 07. The dashboard starts the server
  without a console window and opens `http://localhost:3001` in your browser. Once the server is running,
  the button becomes **Open in browser** and **Stop server** appears. Closing NeraVeda stops the server
  after a confirmation.
- **Directly:** run `npm run build` once, then `npm run start`. For development, use `npm run dev`.
- **Port:** the server listens on `127.0.0.1:3001` only. Set `EMISSIONS_PORT` to use another port.
- **Browser warning:** Sophos web protection may show an "Uncategorized website" warning for `localhost`.
  Choose Continue, or ask IT to allow `localhost`.

## Setup (once)

1. Node.js 18 or later on PATH, then `npm install` in this folder.
2. Copy `.env.example` to `.env.local` and set `EMISSIONS_MONGODB_URI`. The same Atlas cluster as the
   Inspection Reports app works; data goes to the `emissions` database.
   - If the network's DNS does not answer `mongodb+srv` SRV lookups, keep `EMISSIONS_DNS_SERVERS=8.8.8.8`.
     It changes this app's own lookups only.
3. Optional, recommended: create separate least-privilege database users and set
   `EMISSIONS_SOURCE_WRITE_URI` and `EMISSIONS_SOURCE_READ_URI`. See **Storage integrity** in the app.
4. `npm run build`.

For a quick look without a database, start with `EMISSIONS_STORAGE=memory`. This is test mode: nothing is
saved, and the app says so on every page that matters.

## Workflow

1. **Create a validation session:** vessel, IMO (check digit validated) and UTC reporting period.
2. **Sources:** register the LA (.csv), BR (.csv) and OVDLA (.xlsx).
   - Each file is parsed first. Unsafe or malformed files are rejected and never stored.
   - Accepted files are stored byte-for-byte under their SHA-256. A second upload of identical bytes never
     overwrites anything.
   - Validation runs with whatever sources are present, and coverage shows what could not be checked.
3. **Read-only source viewer:** exact original text, original line or row numbers, the role each column
   was mapped to, search, and highlighting from findings.
   - **Exclude…** leaves one record out of operational calculations, with a reason. Use it for the DHT COLT
     2013 template rows, for example.
   - Excluded records stay visible and audited. There is no exclusion by year or date range.
4. **DNV findings — import from OVD Admin screenshots:**
   - In OVD Admin, expand the vessel so its checks are listed. Press **Win+Shift+S** and select the list.
   - On the DNV findings tab, press **Ctrl+V** (or drop or choose PNG/JPEG files). Add several screenshots
     while you scroll; rows that appear twice are recognised.
   - The screenshot is read **on this computer** by a local OCR engine (Tesseract, bundled in
     `node_modules`). It is not sent to the internet or to any AI service, and only its SHA-256 is recorded.
   - The reader rebuilds the table:
     - the vessel, IMO and period;
     - the UnderWay/InPort segments with times and ports;
     - per item: the severity (from the icon colour), the check, the message, the event time and event, and
       the fuel.
   - It compares what it read with OVD Admin's "n issues / n warnings" badge and says when part of the list
     is not in the screenshots yet. It can also set the session's IMO and period from the screenshot.
   - Review the rows (anything misread can be corrected), then **Add**. Entries are unconfirmed unless you
     tick that you compared them with the screenshot.
   - Single items can still be typed by hand. Nothing is sent back to OVD Admin. Corrections are made by the
     vessel or office in the source files, which are then resubmitted.
5. **Run validation.** Every source is hash-verified before and after the run. Each run stores its exact
   inputs, configuration, exclusions, DNV entries and result.
6. **Investigate:**
   - Dashboard, Source reconciliation, Voyage & fuel (with the residual chart).
   - Findings: each with its calculation, source records, qualifications and possible causes.
   - Statuses: New, Under Investigation, Awaiting Vessel Clarification, Reviewed, Closed.
   - Notes and links between findings are append-only.
7. **Diagnostic reports:** XLSX and JSON. Each is marked
   **NERAVEDA DIAGNOSTIC REPORT — NOT AN OFFICIAL VESSEL REPORTING FILE**.
8. **Findings export for the vessel:** on *Findings & investigation*, click **Export**, then choose **PDF** or
   **Excel**. You can export all errors and warnings (the default), everything including information, or
   exactly what the current filter shows. Office investigation notes are only included if you tick that
   option.
   - **PDF:** laid out like the screen. It has a summary, an index (each row links to its finding), and one card
     per finding with the source lines, calculation, possible causes and recommended check. Each card also has
     a fillable **Investigation status** dropdown, preset to the current status, and a **Vessel remarks** box.
     The fields can be filled in Adobe Reader, Edge or Chrome. They are named `status__<finding id>` and
     `remarks__<finding id>`, so the answers can be read back later.
   - **Excel:** one row per finding, with the status as a dropdown and an empty Vessel remarks column.
     Calculations are on their own sheet.
   - Every page and sheet carries the banner, and each export is recorded in the audit history with its SHA-256.

## Evidence classes (never conflated)

| Finding basis | DNV item outcome |
|---|---|
| Official interface requirement · Official validation requirement · Independent calculation · Screening threshold · Investigation hypothesis | **DNV Reported** (always) + one of **Independently Reproduced**, **Not Reproduced**, **Unresolved**; **Possible Cause** hypotheses are listed separately |

"Not Reproduced" means only that the independent calculation, under its stated assumptions, does not show
the discrepancy. DNV's own validation logic is proprietary and is not claimed to be reproduced.

## Structure

```
app/                 Next.js pages and API route handlers (the "Express" layer of the spec)
  api/sources        list + register only (no PUT/PATCH/DELETE), read-only view, original download
  api/sessions       sessions, runs, reports, DNV entries, statuses, notes, audit
components/          React UI (workspace tabs, read-only viewer, residual chart)
lib/engine/          pure validation engine: no React, MongoDB or file system; deterministic
  decimal.ts         exact BigInt decimal arithmetic
  schema.ts          versioned field mapping (ovd-3.13-1, from the supplied Interface Description)
  events.ts          exact OVD event spellings (Arrival, Departure, ArrivalSTS, …)
  rules/             groups A–G, registry with rule versions and evidence classes
  reconcile.ts       LA vs OVDLA
  correlate.ts       DNV correlation
lib/ocr/             OVD Admin screenshot layout reader (pure) and PNG safety checks / icon colours
lib/parsers/         CSV (RFC 4180), safe ZIP/XML/XLSX readers with bomb/XXE/macro protection
lib/server/          insert-only source store (GridFS), diagnostic store, service layer, request guard
lib/export/          diagnostic XLSX/JSON reports (formula-injection safe writer)
tests/               node --test suites (synthetic data only)
reference/           put the DHT COLT reference files here — excluded from git
```

## Daily backups

**When:** the first time the server uses its storage each day, it backs up the `emissions` database in the background (`lib/server/mongo-backup.ts`, called from `lib/server/runtime.ts`). That covers the sessions, runs, findings, statuses, notes, audit and the original source files (GridFS).

**How it reads:** the source files are read with the read-only source role; the rest with the diagnostics role. The backup only reads the database.

**Where:** `%LOCALAPPDATA%\AbhishekAutomationSuite\backups\emissions-daily`, on this PC.

**How it works:**
- Each document is stored once, compressed, under its SHA-256. After the first backup, a day adds only what changed.
- The newest 30 snapshots are kept.
- It is not run in memory mode.

**Restoring:** `npm run backup -- list | verify <snapshot> | restore <snapshot> <new database name>`. A restore goes only into a new, empty database, never the live one, and needs a database user that may create it.

**Original files:** the static test that no code writes files still applies to everything else. The backup engine is the one exception. Its own test checks that it writes only inside its backup folder and only reads the database.

**Copies of the engine:** the engine is an identical copy of `Superintendent inspection Report/lib/server/mongo-backup.ts`. A test there compares the two.

## Tests

```
npm run typecheck
npm test            # 101 tests: decimals, parsers, rules, OVD Admin checks, screenshot reader, findings export, reconciliation,
                    # correlation, server, security, plus the DHT COLT and OVD Admin screenshot regressions
                    # when reference/ and tests/private/ are present
npm run test:mongo  # MongoDB path, in a temporary emissions_it_* database on the configured cluster (dropped after)
```

The desktop integration is tested from the suite (`tests/test_emissions_launcher.py`).

## Status and known limitations

- **Schema verified.** `ovd-3.13-1` uses the exact field names from the supplied OVD 3.13 Interface
  Description, and requirements traceable to it cite the sheet and row.
- **Record order.** Voyage, fuel, cargo, duration and distance rules read records in UTC order within the
  reporting period, as OVD processes them (*timeline*; switchable to *submitted* in Settings). B01 always
  checks the file order. When records are skipped (outside the period or not interpretable), the finding
  names them as a hypothesis.
- **DHT COLT verified.** The case was run with the real files; results and the comparison with DNV are in
  `docs/ARCHITECTURE.md` §8. The spec's 391/30 figures are **not** reproduced by these files (398 rows; 33
  non-template LA-only records), while 361 matched with zero value differences is.
- **No Bunker Report was supplied for DHT COLT.** Fuel balances are qualified, and DNV "Reported ROB vs
  available fuel" items stay Unresolved until it is supplied.
- **Protection is application-only by default.** Atlas has no write-once mode. With a single database user
  the originals are protected by the application (insert-only code, hashes verified before and after every
  run), not by the database. Least-privilege users make it database-enforced, and the Storage integrity
  page shows which mode is in effect.
- **Open it from NeraVeda.** People sign in to NeraVeda with their Microsoft work account or a NeraVeda ID
  and password. The app then
  accepts API requests only with the session NeraVeda opens the browser with, and only for people who have
  this workspace. Opening `http://localhost:3001` directly shows "Open from NeraVeda". Audit records the
  signed-in email. Requests are also guarded: local host only, no cross-site requests, and a CSRF header on
  writes. Not included yet: vessel-level access (everyone with the workspace sees every vessel) and TLS
  between the browser and the local server (loopback only). See `docs/NERAVEDA_ACCESS.md` in
  `Monthly Report Bot`.
- **No AIS data.** No external AI service is used. The PDF export covers the findings for vessel review. The
  full diagnostic report remains XLSX/JSON.
- **Vessel answers are not imported yet.** A filled-in findings PDF is read by people; importing the
  statuses and remarks back is a possible next step (the field names allow it).
- **Screenshot reading.**
  - It is built for the OVD Admin vessel list layout. Another layout gives few or no items, and the
    reader says so.
  - Severity comes from the icon colour. Words read with low confidence are flagged for checking.
  - A screenshot takes about 10–20 s to read.
  - Event times are taken as UTC, as OVD Admin shows them. `GET /api/ocr` reports whether the reader works.
