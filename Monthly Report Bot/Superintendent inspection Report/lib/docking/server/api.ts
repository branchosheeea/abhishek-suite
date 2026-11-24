// Digital Docking · Stage 1D (part): what the API routes do, as plain functions (tested without a server).
// Input from the browser is untrusted: every field is type- and length-checked here; the meaning (fleet vessel,
// dates, rights of change) is checked by the repository. Errors become 400 messages a Superintendent can act on.

import { AppError } from "../../server/errors"
import type { Store } from "./db"
import { readStored } from "./files"
import {
  addAnnotation, auditTrail, createDocking, type FleetVessel, createJob, dateOfDay, declareNoReport, DEPARTMENTS, type Department, DockingError,
  type DockingInput, DOCKING_TYPES, getDocking, jobTimeline, linkActivity, listAnnotations, listDays, listDockings, listJobs, markDayReviewed,
  unlinkActivity, updateDocking,
} from "./repo"

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const MAX_BODY_BYTES = 64 * 1024
const STATUSES = ["planned", "active", "completed", "cancelled"] as const

/** Run a repository call, turning its validation errors into 400 responses. */
export function call<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof DockingError) throw new AppError(400, error.message)
    throw error
  }
}

export function checkId(value: string, what = "docking"): string {
  if (!ID.test(value)) throw new AppError(404, `This ${what} does not exist.`)
  return value
}

export async function readBody(req: Request, max = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (text.length > max) throw new AppError(413, "The request is too large.")
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new AppError(400, "The request could not be read.")
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "The request could not be read.")
  return body as Record<string, unknown>
}

function text(body: Record<string, unknown>, key: string, label: string, max = 200, required = false): string | undefined {
  const value = body[key]
  if (value === undefined || value === null || value === "") {
    if (required) throw new AppError(400, `${label} is required.`)
    return value === "" ? "" : undefined
  }
  if (typeof value !== "string") throw new AppError(400, `${label} must be text.`)
  if (value.length > max) throw new AppError(400, `${label} is longer than ${max} characters.`)
  return value
}

function integer(body: Record<string, unknown>, key: string, label: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "number" || !Number.isInteger(value)) throw new AppError(400, `${label} must be a whole number.`)
  return value
}

function oneOf<T extends string>(body: Record<string, unknown>, key: string, label: string, allowed: readonly T[], required = false): T | undefined {
  const value = text(body, key, label, 40, required)
  if (value === undefined || value === "") return undefined
  if (!(allowed as readonly string[]).includes(value)) throw new AppError(400, `${label} must be one of: ${allowed.join(", ")}.`)
  return value as T
}

function dockingFields(body: Record<string, unknown>, required: boolean): Partial<DockingInput> {
  const out: Partial<DockingInput> = {
    code: text(body, "code", "Docking code", 24, required),
    vesselName: text(body, "vesselName", "Vessel", 60, required),
    yard: text(body, "yard", "Yard", 120, required),
    location: text(body, "location", "Location", 120),
    dockingType: oneOf(body, "dockingType", "Docking type", DOCKING_TYPES, required),
    utcOffsetMinutes: integer(body, "utcOffsetMinutes", "UTC offset"),
    day0Date: text(body, "day0Date", "Day 0", 10, required),
    arrivalTime: text(body, "arrivalTime", "Arrival time", 5),
    plannedDepartureDate: text(body, "plannedDepartureDate", "Planned departure", 10),
    status: oneOf(body, "status", "Status", STATUSES),
  }
  if (out.arrivalTime === "") out.arrivalTime = null
  if (out.plannedDepartureDate === "") out.plannedDepartureDate = null
  if (required && out.utcOffsetMinutes === undefined) throw new AppError(400, "UTC offset is required.")
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Partial<DockingInput>
}

// ---------------------------------------------------------------- views

export function dockingsView(store: Store) {
  const stats = store.db.prepare(`SELECT d.docking_id AS id,
      SUM(d.state = 'received') AS received, SUM(d.state = 'reviewed') AS reviewed, SUM(d.state = 'no_report') AS no_report,
      MAX(CASE WHEN d.state IN ('received','reviewed') THEN d.day_no END) AS last_day
    FROM days d GROUP BY d.docking_id`).all() as { id: string; received: number; reviewed: number; no_report: number; last_day: number | null }[]
  const jobs = store.db.prepare("SELECT docking_id AS id, COUNT(*) AS n FROM jobs GROUP BY docking_id").all() as { id: string; n: number }[]
  const byId = new Map(stats.map((s) => [s.id, s]))
  const jobsById = new Map(jobs.map((j) => [j.id, Number(j.n)]))
  return listDockings(store).map((d) => {
    const s = byId.get(d.id)
    return { ...d, days_received: Number(s?.received ?? 0), days_reviewed: Number(s?.reviewed ?? 0), days_no_report: Number(s?.no_report ?? 0),
      last_reported_day: s?.last_day ?? null, jobs: jobsById.get(d.id) ?? 0 }
  })
}

