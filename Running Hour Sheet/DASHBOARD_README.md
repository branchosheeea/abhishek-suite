# Engine Room dashboard

## Operational overview

The overview now focuses on equipment decisions, rather than adding together hours from unrelated machines. Four clickable cards show utilisation alerts, machines with two or more consecutive zero-running months, machines with meter exceptions, and machines missing RH. Cards filter a single engineering review queue; categories can overlap, but each machine appears once in the queue. Numeric meter exceptions and missing readings are counted separately.

Equipment operating history shows one selected machine's monthly RH. Largest reductions compares each machine with its own previous three usable recorded months, excluding missing, negative and questioned readings; the baseline month names are displayed and can span gaps. The selected month and future readings never enter that baseline. Comparisons are withheld for a questioned current reading or a zero baseline. These comparisons do not establish faults or maintenance requirements.

Consecutive zero-running months require actual zero RH in adjacent calendar months; a missing or questioned month breaks the sequence. Streaks and historical comparisons start at the beginning of the selected year. Last positive reading means the latest usable positive monthly RH within that year, not the exact last operation date. Imported meter values and the original adaptive screening thresholds are preserved. Per-machine YTD in the heatmap remains available; combined vessel RH totals and cross-equipment RH rankings have been removed.

## DHT LEOPARD review dataset

The working dashboard now contains the approved DHT LEOPARD reports for December 2025 through October 2026: 35 machinery names and 350 source records, excluding four byte-identical duplicate files. The preceding dashboard dataset was backed up before import. The source Excel files were not changed.

Imported months retain opening, closing and reported RH separately, with workbook/sheet/row provenance. Select a machine to inspect these read-only source records. Analytics calculate each available report's closing minus opening meter; they do not bridge missing months. Missing meters remain missing even if a template formula reports zero. March covers only three generators. The SPERRE September report remains 716 RH, with the separate 745 RH continuity gap explicitly flagged. Calendar-hour exceptions are also displayed. Totals and screening remain provisional pending review.

The import is implemented in `import_leopard.py`; do not rerun it after making dashboard changes unless you intend to replace the working dataset with the source reports again. `DHT_LEOPARD_Import_Report.json` records benchmark totals. `test_leopard_import.py` checks source-preserving analytics, missing readings, validation and read-only protection.

## Import an annual Running Hour Sheet workbook

Open **Historical imports**, choose the completed annual `.xlsx` workbook, select **Preview workbook**, review the years and any conflicts, then select **Import non-conflicting values**. The uploader accepts the project template structure: a `Machinery_Master` sheet with permanent IDs and one or more `RH_YYYY` sheets with the standard meter columns. It imports the literal meter values from the annual sheets; calculated RH formulas are ignored. Missing readings stay missing, and zero is preserved as a real reading.

Import adds values only where the dashboard has no value. Matching values are reported as identical; different existing values are shown as conflicts and remain unchanged. Machinery is matched by permanent ID, with normalized name matching for records whose IDs differ; the dashboard's existing machine names and active states are retained. The source workbook is read only and is not modified. Unsupported sheets, invalid meters, missing IDs, or mismatched template headers stop the import before any data is saved. The upload is limited to 15 MB.

After import, uploaded month-end meters are available in the dashboard and are labelled **Workbook import** in monthly entry. Correcting an imported meter requires an engineer name and a correction reason, preserving the normal audit trail. The workbook import is separate from the monthly-report folder scanner below.

Double-click `Start_Dashboard.bat`. It checks for Python 3 and the required `openpyxl` package, starts the local service, and opens the dashboard in your browser. Keep the server window open while using the dashboard; Ctrl+C stops it. If the dashboard is already running, opening the launcher brings the existing dashboard forward instead of starting a second server. If Python or `openpyxl` is missing, the launcher displays the exact setup requirement. No internet, hosted service or external database is used during operation.

The dashboard starts with the machinery register and empty 2026 readings. **Explore demo** shows a separate read-only sample dataset, including low utilisation, zero utilisation and a meter error. It never writes sample readings into vessel records. Return to vessel records to make changes.

## Workflow

1. Open Machinery register, set the vessel name, rename/add machinery and deactivate unwanted items. Deactivation retains history. Check Include inactive machinery to inspect those records.
2. Choose the reporting year, then Enter readings. Enter the previous December baseline and available month-end meter readings. Save the complete machine record. Empty inputs remain missing; equal meter readings correctly produce zero RH.
3. Choose a review month. Cards show utilisation alerts, consecutive inactivity, meter exceptions and missing readings. Select a card to filter the engineering review queue. Choose a machine for its operating trend, or select a reduction to inspect that machine. The heatmap retains individual machinery hours; all views follow the inactive-machinery filter.
4. Select a heatmap row to inspect the machine's readings. Negative RH is purple and excluded from aggregates and adaptive history. Missing values are never substituted with zero. Missing readings remain distinct from confirmed zero running hours. Per-machine YTD values are partial when readings are missing; they are not whole-year estimates.
5. At month-end, save the month's readings, enter the PMS job reference, and choose **Create PMS attachment**. The print-ready record includes each machine's opening/closing meters, calculated RH, missing/exception status, source/engineer, and review/sign-off fields. Use the preview's **Print / Save as PDF** to attach the signed/reviewable PDF to the PMS job and retain it for office records. Export monthly CSV when a data-only extract is needed. Download a full JSON backup regularly; restore validates all records and retains a local copy of the dataset being replaced.
6. At year-end, Create next reporting year carries December readings into next year's baselines for active machines. Previous years remain available. It refuses to replace an existing reporting year.

## Data and analytics

Records are stored by permanent machine ID in `dashboard_data.json` alongside the application. Every save first copies the old file into `dashboard_backups/`, then atomically replaces the working file. Preserve this folder and copy backups to another device periodically. Backups accumulate intentionally; archive older copies as required. Two browser windows editing the same revision cannot silently overwrite each other: stale edits are rejected. Refresh a stale window before editing again. The server binds only to this computer's loopback address, not the vessel network.

Names and active status are global across reporting years; readings are year-specific. Rename updates labels across historical views without moving readings. No deletion command is provided. Each machine receives a blank record when added; enter actual baseline readings for midyear additions without inventing earlier history. The dashboard uses its own JSON dataset and does not automatically import or synchronise the previous Excel workbook.

Adaptive classification follows the original specification: at least three valid historical months before the evaluated two-month period, normal utilisation average ≥200 RH with two-month total <300 RH flagged amber, sporadic average <200 RH with two zero months flagged red. Only the pair's second month is highlighted. The earliest alert is May. Classification restarts each year. Thresholds are shared with `generate_rh.py`. Historical behaviour can change with sea/port duty; indicators require engineering review and do not establish SMS compliance or replace PMS.

No CDN, external fonts, JavaScript packages or internet API are required. The frontend is plain HTML/CSS/JavaScript; the local Python HTTP service handles validation, analytics and storage. No browser-local storage is relied upon for operational records. Existing Excel deliverables are retained separately.

## Checks

Run `python -m unittest -v test_dashboard test_rh test_workbook_import`. Dashboard tests cover sample analytics, mutation isolation, deactivation/reactivation, names and IDs, rollover, duplicates, invalid imports and meters, missing readings, zeros and negative RH. Workbook import tests cover template validation, meter preservation, conflict handling, source tracking, correction notes, and the HTTP preview/apply flow. Before operational deployment, use the demo to review appearance on the shipboard browser, then enter and reload a test record and verify backup/restore using a separate working copy.
