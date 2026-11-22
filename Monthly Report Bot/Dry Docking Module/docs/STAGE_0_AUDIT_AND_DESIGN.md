# Digital Docking — Stage 0: Audit, Source Reconciliation and Proposed Design

**Status:** Decisions D1–D10 answered on 21 Nov 2026 — see **section 8**, which overrides sections 1, 5 and 7 where they differ. The Stage 1A plan (section 9) awaits approval.
**Date:** 21 Nov 2026 · **Governing spec:** `NeraVeda_Digital_Docking_Master_Build_Prompt_v2.md` (v2.0)
**Evidence base:** DHT Leopard 2nd Special Survey, CIMC Changhong, 13–29 Oct 2025 (16 daily emails, 16 daily workbooks, 23 supporting files) and 20 post-docking reports (2020–2026, 9 vessels).

All counts below were measured from the files, not estimated. The working copies were extracted to a temporary folder outside the repository; no vessel data was added to Git.

---

## 1. Repository and SIR architecture (what actually exists)

| Area | Finding | Use for Digital Docking |
|---|---|---|
| Desktop suite | Python 3.15, CustomTkinter 6 workspaces (`lube_oil`, `gc_manager`), launched by `launch_app.pyw` from **the installed Python**, not `.venv`. | Natural home for the importer and template generator. Installed Python has openpyxl, Pillow, pywin32, customtkinter; it lacks reportlab, pypdf, defusedxml. |
| Shared database | `suite_services/database.py`: one SQLite file `%LOCALAPPDATA%\AbhishekAutomationSuite\suite.sqlite3`, versioned schema (v2), backup copy before migration, `BEGIN IMMEDIATE` transactions. | Add docking tables as an additive migration (v3), same backup rule. |
| Source archive | `suite_services/storage.py::archive_file`: SHA-256, content-addressed `originals/ab/<sha>.xlsx`, fsync, atomic replace, "file changed during import" check, 30 MB cap. | Reuse unchanged for daily workbooks (largest seen 6.7 MB). |
| Import pattern | Lub Oil: `report_files` → `source_occurrences` → `processing_runs` (parser version, state, error) → versioned `monthly_reports` with `supersedes_report_id`, `audit_events`. | Same pattern fits day submissions and revisions. `audit_events` has a FK to `monthly_reports`, so docking needs its own audit table. |
| Sign-in / rights | NeraVeda ID + module access rights (`suite_services/access`), `actor.py` for who did it. | Register a "Digital Docking" workspace right. |
| Web shell (SIR) | Next.js 16.4.6, React 19, IndexedDB drafts in the browser, optional MongoDB sync, jsPDF export, local server on 127.0.0.1:3000 started by `suite_services/inspection_server.py`. `lib/modules.ts` is built to host more web modules. | Candidate for the review UI later (Stage 1D/5/7). Its browser-only storage is **not** suitable for immutable originals. |
| Vessel master | Names only: 24 vessels in `report_catalog.VESSELS`, mirrored in SIR `lib/vessels.ts` (a test fails if they drift). No IMO, particulars, tanks or equipment anywhere. | Stage 1 needs only vessel identity. Particulars (Stage 2) must be created; there is nothing in SIR to extend. |
| Report output | SIR: jsPDF. Company post-docking report today: a Word `.doc`. | Stage 7 decision; not needed now. |
| Tests | `unittest` in `tests/` (Python), `node --test` in SIR. | Docking tests go in `tests/test_docking_*.py`, synthetic fixtures only. |
| Prior work | No Codex output, branch, stash or draft exists. No pilot workbook, data dictionary or candidate workbook was found. | Starting from the evidence. |

## 2. Sources inspected, and references that are not available

**Inspected**

| Source | What it is | Key facts |
|---|---|---|
| 16 daily emails (Day 0 – Final) | The Superintendent's daily report to the owner's technical manager, cc fleet group, ops and vessel. | Each is a **rewritten consolidation**, not a copy of the workbook (see 3.3). |
| 16 daily workbooks (Day 1–16) | "Dry Dock Work Done" photo log, attached to each email. | One base file created 17 Feb 2024, re-saved every day. Last saved by: Master's PC 7, Superintendent 7, ECR PC 2. |
| 23 supporting files | Jotun Sitemaster coating daily logs, yard daily planning sheet, port weather forecasts, weather memo, separate email on bottom-plate buckling, Jotun hull photo report. | Third-party evidence. Store and link, do not parse in V1. |
| 20 post-docking reports | 14 Word, 6 PDF, 2020–2026, 26–157 pages. | One stable company form across all years (see 3.4). |

**Not available (master prompt assumes them)**

| Reference | Effect |
|---|---|
| Approved V1 Data Dictionary | The schema in section 4 is proposed from evidence; it becomes the dictionary once approved. |
| Candidate final workbook / NeraVeda pilot / older ten-sheet template | Nothing to reconcile against; the conflict matrix compares the master prompt with **actual practice**. |
| Docking specification / job register with job numbers | Neither the workbooks nor the emails carry job numbers. Job-linked design depends on decision D5. |
| Hull Inspection Annex, SMS forms, yard performance form, account codes, acceptance limits | Later stages only (3–8). Not needed for Stage 1. |
| Vessel email attachment limit; Excel version on board (File > Account) | Needed for Stage 1A. Requested in section 7. |

## 3. What the evidence shows

### 3.1 The current daily workbook

- **Layout:** one sheet per department × performer: `DECK - SHIP STAFF`, `DECK - YARD STAFF`, `DECK - SERVICE ENGINEER`, `ENGINE - SHIP STAFF`, `ENGINE - YARD STAFF`, `ENGINE - SERVICE VENDORS`. Each job is a block: serial number, one sentence in merged cells C:M, then up to three photos per row in columns C, G and K, 10–22 rows tall.
- **The sheet set drifts:** 4 sheets on Day 1; service sheets added Day 2; staging sheets added Day 6 and dropped after Day 13; Day 16 has a single `Engine` sheet. Names change (`Stagging Records - Deck` → `Stagging - Deck`, trailing spaces); sheet order changed on Day 11.
- **No structure:** no job number or spec reference, no findings, status, vendor, witnessing or next-action fields, no data validation, no protection, no formulas, no hidden identity.
- **Staging sheets** are the only tabular records: Location, Qty, L × B × H (m), Purpose, Rigged on, Removed on, Photo. They are cumulative, copied forward whole each day (28–52 identical photos reappear on Days 7, 8, 9, 11 and 12).
- **Volume per day:** 27–274 photos, 17–62 described job blocks, 0.6–6.7 MB per file. Busiest department-day: Deck, 37 job blocks.

