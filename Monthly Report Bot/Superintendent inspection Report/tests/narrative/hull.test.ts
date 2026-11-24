import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createEmptyReport, type Rating } from "../../lib/form-schema"
import { emptyReportContext, type ReportContext } from "../../lib/narrative/context"
import { defaultSectionInputs, generateSection, normaliseSectionState, validateSection, type SectionInputs } from "../../lib/narrative/section"
import { HULL_SECTION, hullDefects } from "../../lib/narrative/sections/hull"
import { findingsRegister } from "../../lib/condition-overview"
import { STRUCTURAL_SECTION } from "../../lib/narrative/sections/structural"
import { placeholderProblems } from "../../lib/narrative/text"
import { outstandingForReview } from "../../lib/completeness"

function ctxWith(hull: Rating = "satisfactory", patch: Partial<ReportContext> = {}): ReportContext {
  // As stated once in the Preamble: laden, in port.
  const base = emptyReportContext({ vesselName: "DHT BRONCO", startDate: "2026-11-17", endDate: "2026-11-20", vesselCondition: { loading: "LADEN", situation: "PORT" }, ...patch })
  return { ...base, items: base.items.map((item) => (item.key === "hull" ? { ...item, rating: hull } : item)) }
}

function run(patch: SectionInputs, ctx = ctxWith()) {
  const inputs = { ...defaultSectionInputs(HULL_SECTION), ...patch }
  const generated = generateSection(HULL_SECTION, inputs, ctx)
  return { generated, validation: validateSection(HULL_SECTION, inputs, ctx, generated) }
}

const TYPICAL: SectionInputs = {
  vantage: ["LAUNCH", "BOARDING"],
  plating: "SOUND",
  topside: ["OPENINGS_OK"],
  markings: "CLEAR",
  coating: "INTACT",
  afSystem: "Jotun SeaQuantum Classic III",
  lastFullPaint: "2023-04-10",
  lastFullPaintPlace: "COSCO Zhoushan",
  growth: "NONE",
  uwStatus: "PREVIOUS",
  uwPlace: "Singapore",
  uwDate: "2026-07-13",
  uwBy: "Hydrex",
  uwSms: true,
  uwFindings: ["NO_FOULING", "PROP_POLISHED", "AF_GOOD"],
  propCoverage: "80",
  performance: "SATISFACTORY",
}

const warned = (v: { warnings: { field: string; message: string }[] }, field: string, pattern: RegExp) =>
  v.warnings.some((w) => w.field === `narr-hullCondition-${field}` && pattern.test(w.message))

