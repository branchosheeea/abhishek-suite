# Lube Oil Intelligence: Architecture

Status: Milestone 1 (budget performance) implemented and verified on 2026-11-15.
This document supersedes the budget and cost sections of `LUB_OIL_CONSUMPTION_REVIEW_ARCHITECTURE.md`.
The import, parsing, validation and provenance sections of that document remain valid.

---

## 1. Existing Suite (inspected, reused)

| Concern | What exists | Used by Lube Oil Intelligence |
|---|---|---|
| Entry point | `abhishek_automation_suite.py`: CustomTkinter launcher. Each module starts as its own process (`CREATE_NO_WINDOW`). | Yes. Launched as `python -m lube_oil`. |
| Modules | Vessel Report Centre (`vessel_report/`), Lube Oil (`lube_oil/`), Voyage Summary (`voyage_summary/`), Guarantee Claim Manager (`gc_manager/`). `machinery_rh/` is design only. | n/a |
| UI framework | CustomTkinter, with `tk.Canvas` charts and a ttk Treeview. No matplotlib or Pillow. | Yes |
| Theme | `suite_services/theme.py` (BG, INK, MUTED, BORDER, AMBER, RED) | Yes. Module accent colours are local. |
| Database | One SQLite file, `%LOCALAPPDATA%\AbhishekAutomationSuite\suite.sqlite3`, created by `suite_services/database.py`. Raw `sqlite3`, **no ORM**. | Yes |
| Vessel master | The `vessels` and `vessel_aliases` tables, seeded from `report_catalog.VESSELS` | Yes. It is the only vessel master. |
| Vessel groups | Suite core schema v2 (`suite_services/database.py`, backup taken before migrating): `vessel_groups`, `vessel_group_members`, `vessel_group_history`. API in `suite_services/vessel_groups.py`. Suite-wide, user-defined, a vessel may be in several groups, archive instead of delete. | Yes. Lube Oil's Fleet Comparison is the first user; other modules can reuse them. |
| File storage | `suite_services/storage.py`: SHA-256 content-addressed archive under the runtime root | Yes. Originals are never modified. |
| Migrations | Suite core uses `schema_migrations` (v1). GC Manager owns `gc_schema_migrations` and takes a backup before migrating. | Lube Oil follows the GC pattern with `lube_schema_migrations`. |
| Outlook | `lube_oil/outlook.py`: COM (win32com), finds mail by subject phrase. `gc_manager/outlook.py`: COM plus Microsoft Graph (MSAL delta sync). | COM today. Graph is planned through an `EmailProvider` interface. |
| Logging | No shared logger. Modules use their own status text or files. | Gap: see §9 |
| Scheduler | None | Gap: see §9 |
| Tests | `tests/`: unittest/pytest, 154 passing | Yes |

### Recorded deviation: NiceGUI
The specification mentions NiceGUI callbacks. The Suite is a CustomTkinter desktop application.
A second UI framework would break §0 of the specification ("no second UI framework"), so the module stays on CustomTkinter.
The rule behind that sentence still holds: **no formulas live in UI callbacks.**
Every calculation is in `analytics.py` or `budget.py`, and `ui.py` only formats values.

---

## 2. Module layout

```
lube_oil/
  parser.py      ParserService: anchor-based workbook extraction and per-report validation (PASS/WARNING/FAIL)
  repository.py  ReportService, HistoricalImportService, DeduplicationService, BudgetBasisService (storage),
                 reference prices, comments, master-data audit, module migrations
  analytics.py   ActualConsumptionService, InventoryService (stock cover), SumpRenewalService (ae_month_breakdown),
                 grouping and aliases, trends, monthly analysis
  budget.py      ActivityVarianceService, ConsumptionEfficiencyService, ConsumptionCostService
  exports.py     Excel/PDF export of monthly analysis
  outlook.py     COM attachment download (to be moved behind EmailProvider)
  ui.py          CustomTkinter views only
```

The spec's service names map to modules, not classes. The codebase uses plain functions over dicts.
Wrapping them in classes would add code without adding behaviour.

---

## 3. Data model

### Existing (Suite core, schema v1)
`vessels`, `vessel_aliases`, `report_files` (sha256 UNIQUE, archive path), `source_occurrences` (every sighting, including duplicates),
`processing_runs` (parser version, state), `monthly_reports` (report_version, is_active, supersedes_report_id, confirmed_at,
validation_status, JSON payload), `audit_events`, `review_notes`.
`budget_scenarios` is legacy and **no longer written**. It is kept so that historical rows are not destroyed.

### New (module schema `lube_schema_migrations` v1)
The migration copies the database to `backups\suite-before-lube-v1-*.sqlite3.bak` before applying.

