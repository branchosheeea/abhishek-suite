"use client"

// Guarantee Claim Manager in the browser: the shapes /api/gc returns (gc_manager/views.py), requests through apiFetch,
// and formatting only. No claim rule lives here: due dates, overdue days, ages, priority classes, reasons, owner
// groups, next actions and suggestion labels all come from the shared Python rules (gc_manager/command.py).

import { apiFetch } from "@/lib/api"

export type Vessel = { id: number; name: string; claims: number }
export type Scope = { vessels: Vessel[]; tracked: string[]; all_vessels: boolean }
export type Sync = {
  enabled: boolean; configured: boolean; last_attempt_at: string | null; last_error: string | null
  last_folder_read_at: string | null; folders: number; folders_with_errors: number
}
export type Overview = {
  today: string; scope: Scope; vessel: Vessel | null; sync: Sync
  claims?: { total: number; open: number; closed: number; cancelled: number; by_status: { status: string; label: string; count: number }[] }
  ownership?: { groups: OwnerRow[]; not_established: number }
  recorded?: { open: number; owner: number; title: number; equipment: number; follow_up_date: number; commitment_date: number; next_action: number; action_since: number }
  guarantee?: { start_date: string | null; expiry_date: string | null }
  correspondence?: { linked_emails: number; latest_incoming: string | null }
  reviews?: { open: number; vessel_unknown: number; by_type: { type: string; count: number }[] }
  headline?: Headline
  next_best?: Brief | null
  attention?: { items: Brief[]; total: number }
  developments?: { since: string; since_review: boolean; counts: Record<string, number>; points: number; items: Development[] }
  closure?: { candidates: number; by_kind: { label: string; count: number }[]; candidate_claims: number[]; suggestions: number; suggestion_claims: number[] }
  review_state?: { last_dashboard_review_at: string | null; user_known: boolean }
  settings?: { standard_followup_days: number; verification_days: number; developments_days: number }
  groups?: Groups
}
export type Group = "YOUR_TURN" | "WAITING" | "READY_TO_CLOSE" | "NOT_SET_UP"
export type Chip = { text: string; tone: "danger" | "warn" | "info" | "muted" }
export type GroupRow = {
  claim_id: number; gc_number: string; group: Group; confirmed: boolean; title: string | null; title_suggested: boolean
  with: string | null; since: string | null; days: number | null; next_step: string | null; next_step_suggested: boolean
  stage: string; progress: number; chips: Chip[]; note: string | null; overdue: boolean; close_source: "RECORD" | "EMAIL" | null
  /** The exact guided set-up request that confirms what the emails say (null when confirmed or not enough to confirm). */
  confirm: { fields: Record<string, string | null>; status: string | null; used: string[]; rejected: string[]; expected_updated_at: string } | null
}
export type Groups = {
  order: Group[]; labels: Record<Group, string>; counts: Record<Group, number>; unconfirmed: Record<Group, number>
  overdue: number; confirmed_total: number; rows: Record<Group, GroupRow[]>
  waiting_by: { with: string; count: number }[]; whats_new: { claim_id: number; gc_number: string; title: string | null }[]
}
export type OwnerRow = { owner: string; open: number; overdue: number; oldest_days: number | null }
export type Headline = {
  need_intervention: number; with_office: number; closure_candidates: number; closure_suggestions: number; owner_suggestions: number; snoozed: number
  breakdown: { verified_action: number; follow_up: number; record_incomplete: number; review_only: number }
}
export type Reason = { code: string; category: "ACTION" | "FOLLOW_UP" | "RECORD" | "REVIEW"; klass: number; text: string }
export type NextAction = { kind: "CONTROLLED" | "REMINDER" | "SUGGESTED" | "NOT_ESTABLISHED"; label: string; text: string; suggestion_key?: string }
export type Assessment = {
  claim_id: number; gc_number: string; open: boolean; owner: string | null; waiting_on: string; pending_since: string | null
  age_days: number | null; due: { date: string; source: string; label: string } | null; due_state: "OVERDUE" | "DUE_TODAY" | "UPCOMING" | null
  overdue_days: number; warranty: { expiry_date: string; days_left: number; state: string } | null
  closure: { kind: string; label: string; text: string } | null; reasons: Reason[]; klass: number | null; class_label: string | null
  review: boolean; snoozed_until: string | null; suggestions: number; suggestion_kinds: string[]; next_action: NextAction | null
  primary_action: string | null; primary_target: "SETUP" | "INSPECT"; needs_intervention: boolean
  /** What the emails suggest for an empty title and owner (shown only marked as a suggestion). */
  suggested: { title: string | null; owner: string | null }
  group: Group | null; chips: Chip[]; note: string | null
}
export type Brief = { claim_id: number; gc_number: string; title: string | null; equipment_system: string | null; status_label: string; assessment: Assessment }
export type Development = {
  claim_id: number; gc_number: string; date: string; source: string; verified: boolean
  category: "ACTION REQUIRED" | "REVIEW REQUIRED" | "MATERIAL UPDATE" | "INFORMATIONAL"; title: string; text: string
  points: { category: string; title: string; text: string; date: string; verified: boolean }[]
}
export type Suggestion = {
  key: string; kind: string; kind_label: string; proposal: string; proposed: Record<string, unknown>; reason: string; quote: string
  evidence_email_id: number; evidence_date: string | null; evidence_subject: string; evidence_direction: string; evidence_author: string
}
export type SetupData = { vessel: Vessel | null; claims: { claim: ClaimRow; suggestions: Suggestion[] }[]; totals: Record<string, number> }
export type SearchData = { vessel: Vessel | null; claims: ClaimRow[]; emails: Email[]; email_total: number; equipment: string[] }
export type ClaimRow = {
  id: number; gc_number: string; vessel_id: number; vessel_name: string; title: string | null; equipment_system: string | null
  status: string; status_label: string; open: boolean; waiting_on: string; owner: string | null; responsible_party: string | null
  next_follow_up_date: string | null; promised_dispatch_date: string | null; expected_delivery_date: string | null
  service_attendance_date: string | null; priority: string; updated_at: string
  last_incoming_email: string | null; last_outgoing_email: string | null; emails: number
  next_action: string | null; action_since: string | null; assessment?: Assessment
}
export type Email = {
  id: number; claim_id: number | null; mailbox_folder: string; direction: string; subject: string; sender_name: string | null
  sender_address: string | null; message_datetime: string | null; body_preview: string; has_attachments: boolean
  reviewed_at: string | null; imported_at: string; recipients: unknown[]; gc_numbers: string[]
  claim?: { id: number; gc_number: string } | null
}
export type StoryEvent = { id: number; event_type: string; title: string; description: string; event_date: string; email_id: number | null; created_by: string | null }
export type HistoryRow = {
  id: number; previous_status: string | null; new_status: string; previous_waiting_on: string | null; new_waiting_on: string
  reason: string; source: string; changed_at: string; changed_by: string | null
}
export type ClaimDetail = {
  claim: ClaimRow & {
    defect_description: string | null; date_reported: string | null; date_submitted: string | null; rectification_date: string | null
    closure_date: string | null; notes: string | null; assigned_to: string | null; reopened_count: number; created_at: string; created_by: string | null
  }
  vessel: { id: number; name: string; guarantee_start_date: string | null; guarantee_expiry_date: string | null }
  story: StoryEvent[]; history: HistoryRow[]; emails: Email[]; suggestions: Suggestion[]
  follow_up_review: { objective: string; last_position: string | null; draft: string } | null
}
export type ReviewItem = {
  id: number; type: string; reason: string; created_at: string; vessel_known: boolean; email_id: number; subject: string
  direction: string; body_preview: string; gc_numbers: string[]; message_datetime: string | null
}

