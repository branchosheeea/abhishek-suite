# Lub Oil Consumption Review — implementation plan

Date: 11 November 2026. Status: implementation in progress; historical analysis and unattended Outlook processing remain gated.

See [architecture](LUB_OIL_CONSUMPTION_REVIEW_ARCHITECTURE.md) for the original evidence, data semantics, integration decisions and architectural constraints. This plan tracks implementation separately from acceptance; a delivered feature is not considered pilot-approved until its exit criteria are met.

## Current implementation checkpoint

The user approved proceeding with a focused DHT Colt pilot. The following first implementation slice now exists in the workspace:

- Project 02 launches from the Suite and opens a CustomTkinter review module.
- **Get Excel from Outlook** searches the classic Outlook Inbox and subfolders for matching subjects within an inclusive received-date range, saves only `.xlsx` attachments, and imports saved workbooks into the pending-review flow. The source is not the Goodwood/PAL website; Outlook messages are not changed.
- The **Activity** page streams folder, subject-match, saved/skipped attachment and import outcomes in the UI for the current session; message bodies and recipients are not collected.
- A Suite-owned SQLite database, content-hash source archive, import ledger, report versions, review notes, audit history and review-gated activation are implemented.
- The `.xlsx` parser retains source-cell evidence and distinguishes storage movement, system movement, operating consumption, change/loss, actual ROB and machinery running-hour data. Missing values remain unavailable rather than being replaced with zero.
- The Review page now presents a bounded decision brief and next action before detailed exceptions. It does not infer physical loss, savings or cost without reviewed evidence.
- The 11 supplied DHT Colt monthly `.xlsx` files from December 2025 through October 2026 were parsed and imported into a temporary test database. All remained pending review; none was confirmed or written to the user's persistent Suite database. The source set is 11 months, not a complete year.
- Synthetic workbook and repository tests cover extraction, stock comparison, duplicate import, reviewed revisions, calendar gaps and purchase-scenario arithmetic.

This is not pilot acceptance. The parser still needs cell-by-cell verification by a technical reviewer, and current warnings must be dispositioned before the reports are activated for confirmed analytics. The milestones below remain acceptance gates; progress on implementation is not evidence that a gate has passed.

## Milestones and acceptance gates

| Milestone | Small deliverable | Verification / exit criterion |
|---|---|---|
| 0. Architecture review | Agree Suite module/process integration, shared SQLite ownership, runtime root and review-based activation. | User authorized implementation of the bounded historical pilot. Future architectural changes still require review. |
| 1. Real-report discovery | Inventory the supplied DHT Colt files (December 2025–October 2026); distinguish revisions, formats, sheets, grades, units, formulas, AE layouts, remarks and missing months. | 11 monthly `.xlsx` files are available and parser/import exercised in a temporary database. Human source-cell checks, revision disposition and an approved reference remain outstanding; this is not a full year. |
| 2. Shared persistence foundation | Initial schema, vessel aliases, Suite database connection, archive and audit interfaces are implemented. | Temporary local-disk migration/rollback/restore tests remain; constraints and existing-app regression still require acceptance. |
| 3. Archival import | Folder and file-selection inputs, hashes, source occurrences, processing ledger and per-file outcomes are implemented. | Duplicate and review/version behavior have synthetic tests; real workbooks imported to a temporary database. Crash/restart and concurrent duplicate tests remain. |
| 4. Metadata and summary parser | `.xlsx` form detection, vessel/month/date/form/remarks, summary engine headings, hours/rates/change dates and source-cell provenance are implemented. | Real-file parsing is exercised, not human-golden validated. Shifted/merged/ambiguous-header fixtures, unavailable-value cases and source-by-source comparison remain. |
| 5. Full inventory and engine parser | ME cylinder/system, individual AEs, other oils, grades, receipts, replenishments, quantities/change-loss and inventory values. | Reconcile every supported field to its source; pooled AE quantities remain pooled. Inventory balance semantics validated with actual form evidence. Unsupported legacy formats reported explicitly until a reader is tested. |
| 6. Validation and lineage | Configurable rate/stock rules, report severity, pending revisions, comparison/review/confirmation, active version constraints and audit. | Test 2% boundaries, zero hours, missing month/grade/SUMMARY, date errors, out-of-order imports, competing revisions and failed corrections. A late older report cannot replace the confirmed active version automatically. |
| 7. Renewal intelligence | Evidence-backed classifications and reviewed event quantities/dates, repeated-event deduplication. | Engineer verifies actual renewal cases; high consumption alone, planned/negated remarks and repeated last-change dates do not generate confirmed renewals. Unknown quantities stay unknown. |
| 8. Historical pilot acceptance | Import the entire available pilot corpus using the same service; publish reconciled results and gap/exception register. | DHT Colt Jan-2025 onward matches the human reference for all supported fields; every discrepancy has evidence/disposition. Rerun creates no duplicate history. This gates advanced analytics and unattended Outlook processing. |
| 9. Suite UI integration | Project 02 launch/process handling, shared theme, review brief, import progress and lineage review are implemented. | Existing launcher contract passes. Dedicated module-window smoke checks, responsive import/close behavior and no-data states still require acceptance; no pilot-success badges before milestone 8. |
| 10. Analytics and charts | Calendar windows, weighted rates, AE and inventory screens, continuity checks and decision brief are implemented. | Hand-checked results for gaps, year boundaries, corrections, mixed running hours, unknown renewal quantities and grade changes remain; confirm active report replacement updates all dependent views. |
| 11. Budget scenarios | Manual forecast inputs and a quantity/cost scenario calculation are implemented. | Hand-reconciled scenarios including unknown price/ROB, zero demand, incompatible units and negative net need remain. No duplicated reserve or renewal deduction. |
| 12. Operational release | Dependency/environment capture, deployment guide, backups, migration/recovery, data access/retention policy and desktop smoke acceptance. | Clean Windows install and restore drill; existing Suite regression checks pass. Release historical capability independently of email. |
| 13. Outlook foundation | Classic Outlook desktop COM reader, background worker, subject/date filtering, `.xlsx`-only saving and mocked mailbox tests. | Offline tests cover Inbox/subfolder traversal, inclusive received dates, subject matching, Excel-only filtering, safe filenames and partial failure. Live access requires classic Outlook installed and a signed-in profile. |
| 14. Controlled Outlook pilot | Interactive Outlook retrieval feeding the existing pending-review importer. | Verify the intended mailbox and Inbox folder structure, actual subject/date behavior, attachment coverage, duplicate handling and partial failures. No scheduled or unattended mailbox processing is enabled. |

