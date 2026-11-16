# Lub Oil Consumption Review — Suite integration architecture

Date: 11 November 2026. Status: original preimplementation architecture baseline.

This document records the architecture before implementation and user approval to proceed. Its descriptions of absent code and data are historical baseline observations, not the current workspace state. The first implementation checkpoint and the subsequently available DHT Colt source coverage are maintained in [the implementation plan](LUB_OIL_CONSUMPTION_REVIEW_IMPLEMENTATION_PLAN.md). Email processing remains out of scope until the historical pilot passes its acceptance gates.

## 1. Evidence and current architecture

Inspection covers the supplied Monthly Report Bot workspace: application source, launchers, catalog, worker, utilities, tests, dependency declarations, diagnostics inventory, and the machinery design document. Browser profile internals were excluded because they contain authentication state. No other Suite checkout was supplied. No AGENTS.md was found in the workspace search or immediate parent.

| Area | Observed implementation and evidence |
|---|---|
| Suite entry | `launch_app.pyw` uses `runpy` to start `abhishek_automation_suite.py`; `--reports` starts `bot_ui.py`. README describes the two `.lnk` shortcuts; their binary targets were not independently verified. |
| Home/navigation | `AutomationSuite(tk.Tk)` is a Tkinter/ttk dashboard with one Project 01 card. `start_vessel_report_manager()` launches `bot_ui.py` using the same Python interpreter and project working directory. A process handle disables repeat launches within that launcher instance. There is no module registry or global single-instance service. |
| Working module | Monthly Report Bot is presented as **Vessel Report Manager**. `ReportApp(ctk.CTk)` has Reports and Run activity navigation, report/frequency selection, vessel/date pickers, metrics, download results, retries, and log export. |
| Other modules | `machinery_rh/` contains only `DESIGN.md`, proposing a separate Excel generator. It is not an implemented Suite module. No Inspection Intelligence implementation was found. Do not change the machinery proposal as part of this task. |
| Theme | `bot_ui.py` defines Segoe UI typography, pale grey background `#F3F6F8`, white cards, navy sidebar `#122D39`, teal `#087F79`, muted labels and amber/red exceptions. Similar constants are duplicated in `ui_pickers.py` and the ttk launcher. |
| Automation | `report_core.py` supplies immutable `BatchRequest`, `ReportJob`, date ranges, exact-pair retries, batch events, and partial-failure handling. `SessionWorker` owns one long-lived `ReportSession` on a dedicated thread. UI events pass through a queue polled by Tk `after()`. |
| Portal service | `Ver2_download.py::ReportSession` owns persistent Edge/Playwright, PAL navigation, authentication recovery, job history selection and attachment saving. History scans loaded visible rows. Receipts prevent repeated downloads within a recovery attempt; filenames receive collision suffixes. This is not permanent content deduplication. |
| Authentication | Interactive Microsoft sign-in for MariApps, retained in `bot_profile`. `bot_chrome_profile` belongs to the legacy Chrome experiment. No Suite user accounts, role system, Graph token store, or Outlook provider was found. |
| Database | No application database, ORM, migrations, or repository abstraction was found. Diagnostic JSON and browser profile stores are not a Suite database. |
| Storage | Default downloads: `Path.home()/Downloads/Vessel Report Manager Downloads`, grouped by vessel and PAL job-end month. User can choose another folder. Diagnostics live under `diagnostics/`; UI results/preferences are in memory, with manual log export. PAL job-end month is not proof of workbook reporting month. |
| Configuration | Python constants in catalog, core, portal code and UI. No persistent Suite settings service. |
| Logging/audit | UI log list and callbacks; desktop stdout/stderr logs from `launch_app.pyw`; JSON portal diagnostics; rotating `scroll_diagnostics.log` from `ScrollRouter`. No durable business audit trail. |
| Shared utilities | `ui_pickers.py` has vessel/calendar popups; `scroll_input.py` handles wheel/touchpad routing; `report_catalog.py` has fleet/report lists and presets. `unique_path` protects filename collisions but does not provide atomic archival storage. |
| Email/scheduling | No email access, notification service or background scheduler was found. Existing worker is a portal-session owner, not a general scheduler. |
| Dependencies | `requirements.txt`: `customtkinter>=6.0,<7`, `playwright>=1.64,<2`. Active interpreter observed: Python 3.15.0, `C:/Users/agupta/AppData/Local/Python/pythoncore-3.15-64/python.exe`. Installed: CustomTkinter 6.0.0, Playwright 1.64.1, openpyxl 3.1.5. openpyxl is not declared by this project. No workspace `.venv` appeared in the root listing. Installed NiceGUI/FastAPI are not evidence that this app uses a web framework. |

