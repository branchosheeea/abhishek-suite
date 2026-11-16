# Superintendent Inspection Report

A Next.js-based inspection reporting app for creating, editing, storing, and exporting superintendent inspection reports. The app is designed to work offline first: reports are saved locally in the browser and synced to a MongoDB-backed API when a connection is available.

## Overview

This project helps ship management teams prepare and maintain Superintendent Detailed Inspection Reports (SIR) with:

- Offline-first report drafting
- Local IndexedDB persistence
- Cloud sync to MongoDB
- PDF export for final reporting
- Photo attachment support
- Structured sections for vessel details, inspection scope, condition ratings, and sign-off

## Tech stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- IndexedDB via `idb-keyval`
- MongoDB via `mongodb`
- jsPDF + jsPDF AutoTable for PDF generation

## Neraveda web shell

This Next.js app is the **Neraveda web shell**. It hosts Neraveda's web workspaces inside the Suite's layout: a navy sidebar, the desktop dashboard's colours and Segoe UI. The Superintendent Inspection Report is its first module.

| Route | What it is |
| --- | --- |
| `/` | Neraveda web home, listing the web workspaces |
| `/inspections` | Inspection report list (module home) |
| `/inspections/report?id=…` | Report editor |
| `/report?id=…` | Old editor address: temporarily redirected (307) to `/inspections/report?id=…` |
| `/api/reports`, `/api/reports/[id]`, `/api/reports/[id]/photos/[photoId]` | Report and photo sync API (unchanged) |
| `/api/health` | Lets the desktop launcher recognise this server |

Return paths: the sidebar (or the top bar on narrow screens) links to Home and each module, the list page has a `Neraveda › Inspection Reports` breadcrumb, and the editor's back arrow returns to `/inspections`.

**Adding a module:** add an entry to `lib/modules.ts`, then create its pages under `app/(shell)/<route>/`. The sidebar and home page pick it up automatically. Keep API routes under `app/api/<module>/…`.

**Storage stays where it was:** browser IndexedDB stores `sir-reports` / `sir-photos` for the `http://localhost:3000` origin, plus MongoDB database `inspections` (collections `reports`, `photos`). The route move changed no data, so no migration is needed. The service worker cache was renamed to `neraveda-shell-v3`; the old `sir-shell-v2` cache is removed automatically. There is no sign-in yet; the server only listens on `127.0.0.1`.

## Project structure

```text
app/
  (shell)/              # Pages inside the Neraveda layout
    layout.tsx          # Sidebar / top bar (components/shell/app-shell.tsx)
    page.tsx            # Neraveda web home
    inspections/        # Inspection Reports module: list + report/ editor
  api/                  # reports/ (MongoDB-backed sync), health/
components/
  shell/               # Neraveda sidebar, brand and module badges
  dashboard/           # Inspection report list UI
  report/              # Report editor sections and form components
    preamble/          # Executive Summary – Preamble builder (forms, live preview, validation summary)
  ui/                  # Shared UI primitives
hooks/
  use-report-editor.ts  # Editing logic and autosave behavior
lib/
  modules.ts           # Registry of web workspaces
  narrative/           # Controlled-narrative engine (no React): text/date helpers, preamble options,
                       #   model, generator and validation
  vessels.ts           # Fleet list (mirrors report_catalog.VESSELS in the desktop suite)
  form-schema.ts       # SIR form data model and section definitions
  local-db.ts          # Local IndexedDB access
  mongodb.ts           # MongoDB client and indexes
  pdf.ts               # PDF generation
  sync.ts              # Local/cloud sync logic
public/
  ...                  # Static assets and PWA files (sw.js)
```

## Opening from Neraveda

This app is **Workspace 06** of the Neraveda automation suite (`Monthly Report Bot/abhishek_automation_suite.py`). Choose **Open Inspection Reports** on the dashboard: it starts this server on `http://localhost:3000` (no console window) and opens `/inspections` in the browser. It uses the production build when it is up to date and falls back to `next dev` otherwise, so after changing code run `npm run build` for faster start-up. Keep port 3000, because drafts saved in the browser belong to that address. The manual steps below still work on their own.

## Prerequisites

- Node.js 18+ recommended
- npm (or pnpm, though the project is configured for npm in this environment)
- MongoDB instance running locally or remotely

## Getting started

1. Open a terminal in the project root:

```bash
cd "c:\Users\agupta\OneDrive - Goodwood Shipmanagement Pte Ltd\Work Related\Office Projects\Python Projects\Monthly Report Bot\Superintendent inspection Report"
```

2. Install dependencies:

```bash
npm install
```

3. Create a local environment file:

```bash
copy .env.example .env.local
```

If you're using a local MongoDB instance, the example file is already set to:

```env
MONGODB_URI=mongodb://127.0.0.1:27017
```

4. Make sure MongoDB is running.

For a local MongoDB installation, the typical command is:

```bash
mongod
```

If you use a remote MongoDB database, update `MONGODB_URI` in `.env.local` with your connection string.

5. Start the development server:

```bash
npm run dev
```

6. Open the app in a browser:

```text
http://localhost:3000/inspections
```

## Production build

To build for production:

```bash
npm run build
```

To run the production build locally:

```bash
npm run start
```

## Features in the app

- Create new inspection reports
- Save work automatically on the device
- Continue editing without internet connectivity
- Sync report data and images to MongoDB when online
- View progress for each section
- Export final inspection report as PDF
- Attach photographs to sections of the report
- Generate the Executive Summary preamble from structured selections (see below)

## Executive Summary – Preamble builder

**Executive Summary → Preamble** replaces the free-text preamble box. The Superintendent enters the attendance facts and picks controlled wording from dropdowns and checkboxes. A four-paragraph preamble is generated and previewed live:

1. Attendance
2. Opening meeting, objectives and scope
3. Examination, records and focus areas
4. Findings, follow-up and acknowledgment

The other six summary fields are unchanged, under **Other summary fields**.

**Deterministic.** `lib/narrative/preamble/generate.ts` builds the text from fixed templates, so the same selections always give the same wording, and no AI service is used.
- Hidden conditional fields never contribute stale values.
- The text never claims that the vessel was satisfactory, that the machinery was fully operational or that defects were closed.
- "No deficiencies identified" wording appears only when that option is chosen.
- Bunkering and cargo operations are described as witnessed only when that is ticked.

**Missing information.** Missing details show as highlighted markers in the preview only. Copied and saved text never contains a marker, because the sentence is shortened instead.

**Validation.** `lib/narrative/preamble/validate.ts` shows errors next to each field and lists them above the preview.
- Errors block **Final** and saving the text. They cover:
  - missing vessel, type, start date or location;
  - an end date before the start date;
  - sailing inspections without both ports or without a passage status;
  - no objective selected;
  - "Other" ticked with no text;
  - dry-docking without a shipyard;
  - mutually exclusive options selected together;
  - placeholders.
- Warnings cover optional items left empty.

**Saving.**
- **Vessel and dates** are the report's Inspection Details fields (`details.vessel`, `details.dateFrom`, `details.dateTo`), never a second copy. A fleet vessel also stores `details.vesselId`.
- **Selections** are stored as stable ids in `report.narratives.preamble` (`status`, `inputs`, `generatedText`, `lastGeneratedAt`). They autosave and sync like the rest of the report. The API saves `narratives` only when a request includes it, so a tab running an older version cannot wipe it.
- **Save preamble** writes the generated text to `summary.preamble`, which the PDF already reads. If the report holds a preamble that was not produced by the builder, the app asks before replacing it.
- **Status:** Draft, Under Review or Final. **Final** saves the text and locks the selections.

**Adding the next section** (Overall Condition, Machinery Condition…) follows the same pattern:
1. Add options, a model, a generator and validation under `lib/narrative/<section>/`.
2. Add its state under `report.narratives.<section>`. The ids are listed in `lib/narrative/types.ts`.
3. Reuse the form primitives in `components/report/preamble/fields.tsx`.

## Tests

```bash
npm run typecheck   # TypeScript, including the tests
npm test            # Node's built-in test runner on tests/**/*.test.ts (no extra packages)
```

The tests cover:
- date and list phrasing;
- every inspection circumstance and the validation rules;
- the five reference scenarios (sailing, port, Special Survey dry-docking, newbuilding maiden voyage, SIRE 2.0 preparation), including that scenario 1 reproduces the reference preamble word for word;
- save → restore round-trips.

`tests/ts-resolve.mjs` only lets Node load the app's extension-less TypeScript imports. The project has no linter configured.

## Notes on runtime behavior

This app uses two storage layers:

- Local storage: IndexedDB for immediate offline editing
- Remote storage: MongoDB for shared/report sync workflows

When the app is online, local changes are pushed to the server, and remote updates are pulled back into the browser.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `MONGODB_URI` | Yes for API sync | MongoDB connection string |

## Troubleshooting

### App does not start

- Confirm Node.js is installed and available in PATH
- Run `npm install` again to ensure dependencies are present
- Verify the project directory is correct

### Sync/API errors

- Ensure `.env.local` exists and contains a valid `MONGODB_URI`
- Make sure MongoDB is running and reachable
- Check the terminal output for connection or validation errors

### PDF export fails

- Ensure the browser allows the page to generate a download
- Try refreshing the browser and exporting again

## License

This project is intended for internal operational use and is not configured with a public license file at this time.
