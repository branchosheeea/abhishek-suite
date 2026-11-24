// Digital Docking · the summary the NeraVeda desktop Home page shows (audit P1-7). Read-only: what each docking has
// received so far, and the days whose daily report is still missing. Home fetches it while this server runs and
// caches it (suite_services/home_intelligence.py), as it does for Inspection Reports and Emissions Validation.

import type { Store } from "./db"
import { listDays, listDockings, listJobs } from "./repo"

export type DockingSummary = {
  id: string; code: string; vessel: string; status: string; day0: string; plannedDeparture: string | null
  /** Days from Day 0 up to today (the yard's local date), within the planned stay. */
  daysSoFar: number; received: number; reviewed: number; noReport: number
  /** Past days with no file and no "no report" reason: the vessel's report is missing. */
  missingDays: number[]
  latestReportDate: string | null; jobs: number
}

/** Today at the yard (the docking's own UTC offset). */
const localToday = (offsetMinutes: number, now: number) => new Date(now + offsetMinutes * 60_000).toISOString().slice(0, 10)

export function dockingsSummary(store: Store, now = Date.now()) {
  const dockings: DockingSummary[] = listDockings(store)
    .filter((d) => d.status !== "cancelled")
    .map((d) => {
      const today = localToday(d.utc_offset_minutes, now)
      const past = listDays(store, d.id).filter((day) => day.report_date <= today)
      const filed = past.filter((day) => day.state === "received" || day.state === "reviewed")
      return {
        id: d.id, code: d.code, vessel: d.vessel_name, status: d.status, day0: d.day0_date, plannedDeparture: d.planned_departure_date,
        daysSoFar: past.length,
        received: filed.length,
        reviewed: past.filter((day) => day.state === "reviewed").length,
        noReport: past.filter((day) => day.state === "no_report").length,
        // Today's report may still arrive, so only earlier days count as missing.
        missingDays: past.filter((day) => day.state === "expected" && day.report_date < today).map((day) => day.day_no),
        latestReportDate: filed.length ? filed[filed.length - 1].report_date : null,
        jobs: listJobs(store, d.id).length,
      }
    })
  return { app: "neraveda-docking", generatedAt: now, dockings }
}
