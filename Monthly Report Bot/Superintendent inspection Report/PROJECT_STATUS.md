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