### Live Outlook smoke test — 11 November 2026

The classic Outlook profile was reachable. A test of the app workflow over the previous-calendar-month range searched the Inbox and its subfolders using Outlook subject/date filters, saved 14 `.xlsx` attachments from 21 matching emails, and imported 13 workbooks as pending review. One `.xlsx` attachment was archived but could not be parsed as the supported lube-oil form, so it remains a failed import rather than being treated as report data. No email was modified. This confirms live connectivity and the end-to-end handoff, not mailbox completeness or pilot acceptance; a human should verify the intended Excel attachment set and disposition the unsupported workbook.

Each milestone ends with a reviewable artifact and recorded test evidence. Avoid broad refactoring between milestones. Any schema/parser/rule change records its version and a migration/reprocessing policy. Source bytes and previously confirmed historical decisions remain auditable.

## Proposed changed folder structure

Legend: **EXISTING** = retained; **NEW** = proposed addition in the original design; **MODIFIED** = planned edit; **SHARED** = Suite-wide ownership. NEW/SHARED can apply together. This is the original target structure and is only partially implemented; use the checkpoint above for current code. Package directories will include `__init__.py` as needed.

```text
Monthly Report Bot/                         [EXISTING Suite workspace]
  abhishek_automation_suite.py               [MODIFIED: Project 02, process map, health card]
  launch_app.pyw                            [EXISTING: Suite/--reports entry paths preserved]
  Abhishek Automation Suite.lnk             [EXISTING]
  Vessel Report Manager.lnk                 [EXISTING]
  bot_ui.py                                [MODIFIED: shared theme only when extracted]
  customtkinter_ui.py                       [EXISTING]
  report_catalog.py                        [MODIFIED/SHARED: compatible vessel accessor later]
  report_core.py                           [EXISTING: portal batches/date utilities]
  session_worker.py                        [EXISTING: portal ownership retained]
  Ver2_download.py                          [EXISTING: optional later ingestion handoff]
  ui_pickers.py                            [MODIFIED/SHARED: shared theme, retain API]
  scroll_input.py                           [EXISTING/SHARED: reuse, compatibility tests]
  requirements.txt                         [MODIFIED: declared phase-specific dependencies]
  README.md                                [MODIFIED: module usage and stale session text]
  .gitignore                               [MODIFIED: generated data/log/archive exclusions]
  suite_services/                          [NEW/SHARED]
    paths.py                               # local runtime root and intake paths
    config.py                              # validated settings and versioned defaults
    theme.py                               # desktop palette/fonts
    database.py                            # connection/transaction/migration service
    migrations/                            # numbered Suite schema migrations
    vessels.py                             # master IDs, reviewed aliases, catalog bridge
    storage.py                             # archive, hash, recovery, backup manifest
    logging.py                             # operational log setup
    audit.py                               # durable business decisions
    email/                                 [NEW/SHARED, later email phase]
      provider.py
      microsoft_graph.py
      auth.py
    scheduler.py                           [NEW/SHARED, later email phase]
  lube_oil/                                [NEW Suite module]
    __main__.py                            # Suite-launched module entry
    models.py                              # extraction and domain records
    repository.py                          # module queries using shared database
    ingestion.py                           # one import pipeline for all sources
    worker.py                              # Excel processing, queue events/cancellation
    parsers/
      readers.py                           # OOXML/legacy adapters
      anchors.py                           # normalisation/candidate resolution
      detector.py                          # evidence-based form recognition
      stock_consumption.py                 # report sections and field evidence
    validation.py
    events.py                              # renewal/replenishment evidence rules
    analytics.py
    budget.py
    ui/
      app.py                               # module shell/navigation
      reports.py                           # imports, versions, review
      exceptions.py
      overview.py
      trends.py
      engines.py
      inventory.py
      budget.py
      charts.py                            # Tk chart adapter
  data/imports/lube_oil/                    [NEW optional intake; originals not committed]
  tests/                                   [EXISTING]
    test_suite_launcher.py                  [MODIFIED: Project 02 launch contracts]
    test_suite_services.py                  [NEW]
    test_lube_ingestion.py                  [NEW]
    test_lube_parser.py                     [NEW]
    test_lube_validation.py                 [NEW]
    test_lube_versions.py                   [NEW]
    test_lube_events.py                     [NEW]
    test_lube_analytics.py                  [NEW]
    test_lube_budget.py                     [NEW]
    test_email_provider.py                  [NEW, later]
    fixtures/lube_oil/                      [NEW: approved test fixtures/reference manifest]
  docs/                                    [NEW, CREATED now]
    LUB_OIL_CONSUMPTION_REVIEW_ARCHITECTURE.md    [NEW, CREATED now]
    LUB_OIL_CONSUMPTION_REVIEW_IMPLEMENTATION_PLAN.md [NEW, CREATED now]
  machinery_rh/DESIGN.md                    [EXISTING: separate proposal, untouched]
  diagnostics/                             [EXISTING: existing portal diagnostics]
  bot_profile/                             [EXISTING: no credential migration here]
  bot_chrome_profile/                       [EXISTING: legacy profile]
  other diagnostic/legacy scripts          [EXISTING, retained]

%LOCALAPPDATA%/AbhishekAutomationSuite/     [NEW/SHARED runtime, created only after approval]
  config.json
  suite.sqlite3
  originals/<sha256-prefix>/<sha256>.<ext>
  logs/
  backups/
```

