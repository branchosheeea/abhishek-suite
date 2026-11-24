// What the cloud accepts for a report. Pure: used by the API routes (app/api/reports/**) and in tests.
//
// 1. Conflicts (audit P0-1). A device sends the cloud version its copy is based on (`baseUpdatedAt`: the cloud's
//    updatedAt when this device last synced the report). A save is accepted only if the cloud still holds that version;
//    otherwise another device or tab saved in between, and the device keeps its copy until the person chooses.
//    Older tabs do not send a base: for them a save older than the cloud copy is refused, as before.
//    A save the cloud already holds (same updatedAt, e.g. a retry after a lost response) is accepted without writing.
//
// 2. Approved reports (audit P0-2). Once the Fleet Manager has approved a report (name, date and signature, as
//    lib/completeness.ts isApproved), the cloud refuses any change to it, its photos, or its deletion. The only way to
//    change it is to withdraw the approval with a reason (POST /api/reports/[id]/reopen), which keeps a permanent copy
//    of the approved version and records who withdrew it and why. A save that changes nothing is accepted.

import { isApproved } from "./completeness"
import type { Photo, Report } from "./form-schema"

/** Report sections saved on every request. */
export const REPORT_SECTIONS = ["details", "particulars", "summary", "scope", "worklist", "deck", "engine", "management", "signoff"] as const
/** Saved only when the request includes them: a tab running an older version does not send these and must not wipe them. */
export const OPTIONAL_SECTIONS = ["narratives", "criticalResults", "vesselSnapshot"] as const

type Doc = Record<string, unknown>

export type WriteDecision = "insert" | "write" | "unchanged" | "conflict"

export function decideReportWrite(input: {
  /** updatedAt of the cloud copy, or null when the cloud has no copy yet. */
  serverUpdatedAt: number | null
  /** updatedAt of the copy being saved. */
  updatedAt: number
  /** The cloud version the saved copy is based on; undefined when the device did not send one. */
  baseUpdatedAt?: number
}): WriteDecision {
  const { serverUpdatedAt, updatedAt, baseUpdatedAt } = input
  if (serverUpdatedAt === null) return "insert"
  if (serverUpdatedAt === updatedAt) return "unchanged"
  if (baseUpdatedAt !== undefined) return serverUpdatedAt === baseUpdatedAt ? "write" : "conflict"
  return serverUpdatedAt > updatedAt ? "conflict" : "write"
}

/** The base version from a request body: a finite number, otherwise undefined (older tabs send none). */
export function readBaseUpdatedAt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export const isApprovedDoc = (doc: Doc | null | undefined) => Boolean(doc) && isApproved(doc as unknown as Report)

/** Who approved, for messages: the Fleet Manager's name and approval date as entered. */
export function approvalOf(doc: Doc) {
  const signoff = (doc.signoff ?? {}) as Report["signoff"]
  return { approvedBy: signoff.fleetManagerName ?? "", approvedOn: signoff.fleetManagerDate ?? "" }
}

/** JSON with object keys in a fixed order, so that two copies with the same content compare equal. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Doc)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

/** Whether a save changes any part of the report (sections the request leaves out are not compared). */
export function sameReportContent(stored: Doc, incoming: Doc): boolean {
  for (const key of REPORT_SECTIONS) {
    if (canonical(stored[key] ?? {}) !== canonical(incoming[key] ?? {})) return false
  }
  for (const key of OPTIONAL_SECTIONS) {
    if (key in incoming && canonical(stored[key] ?? {}) !== canonical(incoming[key] ?? {})) return false
  }
  return true
}

export type SavePlan =
  | { action: "conflict"; serverUpdatedAt: number }
  | { action: "locked"; serverUpdatedAt: number; approvedBy: string; approvedOn: string }
  | { action: "unchanged" }
  /** touch: an approved report re-sent with nothing changed; only its timestamp moves on. */
  | { action: "insert" | "write" | "touch"; approves: boolean }

/** What to do with a report save. `approves` is true when this save is the one that makes the report approved. */
export function planReportSave(input: { stored: Doc | null; incoming: Doc & { updatedAt: number }; baseUpdatedAt?: number }): SavePlan {
  const { stored, incoming, baseUpdatedAt } = input
  const serverUpdatedAt = stored ? Number(stored.updatedAt) : null
  const decision = decideReportWrite({ serverUpdatedAt, updatedAt: incoming.updatedAt, baseUpdatedAt })
  if (decision === "conflict") return { action: "conflict", serverUpdatedAt: serverUpdatedAt! }
  if (decision === "unchanged") return { action: "unchanged" }
  if (decision === "insert" || !stored) return { action: "insert", approves: isApprovedDoc(incoming) }
  if (isApprovedDoc(stored)) {
    if (sameReportContent(stored, incoming)) return { action: "touch", approves: false }
    return { action: "locked", serverUpdatedAt: serverUpdatedAt!, ...approvalOf(stored) }
  }
  return { action: "write", approves: isApprovedDoc(incoming) }
}

export type ReopenPlan = "not-found" | "not-approved" | "stale" | "reopen"

/** Withdrawing an approval: only an approved report, and only from a copy based on the cloud's current version. */
export function planReopen(stored: Doc | null, baseUpdatedAt?: number): ReopenPlan {
  if (!stored) return "not-found"
  if (!isApprovedDoc(stored)) return "not-approved"
  if (baseUpdatedAt !== undefined && baseUpdatedAt !== Number(stored.updatedAt)) return "stale"
  return "reopen"
}

/** The reason given for withdrawing an approval, or an error message. */
export function checkReopenReason(value: unknown): { reason: string } | { error: string } {
  const reason = typeof value === "string" ? value.trim() : ""
  if (reason.length < 5) return { error: "Give the reason for withdrawing the approval (at least 5 characters)." }
  if (reason.length > 1000) return { error: "The reason is longer than 1,000 characters." }
  return { reason }
}

/** The report as it stands after its approval is withdrawn: the Fleet Manager must sign again. */
export function withdrawnSignoff(signoff: unknown): Report["signoff"] {
  return { ...((signoff ?? {}) as Report["signoff"]), fleetManagerSignature: "" }
}

export type DeletePlan = "absent" | "locked" | "delete"

export function planReportDelete(stored: Doc | null): DeletePlan {
  if (!stored) return "absent"
  return isApprovedDoc(stored) ? "locked" : "delete"
}

const PHOTO_FIELDS = ["dataUrl", "category", "caption", "includeInOwnerReport"] as const

/** A photo save: refused for an approved report unless it changes nothing. */
export function planPhotoSave(storedReport: Doc | null, storedPhoto: Partial<Photo> | null, incoming: Partial<Photo>): "write" | "unchanged" | "locked" {
  if (!isApprovedDoc(storedReport)) return "write"
  if (storedPhoto && PHOTO_FIELDS.every((k) => storedPhoto[k] === incoming[k])) return "unchanged"
  return "locked"
}

/** A photo deletion: refused for an approved report. */
export function planPhotoDelete(storedReport: Doc | null): "delete" | "locked" {
  return isApprovedDoc(storedReport) ? "locked" : "delete"
}
