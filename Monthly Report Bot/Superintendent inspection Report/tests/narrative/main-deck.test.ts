import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { findingsRegister } from "../../lib/condition-overview"
import { outstandingForReview } from "../../lib/completeness"
import { createEmptyReport, type Rating } from "../../lib/form-schema"
import { emptyReportContext, type ReportContext, type VesselCondition } from "../../lib/narrative/context"
import { defaultSectionInputs, generateSection, normaliseSectionState, validateSection, type SectionInputs } from "../../lib/narrative/section"
import { MAIN_DECK_SECTION, mainDeckDefects } from "../../lib/narrative/sections/mainDeck"
import { STRUCTURAL_SECTION } from "../../lib/narrative/sections/structural"
import { placeholderProblems } from "../../lib/narrative/text"

function ctxWith(rating: Rating = "satisfactory", patch: Partial<ReportContext> = {}): ReportContext {
  const vesselCondition: VesselCondition = { loading: "LADEN", situation: "SEA" }
  const base = emptyReportContext({ vesselName: "DHT BRONCO", startDate: "2026-11-17", endDate: "2026-11-20", vesselCondition, ...patch })
  return { ...base, items: base.items.map((item) => (item.key === "weatherDeck" ? { ...item, rating } : item)) }
}

function run(patch: SectionInputs, ctx = ctxWith()) {
  const inputs = { ...defaultSectionInputs(MAIN_DECK_SECTION), ...patch }
  const generated = generateSection(MAIN_DECK_SECTION, inputs, ctx)
  return { generated, validation: validateSection(MAIN_DECK_SECTION, inputs, ctx, generated) }
}

const warned = (v: { warnings: { field: string; message: string }[] }, field: string, pattern: RegExp) =>
  v.warnings.some((w) => w.field === `narr-mainDeckCondition-${field}` && pattern.test(w.message))
const erred = (v: { errors: { field: string; message: string }[] }, field: string, pattern: RegExp) =>
  v.errors.some((e) => e.field === `narr-mainDeckCondition-${field}` && pattern.test(e.message))

// Modelled on report 09: a well-kept deck with a full-coat programme in progress during a laden voyage.
const REPORT_09: SectionInputs = {
  prevStatus: "ALL_CLOSED",
  areas: ["MAIN", "FORECASTLE", "POOP"],
  structure: "SOUND",
  deckRust: "NONE",
  coatingCondition: "GOOD",
  lastDeckCoating: "2024-03-10",
  paintSystem: "Jotun Jotamastic 87 with Hardtop XP finish",
  painting: "FULL_COAT",
  completedSections: "the deck in way of Nos. 1–3 COTs and the forecastle",
  remaining: "the deck in way of COTs 4P/C/S",
  completion: "NEXT_BALLAST",
  paintStock: true,
  surfacePrep: "POWER_TOOL",
  dftRecorded: true,
  discussedWith: ["CO", "BOSUN", "CREW"],
  paintTraining: "ADEQUATE",
  dataSheets: true,
  equipment: ["GRIT", "SPRAY", "DFT"],
  pipes: ["RUST_FREE", "TEFLON"],
  safety: ["WALKWAYS", "BONDING", "SCUPPERS", "SAVEALLS", "SPILL"],
  verifyBonding: "SIGHTED",
  venting: ["PV_OK", "BREAKER", "DECK_SEAL", "MAST_RISER", "FLAME_SCREENS", "SEAL_ALARM"],
  verifyPv: "TESTED",
  verifyDeckSeal: "TESTED",
  pvLastMaintenance: "2026-08-15",
  tankOpenings: "SECURED",
  exEquipment: "OK",
  weathertight: "OK",
  tempRepairs: "NONE",
  hydraulic: "NO_LEAKS",
  accommodation: "GOOD",
  casing: "CLEAN",
}

