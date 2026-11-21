// Digital Docking · Stage 1D (part): what the API routes do, as plain functions (tested without a server).
// Input from the browser is untrusted: every field is type- and length-checked here; the meaning (fleet vessel,
// dates, rights of change) is checked by the repository. Errors become 400 messages a Superintendent can act on.

import { AppError } from "../../server/errors"
import type { Store } from "./db"
import {
  addAnnotation, auditTrail, createDocking, createJob, dateOfDay, declareNoReport, DEPARTMENTS, type Department, DockingError,
  type DockingInput, DOCKING_TYPES, getDocking, jobTimeline, listAnnotations, listDays, listDockings, listJobs, markDayReviewed,
  updateDocking,
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

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text()
  if (text.length > MAX_BODY_BYTES) throw new AppError(413, "The request is too large.")
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
  const days = listDays(store, id).map((d) => ({
    ...d,
    files: files.filter((f) => f.day_id === d.id).map(({ department, file_name, imported_at, received_via }) => ({ department, file_name, imported_at, received_via })),
  }))
  const linked = store.db.prepare(`SELECT l.job_id, COUNT(*) AS activities, MIN(d.day_no) AS first_day, MAX(d.day_no) AS last_day
    FROM job_links l JOIN activities a ON a.id = l.activity_id JOIN submissions s ON s.id = a.submission_id JOIN days d ON d.id = s.day_id
    WHERE a.docking_id = ? GROUP BY l.job_id`).all(id) as { job_id: string; activities: number; first_day: number; last_day: number }[]
  const byJob = new Map(linked.map((l) => [l.job_id, l]))
  const jobs = listJobs(store, id).map((j) => {
    const l = byJob.get(j.id)
    return { ...j, activities: Number(l?.activities ?? 0), first_day: l?.first_day ?? null, last_day: l?.last_day ?? null }
  })
  return { docking, days, jobs, notes: listAnnotations(store, id) }
}

export function jobView(store: Store, dockingId: string, jobId: string) {
  checkId(dockingId)
  const job = listJobs(store, dockingId).find((j) => j.id === checkId(jobId, "job"))
  if (!job) throw new AppError(404, "This job does not exist in this docking.")
  return { job, timeline: jobTimeline(store, job.id), notes: listAnnotations(store, dockingId).filter((n) => n.entity === "job" && n.entity_id === job.id) }
}

export function auditView(store: Store, dockingId: string) {
  call(() => getDocking(store, checkId(dockingId)))
  return auditTrail(store, dockingId)
}

// ---------------------------------------------------------------- changes

export function createDockingFrom(store: Store, body: Record<string, unknown>, actor: string) {
  return call(() => createDocking(store, dockingFields(body, true) as DockingInput, actor))
}

export function updateDockingFrom(store: Store, id: string, body: Record<string, unknown>, actor: string) {
  const rev = integer(body, "rev", "Revision")
  if (rev === undefined) throw new AppError(400, "Reload the docking before changing it.")
  return call(() => updateDocking(store, checkId(id), dockingFields(body, false), rev, actor))
}

export function dayActionFrom(store: Store, id: string, dayNoText: string, body: Record<string, unknown>, actor: string) {
  if (!/^\d{1,3}$/.test(dayNoText)) throw new AppError(404, "This day does not exist.")
  const dayNo = Number(dayNoText)
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
