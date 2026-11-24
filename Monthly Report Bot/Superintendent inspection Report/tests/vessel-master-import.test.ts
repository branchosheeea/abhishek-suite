// Vessel Master import (lib/vessel-master/import.ts): preview, approval by hash, one transaction, no-op re-imports,
// protected VERIFIED values, rollback, concurrent commits and identity conflicts. In-memory store with the database's
// rules; synthetic workbooks only.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { commitImport, ImportRefused, planImport } from "../lib/vessel-master/import"
import { readWorkbook } from "../lib/vessel-master/workbook"
import { fullSources, memoryStore, vessel, workbook, type TestVessel } from "./vessel-master.helpers"

const imo = (six: string) => six + String([...six].reduce((n, d, i) => n + Number(d) * (7 - i), 0) % 10)
const A = imo("900001"), B = imo("900002"), C = imo("900003")
const BY = "test@example.com"

async function book(vessels: TestVessel[], extra: Omit<Parameters<typeof workbook>[0], "vessels"> = {}) {
  const ids = vessels.map((v) => String(v.values["Vessel ID"]))
  return readWorkbook(await workbook({ sources: ids.flatMap((id) => fullSources(id)), ...extra, vessels }))
}

/** Preview, then commit with that preview's hash (the reviewed path). */
async function importBook(store: ReturnType<typeof memoryStore>, b: Awaited<ReturnType<typeof book>>, legacy: string[] = [], over: { overrideVerified?: { reason: string } } = {}) {
  const plan = planImport(b, "test.xlsx", await store.listVessels(), legacy)
  return { plan, record: await commitImport(store, b, "test.xlsx", legacy, { approve: plan.previewHash, by: BY, ...over }) }
}

describe("import preview and commit", () => {
  test("a first import creates each vessel at revision 1, with its revision, reference rows and import record", async () => {
    const store = memoryStore()
    const b = await book([{ values: vessel("TA", "Test A", A) }, { values: vessel("TB", "Test B", B) }], {
      issues: [{ "Issue ID": "DQ-T1", "Vessel ID": "TA", Field: "Flag", "Disposition for SIR Autofill": "Allow", Status: "Open" }],
    })
    const before = planImport(b, "test.xlsx", [], [])
    assert.equal(before.counts.create, 2)
    assert.equal(store.state().vessels.length, 0, "the preview writes nothing")

    const { record } = await importBook(store, b)
    assert.equal(record.outcome, "committed")
    const s = store.state()
    assert.equal(s.vessels.length, 2)
    assert.ok(s.vessels.every((v) => v.revision === 1 && v.vesselId && v.updatedBy === BY))
    assert.equal(s.revisions.length, 2)
    assert.equal(s.imports.length, 1)
    assert.equal(s.imports[0].sha256, b.sha256)
    assert.ok(s.refs.has("issues|DQ|DQ-T1"))
    assert.ok([...s.refs.keys()].some((k) => k.startsWith("sources|SRC-TA-")))
  })

  test("re-importing the same workbook is a no-op: no revisions, no import record", async () => {
    const store = memoryStore()
    const b = await book([{ values: vessel("TA", "Test A", A) }])
    await importBook(store, b)
    const snapshot = structuredClone({ vessels: store.state().vessels, revisions: store.state().revisions, imports: store.state().imports })

    const { plan, record } = await importBook(store, b)
    assert.equal(plan.counts.unchanged, 1)
    assert.equal(plan.counts.create + plan.counts.update, 0)
    assert.equal(record.outcome, "no-change")
    assert.deepEqual({ vessels: store.state().vessels, revisions: store.state().revisions, imports: store.state().imports }, snapshot)
  })

  test("a changed value updates the record, bumps its revision and records before and after", async () => {
    const store = memoryStore()
    await importBook(store, await book([{ values: vessel("TA", "Test A", A, { "Performance Status": "PROVISIONAL" }) }]))
    const { plan } = await importBook(store, await book([{ values: vessel("TA", "Test A", A, { "Performance Status": "PROVISIONAL", "Service Speed Laden (kn)": 13.9 }) }]))
    const change = plan.vessels[0].changes.find((c) => c.field === "service_speed_laden_kn")!
    assert.equal(change.kind, "update")
    assert.equal(change.verifiedOverwrite, false)
    const v = store.state().vessels[0]
    assert.equal(v.revision, 2)
    assert.equal(v.fields.service_speed_laden_kn.value, 13.9)
    const rev = store.state().revisions.find((r) => r.revision === 2)!
    assert.deepEqual(rev.changes.find((c) => c.field === "service_speed_laden_kn")?.before?.value, 14.5)
  })

  test("a VERIFIED value is kept unless the import explicitly overrides it with a reason", async () => {
    const store = memoryStore()
    await importBook(store, await book([{ values: vessel("TA", "Test A", A) }]))
    assert.equal(store.state().vessels[0].fields.loa_m.status, "VERIFIED", "fixture: LOA is VERIFIED")

    const changed = await book([{ values: vessel("TA", "Test A", A, { "LOA (m)": 331 }) }])
    const { plan, record } = await importBook(store, changed)
    assert.equal(plan.counts.verifiedOverwrites, 1)
    assert.deepEqual(record.skippedVerified, [{ workbookId: "TA", field: "loa_m" }])
    assert.equal(store.state().vessels[0].fields.loa_m.value, 330, "kept")

    const { record: forced } = await importBook(store, changed, [], { overrideVerified: { reason: "Load line certificate re-issued" } })
    assert.deepEqual(forced.skippedVerified, [])
    assert.equal(store.state().vessels[0].fields.loa_m.value, 331)
    assert.match(store.state().revisions.at(-1)!.reason, /VERIFIED values replaced: Load line certificate re-issued/)
  })

  test("a commit is refused unless its hash matches a fresh preview; a structurally broken workbook is refused", async () => {
    const store = memoryStore()
    const b = await book([{ values: vessel("TA", "Test A", A) }])
    await assert.rejects(commitImport(store, b, "test.xlsx", [], { approve: "0000000000000000", by: BY }), ImportRefused)

    // Reviewed against an empty master; the master then changes, so the old preview no longer describes the commit.
    const stale = planImport(b, "test.xlsx", [], [])
    await importBook(store, await book([{ values: vessel("TB", "Test B", B) }]))
    await assert.rejects(commitImport(store, b, "test.xlsx", [], { approve: stale.previewHash, by: BY }), /no longer matches/)

    const broken = await readWorkbook(await workbook({ vessels: [{ values: vessel("TC", "Test C", C) }], omitSheet: "Source_Register" }))
    const p = planImport(broken, "x.xlsx", [], [])
    await assert.rejects(commitImport(store, broken, "x.xlsx", [], { approve: p.previewHash, by: BY }), /structural problems/)
    assert.equal(store.state().vessels.length, 1)
  })

  test("a failure part-way through writes nothing", async () => {
    const store = memoryStore()
    const b = await book([{ values: vessel("TA", "Test A", A) }, { values: vessel("TB", "Test B", B) }])
    const plan = planImport(b, "test.xlsx", [], [])
    store.failAfter(3)
    await assert.rejects(commitImport(store, b, "test.xlsx", [], { approve: plan.previewHash, by: BY }), /simulated failure/)
    const s = store.state()
    assert.deepEqual([s.vessels.length, s.revisions.length, s.imports.length, s.refs.size], [0, 0, 0, 0])
    // And the same approval then succeeds.
    await commitImport(store, b, "test.xlsx", [], { approve: plan.previewHash, by: BY })
    assert.equal(store.state().vessels.length, 2)
  })

  test("two concurrent commits of the same preview produce one result", async () => {
    const store = memoryStore()
    const b = await book([{ values: vessel("TA", "Test A", A) }])
    const plan = planImport(b, "test.xlsx", [], [])
    const results = await Promise.allSettled([1, 2].map(() => commitImport(store, b, "test.xlsx", [], { approve: plan.previewHash, by: BY })))
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
    assert.equal(store.state().vessels.length, 1)
    assert.equal(store.state().imports.length, 1)
  })
})

