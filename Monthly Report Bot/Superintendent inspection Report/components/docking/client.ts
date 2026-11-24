"use client"

// Digital Docking in the browser: the shapes the API returns, requests (through apiFetch, which adds the header the
// server requires and announces an ended session) and small formatters.

import { createContext, useContext } from "react"
import { apiFetch } from "@/lib/api"
import type { ReportContent } from "@/lib/docking/report/content"

export type Docking = {
  id: string; code: string; vessel_id: string; vessel_name: string; yard: string; location: string; docking_type: string
  utc_offset_minutes: number; day0_date: string; arrival_time: string | null; planned_departure_date: string | null
  status: "planned" | "active" | "completed" | "cancelled"; created_by: string; created_at: string; updated_at: string; rev: number
}
export type DockingRow = Docking & { days_received: number; days_reviewed: number; days_no_report: number; last_reported_day: number | null; jobs: number }
export type DayFile = { department: "deck" | "engine"; file_name: string; imported_at: string; received_via: string }
/** The day's daily report: a draft only (versions 0), or issued; `changed` = the draft differs from the last version. */
export type DayReport = { versions: number; changed: boolean }
export type Day = { id: string | null; day_no: number; report_date: string; state: "expected" | "received" | "reviewed" | "no_report"; no_report_reason: string | null; files: DayFile[]; report: DayReport | null }
export type Job = { id: string; job_no: string; department: "deck" | "engine"; title: string; area: string; created_by: string; created_at: string; activities: number; first_day: number | null; last_day: number | null }
export type Note = { id: string; entity: string; entity_id: string; kind: "comment" | "query" | "correction"; body: string; author: string; created_at: string; supersedes_id: string | null; replaced: boolean }
export type People = Record<string, string>
export type DockingDetail = { docking: Docking; days: Day[]; jobs: Job[]; notes: Note[]; people: People }
export type AuditEntry = { id: number; at: string; actor: string; action: string; entity: string; entity_id: string; before: unknown; after: unknown }
export type PhotoRef = { id: string; slot: number; width: number | null; height: number | null; bytes: number }
export type Entry = {
  id: string; sheet: string; row_no: number; row_ref: string; area: string; performed_by: string; company: string; location: string
  work_text: string; findings: string; status: string; next_action: string; witnessed: string; no_text: boolean
  job: { id: string; job_no: string; title: string } | null; photos: PhotoRef[]
}
export type DepartmentDay = {
  department: "deck" | "engine"
  file: { file_name: string; imported_at: string; imported_by: string; received_via: string; template: string; shared: boolean; warnings: string[]; rejected_photos: { sheet: string; cell: string; reason: string }[] } | null
  entries: Entry[]
}
export type DayDetailView = {
  docking: { id: string; code: string; vessel_name: string; day0_date: string; status: Docking["status"] }
  day: { id: string | null; day_no: number; report_date: string; state: Day["state"]; no_report_reason: string | null }
  previous: number | null; next: number | null
  departments: DepartmentDay[]
  jobs: { id: string; job_no: string; department: "deck" | "engine"; title: string; area: string }[]
  notes: Note[]
  people: People
}
export type ReportVersion = { version: number; file_name: string; pdf_bytes: number; photos: number; reason: string; issued_by: string; issued_at: string; email_text: string }
export type ReportView = {
  day: { id: string; day_no: number; report_date: string; state: Day["state"] }
  report: {
    id: string; rev: number; content: ReportContent; created_by: string; created_at: string; updated_by: string; updated_at: string
    changed_since_issue: boolean | null
  } | null
  versions: ReportVersion[]
  newer_file: { file_name: string; imported_at: string } | null
  carried_from_day: number | null
  issue_blocker: string | null
  max_pdf_bytes: number
  photo_bytes: number
  people: People
}
export type ImportKind = "initial" | "revision" | "amendment" | "duplicate"
export type ImportPlan = {
  file: { name: string; bytes: number; sha256: string }
  format: string
  file_date: string | null; file_day_no: number | null
  report_date: string | null; day_no: number | null; day_state: Day["state"] | null
  departments: { department: "deck" | "engine"; entries: number; entries_without_text: number; photos: number; photos_rejected: number; sheets: string[]; kind: ImportKind | null; current_file: string | null }[]
  warnings: string[]
  problems: string[]
  needs_reason: boolean
  issued_versions: number
}
export type ImportDone = {
  day_no: number; report_date: string; warnings: string[]
  results: { department: "deck" | "engine"; kind: ImportKind; outcome: string; linksCarried?: number; linksToReview?: number }[]
}
export const photoUrl = (dockingId: string, photoId: string) => `${API}/${dockingId}/photos/${photoId}`
export type TimelineEntry = { id: string; day_no: number; report_date: string; department: string; row_ref: string; work_text: string; findings: string; status: string; submission_status: string; photos: { id: string; slot: number }[] }

export const API = "/api/docking/dockings"
export const reportPath = (dockingId: string, dayNo: number | string) => `${API}/${dockingId}/days/${dayNo}/report`

/** The person behind a recorded actor: their name when NeraVeda knows it (records keep the sign-in id). */
export function who(people: People | undefined, actor: string): string {
  if (people?.[actor]) return people[actor]
  const imported = /^history-import:(.+)$/.exec(actor)
  return imported ? `History import (${imported[1]})` : actor
}

/** Names of the people in this docking's records, provided by each docking screen. */
export const PeopleContext = createContext<People>({})
export const usePeople = () => useContext(PeopleContext)

export const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { cache: "no-store" })
  return read<T>(res)
}

export async function send<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
  const res = await apiFetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return read<T>(res)
}

/** A file upload (multipart form data); the browser sets the content type with its boundary. */
export async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await apiFetch(path, { method: "POST", body: form })
  return read<T>(res)
}

async function read<T>(res: Response): Promise<T> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // keep null
  }
  if (!res.ok) {
    const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `Request failed (${res.status})`
    throw new Error(message)
  }
  return body as T
}

const DATE = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
const SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })
const STAMP = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })

/** A calendar date (YYYY-MM-DD) as written, e.g. "Tue, 21 Oct 2025" — no time-zone shift. */
export const formatDay = (date: string) => DATE.format(new Date(`${date}T00:00:00Z`))
export const formatShort = (date: string) => SHORT.format(new Date(`${date}T00:00:00Z`))
/** A moment (ISO time) in this computer's local time. */
export const formatStamp = (iso: string) => STAMP.format(new Date(iso))

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+"
  const abs = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}

export const OFFSETS: number[] = Array.from({ length: (840 + 720) / 15 + 1 }, (_, i) => -720 + i * 15)

export const STATUS_LABEL: Record<Docking["status"], string> = { planned: "Planned", active: "In progress", completed: "Completed", cancelled: "Cancelled" }
export const DAY_LABEL: Record<Day["state"], string> = { expected: "Expected", received: "Received", reviewed: "Reviewed", no_report: "No report" }
export const KIND_LABEL: Record<Note["kind"], string> = { comment: "Comment", query: "Query", correction: "Correction" }

export const todayIso = () => new Date().toISOString().slice(0, 10)

/** A suggested docking code, e.g. DHT LEOPARD + 2025 + Special survey → LEO-2025-SS. The Superintendent can change it. */
export function suggestCode(vessel: string, day0: string, type: string): string {
  const name = vessel.replace(/^DHT\s+/i, "").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase()
  const year = /^\d{4}/.test(day0) ? day0.slice(0, 4) : ""
  const kind = type === "Special survey" ? "SS" : type === "Intermediate survey" ? "IS" : "DD"
  return [name, year, kind].filter(Boolean).join("-")
}
