// Vessel Master in the SIR: the six-group view of a master record, the "Report master data issue" rules, and the
// browser cache (network first, saved copy only when offline, never invented). Synthetic vessels only.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { AppError } from "../lib/server/errors"
import { networkFirst } from "../lib/vessel-cache"
import { FIELDS } from "../lib/vessel-master/fields"
import { flagFrom, VESSEL_ID_PATTERN } from "../lib/vessel-master/flags"
import type { StoredVessel } from "../lib/vessel-master/import"
import { buildMaster } from "../lib/vessel-master/rules"
import { formatValue, isSelectable, pairedDisplay, pickerEntry, vesselView } from "../lib/vessel-master/view"
import { readWorkbook } from "../lib/vessel-master/workbook"
import { fullSources, vessel, workbook } from "./vessel-master.helpers"

const imo = (six: string) => six + String([...six].reduce((n, d, i) => n + Number(d) * (7 - i), 0) % 10)
const A = imo("900001")
const ID = "0b9e4c1a-1111-4222-8333-944455556666"

async function stored(over: Parameters<typeof vessel>[3] = {}, legacy: string[] = ["TEST A", "TEST Z"]): Promise<StoredVessel[]> {
  const book = await readWorkbook(await workbook({ vessels: [{ values: vessel("TA", "Test A", A, over), orange: ["MCR (kW)"] }], sources: fullSources("TA") }))
  return buildMaster(book, legacy).vessels.map((d, i) => ({
    ...d, vesselId: i ? ID.replace("0b9e", "1b9e") : ID, revision: 1, org: "default", createdAt: "2026-11-24T00:00:00Z", updatedAt: "2026-11-24T00:00:00Z", updatedBy: "test",
  }))
}

describe("the SIR view of a master record", () => {
  test("six groups in order, master-only fields left out, NeraVeda's upper-case name", async () => {
    const [v] = await stored()
    const view = vesselView(v)
    assert.deepEqual(view.groups.map((g) => g.id), ["A", "B", "C", "D", "E", "F"])
    const keys = view.groups.flatMap((g) => g.fields.map((f) => f.key))
    assert.equal(keys.length, FIELDS.filter((f) => f.group).length)
    assert.ok(!keys.includes("statutory_power_kw") && !keys.includes("public_dwt_mt"))
    const name = view.groups[0].fields.find((f) => f.key === "vessel_name")!
    assert.deepEqual([name.value, name.display], ["TEST A", "TEST A"])
  })

  test("values are shown with separators and units; a year is not; blank stays blank", () => {
    assert.equal(formatValue("summer_dwt_mt", 299629, "MT"), "299,629 MT")
    assert.equal(formatValue("summer_draft_m", 21.622, "m"), "21.622 m")
    assert.equal(formatValue("year_built", 2016), "2016")
    assert.equal(formatValue("loa_m", null, "m"), "")
    assert.equal(formatValue("flag", "Marshall Islands"), "Marshall Islands")
  })

  test("paired values read as one phrase; the pair is dropped when blank", async () => {
    const [v] = await stored({ "NCR/CSR (rpm)": null })
    const view = vesselView(v)
    assert.equal(pairedDisplay(view, "mcr_kw"), "20,000 kW @ 60 rpm")
    assert.equal(pairedDisplay(view, "ncr_kw"), "17,000 kW")
    assert.equal(pairedDisplay(view, "fuel_laden_mt_day"), "55 MT/day @ 14.5 kn")
  })

  test("statuses and releases come from the master unchanged (an orange cell is withheld)", async () => {
    const [v] = await stored()
    const mcr = vesselView(v).groups.find((g) => g.id === "E")!.fields.find((f) => f.key === "mcr_kw")!
    assert.equal(mcr.physicalVerification, true)
    assert.equal(mcr.release, "withhold")
    assert.equal(mcr.status, v.fields.mcr_kw.status)
  })

  test("section F says Guaranteed only for a contractual basis whose values are VERIFIED", async () => {
    const [v] = await stored()
    const verified = { ...v, performanceBasis: "CONTRACTUAL" as const, fields: Object.fromEntries(Object.entries(v.fields).map(([k, f]) => [k, { ...f, status: "VERIFIED" as const }])) }
    assert.equal(vesselView(verified).basisLabel, "Guaranteed (shipbuilding contract)")
    const provisional = { ...verified, fields: { ...verified.fields, fuel_laden_mt_day: { ...verified.fields.fuel_laden_mt_day, status: "PROVISIONAL" as const } } }
    assert.match(vesselView(provisional).basisLabel!, /^Reference: shipbuilding specification/)
    assert.equal(vesselView({ ...v, performanceBasis: "SHOP_TEST" }).basisLabel, "Reference: shop test")
    assert.equal(vesselView({ ...v, performanceBasis: null }).basisLabel, null)
  })

  test("the picker offers workbook vessels only, not name-only or undelivered records", async () => {
    const [a, z] = await stored()
    assert.equal(pickerEntry(a).selectable, true)
    assert.equal(z.workbookId, null)
    assert.equal(pickerEntry(z).selectable, false)
    assert.equal(isSelectable({ workbookId: "TX", activeStatus: "NOT DELIVERED" }), false)
  })
})

