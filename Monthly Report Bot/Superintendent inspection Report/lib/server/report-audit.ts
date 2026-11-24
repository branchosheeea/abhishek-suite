import "server-only"
import type { Db } from "mongodb"
import { currentUser } from "./auth"

// Who did what to an inspection report, kept in MongoDB `inspections.report_audit`. Records are only ever added.
//   approve            a save made the report approved (Fleet Manager name, date and signature)
//   withdraw-approval  the approval was withdrawn, with the reason; the approved version is in report_revisions
//   delete             a draft was deleted; it and its photos are kept in reports_deleted / photos_deleted
//   change-refused     a change to an approved report, or its deletion, was refused

export type ReportAction = "approve" | "withdraw-approval" | "delete" | "change-refused"

/** The signed-in person, for records: their NeraVeda id and name. */
export function actor() {
  const user = currentUser()
  return { sub: user?.sub ?? "", name: user?.name ?? "" }
}

/** Stamp written on each saved report: who saved it last, and when. */
export function savedBy() {
  return { ...actor(), at: new Date().toISOString() }
}

export async function recordReportEvent(db: Db, reportId: string, action: ReportAction, detail: Record<string, unknown> = {}) {
  const who = actor()
  await db.collection("report_audit").insertOne({ reportId, action, at: new Date().toISOString(), actor: who.sub, actorName: who.name, detail })
}