describe("identity", () => {
  test("an IMO that the master holds for another vessel, or a workbook ID with a different IMO, is refused", async () => {
    const store = memoryStore()
    await importBook(store, await book([{ values: vessel("TA", "Test A", A) }]))
    const { plan } = await importBook(store, await book([{ values: vessel("TA", "Test A", B) }, { values: vessel("TB", "Test B", A) }]))
    assert.equal(plan.counts.rejected, 2)
    assert.match(plan.rejected.map((r) => r.reasons.join(" ")).join(" | "), /IMO .* in the master but IMO/)
    assert.match(plan.rejected.map((r) => r.reasons.join(" ")).join(" | "), /Vessel ID TA\) in the master, not TB/)
    assert.equal(store.state().vessels.length, 1)
    assert.equal(store.state().vessels[0].imo, A)
  })

  test("NeraVeda's existing names link on the first import; one missing from the workbook is kept as identity-only", async () => {
    const store = memoryStore()
    const legacy = ["TEST A", "TEST Z"]
    await importBook(store, await book([{ values: vessel("TA", "Test A", A) }]), legacy)
    const s = store.state().vessels
    const a = s.find((v) => v.workbookId === "TA")!
    assert.equal(a.name, "TEST A")
    assert.deepEqual(a.legacyKeys, ["TEST_A"])
    const z = s.find((v) => v.name === "TEST Z")!
    assert.equal(z.workbookId, null)
    assert.ok(Object.entries(z.fields).every(([k, f]) => k === "vessel_name" || f.value === null), "no values invented")

    // Later the workbook lists it: matched once by its legacy name, then by ID and IMO.
    const { plan } = await importBook(store, await book([{ values: vessel("TA", "Test A", A) }, { values: vessel("TZ", "Test Z", C) }]), legacy)
    const zPlan = plan.vessels.find((v) => v.workbookId === "TZ")!
    assert.deepEqual([zPlan.action, zPlan.match, zPlan.vesselId], ["update", "legacy-name", z.vesselId])
    assert.equal(store.state().vessels.length, 2)
    assert.equal(store.state().vessels.find((v) => v.vesselId === z.vesselId)!.imo, C)
  })

  test("another fleet's vessel is added by data alone", async () => {
    const store = memoryStore()
    await importBook(store, await book([{ values: vessel("OM1", "Other Ship", A, { "Fleet Group": "Other Managed" }) }]))
    const v = store.state().vessels[0]
    assert.deepEqual([v.workbookId, v.fleetGroup, v.imo], ["OM1", "Other Managed", A])
    assert.equal(v.legacyKeys.length, 0)
  })
})
