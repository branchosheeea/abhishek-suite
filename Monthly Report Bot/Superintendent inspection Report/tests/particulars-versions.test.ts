// Principal Particulars in two versions (lib/particulars.ts): earlier reports keep their four typed groups exactly;
// new reports take a fixed snapshot of the Vessel Master. Synthetic vessels only.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { outstandingForReview } from "../lib/completeness"
import { PARTICULARS_GROUPS, createEmptyReport, createNewReport, sectionProgress, type Report } from "../lib/form-schema"
import { applyLinkedChange } from "../lib/linked-fields"
import {
  PARTICULARS_GROUPS_V2, applyRefresh, confirmOffer, hasReportContent, isV2, markFlagSent, originOf, particularsForPdf, particularsGroups,
  particularsOutstanding, pendingFlags, refreshPlan, selectOtherVessel, selectVessel, setParticular, v1ToV2,
} from "../lib/particulars"
import { planReportSave } from "../lib/report-write"
import type { StoredVessel } from "../lib/vessel-master/import"
import { buildMaster } from "../lib/vessel-master/rules"
import { vesselView, type VesselView } from "../lib/vessel-master/view"
import { readWorkbook } from "../lib/vessel-master/workbook"
import { fullSources, vessel, workbook } from "./vessel-master.helpers"

const imo = (six: string) => six + String([...six].reduce((n, d, i) => n + Number(d) * (7 - i), 0) % 10)
const A = imo("900001")
const ID = "0b9e4c1a-1111-4222-8333-944455556666"
const BY = "Test Superintendent"
const NOW = "2026-11-24T10:00:00.000Z"

/** A master view of TEST A: registry values only PROVISIONAL (so VERIFIED-only ones are offered), MCR orange (withheld). */
async function view(over: Parameters<typeof vessel>[3] = {}, revision = 1): Promise<VesselView> {
  const book = await readWorkbook(await workbook({
    vessels: [{ values: vessel("TA", "Test A", A, { "Registry Status": "PROVISIONAL", ...over }), orange: ["MCR (kW)"] }], sources: fullSources("TA"),
  }))
  const [draft] = buildMaster(book, ["TEST A"]).vessels
  const stored: StoredVessel = { ...draft, vesselId: ID, revision, org: "default", createdAt: NOW, updatedAt: NOW, updatedBy: "test" }
  return vesselView(stored)
}
const chosen = async (over: Parameters<typeof vessel>[3] = {}) =>
  selectVessel(createNewReport("r1234567890"), { kind: "view", view: await view(over), source: "master", fetchedAt: NOW, legacyKey: "TEST_A" }, BY, NOW)

describe("earlier reports keep their particulars exactly", () => {
  test("a report saved before the Vessel Master stays four-group, even merged over today's defaults", () => {
    const saved = { id: "old", details: { vessel: "DHT LEOPARD" }, particulars: { shipName: "DHT LEOPARD", imo: "9733961" } } as Partial<Report>
    const loaded = { ...createEmptyReport("old"), ...saved } as Report
    assert.equal(isV2(loaded), false)
    assert.equal(particularsGroups(loaded), PARTICULARS_GROUPS)
    assert.deepEqual(particularsOutstanding(loaded), PARTICULARS_GROUPS.flatMap((g) => g.fields).filter((f) => f.required && !loaded.particulars[f.key]).map((f) => f.label))
    assert.deepEqual(particularsForPdf(loaded).map((g) => [g.title, g.fields, g.values]), PARTICULARS_GROUPS.map((g) => [g.title, g.fields, loaded.particulars]))
    assert.equal(sectionProgress(loaded, 0).particulars.total, PARTICULARS_GROUPS.flatMap((g) => g.fields).length)
    // Vessel ⇄ Ship name linking unchanged.
    assert.equal(applyLinkedChange(loaded, "details", "vessel", "DHT LION").particulars.shipName, "DHT LION")
  })

  test("a new report uses the six Vessel Master groups", () => {
    const r = createNewReport("new")
    assert.equal(isV2(r), true)
    assert.equal(r.vesselSnapshot!.source, "none")
    assert.deepEqual(PARTICULARS_GROUPS_V2.map((g) => g.title?.slice(0, 1)), ["A", "B", "C", "D", "E", "F"])
    assert.equal(sectionProgress(r, 0).particulars.total, 38, "40 master fields less the two master-only ones")
    assert.deepEqual(particularsOutstanding(r).sort(), ["Classification Society", "Flag", "IMO Number", "Registered Owner", "Summer Deadweight", "Technical Manager", "Vessel Name", "Vessel Type", "Year Built"])
  })
})

