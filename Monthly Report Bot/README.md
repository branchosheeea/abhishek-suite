# Vessel Report Manager

A Windows desktop workspace for collecting vessel report attachments from MariApps/PAL.

## NeraVeda

NeraVeda (formerly Abhishek Automation Suite) combines Nereus, the Greek god of the sea, with *Veda*, Sanskrit for knowledge. Internal file names and the data folder `%LOCALAPPDATA%\AbhishekAutomationSuite` keep the original name so existing data stays connected.

Double-click **Neraveda.lnk** to open the dashboard without a terminal, or **Vessel Report Manager.lnk** to open the report app directly. These Windows shortcuts use the installed Python and require this project folder to stay in its current location. You can copy either shortcut to your desktop. Python and the dependencies are still required; this is not a standalone executable.

Desktop startup errors appear in a dialog and are logged in `diagnostics/*_desktop.log`.

The NeraVeda home (Fleet Intelligence Suite) launches seven workspaces: Vessel Report Centre (**01**), Lub Oil Consumption Review (**02**), Voyage Summary (**03**), Guarantee Claim Manager (**04**), Critical Job Compliance (**05**), Superintendent Inspection Report (**06**) and DNV Emissions Validation (**07**). Start it with:

```powershell
python abhishek_automation_suite.py
```

### Sign-in and access rights

People sign in with a NeraVeda ID (their work email) and password, or with their Microsoft work account once IT has registered the app. An admin chooses which workspaces each person may use, and gives out temporary passwords (**Admin**, top right). Workspaces a person may not use are hidden from the home page, the sidebar and Needs attention.
- Desktop workspaces started directly (e.g. `python -m lube_oil`) open only with a NeraVeda session that includes them.
- The web workspaces (06, 07) accept requests only from the browser NeraVeda opened, with that person's session. The server checks it for every page (`proxy.ts`) as well as every API call, so a tab without a session gets an "Open from NeraVeda" page, not the app. Exception: Inspection Reports keeps drafts in the browser and still opens them from its offline copy when the NeraVeda server is not running.
- Until a PC is set up, NeraVeda runs in **local mode**: the Windows user, with every workspace, as before.

Set-up, adding people and leavers: [docs/NERAVEDA_ADMIN_GUIDE.md](docs/NERAVEDA_ADMIN_GUIDE.md). Request for IT: [docs/NERAVEDA_ACCESS_IT_REQUEST.md](docs/NERAVEDA_ACCESS_IT_REQUEST.md). Design, ticket format and limitations: [docs/NERAVEDA_ACCESS.md](docs/NERAVEDA_ACCESS.md).

### Fleet Intelligence home

The home page shows **the latest results each workspace has already saved**, not live data. Below a compact header (title, date, who is signed in) it has two sections:
- **Workspaces:** one card per workspace. Each card shows what is known, its period, when it was processed, how many items need attention (an amber or red count; click it to jump to the list), and the **Open** action.
- **Needs attention:** the 3–4 highest-priority items, by severity, alternating between workspaces, with "N more" per workspace.

It never fetches from MariApps, Outlook or vessels and never writes to workspace data: `suite_services/home_intelligence.py` opens the shared database read-only and applies each workspace's own rules. **Reload saved results** re-reads them; the page also reloads when a workspace window closes.

| Workspace | What Home reads | Attention items |
|---|---|---|
| Vessel Report Centre | Nothing yet: run results are kept only while its window is open | None. Shows "Not connected to Home" |
| Lub Oil Review | Sheets in use (`monthly_reports`), processing times, unresolved failed imports | `lube_oil.analytics.decision_brief` on each vessel's latest sheet (integrity failure = Action required; other priority exceptions = Review required); failed imports |
| Voyage Summary | Nothing yet: it reads the noon report each time it opens | None. Shows "Not connected to Home" |
| Guarantee Claims | Claim register, Outlook import time, review queue | `gc_manager.attention.calculate_attention`, applied today to the saved register (overdue/delivery overdue = Action required, as in the GC workspace) |
| Critical Jobs | Saved extraction runs (`cjc_runs`) | Latest run per vessel that failed or did not reconcile. Compliance assessments are not saved yet, so no compliance exceptions are shown |
| Superintendent Inspection | Web app summary from `/api/inspections/summary`, fetched while its server runs and cached in `%LOCALAPPDATA%\AbhishekAutomationSuite\home\inspections_summary.json` | Reports with condition items rated **Action required**. Report completion (draft % / signed off) is shown separately; the form has no finding-closure field |
| Emissions Validation | Web app summary from `/api/summary` (latest completed run per session), fetched while its server runs and cached in `%LOCALAPPDATA%\AbhishekAutomationSuite\home\emissions_summary.json` | Sessions whose latest run has validation errors (**Review required**). DNV items are counted as entered; findings are diagnostic, not confirmed reporting errors |

