// Digital Docking · Stage 1B: the only code that writes docking records. Every change is audited with its actor;
// vessel records are never edited (a correction is a new submission that supersedes the old one, kept in full);
// everything is scoped to one docking, and the schema refuses cross-docking links.

import { randomUUID } from "node:crypto"
import { FLEET_VESSELS, vesselIdFor } from "../../vessels"
import { type Store, tx } from "./db"
import { putFile, sha256 } from "./files"

export class DockingError extends Error {
  readonly field?: string
  constructor(message: string, field?: string) {
    super(message)
    this.field = field
  }
}

export const DOCKING_TYPES = ["Special survey", "Intermediate survey", "Other"] as const
export const DEPARTMENTS = ["deck", "engine"] as const
export type Department = (typeof DEPARTMENTS)[number]
export const RECEIVED_VIA = ["email", "teams", "other"] as const

const now = () => new Date().toISOString()
const json = (v: unknown) => JSON.stringify(v ?? null)
type Row = Record<string, unknown>

function audit(store: Store, actor: string, action: string, entity: string, entityId: string, dockingId: string | null, before: unknown, after: unknown) {
  store.db.prepare("INSERT INTO audit(at, actor, action, entity, entity_id, docking_id, before, after) VALUES(?,?,?,?,?,?,?,?)")
    .run(now(), actor, action, entity, entityId, dockingId, before === undefined ? null : json(before), after === undefined ? null : json(after))
}

function requireActor(actor: string) {
  if (!actor?.trim()) throw new DockingError("Every change needs the signed-in person.")
}

// ---------------------------------------------------------------- dates and day numbers

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

/** D7: Day 0 is the arrival date at the yard (local); Day N is N calendar days later. */
export function dayNumber(day0Date: string, reportDate: string): number {
  if (!isDate(day0Date) || !isDate(reportDate)) throw new DockingError("Dates must be written as YYYY-MM-DD.", "reportDate")
  const n = Math.round((Date.parse(`${reportDate}T00:00:00Z`) - Date.parse(`${day0Date}T00:00:00Z`)) / 86_400_000)
  if (n < 0) throw new DockingError(`${reportDate} is before Day 0 (${day0Date}) of this docking.`, "reportDate")
  return n
}

export function dateOfDay(day0Date: string, dayNo: number): string {
  return new Date(Date.parse(`${day0Date}T00:00:00Z`) + dayNo * 86_400_000).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------- dockings

export type DockingInput = {
  code: string
  vesselName: string
  yard: string
  location?: string
  dockingType: string
  utcOffsetMinutes: number
  day0Date: string
  arrivalTime?: string | null
  plannedDepartureDate?: string | null
  status?: "planned" | "active" | "completed" | "cancelled"
}

export type Docking = {
  id: string; code: string; vessel_id: string; vessel_name: string; yard: string; location: string; docking_type: string
  utc_offset_minutes: number; day0_date: string; arrival_time: string | null; planned_departure_date: string | null
  status: string; created_by: string; created_at: string; updated_at: string; rev: number
}

function validateDocking(input: DockingInput) {
  if (!/^[A-Z0-9][A-Z0-9-]{2,23}$/i.test(input.code ?? "")) throw new DockingError("Docking code: 3–24 letters, digits or hyphens, e.g. LEO-2025-SS2.", "code")
  const vessel = FLEET_VESSELS.find((v) => v.toLowerCase() === (input.vesselName ?? "").trim().toLowerCase())
  if (!vessel) throw new DockingError(`${input.vesselName || "The vessel"} is not in the fleet list.`, "vesselName")
  if (!input.yard?.trim()) throw new DockingError("Enter the yard.", "yard")
  if (!(DOCKING_TYPES as readonly string[]).includes(input.dockingType)) throw new DockingError(`Docking type must be one of: ${DOCKING_TYPES.join(", ")}.`, "dockingType")
  if (!Number.isInteger(input.utcOffsetMinutes) || input.utcOffsetMinutes < -720 || input.utcOffsetMinutes > 840 || input.utcOffsetMinutes % 15 !== 0) {
    throw new DockingError("UTC offset must be whole quarter-hours between −12:00 and +14:00.", "utcOffsetMinutes")
  }
  if (!isDate(input.day0Date)) throw new DockingError("Day 0 (arrival date at the yard) must be YYYY-MM-DD.", "day0Date")
  if (input.arrivalTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.arrivalTime)) throw new DockingError("Arrival time must be HH:MM (local).", "arrivalTime")
  if (input.plannedDepartureDate && (!isDate(input.plannedDepartureDate) || input.plannedDepartureDate < input.day0Date)) {
    throw new DockingError("Planned departure must be a date on or after Day 0.", "plannedDepartureDate")
  }
  return vessel
}