describe("reporting a master data issue", () => {
  const who = { sub: "supt@example.com", name: "Test Superintendent" }
  const refused = (fn: () => unknown, status: number, pattern: RegExp) =>
    assert.throws(fn, (e: unknown) => e instanceof AppError && e.status === status && pattern.test(e.message))

  test("the current value comes from the master and the reporter from the session, not from the browser", async () => {
    const [v] = await stored()
    const flag = flagFrom({ field: "summer_dwt_mt", proposedValue: "300,100", reason: "Load line certificate shows 300,100 MT", source: "ILLC 2024", currentValue: "999", reporter: "someone-else" }, v, who, new Date("2026-11-24T10:00:00Z"))
    assert.equal(flag.currentValue, "300,000.5 MT")
    assert.equal(flag.reporter, who.sub)
    assert.equal(flag.reporterName, who.name)
    assert.deepEqual([flag.vesselId, flag.vesselName, flag.status, flag.at, flag.reportId], [ID, "TEST A", "open", "2026-11-24T10:00:00.000Z", null])
    assert.match(flag.flagId, VESSEL_ID_PATTERN)
  })

  test("untrusted input is checked", async () => {
    const [v] = await stored()
    refused(() => flagFrom(null, v, who), 400, /JSON object/)
    refused(() => flagFrom({ reason: "Wrong value here" }, v, who), 400, /Field is required/)
    refused(() => flagFrom({ field: "colour", reason: "Wrong value here" }, v, who), 400, /not a Vessel Master field/)
    refused(() => flagFrom({ field: "flag", reason: "no" }, v, who), 400, /why the value is wrong/)
    refused(() => flagFrom({ field: "flag", reason: 12345 }, v, who), 400, /must be text/)
    refused(() => flagFrom({ field: "flag", reason: "x".repeat(1001) }, v, who), 400, /longer than 1000/)
    refused(() => flagFrom({ field: "flag", reason: "Wrong value here", reportId: "../../x" }, v, who), 400, /not a valid report id/)
    refused(() => flagFrom({ field: "flag", reason: "Wrong value here" }, v, { sub: "", name: "" }), 401, /Sign in/)
    assert.equal(flagFrom({ field: "statutory_power_kw", reason: "Missing from the master" }, v, who).currentValue, "19,000 kW", "master-only fields can be flagged too")
  })
})

describe("the vessel cache in the browser", () => {
  const memory = () => {
    let saved: { data: string[]; fetchedAt: string } | undefined
    return { read: async () => saved, write: async (v: { data: string[]; fetchedAt: string }) => void (saved = v), peek: () => saved }
  }

  test("fresh data is saved and marked as from the network", async () => {
    const m = memory()
    const r = await networkFirst(async () => ({ data: ["TEST A"], fetchedAt: "t1" }), m.read, m.write)
    assert.deepEqual(r, { data: ["TEST A"], fetchedAt: "t1", source: "network" })
    assert.deepEqual(m.peek(), { data: ["TEST A"], fetchedAt: "t1" })
  })

  test("offline or refused: the saved copy, marked as such with its time; none saved: null, never a placeholder", async () => {
    const m = memory()
    await m.write({ data: ["TEST A"], fetchedAt: "t1" })
    assert.deepEqual(await networkFirst(async () => { throw new TypeError("Failed to fetch") }, m.read, m.write), { data: ["TEST A"], fetchedAt: "t1", source: "cache" })
    assert.deepEqual(await networkFirst(async () => null, m.read, m.write), { data: ["TEST A"], fetchedAt: "t1", source: "cache" })
    assert.equal(await networkFirst(async () => null, memory().read, memory().write), null)
  })

  test("a browser store that fails does not hide fresh data", async () => {
    const r = await networkFirst(async () => ({ data: ["TEST A"], fetchedAt: "t1" }), async () => undefined, async () => { throw new Error("QuotaExceeded") })
    assert.equal(r?.source, "network")
  })
})