| Table | Purpose | Key rules |
|---|---|---|
| `vessel_budget_consumption_basis` | Approved basis per vessel, **budget year** and category | UNIQUE(vessel, year, category). Stores the daily rate **and** the applicable days. `annual = rate × days`. `source_reference` is required. |
| `oil_consumption_reference_price` | Singapore reference consumption price | Versioned: a change closes the old row (`effective_to`) and inserts a new one. A vessel price overrides a fleet price. `oil_grade` is optional, for separate High/Low BN prices. |
| `cost_variance_comments` | Superintendent explanations | `created_by` (Windows user) and timestamps. Never generated by the system. |
| `master_data_audit` | Old and new value, reason, actor and time for every basis or price change | Append-only |

Seed data, inserted once as editable master data and never read by service code:
- DHT COLT 2026 basis: ME cylinder 425 L/day × 240 days = 102,000 L. ME system oil 75 × 240 = 18,000 L. AE system oil 15 × 365 = 5,475 L.
- DHT COLT 2026 prices: cylinder oil 1.59 USD/L and MECC 1.18 USD/L. Source: `DHT Vessels - LO Expense analysis.xlsx`, sheet *F3 RH Analysis*, row 6 formulas.
  **No AE price exists in that workbook**, so AE cost shows "Pending price".

Planned tables (not created yet): `oil_tanks`, `engine_running_hour_readings`, `manual_data_corrections`, `email_messages`.
See the implementation plan.

---

## 4. Canonical categories and display order

- Canonical budget categories: `ME_SYSTEM_OIL`, `ME_CYLINDER_OIL`, `AE_SYSTEM_OIL`.
- Aliases mapped to `ME_SYSTEM_OIL`: SYSTEM OIL M/E, MECC, C/C OIL, ME/MAIN ENGINE SYSTEM OIL, any heading containing CRANKCASE.
- Aliases mapped to `AE_SYSTEM_OIL`: SYSTEM OIL A/E, AECC, AE SYSTEM OIL, GENERATOR OIL.
- Locked order everywhere (cards, charts, legends, tables, exports): **ME System Oil → Cylinder High BN → Cylinder Low BN → AE System Oil / AECC**.
- Supporting buckets (inventory only, never costed): Hydraulics · Gear oils · Compressor/refrigeration · Greases · Other/EAL.
  Wire-rope EAL is reported in litres, so it is no longer grouped with grease.

---

## 5. Calculation rules (as implemented)

**Actual consumption**

| Category | Rule |
|---|---|
| System oils | The sheet's *TOTAL CONSUMPTION THIS MONTH (D+E)*: routine plus change/loss, i.e. all-in. |
| Cylinder oil | Storage withdrawal. Total = High BN + Low BN. A heading missing from the sheet contributes nothing. A blank heading makes the month unavailable. |

**Budget year**
- The period runs from January of the selected budget year to the latest report in use.
- Rows from any other year are ignored.
- If nothing is configured for the year, the page shows `BUDGET BASIS NOT CONFIGURED`. There is no roll-forward.

**Months counted**
- A month counts only if a report is in use (active, not FAIL) and the category's consumption is present.
  ME categories also need ME hours, and AE needs both routine and change/loss.
- A missing month is excluded from **both** allowance and actual, and is listed on screen. It is never zero and never interpolated.

**Original allowance**

| Basis | Formula |
|---|---|
| 240-day basis | annual × covered months ÷ 12, as in the reference workbook (240/12 × 9 × 24 h) |
| 365-day basis | rate × calendar days of the covered months |

**ME activity** (ME system oil and cylinder oil only; AE never uses ME days)
- Budget hours = days ÷ 12 × months × 24
- Hour variance = actual − budget
- Operating-day variance = hour variance ÷ 24
- Activity quantity = operating-day variance × daily rate

Positive activity is labelled "activity impact" and never "adverse".

- **Adjusted allowance** = original + activity.
- **Technical variance** = actual − adjusted. Positive means actual consumption is above the adjusted allowance.

**Cost**
- Cost is applied after quantity: each quantity × reference price.
- Cylinder cost = Σ(grade quantity × grade price, falling back to the category price).
- Zero consumption is zero cost even when no price exists.
- Receipts never create cost.
- A missing price shows "Pending price", never $0.

**AE breakdown**
Change/loss (E) is classified only from the sheet's evidence:
- **CONFIRMED_SUMP_RENEWAL**: a confirmed AE renewal dated this month or last month that the previous sheet did not already carry.
- **PROBABLE_SUMP_RENEWAL**: probable renewals are never excluded automatically.
- **UNCLASSIFIED_LOSS**: everything else.