export const API = "/api/gc"

/** A failed request, with the HTTP status (0 = the server could not be reached). */
export class RequestFailed extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function getJson<T>(path: string): Promise<T> {
  let res: Response
  try {
    res = await apiFetch(path, { cache: "no-store" })
  } catch {
    throw new RequestFailed(0, "The NeraVeda web server is not reachable. Open the workspace again from NeraVeda.")
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // keep null
  }
  if (!res.ok) {
    const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `Request failed (${res.status})`
    throw new RequestFailed(res.status, message)
  }
  return body as T
}

/** A query string from the values that are set. */
export function query(values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "") params.set(key, String(value))
  const text = params.toString()
  return text ? `?${text}` : ""
}

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
const STAMP = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
const SHORT_STAMP = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })

/** A calendar date as recorded (YYYY-MM-DD), without any time-zone shift. */
export const formatDay = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? DAY.format(new Date(`${value}T00:00:00Z`)) : value)
/** A moment (stored in UTC) in this computer's local time. */
export function formatStamp(value: string, short = false): string {
  const when = new Date(value)
  return Number.isNaN(when.getTime()) ? value : (short ? SHORT_STAMP : STAMP).format(when)
}

export const NOT_RECORDED = "Not recorded"

export const REVIEW_LABEL: Record<string, string> = {
  NEW_GC: "GC number not registered yet",
  MULTIPLE_GC_NUMBERS: "Several GC numbers in one subject",
  AMBIGUOUS_VESSEL: "Vessel unclear",
  UNMATCHED_GC_EMAIL: "No vessel named in the subject",
}

/** "12 days" / "1 day"; null stays null so the page can say it is not established. */
export const days = (n: number | null | undefined) => (n === null || n === undefined ? null : `${n} day${n === 1 ? "" : "s"}`)

export type Vocabulary = {
  statuses: string[]; labels: Record<string, string>; waiting_on: string[]; owner_labels: Record<string, string>
  transitions: Record<string, string[]>
}

/** A change (POST/PATCH/DELETE) through apiFetch, which adds the write header the server requires. */
export async function send<T>(path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await apiFetch(path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new RequestFailed(0, "The NeraVeda web server is not reachable, so nothing was saved.")
  }
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    // keep null
  }
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `Not saved (${res.status})`
    throw new RequestFailed(res.status, message)
  }
  return data as T
}

/** Statuses a claim can still be in (closing has its own action with a date and reason). */
export const openStatuses = (v: Vocabulary) => v.statuses.filter((s) => s !== "CLOSED")
