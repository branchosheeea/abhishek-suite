// Guarantee Claim Manager: reading the browser's request bodies for the change routes (Phase 4). Only known names,
// only text of a limited length, dates as YYYY-MM-DD. The Python helper checks everything again and applies the claim
// rules; nothing here becomes SQL, a file path or a command name.

import { AppError } from "../server/errors"
import { currentUser } from "../server/auth"

const MAX_BODY = 32 * 1024
const MAX_TEXT = 2000
const DAY = /^\d{4}-\d{2}-\d{2}$/
const STATUS = /^[A-Z_]{1,40}$/
const KEY = /^[A-Z_]{1,20}:\d{1,15}:\d{1,15}:[\s\S]{0,360}$/

/** Fields a person may edit (gc_manager Repository.EDITABLE). */
export const EDITABLE = [
  "title", "equipment_system", "defect_description", "date_reported", "date_submitted", "waiting_on", "responsible_party_name",
  "next_follow_up_date", "promised_dispatch_date", "expected_delivery_date", "service_attendance_date", "rectification_date",
  "priority", "notes", "assigned_to", "next_action", "action_since",
] as const
const DATE_FIELDS = new Set(["date_reported", "date_submitted", "next_follow_up_date", "promised_dispatch_date", "expected_delivery_date",
  "service_attendance_date", "rectification_date", "action_since"])

type Body = Record<string, unknown>

export async function readBody(req: Request): Promise<Body> {
  const text = await req.text()
  if (text.length > MAX_BODY) throw new AppError(413, "The request is too large.")
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new AppError(400, "The request could not be read.")
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "The request could not be read.")
  return body as Body
}

function only(body: Body, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw new AppError(400, `Unknown value: ${key.slice(0, 40)}.`)
}

function text(body: Body, key: string, required = false, max = MAX_TEXT): string {
  const value = body[key]
  if (value === undefined || value === null || value === "") {
    if (required) throw new AppError(400, `${key.replace(/_/g, " ")} is required.`)
    return ""
  }
  if (typeof value !== "string" || value.length > max) throw new AppError(400, `${key.replace(/_/g, " ")} must be text of at most ${max} characters.`)
  return value
}

function day(body: Body, key: string, required = false): string {
  const value = text(body, key, required, 10)
  if (value && !DAY.test(value)) throw new AppError(400, `${key.replace(/_/g, " ")} must be a date (YYYY-MM-DD).`)
  return value
}

function stamp(body: Body): string {
  const value = text(body, "expected_updated_at", true, 64)
  return value
}

function status(body: Body, key = "status"): string {
  const value = text(body, key, true, 40)
  if (!STATUS.test(value)) throw new AppError(400, "Status is not a known claim status.")
  return value
}

function fields(body: Body): Record<string, string | null> {
  const value = body.fields
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(400, "fields must be an object.")
  const out: Record<string, string | null> = {}
  for (const [key, item] of Object.entries(value as Body)) {
    if (!(EDITABLE as readonly string[]).includes(key)) throw new AppError(400, `${key.slice(0, 40)} cannot be edited.`)
    if (item !== null && (typeof item !== "string" || item.length > MAX_TEXT)) throw new AppError(400, `${key} must be text of at most ${MAX_TEXT} characters.`)
    if (DATE_FIELDS.has(key) && item && !DAY.test(item as string)) throw new AppError(400, `${key.replace(/_/g, " ")} must be a date (YYYY-MM-DD).`)
    out[key] = item === "" ? null : (item as string | null)
  }
  if (Object.keys(out).length === 0) throw new AppError(400, "Nothing to change.")
  return out
}

function keys(body: Body, key: string): string[] {
  const value = body[key] ?? []
  if (!Array.isArray(value) || value.length > 50 || value.some((k) => typeof k !== "string" || !KEY.test(k))) throw new AppError(400, `${key} must be a list of suggestion keys.`)
  return value as string[]
}

/** The signed-in person (the session's email): every change is recorded under it. */
export function actor(): string {
  const user = currentUser()
  if (!user?.sub) throw new AppError(401, "Sign in to NeraVeda again.")
  return user.sub
}

export function updateBody(body: Body) {
  only(body, ["fields", "reason", "expected_updated_at"])
  return { fields: fields(body), reason: text(body, "reason", false, 200), expected_updated_at: stamp(body) }
}

export function setupBody(body: Body) {
  only(body, ["fields", "status", "used", "rejected", "expected_updated_at"])
  const args: { fields: Record<string, string | null>; used: string[]; rejected: string[]; expected_updated_at: string; status?: string } =
    { fields: fields(body), used: keys(body, "used"), rejected: keys(body, "rejected"), expected_updated_at: stamp(body) }
  if (body.status !== undefined && body.status !== null && body.status !== "") args.status = status(body)
  return args
}

export function statusBody(body: Body) {
  only(body, ["status", "reason", "override", "expected_updated_at"])
  if (body.override !== undefined && typeof body.override !== "boolean") throw new AppError(400, "override must be true or false.")
  return { status: status(body), reason: text(body, "reason"), override: body.override === true, expected_updated_at: stamp(body) }
}

export function closeBody(body: Body) {
  only(body, ["closure_date", "reason", "expected_updated_at"])
  return { closure_date: day(body, "closure_date", true), reason: text(body, "reason", true), expected_updated_at: stamp(body) }
}

export function reopenBody(body: Body) {
  only(body, ["status", "reason", "expected_updated_at"])
  return { status: status(body), reason: text(body, "reason", true), expected_updated_at: stamp(body) }
}

export function snoozeBody(body: Body) {
  only(body, ["until", "reason"])
  return { until: day(body, "until", true), reason: text(body, "reason", true) }
}

function optionalId(body: Body, key: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 2 ** 53) throw new AppError(400, `${key.replace(/_/g, " ")} must be a positive whole number.`)
  return value
}

/** Resolve one Review Queue email: link it (to a claim, or by registering its GC number) or mark it not relevant. */
export function reviewBody(body: Body) {
  only(body, ["action", "vessel_id", "claim_id", "register", "link_matching", "notes", "claim_ids"])
  const notes = text(body, "notes")
  if (body.action === "multiple") {
    const ids = body.claim_ids
    if (!Array.isArray(ids) || ids.length < 2 || ids.length > 20 || ids.some((i) => typeof i !== "number" || !Number.isInteger(i) || i <= 0)) throw new AppError(400, "Choose at least two claims.")
    return { cmd: "review.resolve_multiple" as const, args: { claim_ids: ids as number[], notes } }
  }
  if (body.action !== "link" && body.action !== "irrelevant") throw new AppError(400, "action must be link, irrelevant or multiple.")
  for (const flag of ["register", "link_matching"]) if (body[flag] !== undefined && typeof body[flag] !== "boolean") throw new AppError(400, `${flag} must be true or false.`)
  const args: Record<string, unknown> = { action: body.action, register: body.register === true, link_matching: body.link_matching === true, notes }
  const vessel = optionalId(body, "vessel_id")
  if (vessel !== undefined) args.vessel_id = vessel
  const claim = optionalId(body, "claim_id")
  if (claim !== undefined) args.claim_id = claim
  return { cmd: "review.resolve" as const, args }
}

export function decideBody(body: Body) {
  only(body, ["key", "decision", "reason"])
  const [key] = keys({ key: [body.key] }, "key")
  const decision = body.decision
  if (decision !== "ACCEPTED" && decision !== "REJECTED") throw new AppError(400, "decision must be ACCEPTED or REJECTED.")
  return { key, decision, reason: text(body, "reason") }
}