All-in = routine + change/loss. Normal operating = all-in − confirmed renewal.

**Stock cover**
- Cover = storage ROB ÷ normal monthly consumption.
- The rate comes from the 6-month average if all six months are present, else the 3-month average, else the approved budget rate. The basis used is shown on every card.
- Confirmed AE renewals are excluded from the rate.
- Provisional thresholds, labelled on screen as not company policy: Critical < 1, Low < 3, Planning < 6 months.

**ME hours above the calendar month**
- DHT Colt Feb, Apr and Jun 2026 report more ME hours than the calendar month contains.
- These hours are kept and flagged. The sheet's reporting period need not match the calendar month, and consecutive periods still add up to the true running time.

---

## 6. Verification against the reference workbook

`tests/test_lube_oil_budget.py::test_reference_workbook_dht_colt_activity` reproduces the workbook's DHT Colt row exactly:

| Measure | Value |
|---|---|
| RH | 5,259 h vs 4,320 h → 939 h → 39.125 days |
| Cylinder oil | +16,628.125 L → $26,438.72 |
| MECC | +2,934.375 L → $3,462.56 |
| Original allowance to September | 76,500 L |

**Data finding.** The live sheets give 5,152 h for Jan–Sep 2026 (sum of monthly *hours run*). The workbook's cumulative counter difference is 5,259 h.
The 107 h gap is why the dashboard shows +34.7 days where the workbook shows +39.1.
Settling this needs cumulative counter readings (`engine_running_hour_readings`). See *Requires data* in the plan.

DHT Colt Jan–Sep 2026 from real sheets:

| Category | Original allowance | Activity impact | Actual | Technical variance |
|---|---|---|---|---|
| Cylinder oil | 76,500 L | +14,733 L | 84,633 L | −6,600 L (−7.2%) |
| ME system oil | 13,500 L | +2,600 L | 21,350 L | +5,250 L (+32.6%) |
| AE system oil | 4,095 L allowance | n/a | 13,055 L all-in | n/a |

AE all-in breakdown: routine 7,355 L, confirmed renewal 1,350 L, probable 3,800 L, unclassified 550 L.

---

## 7. Scope removed (locked)

- **Removed from code:** `purchase_scenario()`, the purchase-scenario page, and `Repository.save_budget()`.
- **Never to be implemented:** supplier-price comparison, purchase/invoice costing, port-price variance, FIFO/LIFO/weighted-average costing, inventory valuation, and the 240/250/260-day scenario or sensitivity pages.
- The reference workbook's *Owners Summary* 2027 scenario block (CLO $2.29/MECC $1.88 "budget prices", 250/260 days) is presentation-only and **not imported**.
- `ScopeTests` in `tests/test_lube_oil_budget.py` fail if procurement, price-variance, FIFO or scenario code reappears in the analytics or budget modules.

---

## 8. Report activation: a conflict to resolve

- **Spec §8:** activate a revised or corrected report only on evidence or authorised confirmation.
- **Current behaviour:** the latest usable import for a vessel/month activates automatically. Earlier versions stay preserved and visible as "Superseded".
  This follows your explicit instruction (2026-11) that vessel sheets are official and need no review gate.
- **Status:** recorded as a *user decision* in the plan. Not changed silently.

---

## 9. Architectural problems in the Suite (identified, not refactored)

1. **No shared logging.** Each module writes ad-hoc status text. The Vessel Report Centre's `scroll_diagnostics.log` rotation fails when two windows hold it open.
2. **No scheduler.** Outlook ingestion is manual. Any automation needs one Suite-level scheduler, not one per module.
3. **Two Outlook stacks.** The Lube Oil COM code and the GC Manager COM/Graph code duplicate connection logic. One `EmailProvider` service should serve both.
4. **Core schema gate.** `suite_services.database.initialize` refuses any `schema_migrations` version above 1. Modules have to version their own tables, which is why `lube_schema_migrations` exists.
5. **Large view file.** `lube_oil/ui.py` is about 2,730 lines. The page classes could be split into `lube_oil/views/` without behaviour change.
6. **JSON payloads.** Parsed values live in `monthly_reports.payload` JSON. Normalised tables (inventory, engine hours) would allow SQL queries and manual corrections per field.
7. **Vessel master is seeded from code.** `report_catalog.VESSELS` seeds the table. Adding a vessel currently needs a code change.
8. **UI wrapping limitation.** In CustomTkinter, wrap widths that react to resizing make the scrollable page oscillate and the scrollbar recurse. Wrap widths are therefore fixed to fit the minimum 1280 px window.