### 3.2 Photographs

| Measure | Result |
|---|---|
| Embedded images, all days | 2,873 (2,644 distinct) |
| Insertion method | 100% floating pictures. No "Place in Cell" was used. |
| Anchoring | Deck sheets: two-cell anchor, "move but don't size". Engine sheets: one-cell anchor. Day 11 (saved on the ECR PC): one-cell everywhere. |
| Resolution | 98% have a long edge under 500 px (2,305 between 300 and 399 px). **No EXIF.** These are compressed thumbnails; originals and capture times are not in the workbook. |
| Photos per job | 242 of 681 job blocks (36%) have more than 3 photos; one job has 21. |
| Association risk | Day 15: Deck-Yard sheet has 22 numbered photo blocks but text on only the first; Service Engineer sheet has 5 numbered blocks and no text at all. **81 photos (67 + 14) sit in blocks with no description.** Position-only matching would attach them to the wrong job or to none. |
| Re-save effect | Staging photos carried forward on Days 10 and 13 came back with different hashes, so re-saving appears to re-compress images. The same photo can look "new" the next day. |

### 3.3 The daily email is the real report, and it is re-typed every day

The email has a fixed structure: headline issues (e.g. gale suspends work at height, ferry stopped); a header block (date / day, berth, arrival, dock entry, dock departure, ETD, time lost to weather, weather); timed events (SOF-style, local time); then **Deck → Ship staff / Yard staff**, **Engine → Ship staff / Yard staff**, **Class Surveyor attendance**, **Service engineers (with company names)**.

Compared with the same day's workbook, the Superintendent:

- **merges** related rows (Day 8: 17 Deck ship-staff rows became 15 email items);
- **adds jobs with no workbook row** (Day 8: anchor-chain studs, ballast blank flange; Day 15: 14 Deck-yard jobs where the workbook has text for 1);
- **adds findings** ("condition found to be good", "previous Eco Shield coating fully intact") and **vendor names** (HD Marine, Cosco, Alphatron, Cathelco, Kemel, Aries Marine, HKT…) that the workbook never records;
- writes 2,000–8,000 characters of new text per day. The quoted chain reaches 133,000 characters by the final day.

Neither the workbook nor the email is a complete record on its own. **Automatically drafting this email from reviewed records is the clearest measurable time saving** (decision D9).

### 3.4 The post-docking report (what the system must eventually feed)

All 20 reports use the same company form: **1 Docking Report · 2 Financial Statement · 3 Invoice – Yard · 4 Record of Inspections · 5 Photographs.** The Docking Report sections are stable:

General information · attending personnel · vessel's command · **Statement of Facts** · bunkers ROB (off-hire / on-hire) · drafts (4 milestones) · **tank soundings** (arrival, before dock, before flooding, before sailing) · consumption / supplies (shore power kWh, cooling water, ballast, fresh water, fire-main hours) · outboard paint (areas, blasting %) · cathodic protection · anchors · chain cables · chain lockers · rudder (clearances) · tail-end shaft & stern tube · seals & liners (wear-down, initial / final) · propeller · sea chests & valves · bridge equipment · **various works by area** (deck machinery, cargo system, ballast, pumproom, LSA/FFA, bridge, ER by ship staff / shipyard / service engineer) · yard performance · recommendations for next docking.

Four 2025–26 reports (Jaguar 2025, Lion, Panther, Puma 2026) do not use the exact headings "Statement of Facts" and "Tank Soundings", so the form has changed slightly. To be confirmed in Stage 7.

**The "Various works" narrative is written from the daily records**, grouped by **area/system**, not by day or job number. That is why section 4 proposes an Area/System field.

**SOF disagrees with the daily emails.** Report: *Arriving yard 13/10 1906*, *Gate closed 17/10 2346*. Emails: *arrived 2100 LT 13 Oct*, *Lock gate closed 0006 LT 18 Oct*. One of each pair is wrong, and nothing today records which source was used. Capturing timed events once, with their source, fixes this (Stage 1 stores them; Stage 3 builds the SOF).

## 4. Conflict matrix (master prompt vs evidence)

| # | Master prompt says | Evidence shows | Proposed resolution |
|---|---|---|---|
| C1 | Superintendent never edits the vessel submission (§3). | 7 of 16 workbooks were last saved by the Superintendent before forwarding. | Import **the file as received from the vessel**. Superintendent additions become annotations or extra records in NeraVeda (D8). |
| C2 | Tabs `Deck Work` / `Engine Work` with a performer field (§4.4). | Six sheets split by department × performer. | Two work sheets with a **Performed by** column. Fewer sheets, and still yields the email's Ship / Yard / Service grouping (D3). |
| C3 | Up to 4 photo slots per row (§2, §4.4). | Today 3 per row; 36% of jobs have more than 3 photos. | 4 slots per activity row, plus **continuation rows** referencing the same row for more photos. |
| C4 | Preserve photo originals (§2). | Workbook images are about 350 px thumbnails with no EXIF. At 1,600 px a day's 250 photos would be roughly 40–60 MB, which no vessel email can carry. | V1 keeps the **image as received** (hashed) as the evidence of record; originals stay on board. Target resolution is set by the email limit (D6). |
| C5 | Tabs for Day Summary, Readings & Tests, Utilities, Job Register, Lists, `_ID`. | None exist. Day-summary facts are typed into the email; readings appear only in the final report. | Keep Day Summary (replaces the email header and events). Light Readings & Tests log. Utilities as optional Day Summary fields. Job Register only if D5 = yes. |
| C6 | Preloaded job register; Job No. retrieves the title. | No job numbers anywhere; "DD Specs" only mentioned. | Job No. **optional** in V1. **Area/System** dropdown is the reporting backbone (D4, D5). |
| C7 | Define Day 1 at docking setup. | The emails use **Day 0 = arrival day at yard**; day number = calendar day after that; the last day is labelled "Final". | Day 0 = arrival date (local) set at docking setup; Day N = date − Day 0; Final = departure day flag (D7). |
| C8 | Readings mapped to equipment and limits. | Readings (rudder clearances, stern-tube wear-down, chain diameter) exist only in the final report. | V1 logs readings as entered values with units and source; **no limits, no pass/fail** (Stage 4). |
| C9 | Staging recorded daily. | Staging register copied forward whole; repeated photos inflate files. | Staging entered as **events on the day** (Rigged / Removed / Modified); NeraVeda builds the running register. No copying forward. |
| C10 | Fleet Manager approves the final report. | Daily report goes to the owner's technical manager; Fleet Manager role not seen in daily flow. | No change for Stage 1. Confirm before Stage 7. |
| C11 | Worksheet protection proposed. | No protection today; staff insert pictures freely. | Protect identity / prefilled cells only; leave entry and photo cells unlocked, and allow "Edit objects". Must be proven in 1A. |

