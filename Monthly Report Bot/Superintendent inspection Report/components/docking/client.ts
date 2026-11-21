"use client"

// Digital Docking in the browser: the shapes the API returns, requests (through apiFetch, which adds the header the
// server requires and announces an ended session) and small formatters.

import { apiFetch } from "@/lib/api"

export type Docking = {
  id: string; code: string; vessel_id: string; vessel_name: string; yard: string; location: string; docking_type: string
  utc_offset_minutes: number; day0_date: string; arrival_time: string | null; planned_departure_date: string | null
  status: "planned" | "active" | "completed" | "cancelled"; created_by: string; created_at: string; updated_at: string; rev: number
}
export type DockingRow = Docking & { days_received: number; days_reviewed: number; days_no_report: number; last_reported_day: number | null; jobs: number }
export type DayFile = { department: "deck" | "engine"; file_name: string; imported_at: string; received_via: string }
export type Day = { id: string | null; day_no: number; report_date: string; state: "expected" | "received" | "reviewed" | "no_report"; no_report_reason: string | null; files: DayFile[] }
export type Job = { id: string; job_no: string; department: "deck" | "engine"; title: string; area: string; created_by: string; created_at: string; activities: number; first_day: number | null; last_day: number | null }
export type Note = { id: string; entity: string; entity_id: string; kind: "comment" | "query" | "correction"; body: string; author: string; created_at: string; supersedes_id: string | null; replaced: boolean }
export type DockingDetail = { docking: Docking; days: Day[]; jobs: Job[]; notes: Note[] }
export type AuditEntry = { id: number; at: string; actor: string; action: string; entity: string; entity_id: string; before: unknown; after: unknown }
export type TimelineEntry = { id: string; day_no: number; report_date: string; department: string; row_ref: string; work_text: string; findings: string; status: string; submission_status: string; photos: { id: string; slot: number }[] }

export const API = "/api/docking/dockings"

export async function getJson<T>(path: string): Promise<T> {
  const res = await apiFetch(path, { cache: "no-store" })
  return read<T>(res)
}

export async function send<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
  const res = await apiFetch(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
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
