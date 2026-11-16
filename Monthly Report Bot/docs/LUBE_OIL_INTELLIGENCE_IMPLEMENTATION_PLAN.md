# Lube Oil Intelligence: Gap Analysis and Implementation Plan

Companion to `LUBE_OIL_INTELLIGENCE_ARCHITECTURE.md`. Specification section numbers are shown as §n.
Last updated 2026-11-15, after Milestone 1.

---

## 1. Gap analysis

### Already implemented
- Historical import (§4): files/folder picker, SHA-256 archive, duplicate detection with every sighting recorded, a processing summary, and the original file preserved.
- Anchor-based parser (§9): vessel, month, report type, ME/AE engine metrics, last-change dates and remarks, with a validation status of PASS/WARNING/FAIL.
- Validation (§41): stock arithmetic, system balance, negative values, hours above the calendar month, zero hours with consumption, reported vs calculated ME L/24h, AE reconciliation, opening-vs-previous-closing continuity, and revision warnings.
- Version lineage (§8): `report_version`, `is_active`, `supersedes_report_id`, audit events. Superseded versions are kept and shown.
- Missing data is never zero or interpolated (§39, §17), across trends, budget and cover.
- **Budget basis master data (§19, §20, §23, §24):** vessel- and year-specific, rate and days kept separately, no roll-forward, `BUDGET BASIS NOT CONFIGURED` shown when absent.
- **Reference prices (§32):** versioned, editable, Singapore basis, with a source recorded.
- **ME activity variance, adjusted allowance and technical variance (§25–§27).**
- **Consumption-only cost (§31, §34, §35)**, with quantity first and cost second.
- **Cylinder roll-up (§21)**, with grade-specific prices supported.
- **AE vessel-level allowance (§22)**; all-in vs normal consumption (§30); AE change/loss classification (§28).
- **Stock-cover rate hierarchy (§17)**, with the basis shown and provisional NORMAL/PLANNING/LOW/CRITICAL thresholds (§16).
- **Aliases (§11)** and **locked card order (§12)**.
- **Bulk cards (§13):** six-month bars of litres, a separate L/24h figure, 12-month average, ROB, cover, status, and hover details.
- **Budget Performance page (§45, §46):** cost table, variance waterfall with a Quantity/Cost toggle (§36), AE breakdown, comments (§38), and supporting-lubricant buckets (§14).
- **Navigation (§43):** Overview, Consumption, Budget Performance, AE Analysis, Inventory, Reports, Exceptions.

### Partially implemented
- **Outlook (§5, §6):** COM download by subject phrase, `.xlsx` only. There is no `EmailProvider` abstraction and no sender or vessel-address scoring. Workbook content already confirms vessel and month.
- **Sump-renewal detection (§29):**
  - Done: change-date and explicit remark evidence for AE, classified as probable or confirmed.
  - Missing: the full phrase list ("sump cleaned", "system oil renewed"…), per-engine quantity, confidence, and manual confirmation.
- **Monthly completeness (§39):** gaps are shown everywhere, but there is no explicit RECEIVED / MISSING / PROCESSING_FAILED calendar per vessel.
- **Unreadable workbook (§41):** a parse failure is recorded as "Failed" and listed. There is no explicit `PROCESSING_REVIEW_REQUIRED` state or encrypted-file detection.
- **Overview KPIs (§44):** cards, consumption, AE, stock and supporting panels exist. There are no dedicated tiles yet for completeness, renewals over the last 12 months, or the adjusted-allowance status.
- **Exports (§12):** the monthly analysis exports follow the new order. Budget Performance has no export yet.

### Not implemented
- Tank master and tank fill % (§15, §16): the `oil_tanks` table and the card fields.
- `engine_running_hour_readings` with cumulative counters (§25).
- Manual data corrections with original and corrected values (§40).
- `EmailProvider` / `MicrosoftGraphEmailProvider` (§5).
- ORIGINAL / REVISED / CORRECTED classification and `activation_reason` / `activated_by` columns (§8).
- AlertService: a consolidated list of conditions needing superintendent attention (§44.8).

