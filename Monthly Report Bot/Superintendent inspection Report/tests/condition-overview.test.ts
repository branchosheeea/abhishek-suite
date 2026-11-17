import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
  areaOverview,
  conclusion,
  criticalOverview,
  findingRef,
  findingsRegister,
  keyFigures,
  limitations,
  severity,
} from "../lib/condition-overview"
import { CONDITION_SECTIONS, createEmptyReport, emptyFinding, type Finding, type Rating, type Report } from "../lib/form-schema"

/** A report with every condition item rated Satisfactory. */
function rated(rating: Rating = "satisfactory"): Report {
  const r = createEmptyReport("overview")
  for (const section of CONDITION_SECTIONS) {
    for (const item of section.items) (section.source === "deck" ? r.deck : r.engine)[item.key] = { rating, remarks: "" }
  }
  return r
}

const finding = (patch: Partial<Finding> = {}): Finding => ({ ...emptyFinding(), action: "Rectify.", priority: "priority", dueDate: "2026-12-01", ...patch })
const area = (r: Report, id: string) => areaOverview(r).find((a) => a.id === id)!

describe("worst observed condition", () => {
  test("an area is reported by its worst item, never by an average", () => {
    const r = rated()
    r.engine.mainEngine = { rating: "deficient", remarks: "x", finding: finding() }
    r.engine.boiler = { rating: "acceptable", remarks: "" }
    const engine = area(r, "engine")
    assert.equal(engine.worst, "deficient")
    assert.equal(engine.deficient, 1)
    assert.equal(engine.assessed, engine.total)
  })

  test("severity order, including the earlier scale", () => {
    const order: Rating[] = ["satisfactory", "acceptable", "fair", "degraded", "poor", "deficient"]
    assert.deepEqual([...order].sort((a, b) => severity(a) - severity(b)), order)
    assert.equal(severity("good"), severity("satisfactory"))
    for (const r of ["", "na", "notInspected"] as Rating[]) assert.equal(severity(r), 0)
  })

  test("earlier-scale good reads as Satisfactory", () => {
    assert.equal(area(rated("good"), "hull").worst, "satisfactory")
  })
})

describe("coverage", () => {
  test("Complete, Limited (not inspected, reason recorded), Incomplete (unrated) and Not applicable", () => {
    const r = rated()
    r.deck.ballastTanks = { rating: "notInspected", remarks: "Tanks ballasted." }
    r.engine.boiler = { rating: "", remarks: "" }
    r.deck.navigation = { rating: "na", remarks: "" }
    assert.equal(area(r, "hull").coverage, "complete")
    assert.equal(area(r, "cargoBallast").coverage, "limited")
    assert.equal(area(r, "engine").coverage, "incomplete")
    assert.equal(area(r, "navigation").coverage, "notApplicable")
    assert.deepEqual(limitations(r), [{ areaTitle: "Cargo Tank / Water Ballast Tanks", item: "Water ballast tanks", reason: "Tanks ballasted." }])
  })

  test("coverage counts graded items against applicable items", () => {
    const r = rated()
    r.deck.ballastTanks = { rating: "notInspected", remarks: "x" }
    r.deck.navigation = { rating: "na", remarks: "" }
    const total = CONDITION_SECTIONS.reduce((n, s) => n + s.items.length, 0)
    assert.deepEqual(keyFigures(r).coverage, { assessed: total - 2, applicable: total - 1, percent: Math.round(((total - 2) / (total - 1)) * 100) })
  })
})

describe("conclusion", () => {
  test("withheld while items are unassessed; limited with Not inspected items; complete otherwise", () => {
    const empty = createEmptyReport("empty")
    assert.equal(conclusion(empty).state, "withheld")
    assert.match(conclusion(empty).text, /^Overall conclusion withheld – 25 items not assessed\./)
    const r = rated()
    assert.deepEqual(conclusion(r), { state: "complete", text: "All applicable items assessed." })
    r.deck.cargoHolds = { rating: "notInspected", remarks: "Loaded." }
    assert.equal(conclusion(r).state, "limited")
    assert.match(conclusion(r).text, /1 item not inspected/)
  })
})

describe("findings register", () => {
  test("Deficient first, then Immediate, then report order, with stable references", () => {
    const r = rated()
    r.deck.hull = { rating: "degraded", remarks: "Coating breakdown.", finding: finding({ priority: "planned" }) }
    r.deck.lsa = { rating: "degraded", remarks: "Lifebuoy light faulty.", finding: finding({ priority: "immediate", safetyCritical: true }) }
    r.engine.mainEngine = { rating: "deficient", remarks: "Exhaust valve leak.", finding: finding() }
    r.management.critical_emergencyFirePump = "true"
    r.criticalResults = { critical_emergencyFirePump: { result: "defect", description: "Low pressure.", finding: finding({ priority: "immediate", raStatus: "pending" }) } }
    const register = findingsRegister(r)
    assert.deepEqual(register.map((e) => e.ref), ["CRT-06", "ENG-02", "SAF-01", "HUL-01"])
    assert.deepEqual(register.map((e) => e.rating), ["deficient", "deficient", "degraded", "degraded"])
    assert.equal(register[0].source, "critical")
    assert.equal(findingRef("engine", 1), "ENG-02")
  })

  test("key figures: non-conformities, Immediate, open findings and RA pending", () => {
    const r = rated()
    r.engine.mainEngine = { rating: "deficient", remarks: "x", finding: finding({ raStatus: "completed", raRef: "RA-1" }) }
    r.engine.steering = { rating: "deficient", remarks: "x", finding: finding({ priority: "immediate", raStatus: "pending" }) }
    r.deck.hull = { rating: "degraded", remarks: "x", finding: finding({ priority: "immediate", status: "closed" }) }
    r.deck.weatherDeck = { rating: "degraded", remarks: "x", finding: finding() }
    const figures = keyFigures(r)
    assert.equal(figures.deficient, 2)
    assert.equal(figures.degraded, 2)
    assert.equal(figures.immediate, 1, "a closed Immediate finding is not an open action")
    assert.equal(figures.openFindings, 3)
    assert.equal(figures.raPending, 1, "completed RA and closed findings are not pending")
  })

  test("Satisfactory and Acceptable items raise no findings", () => {
    const r = rated("acceptable")
    assert.deepEqual(findingsRegister(r), [])
    assert.equal(keyFigures(r).openFindings, 0)
  })
})

describe("critical equipment", () => {
  test("tested, satisfactory, defects and results not recorded", () => {
    const r = createEmptyReport("critical")
    r.management.critical_radar = "true"
    r.management.critical_gmdss = "true"
    r.management.critical_generatorAutoStart = "true" // legacy key of the stand-by generator test
    r.criticalResults = { critical_radar: { result: "satisfactory" }, critical_gmdss: { result: "defect" } }
    assert.deepEqual(criticalOverview(r), { total: 39, tested: 3, satisfactory: 1, defects: 1, notRecorded: 1 })
  })
})