export function dockingView(store: Store, id: string) {
  const docking = call(() => getDocking(store, checkId(id)))
  const files = store.db.prepare(`SELECT s.day_id, s.department, s.file_name, s.imported_at, s.received_via FROM submissions s
    WHERE s.docking_id = ? AND s.status = 'current'`).all(id) as { day_id: string; department: string; file_name: string; imported_at: string; received_via: string }[]
  // The daily report of each day: none, a draft, or issued (with whether the draft has changed since the last version).
  const reports = new Map((store.db.prepare(`SELECT r.day_id, r.content,
      (SELECT COUNT(*) FROM report_versions v WHERE v.day_id = r.day_id) AS versions,
      (SELECT v.content FROM report_versions v WHERE v.day_id = r.day_id ORDER BY v.version DESC LIMIT 1) AS last_content
    FROM daily_reports r WHERE r.docking_id = ?`).all(id) as { day_id: string; content: string; versions: number; last_content: string | null }[])
    .map((r) => [r.day_id, { versions: Number(r.versions), changed: r.last_content !== null && r.last_content !== r.content }]))
  const days = listDays(store, id).map((d) => ({
    ...d,
    files: files.filter((f) => f.day_id === d.id).map(({ department, file_name, imported_at, received_via }) => ({ department, file_name, imported_at, received_via })),
    report: d.id ? (reports.get(d.id) ?? null) : null,
  }))
  const linked = store.db.prepare(`SELECT l.job_id, COUNT(*) AS activities, MIN(d.day_no) AS first_day, MAX(d.day_no) AS last_day
    FROM job_links l JOIN activities a ON a.id = l.activity_id JOIN submissions s ON s.id = a.submission_id JOIN days d ON d.id = s.day_id
    WHERE a.docking_id = ? GROUP BY l.job_id`).all(id) as { job_id: string; activities: number; first_day: number; last_day: number }[]
  const byJob = new Map(linked.map((l) => [l.job_id, l]))
  const jobs = listJobs(store, id).map((j) => {
    const l = byJob.get(j.id)
    return { ...j, activities: Number(l?.activities ?? 0), first_day: l?.first_day ?? null, last_day: l?.last_day ?? null }
  })
  return { docking, days, jobs, notes: listAnnotations(store, id), people: peopleNames(store) }
}

export function jobView(store: Store, dockingId: string, jobId: string) {
  checkId(dockingId)
  const job = listJobs(store, dockingId).find((j) => j.id === checkId(jobId, "job"))
  if (!job) throw new AppError(404, "This job does not exist in this docking.")
  return { job, timeline: jobTimeline(store, job.id), notes: listAnnotations(store, dockingId).filter((n) => n.entity === "job" && n.entity_id === job.id) }
}

function dayNoFrom(text: string): number {
  if (!/^\d{1,3}$/.test(text)) throw new AppError(404, "This day does not exist.")
  return Number(text)
}

type ActivityRow = {
  id: string; submission_id: string; sheet: string; row_no: number; row_ref: string; area: string; performed_by: string; company: string
  location: string; work_text: string; findings: string; status: string; next_action: string; witnessed: string; raw: string; job_id: string | null
}
type PhotoRef = { id: string; slot: number; width: number | null; height: number | null; bytes: number }

