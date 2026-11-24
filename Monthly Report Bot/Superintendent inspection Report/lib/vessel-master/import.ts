// Vessel Master · import in two steps, both from the same workbook bytes:
//   plan   - read, check and compare with the master: what would be created, updated, left unchanged, refused. Stores
//            nothing. Its hash names exactly this preview.
//   commit - only with that hash (so what was reviewed is what is written), in one transaction, recorded as an import.
// Matching: workbook Vessel ID, then IMO. A record NeraVeda already had without either (an identity-only record, or the
// first import's link to the existing fleet names) is matched once by its legacy name. Never by name alone otherwise.
// An unchanged workbook changes nothing (no new revisions). A VERIFIED value is never replaced without an explicit
// override and a reason.

import { createHash, randomUUID } from "node:crypto"
import { FIELDS } from "./fields"
import { buildMaster, type MasterDraft, type MasterField, type Rejected, type ReviewException } from "./rules"
import { verifiedOnBoard } from "./verify"
import type { ParsedWorkbook, Row } from "./workbook"

export type StoredVessel = MasterDraft & {
  vesselId: string
  revision: number
  org: string
  createdAt: string
  updatedAt: string
  updatedBy: string
}

export type RevisionChange = { field: string; before: Pick<MasterField, "value" | "status" | "release"> | null; after: Pick<MasterField, "value" | "status" | "release"> }
export type Revision = { vesselId: string; revision: number; at: string; by: string; reason: string; importId?: string; changes: RevisionChange[] }
export type ImportRecord = {
  importId: string; sha256: string; fileName: string; at: string; by: string
  outcome: "committed" | "no-change"; previewHash: string
  counts: PlanCounts; rejected: Rejected[]; exceptions: ReviewException[]; skippedVerified: { workbookId: string | null; field: string }[]
}

/** Writes of one import, applied all together or not at all. */
export interface MasterTx {
  /** The master as this transaction sees it. */
  listVessels(): Promise<StoredVessel[]>
  insertVessel(doc: StoredVessel): Promise<void>
  /** Replaces the record only if it still has the expected revision; false otherwise (someone changed it meanwhile). */
  replaceVessel(doc: StoredVessel, expectedRevision: number): Promise<boolean>
  insertRevision(revision: Revision): Promise<void>
  upsertReference(collection: "sources" | "issues", key: string, doc: Row & { importId: string }): Promise<void>
  insertImport(record: ImportRecord): Promise<void>
}
export interface MasterStore {
  listVessels(): Promise<StoredVessel[]>
  transaction<T>(fn: (tx: MasterTx) => Promise<T>): Promise<T>
}

export type FieldChange = RevisionChange & { kind: "add" | "update" | "status"; verifiedOverwrite: boolean }
export type VesselPlan = {
  action: "create" | "update" | "unchanged"
  match: "workbook-id" | "imo" | "legacy-name" | "new"
  vesselId: string | null
  workbookId: string | null
  name: string
  changes: FieldChange[]
  /** Name, aliases, IMO, fleet group, statuses or basis differ from the master record. */
  identityChanged: boolean
  draft: MasterDraft
}
export type PlanCounts = {
  create: number; update: number; unchanged: number; rejected: number
  fields: { VERIFIED: number; PROVISIONAL: number; CONFLICT: number; MISSING: number }
  release: { fill: number; offer: number; withhold: number; "master-only": number }
  physicalVerification: number; verifiedOverwrites: number
}
export type ImportPlan = {
  sha256: string
  fileName: string
  problems: string[]
  rejected: Rejected[]
  exceptions: ReviewException[]
  vessels: VesselPlan[]
  counts: PlanCounts
  /** Names exactly this preview: the workbook, the master it was compared with, and every proposed change. */
  previewHash: string
}

const pick = (f: MasterField | undefined) => (f ? { value: f.value, status: f.status, release: f.release } : null)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const IDENTITY_KEYS = ["name", "aliases", "legacyKeys", "imo", "fleetGroup", "activeStatus", "groupStatus", "performanceBasis", "sourceNote", "workbookId"] as const

function match(draft: MasterDraft, existing: StoredVessel[]): { vessel: StoredVessel | null; how: VesselPlan["match"] } {
  const byId = draft.workbookId ? existing.find((v) => v.workbookId === draft.workbookId) : undefined
  if (byId) return { vessel: byId, how: "workbook-id" }
  const byImo = draft.imo ? existing.find((v) => v.imo === draft.imo) : undefined
  if (byImo) return { vessel: byImo, how: "imo" }
  const legacy = existing.find((v) => !v.workbookId && !v.imo && draft.legacyKeys.some((k) => v.legacyKeys.includes(k)))
  if (legacy) return { vessel: legacy, how: "legacy-name" }
  return { vessel: null, how: "new" }
}

