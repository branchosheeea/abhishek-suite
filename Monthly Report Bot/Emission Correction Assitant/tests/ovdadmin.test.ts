// Checks added for the OVD Admin check names (sea passage, maneuvering in port, consumption deviation, cargo
// heating vs boiler, distance per voyage) and DNV items anchored on an event time. Synthetic data only.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { DEFAULT_CONFIG, parseConfig } from "../lib/engine/config"
import type { DnvFinding } from "../lib/engine/correlate"
import { runValidation } from "../lib/engine/run"
import type { SourceTable } from "../lib/engine/types"
import { baseRows, csvTable, IMO, LA_HEADERS, type Row, toCsv } from "./helpers"

const config = parseConfig({ ...DEFAULT_CONFIG, period: { from: "2025-01-01", to: "2025-12-31" }, imo: IMO })

function run(la: SourceTable, dnv: DnvFinding[] = []) {
  const result = runValidation({ sources: { LA: la }, config, dnv })
  return { result, rule: (id: string) => result.findings.filter((f) => f.ruleId === id), coverage: (id: string) => result.coverage.rules.filter((r) => r.ruleId === id) }
}

/** A record copied from `base` at another time, with no consumption or distance of its own. */
function extra(base: Row, date: string, time: string, Event: string, more: Row = {}): Row {
  return { ...base, Date_UTC: date, Time_UTC: time, Event, Distance: "0", ME_Consumption_LFO: "", AE_Consumption_LFO: "", ME_Consumption_HFO: "", Time_Since_Previous_Report: "", ...more }
}

/** Ports and stays with a chosen consumption; no positions. Each step: [event, from, to, hours, LFO consumed]. */
function chain(steps: [string, string, string, number, number][]): SourceTable {
  let t = Date.parse("2025-05-01T00:00:00Z")
  let rob = 2000
  const rows: Row[] = steps.map(([Event, from, to, hours, used], i) => {
    t += hours * 3_600_000
    rob -= used
    const iso = new Date(t).toISOString()
    return {
      IMO, Date_UTC: iso.slice(0, 10), Time_UTC: iso.slice(11, 16), Event, Voyage_From: from, Voyage_To: to,
      Time_Since_Previous_Report: i ? String(hours) : "", Distance: "0", Cargo_Mt: "100000",
      ME_Consumption_LFO: i ? String(used) : "", AE_Consumption_LFO: i ? "0" : "", LFO_ROB: String(rob),
    }
  })
  return csvTable(toCsv(rows))
}

const dnv = (over: Partial<DnvFinding>): DnvFinding => ({
  id: "dnv-1", category: "OTHER", severity: "warning", description: "as shown in OVD Admin", imo: IMO,
  fromUtc: null, toUtc: null, eventUtc: null, voyageOrPortStay: null, portCodes: [], fuel: null, quantity: null,
  entryMethod: "manual", confirmed: true, ...over,
})

describe("C09 sea passage consistency", () => {
  test("COSP is accepted as the passage start (qualified by A08); a consistent passage gives no C09", () => {
    const b = baseRows()
    const rows = [b[0], extra(b[0], "2025-03-01", "08:00", "COSP"), b[1], b[2], extra(b[3], "2025-03-04", "04:00", "EOSP"), b[3]]
    const { rule, coverage } = run(csvTable(toCsv(rows)))
    assert.deepEqual(rule("C09").map((f) => f.title), [])
    assert.equal(coverage("C09")[0].status, "executed")
    const alias = rule("A08").find((f) => /"COSP" is not a documented OVD sea passage event/.test(f.title))!
    assert.equal(alias.severity, "info")
  })

  test("EOSP after the Arrival (in port) is reported", () => {
    const b = baseRows()
    const { rule } = run(csvTable(toCsv([...b, extra(b[3], "2025-03-04", "10:00", "EOSP")])))
    const f = rule("C09")
    assert.equal(f.length, 1)
    assert.match(f[0].title, /EOSP at line 6 after the Arrival at line 5/)
    assert.equal(f[0].severity, "error")
  })

  test("a second start without an end, and an Arrival while the passage is open", () => {
    const b = baseRows()
    const rows = [b[0], extra(b[0], "2025-03-01", "08:00", "BOSP"), extra(b[0], "2025-03-01", "09:00", "BOSP"), b[1], b[2], b[3]]
    const titles = run(csvTable(toCsv(rows))).rule("C09").map((f) => f.title)
    assert.ok(titles.some((t) => /second sea passage start at line 4/.test(t)), titles.join(" | "))
    assert.ok(titles.some((t) => /sea passage started at line 4 is not ended by EOSP before the Arrival \(line 7\)/.test(t)), titles.join(" | "))
  })

  test("not executable when no sea passage events are reported", () => {
    const c = run(csvTable(toCsv(baseRows()))).coverage("C09")
    assert.equal(c[0].status, "not-executable")
    assert.match(c[0].reason!, /no sea passage start\/end events/)
  })
})

