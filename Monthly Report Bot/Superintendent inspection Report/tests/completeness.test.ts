import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  isFinal,
  outstandingForFinal,
  outstandingForReview,
  reportStage,
  superintendentName,
  superintendentSignature,
} from "../lib/completeness"
import {
  CONDITION_SECTIONS,
  DETAILS_GROUPS,
  MANAGEMENT_SECTION_GROUPS,
  PARTICULARS_GROUPS,
  SUMMARY_FIELDS,
  createEmptyReport,
  emptyFinding,
  type Report,
} from "../lib/form-schema"

const SIG = "data:image/png;base64,AAAA"

/** A report with every mandatory input completed, but no Fleet Manager approval yet. */
function completeReport(): Report {
  const r = createEmptyReport("complete-report")
  const fill = (groups: { fields: { key: string; required?: boolean }[] }[], target: Record<string, string>) => {
    for (const f of groups.flatMap((g) => g.fields)) if (f.required) target[f.key] = f.key === "dateFrom" ? "2026-09-25" : f.key === "dateTo" ? "2026-09-30" : "x"
  }
  fill(DETAILS_GROUPS, r.details)
  r.details.inspectedBy = "Kamlesh Chauhan"
  fill(PARTICULARS_GROUPS, r.particulars)
  for (const key of ["critical", "system", "survey", "budget", "crew"] as const) fill(MANAGEMENT_SECTION_GROUPS[key], r.management)
  for (const f of SUMMARY_FIELDS) r.summary[f.key] = "Generated text."
  r.scope.s1 = true
  for (const section of CONDITION_SECTIONS) {
    for (const item of section.items) (section.source === "deck" ? r.deck : r.engine)[item.key] = { rating: "satisfactory", remarks: "" }
  }
  r.worklist = { issued: true, followUp: true }
  r.signoff.superintendentSignature = SIG
  return r
}