The runtime tree is a proposal only; this documentation task does not write outside the workspace. The database is Suite-owned even though Lub Oil Consumption Review is its first consumer. Module-owned tables/migrations share the same connection and backup architecture. Real vessel fixtures should remain access-controlled and excluded from public source control; commit only approved anonymised fixtures where appropriate.

## Baseline verification and unresolved evidence

Inspection confirmed the long-lived portal worker in code, so README's earlier fresh-session wording should not drive the new design. Source inventory and installed-package inspection were read-only; no live portal/download/email scripts were run. Existing offline tests were selected without GUI or Edge fixtures: report core, Suite launcher, session worker, recovery, download scope and backend matrix. The first sandbox run encountered Windows permission errors accessing/cleaning temporary directories and a long-path fixture. These are recorded as environment failures, not asserted production defects. An outside-sandbox rerun was requested to determine the baseline; its result is recorded below once available.

The outside-sandbox rerun completed successfully: **39 tests passed** across those six existing test modules on 11 November 2026. This verifies the selected existing offline baseline, not live portal behavior or future Lub Oil Consumption Review functionality. GUI, scroll-input and local Edge fixtures were not run.

The original architecture-only baseline above was superseded when the user approved implementation. Synthetic fixtures test edge cases only and cannot substitute for real DHT Colt acceptance. Human source-cell checks, revision disposition and an approved reference remain outstanding. Exact format support, grade normalization, stock equations, renewal quantity inclusion and operational alert thresholds must be settled using that evidence.