Additional scripts (`login_once.py`, `inspect_portal.py`, `inspect_attachment_state.py`, `verify_live_backend.py`, `edge_*test.py`, `diagnose_touchpad.py`, `monthly_report_bot_v01.py`) are login, diagnostic or legacy tools, not additional operational modules. `customtkinter_ui.py` is a compatibility launcher.

The catalog already contains `DHT COLT` and monthly `12.04.07.021 - LO Stock and consumption report`. This identifies a future retrieval option, not the workbook layout. Workbook inventory found diagnostic downloads for other vessels, including lubricant inventory form 12.04.07.023; these are not the requested DHT Colt stock/consumption corpus. No matching DHT Colt historical workbooks or independently verified Jan-2025 onward comparison dataset were found. The supplied form anchors are requirements, not observations from a real pilot workbook. Exact layouts, units, formulas, engine columns and revision conventions remain unverified.

## 2. Integration decision

Keep this repository and its Suite launcher. Add **Lub Oil Consumption Review** as Project 02/navigation action in `AutomationSuite`, alongside Vessel Report Manager. Follow the existing module-process launch pattern: launch `python -m lube_oil` from the project root, track one process per module, and keep shared configuration/data paths independent of the working directory. This is a module of the same Suite, using the same deployment and infrastructure, not a separate product or web application.

Use CustomTkinter for its module window and the existing palette, fonts, cards, pickers and queue-to-main-thread update pattern. Preserve the ttk Suite home. A future single-window shell is optional and not required to deliver this module. Do not place analytics inside `ReportApp` or make it inherit download-specific state.

Module dependencies flow from UI to application services to parser/validation/analytics and repositories. Domain calculations must not import Tk, Playwright or Outlook. A worker performs historical imports; only the Tk thread updates widgets. Suite home reads a lightweight health query asynchronously and shows unavailable/no data when appropriate. It must not open Edge, import Excel, or migrate a database while painting a card.

## 3. Shared services and bounded refactoring

| Component | Proposed treatment after approval |
|---|---|
| Vessel catalog | Seed a shared `vessels` table from `report_catalog.VESSELS`, preserving exact portal names. Add stable IDs, aliases and reviewed identity mapping. No guessed IMO numbers. Initially keep the catalog API; later back its vessel accessor with the repository plus a catalog fallback for the download app. Never maintain two independently edited vessel lists. |
| UI theme | Extract palette/font tokens into `suite_services/theme.py`; launcher, pickers and both modules consume them. Move generic widget factories only when both consumers need them. Preserve visual behavior with focused smoke checks. |
| Date/vessel pickers | Reuse existing pickers. `preset_range()` includes the current partial month; analytics needs its own explicit complete-report/calendar-window semantics. Do not reuse it blindly for trailing-year metrics. |
| Database/storage/settings | Introduce Suite-owned services, not `lube_oil.db`. Central paths, schema migration, transactions, hash-addressed originals, validated settings and backups belong here. Domain repositories remain in the module. |
| Logging/audit | Add a shared logger with module/run/report identifiers and rotation. Business decisions also go into append-only audit records. Preserve existing log export and desktop errors. Refactor existing logging incrementally, not as a prerequisite rewrite. |
| Workers | Reuse the queue/event/cancellation pattern. Do not use `SessionWorker` for Excel imports: it constructs and pumps a portal session. A small import worker needs no Playwright ownership. Extract a generic event envelope only when beneficial. |
| Portal integration | Reuse `ReportSession` and batch requests unchanged for optional later retrieval. Pass saved paths and source metadata to the same ingestion service. Do not duplicate selectors or authenticate another simultaneous Edge instance against the same profile. |
| Email/auth/scheduler | Later add one Suite email-provider interface and Graph adapter. Graph authentication is distinct from browser cookies. Introduce shared scheduled-job coordination only when email ingestion is approved. |

No full plugin framework, web server, notification bus or general orchestration engine is needed for historical ingestion.

## 4. Storage and database proposal

Use standard-library SQLite as the first **Suite** database, with versioned migrations, foreign keys enabled per connection, explicit transactions, a busy timeout and short writes. Each worker/process owns its own connection. Unique constraints, not UI buttons, enforce concurrency invariants. Schema migrations run through a startup service with a migration lock; older clients refuse unsupported schema versions.