describe("Main Deck remarks builder", () => {
  test("a well-kept deck: plating, painting programme, pipelines, safety, venting, hydraulics, superstructure", () => {
    const { generated, validation } = run(REPORT_09)
    assert.deepEqual(validation.errors, [])
    assert.deepEqual(validation.warnings, [])
    assert.deepEqual(placeholderProblems(generated.text), [])
    const t = generated.text
    assert.match(t, /^All deck findings of the previous inspection have been closed and were verified on board\.\n\nThe weather deck was inspected, covering the main deck, the forecastle deck and the poop deck\. The deck plating was structurally sound, with no buckling, cracking or wastage\. No rust spots were noted\.\n\nThe deck coating was assessed as GOOD, as defined by IACS\. The deck was last fully coated in March 2024, about 2\.5 years before this attendance\./)
    assert.match(t, /The deck is coated with Jotun Jotamastic 87 with Hardtop XP finish\. A full-coat painting programme for the main deck, pipelines and fittings is in progress\. Painting of the deck in way of Nos\. 1–3 COTs and the forecastle has been completed, with the deck in way of COTs 4P\/C\/S remaining\. The work is planned to be completed during the next ballast leg\. Sufficient paint is on board to complete the work\. Surfaces are prepared by power-tool cleaning to St 2 \/ St 3, and DFT readings are recorded against the paint maker’s specification\./)
    assert.match(t, /The deck painting scope was discussed with the Chief Officer, the Bosun and the deck crew to confirm their understanding of the work and the training they have received\. The crew were found familiar with surface preparation and application to the paint maker’s specification\. The paint maker’s technical data sheets and application guidelines are available on board\./)
    assert.match(t, /Deck maintenance equipment on board, including a mini grit blaster, an airless paint spray machine and a DFT gauge, was in working order\./)
    assert.match(t, /The pipelines and supports were free of rust, and the pipelines were supported on Teflon pads with Teflon-coated clamps\./)
    assert.match(t, /the cargo line bonding straps were in place, sighted during the attendance/)
    assert.match(t, /the scupper plugs were in place and readily available/)
    assert.match(t, /the deck oil spill equipment in the SOPEP locker was fully stocked/)
    assert.match(t, /The PV valves were inspected and found free of leakage, verified by function test during the attendance; the PV breaker liquid level was correct; the deck seal \(verified by function test during the attendance\) and the mast riser were in order; the flame screens and high-velocity vents were clean and intact; and the deck seal water level and its low-level alarm were tested satisfactorily\. The last PV valve maintenance under the PMS was carried out in August 2026\. Ullage and sounding plugs, Butterworth covers and tank lids were secured with all fastenings, with no vapour leakage\./)
    assert.match(t, /Ex-rated deck lights, junction boxes and cable glands in the hazardous areas were intact, and cables and cable trays were secured\. Weathertight doors and hatches, including the forecastle and bosun stores, deckhouses and the emergency fire pump room, closed properly, with their dogs, gaskets and hinges in order\./)
    assert.match(t, /No temporary repairs were found on deck\./)
    assert.match(t, /The accommodation block exterior was in good condition\. The engine room casing and funnel were clean and free of stains and leaks\.$/)
  })

  test("report 07: painting delayed by weather, PV valves needing de-rusting", () => {
    const { generated } = run({ ...REPORT_09, completedSections: "most of the deck", remaining: "a few sections under the cargo pipelines in way of Nos. 4 and 5 COTs", delay: "WEATHER", completion: "NEXT_LADEN", venting: ["PV_OK", "BREAKER", "PV_DERUST"] }, ctxWith("acceptable", { vesselCondition: { loading: "BALLAST", situation: "SEA" } }))
    assert.match(generated.text, /Progress has been delayed by inclement weather\. The work is planned to be completed during the next laden leg\./)
    assert.match(generated.text, /De-rusting and cosmetic maintenance of the PV valves is required\./)
  })

  test("crew painting is accepted; the paint maker is involved for a coating failure", () => {
    const { generated, validation } = run({ ...REPORT_09, painting: "FAILURE" }, ctxWith("degraded"))
    assert.match(generated.text, /Premature breakdown of the deck coating was noted, and the paint maker has been asked to assess it and advise on the repair\./)
    assert.deepEqual(validation.errors, [])
  })

  test("required fields leave gaps and errors", () => {
    const { generated, validation } = run({})
    assert.ok(generated.incomplete)
    for (const key of ["areas", "structure", "deckRust", "painting", "pipes", "venting", "hydraulic"]) {
      assert.ok(validation.errors.some((e) => e.field === `narr-mainDeckCondition-${key}`), key)
    }
    assert.ok(erred(run({ ...REPORT_09, completion: "" }).validation, "completion", /Select/))
  })
})