/** What importing this workbook would do to the master. Pure apart from the master it is given. */
export function planImport(book: ParsedWorkbook, fileName: string, existing: StoredVessel[], legacyNames: readonly string[]): ImportPlan {
  const built = book.problems.length ? { vessels: [], rejected: [], exceptions: [] } : buildMaster(book, legacyNames)
  const rejected = [...built.rejected]
  const vessels: VesselPlan[] = []
  for (const draft of built.vessels) {
    const { vessel, how } = match(draft, existing)
    // A workbook ID and an IMO that point at two different master records is an identity conflict: refused.
    if (vessel && draft.imo && vessel.imo && vessel.imo !== draft.imo) {
      rejected.push({ row: 0, workbookId: draft.workbookId, reasons: [`Vessel ID ${draft.workbookId} is IMO ${vessel.imo} in the master but IMO ${draft.imo} in the workbook`] })
      continue
    }
    // Matched by IMO, but the master knows this vessel under another workbook ID: an ID is never silently renamed.
    if (vessel && how === "imo" && vessel.workbookId && draft.workbookId && vessel.workbookId !== draft.workbookId) {
      rejected.push({ row: 0, workbookId: draft.workbookId, reasons: [`IMO ${draft.imo} is ${vessel.name} (Vessel ID ${vessel.workbookId}) in the master, not ${draft.workbookId}`] })
      continue
    }
    const other = draft.imo ? existing.find((v) => v.imo === draft.imo && v !== vessel) : undefined
    if (other) {
      rejected.push({ row: 0, workbookId: draft.workbookId, reasons: [`IMO ${draft.imo} already belongs to ${other.name} in the master`] })
      continue
    }
    // An identity-only record the workbook does not list is left exactly as it is.
    if (!draft.workbookId && vessel) {
      vessels.push({ action: "unchanged", match: how, vesselId: vessel.vesselId, workbookId: null, name: vessel.name, changes: [], identityChanged: false, draft })
      continue
    }
    const changes: FieldChange[] = []
    for (const spec of FIELDS) {
      const before = vessel?.fields[spec.key]
      const after = draft.fields[spec.key]
      if (before && same(pick(before), pick(after)) && same(before.reasons, after.reasons) && same(before.sourceIds, after.sourceIds)) continue
      // Verified on board with evidence: kept while the workbook has the same value (a different value is a VERIFIED
      // overwrite below, which needs an explicit override).
      if (verifiedOnBoard(before) && same(before!.value, after.value)) continue
      if (!before && after.value === null && after.status === "MISSING" && vessel) continue
      const kind: FieldChange["kind"] = !before || before.value === null ? "add" : same(before.value, after.value) ? "status" : "update"
      changes.push({ field: spec.key, before: pick(before), after: pick(after)!, kind, verifiedOverwrite: before?.status === "VERIFIED" && !same(before.value, after.value) })
    }
    const identityChanged = vessel ? IDENTITY_KEYS.some((k) => !same(vessel[k], draft[k])) : true
    const action: VesselPlan["action"] = !vessel ? "create" : changes.length || identityChanged ? "update" : "unchanged"
    vessels.push({ action, match: how, vesselId: vessel?.vesselId ?? null, workbookId: draft.workbookId, name: draft.name, changes, identityChanged, draft })
  }

  const counts: PlanCounts = {
    create: vessels.filter((v) => v.action === "create").length, update: vessels.filter((v) => v.action === "update").length,
    unchanged: vessels.filter((v) => v.action === "unchanged").length, rejected: rejected.length,
    fields: { VERIFIED: 0, PROVISIONAL: 0, CONFLICT: 0, MISSING: 0 }, release: { fill: 0, offer: 0, withhold: 0, "master-only": 0 },
    physicalVerification: 0, verifiedOverwrites: 0,
  }
  for (const v of vessels) {
    for (const f of Object.values(v.draft.fields)) {
      counts.fields[f.status]++
      counts.release[f.release]++
      if (f.physicalVerification) counts.physicalVerification++
    }
    counts.verifiedOverwrites += v.changes.filter((c) => c.verifiedOverwrite).length
  }
  const previewHash = createHash("sha256").update(JSON.stringify({
    sha: book.sha256, master: existing.map((v) => [v.vesselId, v.revision]).sort(),
    vessels: vessels.map((v) => [v.action, v.vesselId, v.workbookId, v.changes, v.draft]), rejected,
  })).digest("hex").slice(0, 16)
  return { sha256: book.sha256, fileName, problems: book.problems, rejected, exceptions: built.exceptions, vessels, counts, previewHash }
}

