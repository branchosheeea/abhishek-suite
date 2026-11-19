// DHT COLT regression (spec §15). Runs only when the confidential reference files and the private expectations
// (tests/private/dhtcolt.json) are present; both are git-ignored. Expected values live here, never in the rules.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { DEFAULT_CONFIG, parseConfig } from "../lib/engine/config"
import type { DnvFinding } from "../lib/engine/correlate"
import { runValidation, type ValidationResult } from "../lib/engine/run"
import { parseSource } from "../lib/parsers"

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const expectationsPath = join(ROOT, "tests", "private", "dhtcolt.json")
const spec = existsSync(expectationsPath) ? JSON.parse(readFileSync(expectationsPath, "utf8")) : null
const present = spec && Object.values(spec.files as Record<string, string>).every((f) => existsSync(join(ROOT, "reference", f)))

describe("DHT COLT regression (reference files)", { skip: present ? false : "reference files or tests/private/dhtcolt.json not present" }, () => {
  const read = (name: string) => {
    const bytes = new Uint8Array(readFileSync(join(ROOT, "reference", name)))
    return { bytes, sha: createHash("sha256").update(bytes).digest("hex") }
  }
  let la: ReturnType<typeof read>
  let ov: ReturnType<typeof read>
  let result: ValidationResult
  const finding = (rule: string, pattern: RegExp) => result.findings.find((f) => f.ruleId === rule && pattern.test(f.title))

  test("the validation runs on the real files without changing a byte", () => {
    la = read(spec.files.LA)
    ov = read(spec.files.OVDLA)
    const before = [la.sha, ov.sha]
    const LA = parseSource(la.bytes, "LA", la.sha, spec.files.LA)
    const OVDLA = parseSource(ov.bytes, "OVDLA", ov.sha, spec.files.OVDLA)
    assert.equal(LA.rows.length, spec.expect.laRows)
    assert.equal(OVDLA.rows.length, spec.expect.ovdlaRows)
    // the four 2013 DNV template records ("Example Voyage") are exactly the lines given in the spec
    for (const line of spec.templateLines) assert.match(LA.rows.find((r) => r.line === line)!.cells.join(","), /2013-03-2\d.*Example Voyage/)
    const config = parseConfig({ ...DEFAULT_CONFIG, period: spec.period, imo: spec.imo })
    const exclusions = spec.templateLines.map((line: number) => ({ sha256: la.sha, line, reason: "DNV template/sample record" }))
    const dnv: DnvFinding[] = spec.dnv.map((d: Record<string, unknown>) => ({ imo: spec.imo, voyageOrPortStay: null, portCodes: [], quantity: null, entryMethod: "screenshot", confirmed: false, ...d }))
    result = runValidation({ sources: { LA, OVDLA }, config, exclusions, dnv })
    assert.equal(result.schema.verified, true)
    assert.deepEqual([createHash("sha256").update(la.bytes).digest("hex"), createHash("sha256").update(ov.bytes).digest("hex")], before)
  })

  test("case 9 and 10: LA vs OVDLA — all OVDLA records matched without value differences; LA-only records classified", () => {
    const r = result.reconciliation!
    assert.equal(r.counts.matched, spec.expect.matched)
    assert.equal(r.counts.matchedWithDifferences, spec.expect.matchedWithDifferences)
    assert.equal(r.counts.systemOnly, 0)
    const byClass: Record<string, number[]> = {}
    for (const u of r.submittedOnly) (byClass[u.classification] ??= []).push(u.ref.line)
    assert.deepEqual(byClass.excluded, spec.expect.submittedOnly.excluded)
    assert.deepEqual(byClass["outside-period"], spec.expect.submittedOnly["outside-period"])
    assert.equal(byClass["after-other-last"].length, spec.expect.submittedOnly["after-other-last"])
    assert.equal(new Date(r.systemRange!.lastMs).toISOString(), spec.expect.ovdlaLast)
  })

  test("cases 1–8: each expected independent finding is present (with its stated cause where given)", () => {
    for (const e of spec.expect.findings as { case: string; rule: string; title: string; cause?: string }[]) {
      const f = finding(e.rule, new RegExp(e.title))
      assert.ok(f, `case ${e.case}: ${e.rule} /${e.title}/ not found`)
      if (e.cause) assert.ok((f.possibleCauses ?? []).some((c) => new RegExp(e.cause!).test(c)), `case ${e.case}: cause /${e.cause}/ missing`)
    }
  })

  test("cases 5–8 and 2: fuel items left Unresolved against DNV without the Bunker Report", () => {
    for (const id of spec.expect.unresolvedWithoutBunkerReport) {
      const c = result.correlations.find((x) => x.dnvId === id)!
      assert.equal(c.outcome, "unresolved", id)
      assert.match(c.explanation, /no Bunker Report was supplied/)
    }
  })

  test("DNV items reproduced independently; transcriptions flagged as unconfirmed", () => {
    for (const id of spec.expect.reproduced) {
      const c = result.correlations.find((x) => x.dnvId === id)!
      assert.equal(c.outcome, "independently-reproduced", id)
      assert.equal(c.evidenceConfirmed, false)
    }
  })
})
