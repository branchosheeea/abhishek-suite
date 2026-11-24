// Vessel Master · "Report master data issue": a Superintendent says a master value is wrong or missing. The entry is
// recorded for the office to review; it never changes the master by itself. The browser sends only the field, the
// proposed value, the reason, the source and (optionally) the report; the current value comes from the master, and the
// reporter from the NeraVeda session.

import { randomUUID } from "node:crypto"
import { AppError } from "../server/errors"
import { FIELD } from "./fields"
import type { StoredVessel } from "./import"
import type { Flag } from "./repo"
import { formatValue } from "./view"

export const VESSEL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

function text(body: Record<string, unknown>, key: string, label: string, max: number, required = false): string {
  const value = body[key]
  if (value === undefined || value === null) {
    if (required) throw new AppError(400, `${label} is required.`)
    return ""
  }
  if (typeof value !== "string") throw new AppError(400, `${label} must be text.`)
  const trimmed = value.trim()
  if (required && !trimmed) throw new AppError(400, `${label} is required.`)
  if (trimmed.length > max) throw new AppError(400, `${label} is longer than ${max} characters.`)
  return trimmed
}

/** Checks what the browser sent and builds the flag. Throws AppError(400) with a message the Superintendent can act on. */
export function flagFrom(body: unknown, vessel: StoredVessel, reporter: { sub: string; name: string }, now = new Date()): Flag {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Send the issue as a JSON object.")
  const input = body as Record<string, unknown>
  const field = text(input, "field", "Field", 60, true)
  const spec = FIELD[field]
  if (!spec) throw new AppError(400, `"${field}" is not a Vessel Master field.`)
  const proposedValue = text(input, "proposedValue", "Proposed value", 500)
  const reason = text(input, "reason", "Reason", 1000, true)
  if (reason.length < 5) throw new AppError(400, "Say briefly why the value is wrong or missing.")
  const source = text(input, "source", "Source", 500)
  const reportId = text(input, "reportId", "Report", 64)
  if (reportId && !REPORT_ID_PATTERN.test(reportId)) throw new AppError(400, "Report is not a valid report id.")
  if (!reporter.sub) throw new AppError(401, "Sign in to NeraVeda to report an issue.")
  const current = vessel.fields[field]
  return {
    flagId: randomUUID(), vesselId: vessel.vesselId, vesselName: vessel.name, field,
    currentValue: formatValue(field, current?.value ?? null, spec.unit), proposedValue, reason, source,
    reporter: reporter.sub, reporterName: reporter.name || reporter.sub, reportId: reportId || null, at: now.toISOString(), status: "open",
  }
}