export function createDocking(store: Store, input: DockingInput, actor: string): Docking {
  requireActor(actor)
  const vessel = validateDocking(input)
  return tx(store.db, () => {
    if (store.db.prepare("SELECT 1 FROM dockings WHERE code = ?").get(input.code)) throw new DockingError(`A docking with code ${input.code} already exists.`, "code")
    const id = randomUUID()
    const stamp = now()
    store.db.prepare(`INSERT INTO dockings(id, code, vessel_id, vessel_name, yard, location, docking_type, utc_offset_minutes, day0_date,
      arrival_time, planned_departure_date, status, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.code.toUpperCase(), vesselIdFor(vessel), vessel, input.yard.trim(), (input.location ?? "").trim(), input.dockingType,
        input.utcOffsetMinutes, input.day0Date, input.arrivalTime ?? null, input.plannedDepartureDate ?? null, input.status ?? "planned", actor, stamp, stamp)
    const created = getDocking(store, id)
    audit(store, actor, "docking.create", "docking", id, id, undefined, created)
    return created
  })
}

export function getDocking(store: Store, id: string): Docking {
  const row = store.db.prepare("SELECT * FROM dockings WHERE id = ?").get(id) as Docking | undefined
  if (!row) throw new DockingError("This docking does not exist.")
  return { ...row }
}

export function listDockings(store: Store): Docking[] {
  return (store.db.prepare("SELECT * FROM dockings ORDER BY day0_date DESC, code").all() as Docking[]).map((r) => ({ ...r }))
}

/** Change docking details. Vessel, code and Day 0 are fixed once a file has been imported (they number the days). */
export function updateDocking(store: Store, id: string, changes: Partial<DockingInput>, expectedRev: number, actor: string): Docking {
  requireActor(actor)
  return tx(store.db, () => {
    const before = getDocking(store, id)
    if (before.rev !== expectedRev) throw new DockingError("Someone else changed this docking. Reload and try again.")
    const merged: DockingInput = {
      code: changes.code ?? before.code, vesselName: changes.vesselName ?? before.vessel_name, yard: changes.yard ?? before.yard,
      location: changes.location ?? before.location, dockingType: changes.dockingType ?? before.docking_type,
      utcOffsetMinutes: changes.utcOffsetMinutes ?? before.utc_offset_minutes, day0Date: changes.day0Date ?? before.day0_date,
      arrivalTime: changes.arrivalTime !== undefined ? changes.arrivalTime : before.arrival_time,
      plannedDepartureDate: changes.plannedDepartureDate !== undefined ? changes.plannedDepartureDate : before.planned_departure_date,
      status: (changes.status ?? before.status) as DockingInput["status"],
    }
    const vessel = validateDocking(merged)
    const fixedChanged = merged.code.toUpperCase() !== before.code || vessel !== before.vessel_name || merged.day0Date !== before.day0_date
    if (fixedChanged && store.db.prepare("SELECT 1 FROM submissions WHERE docking_id = ?").get(id)) {
      throw new DockingError("Vessel, code and Day 0 cannot change after daily files have been imported.")
    }
    if (merged.code.toUpperCase() !== before.code && store.db.prepare("SELECT 1 FROM dockings WHERE code = ? AND id <> ?").get(merged.code, id)) {
      throw new DockingError(`A docking with code ${merged.code} already exists.`, "code")
    }
    if (!["planned", "active", "completed", "cancelled"].includes(merged.status ?? "")) throw new DockingError("Unknown docking status.", "status")
    store.db.prepare(`UPDATE dockings SET code=?, vessel_id=?, vessel_name=?, yard=?, location=?, docking_type=?, utc_offset_minutes=?,
      day0_date=?, arrival_time=?, planned_departure_date=?, status=?, updated_at=?, rev=rev+1 WHERE id=? AND rev=?`)
      .run(merged.code.toUpperCase(), vesselIdFor(vessel), vessel, merged.yard.trim(), (merged.location ?? "").trim(), merged.dockingType,
        merged.utcOffsetMinutes, merged.day0Date, merged.arrivalTime ?? null, merged.plannedDepartureDate ?? null, merged.status!, now(), id, expectedRev)
    const after = getDocking(store, id)
    audit(store, actor, "docking.update", "docking", id, id, before, after)
    return after
  })
}

// ---------------------------------------------------------------- days

export type Day = { id: string | null; docking_id: string; day_no: number; report_date: string; state: string; no_report_reason: string | null }

function ensureDay(store: Store, docking: Docking, reportDate: string): Day {
  const dayNo = dayNumber(docking.day0_date, reportDate)
  const existing = store.db.prepare("SELECT * FROM days WHERE docking_id = ? AND day_no = ?").get(docking.id, dayNo) as Day | undefined
  if (existing) return { ...existing }
  const id = randomUUID()
  store.db.prepare("INSERT INTO days(id, docking_id, day_no, report_date, state, updated_at) VALUES(?,?,?,?,?,?)").run(id, docking.id, dayNo, reportDate, "expected", now())
  return { id, docking_id: docking.id, day_no: dayNo, report_date: reportDate, state: "expected", no_report_reason: null }
}

/** Every day from Day 0 to the later of the last stored day and `until` (default: planned departure, else Day 0). */
export function listDays(store: Store, dockingId: string, until?: string): Day[] {
  const docking = getDocking(store, dockingId)
  const stored = new Map((store.db.prepare("SELECT * FROM days WHERE docking_id = ? ORDER BY day_no").all(dockingId) as Day[]).map((d) => [d.day_no, { ...d }]))
  const lastStored = Math.max(-1, ...stored.keys())
  const end = until ?? docking.planned_departure_date ?? docking.day0_date
  const lastPlanned = dayNumber(docking.day0_date, end < docking.day0_date ? docking.day0_date : end)
  return Array.from({ length: Math.max(lastStored, lastPlanned) + 1 }, (_, n) =>
    stored.get(n) ?? { id: null, docking_id: dockingId, day_no: n, report_date: dateOfDay(docking.day0_date, n), state: "expected", no_report_reason: null })
}

/** The Superintendent declares that a day has no report, with a reason. Never allowed over a received file. */
export function declareNoReport(store: Store, dockingId: string, reportDate: string, reason: string, actor: string): Day {
  requireActor(actor)
  if (!reason?.trim()) throw new DockingError("Give the reason there is no report for this day.", "reason")
  return tx(store.db, () => {
    const day = ensureDay(store, getDocking(store, dockingId), reportDate)
    if (store.db.prepare("SELECT 1 FROM submissions WHERE day_id = ? AND status = 'current'").get(day.id)) {
      throw new DockingError(`Day ${day.day_no} already has a report file; it cannot be marked as "no report".`)
    }
    store.db.prepare("UPDATE days SET state='no_report', no_report_reason=?, updated_at=? WHERE id=?").run(reason.trim(), now(), day.id)
    audit(store, actor, "day.no_report", "day", day.id!, dockingId, { state: day.state }, { state: "no_report", reason: reason.trim() })
    return { ...day, state: "no_report", no_report_reason: reason.trim() }
  })
}

export function markDayReviewed(store: Store, dockingId: string, dayNo: number, actor: string): void {
  requireActor(actor)
  tx(store.db, () => {
    const day = store.db.prepare("SELECT * FROM days WHERE docking_id = ? AND day_no = ?").get(dockingId, dayNo) as Day | undefined
    if (!day || day.state !== "received") throw new DockingError(`Day ${dayNo} has no received report to mark as reviewed.`)
    store.db.prepare("UPDATE days SET state='reviewed', updated_at=? WHERE id=?").run(now(), day.id)
    audit(store, actor, "day.reviewed", "day", day.id!, dockingId, { state: "received" }, { state: "reviewed" })
  })
}

// ---------------------------------------------------------------- submissions (imported daily files)

export type ActivityInput = {
  sheet: string; rowNo: number; rowRef: string; workText: string
  area?: string; performedBy?: string; company?: string; location?: string; findings?: string; status?: string
  nextAction?: string; witnessed?: string; readingRef?: string; photoNotes?: string; continuesRef?: string; raw?: unknown
}

export type PhotoInput = {
  sheet: string; rowNo: number; cell: string; slot: number | null; method: string; anchor: string; mediaPart: string
  data: Buffer | null; extension: string; width: number | null; height: number | null; format: string | null
  status: "linked" | "rejected"; reason: string
}

export type SubmissionInput = {
  dockingId: string; reportDate: string; department: Department
  file: { data: Buffer; name: string }
  template: string; templateVersion: number; receivedVia: (typeof RECEIVED_VIA)[number]
  activities: ActivityInput[]; photos: PhotoInput[]
  correctionReason?: string; validation?: unknown
  /** The vessel's own workbook holds both departments: the same file is the source of that day's Deck and Engine records. */
  combined?: boolean
  /** The day was reviewed when this import began: a combined file is imported one department after the other, and the
   *  first one already puts the day back to "received"; the second is still an amendment of a reviewed day. */
  reviewedBefore?: boolean
}

export type ImportResult = {
  outcome: "accepted" | "duplicate"
  kind: "initial" | "revision" | "amendment" | "duplicate"
  submissionId: string; dayNo: number; supersededId: string | null
  /** Replacing a file: job links moved to the same, unchanged row of the new file, and links left on the replaced file. */
  linksCarried?: number; linksToReview?: number
}

function recordAttempt(store: Store, a: { dockingId: string | null; sha: string | null; name: string; actor: string; outcome: string; messages: string[]; submissionId?: string | null }) {
  store.db.prepare("INSERT INTO import_attempts(id, docking_id, sha256, file_name, attempted_at, actor, outcome, messages, submission_id) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(randomUUID(), a.dockingId, a.sha, a.name, now(), a.actor, a.outcome, json(a.messages), a.submissionId ?? null)
}

/**
 * Store one department's daily file for one day. Distinguishes an initial file, an exact duplicate (nothing stored),
 * a revision before review, and an amendment of a reviewed day (needs a reason; the day goes back to "received").
 * Files are written first (content-addressed), records in one transaction. Every attempt is recorded, also a failed one.
 */
export function importSubmission(store: Store, input: SubmissionInput, actor: string): ImportResult {
  requireActor(actor)
  const sha = sha256(input.file.data)
  const name = input.file.name || "workbook.xlsx"
  try {
    if (!(DEPARTMENTS as readonly string[]).includes(input.department)) throw new DockingError("Department must be deck or engine.", "department")
    if (!(RECEIVED_VIA as readonly string[]).includes(input.receivedVia)) throw new DockingError("Unknown way of receiving the file.", "receivedVia")
    const docking = getDocking(store, input.dockingId)
    const dayNo = dayNumber(docking.day0_date, input.reportDate)
    const rows = new Set<string>()
    for (const a of input.activities) {
      const key = `${a.sheet}|${a.rowNo}`
      if (rows.has(key)) throw new DockingError(`${a.sheet} row ${a.rowNo} appears twice.`)
      rows.add(key)
    }
    for (const p of input.photos) {
      if (p.status === "linked" && (!rows.has(`${p.sheet}|${p.rowNo}`) || p.slot === null)) throw new DockingError(`A photo is linked to ${p.sheet} row ${p.rowNo}, which has no activity.`)
    }

    const elsewhere = store.db.prepare(`SELECT s.docking_id, s.department, d.day_no FROM submissions s JOIN days d ON d.id = s.day_id
      WHERE s.sha256 = ? AND NOT (s.docking_id = ? AND d.day_no = ? AND (s.department = ? OR ?)) LIMIT 1`).get(sha, docking.id, dayNo, input.department, input.combined ? 1 : 0) as Row | undefined
    if (elsewhere) throw new DockingError(`This exact file was already imported as the ${elsewhere.department} report for Day ${elsewhere.day_no}${elsewhere.docking_id === docking.id ? "" : " of another docking"}.`)

    const original = putFile(store, "originals", input.file.data, "xlsx")
    const photoFiles = input.photos.map((p) => (p.data ? putFile(store, "photos", p.data, p.extension) : null))

    return tx(store.db, () => {
      const day = ensureDay(store, docking, input.reportDate)
      const current = store.db.prepare("SELECT * FROM submissions WHERE day_id = ? AND department = ? AND status = 'current'").get(day.id, input.department) as Row | undefined
      if (current && current.sha256 === sha) {
        recordAttempt(store, { dockingId: docking.id, sha, name, actor, outcome: "duplicate", messages: ["Exact duplicate of the current file; nothing was changed."], submissionId: String(current.id) })
        return { outcome: "duplicate", kind: "duplicate", submissionId: String(current.id), dayNo, supersededId: null } as ImportResult
      }
      const kind: ImportResult["kind"] = !current ? "initial" : day.state === "reviewed" || input.reviewedBefore ? "amendment" : "revision"
      if (kind === "amendment" && !input.correctionReason?.trim()) {
        throw new DockingError(`Day ${dayNo} has been reviewed. Give the reason for replacing its ${input.department} file.`, "correctionReason")
      }
      if (!store.db.prepare("SELECT 1 FROM source_files WHERE sha256 = ?").get(sha)) {
        store.db.prepare("INSERT INTO source_files(sha256, bytes, stored_path, first_name, first_seen_at) VALUES(?,?,?,?,?)").run(sha, input.file.data.length, original.path, name, now())
      }
      if (current) store.db.prepare("UPDATE submissions SET status = 'superseded' WHERE id = ?").run(String(current.id))
      const submissionId = randomUUID()
      const reason = input.correctionReason?.trim() || (kind === "revision" ? "Revised file received before review." : null)
      store.db.prepare(`INSERT INTO submissions(id, docking_id, day_id, department, sha256, file_name, template, template_version, received_via,
        imported_by, imported_at, status, supersedes_id, correction_reason, validation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(submissionId, docking.id, day.id, input.department, sha, name, input.template, input.templateVersion, input.receivedVia,
          actor, now(), "current", current ? String(current.id) : null, reason, json(input.validation ?? {}))

      const activityIds = new Map<string, string>()
      const insertActivity = store.db.prepare(`INSERT INTO activities(id, submission_id, docking_id, sheet, row_no, row_ref, area, performed_by, company,
        location, work_text, findings, status, next_action, witnessed, reading_ref, photo_notes, continues_ref, raw) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      for (const a of input.activities) {
        const id = randomUUID()
        activityIds.set(`${a.sheet}|${a.rowNo}`, id)
        insertActivity.run(id, submissionId, docking.id, a.sheet, a.rowNo, a.rowRef, a.area ?? "", a.performedBy ?? "", a.company ?? "", a.location ?? "",
          a.workText, a.findings ?? "", a.status ?? "", a.nextAction ?? "", a.witnessed ?? "", a.readingRef ?? "", a.photoNotes ?? "", a.continuesRef ?? "", json(a.raw ?? {}))
      }
      const insertPhoto = store.db.prepare(`INSERT INTO photos(id, submission_id, docking_id, activity_id, sheet, row_no, cell, slot, method, anchor, media_part,
        sha256, bytes, width, height, format, stored_path, link_status, reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      input.photos.forEach((p, i) => {
        const file = photoFiles[i]
        const linked = p.status === "linked"
        insertPhoto.run(randomUUID(), submissionId, docking.id, linked ? activityIds.get(`${p.sheet}|${p.rowNo}`)! : null, p.sheet, p.rowNo, p.cell,
          linked ? p.slot : null, p.method, p.anchor, p.mediaPart, file?.sha256 ?? "", p.data?.length ?? 0, p.width, p.height, p.format,
          file?.path ?? null, p.status, p.reason)
      })
      // Job links follow a replaced file (audit P1-6). A link moves to the new file only when it has the same row (sheet
      // and row reference) with exactly the same text, found once; both moves are in the link history. Any other link
      // stays on the replaced row, which the job view marks "replaced file", for the Superintendent to link the new row.
      let linksCarried = 0
      let linksToReview = 0
      if (current) {
        const sameRow = new Map<string, string[]>()
        for (const a of input.activities) {
          const key = `${a.sheet}|${a.rowRef}|${a.workText}`
          sameRow.set(key, [...(sameRow.get(key) ?? []), activityIds.get(`${a.sheet}|${a.rowNo}`)!])
        }
        const linked = store.db.prepare(`SELECT a.id, a.sheet, a.row_ref, a.work_text, l.job_id FROM job_links l
          JOIN activities a ON a.id = l.activity_id WHERE a.submission_id = ? ORDER BY a.sheet, a.row_no`).all(String(current.id)) as Row[]
        const at = now()
        const history = store.db.prepare("INSERT INTO job_links_history(activity_id, job_id, action, actor, at, reason) VALUES(?,?,?,?,?,?)")
        for (const old of linked) {
          const matches = sameRow.get(`${old.sheet}|${old.row_ref}|${old.work_text}`) ?? []
          if (matches.length !== 1 || store.db.prepare("SELECT 1 FROM job_links WHERE activity_id = ?").get(matches[0])) {
            linksToReview++
            continue
          }
          const why = "The day's file was replaced; the same row with the same text is in the new file."
          store.db.prepare("DELETE FROM job_links WHERE activity_id = ?").run(String(old.id))
          history.run(String(old.id), String(old.job_id), "unlink", actor, at, `${why} Link moved to the new row.`)
          store.db.prepare("INSERT INTO job_links(activity_id, job_id, linked_by, linked_at) VALUES(?,?,?,?)").run(matches[0], String(old.job_id), actor, at)
          history.run(matches[0], String(old.job_id), "link", actor, at, why)
          linksCarried++
        }
      }

      const newState = "received"
      if (day.state !== newState) store.db.prepare("UPDATE days SET state = ?, no_report_reason = NULL, updated_at = ? WHERE id = ?").run(newState, now(), day.id)
      const linkedPhotos = input.photos.filter((p) => p.status === "linked").length
      audit(store, actor, `submission.${kind}`, "submission", submissionId, docking.id, current ? { submission: current.id, day_state: day.state } : undefined,
        { day: dayNo, department: input.department, file: name, sha256: sha, activities: input.activities.length, photos_linked: linkedPhotos,
          photos_rejected: input.photos.length - linkedPhotos, reason, ...(current ? { links_carried: linksCarried, links_to_review: linksToReview } : {}) })
      recordAttempt(store, { dockingId: docking.id, sha, name, actor, outcome: "accepted", messages: [`${kind}: Day ${dayNo} ${input.department}`], submissionId })
      return {
        outcome: "accepted", kind, submissionId, dayNo, supersededId: current ? String(current.id) : null,
        ...(current ? { linksCarried, linksToReview } : {}),
      } as ImportResult
    })
  } catch (error) {
    // The import rolled back, but the attempt is kept (separate transaction).
    try {
      tx(store.db, () => recordAttempt(store, { dockingId: store.db.prepare("SELECT 1 FROM dockings WHERE id = ?").get(input.dockingId) ? input.dockingId : null, sha, name, actor, outcome: "rejected", messages: [(error as Error).message] }))
    } catch {
      // never hide the original error
    }
    throw error
  }
}

export function importAttempts(store: Store, dockingId: string): Row[] {
  return (store.db.prepare("SELECT * FROM import_attempts WHERE docking_id = ? ORDER BY attempted_at, rowid").all(dockingId) as Row[]).map((r) => ({ ...r, messages: JSON.parse(String(r.messages)) }))
}

// ---------------------------------------------------------------- jobs (created by the Superintendent, D5)

export type Job = { id: string; docking_id: string; job_no: string; department: Department; seq: number; title: string; area: string; created_by: string; created_at: string }

export function createJob(store: Store, dockingId: string, input: { title: string; department: Department; area?: string }, actor: string): Job {
  requireActor(actor)
  if (!input.title?.trim()) throw new DockingError("Give the job a title.", "title")
  if (!(DEPARTMENTS as readonly string[]).includes(input.department)) throw new DockingError("Department must be deck or engine.", "department")
  return tx(store.db, () => {
    const docking = getDocking(store, dockingId)
    const seq = Number((store.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM jobs WHERE docking_id = ? AND department = ?").get(dockingId, input.department) as { n: number }).n)
    const jobNo = `${docking.code}-${input.department === "deck" ? "D" : "E"}-${String(seq).padStart(3, "0")}`
    const id = randomUUID()
    store.db.prepare("INSERT INTO jobs(id, docking_id, job_no, department, seq, title, area, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, dockingId, jobNo, input.department, seq, input.title.trim(), (input.area ?? "").trim(), actor, now())
    const job = { ...(store.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job) }
    audit(store, actor, "job.create", "job", id, dockingId, undefined, job)
    return job
  })
}

export function listJobs(store: Store, dockingId: string): Job[] {
  return (store.db.prepare("SELECT * FROM jobs WHERE docking_id = ? ORDER BY department, seq").all(dockingId) as Job[]).map((j) => ({ ...j }))
}

/** Link an activity row to a job (replacing an earlier link, which stays in the history). Only current rows can be linked. */
export function linkActivity(store: Store, activityId: string, jobId: string, actor: string): void {
  requireActor(actor)
  tx(store.db, () => {
    const activity = store.db.prepare(`SELECT a.docking_id, s.status FROM activities a JOIN submissions s ON s.id = a.submission_id WHERE a.id = ?`).get(activityId) as Row | undefined
    if (!activity) throw new DockingError("This activity does not exist.")
    if (activity.status !== "current") throw new DockingError("This activity is from a replaced file. Link the row in the current file instead.")
    const job = store.db.prepare("SELECT docking_id FROM jobs WHERE id = ?").get(jobId) as Row | undefined
    if (!job) throw new DockingError("This job does not exist.")
    if (job.docking_id !== activity.docking_id) throw new DockingError("An activity can only be linked to a job of the same docking.")
    const existing = store.db.prepare("SELECT job_id FROM job_links WHERE activity_id = ?").get(activityId) as Row | undefined
    if (existing?.job_id === jobId) return
    const at = now()
    if (existing) {
      store.db.prepare("DELETE FROM job_links WHERE activity_id = ?").run(activityId)
      store.db.prepare("INSERT INTO job_links_history(activity_id, job_id, action, actor, at, reason) VALUES(?,?,?,?,?,?)").run(activityId, String(existing.job_id), "unlink", actor, at, "linked to another job")
    }
    store.db.prepare("INSERT INTO job_links(activity_id, job_id, linked_by, linked_at) VALUES(?,?,?,?)").run(activityId, jobId, actor, at)
    store.db.prepare("INSERT INTO job_links_history(activity_id, job_id, action, actor, at) VALUES(?,?,?,?,?)").run(activityId, jobId, "link", actor, at)
    audit(store, actor, "activity.link", "activity", activityId, String(activity.docking_id), existing ? { job: existing.job_id } : undefined, { job: jobId })
  })
}

export function unlinkActivity(store: Store, activityId: string, reason: string, actor: string): void {
  requireActor(actor)
  if (!reason?.trim()) throw new DockingError("Give the reason for removing the link.", "reason")
  tx(store.db, () => {
    const link = store.db.prepare("SELECT l.job_id, a.docking_id FROM job_links l JOIN activities a ON a.id = l.activity_id WHERE l.activity_id = ?").get(activityId) as Row | undefined
    if (!link) throw new DockingError("This activity is not linked to a job.")
    store.db.prepare("DELETE FROM job_links WHERE activity_id = ?").run(activityId)
    store.db.prepare("INSERT INTO job_links_history(activity_id, job_id, action, actor, at, reason) VALUES(?,?,?,?,?,?)").run(activityId, String(link.job_id), "unlink", actor, now(), reason.trim())
    audit(store, actor, "activity.unlink", "activity", activityId, String(link.docking_id), { job: link.job_id }, { reason: reason.trim() })
  })
}

/** A job's chronology: every linked activity in day order, with the vessel's own text and its linked photos. */
export function jobTimeline(store: Store, jobId: string): (Row & { photos: Row[] })[] {
  const activities = store.db.prepare(`SELECT a.*, d.day_no, d.report_date, s.department, s.status AS submission_status
    FROM job_links l JOIN activities a ON a.id = l.activity_id JOIN submissions s ON s.id = a.submission_id JOIN days d ON d.id = s.day_id
    WHERE l.job_id = ? ORDER BY d.day_no, a.sheet, a.row_no`).all(jobId) as Row[]
  const photos = store.db.prepare("SELECT * FROM photos WHERE activity_id = ? AND link_status = 'linked' ORDER BY slot")
  return activities.map((a) => ({ ...a, photos: (photos.all(String(a.id)) as Row[]).map((p) => ({ ...p })) }))
}

// ---------------------------------------------------------------- Superintendent annotations (D8)

const ANNOTATED: Record<string, string> = { activity: "activities", photo: "photos", day: "days", job: "jobs", submission: "submissions" }

export function addAnnotation(store: Store, input: { dockingId: string; entity: string; entityId: string; kind: "comment" | "query" | "correction"; body: string; supersedesId?: string }, actor: string) {
  requireActor(actor)
  if (!input.body?.trim()) throw new DockingError("The note is empty.", "body")
  const table = ANNOTATED[input.entity]
  if (!table) throw new DockingError("Notes can be added to activities, photos, days, jobs and submissions.", "entity")
  return tx(store.db, () => {
    const target = store.db.prepare(`SELECT docking_id FROM ${table} WHERE id = ?`).get(input.entityId) as Row | undefined
    if (!target || target.docking_id !== input.dockingId) throw new DockingError("The note's subject is not part of this docking.")
    if (input.supersedesId) {
      const prior = store.db.prepare("SELECT entity_id FROM annotations WHERE id = ?").get(input.supersedesId) as Row | undefined
      if (!prior || prior.entity_id !== input.entityId) throw new DockingError("A note can only replace an earlier note on the same item.")
    }
    const id = randomUUID()
    store.db.prepare("INSERT INTO annotations(id, docking_id, entity, entity_id, kind, body, author, created_at, supersedes_id) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, input.dockingId, input.entity, input.entityId, input.kind, input.body.trim(), actor, now(), input.supersedesId ?? null)
    audit(store, actor, `annotation.${input.kind}`, input.entity, input.entityId, input.dockingId, undefined, { annotation: id })
    return id
  })
}

export type Note = { id: string; docking_id: string; entity: string; entity_id: string; kind: string; body: string; author: string; created_at: string; supersedes_id: string | null; replaced: boolean }

/** Every note of a docking, oldest first; a note that a later note replaced is marked `replaced` (both are kept). */
export function listAnnotations(store: Store, dockingId: string): Note[] {
  return (store.db.prepare(`SELECT n.*, EXISTS(SELECT 1 FROM annotations r WHERE r.supersedes_id = n.id) AS replaced
    FROM annotations n WHERE n.docking_id = ? ORDER BY n.created_at, n.rowid`).all(dockingId) as Row[]).map((r) => ({ ...r, replaced: Boolean(r.replaced) }) as Note)
}

export function auditTrail(store: Store, dockingId: string): Row[] {
  return (store.db.prepare("SELECT * FROM audit WHERE docking_id = ? ORDER BY id").all(dockingId) as Row[]).map((r) => ({
    ...r, before: r.before === null ? null : JSON.parse(String(r.before)), after: r.after === null ? null : JSON.parse(String(r.after)),
  }))
}