describe("Hull remarks builder", () => {
  test("typical attendance: examination, plating, markings, coating, underwater and performance", () => {
    const { generated, validation } = run(TYPICAL)
    assert.deepEqual(validation.errors, [])
    assert.deepEqual(validation.warnings, [])
    assert.deepEqual(placeholderProblems(generated.text), [])
    assert.equal(generated.paragraphs.length, 5)
    const t = generated.text
    assert.match(t, /^The hull above the waterline was examined from a launch boat around the vessel and while boarding, with the vessel in laden condition\. The shell plating showed no deformation, indentation or contact damage\. Overboard discharges and shell openings were in good order\./)
    assert.match(t, /The draught marks, load line mark, vessel’s name, port of registry and IMO number were clearly visible\./)
    assert.match(t, /The last complete painting of the hull was carried out at COSCO Zhoushan in April 2023, about 3.5 years before this attendance\. The topside and boot-top coating was intact, with no breakdown\. The underwater hull is coated with Jotun SeaQuantum Classic III antifouling\. No marine growth was visible at the waterline\./)
    assert.match(t, /The last underwater hull inspection and propeller polishing were carried out by Hydrex at Singapore on 13 July 2026, within the six-monthly interval required by the SMS\./)
    assert.match(t, /approximately 80% of the propeller was covered with slime and algae, which were removed by polishing/)
    assert.match(t, /Hull performance is monitored and has been satisfactory, with no performance claims from charterers\.$/)
  })

  test("contact damage states where, and what was done, and asks for Class involvement", () => {
    const { generated, validation } = run(
      { ...TYPICAL, vantage: ["BERTH"], berthSide: "PORT", plating: "DAMAGE", location: "on the port side shell between frames 120 and 125", damageActions: ["MONITOR", "REPAIR_DD"] },
      ctxWith("degraded"),
    )
    assert.match(generated.text, /^The hull above the waterline was examined from the berth, with the vessel berthed port side alongside and in laden condition\. Indentation and contact damage were noted on the port side shell between frames 120 and 125\. The area is monitored by the ship’s staff with dated photographs, and permanent repair is planned at the next dry-docking\./)
    assert.ok(warned(validation, "damageActions", /Classification Society/))
  })

  test("illegible markings cite the Load Line Convention and ask for Deficient", () => {
    const { generated, validation } = run({ ...TYPICAL, markings: "NOT_LEGIBLE", markingsDetail: "the forward draught marks" }, ctxWith("degraded"))
    assert.match(generated.text, /The forward draught marks were not clearly legible and are to be re-marked\. Legible draught marks and load line mark are required by the International Convention on Load Lines/)
    assert.ok(warned(validation, "markings", /rate the hull Deficient/))
  })

  test("the rating and the text must agree", () => {
    assert.ok(warned(run({ ...TYPICAL, coating: "LOCAL", coatingExtent: "LT_1", coatingActions: ["MAKER_INSPECT"] }, ctxWith("satisfactory")).validation, "plating", /Acceptable may be the better rating/))
    assert.ok(warned(run({ ...TYPICAL, coating: "WIDESPREAD", coatingExtent: "GT_3", coatingActions: ["MAKER_ASSESSED", "DRY_DOCK"] }, ctxWith("acceptable")).validation, "plating", /Confirm the rating/))
    assert.ok(warned(run(TYPICAL, ctxWith("deficient")).validation, "plating", /no defect is recorded/))
    assert.ok(warned(run(TYPICAL, ctxWith("")).validation, "vantage", /Rate the hull/))
    assert.deepEqual(run({ ...TYPICAL, coating: "LOCAL", coatingExtent: "LT_1", coatingActions: ["MAKER_INSPECT"] }, ctxWith("acceptable")).validation.warnings, [])
  })

  test("required selections and gaps", () => {
    const { generated, validation } = run({ vantage: [] })
    assert.ok(generated.incomplete)
    for (const key of ["vantage", "plating", "markings", "coating"]) {
      assert.ok(validation.errors.some((e) => e.field === `narr-hullCondition-${key}`), key)
    }
  })

  test("an underwater inspection older than six months is flagged", () => {
    assert.ok(warned(run({ ...TYPICAL, uwDate: "2026-03-01" }).validation, "uwDate", /six months/))
  })

  test("differences from the Structural Condition summary are flagged", () => {
    const ctx = ctxWith("satisfactory", { sectionInputs: { structuralCondition: { uwStatus: "PREVIOUS", uwPlace: "Fujairah", uwDate: "2026-07-13", hull: ["NO_DEFORMATION"] } } })
    const { validation } = run({ ...TYPICAL, plating: "MINOR", location: "the bow" }, ctx)
    assert.ok(warned(validation, "uwStatus", /differ from the Executive Summary/))
    assert.ok(warned(validation, "plating", /Structural Condition summary states no deformation/))
  })
})

