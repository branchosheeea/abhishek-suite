import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { DEFAULT_CONFIG, parseConfig } from "../lib/engine/config"
import { runValidation, type ValidationInput } from "../lib/engine/run"
import type { SourceTable } from "../lib/engine/types"
import { baseRows, brRow, brTable, csvTable, IMO, LA_HEADERS, laTable, type Row, toCsv } from "./helpers"

const config = parseConfig({ ...DEFAULT_CONFIG, period: { from: "2025-01-01", to: "2025-12-31" }, imo: IMO })

function run(rows: Row[], extra: Partial<ValidationInput> & { br?: SourceTable } = {}) {
  const la = laTable(rows)
  const result = runValidation({ sources: { LA: la, ...(extra.br ? { BR: extra.br } : {}) }, config, exclusions: extra.exclusions, dnv: extra.dnv })
  return { la, result, rule: (id: string) => result.findings.filter((f) => f.ruleId === id) }
}

function edit(changes: Record<number, Row>): Row[] {
  return baseRows().map((r, i) => ({ ...r, ...(changes[i] ?? {}) }))
}

describe("baseline", () => {
  test("a consistent voyage gives no error or warning, and every balance closes exactly", () => {
    const { result } = run(baseRows())
    const serious = result.findings.filter((f) => f.severity !== "info")
    assert.deepEqual(serious.map((f) => `${f.ruleId} ${f.title}`), [])
    const lfo = result.fuel[0].steps.filter((s) => s.fuel === "LFO")
    assert.deepEqual(lfo.map((s) => s.residual), ["0", "0", "0"])
    assert.equal(result.schema.id, "ovd-3.13-1")
    assert.equal(result.schema.verified, true)
    assert.ok(result.findings.every((f) => f.schemaVerified === true))
  })
})

