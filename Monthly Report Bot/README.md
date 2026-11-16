# Vessel Report Manager

A Windows desktop workspace for collecting vessel report attachments from MariApps/PAL.

## Neraveda

Neraveda (formerly Abhishek Automation Suite) combines Nereus, the Greek god of the sea, with *Veda*, Sanskrit for knowledge. Internal file names and the data folder `%LOCALAPPDATA%\AbhishekAutomationSuite` keep the original name so existing data stays connected.

Double-click **Neraveda.lnk** to open the dashboard without a terminal, or **Vessel Report Manager.lnk** to open the report app directly. These Windows shortcuts use the installed Python and require this project folder to stay in its current location. You can copy either shortcut to your desktop. Python and the dependencies are still required; this is not a standalone executable.

Desktop startup errors appear in a dialog and are logged in `diagnostics/*_desktop.log`.

The suite dashboard includes Vessel Report Manager as **Project 01**, Lub Oil Consumption Review as **Project 02**, Voyage Summary as **Project 03**, and Guarantee Claim Manager as **Project 04**, with a compact health summary for confirmed and pending lube-oil reports. Start the redesigned dashboard with:

```powershell
python abhishek_automation_suite.py
```

**Guarantee Claim Manager** maintains a vessel-and-GC claim register, status/timeline history, daily attention and an Outlook review queue. It uses the Suite's shared local SQLite database and CustomTkinter desktop pattern. Outlook is read-only; when Graph is not configured, import optional local JSON fixtures through the same deterministic subject-matching and deduplication flow. Configure Graph with the variables in `.env.example`; see [docs/GC_MODULE_README.md](docs/GC_MODULE_README.md) and [docs/GC_GRAPH_SETUP.md](docs/GC_GRAPH_SETUP.md). Launch it from the dashboard or directly with `python -m gc_manager`.

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