describe("Hull coating: last complete painting and paint maker", () => {
  const err = (v: { errors: { field: string; message: string }[] }, field: string, pattern: RegExp) =>
    v.errors.some((e) => e.field === `narr-hullCondition-${field}` && pattern.test(e.message))

  test("the last complete painting is stated first, with its age at the attendance", () => {
    assert.match(run({ ...TYPICAL, lastFullPaint: "2026-04-02", lastFullPaintPlace: "" }).generated.text, /The last complete painting of the hull was carried out in April 2026, about 7 months before this attendance\./)
    assert.match(run({ ...TYPICAL, lastFullPaint: "2025-11-20" }).generated.text, /in November 2025, about 1 year before this attendance\./)
    assert.match(run({ ...TYPICAL, afApplied: "2025-01-15" }).generated.text, /Jotun SeaQuantum Classic III antifouling, last applied in January 2025\./)
  })

  test("a place containing a comma is closed with a comma before the date", () => {
    assert.match(run({ ...TYPICAL, lastFullPaintPlace: "COSCO Zhoushan, at the third Special Survey" }).generated.text, /carried out at COSCO Zhoushan, at the third Special Survey, in April 2023,/)
  })

  test("the last complete painting is required and cannot be after the inspection", () => {
    assert.ok(err(run({ ...TYPICAL, lastFullPaint: "" }).validation, "lastFullPaint", /Enter/))
    assert.ok(err(run({ ...TYPICAL, lastFullPaint: "2027-01-10" }).validation, "lastFullPaint", /cannot be after/))
    assert.ok(warned(run({ ...TYPICAL, afApplied: "2022-01-10" }).validation, "afApplied", /before the last complete painting/))
  })

  test("paint performance: older than five years, and breakdown on a recent coating", () => {
    assert.ok(warned(run({ ...TYPICAL, lastFullPaint: "2021-03-01" }).validation, "lastFullPaint", /more than five years/))
    const recent = run({ ...TYPICAL, lastFullPaint: "2025-09-01", coating: "LOCAL", coatingExtent: "1_3", coatingActions: ["MAKER_INSPECT"] }, ctxWith("acceptable"))
    assert.ok(warned(recent.validation, "lastFullPaint", /paint maker’s warranty/))
  })

  test("there is no ship’s-staff touch-up option; coating damage needs the paint maker", () => {
    const field = HULL_SECTION.groups.flatMap((g) => g.fields).find((f) => f.key === "coatingActions")!
    assert.ok(field.kind === "multi" && !field.options.some((o) => /ship’s staff|touch-up/i.test(o.label)))
    const monitorOnly = run({ ...TYPICAL, coating: "LOCAL", coatingExtent: "LT_1", coatingActions: ["MONITOR"] }, ctxWith("acceptable"))
    assert.ok(err(monitorOnly.validation, "coatingActions", /paint maker’s assessment/))
    const none = run({ ...TYPICAL, topside: ["FENDER"] }, ctxWith("acceptable"))
    assert.ok(err(none.validation, "coatingActions", /Select at least one/), "fender damage is coating damage too")
  })

  test("the extent and the paint maker’s action are written; widespread breakdown needs a planned repair", () => {
    const local = run({ ...TYPICAL, coating: "LOCAL", coatingExtent: "1_3", coatingActions: ["MAKER_INSPECT", "MONITOR"] }, ctxWith("acceptable"))
    assert.match(local.generated.text, /Local coating breakdown and spot rust, estimated at 1–3% of the topside area, were noted at edges and welds of the topsides\. The paint maker’s representative will inspect the coating and advise on the repair, and the affected areas are monitored under the PMS with dated photographs until repaired\./)
    const wide = run({ ...TYPICAL, coating: "WIDESPREAD", coatingExtent: "GT_3", coatingActions: ["MAKER_INSPECT"] }, ctxWith("degraded"))
    assert.ok(warned(wide.validation, "coatingActions", /planned repair/))
    assert.ok(err(run({ ...TYPICAL, coating: "LOCAL", coatingActions: ["MAKER_INSPECT"] }, ctxWith("acceptable")).validation, "coatingExtent", /Select/))
  })
})

