// Approved reports are protected by the cloud (P0-2 of the 24 Nov 2026 audit): once the Fleet Manager has approved a
// report, it, its photos and its deletion are refused; the only way to change it is to withdraw the approval with a
// reason, which keeps the approved version. Simulated devices sync with an in-memory cloud that applies the API's
// rules (tests/report-cloud.helpers.ts).

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createEmptyReport, type Report } from "../lib/form-schema"
import {
  canonical,
  checkReopenReason,
  planPhotoDelete,
  planPhotoSave,
  planReopen,
  planReportDelete,
  planReportSave,
  sameReportContent,
} from "../lib/report-write"
import { ID, approveOn, twoDevicesSharingAReport } from "./report-cloud.helpers"

function report(patch: Partial<Report> = {}, updatedAt = 100): Report {
  return { ...createEmptyReport(ID), createdAt: 1, updatedAt, ...patch }
}
const approvedSignoff = { superintendentSignature: "s", inspectorSignature: "", superintendentName: "", fleetManagerName: "Vijoy Dick", fleetManagerDate: "2026-11-20", fleetManagerSignature: "data:image/png;base64,SIG=" }
const approved = (patch: Partial<Report> = {}, updatedAt = 100) => report({ signoff: approvedSignoff, ...patch }, updatedAt)
const doc = (r: Report) => r as unknown as Record<string, unknown> & { updatedAt: number }

// ---------------------------------------------------------------- the rules

describe("approved-report rules", () => {
  test("a change to an approved report is refused, naming who approved it and when", () => {
    const plan = planReportSave({ stored: doc(approved()), incoming: doc(approved({ details: { port: "Changed" } }, 200)), baseUpdatedAt: 100 })
    assert.deepEqual(plan, { action: "locked", serverUpdatedAt: 100, approvedBy: "Vijoy Dick", approvedOn: "2026-11-20" })
  })

  test("removing the approval by a normal save is refused (it must be withdrawn with a reason)", () => {
    const unsigned = approved({ signoff: { ...approvedSignoff, fleetManagerSignature: "" } }, 200)
    assert.equal(planReportSave({ stored: doc(approved()), incoming: doc(unsigned), baseUpdatedAt: 100 }).action, "locked")
  })

  test("re-sending an approved report with nothing changed is accepted", () => {
    assert.deepEqual(planReportSave({ stored: doc(approved()), incoming: doc(approved({}, 200)), baseUpdatedAt: 100 }), { action: "touch", approves: false })
  })

  test("the save that approves a draft is accepted and marked as the approval", () => {
    assert.deepEqual(planReportSave({ stored: doc(report()), incoming: doc(approved({}, 200)), baseUpdatedAt: 100 }), { action: "write", approves: true })
    assert.deepEqual(planReportSave({ stored: null, incoming: doc(approved()) }), { action: "insert", approves: true })
    assert.deepEqual(planReportSave({ stored: doc(report()), incoming: doc(report({ details: { port: "X" } }, 200)), baseUpdatedAt: 100 }), {
      action: "write",
      approves: false,
    })
  })

  test("a conflict is still reported first", () => {
    assert.equal(planReportSave({ stored: doc(approved({}, 150)), incoming: doc(approved({ details: { port: "X" } }, 200)), baseUpdatedAt: 100 }).action, "conflict")
  })

  test("content is compared regardless of key order, and sections a request leaves out are not compared", () => {
    assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }))
    const stored = doc(approved({ narratives: { preamble: undefined } }))
    const incoming = doc(approved({}, 200))
    delete (incoming as Record<string, unknown>).narratives
    assert.equal(sameReportContent(stored, incoming), true)
  })

  test("withdrawing: only an approved report, from a copy based on the cloud's version, with a reason", () => {
    assert.equal(planReopen(null), "not-found")
    assert.equal(planReopen(doc(report())), "not-approved")
    assert.equal(planReopen(doc(approved()), 90), "stale")
    assert.equal(planReopen(doc(approved()), 100), "reopen")
    assert.ok("error" in checkReopenReason("typo"))
    assert.ok("error" in checkReopenReason("x".repeat(1001)))
    assert.deepEqual(checkReopenReason("  Wrong running hours  "), { reason: "Wrong running hours" })
  })

  test("deleting and photos: refused for an approved report", () => {
    assert.equal(planReportDelete(null), "absent")
    assert.equal(planReportDelete(doc(report())), "delete")
    assert.equal(planReportDelete(doc(approved())), "locked")
    const photo = { id: "p1", reportId: ID, category: "Main deck", caption: "A", includeInOwnerReport: true, dataUrl: "data:image/png;base64,AA==" }
    assert.equal(planPhotoSave(doc(report()), null, photo), "write")
    assert.equal(planPhotoSave(doc(approved()), null, photo), "locked")
    assert.equal(planPhotoSave(doc(approved()), photo, { ...photo }), "unchanged")
    assert.equal(planPhotoSave(doc(approved()), photo, { ...photo, caption: "B" }), "locked")
    assert.equal(planPhotoDelete(doc(approved())), "locked")
    assert.equal(planPhotoDelete(doc(report())), "delete")
  })
})

