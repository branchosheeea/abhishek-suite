# Machinery Running Hours Monitoring System — proposed design

Design date: 11 November 2026. Based on the supplied project specification.

## 1. Scope and delivery

Build a standalone Python/openpyxl workbook generator in this folder. The existing Monthly Report Bot remains a separate application. Initial delivery has two visible worksheets, Machinery_Master and RH_2026, with no macros, external data connections, dashboards, or PMS features. Subsequent annual sheets stay in the same workbook for historical reference.

This document is the design deliverable. Implementation starts with Phases 1 and 2; the later phases below define how the complete solution will preserve records. No operational workbook has been generated yet.

Normal monthly operation requires only Excel 365 and works offline. Initial generation, machinery-list synchronisation, safe sorting, and annual rollover require the Python utility. Master-list edits do not automatically rearrange the RH sheet. This is the simplest safe compromise between manually entered readings, protected formulas, and a configurable machinery list without VBA.

## 2. Workbook layout

### Machinery_Master

- Excel Table `tblMachinery`, with two visible columns: Machinery Name and Include in RH.
- A hidden, protected third table column stores a permanent machinery UUID. It travels with the complete table record and is never derived from the name or row number.
- Include in RH uses a Yes/No dropdown. Names and selection are editable; IDs and headings are locked.
- Provide a modest reserve of blank table rows for new machinery. The utility extends the table and validation when capacity is reached. Engineers enter additions in these reserved rows; arbitrary table expansion on a protected sheet is not assumed to work.
- Blank unused rows have neither an ID nor readings. An ID is assigned on successful synchronisation.
- Reject duplicate names after trimming, collapsing repeated whitespace, and case-insensitive comparison. Use Excel validation as an entry aid and Python validation as the authoritative check, because pasted values can bypass validation.
- To remove equipment from current use, select No. Do not delete its master record or reuse its ID for replacement equipment.

### RH_2026

| Columns | Contents | Access |
|---|---|---|
| A | Machinery Name | Locked |
| B | Previous 31 December meter | Manual input |
| C–N | January–December month-end meters | Manual input |
| O–Z | January–December calculated RH | Locked formulas |
| AA | Machinery UUID | Hidden and locked |
| AB onward | Validity and utilisation helper formulas, if needed | Hidden and locked |

Rows 1–3 hold the title, brief operating instruction, and legend. Row 5 holds column headings; data begins at row 6. Freeze at C6 to keep machinery names, baseline, and headings visible. Use Verdana 11, white input cells, navy/grey headers, restrained separators, and lightly shaded calculated cells. Alert colours override the calculated-cell shading; “no alert” means no conditional alert fill.

A complete machinery row is one record. Names are static values written by the utility, never a FILTER spill. The initial active list is alphabetical. Protected operational sheets do not permit manual row deletion or sorting; the utility performs later alphabetical sorting across complete records. Filtering may be enabled without allowing independent column sorting.

Deactivated records remain on the annual sheet with their inputs preserved. The utility can hide these rows to present the active list; an explicit show-inactive operation restores visibility. Historical records are never deleted because of selection changes.

## 3. Data-integrity architecture

The record key is `(year, machinery UUID)`. All readings are loaded and stored against this key before any rewrite. Sorting operates on complete record objects, not worksheet names alone. Formulas are regenerated for the resulting row positions; input values are copied unchanged.

For a synchronisation operation:

1. Require the workbook to be saved and closed in Excel. Read formulas and raw input cells, not cached formula results.
2. Validate workbook schema, existing IDs, uniqueness, sheet years, names, selection values, and input types. Reject ambiguous or damaged identity mappings before writing anything.
3. Read all annual records by ID. Require existing annual IDs to remain represented in the master. If a master row has been deleted, stop with recovery guidance; never silently interpret absence as authority to erase history.
4. Assign fresh IDs only to genuinely new master rows. Existing IDs survive name edits. A missing ID on a row that may represent existing machinery is an error, not an invitation to match readings by name.
5. Add selected new machinery, update current-year display names by ID, retain deactivated records, and sort complete current-year records. Prior annual sheets retain their name snapshots and readings.
6. Validate the result and compare every pre-existing `(year, ID, month)` input with its original value, including the baseline.
7. Save to a new versioned output path via a temporary file, reopen it, and verify integrity. Keep the input workbook intact; never silently overwrite an existing output.