Missing data is never shown as zero or "all clear": a workspace without a saved result says *Not connected to Home*, *Not yet processed* or *Summary not loaded yet*; a failed run says so; a workspace whose results cannot be read shows *Could not read saved results* without affecting the others. To connect Vessel Report Centre or Voyage Summary later, each would save a small run summary (period, vessels, outcome, finished time) that `home_intelligence.py` can read.

**Guarantee Claim Manager** maintains a vessel-and-GC claim register, status/timeline history, daily attention and an Outlook review queue. It uses the Suite's shared local SQLite database and CustomTkinter desktop pattern. Outlook is read-only; when Graph is not configured, import optional local JSON fixtures through the same deterministic subject-matching and deduplication flow. Configure Graph with the variables in `.env.example`; see [docs/GC_MODULE_README.md](docs/GC_MODULE_README.md) and [docs/GC_GRAPH_SETUP.md](docs/GC_GRAPH_SETUP.md). Launch it from the dashboard or directly with `python -m gc_manager`.

**Superintendent Inspection Report** (Workspace 06) is the Inspection Reports module of the **NeraVeda web shell**, the Next.js app in [`Superintendent inspection Report/`](Superintendent%20inspection%20Report/README.md), for Superintendent's Detailed Inspection Reports (form 16.02.00.003.04). The web shell uses the Suite's layout and colours, serves the module at `/inspections`, and is where future web workspaces are added (`lib/modules.ts`). **Open Inspection Reports** starts its local server without a console window and opens `http://localhost:3000/inspections` in the default browser; once running, the button becomes **Open in browser** and **Stop server** appears. Closing NeraVeda stops the server after a confirmation. With a current build it runs `next start`; if source files are newer than the last `npm run build`, it runs `next dev` so changes are never served stale (slower first load). The server listens on `127.0.0.1` only, and every API request needs the NeraVeda session the browser was opened with, so open it from NeraVeda (opening the address directly shows "Open from NeraVeda"). Drafts are kept in the browser's IndexedDB for the `http://localhost:3000` origin, so keep port 3000: `SIR_PORT` exists, but a different port shows an empty report list. If port 3000 is used by another program the dashboard says so instead of starting; if the app is already running from this NeraVeda session, it just opens the browser, and a server left over from an earlier session is restarted after a confirmation (drafts are kept). Requirements: Node.js 18+ on PATH and `npm install` run once in the app folder; cloud sync needs `MONGODB_URI`, in that folder's `.env.local` or moved into this PC's protected storage with `python -m suite_services.access secrets import`. Server output is logged to `diagnostics/superintendent_inspection_server.log`.

**DNV Emissions Validation & Intelligence** (Workspace 07) is a separate Next.js app in [`Emission Correction Assitant/`](Emission%20Correction%20Assitant/README.md). It reads vessel Log Abstract and Bunker Report CSVs and the system-generated OVDLA workbook, reconciles them, recalculates fuel balances, and relates DNV Emissions Connect errors to independent findings. It **never modifies, corrects or writes back an original reporting file**: originals are stored insert-only under their SHA-256 and verified before and after every run, and all results are separate diagnostic records and reports. **Open Emissions Validation** starts its server (port 3001, `127.0.0.1` only, no console window) and opens `http://localhost:3001` with the NeraVeda session; **Stop server** and closing NeraVeda stop it. Requirements: Node.js 18+, `npm install` and `npm run build` once in that folder, and `EMISSIONS_MONGODB_URI` in its `.env.local` or in this PC's protected storage (`python -m suite_services.access secrets import`). Server output is logged to `diagnostics/emissions_validation_server.log`. Architecture, security controls and the acceptance-criteria status are in [`docs/ARCHITECTURE.md`](Emission%20Correction%20Assitant/docs/ARCHITECTURE.md).