describe("Main Deck cross-checks", () => {
  test("the rating and the text must agree", () => {
    assert.ok(warned(run({ ...REPORT_09, deckRust: "SCATTERED" }, ctxWith("satisfactory")).validation, "deckRust", /Acceptable may be the better rating/))
    assert.ok(warned(run({ ...REPORT_09, hydraulic: "LEAKS", hydraulicWhere: "the forward winch supply line" }, ctxWith("acceptable")).validation, "structure", /Confirm the rating/))
    assert.ok(warned(run(REPORT_09, ctxWith("degraded")).validation, "structure", /no defect is recorded/))
  })

  test("missing bonding straps, missing scupper plugs or a passing PV valve suggest Deficient", () => {
    const bonding = run({ ...REPORT_09, safety: ["WALKWAYS"], safetyDefects: ["BONDING"] }, ctxWith("degraded"))
    assert.ok(warned(bonding.validation, "safetyDefects", /consider rating the weather deck Deficient/))
    assert.match(bonding.generated.text, /However, cargo line bonding straps were missing or damaged, and these are to be rectified\./)
    const pv = run({ ...REPORT_09, venting: ["BREAKER", "PV_LEAK"], pvLeakWhere: "No. 5 COT (S)" }, ctxWith("deficient"))
    assert.ok(!warned(pv.validation, "safetyDefects", /Deficient/))
    assert.match(pv.generated.text, /A PV valve was found passing at No\. 5 COT \(S\) and is to be overhauled\./)
  })

  test("contradictory selections are errors", () => {
    assert.ok(erred(run({ ...REPORT_09, safetyDefects: ["SCUPPERS"] }).validation, "safetyDefects", /both as in order and as a deficiency/))
    assert.ok(erred(run({ ...REPORT_09, venting: ["PV_OK", "PV_LEAK"], pvLeakWhere: "x" }).validation, "venting", /cannot both/))
  })

  test("PV valve maintenance: after the inspection is an error, older than six months a warning", () => {
    assert.ok(erred(run({ ...REPORT_09, pvLastMaintenance: "2027-01-05" }).validation, "pvLastMaintenance", /cannot be after/))
    assert.ok(warned(run({ ...REPORT_09, pvLastMaintenance: "2026-03-01" }).validation, "pvLastMaintenance", /more than six months/))
  })

  test("planned completion is checked against laden / ballast from the Preamble", () => {
    const inBallast = ctxWith("satisfactory", { vesselCondition: { loading: "BALLAST", situation: "SEA" } })
    assert.ok(warned(run(REPORT_09, inBallast).validation, "completion", /in ballast now/))
    assert.deepEqual(MAIN_DECK_SECTION.facts!(inBallast), [["Vessel condition (from the Preamble)", "ballast, at sea"]])
  })

  test("differences from the Structural Condition summary are flagged", () => {
    const ctx = ctxWith("satisfactory", { sectionInputs: { structuralCondition: { deckRust: "LT_1", casing: "STAINS" } } })
    const { validation } = run(REPORT_09, ctx)
    assert.ok(warned(validation, "deckRust", /differs from the Executive Summary/))
    assert.ok(warned(validation, "casing", /differ from the Executive Summary/))
  })
})

