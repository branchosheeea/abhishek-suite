# Running Hour Sheet — MERN application

This is the online MERN rewrite, kept alongside the existing Python offline app. The Python files and `dashboard_data.json` remain the migration source and fallback; this project does not edit or delete them.

## Requirements

- Node.js 20 or newer and npm
- MongoDB connection string for local development or an IT-approved shared environment

Copy `.env.example` to `.env`, set `MONGODB_URI`, and choose the resolver allowed by your network in `DNS_SERVERS`, then run:

```powershell
npm install
npm run dev
```

The React development server runs on port 5173 and proxies `/api` to Express on port 3000. The API reports a clear database-unavailable error if MongoDB is not configured or reachable; it does not silently use local or demo data.

## Safe source-data migration

The migration command validates and summarizes the current Python JSON dataset without connecting to MongoDB or changing any files:

```powershell
npm run migrate:dry-run -- --source ..\dashboard_data.json
```

To insert the dataset into MongoDB only after the target database and access have been approved, configure `MONGODB_URI` and explicitly pass `--apply`:

```powershell
npm run migrate:dry-run -- --source ..\dashboard_data.json --apply
```

The importer stores the validated source JSON intact, records its SHA-256, and is insert-only. Re-running with the same source hash reports that it is already present; a different dataset at the same vessel key is rejected rather than overwritten. Back up the approved target database before applying. This does not deploy the application or make it available to colleagues.

## Workflows

The MERN dashboard includes the main workflows from the offline dashboard:

- Overview charts and review summaries, month/year selection, utilization and exception queues, and machine source inspection.
- Monthly meter entry with carried-forward opening readings, engineer attribution, continuity notes, and revision-checked saves.
- Machinery register with equipment groups and deactivate/reactivate behavior that retains historical readings.
- CSV export, a month-specific print/PDF PMS attachment, downloadable backups, and validated backup restore. The API also retains a pre-change snapshot before a successful record update.
- Demo mode for exploring sample records without changing the vessel dataset.
- Annual workbook preview/import and historical report-folder upload. Historical reports are selected in the browser as `YYYY-MM` folders; only new, non-conflicting readings are added, and source provenance is retained.

The application is still a local/development deployment, not a publicly hosted sharing link. It has no authentication or authorization, and the API binds to localhost by default. **Do not expose it to the internet or use it for shared operational records until company access controls, database hosting, deployment, backup and recovery, and cutover have been approved and implemented.** Demo mode is safe for UI exploration; it is not an access-control boundary.

For local testing, migrate a sanitized copy of the Python dataset to an approved local MongoDB, start the app as described above, and share the app only through an IT-approved environment. A colleague opening the same hosted app will need network access and their own authorized account once authentication is added; a local development URL or downloaded HTML file is not a shareable multi-user deployment.