describe("Hull builder in the report", () => {
  test("a new Hull page starts from the Structural summary’s underwater and hull selections", () => {
    const r = createEmptyReport("seed")
    r.narratives = {
      structuralCondition: normaliseSectionState(STRUCTURAL_SECTION, {
        inputs: { uwStatus: "PREVIOUS", uwPlace: "Singapore", uwDate: "2026-07-13", uwFindings: ["NO_FOULING"], hull: ["NO_DEFORMATION", "MARKINGS", "FENDER_DAMAGE"] },
      }),
    }
    const state = normaliseSectionState(HULL_SECTION, undefined, HULL_SECTION.seed!(r))
    assert.equal(state.inputs.uwStatus, "PREVIOUS")
    assert.equal(state.inputs.uwPlace, "Singapore")
    assert.deepEqual(state.inputs.uwFindings, ["NO_FOULING"])
    assert.equal(state.inputs.plating, "SOUND")
    assert.equal(state.inputs.markings, "CLEAR")
    assert.deepEqual(state.inputs.topside, ["FENDER"])
    // Saved selections always win over the seed.
    const saved = normaliseSectionState(HULL_SECTION, { inputs: { uwStatus: "PLANNED" } }, HULL_SECTION.seed!(r))
    assert.equal(saved.inputs.uwStatus, "PLANNED")
  })

  test("the text is saved as the Hull item's remarks, keeping its rating and finding", () => {
    const r = createEmptyReport("target")
    r.deck.hull = { rating: "degraded", remarks: "", finding: { action: "x", priority: "planned", dueDate: "2027-01-01", safetyCritical: false, raStatus: "", raRef: "", defectRef: "", status: "open" } }
    const patch = HULL_SECTION.target!.write(r, "Generated hull text.")
    assert.equal(patch.deck!.hull.remarks, "Generated hull text.")
    assert.equal(patch.deck!.hull.rating, "degraded")
    assert.equal(patch.deck!.hull.finding?.action, "x")
    assert.equal(HULL_SECTION.target!.read({ ...r, ...patch }), "Generated hull text.")
  })

  test("the findings register gets only the defects, not the whole description", () => {
    const inputs = { ...defaultSectionInputs(HULL_SECTION), ...TYPICAL, plating: "MINOR", location: "the bow", topside: ["FENDER", "OPENINGS_OK"], coating: "LOCAL", coatingExtent: "LT_1", coatingActions: ["MAKER_INSPECT", "DRY_DOCK"] }
    assert.deepEqual(hullDefects(inputs), [
      "A minor indentation within Class allowable limits was noted on the bow.",
      "Abrasion and coating damage from fender contact was noted.",
      "Local coating breakdown and spot rust, estimated at less than 1% of the topside area, were noted at edges and welds of the topsides.",
    ])
    assert.deepEqual(hullDefects({ ...defaultSectionInputs(HULL_SECTION), ...TYPICAL }), [])
    const r = createEmptyReport("register")
    const text = generateSection(HULL_SECTION, inputs, ctxWith("degraded")).text
    Object.assign(r, HULL_SECTION.target!.write(r, text, HULL_SECTION.summary!(inputs, ctxWith("degraded"))))
    r.deck.hull.rating = "degraded"
    const entry = findingsRegister(r).find((e) => e.ref === "HUL-01")!
    assert.match(entry.description, /^A minor indentation within Class allowable limits was noted on the bow\./)
    assert.ok(!entry.description.includes("launch boat"), "the description of how the hull was examined stays in the remarks")
  })

  test("Hull remarks are mandatory, as the Executive Summary texts are", () => {
    const r = createEmptyReport("mandatory")
    r.deck.hull = { rating: "satisfactory", remarks: "" }
    assert.ok(outstandingForReview(r, 1).some((o) => o.section === "hull" && /save the text from the Hull builder/.test(o.label)))
    r.deck.hull = { rating: "na", remarks: "" }
    assert.ok(!outstandingForReview(r, 1).some((o) => o.section === "hull"))
  })
})
