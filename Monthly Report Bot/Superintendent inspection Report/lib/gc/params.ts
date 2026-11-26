// Guarantee Claim Manager: reading the browser's query values for the /api/gc routes. Only known names, only the
// expected shapes; the Python helper checks them again. Nothing here becomes SQL, a file path or a command name.

import { AppError } from "../server/errors"

const ID = /^[1-9]\d{0,14}$/
const STATUS = /^[A-Z_]{1,40}$/
const MAX_TEXT = 200

function only(url: URL, allowed: readonly string[]): void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key)) throw new AppError(400, `Unknown query value: ${key.slice(0, 40)}.`)
}

/** A positive whole number from the path or query, or a 400. */
export function idFrom(value: string | null | undefined, name: string): number {
  if (!value || !ID.test(value)) throw new AppError(400, `${name} must be a positive whole number.`)
  return Number(value)
}

function optionalId(url: URL, key: string, name: string): number | undefined {
  const value = url.searchParams.get(key)
  return value === null || value === "" ? undefined : idFrom(value, name)
}

function text(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)
  if (value === null) return undefined
  if (value.length > MAX_TEXT) throw new AppError(400, `Search text is longer than ${MAX_TEXT} characters.`)
  return value
}

/** ?vessel=<id> */
export function vesselArgs(url: URL): { vessel_id?: number } {
  only(url, ["vessel"])
  const vessel = optionalId(url, "vessel", "Vessel")
  return vessel === undefined ? {} : { vessel_id: vessel }
}

// Fixed word lists the Python helper also checks (gc_manager/views.py FOCUS, SORTS; command.py OWNER_ORDER).
export const FOCUS = ["intervention", "office", "overdue", "closure", "suggestions", "incomplete", "your_turn", "waiting", "ready_to_close", "not_set_up"] as const
export const SORTS = ["gc", "priority"] as const
export const OWNERS = ["Office", "Makers", "Shipyard", "Vessel", "Class", "Multiple parties", "Not established"] as const

function oneOf(url: URL, key: string, options: readonly string[], name: string): string | undefined {
  const value = url.searchParams.get(key)
  if (value === null || value === "") return undefined
  if (!options.includes(value)) throw new AppError(400, `${name} is not one of the known values.`)
  return value
}

type RegisterArgs = { vessel_id?: number; search?: string; status?: string; focus?: string; owner?: string; sort?: string }

/** ?vessel=&search=&status=&focus=&owner=&sort= */
export function registerArgs(url: URL): RegisterArgs {
  only(url, ["vessel", "search", "status", "focus", "owner", "sort"])
  const args: RegisterArgs = {}
  const focus = oneOf(url, "focus", FOCUS, "Focus")
  if (focus) args.focus = focus
  const owner = oneOf(url, "owner", OWNERS, "Owner")
  if (owner) args.owner = owner
  const sort = oneOf(url, "sort", SORTS, "Sort")
  if (sort) args.sort = sort
  const vessel = optionalId(url, "vessel", "Vessel")
  if (vessel !== undefined) args.vessel_id = vessel
  const search = text(url, "search")
  if (search) args.search = search
  const status = url.searchParams.get("status")
  if (status) {
    if (!STATUS.test(status)) throw new AppError(400, "Status is not a known claim status.")
    args.status = status
  }
  return args
}

/** ?vessel=&search=&direction=&offset= */
export function correspondenceArgs(url: URL): { vessel_id?: number; search?: string; direction?: string; offset?: number } {
  only(url, ["vessel", "search", "direction", "offset"])
  const args: { vessel_id?: number; search?: string; direction?: string; offset?: number } = {}
  const vessel = optionalId(url, "vessel", "Vessel")
  if (vessel !== undefined) args.vessel_id = vessel
  const search = text(url, "search")
  if (search) args.search = search
  const direction = url.searchParams.get("direction")
  if (direction) {
    if (direction !== "INCOMING" && direction !== "OUTGOING") throw new AppError(400, "Direction must be INCOMING or OUTGOING.")
    args.direction = direction
  }
  const offset = url.searchParams.get("offset")
  if (offset !== null && offset !== "" && offset !== "0") args.offset = idFrom(offset, "Offset")
  return args
}

/** ?vessel=&q= (Ctrl+K search) */
export function searchArgs(url: URL): { vessel_id?: number; text?: string } {
  only(url, ["vessel", "q"])
  const args: { vessel_id?: number; text?: string } = {}
  const vessel = optionalId(url, "vessel", "Vessel")
  if (vessel !== undefined) args.vessel_id = vessel
  const value = text(url, "q")
  if (value) args.text = value
  return args
}