describe("mandatory inputs", () => {
  test("an empty report is a draft with outstanding items in every mandatory area", () => {
    const r = createEmptyReport("empty")
    const sections = new Set(outstandingForReview(r, 0).map((o) => o.section))
    for (const s of ["details", "particulars", "summary", "scope", "hull", "engine", "critical", "system", "survey", "budget", "crew", "photos", "signoff"]) {
      assert.ok(sections.has(s as never), `${s} has outstanding items`)
    }
    assert.equal(reportStage(r, 0), "draft")
    assert.equal(isFinal(r, 0), false)
  })

  test("a complete report waits for the Fleet Manager; approval makes it final", () => {
    const r = completeReport()
    assert.deepEqual(outstandingForReview(r, 1), [])
    assert.equal(reportStage(r, 1), "awaiting-approval")
    assert.deepEqual(outstandingForFinal(r, 1).map((o) => o.label), ["Fleet Manager’s name", "Fleet Manager’s approval date", "Fleet Manager’s signature"])
    r.signoff.fleetManagerName = "Jitendra Kumar"
    r.signoff.fleetManagerDate = "2026-10-02"
    r.signoff.fleetManagerSignature = SIG
    assert.equal(reportStage(r, 1), "approved")
    assert.equal(isFinal(r, 1), true)
  })

  test("photographs, worklist and the Superintendent's signature are required", () => {
    const r = completeReport()
    assert.ok(outstandingForReview(r, 0).some((o) => o.label === "At least one photograph"))
    r.worklist.followUp = false
    r.signoff.superintendentSignature = ""
    const labels = outstandingForReview(r, 1).map((o) => o.label)
    assert.ok(labels.includes("Confirm the Master will report work-list progress"))
    assert.ok(labels.includes("Superintendent’s signature"))
  })

  test("Degraded and Deficient ratings need remarks and a findings-register entry", () => {
    const r = completeReport()
    r.engine.mainEngine = { rating: "deficient", remarks: "" }
    const labels = () => outstandingForReview(r, 1).map((o) => o.label)
    assert.ok(labels().includes("Main engine: remarks (rated Deficient)"))
    assert.ok(labels().includes("Main engine: corrective action / controls"))
    assert.ok(labels().includes("Main engine: priority"))
    assert.ok(labels().includes("Main engine: due date"))
    assert.ok(labels().includes("Main engine: risk assessment status"))
    r.engine.mainEngine = {
      rating: "deficient",
      remarks: "No. 7 unit exhaust valve leaking.",
      finding: { ...emptyFinding(), action: "Valve overhauled at next port; load restricted until then.", priority: "priority", dueDate: "2026-10-15", raStatus: "completed", raRef: "" },
    }
    assert.deepEqual(labels(), ["Main engine: risk assessment number"])
    r.engine.mainEngine.finding!.raRef = "RA-2026-017"
    assert.deepEqual(labels(), [])
  })

  test("a Degraded finding needs no RA status unless Immediate; dry-dock and closed findings need no due date", () => {
    const r = completeReport()
    r.deck.hull = { rating: "degraded", remarks: "Coating breakdown at the boot top.", finding: { ...emptyFinding(), action: "Touch-up by crew.", priority: "drydock" } }
    assert.deepEqual(outstandingForReview(r, 1), [])
    r.deck.hull.finding = { ...r.deck.hull.finding!, priority: "immediate", dueDate: "2026-10-01" }
    assert.deepEqual(outstandingForReview(r, 1).map((o) => o.label), ["Hull structure, coating and hull marking: risk assessment status"])
    r.deck.hull.finding = { ...r.deck.hull.finding!, priority: "planned", dueDate: "", status: "closed" }
    assert.deepEqual(outstandingForReview(r, 1), [])
  })

  test("Not inspected needs the reason", () => {
    const r = completeReport()
    r.deck.ballastTanks = { rating: "notInspected", remarks: "" }
    assert.deepEqual(outstandingForReview(r, 1).map((o) => o.label), ["Water ballast tanks: reason it was not inspected"])
    r.deck.ballastTanks.remarks = "Tanks ballasted; no access during cargo operations."
    assert.deepEqual(outstandingForReview(r, 1), [])
  })

  test("earlier-scale Monitor / Action required must be re-rated, unless the report was already approved", () => {
    const r = completeReport()
    r.engine.steering = { rating: "fair", remarks: "Minor oil weep." }
    r.engine.erGeneral = { rating: "good", remarks: "" }
    assert.deepEqual(outstandingForReview(r, 1).map((o) => o.label), ["Steering gear: re-rate on the current scale (earlier rating: Monitor)"])
    Object.assign(r.signoff, { fleetManagerName: "Jitendra Kumar", fleetManagerDate: "2026-10-02", fleetManagerSignature: SIG })
    assert.equal(isFinal(r, 1), true)
  })

  test("critical tests carried out need a result; a defect needs a description and a finding", () => {
    const r = completeReport()
    r.management.critical_emergencyFirePump = "true"
    assert.deepEqual(outstandingForReview(r, 1).map((o) => o.label), ["Emergency Fire Pump — Performance Test: test result"])
    r.criticalResults = { critical_emergencyFirePump: { result: "defect", finding: emptyFinding(true) } }
    const labels = outstandingForReview(r, 1).map((o) => o.label)
    assert.ok(labels.includes("Emergency Fire Pump — Performance Test: defect found"))
    assert.ok(labels.includes("Emergency Fire Pump — Performance Test: risk assessment status"))
    r.criticalResults.critical_emergencyFirePump = {
      result: "defect",
      description: "Delivery pressure 4.2 bar against the required 5 bar at the highest hydrant.",
      finding: { ...emptyFinding(true), action: "Impeller renewed at next port; main fire pumps kept on standby.", priority: "immediate", dueDate: "2026-10-05", raStatus: "pending" },
    }
    assert.deepEqual(outstandingForReview(r, 1), [])
    r.criticalResults.critical_emergencyFirePump = { result: "satisfactory" }
    assert.deepEqual(outstandingForReview(r, 1), [])
  })

  test("reports approved before critical-test results existed stay approved", () => {
    const r = completeReport()
    r.management.critical_emergencyFirePump = "true"
    Object.assign(r.signoff, { fleetManagerName: "Jitendra Kumar", fleetManagerDate: "2026-10-02", fleetManagerSignature: SIG })
    assert.equal(r.criticalResults, undefined)
    assert.equal(isFinal(r, 1), true)
  })

  test("a report that becomes incomplete after approval is a draft again", () => {
    const r = completeReport()
    Object.assign(r.signoff, { fleetManagerName: "Jitendra Kumar", fleetManagerDate: "2026-10-02", fleetManagerSignature: SIG })
    r.summary.performance = ""
    assert.equal(reportStage(r, 1), "draft")
    assert.equal(isFinal(r, 1), false)
  })

  test("older reports: former Inspector signature and sign-off name still count", () => {
    const r = completeReport()
    r.signoff.superintendentSignature = ""
    r.signoff.inspectorSignature = SIG
    assert.equal(superintendentSignature(r), SIG)
    assert.deepEqual(outstandingForReview(r, 1), [])
    r.details.inspectedBy = ""
    r.signoff.superintendentName = "K. S. Chauhan"
    assert.equal(superintendentName(r), "K. S. Chauhan")
  })

  test("reports saved before the Fleet Manager fields existed load without errors", () => {
    const old = completeReport() as Report & { signoff: Record<string, unknown> }
    delete old.signoff.fleetManagerName
    delete old.signoff.fleetManagerDate
    delete old.signoff.fleetManagerSignature
    assert.equal(reportStage(old, 1), "awaiting-approval")
  })
})