describe("Main Deck: Technical Director review additions", () => {
  test("previous inspection’s open findings are listed first, and an overdue one is flagged", () => {
    const { generated, validation } = run(
      {
        ...REPORT_09,
        prevStatus: "SOME_OPEN",
        prevOpen: [
          { id: "a", finding: "corrosion of the IG line supports in way of No. 2 COT", status: "OVERDUE", revisedDue: "2026-12-15" },
          { id: "b", finding: "anti-skid renewal on the starboard walkway", status: "OPEN", revisedDue: "" },
        ],
      },
      ctxWith("acceptable"),
    )
    assert.match(generated.text, /^Of the previous inspection’s deck findings, the following remain open: corrosion of the IG line supports in way of No\. 2 COT \(overdue, now due by 15 December 2026\) and anti-skid renewal on the starboard walkway \(open\)\./)
    assert.ok(warned(validation, "prevOpen", /overdue finding/))
  })

  test("painting progress is stated by sections; DFT, crew discussion and paint system are asked for", () => {
    const bare = run({ ...REPORT_09, dftRecorded: false, discussedWith: [], paintSystem: "" })
    assert.ok(warned(bare.validation, "dftRecorded", /DFT readings/))
    assert.ok(warned(bare.validation, "discussedWith", /Chief Officer, Bosun and deck crew/))
    assert.ok(warned(bare.validation, "paintSystem", /deck paint in use/))
    assert.ok(erred(run({ ...REPORT_09, completedSections: "" }).validation, "completedSections", /Enter/))
    const refresher = run({ ...REPORT_09, discussedWith: ["CO"], paintTraining: "REFRESHER_MAKER" })
    assert.match(refresher.generated.text, /discussed with the Chief Officer to confirm their understanding of the work and the training they have received\. Training of the deck crew by the paint maker’s representative is to be arranged\./)
    assert.ok(erred(run({ ...REPORT_09, paintTraining: "" }).validation, "paintTraining", /Select/))
  })

  test("Ex equipment, weathertight closures and tank openings: defects are written with where and action, and suggest Deficient", () => {
    const { generated, validation } = run(
      {
        ...REPORT_09,
        exEquipment: "DEFECT",
        exEquipmentWhere: "the deck light junction box at the starboard manifold",
        exEquipmentAction: "ISOLATED",
        weathertight: "DEFECT",
        weathertightWhere: "the bosun store door: two dogs seized, gasket hardened",
        weathertightAction: "PLANNED",
        tankOpenings: "DEFECT",
        tankOpeningsWhere: "the Butterworth cover of No. 3 COT (P)",
      },
      ctxWith("degraded"),
    )
    assert.match(generated.text, /Defective Ex-rated electrical equipment was found at the deck light junction box at the starboard manifold, and the item has been isolated or secured and spares have been ordered\./)
    assert.match(generated.text, /Defective weathertight closures were found at the bosun store door: two dogs seized, gasket hardened, and repair has been planned\./)
    assert.match(generated.text, /Tank openings were found not secured or leaking vapour at the Butterworth cover of No\. 3 COT \(P\), and these were to be secured immediately\./)
    assert.ok(warned(validation, "exEquipment", /consider rating the weather deck Deficient/))
  })

  test("temporary repairs are listed with Class status and permanent repair; Class not informed and CoC are flagged", () => {
    const { generated, validation } = run(
      {
        ...REPORT_09,
        tempRepairs: "PRESENT",
        tempItems: [
          { id: "t1", type: "PIPE_CLAMP", where: "the stripping line near No. 4 COT (S)", classStatus: "NOT_INFORMED", permanent: "NEXT_PORT" },
          { id: "t2", type: "DOUBLER", where: "the deck plating in way of No. 1 COT (P)", classStatus: "COC", permanent: "NEXT_DD" },
        ],
      },
      ctxWith("degraded"),
    )
    assert.match(generated.text, /The following temporary repairs are on deck: a pipe clamp at the stripping line near No\. 4 COT \(S\), not yet reported to the Classification Society, with permanent repair at the next port; and a doubler plate at the deck plating in way of No\. 1 COT \(P\), under a Condition of Class, with permanent repair at the next dry-docking\./)
    assert.ok(warned(validation, "tempItems", /report it to Class/))
    assert.ok(warned(validation, "tempItems", /Significant Problems/))
    assert.ok(warned(run({ ...REPORT_09, tempRepairs: "PRESENT", tempItems: [{ id: "t", type: "CEMENT_BOX", where: "x", classStatus: "INFORMED", permanent: "NEXT_DD" }] }, ctxWith("satisfactory")).validation, "structure", /Confirm the rating/))
  })
})