/** One day as received: each department's current file, its entries in workbook order with their photos and job links, and the notes. */
export function dayView(store: Store, dockingId: string, dayNoText: string) {
  const dayNo = dayNoFrom(dayNoText)
  const docking = call(() => getDocking(store, checkId(dockingId)))
  const days = listDays(store, dockingId)
  const day = days.find((d) => d.day_no === dayNo)
  if (!day) throw new AppError(404, "This day does not exist.")
  type Sub = { id: string; department: string; sha256: string; file_name: string; imported_at: string; imported_by: string; received_via: string; template: string; validation: string }
  const submissions = day.id
    ? (store.db.prepare(`SELECT id, department, sha256, file_name, imported_at, imported_by, received_via, template, validation FROM submissions
        WHERE day_id = ? AND status = 'current'`).all(day.id) as Sub[])
    : []
  const ids = submissions.map((s) => s.id)
  const marks = ids.map(() => "?").join(",")
  const activities = ids.length
    ? (store.db.prepare(`SELECT a.id, a.submission_id, a.sheet, a.row_no, a.row_ref, a.area, a.performed_by, a.company, a.location, a.work_text, a.findings,
        a.status, a.next_action, a.witnessed, a.raw, l.job_id FROM activities a LEFT JOIN job_links l ON l.activity_id = a.id
        WHERE a.submission_id IN (${marks}) ORDER BY a.rowid`).all(...ids) as ActivityRow[])
    : []
  const photos = ids.length
    ? (store.db.prepare(`SELECT id, activity_id, slot, width, height, bytes FROM photos WHERE submission_id IN (${marks}) AND link_status = 'linked' ORDER BY slot`)
        .all(...ids) as (PhotoRef & { activity_id: string })[])
    : []
  const rejected = ids.length
    ? (store.db.prepare(`SELECT submission_id, sheet, cell, reason FROM photos WHERE submission_id IN (${marks}) AND link_status = 'rejected'`).all(...ids) as Record<string, string>[])
    : []
  const jobs = listJobs(store, dockingId)
  const jobById = new Map(jobs.map((j) => [j.id, j]))
  const photosBy = new Map<string, PhotoRef[]>()
  for (const p of photos) photosBy.set(p.activity_id, [...(photosBy.get(p.activity_id) ?? []), { id: p.id, slot: p.slot, width: p.width, height: p.height, bytes: p.bytes }])
  const activityIds = new Set(activities.map((a) => a.id))
  const departments = DEPARTMENTS.map((department) => {
    const sub = submissions.find((s) => s.department === department)
    const validation = sub ? (JSON.parse(sub.validation || "{}") as { warnings?: string[] }) : {}
    return {
      department,
      file: sub
        ? {
            file_name: sub.file_name, imported_at: sub.imported_at, imported_by: sub.imported_by, received_via: sub.received_via, template: sub.template,
            shared: submissions.some((o) => o.id !== sub.id && o.sha256 === sub.sha256), warnings: validation.warnings ?? [],
            rejected_photos: rejected.filter((r) => r.submission_id === sub.id).map(({ sheet, cell, reason }) => ({ sheet, cell, reason })),
          }
        : null,
      entries: activities.filter((a) => a.submission_id === sub?.id).map((a) => {
        const job = a.job_id ? jobById.get(a.job_id) : undefined
        const extra = JSON.parse(a.raw || "{}") as { noText?: boolean }
        return {
          id: a.id, sheet: a.sheet, row_no: a.row_no, row_ref: a.row_ref, area: a.area, performed_by: a.performed_by, company: a.company, location: a.location,
          work_text: a.work_text, findings: a.findings, status: a.status, next_action: a.next_action, witnessed: a.witnessed,
          no_text: Boolean(extra.noText) || !a.work_text.trim(),
          job: job ? { id: job.id, job_no: job.job_no, title: job.title } : null,
          photos: photosBy.get(a.id) ?? [],
        }
      }),
    }
  })
  const position = days.findIndex((d) => d.day_no === dayNo)
  return {
    docking: { id: docking.id, code: docking.code, vessel_name: docking.vessel_name, day0_date: docking.day0_date, status: docking.status },
    day: { id: day.id, day_no: day.day_no, report_date: day.report_date, state: day.state, no_report_reason: day.no_report_reason },
    previous: position > 0 ? days[position - 1].day_no : null,
    next: position >= 0 && position < days.length - 1 ? days[position + 1].day_no : null,
    departments,
    jobs: jobs.map((j) => ({ id: j.id, job_no: j.job_no, department: j.department, title: j.title, area: j.area })),
    notes: listAnnotations(store, dockingId).filter((n) => (n.entity === "day" && n.entity_id === day.id) || (n.entity === "activity" && activityIds.has(n.entity_id))),
    people: peopleNames(store),
  }
}