Proposed default runtime root: `%LOCALAPPDATA%/AbhishekAutomationSuite/`, configurable to a supported local disk. Keep the live database outside this OneDrive-synchronised source directory. Project `data/imports/lube_oil/` is a convenient optional intake folder, not the database location. Archive originals under the runtime root using SHA-256 and retain their original display names in metadata. Do not rename or modify the user's input file. Coordinate consistent database/archive backups; do not treat copying an open SQLite file or OneDrive sync as a backup protocol.

Logical schema (exact DDL follows real-file discovery):

| Entity | Principal fields/invariants |
|---|---|
| `schema_migrations` | Version, applied timestamp; shared ownership. |
| `vessels`, `vessel_aliases` | Stable vessel ID, canonical and portal names, reviewed aliases; ambiguous aliases require review. |
| `email_messages` (later) | Provider/mailbox/message identity, sender, subject, received timestamp, ingestion state; unique provider-scoped identity. |
| `report_files` | ID, unique SHA-256, original filename, archive-relative path, size, detected format, archived timestamp. One byte-identical file record globally. |
| `source_occurrences` | File ID, source kind/path or message/attachment IDs, received date when known, discovered/imported timestamps. Duplicate delivery remains auditable without duplicate reports. Historical file mtime is not an email received date. |
| `processing_runs` | File, parser version, rules/config version, start/end, outcome and error details; supports retries/reprocessing without pretending the vessel issued a revision. |
| `monthly_reports` | Vessel, report type, month, reporting date, form, file/run, source status original/corrected/revised/unknown, internal report_version, is_correction, supersedes_report_id, confirmation state, is_active, complete remarks. Unknown identity stays quarantined in processing records until resolved. |
| `oil_inventory` | Report, stable oil/grade identity plus original label, category, unit, opening ROB, received, replenished to system, system quantity, change/loss, consumption, closing ROB. Values nullable; per-engine allocations never inferred from a pooled total. |
| `engine_consumption` | Report, engine identity ME/AE1–AE4 as observed, oil category/grade, running hours, consumption litres, reported L/24h, calculated L/24h, last oil change, replenishment, change/loss, renewal quantity. Cylinder and system oil remain distinct. |
| `oil_change_events` | Vessel/engine, event date or unknown date, report month, grade, quantity, classification, evidence links, confidence, review state and source report. Deduplicate repeated mentions of the same historical change. |
| `field_evidence` | Entity/field, sheet/cell or range, raw value, formula/cache details, original unit, normalized value and extraction status. Multiple evidence sources supported. |
| `validation_results` | Run/report, stable rule code/version, PASS/WARNING/FAIL, affected field, expected/actual values, evidence and review disposition. |
| `audit_events` | Import, confirmation, rejection, identity resolution, configuration and activation actions, timestamp, local actor identity and reason. Actor label is not authenticated identity unless a real auth service exists. |
| `budget_scenarios` (later) | Vessel/grade, horizon, assumptions, baseline report versions, calculations version, prices/currency, delivery and ROB inputs; immutable saved scenario snapshots. |

Use ISO months/dates and timezone-aware timestamps; retain original source representations. Separate quantities, rates, hours and currencies. Use decimal arithmetic and a documented storage precision/rounding policy. No density-based mass-to-volume conversion without documented density. Unsupported units remain unresolved.

Version identity is `(vessel_id, report_type, reporting_month)`, with unique internal version numbers and at most one active confirmed report enforced by a partial unique index. Imported sequence numbers do not assert source chronology. A distinct same-month file enters pending review, showing field differences and correction evidence. Filename words alone cannot authorize activation. Confirming a successor and deactivating its predecessor happen in one transaction with audit entries. Rejected/failed revisions never replace a valid active report. Supersession stays within the same identity and must be acyclic. Reports and originals are retained.

Reprocessing the same hash creates a new extraction run, not a new vessel report version. Activation of a new extraction result requires review if values change. Historical corrections invalidate dependent analytics and revalidate continuity for the affected month and its next calendar month. All dashboard queries use active confirmed reports; audit views expose all versions.

## 5. Historical ingestion pipeline