Voyage Summary uses the supplied `Log Report 11 NOV 2026 Noon-.xlsx` **Noon at Sea** report as its source of truth. It looks first in `Voyage Summary` under the project folder, then in the current user's `Downloads` folder. The dashboard follows the supplied Nautix-style reference with section navigation, five voyage KPIs, passage progress, cargo/stability, grouped propulsion telemetry, auxiliary power, bunker accounting, and report remarks. Voyage status, speed, passage progress, ETA, engine telemetry, auxiliary-generator readings, cargo, drafts, environment, bunker accounting and oil-store values come from the noon report; unavailable readings are not filled with mock data. The passage graphic shows completed and remaining distance rather than inventing a historical track from a single report. Fuel totals marked with an asterisk are calculated from the report's component cells when a reported total is inconsistent or unavailable. If the report cannot be read, the module shows an error dialog with the expected file locations and access guidance. Window sizing and responsive layout account for display scaling; narrow layouts collapse the sidebar and stack panels, with scrolling for shorter windows.

Choose **Open Vessel Report Manager** to launch the report workspace, or **Open project folder** to browse its files. The dashboard prevents launching another copy while its project process is still running.

Choose **Open Lub Oil Consumption Review** for the multi-vessel monthly review. **Get Excel from Outlook** searches the classic Outlook Inbox and its subfolders for emails whose subject contains `LUBE OIL STOCK AND CONSUMPTION` within an inclusive received-date range. It saves only `.xlsx` attachments (skipping PDFs and other file types), then archives and imports those workbooks as pending reports. The workbook supplies its own vessel and reporting month; email messages are not changed. Received-date range and workbook reporting month are displayed as separate concepts.

The **Monthly Analysis** page groups the available reports by vessel and reporting month, and reviews the selected month against each vessel's own history. When changing vessels, if the selected month is unavailable for that vessel, the page moves to that vessel's latest report month; the month selector remains available for deliberate review of another month. For a selected vessel, the opening brief leads with source/review status, decision context, priority items and a grade-level monthly-consumption chart against the prior confirmed average. Choose the current month or compare against preceding 3-, 6-, or 12-month baselines. System-oil rates use valid running hours and the same oil grade; main-engine cylinder-oil rates are compared only when the reported high-/low-TBN grade set matches. Percentage changes are shown only with complete calendar coverage. Monthly operating-consumption comparisons show the actual comparable-month coverage and require the same category, grade and unit. Pending reports are excluded from the confirmed baseline. When pending historical reports exist, the page and exports show them separately as a preliminary reference, including coverage and the number of unconfirmed months; verify these before relying on them. Export the selected review to PDF or Excel. Unresolved reporting months, duplicate/revised sources, missing vessel reports, source evidence and validation warnings remain visible rather than being silently filled or inferred.