describe("Group D: fuel reconciliation", () => {
  test("D02 reports the residual with an exact, traceable calculation", () => {
    const { rule } = run(edit({ 1: { LFO_ROB: "470" } }))
    const d02 = rule("D02").filter((f) => f.fuel === "LFO")
    assert.equal(d02.length, 2)
    const first = d02.find((f) => f.refs.some((r) => r.line === 2) && f.refs.some((r) => r.line === 3))!
    assert.equal(first.calculation!.result, "-7.25 mt")
    assert.match(first.calculation!.steps[0], /500 \+ \(0\) − 22\.75 = 477\.25/)
    assert.ok(first.calculation!.inputs.some((i) => i.column === "LFO_ROB" && i.value === "470" && i.ref?.line === 3))
    assert.ok(first.calculation!.qualifications.some((q) => /No Bunker Report/.test(q)))
    assert.ok(first.calculation!.qualifications.some((q) => /not assumed to be zero/.test(q)))
    assert.ok(first.possibleCauses!.every((c) => /hypothesis/.test(c)))
    assert.equal(first.evidence, "independent-calculation")
    // the two opposite residuals cancel over the voyage, so D04 stays silent
    assert.equal(rule("D04").length, 0)
  })

  test("a blank consumption field is not read as zero: the step is qualified and says so", () => {
    const { rule, result } = run(edit({ 2: { AE_Consumption_LFO: "" } }))
    const step = result.fuel[0].steps.find((s) => s.fuel === "LFO" && s.cur.line === 4)!
    assert.equal(step.qualified, true)
    assert.equal(step.consumption, "21")
    const f = rule("D02").find((x) => x.fuel === "LFO")!
    assert.equal(f.calculation!.result, "-2.25 mt")
    assert.ok(f.calculation!.qualifications.some((q) => /AE_Consumption_LFO/.test(q) && /not read as zero/.test(q)))
  })

  test("a blank ROB makes the step not computable (D03), never a zero balance", () => {
    const { rule, result } = run(edit({ 1: { LFO_ROB: "" } }))
    assert.equal(rule("D02").filter((f) => f.fuel === "LFO").length, 0)
    const d03 = rule("D03").find((f) => f.fuel === "LFO")!
    assert.match(d03.detail, /closing ROB blank at line 3/)
    assert.match(d03.detail, /opening ROB blank at line 3/)
    const lfo = result.fuel[0].steps.filter((s) => s.fuel === "LFO")
    assert.deepEqual(lfo.map((s) => s.status), ["not-computable", "not-computable", "computed"])
    // The period balance runs from the first to the last REPORTED ROB, summing all consumption in between,
    // so one blank intermediate ROB does not block it: 500 − (22.75 + 23.25 + 22) = 432 = reported.
    const period = result.fuel[0].period.find((p) => p.fuel === "LFO")!
    assert.equal(period.status, "computed")
    assert.equal(period.consumption, "68")
    assert.equal(period.residual, "0")
  })

  test("allocation columns (cargo heating) are a portion of total consumption: never added, and D08 flags excess", () => {
    const headers = [...LA_HEADERS, "Cargo_heating_consumption_LFO"]
    const rows = baseRows().map((r, i) => ({ ...r, Cargo_heating_consumption_LFO: i === 1 ? "30" : i === 2 ? "5" : "" }))
    const la = csvTable(toCsv(rows, headers))
    const result = runValidation({ sources: { LA: la }, config })
    const lfo = result.fuel[0].steps.filter((s) => s.fuel === "LFO")
    assert.deepEqual(lfo.map((s) => s.residual), ["0", "0", "0"]) // not double counted
    const d08 = result.findings.filter((f) => f.ruleId === "D08")
    assert.equal(d08.length, 1)
    assert.match(d08[0].detail, /line 3: 30 > 22\.75/)
    assert.ok(result.findings.some((f) => f.ruleId === "A09" && /letter case/.test(f.title)))
  })

  test("an invalid value is not computable and is reported with its raw text", () => {
    const { rule } = run(edit({ 1: { ME_Consumption_LFO: "20,5" } }))
    assert.ok(rule("A05").some((f) => /ME_Consumption_LFO/.test(f.title) && /comma/.test(f.detail)))
    assert.match(rule("D03").find((f) => f.fuel === "LFO")!.detail, /ME_Consumption_LFO "20,5" invalid/)
  })

  test("D01 missing opening ROB", () => {
    const { rule } = run(edit({ 0: { LFO_ROB: "" } }))
    const d01 = rule("D01")
    assert.equal(d01.length, 1)
    assert.equal(d01[0].fuel, "LFO")
    assert.equal(d01[0].severity, "error")
    assert.equal(d01[0].refs[0].line, 2)
  })

  test("documented bunker deliveries inside the interval are added; without the Bunker Report the step is flagged", () => {
    const rows = edit({ 2: { LFO_ROB: "554" }, 3: { LFO_ROB: "532" } })
    const br = brTable([brRow("2025-03-02", "18:00", "VLSLFO2020", "100")]) // a documented grade in the LFO category
    const withBr = run(rows, { br })
    assert.equal(withBr.rule("D02").filter((f) => f.fuel === "LFO").length, 0)
    const step = withBr.result.fuel[0].steps.find((s) => s.fuel === "LFO" && s.cur.line === 4)!
    assert.equal(step.bunkers, "100")
    const without = run(rows)
    assert.equal(without.rule("D02").find((f) => f.fuel === "LFO")!.calculation!.result, "100 mt")
  })

  test("D05: a delivery dated just outside the step is offered as a hypothesis; nothing is moved", () => {
    const rows = edit({ 2: { LFO_ROB: "554" }, 3: { LFO_ROB: "532" } })
    const br = brTable([brRow("2025-03-03", "10:00", "LFO", "100", "B-2", "LKCMB")])
    const { rule, result } = run(rows, { br })
    const d05 = rule("D05")
    assert.equal(d05.length, 1)
    assert.equal(d05[0].evidence, "hypothesis")
    const d02 = rule("D02").find((f) => f.refs.some((r) => r.line === 4) && f.refs.some((r) => r.line === 3))!
    assert.match(d02.possibleCauses![0], /dated 4\.0 h outside this interval/)
    // the delivery is used only in the interval it is dated in
    const next = result.fuel[0].steps.find((s) => s.fuel === "LFO" && s.cur.line === 5)!
    assert.equal(next.bunkers, "100")
  })

  test("D06 consumption exceeding the available fuel", () => {
    const { rule } = run(edit({ 1: { ME_Consumption_LFO: "600" } }))
    assert.ok(rule("D06").some((f) => f.fuel === "LFO" && /-102\.25/.test(f.detail)))
  })
})