## 5. Proposed vessel daily workbook (V1)

**Principle:** one **fresh copy** of the issued template per day; entered progressively during the day; saved and reopened freely; no macros; `.xlsx` only.
Key: **P** = prefilled and locked · **S** = ship-entered · **C** = calculated and locked · **(opt)** = optional

**Sheets:** `Instructions` · `Day Summary` · `Deck Work` · `Engine Work` · `Staging` · `Readings & Tests` · `Job Register` (only if D5) · `Lists` (hidden) · `_ID` (very hidden)

### 5.1 Day Summary

| Field | Key | Notes |
|---|---|---|
| Vessel, Docking ID, Yard, Arrival at yard (date / time LT), Template version | P | From docking setup |
| Report date | S | Required |
| Day number | C | Report date − Day 0 date |
| Berth / dock | S | Dropdown from docking setup, plus "Other" |
| Weather | S | Short text |
| Time lost today, hours, and reason (opt) | S | Feeds "loss of time due to weather" |
| Key events / headlines (opt) | S | Free text (gale, ferry suspended, buckling found…) |
| **Timed events** (about 30 rows): Date, Local time, Event, Remarks | S | Event dropdown taken from the events in the emails and SOF (arrival, POB, tug fast, all fast, bow / aft in dock gate, gate closed, on blocks, flooding commenced, afloat, gate opened, out of dock, gangway on / off, unmooring…) plus "Other" |
| **Class attendance** (about 10 rows): Society, items attended / witnessed | S | Replaces the email's Class section |
| Utilities (opt): shore-power meter (kWh), ballast taken (t), FW taken (t), fire main pressurised (Y/N) | S | Feeds the final report's consumption table |
| Deck check: officer, "all deck work today is recorded" Y/N, time | S | End-of-day only |
| Engine check: officer, same declaration, time | S | End-of-day only |
| Master confirmation: name, time | S | End-of-day only |

### 5.2 Deck Work and Engine Work (identical columns; one activity per row)

| Col | Field | Key | Rule |
|---|---|---|---|
| A | Row ref (`DK001…` / `EN001…`) | P | Identifies a row in **this** submission only |
| B | Job No. | S (opt) | Dropdown from register, or `EXTRA`, or blank |
| C | Job title | C | Looked up from register |
| D | Extra ref (e.g. `X-D-03`) | S | Required when B = `EXTRA`; reused on later days |
| E | New job title | S | Required when B = `EXTRA` |
| F | Area / System | S | Dropdown (D4). Required when B is blank or `EXTRA` |
| G | Performed by | S | Ship staff / Yard / Service engineer / Ship + Yard |
| H | Company / vendor | S (opt) | Dropdown from docking setup, plus free text |
| I | Equipment / location | S (opt) | e.g. "No.1 & 2 COP discharge valves OP208/209, pumproom" |
| J | **Work carried out today** | S | **Required.** Full technical detail, wrapped |
| K | Findings / as-found condition | S (opt) | "Seat ring found damaged", "coating intact" |
| L | Status | S | In progress / Completed / Stopped – awaiting / Deferred |
| M | Next action / outstanding | S (opt) | |
| N | Witnessed | S (opt) | Not applicable / Class / Owner's Supt / Ship's staff / **Not witnessed**. Blank ≠ Not witnessed |
| O | Reading / test ref | S (opt) | Links to a `Readings & Tests` row |
| P–S | Photo 1–4 | S | One picture per slot cell |
| T | Photo notes | S (opt) | e.g. "1–2 before, 3–4 after" |
| U | Continues row | S (opt) | For more photos: the row ref this row continues; J may say "contd." |

**Capacity:** 150 pre-numbered rows per sheet, about 4× the busiest day observed. Data typed below row 150 is an **import error naming the cell**, never silently dropped. The overflow method is a 1C test item.

### 5.3 Staging (events, not a copied register)

Row ref (P) · Department · Action (Rigged / Removed / Modified) · Location · Qty · L, B, H (m) · Purpose · Related row ref or Job No. (opt) · Photo 1–2

### 5.4 Readings & Tests (V1: record only, never evaluated)

Row ref (P) · Related row ref / Job No. · Equipment / item · Parameter / position · Value · Unit · Measured by · Witnessed (as in 5.2) · Document / report ref
Every reading imports as **Not evaluated** until Stage 4 supplies approved limits.

### 5.5 `_ID` (very hidden)

Docking ID · template version · schema version · register revision · generated at. This is metadata, **not** an authenticity check.

**What ship staff no longer type:** vessel and docking identity, arrival and dock dates, job titles (if a register exists), the staging register, and yesterday's staging photos.
**What the Superintendent no longer types:** the email header, events, Class and service sections, and the job lists (drafted by NeraVeda for editing, D9).

## 6. Test plan and minimal Stage 1 model

### 6.1 Tests for Stage 1A/1C (need the vessel's Excel; cannot be done from the office alone)