// ---------------------------------------------------------------- with devices

/** A approves the report and syncs; B fetches the approved version. */
async function approvedOnBothDevices() {
  const setup = await twoDevicesSharingAReport()
  const { cloud, a, b } = setup
  a.advance(1_000)
  approveOn(a)
  assert.equal(await a.engine.syncReport(ID), "synced")
  assert.ok(cloud.audit.some((e) => e.action === "approve"), "the approval is recorded")
  await b.engine.syncAll()
  assert.equal(b.report().signoff.fleetManagerSignature, "data:image/png;base64,SIG=")
  return setup
}

/** B changes the approved report (the editor prevents this; an older tab or a refused conflict choice can still do it). */
async function refusedChangeOnB() {
  const setup = await approvedOnBothDevices()
  const { cloud, b } = setup
  b.advance(5_000)
  b.edit((r) => void (r.particulars.yearBuilt = "2011"))
  assert.equal(await b.engine.syncReport(ID), "locked")
  assert.equal(cloud.reports.get(ID)!.particulars.yearBuilt, undefined, "the approved report is unchanged")
  return setup
}

describe("approved reports with devices", () => {
  test("a change is refused, kept on the device, and not replaced by the next fetch", async () => {
    const { cloud, b } = await refusedChangeOnB()
    assert.equal(b.state().locked?.approvedBy, "Vijoy Dick")
    await b.engine.syncAll()
    assert.equal(b.report().particulars.yearBuilt, "2011", "B's change is still on B")
    assert.ok(cloud.audit.some((e) => e.action === "change-refused"))
  })

  test("a refused conflict choice ends in the same protected state", async () => {
    const { cloud, a, b } = await twoDevicesSharingAReport()
    b.advance(500)
    b.edit((r) => void (r.details.port = "Port by B")) // B works on a draft, not yet sent
    a.advance(1_000)
    approveOn(a) // meanwhile A approves
    await a.engine.syncAll()
    assert.equal(await b.engine.syncReport(ID), "conflict")
    assert.equal((await b.engine.resolveSyncConflict(ID, "local")).result, "locked")
    assert.ok(cloud.reports.get(ID)!.signoff.fleetManagerSignature, "still approved")
    assert.equal(cloud.reports.get(ID)!.details.port, "Singapore")
  })

  test("re-sending the approved report unchanged does not lock it", async () => {
    const { a } = await approvedOnBothDevices()
    a.advance(100)
    a.edit(() => {}) // a new timestamp, nothing changed
    assert.equal(await a.engine.syncReport(ID), "synced")
    assert.equal(a.state().locked, undefined)
  })

  test("withdraw and save my changes: the approved version is kept, the changes reach the cloud, approval is needed again", async () => {
    const { cloud, b } = await refusedChangeOnB()
    const outcome = await b.engine.withdrawApproval(ID, "Year of build was wrong")
    assert.deepEqual(outcome, { result: "synced", withdrawn: "cloud" })
    const now = cloud.reports.get(ID)!
    assert.equal(now.particulars.yearBuilt, "2011")
    assert.equal(now.signoff.fleetManagerSignature, "", "the Fleet Manager must sign again")
    assert.equal(now.signoff.fleetManagerName, "Vijoy Dick")
    assert.equal(cloud.revisions.length, 1)
    assert.equal(cloud.revisions[0].reason, "Year of build was wrong")
    assert.equal(cloud.revisions[0].report.signoff.fleetManagerSignature, "data:image/png;base64,SIG=", "the approved version is kept as it was")
    assert.equal(cloud.revisions[0].report.particulars.yearBuilt, undefined)
    assert.deepEqual(b.state(), { base: b.state().base }, "no lock or conflict left")
  })

  test("withdraw on the device that approved (nothing changed yet): the report becomes a draft again", async () => {
    const { cloud, a } = await approvedOnBothDevices()
    assert.deepEqual(await a.engine.withdrawApproval(ID, "Fleet Manager asked for the crew section to be expanded"), { result: "synced", withdrawn: "cloud" })
    assert.equal(cloud.reports.get(ID)!.signoff.fleetManagerSignature, "")
    assert.equal(a.report().signoff.fleetManagerSignature, "")
    assert.equal(cloud.revisions.length, 1)
    a.advance(10_000)
    a.edit((r) => void (r.management.crew = "Expanded"))
    assert.equal(await a.engine.syncReport(ID), "synced", "the draft can be edited and saved again")
  })

  test("withdrawing needs a reason; without one nothing changes", async () => {
    const { cloud, a } = await approvedOnBothDevices()
    await assert.rejects(a.engine.withdrawApproval(ID, "no"), /reason/)
    assert.ok(cloud.reports.get(ID)!.signoff.fleetManagerSignature)
    assert.equal(cloud.revisions.length, 0)
  })

  test("withdrawing from an out-of-date copy is a conflict, not a withdrawal", async () => {
    const { cloud, a, b } = await approvedOnBothDevices()
    await a.engine.withdrawApproval(ID, "Correct the crew list")
    a.advance(10_000)
    approveOn(a) // approved again, with a later version
    a.edit((r) => void (r.management.crew = "Corrected"))
    await a.engine.syncAll()
    // B still holds the first approved version
    const outcome = await b.engine.withdrawApproval(ID, "Another correction")
    assert.deepEqual(outcome, { result: "conflict", withdrawn: null })
    assert.equal(cloud.revisions.length, 1, "nothing withdrawn")
  })

  test("an approval that never reached the cloud is withdrawn on the device", async () => {
    const { cloud, a } = await twoDevicesSharingAReport()
    a.advance(1_000)
    approveOn(a) // approved on A, not yet sent
    assert.deepEqual(await a.engine.withdrawApproval(ID, "Signed by mistake"), { result: "synced", withdrawn: "device" })
    assert.equal(a.report().signoff.fleetManagerSignature, "")
    assert.equal(cloud.reports.get(ID)!.signoff.fleetManagerSignature ?? "", "")
    assert.equal(cloud.revisions.length, 0)
  })

  test("keep both: the changes become a separate draft without the Fleet Manager's signature; the original stays approved", async () => {
    const { cloud, b } = await refusedChangeOnB()
    const { result, copyId } = await b.engine.resolveSyncConflict(ID, "both")
    assert.equal(result, "synced")
    assert.equal(b.report(copyId!).particulars.yearBuilt, "2011")
    assert.equal(b.report(copyId!).signoff.fleetManagerSignature, "")
    assert.equal(b.report().particulars.yearBuilt, undefined)
    assert.ok(b.report().signoff.fleetManagerSignature)
    await b.engine.syncAll()
    assert.equal(cloud.reports.get(copyId!)!.particulars.yearBuilt, "2011")
    assert.ok(cloud.reports.get(ID)!.signoff.fleetManagerSignature, "the original is still approved in the cloud")
  })

  test("discard my changes: the device shows the approved version again", async () => {
    const { b } = await refusedChangeOnB()
    await b.engine.resolveSyncConflict(ID, "cloud")
    assert.equal(b.report().particulars.yearBuilt, undefined)
    assert.equal(b.state().locked, undefined)
  })

  test("'use this device's version' is not possible for an approved report", async () => {
    const { b } = await refusedChangeOnB()
    await assert.rejects(b.engine.resolveSyncConflict(ID, "local"), /Withdraw the approval/)
  })

  test("a photo added to an approved report is refused and kept on the device", async () => {
    const { cloud, b } = await approvedOnBothDevices()
    b.addPhoto("photoB00000001", "added after approval")
    assert.equal(await b.engine.syncReport(ID), "locked")
    assert.equal(cloud.photos.has("photoB00000001"), false)
    assert.ok(b.photos.has("photoB00000001"))
  })

  test("an approved report cannot be deleted; it comes back to the device on the next sync", async () => {
    const { cloud, a } = await approvedOnBothDevices()
    a.deleteLocally()
    await a.engine.syncAll()
    assert.ok(cloud.reports.has(ID), "still in the cloud")
    assert.deepEqual(a.pending(), [], "the device stops asking")
    assert.ok(a.reports.has(ID), "fetched back to the device")
    assert.ok(cloud.audit.some((e) => e.action === "change-refused" && e.detail === "delete"))
  })

  test("a deleted draft is kept in the cloud's deleted store", async () => {
    const { cloud, a } = await twoDevicesSharingAReport()
    a.deleteLocally()
    await a.engine.syncAll()
    assert.equal(cloud.reports.has(ID), false)
    assert.equal(cloud.deleted.length, 1)
    assert.equal(cloud.deleted[0].details.port, "Singapore")
  })
})