describe("Groups B, C, E, F, G", () => {
  test("B01 backwards timestamps and F01 duration mismatch, with the row order unchanged", () => {
    const { rule, la } = run(edit({ 2: { Date_UTC: "2025-03-01" } }))
    assert.equal(rule("B01").length, 1)
    assert.ok(rule("F01").length >= 1)
    assert.deepEqual(la.rows.map((r) => r.line), [2, 3, 4, 5])
  })

  test("B03 flags an anomalous year; a user exclusion removes it from calculations but keeps it visible", () => {
    const rows = edit({ 1: { Date_UTC: "2013-03-02" } })
    const flagged = run(rows)
    assert.equal(flagged.rule("B03").length, 1)
    assert.match(flagged.rule("B03")[0].title, /2013/)
    const la = laTable(rows)
    const excluded = runValidation({ sources: { LA: la }, config, exclusions: [{ sha256: la.sha256, line: 3, reason: "DNV template record" }] })
    assert.equal(excluded.findings.filter((f) => f.ruleId === "B03").length, 0)
    assert.deepEqual(excluded.exclusions.map((e) => e.found), [true])
    assert.equal(la.rows.length, 4) // still in the source view
  })

  test("C01 / C03 / C04 port continuity, and C05 port-code form", () => {
    const rows: Row[] = [
      { ...baseRows()[0] },
      { ...baseRows()[3], Voyage_To: "DEHAM" }, // arrival elsewhere than declared → C04
      { ...baseRows()[0], Date_UTC: "2025-03-06", Voyage_From: "BEANR", Voyage_To: "Singapore" }, // departs from another port → C01, C05
      { ...baseRows()[0], Date_UTC: "2025-03-08", Voyage_From: "BEANR", Voyage_To: "Singapore" }, // second departure → C03
    ]
    const { rule } = run(rows)
    assert.equal(rule("C04").length, 1)
    assert.equal(rule("C01").length, 1)
    assert.equal(rule("C03").length, 1)
    assert.ok(rule("C05").some((f) => /Singapore/.test(f.title)))
  })

  test("E01 cargo change on a sea passage is flagged; a change during a port stay (Arrival → Departure) is not", () => {
    // 100000 → 95000 → 100000 between Departure and Arrival: both changes are at sea
    assert.equal(run(edit({ 2: { Cargo_Mt: "95000" } })).rule("E01").length, 2)
    const portStay = [...baseRows(), { ...baseRows()[0], Date_UTC: "2025-03-05", Voyage_From: "NLRTM", Voyage_To: "SGSIN", Cargo_Mt: "0" }]
    assert.equal(run(portStay).rule("E01").length, 0)
  })

  test("timeline basis (default) follows UTC order within the period and names records it cannot place", () => {
    // Line 4 (the second noon) dated 2013: OVD would not place it in the 2025 period
    const rows = edit({ 2: { Date_UTC: "2013-03-03" } })
    const { rule, result } = run(rows)
    assert.equal(result.coverage.notes.some((n) => /UTC-timestamp order/.test(n)), true)
    const f01 = rule("F01").find((f) => f.refs.some((r) => r.line === 5))!
    assert.match(f01.title, /24 h vs 48\.00 h/)
    assert.match(f01.possibleCauses![0], /line 4 \(Noon, 2013-03-03 06:00\)/)
    // the submitted basis keeps the file order instead
    const submitted = runValidation({ sources: { LA: laTable(rows) }, config: parseConfig({ ...config, sequenceBasis: "submitted" }) })
    assert.equal(submitted.findings.filter((f) => f.ruleId === "F01" && f.refs.some((r) => r.line === 5)).length, 1)
    assert.match(submitted.findings.find((f) => f.ruleId === "F01" && f.refs.some((r) => r.line === 5))!.title, /24 h vs 105216\.00 h/) // 2013 → 2025 in file order
  })

  test("A08 exact OVD event spelling; C01 compares a second departure with the previous port of call", () => {
    const rows = [...baseRows()]
    rows[3] = { ...rows[3], Event: "arrival" } // near miss: not recognised by OVD voyage logic
    rows.push({ ...baseRows()[0], Date_UTC: "2025-03-05", Voyage_From: "NLRTM", Voyage_To: "SGSIN" })
    const { rule } = run(rows)
    assert.ok(rule("A08").some((f) => /"arrival" should be spelled "Arrival"/.test(f.title)))
    assert.ok(rule("C03").length === 1) // two departures: the misspelled arrival does not count
    assert.ok(rule("C01").some((f) => /departure from NLRTM does not match the previous port SGSIN/.test(f.title)))
  })

  test("G01 distance shorter than the geodesic, G03 implausible implied speed", () => {
    assert.equal(run(edit({ 1: { Distance: "100" } })).rule("G01").length, 1)
    const fast = run(edit({ 1: { Latitude_Degree: "40" } }))
    assert.ok(fast.rule("G03").length >= 1)
  })

  test("Group A: IMO check digit, negative values, duplicates", () => {
    const { rule } = run(edit({ 1: { IMO: "9074720" }, 2: { Distance: "-5" } }))
    assert.ok(rule("A04").some((f) => /check digit/.test(f.detail)))
    assert.ok(rule("A06").some((f) => /Distance/.test(f.title)))
    const dup = baseRows()
    dup.splice(2, 0, { ...dup[1] })
    const d = run(dup)
    assert.ok(d.rule("A07").some((f) => /identical/.test(f.title)))
    assert.ok(d.rule("B02").length >= 1)
  })
})

