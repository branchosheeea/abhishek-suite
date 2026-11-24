// Vessel Master · "Verify on board": a Superintendent checks a value against a ship's document and records the
// evidence. The master value then becomes VERIFIED at once (the decision of 24 Nov 2026), with the evidence kept in the
// value's reasons, a new revision and an append-only verification record. Safeguards:
//   - evidence is required (document type and its number or reference)
//   - a value already VERIFIED can only be confirmed, not changed here ("Report issue" asks the office instead)
//   - the vessel name and IMO number can only be confirmed, never changed here (they identify the vessel)
//   - a later workbook import keeps a value verified on board (lib/vessel-master/import.ts)
// Pure: the API route stores the result in one transaction (repo.ts verifyField).

import { randomUUID } from "node:crypto"
import { AppError } from "../server/errors"
export { DOCUMENT_TYPES } from "./evidence"
import { FIELD } from "./fields"
import type { Revision, StoredVessel } from "./import"
import { parseValue, type MasterField } from "./rules"
import { formatValue } from "./view"


export type Verification = {
  verificationId: string
  vesselId: string
  vesselName: string
  field: string
  before: { value: string | number | null; status: string }
  value: string | number
  documentType: string
  documentRef: string
  documentDate: string | null
  note: string
  reportId: string | null
  by: string
  byName: string
  at: string
}

const IDENTITY = new Set(["vessel_name", "imo"])
const REPORT_ID = /^[A-Za-z0-9_-]{8,64}$/

function text(body: Record<string, unknown>, key: string, label: string, max: number, required = false): string {
  const value = body[key]
  if (value === undefined || value === null || value === "") {
    if (required) throw new AppError(400, `${label} is required.`)
    return ""
  }
  if (typeof value !== "string" && typeof value !== "number") throw new AppError(400, `${label} must be text.`)
  const trimmed = String(value).trim()
  if (required && !trimmed) throw new AppError(400, `${label} is required.`)
  if (trimmed.length > max) throw new AppError(400, `${label} is longer than ${max} characters.`)
  return trimmed
}

const sameValue = (a: unknown, b: unknown) => a !== null && a !== undefined && String(a) === String(b)

/**
 * Checks what the browser sent against the vessel as stored now, and returns the VERIFIED field, the revision and the
 * verification record to store. Throws AppError (400 bad input, 409 not allowed for this value).
 */
export function verificationFrom(body: unknown, vessel: StoredVessel, who: { sub: string; name: string }, now = new Date()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Send the verification as a JSON object.")
  if (!who.sub) throw new AppError(401, "Sign in to NeraVeda to verify a value.")
  if (!vessel.workbookId) throw new AppError(409, "This vessel has no Vessel Master particulars to verify.")
  const input = body as Record<string, unknown>
  const key = text(input, "field", "Field", 60, true)
  const spec = FIELD[key]
  if (!spec) throw new AppError(400, `"${key}" is not a Vessel Master field.`)
  const raw = text(input, "value", "Verified value", 500, true)
  const parsed = parseValue(raw, spec)
  if (parsed.value === null || parsed.error) throw new AppError(400, `${spec.label}: ${parsed.error ?? "enter the value shown on the document"}.`)
  const documentType = text(input, "documentType", "Document", 120, true)
  const documentRef = text(input, "documentRef", "Document number or reference", 200, true)
  const documentDate = text(input, "documentDate", "Document date", 10)
  if (documentDate && !/^\d{4}-\d{2}-\d{2}$/.test(documentDate)) throw new AppError(400, "Document date must be a date (YYYY-MM-DD).")
  if (documentDate && documentDate > now.toISOString().slice(0, 10)) throw new AppError(400, "Document date cannot be in the future.")
  const note = text(input, "note", "Note", 1000)
  const reportId = text(input, "reportId", "Report", 64)
  if (reportId && !REPORT_ID.test(reportId)) throw new AppError(400, "Report is not a valid report id.")

  const current = vessel.fields[key]
  const changed = !sameValue(current?.value, parsed.value)
  if (changed && IDENTITY.has(key)) {
    throw new AppError(409, `${spec.label} identifies the vessel and can only be confirmed here, not changed. Use “Report issue” for the office.`)
  }
  if (changed && current?.status === "VERIFIED") {
    throw new AppError(409, `${spec.label} is already VERIFIED as ${formatValue(key, current.value, spec.unit)}. Use “Report issue” so the office can correct it.`)
  }

  const at = now.toISOString()
  const verificationId = randomUUID()
  const evidence = `${documentType} ${documentRef}${documentDate ? ` dated ${documentDate}` : ""}`
  const field: MasterField = {
    value: parsed.value, ...(parsed.raw !== undefined ? { raw: parsed.raw } : {}), unit: spec.unit, status: "VERIFIED",
    release: spec.autofill === "MASTER_ONLY" ? "master-only" : "fill", physicalVerification: false,
    reasons: [`Verified on board by ${who.name || who.sub} on ${at.slice(0, 10)} against ${evidence}${changed ? ` (was ${formatValue(key, current?.value ?? null, spec.unit) || "blank"})` : ""}.${note ? ` ${note}` : ""}`],
    sourceIds: [...new Set([...(current?.sourceIds ?? []), `VER-${verificationId.slice(0, 8)}`])],
    issueIds: current?.issueIds ?? [],
  }
  const verification: Verification = {
    verificationId, vesselId: vessel.vesselId, vesselName: vessel.name, field: key,
    before: { value: current?.value ?? null, status: current?.status ?? "MISSING" }, value: parsed.value,
    documentType, documentRef, documentDate: documentDate || null, note, reportId: reportId || null, by: who.sub, byName: who.name || who.sub, at,
  }
  const revision: Revision = {
    vesselId: vessel.vesselId, revision: vessel.revision + 1, at, by: who.name || who.sub,
    reason: `Verified on board: ${spec.label} against ${evidence}`,
    changes: [{ field: key, before: current ? { value: current.value, status: current.status, release: current.release } : null, after: { value: field.value, status: field.status, release: field.release } }],
  }
  const doc: StoredVessel = { ...vessel, fields: { ...vessel.fields, [key]: field }, revision: vessel.revision + 1, updatedAt: at, updatedBy: who.name || who.sub }
  return { doc, revision, verification, field }
}

/** True when a field's VERIFIED status came from an on-board verification (kept by later workbook imports). */
export const verifiedOnBoard = (f: MasterField | undefined) => Boolean(f && f.status === "VERIFIED" && f.sourceIds.some((id) => id.startsWith("VER-")))
