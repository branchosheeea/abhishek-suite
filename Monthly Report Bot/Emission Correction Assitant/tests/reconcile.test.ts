import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { DEFAULT_CONFIG, parseConfig } from "../lib/engine/config"
import { type DnvFinding } from "../lib/engine/correlate"
import { runValidation } from "../lib/engine/run"
import { writeXlsx, type XlsxCell } from "../lib/export/xlsx-writer"
import { parseXlsx } from "../lib/parsers/xlsx"
import { baseRows, brTable, IMO, LA_HEADERS, laTable, ovdlaTable, type Row, sha } from "./helpers"

const config = parseConfig({ ...DEFAULT_CONFIG, period: { from: "2025-01-01", to: "2025-12-31" }, imo: IMO })
const recon = (la: Row[], ovdla: Row[]) => runValidation({ sources: { LA: laTable(la), OVDLA: ovdlaTable(ovdla) }, config })

describe("source reconciliation (LA vs OVDLA)", () => {
  test("identical files: every record matched with no differences", () => {
    const r = recon(baseRows(), baseRows()).reconciliation!
    assert.equal(r.counts.matched, 4)
    assert.equal(r.counts.matchedIdentical, 4)
    assert.equal(r.counts.submittedOnly, 0)
    assert.equal(r.counts.systemOnly, 0)
    assert.deepEqual(r.systemOnlyColumns, ["Source_System", "Last_Updated"])
    assert.deepEqual(r.systemMetadata.Last_Updated, ["2025-04-01T00:00:00Z"])
  })

  test("LA records after the OVDLA's last record are classified as a possible cut-off (hypothesis), not as errors in either file", () => {
    const res = recon(baseRows(), baseRows().slice(0, 3))
    const r = res.reconciliation!
    assert.equal(r.counts.submittedOnly, 1)
    assert.equal(r.submittedOnly[0].classification, "after-other-last")
    assert.equal(r.submittedOnly[0].ref.line, 5)
    const f = res.findings.find((x) => x.ruleId === "R01")!
    assert.equal(f.evidence, "hypothesis")
  })

  test("a value difference is reported with both raw values; a formatting-only difference is reported separately", () => {
    const ovdla = baseRows()
    ovdla[1] = { ...ovdla[1], LFO_ROB: "477.30" } // value
    ovdla[2] = { ...ovdla[2], LFO_ROB: "454" } // LA has "454.0" → format only
    const res = recon(baseRows(), ovdla)
    const r = res.reconciliation!
    assert.equal(r.counts.matchedWithDifferences, 1)
    assert.equal(r.counts.matchedFormatOnly, 1)
    const r03 = res.findings.find((f) => f.ruleId === "R03")!
    assert.match(r03.detail, /"477\.25" vs OVDLA row 3 "477\.30"/)
    assert.match(r03.detail, /Neither value is assumed correct/)
    assert.ok(res.findings.some((f) => f.ruleId === "R05" && /LFO_ROB/.test(f.title)))
  })

  test("Excel date serials compare equal to the LA's text dates (format-only, not a value difference)", () => {
    const headers = [...LA_HEADERS]
    const rows: XlsxCell[][] = [headers, ...baseRows().map((r, i) => headers.map((h) => {
      if (h === "Date_UTC") return { date: String(45717 + i) }
      if (h === "Time_UTC") return { date: "0.25" }
      return r[h] === "" ? null : r[h]
    }))]
    const bytes = writeXlsx([{ name: "S", rows }])
    const ovdla = parseXlsx(bytes, "OVDLA", sha(bytes), "o.xlsx")
    const res = runValidation({ sources: { LA: laTable(baseRows()), OVDLA: ovdla }, config })
    assert.equal(res.reconciliation!.counts.matched, 4)
    assert.equal(res.reconciliation!.counts.matchedWithDifferences, 0)
  })

  test("duplicate keys are never silently paired: they stay ambiguous", () => {
    const la = baseRows()
    la.splice(2, 0, { ...la[1] }) // LA has the noon report twice
    const res = recon(la, baseRows())
    const r = res.reconciliation!
    assert.equal(r.ambiguous.length, 1)
    assert.equal(r.counts.ambiguousSubmitted, 2)
    assert.equal(r.counts.ambiguousSystem, 1)
    assert.equal(r.counts.matched, 3)
    assert.ok(res.findings.some((f) => f.ruleId === "R04"))
  })

  test("an excluded LA record that is not in the OVDLA is classified as excluded and stays listed", () => {
    const la = [...baseRows(), { ...baseRows()[1], Date_UTC: "2013-01-01" }]
    const table = laTable(la)
    const res = runValidation({ sources: { LA: table, OVDLA: ovdlaTable(baseRows()) }, config, exclusions: [{ sha256: table.sha256, line: 6, reason: "DNV sample record" }] })
    const u = res.reconciliation!.submittedOnly
    assert.equal(u.length, 1)
    assert.equal(u[0].classification, "excluded")
  })
})