1. User selects files through the Suite module or explicitly imports the configured intake folder. Inventory supported files deterministically; do not silently watch Outlook or all Downloads.
2. Detect actual file type, enforce size limits, check file readability/stability, stream SHA-256 and copy to a temporary archive file. Verify the archived hash, then atomically finalize it. Original inputs remain untouched.
3. Record source occurrence and file identity. An existing hash yields a duplicate informational result, without double-counting facts. Database uniqueness handles concurrent imports.
4. Detect a supported form from workbook contents. Read all relevant sheets and generate a field-evidence extraction result. A wrong report, encrypted/corrupt workbook or unknown layout is retained with a reviewable processing failure.
5. Resolve vessel/report month from evidence and reviewed mappings. Conflicting workbook/date/email hints are warnings or failures; never use folder naming to silently fill the report month.
6. Validate within-report data, classify evidence-based events, and persist staged facts in a transaction. One bad file does not abort the remaining batch.
7. Review identity, warnings and revision diffs; confirm an eligible report. Revalidate cross-month relationships after activation, regardless of import order.
8. Refresh derived queries and display per-file results, including duplicates, failures and missing expected months. On restart, recover interrupted processing runs. A file archived before a failed database commit is reconciled by hash, not deleted automatically.

Pilot acceptance requires an inventory of actual DHT Colt originals/revisions from January 2025 onward and a human-verified cell-to-value reference. A missing month is a gap, not zero consumption. Historical success cannot be claimed until that reference reconciles.

## 6. Excel parser architecture

Use a reader adapter yielding workbook/sheet/cell/merged-range data, a form detector, anchor resolver, section parsers and typed extraction records. Proposed OOXML reader: openpyxl, explicitly declared and tested at implementation time. `.xls` requires a separately validated reader (for example xlrd) or a controlled conversion retaining both original and derivative hashes; never pass it to openpyxl or just change its extension. Unsupported formats fail clearly. Do not enable macros, follow external links, or calculate arbitrary formulas.

Normalize anchor text for case, whitespace and punctuation, retaining raw labels. Support only observed, tested synonyms. Resolve merged labels from their top-left value while retaining the full range. Locate SUMMARY, engine headings and metric rows by their relationships and section bounds. Handle repeated headers and multiple sheets with explicit candidate scoring; multiple plausible matches produce NULL/ambiguity, not a guessed nearest cell. Fixed offsets may assist a validated template adapter but cannot be the sole identification method.

Read formula and cached-value views. openpyxl does not calculate formulas; missing/error caches become NULL plus a warning. Preserve formula text and any independently calculated value separately from the vessel's reported value. Detect date epochs, Excel serial dates and clearly labelled text dates; ambiguous dates require review.

Extract metadata, complete remarks, ME cylinder oil grade/stocks/consumption/rate, ME system grade/stocks/receipts/replenishment/system quantity/change-loss/consumption/hours/rate/change date, each observed AE's hours/consumption/rate/change date/renewal/replenishment/change-loss, and other oils' grade/stocks/receipts/consumption. AE4 exists only where supported by the report. Do not copy an aggregate AE total to every engine or split it evenly. Distinguish not applicable, absent, unreadable and ambiguous fields through extraction status even though the numeric value is NULL.

Inventory equations must be established from actual report semantics. Transfers into an engine system may reduce storage ROB without being consumption. Do not assume every section obeys opening + receipts - consumption = closing.

## 7. Validation and operational events

Report status is the highest severity of applicable rules. Missing vessel/month, unsupported form, corrupt input or missing required SUMMARY fails activation. Missing grade/value, invalid dates, negatives, correction evidence, stock discontinuity and rate mismatch receive explicit diagnostics; invalid values are excluded from metrics. Rule severity and blocking behavior are versioned. A warning can be confirmed with a recorded review decision; a structural failure needs correction before activation.

Compare opening ROB to the immediately preceding calendar month's active closing ROB for the same vessel, oil identity and compatible inventory scope/unit. A gap means the continuity check is unavailable. Use configurable stock tolerance justified by source precision. Compare reported rate with `consumption / hours * 24` only when compatible consumption and positive hours exist. Default relative tolerance is 2% of the calculated rate; define a configurable absolute rounding tolerance. For a zero calculated rate use the absolute tolerance, not division by zero. Zero hours with positive consumption is an exception, never an infinite rate. Report explicitly which rules could not run.

Flag unexplained large consumption using a configurable, documented historical baseline with minimum coverage; no arbitrary pilot threshold is asserted here. Check negative quantities, missing oil grade, invalid/future dates, duplicate occurrences, revisions, missing months and inventory reconciliation. Deduplication is an ingestion outcome, not a reason to invalidate the already-imported original.