### Requires modification
- **Report activation (§8).** Automatic activation of the latest import conflicts with §8. See decision D1.
- **Consumption page measure.** The Consumption page trend still uses routine system-oil consumption (D) for L/24h comparisons, which is correct for rates. Budget and cards use all-in (D+E). Label both consistently (Milestone 3).
- **Launcher card title.** The launcher card still reads "Lub Oil Consumption Review". Rename it to "Lube Oil Intelligence" after you confirm.

### Requires data

| Item | Needed |
|---|---|
| AE system oil reference price | No AE price exists in the LO Expense workbook. |
| Tank capacities | Physical and usable capacity, minimum ROB and safety stock per tank, for DHT Colt first. |
| Cumulative ME running-hour counter readings | The sheets give 5,152 h for Jan–Sep 2026; the workbook counter difference gives 5,259 h. |
| Budget basis for other vessels | Other vessels show "not configured". |
| Budget basis for DHT Colt 2027 | Not configured; nothing is copied forward from 2026. |
| Separate High BN / Low BN reference prices | Only if they differ; the workbook uses a single CLO price of 1.59. |

### Requires user decision
- **D1. Activation rule.** Should the latest import stay automatic (your earlier instruction), or should a revised or corrected sheet need confirmation (§8)?
  *Decided 2026-11-15: Option A.* The latest sheet for a vessel/month replaces the older one automatically; the older version stays in history.
- **D2. Running-hour basis for activity.** *Decided 2026-11-15:*
  - Primary source: the "hours run" reported in the LO Stock & Consumption sheet (current behaviour).
  - Second source to be supported: the ME Running Hours sheet. Each reading keeps its source in `engine_running_hour_readings`; see `machinery_rh/DESIGN.md`.
- **D3. ME system oil "actual".** *Decided 2026-11-15:* total consumption D+E (current behaviour).
- **D4. Stock-cover thresholds.** *In discussion.*
  - **ME system oil (agreed rule):** storage ROB should hold one full charge at all times; this is the trigger.
    The full charge is recorded per vessel in the Master Data Register.
    Open question: does it mean the whole system quantity (DHT Colt 39,800 L) or the sump only (27,800 L)?
  - **Cylinder oil:** the minimum is not defined yet and needs an assessment, e.g. days between supply opportunities on the trade.
  - The provisional placeholders (Critical < 1, Low < 3, Planning < 6 months) stay labelled as not company policy until both rules are agreed.
- **D5. Hours above the calendar month.** These are kept and flagged at present. Alternatively, months with reporting-period overlap could be excluded.

- **D6. Budget period.** *Decided 2026-11-15:* the budget year starts on 1 January, so every budget figure is year to date.
  - Overview cards show "YTD used" and the year-to-date actual vs allowance. These are the same figures as the Budget Performance page (`budget.card_budget`).
  - Bar hover notes compare each month with its own hours-adjusted allowance. A month in a year without a basis shows a 12-month trend note instead.
  - The period menu defaults to "Budget year to date"; the rolling 3/6/12/24-month windows stay for trend analysis.
  - Stock cover stays on the rolling 6-month (else 3-month) normal average, because physical stock does not reset in January.
  - Deferred: comparison with the same period of the previous year (needs the prior-year basis).

- **D7. Card L/24h.** *Decided 2026-11-15:* L/24h always follows the selected period: latest month, 3/6/12/24 months, or budget year to date.
  - It is the running-hours-weighted average of the sheet's own rates (`analytics.weighted_rate`), equal to total litres × 24 ÷ total hours.
  - A month without a rate or hours is left out (blank, never zero), and the card shows "n of N mo".
  - Months whose hours exceed the calendar month are kept in multi-month averages and counted as "flagged". Shown alone (latest month) they stay hidden.
  - The Fleet Comparison page uses the same function, so the two always agree.
  - The card bars also follow the period: one bar per month, with month labels thinned out on long periods.
  - Hover tips appear in a floating window, so they are never clipped by the chart. The whole month column responds to the pointer, including missing months ("—").

**Master data (§19, §32): decided 2026-11-15.**
- The user will supply AE prices, tank capacities, other vessels' bases and future years.
- Everything is held in a register, never hard-wired.
- Basis and reference prices are **per vessel and per budget year**, because cost changes every budget year.

### Removed from scope
- Purchase scenario page and `purchase_scenario()`: removed.
- Supplier-price comparison, purchase/invoice costing, port-price variance, FIFO/LIFO/weighted average, inventory valuation: never to be built.
- 240/250/260-day scenarios and operating-day sensitivity, including the workbook's *Owners Summary* 2027 block: never to be built.