describe("Main Deck: deck coating condition", () => {
  test("condition on the IACS scale, type of breakdown and the coating’s age", () => {
    const { generated, validation } = run({ ...REPORT_09, deckRust: "LT_1", coatingCondition: "FAIR", coatingDefects: ["EDGES", "CHALKING"] }, ctxWith("acceptable"))
    assert.match(generated.text, /The deck coating was assessed as FAIR, as defined by IACS, with local breakdown at edges and welds and chalking of the finish coat\. The deck was last fully coated in March 2024, about 2\.5 years before this attendance\./)
    assert.deepEqual(validation.warnings, [])
    assert.ok(erred(run({ ...REPORT_09, coatingCondition: "" }).validation, "coatingCondition", /Select/))
  })

  test("a completed full coat supplies the coating date; the separate field is not asked", () => {
    const { generated } = run({ ...REPORT_09, painting: "COMPLETED", completedIn: "2025-06-01", lastDeckCoating: "2020-01-01" })
    assert.match(generated.text, /Full-coat painting of the main deck, pipelines and fittings was completed in June 2025\./)
    assert.ok(!/last fully coated/.test(generated.text))
  })

  test("cross-checks: rust extent, rating, repair plan and early breakdown", () => {
    assert.ok(warned(run({ ...REPORT_09, coatingCondition: "GOOD", deckRust: "SCATTERED" }, ctxWith("acceptable")).validation, "coatingCondition", /disagree/))
    assert.ok(warned(run({ ...REPORT_09, coatingCondition: "POOR" }, ctxWith("acceptable")).validation, "coatingCondition", /confirm the rating/))
    assert.ok(warned(run({ ...REPORT_09, coatingCondition: "FAIR", deckRust: "LT_1" }, ctxWith("satisfactory")).validation, "coatingCondition", /Acceptable may be the better rating/))
    assert.ok(warned(run({ ...REPORT_09, coatingCondition: "POOR", deckRust: "SIGNIFICANT", painting: "NONE" }, ctxWith("degraded")).validation, "painting", /no painting programme/))
    const early = run({ ...REPORT_09, deckRust: "LT_1", coatingCondition: "FAIR", coatingDefects: ["BLISTERING"], lastDeckCoating: "2025-09-01" }, ctxWith("acceptable"))
    assert.ok(warned(early.validation, "coatingDefects", /warranty claim/))
    assert.ok(erred(run({ ...REPORT_09, lastDeckCoating: "2027-02-01" }).validation, "lastDeckCoating", /cannot be after/))
  })

  test("POOR (or FAIR with breakdown) is stated in the findings register", () => {
    const inputs = { ...defaultSectionInputs(MAIN_DECK_SECTION), ...REPORT_09, deckRust: "SIGNIFICANT", coatingCondition: "POOR", coatingDefects: ["FLAKING", "MECHANICAL"] }
    assert.equal(mainDeckDefects(inputs)[0], "The deck coating was assessed as POOR, as defined by IACS, with flaking and detachment of the coating.")
    const fairCosmetic = { ...defaultSectionInputs(MAIN_DECK_SECTION), ...REPORT_09, coatingCondition: "FAIR", coatingDefects: ["MECHANICAL"] }
    assert.ok(!mainDeckDefects(fairCosmetic).some((d) => /coating was assessed/.test(d)))
  })
})

describe("Main Deck in the report", () => {
  test("a new page starts from the Structural summary’s deck, casing and EGCS selections", () => {
    const r = createEmptyReport("seed")
    r.narratives = {
      structuralCondition: normaliseSectionState(STRUCTURAL_SECTION, {
        inputs: { deckRust: "LT_0_1", deck: ["NO_CORROSION", "MANHOLE_WEEPING"], casing: "STAINS", egcs: ["SATISFACTORY"] },
      }),
    }
    const inputs = normaliseSectionState(MAIN_DECK_SECTION, undefined, MAIN_DECK_SECTION.seed!(r)).inputs
    assert.equal(inputs.deckRust, "LT_0_1")
    assert.equal(inputs.structure, "SOUND")
    assert.deepEqual(inputs.pipes, ["RUST_FREE"])
    assert.deepEqual(inputs.weeping, ["DOMES", "MANHOLES"])
    assert.equal(inputs.casing, "STAINS")
    assert.deepEqual(inputs.egcs, ["SATISFACTORY"])
  })

  test("saved as the Weather deck remarks; the findings register gets only the defects", () => {
    const inputs = { ...defaultSectionInputs(MAIN_DECK_SECTION), ...REPORT_09, deckRust: "SCATTERED", safety: ["WALKWAYS"], safetyDefects: ["SCUPPERS"] }
    assert.deepEqual(mainDeckDefects(inputs), ["Scattered spot rust was noted.", "Scupper plugs were missing or not readily available."])
    const r = createEmptyReport("target")
    r.deck.weatherDeck = { rating: "degraded", remarks: "" }
    const ctx = ctxWith("degraded")
    Object.assign(r, MAIN_DECK_SECTION.target!.write(r, generateSection(MAIN_DECK_SECTION, inputs, ctx).text, MAIN_DECK_SECTION.summary!(inputs, ctx)))
    assert.equal(r.deck.weatherDeck.rating, "degraded")
    assert.match(r.deck.weatherDeck.remarks, /^All deck findings of the previous inspection have been closed[^]*The weather deck was inspected/)
    assert.equal(findingsRegister(r).find((e) => e.ref === "DCK-01")?.description, "Scattered spot rust was noted. Scupper plugs were missing or not readily available.")
  })

  test("the Weather deck remarks are mandatory", () => {
    const r = createEmptyReport("mandatory")
    r.deck.weatherDeck = { rating: "satisfactory", remarks: "" }
    assert.ok(outstandingForReview(r, 1).some((o) => o.section === "mainDeck" && /Main Deck builder/.test(o.label)))
  })
})
