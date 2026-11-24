// The recovery-test comparison (lib/server/backup-compare.ts): a faithful restore passes; every kind of damage fails
// on the check that names it. In-memory data and temporary folders only.

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { ObjectId, type Document } from "mongodb"
import { compareInspections, formatComparison, type Collections } from "../lib/server/backup-compare"
import { backupDatabase, restoreSnapshot, snapshotDocuments } from "../lib/server/mongo-backup"

const temp = mkdtempSync(join(tmpdir(), "neraveda-backup-compare-"))
after(() => rmSync(temp, { recursive: true, force: true }))

const signed = { superintendentSignature: "s", inspectorSignature: "", superintendentName: "", fleetManagerName: "Vijoy Dick", fleetManagerDate: "2026-11-20", fleetManagerSignature: "data:image/png;base64,SIG=" }

function live(): Collections {
  return {
    reports: [
      { _id: new ObjectId("665f1c2b9d3e4a0012340001"), id: "report00000001", updatedAt: 100, details: { vessel: "DHT LEOPARD" }, particulars: { imo: "9384011", deadweight: "320000" }, signoff: signed },
      { _id: new ObjectId("665f1c2b9d3e4a0012340002"), id: "report00000002", updatedAt: 200, details: { vessel: "DHT TIGER" }, particulars: { imo: "9384023" }, signoff: { fleetManagerSignature: "" } },
    ],
    photos: [
      { _id: new ObjectId("665f1c2b9d3e4a0012340003"), id: "photo1", reportId: "report00000001", dataUrl: "data:image/png;base64,AA==" },
      { _id: new ObjectId("665f1c2b9d3e4a0012340004"), id: "photo2", reportId: "report00000002", dataUrl: "data:image/png;base64,BB==" },
    ],
    report_audit: [{ _id: new ObjectId("665f1c2b9d3e4a0012340005"), reportId: "report00000001", action: "approve", at: "2026-11-20T08:00:00Z" }],
  }
}

const clone = (c: Collections): Collections => structuredClone(c)
const failing = (c: Collections) => compareInspections(live(), c).checks.filter((x) => !x.pass).map((x) => x.name)

describe("recovery-test comparison", () => {
  test("a faithful restore through the real backup engine passes every check", async () => {
    const data = live()
    const folder = await backupDatabase(
      { collections: async () => Object.keys(data), documents: async function* (n) { yield* data[n] } },
      { dest: join(temp, "dest"), database: "inspections", now: new Date("2026-11-24T08:00:00Z") },
    )
    const restored: Collections = {}
    await restoreSnapshot(folder, {
      collections: async () => Object.keys(restored),
      insert: async (n, docs) => void (restored[n] = [...(restored[n] ?? []), ...docs]),
      count: async (n) => restored[n]?.length ?? 0,
    })
    const backup: Collections = {}
    for (const n of Object.keys(data)) backup[n] = [...snapshotDocuments(folder, n)] as Document[]
    const result = compareInspections(backup, restored)
    assert.equal(result.pass, true, formatComparison(result, "faithful restore"))
    assert.match(formatComparison(result, "t"), /RESULT: PASS/)
    assert.match(result.checks.find((c) => c.name.startsWith("Draft"))!.detail, /1 approved, 1 draft/)
  })

  test("a missing report fails the counts and the identical-documents check", () => {
    const c = clone(live())
    c.reports.pop()
    assert.deepEqual(failing(c).slice(0, 2), ["Document counts per collection", "Every document identical"])
  })

  test("changed vessel particulars fail the particulars check", () => {
    const c = clone(live())
    c.reports[0].particulars.deadweight = "319999"
    assert.ok(failing(c).includes("Vessel particulars and inspection details unchanged"))
  })

  test("a lost approval fails the status check", () => {
    const c = clone(live())
    c.reports[0].signoff = { ...signed, fleetManagerSignature: "" }
    assert.ok(failing(c).includes("Draft / approved status and sign-off preserved"))
  })

  test("a photo detached from its report, or a changed image, fails", () => {
    const detached = clone(live())
    detached.photos[0].reportId = "reportXXXXXXXX"
    assert.ok(failing(detached).includes("Photos belong to a restored report"))
    const changed = clone(live())
    changed.photos[1].dataUrl = "data:image/png;base64,CC=="
    assert.ok(failing(changed).includes("Photo images unchanged"))
  })

  test("a changed type (a date stored as text) is caught as a different document", () => {
    const c = clone(live())
    c.report_audit[0].at = new Date("2026-11-20T08:00:00Z")
    assert.ok(failing(c).includes("Every document identical"))
  })
})