describe("D09 consumption deviation and D10 cargo heating vs boiler", () => {
  const voyage = (from: string, to: string): [string, string, string, number, number][] => [["Arrival", from, to, 24, 10]]
  const steps = (lastStayHours: number, lastStayUsed: number): [string, string, string, number, number][] => [
    ["Departure", "SGSIN", "MYPKG", 0, 0], ...voyage("SGSIN", "MYPKG"),
    ["Departure", "MYPKG", "THBKK", 24, 5], ...voyage("MYPKG", "THBKK"),
    ["Departure", "THBKK", "VNSGN", 24, 5], ...voyage("THBKK", "VNSGN"),
    ["Departure", "VNSGN", "PHMNL", lastStayHours, lastStayUsed], ...voyage("VNSGN", "PHMNL"),
  ]

  test("a port stay burning far above the median of the other port stays is reported, with the calculation", () => {
    const { rule, coverage } = run(chain(steps(24, 20)))
    const f = rule("D09")
    assert.equal(f.length, 1, f.map((x) => x.title).join(" | "))
    assert.match(f[0].title, /port stay at VNSGN .* burns 0\.833 mt\/h, 4\.00× the median of the other port stays/)
    assert.equal(f[0].evidence, "screening-threshold")
    assert.match(f[0].calculation!.steps[0], /Rate = 20 ÷ 24\.0000 = 0\.8333 mt\/h/)
    assert.ok(f[0].possibleCauses!.every((c) => /hypothesis/.test(c)))
    // voyages all burn the same rate: compared, nothing reported
    assert.ok(coverage("D09").some((c) => c.status === "executed" && c.evaluated === 7))
  })

  test("fewer than 3 segments of a type are not compared, and say so", () => {
    const short = chain([["Departure", "SGSIN", "MYPKG", 0, 0], ["Arrival", "SGSIN", "MYPKG", 24, 10], ["Departure", "MYPKG", "THBKK", 24, 50], ["Arrival", "MYPKG", "THBKK", 24, 10]])
    const { rule, coverage } = run(short)
    assert.equal(rule("D09").length, 0)
    assert.ok(coverage("D09").some((c) => /at least 3 are needed/.test(c.reason ?? "")))
  })

  test("D10: cargo heating above the boiler consumption of the same fuel on the same report", () => {
    const headers = [...LA_HEADERS, "Boiler_Consumption_LFO", "Cargo_heating_Consumption_LFO"]
    const rows = baseRows().map((r, i) =>
      i === 1 ? { ...r, ME_Consumption_LFO: "19.5", Boiler_Consumption_LFO: "1", Cargo_heating_Consumption_LFO: "3" }
      : i === 2 ? { ...r, ME_Consumption_LFO: "19", Boiler_Consumption_LFO: "2", Cargo_heating_Consumption_LFO: "1.5" }
      : r)
    const { rule, result } = run(csvTable(toCsv(rows, headers)))
    const f = rule("D10")
    assert.equal(f.length, 1)
    assert.match(f[0].detail, /line 3 .*cargo heating 3 mt > boiler 1/)
    assert.deepEqual(result.fuel[0].steps.filter((s) => s.fuel === "LFO").map((s) => s.residual), ["0", "0", "0"]) // boiler counted once, heating not added
  })
})

