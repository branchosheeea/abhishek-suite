// "Verify on board" (lib/vessel-master/verify.ts): a Superintendent's check against a ship's document makes the master
// value VERIFIED at once, with evidence; safeguards for VERIFIED and identity values; later imports keep it; the
// report where it was verified takes the verified value. Synthetic vessels only.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createNewReport } from "../lib/form-schema"
import { applyVerification, originOf, selectVessel } from "../lib/particulars"
import { AppError } from "../lib/server/errors"
import { commitImport, planImport, type StoredVessel } from "../lib/vessel-master/import"
import { buildMaster } from "../lib/vessel-master/rules"
import { verificationFrom, verifiedOnBoard } from "../lib/vessel-master/verify"
import { vesselView } from "../lib/vessel-master/view"
import { readWorkbook } from "../lib/vessel-master/workbook"
import { fullSources, memoryStore, vessel, workbook } from "./vessel-master.helpers"

const imo = (six: string) => six + String([...six].reduce((n, d, i) => n + Number(d) * (7 - i), 0) % 10)
const A = imo("900001")
const WHO = { sub: "supt@example.com", name: "Test Superintendent" }
const NOW = new Date("2026-11-24T10:00:00Z")
const EVIDENCE = { documentType: "Certificate of Registry", documentRef: "REG-123", documentDate: "2025-01-10" }

/** TEST A with registry values only PROVISIONAL and an orange MCR. */
const book = () => workbook({ vessels: [{ values: vessel("TA", "Test A", A, { "Registry Status": "PROVISIONAL" }), orange: ["MCR (kW)"] }], sources: fullSources("TA") })
async function stored(): Promise<StoredVessel> {
  const [draft] = buildMaster(await readWorkbook(await book()), ["TEST A", "TEST Z"]).vessels
  return { ...draft, vesselId: "0b9e4c1a-1111-4222-8333-944455556666", revision: 3, org: "default", createdAt: "t", updatedAt: "t", updatedBy: "import" }
}
const refused = (fn: () => unknown, status: number, pattern: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof AppError && e.status === status && pattern.test(e.message))

describe("verifying a value on board", () => {
  test("the value becomes VERIFIED and filled, with the evidence, a new revision and a record", async () => {
    const v = await stored()
    assert.equal(v.fields.flag.status, "PROVISIONAL")
    const { doc, revision, verification, field } = verificationFrom({ field: "flag", value: "Testland", ...EVIDENCE, note: "Original sighted" }, v, WHO, NOW)
    assert.deepEqual([field.status, field.release, field.value, field.physicalVerification], ["VERIFIED", "fill", "Testland", false])
    assert.match(field.reasons[0], /Verified on board by Test Superintendent on 2026-11-24 against Certificate of Registry REG-123 dated 2025-01-10\. Original sighted/)
    assert.ok(verifiedOnBoard(field))
    assert.deepEqual([doc.revision, revision.revision, doc.updatedBy], [4, 4, "Test Superintendent"])
    assert.deepEqual(revision.changes[0].before, { value: "Testland", status: "PROVISIONAL", release: "offer" })
    assert.deepEqual([verification.by, verification.documentRef, verification.before.status, verification.reportId], [WHO.sub, "REG-123", "PROVISIONAL", null])
  })

  test("a value awaiting physical verification can be verified, and corrected, with the document's figure", async () => {
    const v = await stored()
    assert.equal(v.fields.mcr_kw.release, "withhold")
    const { field } = verificationFrom({ field: "mcr_kw", value: "20,500", documentType: "EIAPP certificate / NOx Technical File", documentRef: "EIAPP-9" }, v, WHO, NOW)
    assert.deepEqual([field.value, field.raw, field.status, field.release], [20500, "20,500", "VERIFIED", "fill"])
    assert.match(field.reasons[0], /\(was 20,000 kW\)/)
  })

  test("evidence is required and checked", async () => {
    const v = await stored()
    refused(() => verificationFrom({ field: "flag", value: "Testland", documentType: "Certificate of Registry" }, v, WHO, NOW), 400, /reference is required/)
    refused(() => verificationFrom({ field: "flag", value: "Testland", documentRef: "X" }, v, WHO, NOW), 400, /Document is required/)
    refused(() => verificationFrom({ field: "flag", ...EVIDENCE }, v, WHO, NOW), 400, /Verified value is required/)
    refused(() => verificationFrom({ field: "loa_m", value: "long", ...EVIDENCE }, v, WHO, NOW), 400, /not a number/)
    refused(() => verificationFrom({ field: "flag", value: "Testland", ...EVIDENCE, documentDate: "2099-01-01" }, v, WHO, NOW), 400, /future/)
    refused(() => verificationFrom({ field: "colour", value: "x", ...EVIDENCE }, v, WHO, NOW), 400, /not a Vessel Master field/)
    refused(() => verificationFrom({ field: "flag", value: "Testland", ...EVIDENCE }, v, { sub: "", name: "" }, NOW), 401, /Sign in/)
  })

  test("a VERIFIED value can be confirmed but not changed; the vessel name and IMO can only be confirmed", async () => {
    const v = await stored()
    assert.equal(v.fields.loa_m.status, "VERIFIED")
    refused(() => verificationFrom({ field: "loa_m", value: "331", ...EVIDENCE }, v, WHO, NOW), 409, /already VERIFIED as 330 m.*Report issue/)
    assert.equal(verificationFrom({ field: "loa_m", value: "330", ...EVIDENCE }, v, WHO, NOW).field.status, "VERIFIED")
    refused(() => verificationFrom({ field: "imo", value: imo("900002"), ...EVIDENCE }, v, WHO, NOW), 409, /identifies the vessel/)
    refused(() => verificationFrom({ field: "vessel_name", value: "Test B", ...EVIDENCE }, v, WHO, NOW), 409, /identifies the vessel/)
    assert.equal(verificationFrom({ field: "imo", value: A, ...EVIDENCE }, v, WHO, NOW).field.status, "VERIFIED")
  })

  test("a name-only record has nothing to verify; a master-only value stays out of reports", async () => {
    const [, nameOnly] = buildMaster(await readWorkbook(await book()), ["TEST A", "TEST Z"]).vessels
    refused(() => verificationFrom({ field: "flag", value: "X", ...EVIDENCE }, { ...nameOnly, vesselId: "x", revision: 1, org: "", createdAt: "", updatedAt: "", updatedBy: "" }, WHO, NOW), 409, /no Vessel Master particulars/)
    const v = await stored()
    assert.equal(verificationFrom({ field: "statutory_power_kw", value: "19000", ...EVIDENCE }, v, WHO, NOW).field.release, "master-only")
  })
})