The **Consumption** page offers **1M / 3M / 6M / 12M / Custom** periods. Presets include the selected reporting month; custom start/end dates select whole monthly report buckets, without inventing daily readings. The grade chart shows **L/day = monthly litres / matching running hours × 24**, not litres per calendar day. ME system oil uses system operating litres and ME hours; cylinder grades use grade-specific withdrawals and ME hours (the workbook's cylinder-rate basis). Pooled AE system oil uses operating litres divided by combined AE hours. Other oil categories remain unavailable until a reliable machinery-hour mapping exists. Missing, zero, invalid or impossible hours are not substituted. Monthly source quantities and change/loss remain available separately in the table.

The prior confirmed benchmark within the selected range uses **sum(litres) / sum(hours) × 24**, excluding the selected report month. Coverage is shown; percentage comparisons require complete comparable prior coverage. Pending reports have a separate preliminary reference and cannot replace an active confirmed baseline. Hover over a chart month to inspect its quantity, hours, rate and source state. Cylinder-grade rates use total ME hours, not the hours on each individual BN grade; consider fuel sulphur, BN selection and load when interpreting changes. This is operating-time normalisation, not load-normalised engine efficiency. Monthly Analysis and PDF/Excel accounting exports retain their existing monthly quantity comparisons.

The **Activity** page shows live folder, matched-email, attachment and import events for the current app session; it does not collect message bodies or recipients. Imports archive source files by content hash and preserve duplicate downloads as source occurrences. The Review page provides per-report evidence and a decision brief. A reported stock difference is not treated as physical loss, savings or cost exposure.

To open the module directly:

```powershell
python -m lube_oil
```

In the module, use **Import reports** or **Import folder**. Only `.xlsx` is supported by this pilot parser; other Excel formats are not silently converted. The optional `--import-folder` command imports workbook files without opening the UI:

```powershell
python -m lube_oil --import-folder "C:\path\to\reports"
```

The shared Suite database and archived originals are stored in `%LOCALAPPDATA%\AbhishekAutomationSuite` by default. Set `ABHISHEK_SUITE_DATA` to use a different local runtime directory.

## Start

Requires Python 3.10+, Microsoft Edge, classic Outlook for Windows, company MariApps access and an authorized Microsoft account. Outlook attachment retrieval uses the signed-in classic Outlook profile through Windows COM.

```powershell
python -m pip install -r requirements.txt
python bot_ui.py
```

The `customtkinter_ui.py` compatibility launcher opens the same interface. Edge uses the local `bot_profile` to retain authentication. Complete Microsoft sign-in when prompted. Do not run another bot instance or login helper against the same profile concurrently.

## Workflow

1. Choose a frequency and search/select reports. Selections are remembered per frequency within the session; only the current frequency is included in a run. Select visible and Clear affect the filtered list.
2. Choose one, several, or all vessels using the searchable vessel chooser. Select all includes the entire fleet even when search is active; Apply commits the selection and Cancel preserves it. Choose an inclusive Job End Date range. In Custom Range, click either Calendar button to pick a date, navigate months or type a year; manual `DD-MMM-YYYY` input remains available. Last 3/6/12 Months includes the current partial month.
3. Choose an output folder. Files are grouped by vessel and job month. Existing filenames receive a numeric suffix instead of being overwritten.
4. Follow live steps, review results, export logs or retry failed reports. Retry runs only the failed vessel/report combinations and retains the original request settings. Already saved attachments may be downloaded again under numbered filenames.

Stop after report completes the active report before skipping the remaining queue. Closing during a run offers to close after that report. Progress counts vessel/report jobs processed; files saved is a separate count that includes attachments from partially failed reports.

Shortcuts: **Ctrl+F** to search; **Ctrl+Enter** to download.

## Structure

- `bot_ui.py`: class-based CustomTkinter UI. UI updates run on the main thread.
- `report_catalog.py`: vessel names, report catalog and preset labels.
- `report_core.py`: date validation, immutable multi-vessel requests, exact-pair retries, batch events and filename collisions.
- `ui_pickers.py`: searchable vessel chooser and calendar popups (no extra dependencies).
- `Ver2_download.py`: existing Playwright/PAL navigation, live step callbacks and file saving.
- `login_once.py`: Edge sign-in/navigation diagnostic.
- `monthly_report_bot_v01.py`: legacy Chrome setup with a separate profile.
- `edge_*test.py`: manual browser experiments.

## Validation

```powershell
python -m unittest discover -s tests -v
python tests/ui_smoke.py
```

Tests exercise dates, stop behavior, partial-failure accounting, request forwarding and repeated filename collisions without contacting MariApps.

## Current limitations

PAL automation scans loaded visible Job History rows; pagination and virtual scrolling are not implemented. A populated Job End Date identifies completed history entries. Each report opens a fresh Edge session using the established selectors and waits. Live portal validation requires an authenticated company session.

Preferences and activity are session-only; export logs to retain them. Browser profiles hold authentication state and are excluded from source control.

The desktop smoke check opens local windows and uses a simulated downloader; it never connects to MariApps.

A run queues every selected report for every selected vessel. For example, 3 vessels and 4 reports produce 12 jobs. Jobs run sequentially using the existing Edge profile; selecting multiple vessels removes repeated manual setup, rather than running competing browsers.

The desktop app owns one Edge/Playwright session on a dedicated worker thread for its entire lifetime. The first job opens MariApps and signs in only if the cached profile is not authenticated. Later vessels, reports, batches, and retries reuse the same browser and navigation tabs. If MariApps asks for sign-in again, the queue pauses and the Run activity panel provides Sign in in Edge and Resume. If Edge closes, use Reopen browser and resume. Closing the app shuts down the browser from its owning worker thread.