describe("G05 maneuvering in port and G06 distance per voyage", () => {
  const departure = (more: Row = {}): Row => ({ ...baseRows()[3], Date_UTC: "2025-03-05", Event: "Departure", Voyage_From: "NLRTM", Voyage_To: "SGSIN", Distance: "3", Time_Since_Previous_Report: "24", ME_Consumption_LFO: "0", AE_Consumption_LFO: "0", ME_Consumption_HFO: "0", ...more })
  const headers = [...LA_HEADERS, "Time_Elapsed_Maneuvering"]

  test("distance in port without maneuvering time is reported; with maneuvering time it is not", () => {
    const without = run(csvTable(toCsv([...baseRows(), departure({ Time_Elapsed_Maneuvering: "" })], headers))).rule("G05")
    assert.equal(without.length, 1)
    assert.match(without[0].title, /distance in port without maneuvering time on 1 record/)
    assert.match(without[0].detail, /Departure line 6 .*: 3 nm, maneuvering blank/)
    const withTime = run(csvTable(toCsv([...baseRows(), departure({ Time_Elapsed_Maneuvering: "1.5" })], headers))).rule("G05")
    assert.equal(withTime.length, 0)
  })

  test("without a Time_Elapsed_Maneuvering column every distance in port is reported, and coverage says why", () => {
    const { rule, coverage } = run(csvTable(toCsv([...baseRows(), departure()])))
    assert.match(rule("G05")[0].title, /distance reported while in port on 1 record/)
    assert.ok(coverage("G05").some((c) => c.status === "partial" && /no Time_Elapsed_Maneuvering column/.test(c.reason ?? "")))
  })

  test("G06: Σ distance shorter than the track through the reported positions is an error; far longer is a warning", () => {
    const short = run(csvTable(toCsv(baseRows().map((r, i) => (i === 2 ? { ...r, Distance: "200" } : r))))).rule("G06")
    assert.equal(short.length, 1)
    assert.equal(short[0].severity, "error")
    assert.match(short[0].title, /voyage SGSIN → NLRTM \(lines 2–5\) reports 805\.0 nm vs \d+\.\d nm along its reported positions \(-/)
    const long = run(csvTable(toCsv(baseRows().map((r, i) => (i === 2 ? { ...r, Distance: "400" } : r))))).rule("G06")
    assert.equal(long.length, 1)
    assert.equal(long[0].severity, "warning")
    assert.match(long[0].title, /reports 1005\.0 nm .*\(\+/)
    assert.equal(run(csvTable(toCsv(baseRows()))).rule("G06").length, 0)
  })
})

describe("DNV items entered with the OVD Admin event time", () => {
  test("a voyage / port-stay item matches the finding of the segment containing the event time, even beyond 4 days", () => {
    const long = chain([
      ["Departure", "SGSIN", "MYPKG", 0, 0], ["Arrival", "SGSIN", "MYPKG", 24, 10],
      ["Departure", "MYPKG", "THBKK", 24, 5], ["Arrival", "MYPKG", "THBKK", 24, 10],
      ["Departure", "THBKK", "VNSGN", 24, 5], ["Arrival", "THBKK", "VNSGN", 24, 10],
      ["Departure", "VNSGN", "PHMNL", 144, 120], ["Arrival", "VNSGN", "PHMNL", 24, 10],
    ])
    // VNSGN stay: Arrival 2025-05-07T00:00Z → Departure 2025-05-13T00:00Z (6 days)
    const inside = dnv({ category: "CONSUMPTION_DEVIATION", eventUtc: "2025-05-13T00:00:00Z", voyageOrPortStay: "InPort" })
    const elsewhere = dnv({ id: "dnv-2", category: "CONSUMPTION_DEVIATION", eventUtc: "2025-05-03T00:00:00Z" })
    const { result } = run(long, [inside, elsewhere])
    const a = result.correlations.find((c) => c.dnvId === "dnv-1")!
    assert.equal(a.outcome, "independently-reproduced")
    assert.match(a.explanation, /D09/)
    assert.match(a.explanation, /around the DNV event time/)
    const b = result.correlations.find((c) => c.dnvId === "dnv-2")!
    assert.equal(b.outcome, "not-reproduced")
  })

  test("a record item (sea passage) matches within ±24 h of the event time only", () => {
    const b = baseRows()
    const la = csvTable(toCsv([...b, extra(b[3], "2025-03-04", "10:00", "EOSP")]))
    const near = dnv({ category: "SEA_PASSAGE", severity: "error", eventUtc: "2025-03-04T10:00:00Z" })
    const far = dnv({ id: "dnv-2", category: "SEA_PASSAGE", severity: "error", eventUtc: "2025-03-20T10:00:00Z" })
    const { result } = run(la, [near, far])
    assert.equal(result.correlations.find((c) => c.dnvId === "dnv-1")!.outcome, "independently-reproduced")
    assert.equal(result.correlations.find((c) => c.dnvId === "dnv-2")!.outcome, "not-reproduced")
  })
})
