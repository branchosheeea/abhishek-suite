# Project Status

## What this project does

This is an offline-first web app for preparing Superintendent's Detailed Inspection Reports (form 16.02.00.003.04). It provides a dashboard and report editor, stores draft reports and photos in browser IndexedDB, syncs with MongoDB when online, and exports a formatted PDF.

## Work completed

- Reviewed the app structure, report form model, editing flow, local storage, MongoDB API, sync logic, and PDF generation.
- Installed the Node dependencies and confirmed that `npm run build` succeeds.
- Started the local development server at `http://localhost:3000`.
- Added `.env.example` with the `MONGODB_URI` setting required by the cloud-sync API.
- Added the main project setup and feature documentation in `README.md`.
- Replaced the earlier condition-risk summary (Good 20 / Fair 40 / Poor 80, averaged) with the Condition & Assurance Overview (17 Nov 2026). An averaged "risk %" is not a risk assessment and hides the worst finding.
  - Items are now rated Satisfactory / Acceptable / Degraded / Deficient, plus Not inspected (with the reason) and Not applicable.
  - Degraded and Deficient items get a findings-register entry (priority, due date, safety-critical, RA status and number, defect-list number, open / closed).
  - Critical-equipment tests record Satisfactory or Defect.
  - The PDF and the Sign-off step show the worst observed condition per area, coverage, key figures, the findings register and the inspection limitations. The overall conclusion is withheld while items are unrated.
  - Ratings made on the earlier scale are kept; Monitor and Action required must be re-rated in reports not yet approved.
- Changed the exported photo pages to place up to two centered, proportionally scaled photographs on each page, each inside a black frame.
- Added the existing `public/logo.png` company mark to the PDF cover page.
- Imported the DHT LEOPARD September 2026 sample report into the local browser draft format, preserving its narratives and 40 numbered photographs. Ratings remain blank because the source report contains no explicit Good/Fair/Poor selections.
- Updated condition tables so each inspection item and rating has a compact heading row, with its remarks/findings spanning the full page width beneath it.
- Set narrative cells and table headers to left alignment and applied consistent shared table defaults for typography, padding, borders, and header styling.
- Removed source-report page-header and form-code artifacts from exported narrative text only; the locally stored report content is unchanged.
- Added the Executive Summary – Preamble builder (16 Nov 2026). It replaces the free-text preamble box with structured selections, a deterministic generator, a live preview, validation and Draft / Under Review / Final status. Selections are saved in `report.narratives.preamble` and the generated text in `summary.preamble`. Existing hand-written preambles are kept until the user confirms a replacement. `npm run typecheck` and `npm test` were added (65 tests). Details are in README.md.
- Added controlled builders for the other six Executive Summary fields (17 Nov 2026): Overall, Structural and Operational Condition, Performance, Significant Problems, and Projects and Upgrades. They are based on a review of 27 past reports. A generic section engine (`lib/narrative/section.ts`) and one definition per section are used. The builders take facts from the report's own condition ratings and critical-equipment tests, and cross-check the summary against them. The placeholder check now also catches "XXXX". There are 93 unit tests in total.
- Added the Hull page remarks builder (23 Nov 2026). It follows the same controlled-narrative engine as the Executive Summary, based on how past reports describe the hull. The text is saved as the Hull item's remarks, and the findings register receives a short defect statement. A new page starts from the Structural Condition summary's underwater and hull selections, using shared wording. The text is cross-checked against the rating, the Load Line Convention (markings), Class reporting of damage, the six-monthly underwater interval and the Structural summary. The engine now supports other save targets and starting selections, so further condition items can get builders.
- The vessel's condition is now stated once and carried through the whole report (23 Nov 2026). Laden or ballast, and at sea, in port or in dry-dock, are taken from the Preamble. The Preamble now asks laden/ballast for every status that does not already imply it. The Hull builder no longer asks for it. The Hull, Structural and Operational builders show it, and warn when a selection contradicts it.
- Hull coating (23 Nov 2026):
  - The date of the last complete hull painting is now recorded and stated with the coating's age.
  - Coating repairs always involve the paint maker; the ship's-staff touch-up options were removed.
  - Repair actions are multi-select, and the extent of breakdown is recorded.
  - New checks: coating older than five years; breakdown on a recent coating (warranty).
- Dropdowns use the theme's colours for the open list in Edge / Chrome 135+, so hovered and selected options stay readable in the dark theme.
- Added the Main Deck (Weather deck) remarks builder (23 Nov 2026), based on the Weather Deck sections of past reports. It adds the items those reports omit but PSC / SIRE 2.0 / TMSA inspectors check: pollution prevention on deck and cargo line bonding. PV valves, the PV breaker, deck seal and mast riser are reported here. Ship's-staff painting is accepted on deck.
- Main Deck builder extended after a Technical Director-level review (23 Nov 2026):
  - previous findings follow-up;
  - paint system and crew training discussion;
  - surface preparation and DFT;
  - "verified by" on key items;
  - flame screens, deck seal alarm and tank openings;
  - Ex electrical equipment and weathertight closures;
  - temporary repairs register with Class status.

  Defects in these suggest a Deficient rating.
- Main Deck (24 Nov 2026): explicit deck coating condition on the IACS scale, the type of breakdown and the coating's age (the helpers are now shared with the Hull page).
- Sync conflicts fixed (24 Nov 2026, audit item P0-1).
  - **Before:** when the cloud refused a save as out of date (409), the app marked the report as synced, and the next fetch replaced this device's changes.
  - **Detection:** each save now carries the cloud version it is based on. The server writes only that version.
  - **On a conflict:** the device keeps its copy, stops syncing that report, and asks whether to keep both, use this device's version or use the cloud version.
  - **Tests:** `tests/sync-conflict.test.ts`. Details are in README.md under "When the same report is changed in two places".