---

## 2. File changes (Milestone 1)

| Class | Files |
|---|---|
| Existing / reused | `suite_services/database.py`, `suite_services/storage.py`, `suite_services/theme.py`, `lube_oil/parser.py`, `lube_oil/exports.py`, `lube_oil/outlook.py`, `abhishek_automation_suite.py` |
| Modified | `lube_oil/analytics.py` (order, aliases, all-in consumption, AE breakdown, cover hierarchy, purchase scenario removed) |
| | `lube_oil/repository.py` (module migration, seed, basis/price/comment APIs, `save_budget` removed) |
| | `lube_oil/ui.py` (tabs, header, bar cards with hover, Budget Performance page, master-data dialog) |
| New | `lube_oil/budget.py`, `docs/LUBE_OIL_INTELLIGENCE_ARCHITECTURE.md`, this file |
| Database migrations | `lube_schema_migrations` v1: `vessel_budget_consumption_basis`, `oil_consumption_reference_price`, `cost_variance_comments`, `master_data_audit`, plus the DHT Colt 2026 seed. A backup is taken before migrating. |
| Tests | New `tests/test_lube_oil_budget.py` (budget, alias, activity, AE, cost, audit, report-control and scope tests) |
| | Updated `tests/test_lube_oil_groups.py` and `tests/test_lube_oil_review.py` |
| | Result: 154 passed, 7 skipped |

Spec §53 tests still to write (later milestones):
- Parser fixtures from real DHT Colt sheets: vessel, month, type, summary, ME, High BN, Low BN, AE1–AE3, hours, last change, remarks.
- `test_unreadable_report_review_status`
- `test_negative_stock_warning`
- `test_manual_correction_preserves_original`
- `test_corrected_report_lineage` (with the D1 rule)

---

## 3. Milestones

Each milestone is small, tested against real DHT Colt reports, and shippable on its own.

| # | Milestone | Content | Status |
|---|---|---|---|
| M1 | Budget performance | Basis, prices, activity, technical variance, consumption cost, AE breakdown, comments, Budget Performance page | **Done 2026-11-15** |
| M1b | Master Data Register | All-vessel register page: basis and prices per year, ME full charge (versioned), bulk tank register (add, edit, retire, history), tank fill % on cards, change history. Schema v2: `oil_tanks`, `vessel_lube_parameters` | **Done 2026-11-15** |
| M1c | Fleet Comparison & vessel groups | Fleet Comparison page (all vessels or a user group): totals with vessel-month coverage, per-vessel Total L / L/24h running / Budget YTD %, ranking, monthly fleet total with vessels-reporting count. Suite-wide vessel groups (core schema v2: `vessel_groups`, `vessel_group_members`, `vessel_group_history`; soft archive). `lube_oil/fleet.py`, `suite_services/vessel_groups.py` | **Done 2026-11-15** |
| M2 | Parser regression fixtures | Archive anonymised copies of the 2025–2026 DHT Colt sheets as fixtures; write the §53 parser tests against them | Next |
| M3 | Report completeness and Exceptions | Expected-month calendar with statuses; `PROCESSING_REVIEW_REQUIRED`; encrypted-file detection; consistent measure labels across pages | |
| M4 | Activation lineage | Apply decision D1; add `is_correction`, `activation_reason`, `activated_by`, `activated_at`; ORIGINAL/REVISED/CORRECTED | Needs D1 |
| M5 | Manual corrections | `manual_data_corrections` table; analytics read corrected values; Audit view shows original and corrected | |
| M6 | Running hours and tanks | `engine_running_hour_readings` (decision D2), `oil_tanks`, tank fill % on cards | Needs data |
| M7 | Sump-renewal evidence | Full phrase list, per-engine events table with confidence, manual confirm/reject, renewals over the last 12 months on Overview | |
| M8 | Email provider | `EmailProvider` interface; COM adapter for today; `MicrosoftGraphEmailProvider` reusing GC Manager's MSAL setup; multi-signal detection (§6) | |
| M9 | Suite infrastructure | Shared logger and scheduler, proposed for the whole Suite; agreed separately because it touches every module | Proposal only |