const IMAGE_TYPES: Record<string, string> = { jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" }

/** A stored photo of this docking, checked against its hash. */
export function photoFile(store: Store, dockingId: string, photoId: string): { data: Buffer; type: string } {
  checkId(dockingId)
  checkId(photoId, "photo")
  const row = store.db.prepare("SELECT stored_path, sha256, format FROM photos WHERE id = ? AND docking_id = ?").get(photoId, dockingId) as
    { stored_path: string | null; sha256: string; format: string | null } | undefined
  if (!row?.stored_path) throw new AppError(404, "This photo does not exist.")
  return { data: readStored(store, row.stored_path, row.sha256), type: IMAGE_TYPES[row.format ?? ""] ?? "application/octet-stream" }
}

/** Link a vessel entry to a job, remove the link (with a reason), or create a new job from the entry and link it. */
export function activityActionFrom(store: Store, dockingId: string, activityId: string, body: Record<string, unknown>, actor: string) {
  checkId(dockingId)
  checkId(activityId, "entry")
  const entry = store.db.prepare("SELECT a.docking_id, s.department FROM activities a JOIN submissions s ON s.id = a.submission_id WHERE a.id = ?").get(activityId) as
    { docking_id: string; department: Department } | undefined
  if (!entry || entry.docking_id !== dockingId) throw new AppError(404, "This entry does not exist in this docking.")
  const action = oneOf(body, "action", "Action", ["link", "unlink", "new_job"] as const, true)
  return call(() => {
    if (action === "link") linkActivity(store, activityId, checkId(text(body, "jobId", "Job", 36, true)!, "job"), actor)
    else if (action === "unlink") unlinkActivity(store, activityId, text(body, "reason", "Reason", 500, true)!, actor)
    else {
      const job = createJob(store, dockingId, { title: text(body, "title", "Job title", 200, true)!, department: entry.department, area: text(body, "area", "Area / system", 80) }, actor)
      linkActivity(store, activityId, job.id, actor)
    }
    const link = store.db.prepare("SELECT j.id, j.job_no, j.title FROM job_links l JOIN jobs j ON j.id = l.job_id WHERE l.activity_id = ?").get(activityId) as
      { id: string; job_no: string; title: string } | undefined
    return link ? { ...link } : null
  })
}

export function auditView(store: Store, dockingId: string) {
  call(() => getDocking(store, checkId(dockingId)))
  return auditTrail(store, dockingId)
}

/** Who is who: the name last seen for each sign-in id (records keep the id; screens show the name). */
export function peopleNames(store: Store): Record<string, string> {
  return Object.fromEntries((store.db.prepare("SELECT sub, name FROM people").all() as { sub: string; name: string }[]).map((p) => [p.sub, p.name]))
}

// ---------------------------------------------------------------- changes

export function createDockingFrom(store: Store, body: Record<string, unknown>, actor: string, fleet?: readonly FleetVessel[]) {
  return call(() => createDocking(store, dockingFields(body, true) as DockingInput, actor, fleet))
}

export function updateDockingFrom(store: Store, id: string, body: Record<string, unknown>, actor: string, fleet?: readonly FleetVessel[]) {
  const rev = integer(body, "rev", "Revision")
  if (rev === undefined) throw new AppError(400, "Reload the docking before changing it.")
  return call(() => updateDocking(store, checkId(id), dockingFields(body, false), rev, actor, fleet))
}

export function dayActionFrom(store: Store, id: string, dayNoText: string, body: Record<string, unknown>, actor: string) {
  const dayNo = dayNoFrom(dayNoText)
  const action = oneOf(body, "action", "Action", ["no_report", "reviewed"] as const, true)
  return call(() => {
    const docking = getDocking(store, checkId(id))
    if (action === "no_report") declareNoReport(store, id, dateOfDay(docking.day0_date, dayNo), text(body, "reason", "Reason", 500, true)!, actor)
    else markDayReviewed(store, id, dayNo, actor)
    return dockingView(store, id).days.find((d) => d.day_no === dayNo)
  })
}

export function createJobFrom(store: Store, dockingId: string, body: Record<string, unknown>, actor: string) {
  const department = oneOf(body, "department", "Department", DEPARTMENTS, true) as Department
  return call(() => createJob(store, checkId(dockingId), { title: text(body, "title", "Job title", 200, true)!, department, area: text(body, "area", "Area / system", 80) }, actor))
}

export function addNoteFrom(store: Store, dockingId: string, body: Record<string, unknown>, actor: string) {
  const entity = oneOf(body, "entity", "Note subject", ["day", "job", "activity", "photo", "submission"] as const, true)!
  const kind = oneOf(body, "kind", "Note type", ["comment", "query", "correction"] as const, true)!
  const entityId = checkId(text(body, "entityId", "Note subject", 36, true)!, entity)
  const supersedes = text(body, "supersedesId", "Replaced note", 36)
  const id = call(() => addAnnotation(store, {
    dockingId: checkId(dockingId), entity, entityId, kind, body: text(body, "body", "Note", 4000, true)!,
    supersedesId: supersedes ? checkId(supersedes, "note") : undefined,
  }, actor))
  return listAnnotations(store, dockingId).find((n) => n.id === id)
}