No worksheet password is a security boundary. Protection reduces accidental edits; it cannot make arbitrary manual unprotecting, ID replacement, or partial-column pastes safe. The supported process must be prominent in the README.

## 4. Running-hour calculation

For each month, subtract the preceding meter from the current meter. January uses column B. Return an empty string when either endpoint is absent, including a blank-looking string. Preserve a real numeric zero when both valid endpoints are equal.

Meter inputs must be numeric and nonnegative. Accept decimal hours. Text, Excel errors, negative meter readings, and booleans are invalid. Data validation guides entry, and defensive Excel formulas/conditional formatting catch invalid pasted content. Invalid nonblank endpoints produce a visible `CHECK` result; a valid decreasing pair produces the actual negative difference with the error style. Input error highlighting remains visible even if the other endpoint is missing.

Use a distinct purple error fill and an explicit legend, separate from amber/red utilisation alerts. Invalid and negative monthly results are excluded from history and monitoring. A month with a missing endpoint is not a zero-hour month.

Meter replacement/reset is flagged for engineer review. Do not use ABS, clamp negative values to zero, or invent an offset. Preserve the raw readings and document the event in a cell note and vessel records. Automated reset-adjusted RH is outside this initial scope.

Do not impose a hard 720-hour limit: calendar month lengths differ. The approximate operating hours in the specification are context, not input constraints.

## 5. Adaptive utilisation monitoring

Evaluate each consecutive pair of calendar months, highlighting only the second month's calculated RH cell. Both months must have valid, nonnegative RH. Missing/invalid months cannot be skipped to create a pair.

For a pair ending in month M, calculate the average from valid RH months strictly before M−1. Require at least three such months. Numeric zero counts as valid history; blanks, text, errors, and negative RH do not.

| Historical average | Evaluation pair | Result |
|---|---|---|
| At least 200 hours | Combined RH below 300 | Amber |
| Below 200 hours | Both RH values zero | Red |
| Insufficient history | Any pair | No adaptive alert |
| Any category | Missing/invalid evaluation month | No utilisation alert |
| Otherwise | Any pair | No utilisation alert |

Exactly 200 belongs to the higher-use category; exactly 300 combined hours does not trigger amber. Higher-use equipment with two zero months is amber under the supplied rules. Red is reserved for classified sporadic equipment with two zeros.

Initial implementation uses preceding months in the same annual sheet. With a January start, the first eligible pair is April–May, assessed in May using January–March. Classification restarts each year; cross-year history and December–January pairing are deferred explicitly to keep the first release simple. Prior annual data remains available for manual review.

Implement small, auditable hidden helper formulas rather than a single complex conditional-formatting formula. Configure the minimum history, classification threshold, and two-month threshold in Python. Error formatting takes precedence over utilisation formatting. No visible category columns are added.

These colours identify records for review. They never assert that changeover occurred or that SMS requirements were met. Actual changeover must be checked against vessel records and operating circumstances.

## 6. Midyear additions and annual rollover

For machinery added midyear, leave earlier readings blank. Enter the meter at commissioning/start into the preceding month-end slot only when it genuinely represents that month-end. Otherwise enter the first actual month-end reading; the first complete measurable month is the next month. Never fabricate a previous December baseline or treat pre-installation months as zero.

A midmonth commissioning-to-month-end total cannot be represented accurately by the specified month-end-only schema without an additional commissioning baseline field. The initial design deliberately leaves that partial month uncalculated; record it separately in vessel records if required.