describe("coverage, determinism and source immutability", () => {
  test("rules that cannot run say why", () => {
    const { result } = run(baseRows())
    const r01 = result.coverage.rules.find((r) => r.ruleId === "R01")!
    assert.equal(r01.status, "not-executable")
    assert.match(r01.reason!, /needs both the LA and the OVDLA/)
    const d05 = result.coverage.rules.find((r) => r.ruleId === "D05")!
    assert.match(d05.reason!, /no Bunker Report/)
  })

  test("identical inputs give identical results, including finding ids", () => {
    const rows = edit({ 1: { LFO_ROB: "470" }, 2: { Cargo_Mt: "95000" } })
    const a = runValidation({ sources: { LA: laTable(rows) }, config })
    const b = runValidation({ sources: { LA: laTable(rows) }, config })
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
    assert.ok(a.findings.length > 0)
  })

  test("running the validation does not change the source bytes or the parsed table", () => {
    const text = new TextEncoder().encode(laTableText())
    const before = Buffer.from(text)
    const la = laTable(edit({ 1: { LFO_ROB: "470" } }))
    const snapshot = JSON.stringify(la)
    runValidation({ sources: { LA: la }, config })
    assert.equal(JSON.stringify(la), snapshot)
    assert.ok(Buffer.from(text).equals(before))
    assert.ok(Object.isFrozen(la) && Object.isFrozen(la.rows[0].cells))
  })
})

function laTableText() {
  return baseRows().map((r) => Object.values(r).join(",")).join("\n")
}
