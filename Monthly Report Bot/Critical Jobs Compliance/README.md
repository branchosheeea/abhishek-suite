# Critical Job Compliance (Neraveda workspace 05)

Builds and verifies the **Critical Job Plan population** for one vessel from the MariApps/PAL
Job Overview Report. Later stages will review the Job executions in a selected review period against it.

Open it from the Neraveda launcher (card 05), or run it directly from the suite root:

```
.venv\Scripts\python.exe "Critical Jobs Compliance"
```

## Current scope (stage 1)

1. Open MariApps using the proven Vessel Report Centre session (`vessel_report.downloader.ReportSession`:
   SSO sign-in, sign-in/401 detection, Edge-loss detection, idle waits, vessel box, menu retry).
2. Open **Maintenance › Reports › Job Overview** (opens in a new tab). Reload it before every run.
3. Select the vessel in the header and wait until the equipment tree belongs to that vessel.
4. Select **A - EQUIPMENT**. If you select the vessel root instead, the portal sends `equipId -1` and returns no rows.
5. Apply the confirmed filter set. Every dropdown is set explicitly, so a run never inherits an old selection:
   - Show Sublevel Equipment: ticked. Show Overdue: not ticked.
   - Risk Assessment Required = **YES**
   - Critical to Safety = **YES**
   - All other filters: Select All / ALL.
6. Click Show, then extract every row from the grid's data source.
7. Reconcile. All 17 checks must pass for the run to count as a **Verified** population.
8. Save the run to the shared `suite.sqlite3` (tables `cjc_runs` and `cjc_job_plans`), then show it in the window.
   You can export it to Excel.

This stage does not include START/END workflows, historical Job Order review, attachment downloads
or compliance decisions.

## Reconciliation checks

- **Selection:** the vessel box and tree root show the vessel, and the selected node is A - EQUIPMENT.
- **Filters:** the dropdowns and checkboxes read back as configured, and every grid read request
  observed on the network carried the expected filters and one positive equipment id.
- **Counts:** the "N records found" label, the grid total, the extracted rows, the rendered rows and
  the server's `totalCount` all agree.
- **Rows:** Job Plan ids are present and unique, all rows come from one vessel, and every row shows
  Risk Assessment = YES and Critical to Safety = YES.
- **Paging:** the final read was page 1 with a page size of at least N. See the next section.

If reconciliation fails, the rows are still saved as evidence, but the run is marked
**Reconciliation failed** and does not count as a population.

## Portal behaviour found by live testing (15-Nov-2026)

- **Unstable paging.** The grid loads 100 rows per request as you scroll, but the server's paging order is not stable.
  On DHT IMPALA (187 rows), page 2 repeated two rows from page 1 and silently omitted two others.
  To avoid this, the module reads the whole population in a single request: the page size is set to the
  total, and the filters and transport stay the same.
- **Stale grid.** If you change the vessel on a Job Overview tab you have already used, the grid can keep
  the old rows. Each run therefore starts from a reloaded tab.
- **"Critical to Safety = NO" is ignored by the server**, so it returns every row. The module never uses NO.
- **Dates.** The portal returns UTC timestamps (for example `2026-09-15 16:00 UTC`, which is 16-Sep-2026 locally).
  The module converts them to the local date the same way the grid does, and this was checked against the rendered grid.
- **Missing vessels.** Some catalogue vessels (for example DHT ORYX) are not in the portal vessel list.
  These runs end as "Vessel not found".

## Files

| File | Purpose |
|---|---|
| `__main__.py` | Entry point; puts the suite root on `sys.path` |
| `cjc/config.py` | Portal facts and the confirmed filter profile |
| `cjc/portal.py` | `JobOverviewSession`, which extends `ReportSession` |
| `cjc/models.py` | Job Plan normalisation, date conversion, reconciliation |
| `cjc/store.py` | `cjc_*` tables in the shared suite database |
| `cjc/worker.py` | Browser-owning worker thread, with pause and resume on sign-in or Edge loss |
| `cjc/ui.py` | CustomTkinter window |
| `tests/` | Unit tests (`.venv\Scripts\python.exe -m pytest "Critical Jobs Compliance\tests"`) |

## Runtime data

- Edge profile: `%LOCALAPPDATA%\AbhishekAutomationSuite\critical_jobs\edge_profile`. It is kept separate from
  the Vessel Report Centre profile, so both modules can run at the same time.
- Failure diagnostics: `...\critical_jobs\diagnostics`. These hold visible facts only, never cookies or page HTML.
- Excel exports: `Downloads\Critical Job Compliance`.