Event rules must retain evidence and rules version:

| Classification | Required interpretation |
|---|---|
| `CONFIRMED_RENEWAL` | Explicit completed renewal evidence identifying the engine and period/date, or human confirmation supported by report evidence. Quantity can remain unknown. |
| `PROBABLE_RENEWAL` | Changed last-change date or suggestive remarks/change-loss entry with incomplete identity or completion evidence. |
| `REPLENISHMENT` | Explicit top-up/replenishment quantity or statement, not evidence of a complete sump replacement. |
| `ROUTINE_CONSUMPTION` | Reported consumption with no renewal/loss evidence; do not infer a separate invented event quantity. |
| `UNCLASSIFIED_LOSS` | Reported change/loss with insufficient explanation. |

Remarks such as “sump renewed” and “system oil renewed” are evidence candidates. Negation, future plans, another engine, and references to old events must be handled. “Sump cleaned” alone is insufficient for confirmed oil renewal. High consumption alone never establishes renewal. The last-change date repeated each month is one event, not twelve. Confidence is a documented evidence grade, not an invented statistical probability.

## 8. Analytics and budget intelligence

Use calendar-month series with explicit gaps, version provenance and coverage counts. Windows end at a user-selected/as-of reporting month; never equate twelve available reports with twelve consecutive months. Provide monthly values, 3/6/12-month averages, trailing 12-month totals, YTD, and comparison with the same prior-year month and matched YTD period. Strict complete-window metrics are NULL when incomplete; optional partial aggregates must show coverage and never masquerade as annual totals. Rates aggregate as `sum(consumption)/sum(hours)*24`, not the arithmetic mean of unequal-hour engines/months. Prior-year zero gives an absolute change and unavailable percentage.

Maintain all-in and normal operating consumption separately. Subtract only confirmed renewal quantities shown to be included in the same all-in quantity, with the same engine/grade/month/unit. Unknown included renewal quantity makes adjusted consumption unavailable; probable renewals are not subtracted. Negative residuals indicate inconsistent evidence. Do not subtract renewal quantities already recorded separately from consumption.

Engine analysis shows running hours, monthly litres, rates, latest confirmed renewal date, whole calendar months since renewal and unique confirmed renewals in the trailing twelve calendar months. Renewal markers link to evidence. Missing historical coverage means renewal counts are lower bounds with a coverage label. Inventory shows stocks, usage, months remaining and estimated depletion date only when usage and usable ROB are known and compatible; zero use has no finite depletion date.

Budget scenarios are calculated per grade, never summed across incompatible oils. Store forecast period, contingency percentage, sailing days, expected AE hours, baseline period, oil prices/currency, minimum ROB, expected renewal count/quantity, usable ROB and confirmed outstanding deliveries due within the horizon. Operating forecast uses validated normal rates and planned hours/days; show assumptions and avoid adding an hours-based and days-based forecast for the same consumption.

`gross demand = forecast normal consumption + expected sump renewal quantities`

`contingency = configured percentage * gross demand`

`purchase requirement = max(0, gross demand + contingency + minimum ROB reserve - current usable ROB - confirmed in-horizon delivery)`

Setting reserve to zero reproduces the requested base equation. Do not deduct reserve twice if usable ROB was already adjusted. Cost is purchase quantity times compatible unit price. Unknown mandatory inputs yield an incomplete scenario, not zeros. Projected annual requirement remains unavailable until a supported twelve-month forecast exists. Save scenarios for audit; do not place orders.

## 9. Dashboard within the Suite

| Screen | Content |
|---|---|
| Overview | Latest confirmed report and coverage, ME system/cylinder rates, hours-weighted AE rate, confirmed trailing-year renewals, compatible AE oil ROB, projected annual requirement, unresolved exceptions. |
| Consumption Trends | ME system/cylinder and individual AE series; 3M/6M/12M/24M/custom range; monthly actual and 3/6/12-month averages. Gaps remain visible. |
| Auxiliary Engine Analysis | Observed AE1–AE4 comparisons, hours/litres/rates, renewal age/count and evidence-linked renewal markers. |
| Oil Inventory | Grade-specific stocks, receipts, consumed quantities, usage, stock continuity and depletion estimates. |
| Budget | Saved configurable assumptions and all intermediate quantities/costs described above. |
| Reports | Import actions, vessel/month/source/received date/version, processing and validation states, original-file access, lineage/diffs and confirmation. |
| Exceptions | Missing reports, ambiguous extraction, formula/rate mismatch, stock mismatch, corrections, abnormal consumption and possible renewal; review disposition never erases evidence. |