describe("later workbook imports", () => {
  async function importedThenVerified(value: string) {
    const store = memoryStore()
    const parsed = await readWorkbook(await book())
    const plan = planImport(parsed, "t.xlsx", [], ["TEST A"])
    await commitImport(store, parsed, "t.xlsx", ["TEST A"], { approve: plan.previewHash, by: "import" })
    const v = store.state().vessels[0]
    store.state().vessels[0] = verificationFrom({ field: "flag", value, ...EVIDENCE }, v, WHO, NOW).doc
    return { store, parsed }
  }

  test("keep a value verified on board while the workbook has the same value (no downgrade, no new revision)", async () => {
    const { store, parsed } = await importedThenVerified("Testland")
    const plan = planImport(parsed, "t.xlsx", await store.listVessels(), ["TEST A"])
    assert.deepEqual([plan.counts.unchanged, plan.counts.update], [1, 0])
    assert.equal((await commitImport(store, parsed, "t.xlsx", ["TEST A"], { approve: plan.previewHash, by: "import" })).outcome, "no-change")
    assert.equal(store.state().vessels[0].fields.flag.status, "VERIFIED")
  })

  test("keep a value corrected on board unless the import explicitly overrides it", async () => {
    const { store, parsed } = await importedThenVerified("Newland")
    const revisions = store.state().revisions.length
    const plan = planImport(parsed, "t.xlsx", await store.listVessels(), ["TEST A"])
    assert.equal(plan.counts.verifiedOverwrites, 1)
    const record = await commitImport(store, parsed, "t.xlsx", ["TEST A"], { approve: plan.previewHash, by: "import" })
    assert.deepEqual(record.skippedVerified, [{ workbookId: "TA", field: "flag" }])
    assert.equal(store.state().vessels[0].fields.flag.value, "Newland")
    assert.equal(store.state().revisions.length, revisions, "nothing else changed, so no new revision")
  })
})

describe("the report where it was verified", () => {
  test("takes the verified value, filled from the master", async () => {
    const v = await stored()
    let r = selectVessel(createNewReport("r1234567890"), { kind: "view", view: vesselView(v), source: "master", fetchedAt: "t" }, "S", "t")
    assert.equal(r.particulars.flag, undefined, "offered before")
    const after = vesselView(verificationFrom({ field: "flag", value: "Testland", ...EVIDENCE }, v, WHO, NOW).doc)
    const field = after.groups[0].fields.find((f) => f.key === "flag")!
    r = applyVerification(r, "flag", field, "S", "t2")
    assert.equal(r.particulars.flag, "Testland")
    assert.equal(originOf(r, "flag"), "master")
    assert.equal(r.vesselSnapshot!.fields.flag.status, "VERIFIED")
    assert.deepEqual(r.vesselSnapshot!.history.at(-1), { at: "t2", by: "S", action: "verified", masterRevision: 3, changed: ["flag"] })
  })
})
