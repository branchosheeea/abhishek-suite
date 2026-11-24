// Compare a restored copy of the inspections database with the backup it came from (the recovery test in the SIR
// backup and recovery verification, 24 Nov 2026). Pure and read-only: it receives both sides as documents and says
// PASS only if every check holds. No Next.js or server-only imports, so it can be tested and used from scripts.

import { createHash } from "node:crypto"
import { BSON, type Document } from "mongodb"
import { isApproved } from "../completeness"
import type { Report } from "../form-schema"
import { canonical } from "../report-write"

export type Check = { name: string; pass: boolean; detail: string }
export type Comparison = { pass: boolean; checks: Check[] }
export type Collections = Record<string, Document[]>

/** A document's full content, in a form where equal documents give equal text (types and key order included). */
const fingerprint = (doc: Document) => canonical(BSON.EJSON.serialize(doc, { relaxed: false }))
const idOf = (doc: Document) => fingerprint({ _id: doc._id })
/** A field's value compared with its type: a backup read back exactly (e.g. numbers as Int32/Double) equals the database. */
const sha = (value: unknown) => createHash("sha256").update(fingerprint({ v: value }), "utf8").digest("hex")
const list = (items: string[], max = 5) => (items.length > max ? `${items.slice(0, max).join(", ")} and ${items.length - max} more` : items.join(", "))

export function compareInspections(backup: Collections, restored: Collections): Comparison {
  const checks: Check[] = []
  const names = [...new Set([...Object.keys(backup), ...Object.keys(restored)])].sort()

  // 1. Every collection has the same number of documents.
  const countDiffs = names.filter((n) => (backup[n]?.length ?? 0) !== (restored[n]?.length ?? 0))
  checks.push({
    name: "Document counts per collection",
    pass: countDiffs.length === 0,
    detail: countDiffs.length
      ? countDiffs.map((n) => `${n}: backup ${backup[n]?.length ?? 0}, restored ${restored[n]?.length ?? 0}`).join("; ")
      : names.map((n) => `${n} ${backup[n]?.length ?? 0}`).join(", "),
  })

  // 2. Every document is present and identical, field by field (types included).
  const contentDiffs: string[] = []
  for (const n of names) {
    const there = new Map((restored[n] ?? []).map((d) => [idOf(d), fingerprint(d)]))
    for (const doc of backup[n] ?? []) {
      const found = there.get(idOf(doc))
      if (found === undefined) contentDiffs.push(`${n} ${String(doc.id ?? doc._id)} missing`)
      else if (found !== fingerprint(doc)) contentDiffs.push(`${n} ${String(doc.id ?? doc._id)} differs`)
    }
  }
  checks.push({ name: "Every document identical", pass: contentDiffs.length === 0, detail: contentDiffs.length ? list(contentDiffs) : "all identical" })

  // 3. Photos stay with their reports, and each photo's image is unchanged.
  const reportIds = new Set((restored.reports ?? []).map((r) => String(r.id)))
  const orphans = (restored.photos ?? []).filter((p) => !reportIds.has(String(p.reportId))).map((p) => String(p.id))
  checks.push({
    name: "Photos belong to a restored report",
    pass: orphans.length === 0,
    detail: orphans.length ? `photos without their report: ${list(orphans)}` : `${restored.photos?.length ?? 0} photos, all with their report`,
  })
  const backupImages = new Map((backup.photos ?? []).map((p) => [String(p.id), sha(p.dataUrl)]))
  const imageDiffs = (restored.photos ?? []).filter((p) => backupImages.get(String(p.id)) !== sha(p.dataUrl)).map((p) => String(p.id))
  checks.push({ name: "Photo images unchanged", pass: imageDiffs.length === 0, detail: imageDiffs.length ? list(imageDiffs) : "all images identical" })

  // 4. Draft / approved status and sign-off preserved; 5. vessel particulars unchanged.
  const byId = (docs: Document[] = []) => new Map(docs.map((r) => [String(r.id), r]))
  const before = byId(backup.reports)
  const after = byId(restored.reports)
  const statusDiffs: string[] = []
  const particularsDiffs: string[] = []
  for (const [id, b] of before) {
    const a = after.get(id)
    if (!a) continue // reported by checks 1 and 2
    const same = isApproved(b as unknown as Report) === isApproved(a as unknown as Report) && sha(b.signoff) === sha(a.signoff) && sha(b.updatedAt) === sha(a.updatedAt)
    if (!same) statusDiffs.push(id)
    if (sha(b.particulars) !== sha(a.particulars) || sha(b.details) !== sha(a.details)) particularsDiffs.push(id)
  }
  const approved = [...after.values()].filter((r) => isApproved(r as unknown as Report)).length
  checks.push({
    name: "Draft / approved status and sign-off preserved",
    pass: statusDiffs.length === 0,
    detail: statusDiffs.length ? `differs for: ${list(statusDiffs)}` : `${approved} approved, ${after.size - approved} draft`,
  })
  checks.push({
    name: "Vessel particulars and inspection details unchanged",
    pass: particularsDiffs.length === 0,
    detail: particularsDiffs.length ? `differs for: ${list(particularsDiffs)}` : `${after.size} reports identical`,
  })

  return { pass: checks.every((c) => c.pass), checks }
}

/** The comparison as a short text report. */
export function formatComparison(result: Comparison, title: string): string {
  const lines = [title, ""]
  for (const c of result.checks) lines.push(`${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`)
  lines.push("", result.pass ? "RESULT: PASS" : "RESULT: FAIL")
  return lines.join("\n")
}