Start with Reports/Exceptions and a verified basic Overview. Advanced charts follow data acceptance. Proposed chart adapter is Matplotlib embedded in Tk, subject to dependency/packaging validation; do not introduce a web frontend. Display NULL as unavailable with a reason. Suite home Project 02 card obtains latest report, review count, consumption alerts and trailing-year renewals from the same active-report query service; no sample health numbers.

## 10. Outlook integration — later phase only

Define a Suite `EmailProvider` boundary with `fetch_new_messages(checkpoint)`, `get_attachments(message)` and `mark_processed(message, result)`. Historical ingestion does not require this interface to be operational. A later `MicrosoftGraphEmailProvider` handles mailbox pagination/checkpoints, retry/backoff, attachment metadata and shared authenticated access. Confirm tenant/account permissions and verify current official API behavior during that phase; this proposal makes no claim of an existing connection.

Match sender, subject, attachment metadata and workbook content together; unchanged reply subjects cannot exclude a valid report. Record source evidence and ambiguous identity for review. Track processing in the Suite database; “mark processed” need not move mail or change read state. Advance checkpoints only when work is durably recorded and retryable. Hash deduplication handles forwarded and acknowledged copies. Credential storage belongs to the shared auth adapter, not config files or browser-profile scraping. Scheduling and email ingestion begin only after historical extraction passes acceptance.

## 11. Testing, deployment and limitations

Existing tests cover date ranges, batching/retries, worker lifecycle/recovery, download scope, mocked backend behavior and launcher contracts. Local Edge selector fixtures are gated by `RUN_EDGE_FIXTURES`; scroll tests and `ui_smoke.py` require GUI execution. No live portal, Outlook or GUI validation was performed for this design. Baseline offline test outcomes are recorded in the implementation plan.

Future tests require real, access-controlled pilot fixtures and a manually checked golden dataset; synthetic edge-case workbooks must be clearly labelled test fixtures, never vessel history. Cover shifted/merged anchors, duplicate headers, missing caches, legacy formats, date ambiguity, NULL versus zero, pooled AE values, revision order, duplicate bytes, interrupted imports, concurrent activation, migration/restore, rate boundaries, inventory transfers, negated renewal remarks, unknown renewal quantities and calendar gaps. Regression-test current report workflows when a shared component changes.

Deploy through the existing Windows/Python Suite entry points. Add explicit Excel/chart dependencies only as their phases require, test in an isolated environment, and capture a reproducible dependency set. Do not infer supported Python versions from installed packages alone. Keep Edge requirements isolated to the report module. Back up data before migration; rollback restores a compatible database/archive snapshot rather than deleting historical reports. Test installation and restoration on a clean Windows account before release.

Architectural issues to record, not automatically refactor:

1. Home is hardcoded to one child process; direct launch or multiple launchers bypass its repeat-launch protection.
2. Theme and configuration are duplicated; UI factories are methods tied to `ReportApp`.
3. Fleet names have no stable IDs/alias review; filename and PAL job dates cannot identify historical report versions.
4. No persistent application state, business audit, migration, retention or backup service exists.
5. Filename collision protection and in-run receipts do not deduplicate historical imports across sessions.
6. Source/profile/diagnostic files share a OneDrive tree. Future live SQLite should use a local runtime root; existing profiles are not moved by this proposal.
7. `.gitignore` omits runtime database/archive patterns and rotated `.log.1`/diagnostic exports. Review before adding sensitive historical data to source control. No `.git` directory appeared in the root listing, so repository tracking state was not verified.
8. README's statement that every report opens a fresh Edge session conflicts with its later paragraph and the long-lived worker implementation; correct documentation when implementation is approved.
9. Active global Python has many unrelated packages, requirements are ranges and no project lock/environment is present; reproducibility needs an explicit deployment check.
10. `ScrollRouter` depends on private CustomTkinter canvas attributes; preserve compatibility checks when extracting UI infrastructure.
11. Portal history lacks pagination/virtual scrolling support, so historical retrieval completeness cannot be assumed.

Approval gates: approve this architecture before production work; obtain real pilot source files before finalizing mappings; reconcile historical outputs before analytics acceptance; approve tenant integration separately before implementing Outlook. No architectural issue listed above has been refactored in this delivery.