describe("choosing a Vessel Master vessel", () => {
  test("released values are filled; VERIFIED-only provisional values are offered; withheld values stay empty", async () => {
    const r = await chosen()
    const s = r.vesselSnapshot!
    assert.deepEqual([r.details.vessel, r.details.vesselId, r.particulars.vessel_name], ["TEST A", "TEST_A", "TEST A"])
    assert.deepEqual([s.source, s.vesselId, s.masterRevision, s.capturedAt], ["master", ID, 1, NOW])
    assert.equal(r.particulars.loa_m, "330", "technical VERIFIED value filled")
    assert.equal(s.fields.flag.release, "offer")
    assert.equal(r.particulars.flag, undefined, "an offered value is not filled")
    assert.equal(s.fields.mcr_kw.release, "withhold")
    assert.equal(r.particulars.mcr_kw, undefined, "a withheld value is not filled")
    assert.equal(s.fields.mcr_kw.value, "20,000", "but the snapshot keeps it, with the reason")
    assert.equal(originOf(r, "loa_m"), "master")
    assert.deepEqual(s.history.map((h) => h.action), ["select"])
  })

  test("'Use this value' records the Superintendent's confirmation; changing it makes it their own entry", async () => {
    let r = confirmOffer(await chosen(), "flag", BY, NOW)
    assert.equal(r.particulars.flag, "Testland")
    assert.equal(originOf(r, "flag"), "confirmed")
    assert.deepEqual(r.vesselSnapshot!.confirmed.flag, { value: "Testland", by: BY, at: NOW })
    r = setParticular(r, "flag", "Liberia", BY, NOW)
    assert.equal(originOf(r, "flag"), "entered")
    assert.equal(r.vesselSnapshot!.confirmed.flag, undefined)
  })

  test("a mandatory value entered by hand is reported to the office once", async () => {
    let r = setParticular(await chosen(), "registered_owner", "Owner Two Inc.", BY, NOW)
    assert.deepEqual(r.vesselSnapshot!.entered.registered_owner, { by: BY, at: NOW, flag: "pending" })
    assert.deepEqual(pendingFlags(r), ["registered_owner"])
    r = markFlagSent(r, "registered_owner", "flag-1")
    assert.deepEqual(pendingFlags(r), [])
    r = setParticular(r, "registered_owner", "Owner Two Incorporated", BY, NOW)
    assert.equal(r.vesselSnapshot!.entered.registered_owner.flag, "sent", "not sent again")
    // Non-mandatory fields and values equal to the master's are not flagged.
    assert.deepEqual(pendingFlags(setParticular(r, "call_sign", "XYZ", BY, NOW)), [])
    assert.equal(setParticular(r, "loa_m", "330", BY, NOW).vesselSnapshot!.entered.loa_m, undefined)
  })

  test("the vessel name is the master's; Vessel in Inspection Details is the same", async () => {
    const r = await chosen()
    assert.equal(r.details.vessel, r.particulars.vessel_name)
    assert.equal(hasReportContent(r), false)
    assert.equal(hasReportContent({ ...r, summary: { overall: "Good" } }), true)
  })
})

describe("offline: pending particulars", () => {
  test("a vessel chosen with no saved copy waits, blocks approval, then fills without losing what was typed", async () => {
    let r = selectVessel(createNewReport("r1234567890"), { kind: "pending", vesselId: ID, name: "TEST A", imo: A }, BY, NOW)
    assert.equal(r.vesselSnapshot!.source, "pending")
    assert.deepEqual(r.particulars, { vessel_name: "TEST A" })
    assert.ok(particularsOutstanding(r).some((l) => /pending|Vessel Master/.test(l)))
    r = setParticular(r, "call_sign", "OWN1", BY, NOW)
    r = selectVessel(r, { kind: "view", view: await view(), source: "master", fetchedAt: NOW }, BY, NOW, true)
    assert.equal(r.vesselSnapshot!.source, "master")
    assert.equal(r.particulars.call_sign, "OWN1", "typed value kept")
    assert.equal(r.particulars.loa_m, "330", "master values filled")
    assert.ok(!particularsOutstanding(r).some((l) => /pending/.test(l)))
    assert.deepEqual(r.vesselSnapshot!.history.map((h) => h.action), ["select", "resolved"])
  })
})