Rollover creates RH_<next year> within a new output workbook and preserves all existing annual sheets. Copy the previous December raw meter to the new baseline by UUID for selected equipment. Missing, nonnumeric, negative, or unresolved erroneous December readings leave the new baseline blank and appear in a rollover review report. All new monthly readings start blank. Do not manufacture values or overwrite an existing annual sheet. Newly selected machinery without a December reading receives a blank baseline.

## 7. Source structure and interface

Planned files:

```text
machinery_rh/
  DESIGN.md
  README.md
  requirements.txt
  generate_rh.py
  rh_monitor/
    config.py       # thresholds, colours, layout constants
    records.py      # typed records, identities, validation
    calculations.py # reference RH and monitoring logic
    workbook.py     # workbook creation, styling, formulas, protection
    lifecycle.py    # read, sync, sort, rollover, safe output
  tests/
    test_calculations.py
    test_workbook.py
    test_integrity.py
  Machinery_RH_Template.xlsx
```

Proposed CLI commands are `create --year 2026`, `sync --input ... --output ...`, and `rollover --input ... --year 2027 --output ...`. `create` must never be used to rebuild an operational workbook containing readings. Dependencies are limited to openpyxl for workbook operations; use Python's standard unittest library for tests.

Set workbook calculation mode to automatic and request full recalculation on open/save. openpyxl writes formulas but does not evaluate them. Excel 365 recalculation and visual inspection are release acceptance steps; inspecting formula text alone does not demonstrate that Excel calculations work.

## 8. Incremental implementation and validation

### Phase 1 — Foundation

Generate the two worksheets, starter machinery, master table, IDs, validation, layout, and protection. Select Yes entries alphabetically at initial creation. Validate workbook structure, visible/hidden columns, input permissions, and table boundaries. Existing-workbook synchronisation is not yet exposed.

### Phase 2 — Running hours

Add all twelve RH formulas, blank handling, genuine zeros, invalid-input handling, negative differences, error formatting, and recalculation settings. Test continuous operation, one/two zeros, missing endpoints, decimal inputs, text, negative meters, and decreasing meters. Generate a foundation workbook for Excel review; clearly label it as incomplete until later phases pass.

### Phase 3 — Data integrity

Implement validated ID-based synchronisation, complete-record sorting, deactivation/reactivation, and safe versioned outputs. Tests use distinct meter sequences per machine and assert that every historical input stays associated with its original UUID through rename, addition, deactivation, sorting, and round-trip save/reload. Reject duplicate names/IDs, lost IDs, master deletion, and overwriting outputs. Preserve manual notes when moving records.

### Phase 4 — Monitoring

Add the history helpers and utilisation formatting. Test threshold boundaries, insufficient history, intermittent sea/port profiles, missing/invalid history, and changes to future readings that must not affect earlier alerts. Include explicit fixtures for amber, red, and neither.

### Phase 5 — Finalisation

Implement rollover and its review report; test valid/missing/error December baselines, midyear equipment, and an already-existing destination year. Confirm all prior annual input records remain unchanged. Complete engineer/developer instructions and generate the final operational template.

Excel acceptance covers formula recalculation, blank versus zero display, all three warning colours, protected-cell behaviour, new master entries, scrolling, filters, hidden inactive records, and rollover. Record what was actually checked in Excel separately from automated Python results.

## 9. Design decisions to carry into implementation

- Routine use is Excel-only; structural changes use the Python utility.
- Keep two visible master columns, with a hidden stable ID column.
- Deactivation preserves records; deletion is not the supported removal workflow.
- Controlled sorting moves complete records and regenerates row-relative formulas.
- Prior annual sheets remain available; the initial workbook has two sheets, later years add annual sheets.
- Three months of strictly preceding history means the first adaptive alert is possible in May, not March.
- Midmonth partial operation and reset-adjusted totals require additional data and are not silently estimated.
- Deliver an operational template only after data-integrity tests and Excel acceptance, not merely after writing formulas.