| Test | How | Pass when |
|---|---|---|
| Progressive entry | Officer fills 5 rows, saves, closes; reopens 3 times during the day and adds rows and photos | No lost text, photos or validation |
| Oldest Excel on board | Repeat on the ECR PC (older build than the Master's PC) and on the Superintendent's laptop | Opens, edits and saves; no repair prompt |
| Photo methods | Place over cells (anchored in slot), Place in Cell (if available), 4 on one row, non-adjacent rows, overlapping two slots, pasted not inserted, picture dragged after protection | Each picture linked to the right row and slot, **or** rejected with "Deck Work row 23, picture not inside a slot" |
| Protection | Protected sheet with entry and photo cells unlocked, "Edit objects" allowed | Staff can insert, resize and delete photos; cannot change prefilled cells |
| Busy-day size | 60 rows and 250 photos at the chosen resolution; Excel "compress pictures" on and off | File size within the vessel email limit; save time acceptable on the ECR PC |
| Editing arrangement | The method chosen in D2, run for one full day | No overwritten work between Deck and Engine |
| Re-import of real days | Leopard Days 8, 11 and 15 re-keyed into the new template from the original workbook and email | Every activity and photo accounted for; Day 15 gaps raised as errors, not hidden |

### 6.2 Minimal Stage 1 database (additive migration v3 in the suite database)

| Table | Purpose |
|---|---|
| `dd_dockings` | Vessel (FK `vessels`), yard, type, timezone / UTC offset, Day 0 date, status |
| `dd_register_revisions`, `dd_jobs` | Versioned job register; immutable job IDs; retired-in revision |
| `dd_extras` | Provisional extra ref, first-seen activity, promoted-to job, who and when. No merging by title |
| `dd_templates` | Issued template version, schema version, register revision, file hash |
| `dd_days` | Docking + day number + report date + state (Expected / Received / Reviewed / No report + reason) |
| `dd_submissions` | Day, archived file (`report_files`), versions read, importer, outcome, **supersedes**, correction reason, validation results |
| `dd_import_attempts` | Every attempt including rejected ones; kept even when the data import rolls back |
| `dd_activities` | Submission, sheet, row, row ref, job / extra, all section 5.2 fields, raw cell values |
| `dd_photos` | Submission, activity (nullable), sheet, row, slot, method, package part, SHA-256, stored path, pixel size, **linked / rejected + reason** |
| `dd_events`, `dd_class_attendance`, `dd_staging_events`, `dd_readings` | Typed records with sheet and row provenance |
| `dd_audit` | Append-only: entity, action, actor, time, before, after |

Raw submitted values and Superintendent annotations are stored separately; an annotation never overwrites a source value. Photo files are written to a temporary folder and moved into place only after the database commit; a startup check removes orphans.

### 6.3 Photo proof of concept (Stage 1A — first build step after approval)

1. Generate a 3-row test workbook (4 slots per row) in two variants: unprotected and protected.
2. The Superintendent and vessel make test files covering the photo cases in 6.1 on the real PCs.
3. The parser reads the workbook package directly (drawing anchors, and the rich-value parts if Place in Cell is used), with hardened XML parsing and size, entry and pixel limits.
4. Output: one line per picture (sheet, row, slot, method, size, linked / rejected + reason), plus file size and save time.
5. **Gate:** 100% of pictures correctly linked or safely rejected on every test file. Then **one** supported insertion method is approved for the vessel instructions.

## 7. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| **D1** | Where the module lives | **Python inside the NeraVeda desktop suite** (suite SQLite + existing source archive + openpyxl). No new framework. Choose the review UI (desktop window or a web-shell module) at Stage 1D, once the data exists. |
| **D2** | Editing on board: one daily file passed between the Master's PC and the ECR PC, **or** two files per day (Deck + Engine) attached to the same email | Tell me how the file moves today. If it is passed between PCs, **two department files** remove the overwrite risk without coauthoring; the importer pairs them by docking and day. |
| **D3** | Two work sheets with a *Performed by* column, or keep six department × performer sheets | **Two sheets** (5.2). |
| **D4** | Area/System list as the reporting backbone | **Yes.** I will draft it from the final report's section headings for your edit. |
| **D5** | Job register: is there a DD specification with job numbers (Excel / PDF)? | If yes, send the Leopard 2025 spec and I will design the import. If no, V1 runs with optional Job No. and `EXTRA` only. |
| **D6** | Photo resolution and email limit | Tell me the vessel's attachment limit. I will then propose a long-edge target (likely 1,024–1,280 px) and measure it in 1A. |
| **D7** | Day numbering | **Day 0 = arrival date at yard (local)**, as in your emails. |
| **D8** | Source of record | **The workbook as emailed by the vessel.** The Superintendent no longer edits it; changes are made as annotations in NeraVeda. |
| **D9** | Draft the daily owner email from reviewed records (Stage 1D) | **Yes.** It is the largest measurable saving. Drafted for you to edit and send yourself; NeraVeda never sends it. |
| **D10** | Repository hygiene | Add `Docking Reports Depository/` and `Daily Docking Report/` to `.gitignore` now (`.doc`/`.docx` are not ignored today). Confirm whether you want a branch per stage (the master prompt asks for one) or commits directly to `main` (your current practice). |

**Information I also need (not decisions):** the Excel version on the Master's and ECR PCs (File > Account > About Excel); a few baseline timings (vessel minutes per day on the workbook; your minutes per day on the email), so that savings can be measured rather than claimed.

## 8. Decisions recorded (21 Nov 2026) and resulting design changes

| # | Answer | What changes |
|---|---|---|
| D1 | Asked why not MERN | **Changed: build in the existing NeraVeda web shell** (Next.js + React on Node, the same stack as SIR and Emissions), as Workspace 08. See 8.1. |
| D2 | Today Deck and Engine each prepare a file, which are then combined into one master sheet on board | **Two department workbooks per day** (Deck, Engine), sent together. Nobody combines them on board; NeraVeda pairs them into one reporting day. See 8.2. |
| D3 | Agreed | One work sheet per file with a *Performed by* column. |
| D4 | To be reviewed | I draft the Area/System list for your edit. |
| D5 | No register; the current format binds nothing, so NeraVeda builds it | **Job identity is created in NeraVeda, not on board.** See 8.3. |
| D6 | 8 MB per email in total; larger files can go via Teams | Both files together ≤ 8 MB by email. Teams is allowed for higher photo quality, and the importer treats both channels the same. See 8.4. |
| D7 | Agreed | Day 0 = arrival date at yard (local). |
| D8 | Import the vessel report into the module, add comments, export a PDF, send to owners | **The daily output is a PDF Daily Report** made from the vessel's records plus Superintendent comments. The vessel's files are kept unchanged. |
| D9 | Agreed; NeraVeda must follow the report format; only the Technical Superintendent sends | The format is drafted in 8.5 for confirmation. NeraVeda produces the PDF; it never sends anything. |
| D10 | Straight to `main` | Done: both real-data folders added to `.gitignore`. Commits go straight to `main`. |
| — | Vessels use `.xlsx` | Confirmed: import accepts `.xlsx` only. |

### 8.1 Why the web shell now (D1)

My first recommendation assumed the module was mainly an importer. D8 makes **reviewing, annotating and producing a photo-rich PDF every day** the core of the job. That is a browser interface, and SIR already does it (photo handling, editor, jsPDF export, sign-in tickets, theme).

- **Not a separate MERN app.** The web shell is already React + Node + MongoDB; Next.js API routes take Express's place. A second app would mean a second server, sign-in and look. The module plugs into `lib/modules.ts`, the same way SIR does.
- **Data stays local first:** records in SQLite through Node 24's built-in `node:sqlite` (no native install; release-candidate status in Node 24, to be re-checked in 1B), and originals and photos in a content-addressed folder outside the repository, with backups. The Superintendent can work at the yard without a reliable internet connection.
- **The scaling path is MongoDB Atlas** (already used by SIR and the access list). Sync is added when a second person (e.g. the Fleet Manager in Stage 7) needs remote access, not before.
- **Not in the browser's IndexedDB**, which is SIR's draft store and is lost if the port or browser profile changes; it is not acceptable for originals.
- **Python's role** is only what it does for SIR now: the NeraVeda launcher starts the local server and opens the workspace.
- **New libraries (need your approval):** `exceljs` (generates the vessel template with dropdowns, protection and pictures), `yauzl` (reads the workbook zip with size and entry limits), `fast-xml-parser` (reads drawing and rich-value XML with entity expansion off). There is no new framework.

### 8.2 Two department files per day (D2)

- **Deck file:** Day Summary (berth, weather, time lost, key events, timed events, Master's confirmation) · Deck Work · Deck Staging · Deck Readings & Tests · Class attendance (deck) · Deck check.
- **Engine file:** Engine Work · Engine Staging · Engine Readings & Tests · Class attendance (engine) · Engine check.
- Both files carry the same docking ID, day and template version in `_ID`. The importer pairs them. A day with only one file is shown as **"Engine file not received"**, never as complete.
- Each file can be revised and re-sent on its own; a revision replaces only that department's submission for the day.

### 8.3 Jobs without a register (D5)

- The vessel sheets have **no Job No., job title or `EXTRA` columns** (section 5.2 columns B–E are removed). Ship staff describe the work; Area/System and Equipment/location carry the context.
- **During daily review the Superintendent links each activity to a job**, creating the job on first sight. Later days' rows can be linked to it in one click.
- NeraVeda **suggests** likely matches (same Area/System, similar equipment wording, earlier days). It never links automatically, and title similarity alone is never enough.
- Job numbers are NeraVeda's own (e.g. `LEO-25-D-014`) and permanent. Sending a job list back to the vessel in a reissued template is optional, from Stage 2.

### 8.4 Photo size within 8 MB (D6)

- Today a whole day fits in 0.6–6.7 MB because each photo is a thumbnail of about 20–30 KB. **With two files sharing 8 MB, emailed photos cannot be much better than today.**
- Resolution is set by the **slot's displayed size × Excel's picture compression**, not by the camera. 1A measures which slot size and compression keep a busy department-day (about 150 photos) under 4 MB.
- **Teams route:** when the vessel wants better photos, it saves the same workbook with less compression and shares it via Teams. The Superintendent imports it like any other file. The import size cap is configurable (proposed 50 MB). If an emailed and a Teams copy of the same day both arrive, the later one is a revision.

### 8.5 Daily Report format (D9) — drafted from the 16 Leopard emails, for confirmation

1. **Opening note:** headline issues (weather stoppages, ferry, findings needing attention). Superintendent writes it.
2. **Header:** Date / Day N · Berth · Vessel arrival shipyard · Dry-dock entry · Dry-dock departure · ETD · Loss of time due to bad weather · Weather. Taken from the docking setup and the Deck file's Day Summary.
3. **Timed events:** date, local time, event. From both files' timed events.
4. **DECK:** Jobs carried out by Ship's staff · Jobs carried out by Yard staff.
5. **ENGINE:** Jobs carried out by Ship staff · Jobs carried out by Yard staff.
6. **Class Surveyor attendance.**
7. **Jobs done by Service Engineers:** "Company – work", both departments.
8. **Photographs, grouped by item:** new, so owners no longer need the workbook.
9. **Signature:** Technical Superintendent.

Each item starts as the vessel's text. The Superintendent can merge items, edit wording and add items. Edits are stored as annotations, and the vessel's original wording stays visible beside them. The PDF shows the final wording.

**Confirmed 21 Nov 2026:** (a) **all photos** go into the PDF, with the option to remove poor ones or add others; (b) the owner email limit is **10 MB**, which sets the PDF photo quality (about 200 photos a day → roughly 50 KB each, about 600–800 px); (c) the vessel workbooks are **not** attached for owners: the PDF carries the photos. Still useful: the Excel version on both vessel PCs (File > Account > About Excel).

## 9. Stage 1A plan — photo proof of concept (approved 21 Nov 2026; built, see section 10)

**Goal:** prove which picture-insertion method the vessel can use so that every photo links to the right row and slot, or is rejected with its exact location, inside the 8 MB limit. No database, no UI, no production template yet.

| Item | Detail |
|---|---|
| Where | Web shell: `lib/docking/photos/` (parser), `scripts/docking-photo-poc.ts` (generator + report), tests in `tests/docking-photos.test.ts` |
| Libraries | `exceljs`, `yauzl`, `fast-xml-parser` (8.1), added with pnpm |
| Test workbook | 3 activity rows × 4 photo slots, in two versions: unprotected, and protected with entry and photo cells unlocked and "Edit objects" allowed. Saved outside the repository |
| Parser | Reads `xl/drawings/*.xml` anchors (one-cell, two-cell, absolute) and, if present, the Place-in-Cell rich-value parts. Maps each picture to sheet, row and slot; rejects pictures outside a slot, across two slots or across two rows, with the reason and location. Limits: file size, total unzipped size, entry count, image pixels; XML entity expansion off |
| Your test files | Made on the real PCs: Place over Cells, Place in Cell (if offered), 4 on one row, non-adjacent rows, one picture overlapping two slots, pasted picture, picture moved after protection, 150 photos at 2–3 compression settings, opened and re-saved on the ECR PC |
| Output | One line per picture (sheet, row, slot, method, pixels, KB, linked or rejected + reason), plus file size per setting |
| Automated tests | Synthetic workbooks built in code for every anchor type, every reject case, an oversized file, too many entries, and an entity-expansion attempt |
| Gate | 100% of pictures on every test file linked correctly or rejected with location; one insertion method and one compression setting approved; then **STOP** |


## 10. Stage 1A — built so far and what the vessel test must show

**Built** (web shell, `Superintendent inspection Report/`):

| Part | File |
|---|---|
| Safe package reader: size, part-count and unzipped-size limits; unsafe names; encrypted, `.xls` and macro files refused | `lib/docking/photos/package.ts` |
| XML reader: refuses any DOCTYPE or entity declaration | `lib/docking/photos/xml.ts` |
| Picture analyser: floating pictures (two-cell, one-cell, absolute anchors) and Place-in-Cell pictures → row + slot, or rejected with location and reason | `lib/docking/photos/analyze.ts` |
| Photo size from file headers (JPEG, PNG, GIF, BMP, WebP), 50-megapixel limit | `lib/docking/photos/image-size.ts` |
| Test workbook (3 rows × 4 slots; unprotected and protected; very hidden `_ID`; test list T1–T9 on its first sheet) | `lib/docking/photos/template.ts`, `layout.ts` |
| Command: `pnpm docking:photos make` / `check <file or folder>` | `scripts/docking-photo-poc.ts` |
| 9 automated tests (synthetic files only) | `tests/docking-photos.test.ts` |

The test workbooks are in `Dry Docking Module/Photo Test/` (ignored by Git).

**Rules the analyser applies:** a picture is linked only if it lies inside one slot cell (6 px tolerance) on an activity row of the work sheet. Pictures in the text column, header rows or other sheets are rejected, as are pictures crossing two slots or rows, two pictures in one slot (both rejected), linked-not-embedded, grouped or hidden pictures, web pictures (IMAGE function), missing picture data and pictures over 50 megapixels.

**Evidence on this office PC** (Excel 16.0 build 20527, through automation, synthetic 1600 × 1200 photos):

- Floating pictures: 4 of 4 correct pictures linked to DK001 Photo 1–4. The picture in column B and the one across E8 | F8 were rejected with the right reason. Results were identical for the protected and unprotected files.
- Protected file: pictures could be inserted; changing the DK001 cell was refused.
- Place in Cell could not be driven by automation on this PC. It must be tested by hand (T2).
- **Size:** at Excel's default compression a photo was stored at about 535 px and 200–230 KB. 150 such photos make about 32 MB, eight times the 4 MB per file that the 8 MB email allows. These synthetic photos are deliberately detailed, so real photos will be smaller, but compression matters: **T9 on board decides the setting.** Today's vessel files work out at about 25 KB per photo (about 350 px).
- **Lesson:** Excel's AutoSave changed the source files when they were opened from this OneDrive folder, even read-only. Vessel files must be archived on arrival, before anyone opens them, which the Stage 1D importer does.

**What the vessel test must give back:** filled copies of both workbooks after T1–T9 (they will hold real photos, so they stay out of Git), the Excel version of each PC, and any notes in the "Your note" column. Then `pnpm docking:photos check` reports every picture. **Gate:** 100% of pictures linked correctly or rejected with location; one insertion method and one compression setting approved → STOP before Stage 1B.

## 11. Stage 1B — minimal foundation (built 21 Nov 2026)

Started before the 1A vessel test at the user's request (the workbook is being reworked separately). Nothing in 1B depends on the photo method: each photo records how it was inserted.

**Where the data lives:** `%LOCALAPPDATA%\AbhishekAutomationSuite\docking\`, next to the suite's existing data and outside the repository. Override it with `DOCKING_DATA_DIR`. Backups go to `DOCKING_BACKUP_DIR` (default `…\docking\backups`, **which is on the same disk, so set it to another drive or a synced folder**).

| File | What it does |
|---|---|
| `lib/docking/server/db.ts` | SQLite store (Node's built-in `node:sqlite`, WAL, full sync), versioned migrations, backup before any upgrade, newer-schema refusal |
| `lib/docking/server/files.ts` | Original workbooks and photos stored by SHA-256: staging → flush → rename; hash checked on every reuse and read; orphan sweep |
| `lib/docking/server/backup.ts` | Online database snapshot + manifest (counts, every file with its hash) + shared incremental file store; restore only into an empty folder, checking hashes and counts; keeps the newest 30 |
| `lib/docking/server/repo.ts` | Dockings, days, imports, jobs, links, notes, audit (below) |
| `tests/docking-store.test.ts` | 13 tests, temporary folders, synthetic data |

**Rules held by the database itself** (triggers and constraints, not only code): activities, photos, import attempts, notes, link history, source files and the audit can never be changed or deleted; a submission can only go from *current* to *superseded* and is never deleted; one current file per day and department; a linked photo must have a row and a slot; an activity can only be linked to a job of the same docking.

**Behaviour:**

- **Docking:** code, fleet vessel, yard, type, UTC offset, Day 0 = arrival date, arrival time, planned departure, status. Vessel, code and Day 0 freeze once a file is imported. Changes use a revision check, so two edits cannot silently overwrite each other.
- **Days:** Day N = date − Day 0. Every day to the planned departure is listed (missing ones as *expected*). *No report* needs a reason and is refused over a received file. *Reviewed* is set by the Superintendent.
- **Imports:** one department file per day. **Initial**; **exact duplicate** (nothing stored, attempt logged); **revision** before review (old file and rows kept, superseded); **amendment** of a reviewed day (needs a reason; the day returns to *received*). The same file cannot be another day's report. Every attempt is logged, **also when the import fails and rolls back**. Rejected photos are stored with their reason, never dropped.
- **Jobs (D5):** created by the Superintendent and numbered per department (`LEO-2025-SS2-D-001`). Activities are linked and relinked with full history; unlinking needs a reason. Only rows of the current file can be linked. A job timeline lists every linked activity by day with its photos and the vessel's own text.
- **Notes (D8):** comment, query or correction on an activity, photo, day, job or file of the same docking. A note can replace an earlier note; the vessel's text is never changed.

**Not yet (Stage 1D):** the import of real daily workbooks (needs the final layout), the screens, the workspace card and access right, and the check that `node:sqlite` loads inside the running Next.js server. Links do not carry over to a revised file's rows automatically; that is a suggestion feature for 1D.

**STOP:** Stage 1B is complete pending your review.

## 12. Workspace 08 — Digital Docking in NeraVeda (built 21 Nov 2026)

**Access right `dd` ("Digital Docking"):** added to the NeraVeda rights list, the launcher (card 08) and Home ("Not connected to Home" for now). Docking runs in the same web shell and server as Inspection Reports. The server's sign-in tickets carry the person's rights to both; each page and API checks its own right (`/docking` and `/api/docking/*` need `dd`; Inspection Reports keeps needing `sir`). **Admins must tick Digital Docking for each person in Admin, including themselves.**

**Screens** (`/docking`):

- **Dockings list:** vessel, code, type, yard, Day 0, days reported and reviewed, jobs, status. **New docking** form: fleet vessel, type, suggested code (e.g. `LEO-2025-SS`), yard, location, local time (UTC offset), Day 0, arrival time, planned departure.
- **Docking overview:**
  - details, editable; vessel, code and Day 0 lock once files exist;
  - **reporting days** Day 0 → planned departure, with state, Deck/Engine files, *Mark reviewed*, *No report* with reason (not for future days) and notes;
  - **jobs** by department with the **draft Area/System list** (D4, `lib/docking/areas.ts`, from the report form headings, for your edit), each with its timeline (filled once imports link entries) and notes;
  - **activity log** from the audit trail.
- **Notes:** comment, query or correction; *Replace* keeps the earlier note, marked as replaced.

**Checked:**

- Automated tests: web shell 171, Emissions 117, Python 301 — all passing; one Python test failed once and passed on two re-runs.
- End to end on a temporary server with throwaway data and a Docking-only sign-in:
  - `node:sqlite` loads inside the Next.js server;
  - `/docking` and the home page open; Inspection Reports pages and API return 403;
  - a write without the request header returns 403; a bad vessel returns the plain message;
  - creating a docking, job, note and *no report* all work; the activity log is complete; the first daily backup was written.
- **Not checked:** the screens' appearance in a browser (only that they compile and are served).

**Next:** the daily workbook importer (needs your reworked layout), linking imported entries to jobs, and the PDF Daily Report.

## 13. DHT Leopard 2025 loaded as a working example; day screen (built 21 Nov 2026)

No vessel is in dock now, so the module was filled with the Leopard 2nd special survey (13–29 Oct 2025) from its 17 daily emails: both the vessel's side (the attached Work Done workbook) and the Superintendent's side (the report sent to owners).

**Reader for the vessel's current workbook** (`lib/docking/legacy/workdone.ts`): the format vessels send today, before the NeraVeda template. It is not only for the demo: a docking that starts before the template is rolled out can be imported with it.

- One workbook holds both departments. Sheets are sorted by name into department and performer; staging tables and the final-day plain list sheet are read too.
- An item is the serial number in B plus the sentence in C. Text written one row above its number counts as the same item.
- Photos belong to the item above them, slot 1, 2, 3… in reading order.
- A numbered item with photos but no text is kept as **"no description"** (Leopard Day 15: 20 items), never merged into a neighbour.
- Unused numbered rows (no text, no photo) are dropped. Unknown sheets are reported, not imported.
- Same hardened package reader as the template. Found and fixed on the way: `&` in cell text (e.g. "5P & 4P WBT") was shown as `&amp;`; XML's five built-in entities and numeric references are now decoded (this applies to the Stage 1A reader too).

**Store:** a combined workbook is stored once and is the source of both that day's Deck and Engine records. Using the same file for another day is still refused.

**Loaded** (`pnpm docking:history <folder>`, from emails unpacked by `scripts/docking-extract-emails.py`; the data stays on this PC, outside Git):

- Docking `LEO-2025-SS2`, Day 0 = 13 Oct (arrival 2100 LT), UTC+8, completed.
- Days 1–16: 1,193 entries and 3,001 photos, all placed; about 135 MB.
- Day 0: no workbook, recorded as "no report".
- Each day's email (new text only) is a note on the day, by its sender, with the sent time in yard local time.
- Days are left as **received**, so review can be tried on them.

**Day screen** (`/docking/<id>/days/<n>`, opened from the day card):

- Deck / Engine switch with counts; filters *Not linked to a job* and *No description*.
- Entries grouped by ship staff / yard staff / service engineer, in workbook order. The staging register is collapsed, with a note that it is copied forward daily.
- Photos as thumbnails, with a full-size viewer (arrow keys, Esc).
- Each entry: link to a job, *+ New job from this entry* (title from the entry, Area/System from the draft list), remove a link (needs a reason), and notes.
- Beside it: the day's notes, which for Leopard hold the report as it was sent. *Mark reviewed*; previous and next day.
- APIs: `GET /api/docking/dockings/<id>/days/<n>`, `GET …/photos/<photo>` (hash-checked, cached), `POST …/activities/<entry>` (link, unlink, new job). All need the `dd` right and the write header.

**Checked:**

- Web shell tests 177, all passing; `tsc` clean.
- On a temporary server (copy of the app, throwaway store, Docking-only session): all 17 days load in under 0.3 s once compiled; photos are served as JPEG; without a session → 401; a write without the request header → 403; *new job from entry* works.
- **Not checked:** the screens in a browser.

**What this shows already (for Stage 3/4):**

- Day 8: 17 Deck ship-staff rows vs 15 items in the email.
- Day 15: 20 photo-only items that the email describes from the Superintendent's own knowledge.
- Service-engineer rows carry no company names; the email adds them (HD Marine, Cosco, Alphatron…).
- The staging list repeats 30–50 rows every day.

## 14. Daily Report to owners (built 22 Nov 2026)

The step after review (D8): the Superintendent turns a reviewed day into the report owners receive, and sends it themself (D9: NeraVeda sends nothing). Opened from the day screen: *Daily report to owners* (`/docking/<id>/days/<n>/report`).

**Draft (built by NeraVeda, edited by the Superintendent):**

- Layout of the Superintendent's own emails:
  - greeting and summary;
  - header lines, with Date / Day N automatic;
  - timed events;
  - DECK and ENGINE, each by ship's staff and yard staff;
  - Class Surveyor attendance;
  - service engineers as "Company – work".
- Items start as one per vessel entry, with that entry's photos. The staging register is left out.
- Greeting, header lines and the events marked *Carry to the next day* come from the previous day's report. The first report starts from the docking details (arrival line, planned departure).
- Editing:
  - change wording, add a company name;
  - move items up or down or to another section, merge with the item above, delete (with Undo), add items;
  - remove photos, or add any photo of that day from a picker.
- The vessel's own text stays visible under each changed item. Records of the vessel are never edited.
- Changes save on their own, with a revision check: a change made in another window is refused, not overwritten. *Rebuild items from the vessel's entries* is there for a corrected file.

**Issuing:**

- Needs the day marked reviewed and text on every item. A photo-only entry must be described, merged or deleted first.
- Freezes the version: the content, the email text and the PDF (stored under its SHA-256, in backups too) can never change.
- A later version needs a reason ("what changed"). Re-issuing an unchanged draft is refused.
- The PDF must be ≤ 10 MB. The editor shows the estimate as photos are added or removed.
- **Copy email text** (per issued version) for pasting into Outlook; **PDF** download.

**PDF** (server side, jsPDF already in the project):

- A4. Company logo and the inspection report's palette.
- Header table, summary, events, then each item followed by its photos, 3 per row. JPEGs are embedded unchanged, so size ≈ the photos.
- Footer: version, issued time in yard local time and the issuer's name. Previews carry a red DRAFT mark.

**Store, schema 2** (upgrade is automatic, with a database backup first):

- `daily_reports`: one working draft per day; never deleted; each save raises the revision by one.
- `report_versions`: issued versions; cannot be changed or deleted.
- `people`: the name last seen per sign-in.

**Smaller changes:**

- Screens now show names instead of e-mail addresses: activity log, notes, *Created by*, issued versions. Records keep the sign-in id.
- The daily store backup no longer blocks the server while it copies photos: the first request of the day waited about 30 s on a fresh backup folder.

**Checked:**

- Web shell tests 186 and Python tests 301 (7 skipped), all passing; `tsc` clean.
- On a copy of the real store (Leopard):
  - schema 1 → 2 upgrade with its backup;
  - the Day 8 draft is built in 6 ms;
  - PDFs for all 16 days are 0.6–5.4 MB, each built in under 1 s.
- Production build plus HTTP run on a temporary server: page 200; no session → 401; write without the request header → 403; save 23 ms; stale save refused; preview 4.3 MB in 1.3 s; issue refused before review, then 0.8 s; download file name correct; audit shows `report.start` and `report.issue`.
- **Not checked:** the editor in a browser (Sophos intercepts localhost browsers on this PC).

**Day 8 compared with the email that was sent:**

| | Email as sent | Auto-draft |
|---|---|---|
| Items (deck ship / deck yard / engine ship / engine yard / class / service) | 15 / 14 / 11 / 9 / 1 / 10 = 60 | 17 / 12 / 8 / 10 / 0 / 6 = 53 |
| Characters | 7,061 | 4,193 |

- 45 of the 60 sent items have a close draft item (at least half the same words).
- The other 15 were the Superintendent's own: rudder, EGCS sea tube, LT cooler pipes, CO2 hoses, blower vents, anchor chain studs, two ballast-line items, Class attendance, and five service companies not in the vessel's workbook.

## 15. Importing daily files from the screen; report status on the days (built 22 Nov 2026)

**What the Superintendent does:** on the docking screen (or on a day's screen) press **Import a daily file**, choose or drop the vessel's workbook, read what NeraVeda found, then press **Import into Day N**. Nothing is stored before that press.

**What the check shows before importing:**
- the date on the sheets and the day it gives (Day 0 = arrival date), and the "Day" number the vessel wrote, with a warning if the two disagree;
- for Deck and Engine: entries (and how many have no description), photos, pictures left out, and what the import does: new for the day, replaces the earlier file (before review), replaces a reviewed file (reason required; the day goes back to "received"), or same as the current file (nothing to do);
- problems that stop the import: no date (choose one), a date before Day 0, the same file already filed under another day or docking, a cancelled docking, a file that is not an .xlsx workbook;
- opened from a day's screen, a file dated for another day offers a choice: file it as its own date, or as this day because the date on the file is wrong. Both dates are kept with the record.

**Format:** the vessel's current "Work Done" workbook (both departments in one file), read by the same hardened reader as the history load. The NeraVeda template will be added as a second format once its layout is final.

**Daily report links:**
- Each day card shows "Report draft", "Report vN issued" or "Report vN issued · changed since".
- If a corrected file arrives after the report was drafted, the report screen says so and offers **Rebuild items**. Issued versions never change.

**Fix found by the tests:** when a combined workbook replaced a reviewed day, the Engine half was recorded as a plain revision (the Deck half had already put the day back to "received") and lost its reason. Both halves are now amendments with the reason.

**Checks:**
- `tsc` clean; 195/195 web tests, 9 of them new for the import.
- On a production build with a temporary empty store, the real Leopard Day 8 workbook (6.5 MB; deck 64 entries / 169 photos, engine 36 / 81) was checked in 0.5 s and imported in 2.5 s over HTTP.
- Also checked over HTTP: the same file again → 400 "Nothing would change"; the Day 9 file filed as Day 8 → revision with the date warning; a report drafted before it then showed the newer-file notice; a non-workbook → 400; no session → 401; no request header → 403.
- **Not checked:** the panel in a browser.