describe("refresh from the Vessel Master", () => {
  test("a master change does not touch the report until Refresh is confirmed; then master values update and entries are kept", async () => {
    let r = await chosen()
    r = setParticular(r, "breadth_moulded_m", "60.5", BY, NOW)
    const before = structuredClone(r)
    const next = await view({ "LOA (m)": 331, "Breadth Moulded (m)": 61, "Depth Moulded (m)": null, "Service Speed Laden (kn)": 14.5 }, 2)
    assert.deepEqual(r, before, "nothing changes by itself")
    const plan = refreshPlan(r, next)
    const outcome = Object.fromEntries(plan.map((row) => [row.key, row.outcome]))
    assert.equal(outcome.loa_m, "updated")
    assert.equal(outcome.breadth_moulded_m, "kept")
    assert.equal(outcome.depth_moulded_m, "cleared")
    assert.equal(outcome.service_speed_laden_kn, undefined, "unchanged fields are not listed")
    r = applyRefresh(r, next, "master", NOW, BY, NOW)
    assert.deepEqual([r.particulars.loa_m, r.particulars.breadth_moulded_m, r.particulars.depth_moulded_m], ["331", "60.5", ""])
    assert.equal(r.vesselSnapshot!.masterRevision, 2)
    assert.deepEqual(r.vesselSnapshot!.history.at(-1)!.changed.sort(), ["breadth_moulded_m", "depth_moulded_m", "loa_m"])
  })
})

describe("a vessel not in the Vessel Master", () => {
  test("starts from blank particulars (none of the previous vessel's) and is renamed by typing", async () => {
    let r = setParticular(await chosen(), "call_sign", "OWN1", BY, NOW)
    r = selectOtherVessel(r, "", BY, NOW)
    assert.equal(r.vesselSnapshot!.source, "not-in-master")
    assert.deepEqual(r.particulars, { vessel_name: "" })
    r = applyLinkedChange(r, "details", "vessel", "MT OTHER")
    assert.deepEqual([r.details.vessel, r.particulars.vessel_name, r.vesselSnapshot!.name, r.details.vesselId], ["MT OTHER", "MT OTHER", "MT OTHER", "OTHER"])
    r = setParticular(r, "imo", "9999999", BY, NOW)
    assert.deepEqual(pendingFlags(r), [], "no master to report to")
  })

  test("an older report's particulars move to the six groups for the next inspection", () => {
    assert.deepEqual(v1ToV2({ shipName: "MT OTHER", owners: "O", managers: "M", deadweight: "300000", mcoPs: "1" }),
      { vessel_name: "MT OTHER", registered_owner: "O", technical_manager: "M", summer_dwt_mt: "300000" })
  })
})

describe("PDF, completeness and approved reports", () => {
  test("the PDF shows units and paired values as one phrase, and section F's basis as its first row", async () => {
    const r = await chosen()
    r.particulars.mcr_kw = "20,000"
    r.vesselSnapshot!.basisLabel = "Reference: shop test"
    const groups = particularsForPdf(r)
    assert.equal(groups.length, 6)
    const E = groups[4], F = groups[5]
    assert.equal(E.values.mcr_kw, "20,000 kW @ 60 rpm")
    assert.equal(E.values.ncr_kw, "17,000 kW @ 57 rpm")
    assert.ok(!E.fields.some((f) => f.key === "mcr_rpm"), "the rpm is part of the MCR row")
    assert.equal(F.values.fuel_laden_mt_day, "55 MT/day @ 14.5 kn")
    assert.equal(F.title, "F · Guaranteed / Reference Performance")
    assert.deepEqual([F.fields[0].label, F.values.basis], ["Basis", "Reference: shop test"])
    assert.equal(groups[3].values.loa_m, "330 m")
  })

  test("approval needs the six-group mandatory fields", async () => {
    const r = await chosen()
    const labels = outstandingForReview(r, 0).filter((o) => o.section === "particulars").map((o) => o.label).sort()
    // Flag and owner are VERIFIED-only, provisional here: offered, so still to confirm. The IMO (verified-or-provisional) is filled.
    assert.deepEqual(labels, ["Flag", "Registered Owner"])
    assert.equal(originOf(r, "imo"), "master")
  })

  test("an approved report's particulars snapshot cannot be changed on the server", async () => {
    const signoff = { superintendentSignature: "s", inspectorSignature: "", superintendentName: "", fleetManagerName: "FM", fleetManagerDate: "2026-11-20", fleetManagerSignature: "data:image/png;base64,SIG=" }
    const approved = { ...(await chosen()), signoff, updatedAt: 100 } as Report
    const changed = { ...approved, updatedAt: 200, vesselSnapshot: { ...approved.vesselSnapshot!, masterRevision: 9 } }
    const doc = (r: Report) => r as unknown as Record<string, unknown> & { updatedAt: number }
    assert.equal(planReportSave({ stored: doc(approved), incoming: doc(changed), baseUpdatedAt: 100 }).action, "locked")
    assert.equal(planReportSave({ stored: doc(approved), incoming: doc({ ...approved, updatedAt: 200 }), baseUpdatedAt: 100 }).action, "touch")
  })
})