- Approved reports protected by the server (24 Nov 2026, audit item P0-2).
  - **Before:** the cloud overwrote or permanently deleted any report, including approved ones, with no record. "Withdraw approval" only cleared the signature.
  - **Now:** once the Fleet Manager has approved a report, it is read-only. The cloud refuses changes to it, its photos and its deletion.
  - **Withdrawing an approval** needs a reason. The cloud keeps the approved version permanently, with who, when and why.
  - **Deleted drafts** are kept in the cloud's deleted store.
  - **Records:** approvals, withdrawals, deletions and refused changes are recorded in `report_audit`, and each saved report records who saved it.
  - **Edit timestamps** now always move forward, so an edit counts as unsent even when this device's clock is behind.
  - **Not yet enforced by the server:** that the report was complete when approved.
  - **Tests:** `tests/approved-reports.test.ts`. Details are in README.md under "Approved reports are protected".
- Daily backups (24 Nov 2026, audit item P1-1).
  - **What:** the server backs up the `inspections` database the first time it is used each day, to `%LOCALAPPDATA%\AbhishekAutomationSuite\backups\inspections-daily` on this PC.
  - **How:** each document is stored once and shared between snapshots; the newest 30 are kept.
  - **Restoring:** a restore goes only into a new, empty database (`npm run backup`).
  - **Shared engine:** the same engine backs up Emissions Validation. The NeraVeda launcher backs up the suite database the same way.
  - **Tests:** `tests/mongo-backup.test.ts`. Details are in README.md under "Daily backups".
- Audit items P1-6, P1-7 and P1-8 (24 Nov 2026).
  - **Digital Docking: job links follow a replaced file.** A link moves to the new file's row only when it is the same row (sheet and row reference) with exactly the same text, found once. Both moves are recorded in the link history.
  - **Links that don't move** stay on the replaced row, which the job view marks "replaced file: link the row in the new file". The import message says how many links moved and how many need re-linking.
  - **Home sees Digital Docking:** `/api/docking/summary` (`lib/docking/server/summary.ts`) lists each docking's days so far, the files received and reviewed, and the past days with no report.
  - **Home sees drafts only on this device:** the report list tells the server how many of the browser's reports are not in the cloud yet, or are waiting for a decision (`/api/inspections/device`, kept in memory). `/api/inspections/summary` passes the counts on.
  - **Type errors now stop the build:** `typescript.ignoreBuildErrors` was removed from `next.config.mjs`. If a build fails, NeraVeda's launcher falls back to `next dev`.

- Vessel Master (24 Nov 2026).
  - **What:** one shared record of each vessel's particulars, imported from the Vessel Master workbook into the cloud `inspections` database. Every value has a status (VERIFIED, PROVISIONAL, CONFLICT, MISSING), its source and its history. 24 vessels were imported (23 from the workbook, DHT ORYX kept as a name-only record), after a restore test of the daily backup passed.
  - **New reports:** the vessel is chosen from the master. The particulars (six groups A–F) are filled in, offered or left empty according to each value's status, and kept as a fixed copy in the report. Refresh compares first. Offline use, "Report issue" and "Verify on board" are included.
  - **Earlier reports** are unchanged: same four groups, same PDF (checked byte for byte against the previous code).
  - **Admin:** `npm run vessel-master` (preview, approved import with a backup first, list, show, flags). The review page is `/inspections/vessels`.
  - **Also fixed:** cloud sync on the office network ("sync failed"). The SIR server now uses NeraVeda's DNS servers for the Atlas lookup.
  - **Open questions from the plan** (values held back until answered or verified on board): Addax performance (specification H5508 vs hull 5509), Puma MCR (24,400 kW may be the statutory power), Antelope summer DWT (scantling figure).
  - **Tests:** 54 new (rules 12, import 10, view and flags 11, verification 8, particulars versions 13). Details are in README.md under "Vessel Master".

## Running locally

From the project directory:

```powershell
npm install
npm run dev
```

Open `http://localhost:3000`. To use cloud sync, set `MONGODB_URI` in `.env.local` to a reachable MongoDB connection string. Draft editing and storage in the browser are available independently of cloud sync.

## PDF review

The imported DHT LEOPARD report was freshly exported to a 32-page PDF after the table updates. The cover and condition pages were visually reviewed: narrative text is left-aligned, findings use the full content width, and no source-PDF page header was found in the exported text. Ratings remain blank because the source contains no explicit Good/Fair/Poor selections. The sample includes 40 photos; the existing two-centered, black-framed-photos-per-page layout was retained.

## Suggestions to make the workflow more useful

- Add a six-month vessel history view that compares condition scores and ratings with the previous inspection.
- Carry forward open defects and recommendations into the next inspection, with owner, due date, and closure evidence.
- Add guided rating definitions and require a short finding or action for Poor ratings.
- Provide a report completion checklist before final PDF export and sign-off.
- Allow photos to be reordered and let users enter captions more quickly in batches.
- Provide a draft PDF preview before download.

## Notes

- `npm.cmd run build` and `npx.cmd tsc --noEmit` passed after the PDF changes. The project has no configured automated test script.
- `npm install` reported six dependency audit findings (two low and four moderate); they were not automatically changed.
- The four condition grades and the new finding fields change form 16.02.00.003.04. A form revision under the Company's document control is needed; the form code printed on the PDF (`FORM_CODE` in `lib/form-schema.ts`) is unchanged until the revision number is issued.
- The Executive Summary's overall-assessment words (Good / Satisfactory / Fair / Poor) differ from the item ratings. Aligning them is an open decision.