export class ImportRefused extends Error {}

export type CommitOptions = {
  approve: string
  by: string
  /** Replace VERIFIED values the workbook changes (otherwise they are kept and listed as skipped). */
  overrideVerified?: { reason: string }
  now?: () => string
}

/** Write a reviewed plan. Refused unless the hash matches a fresh plan of the same workbook against the current master. */
export async function commitImport(store: MasterStore, book: ParsedWorkbook, fileName: string, legacyNames: readonly string[], options: CommitOptions) {
  const now = options.now ?? (() => new Date().toISOString())
  return store.transaction(async (tx) => {
    const plan = planImport(book, fileName, await tx.listVessels(), legacyNames)
    if (plan.problems.length) throw new ImportRefused(`The workbook has structural problems: ${plan.problems.join(" ")}`)
    if (plan.previewHash !== options.approve) {
      throw new ImportRefused(`The approved preview (${options.approve}) no longer matches (now ${plan.previewHash}): the workbook or the master changed. Run the check again and review it.`)
    }
    const at = now()
    const importId = randomUUID()
    const skippedVerified: ImportRecord["skippedVerified"] = []
    let written = 0
    const record = (outcome: ImportRecord["outcome"]): ImportRecord => ({
      importId, sha256: plan.sha256, fileName, at, by: options.by, outcome, previewHash: plan.previewHash,
      counts: plan.counts, rejected: plan.rejected, exceptions: plan.exceptions, skippedVerified,
    })
    // An unchanged workbook writes nothing at all: no revision, no reference rows, no import record.
    if (plan.vessels.every((v) => v.action === "unchanged")) return record("no-change")

    for (const v of plan.vessels) {
      if (v.action === "unchanged") continue
      if (v.action === "create") {
        const doc: StoredVessel = { ...v.draft, vesselId: randomUUID(), revision: 1, org: "default", createdAt: at, updatedAt: at, updatedBy: options.by }
        await tx.insertVessel(doc)
        await tx.insertRevision({ vesselId: doc.vesselId, revision: 1, at, by: options.by, importId, reason: `Created from workbook ${fileName}`, changes: v.changes })
        written++
        continue
      }
      const current = (await tx.listVessels()).find((x) => x.vesselId === v.vesselId)!
      const fields = { ...current.fields }
      const applied: RevisionChange[] = []
      for (const change of v.changes) {
        if (change.verifiedOverwrite && !options.overrideVerified) {
          skippedVerified.push({ workbookId: v.workbookId, field: change.field })
          continue
        }
        fields[change.field] = v.draft.fields[change.field]
        applied.push({ field: change.field, before: change.before, after: change.after })
      }
      // Every change was a protected VERIFIED value and nothing else differs: no new revision.
      if (!applied.length && !v.identityChanged) continue
      const doc: StoredVessel = {
        ...current, ...Object.fromEntries((["name", "aliases", "legacyKeys", "imo", "fleetGroup", "activeStatus", "groupStatus", "performanceBasis", "sourceNote", "workbookId"] as const).map((k) => [k, v.draft[k]])),
        aliases: [...new Set([...current.aliases, ...v.draft.aliases])], legacyKeys: [...new Set([...current.legacyKeys, ...v.draft.legacyKeys])],
        fields, revision: current.revision + 1, updatedAt: at, updatedBy: options.by,
      }
      if (!(await tx.replaceVessel(doc, current.revision))) throw new ImportRefused(`${v.name} was changed while importing; nothing was written. Run the check again.`)
      const reason = `Updated from workbook ${fileName}${options.overrideVerified && applied.some((c) => v.changes.find((x) => x.field === c.field)?.verifiedOverwrite) ? `; VERIFIED values replaced: ${options.overrideVerified.reason}` : ""}`
      await tx.insertRevision({ vesselId: doc.vesselId, revision: doc.revision, at, by: options.by, importId, reason, changes: applied })
      written++
    }
    for (const s of book.sources) await tx.upsertReference("sources", String(s["Source ID"] ?? ""), { ...s, importId })
    for (const i of book.issues) await tx.upsertReference("issues", `DQ|${i["Issue ID"]}`, { ...i, importId })
    for (const [n, p] of book.physical.entries()) await tx.upsertReference("issues", `PV|${p["Vessel ID"]}|${n}`, { ...p, importId })

    const done = record(written ? "committed" : "no-change")
    await tx.insertImport(done)
    return done
  })
}