const dnv = (over: Partial<DnvFinding>): DnvFinding => ({
  id: "dnv-1", category: "FUEL_AVAILABLE", severity: "error", description: "Available fuel vs consumption", imo: IMO,
  fromUtc: "2025-03-02T06:00:00Z", toUtc: "2025-03-03T06:00:00Z", voyageOrPortStay: null, portCodes: [], fuel: "LFO",
  quantity: null, entryMethod: "manual", confirmed: true, ...over,
})

describe("DNV error correlation", () => {
  const rowsWithResidual = () => baseRows().map((r, i) => (i === 2 ? { ...r, LFO_ROB: "440" } : r))

  test("Independently Reproduced when an independent finding of the same kind falls in the window", () => {
    const res = runValidation({ sources: { LA: laTable(rowsWithResidual()), BR: brTable([]) }, config, dnv: [dnv({})] })
    const c = res.correlations[0]
    assert.equal(c.dnvReported, true)
    assert.equal(c.outcome, "independently-reproduced")
    assert.ok(c.matchedFindings.length >= 1)
    assert.ok(c.possibleCauses.length >= 1)
  })

  test("a fuel item is Unresolved without the Bunker Report, even when residuals exist (DNV's available fuel includes bunkering)", () => {
    const res = runValidation({ sources: { LA: laTable(rowsWithResidual()) }, config, dnv: [dnv({})] })
    const c = res.correlations[0]
    assert.equal(c.outcome, "unresolved")
    assert.ok(c.matchedFindings.length >= 1) // listed as candidates, not as a reproduction
    assert.match(c.explanation, /no Bunker Report was supplied/)
  })

  test("a finding spanning a much longer period does not 'match' a short DNV window", () => {
    const rows = baseRows().map((r, i) => (i === 2 ? { ...r, LFO_ROB: "440" } : r))
    const res = runValidation({ sources: { LA: laTable(rows), BR: brTable([]) }, config, dnv: [dnv({ fromUtc: "2025-03-03T05:00Z", toUtc: "2025-03-03T06:00Z" })] })
    const c = res.correlations[0]
    const matched = res.findings.filter((f) => c.matchedFindings.includes(f.id))
    assert.ok(matched.every((f) => f.window!.toMs - f.window!.fromMs <= 4 * 86_400_000))
  })

  test("Not Reproduced when the rules ran and found nothing; DNV items are never treated as confirmed by default", () => {
    const res = runValidation({ sources: { LA: laTable(baseRows()) }, config, dnv: [dnv({ category: "DURATION", fuel: null })] })
    assert.equal(res.correlations[0].outcome, "not-reproduced")
    assert.match(res.correlations[0].explanation, /may differ/)
  })

  test("Unresolved when no rule can check it (AIS) or the inputs are missing", () => {
    const ais = runValidation({ sources: { LA: laTable(baseRows()) }, config, dnv: [dnv({ category: "AIS", fuel: null })] })
    assert.equal(ais.correlations[0].outcome, "unresolved")
    assert.match(ais.correlations[0].explanation, /No AIS dataset/)
    const blanks = baseRows().map((r, i) => (i > 0 ? { ...r, LFO_ROB: "" } : r))
    const missing = runValidation({ sources: { LA: laTable(blanks) }, config, dnv: [dnv({})] })
    assert.equal(missing.correlations[0].outcome, "unresolved")
  })

  test("an unconfirmed (e.g. screenshot) entry is flagged as unverified DNV evidence", () => {
    const res = runValidation({ sources: { LA: laTable(rowsWithResidual()) }, config, dnv: [dnv({ confirmed: false, entryMethod: "screenshot" })] })
    assert.equal(res.correlations[0].evidenceConfirmed, false)
    assert.match(res.correlations[0].explanation, /not yet verified DNV evidence/)
  })

  test("related DNV items are linked when their reproducing findings share a source record", () => {
    const res = runValidation({
      sources: { LA: laTable(rowsWithResidual()) },
      config,
      dnv: [dnv({ id: "a" }), dnv({ id: "b", category: "FUEL_AVAILABLE", severity: "warning" })],
    })
    assert.deepEqual(res.correlations.find((c) => c.dnvId === "a")!.relatedDnvIds, ["b"])
  })
})
