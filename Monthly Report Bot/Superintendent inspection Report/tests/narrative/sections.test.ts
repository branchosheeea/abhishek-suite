import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { Rating } from "../../lib/form-schema"
import { emptyReportContext, type ReportContext } from "../../lib/narrative/context"
import {
  defaultSectionInputs,
  generateSection,
  normaliseSectionState,
  pruneSectionInputs,
  validateSection,
  type GeneratedNarrative,
  type SectionInputs,
  type SectionSpec,
} from "../../lib/narrative/section"
import { SUMMARY_SECTIONS } from "../../lib/narrative/sections"
import { OPERATIONAL_SECTION } from "../../lib/narrative/sections/operational"
import { OVERALL_SECTION } from "../../lib/narrative/sections/overall"
import { PERFORMANCE_SECTION } from "../../lib/narrative/sections/performance"
import { PROBLEMS_SECTION } from "../../lib/narrative/sections/problems"
import { PROJECTS_SECTION } from "../../lib/narrative/sections/projects"
import { STRUCTURAL_SECTION } from "../../lib/narrative/sections/structural"
import { placeholderProblems } from "../../lib/narrative/text"

const SHOW = process.env.SHOW_TEXT === "1"

function ctxWith(ratings: Record<string, Rating> = {}, patch: Partial<ReportContext> = {}): ReportContext {
  const base = emptyReportContext({ vesselName: "DHT COLT", startDate: "2026-09-25", endDate: "2026-09-30", ...patch })
  return { ...base, items: base.items.map((item) => ({ ...item, rating: ratings[item.key] ?? item.rating })) }
}

function run(spec: SectionSpec, patch: SectionInputs, ctx = ctxWith()) {
  const inputs = { ...defaultSectionInputs(spec), ...patch }
  const generated = generateSection(spec, inputs, ctx)
  const validation = validateSection(spec, inputs, ctx, generated)
  if (SHOW) console.log(`\n--- ${spec.title}\n${generated.text}\n`)
  return { inputs, generated, validation }
}

function assertClean(result: GeneratedNarrative) {
  assert.deepEqual(placeholderProblems(result.text), [], "no placeholders or broken punctuation")
  for (const p of result.paragraphs) {
    assert.match(p.text, /[.:]$/, `paragraph "${p.id}" ends with a full stop or colon: ${p.text}`)
    assert.match(p.text, /^[A-Z0-9]/, `paragraph "${p.id}" starts properly: ${p.text}`)
  }
  assert.doesNotMatch(result.text, /[.!?] +[a-z]/, "every sentence starts with a capital letter")
  assert.doesNotMatch(result.text, /\b(\w+) \1\b/i, "no repeated word")
  assert.doesNotMatch(result.text, /\bwere was\b|\bwas were\b|\bThe main engine were\b/, "subject–verb agreement")
}

const GOOD_RATINGS = { hull: "satisfactory", weatherDeck: "satisfactory", ballastTanks: "satisfactory", mainEngine: "satisfactory", dieselGenerator: "satisfactory", navigation: "satisfactory", lsa: "satisfactory", ffa: "satisfactory" } as const

describe("Overall Condition", () => {
  test("typical sailing-visit wording with the rating summary from the report", () => {
    const { generated, validation } = run(
      OVERALL_SECTION,
      {
        assessment: "GOOD",
        hullView: "LAUNCH",
        hullCondition: "GOOD",
        hullObservations: ["NO_DAMAGE", "COATING_INTACT", "MARKS_CLEAR"],
        deckCoating: "NEARING_COMPLETION",
        deckProgress: "with work pending on the pipelines across the manifold and aft",
        deckSupport: ["CREW_BRIEFED", "PAINT_ON_BOARD"],
        accommodation: "GOOD",
        accommodationNotes: ["HYGIENE", "GALLEY"],
        engineRoom: "GOOD",
        engineRoomNotes: ["COSMETIC_GOOD", "NO_LEAKS"],
        machineryMethod: "TESTED",
        machineryResult: "WITHIN_LIMITS",
        defects: ["RECTIFIED", "DDRL"],
        team: "GOOD",
      },
      ctxWith({ ...GOOD_RATINGS, cranes: "degraded" }),
    )
    assertClean(generated)
    assert.deepEqual(validation.errors, [])
    assert.match(generated.text, /^The vessel’s overall condition was assessed as good\. Of the 9 condition items rated in this report, 8 were rated Satisfactory and 1 Degraded\./)
    assert.match(generated.text, /The hull above the waterline, as observed from the launch, was in good condition\. No dents or structural damage were noted; the paint coating was intact; and the draught marks/)
    assert.match(generated.text, /Full-coat painting of the main deck is nearing completion, with work pending on the pipelines across the manifold and aft\./)
    assert.match(generated.text, /The performance of the main engine and auxiliary engines was checked during the attendance, and the parameters were within the maker’s recommended limits\./)
  })

  test("hull not observed states the reason instead of a condition", () => {
    const { generated } = run(OVERALL_SECTION, { assessment: "SATISFACTORY", hullView: "NOT_OBSERVED", hullNotObservedReason: "DARKNESS", engineRoom: "GOOD" })
    assert.match(generated.text, /The hull above the waterline could not be observed during the attendance because of darkness\./)
    assert.doesNotMatch(generated.text, /hull above the waterline, as observed/)
  })

  test("age-qualified assessment uses the year of build", () => {
    const { generated } = run(OVERALL_SECTION, { assessment: "SATISFACTORY_FOR_AGE", engineRoom: "SATISFACTORY" }, ctxWith({}, { vesselAge: 13 }))
    assert.match(generated.text, /assessed as satisfactory, having regard to her age of 13 years\./)
  })

  test("favourable assessment with Deficient items is flagged, not blocked", () => {
    const { validation } = run(OVERALL_SECTION, { assessment: "GOOD", engineRoom: "GOOD", defects: ["NONE_NOTED"] }, ctxWith({ mainEngine: "deficient" }))
    assert.deepEqual(validation.errors, [])
    assert.ok(validation.warnings.some((w) => /Deficient \(main engine\)/.test(w.message)))
    assert.ok(validation.warnings.some((w) => /No defects noted/.test(w.message)))
  })

  test("missing required choices leave no broken sentences", () => {
    const { generated, validation } = run(OVERALL_SECTION, { hullView: "LAUNCH" })
    assert.ok(validation.errors.some((e) => e.field === "narr-overallCondition-assessment"))
    assert.ok(validation.errors.some((e) => e.field === "narr-overallCondition-hullCondition"))
    assert.deepEqual(placeholderProblems(generated.text), [])
    assert.doesNotMatch(generated.text, /was in condition|assessed as\./)
  })
})

describe("Structural Condition", () => {
  test("coverage, underwater inspection, IACS coating and Class status", () => {
    const { generated, validation } = run(STRUCTURAL_SECTION, {
      assessment: "SATISFACTORY",
      hull: ["NO_DEFORMATION", "MARKINGS"],
      uwStatus: "PREVIOUS",
      uwPlace: "Singapore",
      uwDate: "2026-07-13",
      uwSms: true,
      uwFindings: ["MINIMAL_FOULING", "PROP_POLISHED", "AF_GOOD"],
      deckRust: "LT_1",
      deck: ["NO_CORROSION", "HELIDECK"],
      casing: "CLEAN",
      egcs: ["SATISFACTORY", "PIPING_MONITOR"],
      loadLine: true,
      wbtMethod: ["FROM_HATCH", "STAFF_REPORTS"],
      wbtTanks: "No. 2 wing ballast tanks",
      wbtStringer: "THIRD",
      wbtStaffDate: "2026-08-10",
      wbtCoating: "GOOD",
      wbtFindings: ["NO_PITTING", "ANODES_GOOD"],
      cargoTanks: "INERTED",
      cap: "CAP1",
      capScope: ["HULL", "CARGO", "MACHINERY"],
      classStatus: "NO_COC",
      annualFrom: "2026-10-10",
      annualTo: "2027-04-08",
    })
    assertClean(generated)
    assert.deepEqual(validation.errors, [])
    assert.match(generated.text, /^The structural condition of the vessel was assessed as satisfactory, based on the areas accessible during the attendance\./)
    assert.match(generated.text, /The last underwater hull inspection and propeller polishing were carried out at Singapore on 13 July 2026, within the six-monthly interval required by the SMS\./)
    assert.match(generated.text, /The Superintendent inspected No\. 2 wing ballast tanks from the access hatch down to the third stringer level\./)
    assert.match(generated.text, /All ballast tanks were last inspected internally by the ship’s staff in August 2026/)
    assert.match(generated.text, /coating condition was assessed as GOOD, as defined by IACS\./)
    assert.match(generated.text, /The cargo tanks could not be inspected as they were inerted\./)
    assert.match(generated.text, /The vessel holds a CAP 1 rating for hull, cargo system and machinery\./)
    assert.match(generated.text, /The next annual survey window is from 10 October 2026 to 8 April 2027\./)
  })

  test("an underwater inspection that could not be done says why", () => {
    const { generated } = run(STRUCTURAL_SECTION, { assessment: "GOOD", uwStatus: "NOT_POSSIBLE", uwPlace: "Singapore", uwReason: "CURRENT", wbtMethod: ["NOT_INSPECTED"], wbtReason: "BALLASTED" })
    assert.match(generated.text, /arranged at Singapore could not be carried out because of strong currents, and will be rearranged at the first opportunity\./)
    assert.match(generated.text, /Internal inspection of the ballast tanks by the Superintendent was not possible as the tanks were ballasted\./)
  })

  test("survey window ending before it starts is an error; old underwater date is a warning", () => {
    const { validation } = run(STRUCTURAL_SECTION, {
      assessment: "GOOD",
      wbtMethod: ["PHOTOS"],
      uwStatus: "PREVIOUS",
      uwPlace: "Singapore",
      uwDate: "2025-12-01",
      uwSms: true,
      annualFrom: "2027-04-08",
      annualTo: "2026-10-10",
    })
    assert.ok(validation.errors.some((e) => e.field === "narr-structuralCondition-annualTo"))
    assert.ok(validation.warnings.some((w) => /more than six months/.test(w.message)))
  })
})

describe("Operational Condition", () => {
  test("machinery, navigation, cargo, environmental systems, critical equipment, drills and SMS", () => {
    const { generated, validation } = run(
      OPERATIONAL_SECTION,
      {
        assessment: "GOOD",
        issues: "NONE",
        machineryScope: ["MAIN_ENGINE", "GENERATORS", "BOILERS"],
        machineryMethod: "TESTED",
        machineryResult: "WITHIN",
        machineryFacts: ["ME_MONTHLY", "STANDBY"],
        nav: "TESTED_OK",
        navItems: ["RADARS", "ECDIS", "GYRO"],
        navSurvey: "PLANNED",
        navSurveyPlan: "Singapore around 13 October 2026",
        cargo: "UNDERWAY",
        cargoResult: "SATISFACTORY",
        cargoFacts: ["IGS", "CRANES"],
        bwts: "OPERATIONAL",
        egcs: "OPEN_LOOP_OK",
        egcsPortStop: true,
        marpol: ["OWS", "RECORD_BOOKS"],
        includeCritical: true,
        criticalResult: "SATISFACTORY",
        criticalExtra: ["EMERGENCY"],
        drills: ["FIRE", "ABANDON"],
        drillResult: "SATISFACTORY",
        sms: ["PMS", "PTW_RA", "REST_HOURS", "NEAR_MISS"],
        smsResult: "NO_NC",
      },
      ctxWith(GOOD_RATINGS, { critical: { tested: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"], defects: [], total: 39 } }),
    )
    assertClean(generated)
    assert.deepEqual(validation.errors, [])
    assert.match(generated.text, /The main engine, diesel generators and auxiliary boilers were checked in operation during the attendance and were operating within the maker’s specified parameters\./)
    assert.match(generated.text, /Navigation and communication equipment, including both radars, the ECDIS units with up-to-date charts and software, and the gyro compasses and repeaters, was tested and found fully operational\./)
    assert.match(generated.text, /As the vessel was at sea, the cargo machinery could not be observed in operation/)
    assert.match(generated.text, /Of the 39 critical equipment items listed in this report, 12 were tested during the attendance, with satisfactory results\./)
    assert.match(generated.text, /In addition, the emergency generator, emergency fire pump and incinerator were run\./)
    assert.match(generated.text, /Fire and abandon-ship drills were witnessed, and the crew’s response was satisfactory\./)
    assert.match(generated.text, /The review of Safety Management System implementation covered Planned Maintenance System records, randomly cross-checked against the machinery; permit-to-work and risk assessment records; hours of rest records under STCW and MLC; and near-miss reports and the effectiveness of preventive measures\. No non-conformities were identified\./)
  })

  test("“Satisfactory results” for the critical tests is flagged when a test has a defect recorded", () => {
    const ctx = ctxWith(GOOD_RATINGS, { critical: { tested: ["Radar — Performance Test", "Emergency Fire Pump — Performance Test"], defects: ["Emergency Fire Pump — Performance Test"], total: 39 } })
    const { validation } = run(OPERATIONAL_SECTION, { assessment: "GOOD", includeCritical: true, criticalResult: "SATISFACTORY" }, ctx)
    assert.ok(validation.warnings.some((w) => w.field === "narr-operationalCondition-criticalResult" && /Emergency Fire Pump/.test(w.message)))
    const fine = run(OPERATIONAL_SECTION, { assessment: "GOOD", includeCritical: true, criticalResult: "DEFECTS" }, ctx)
    assert.ok(!fine.validation.warnings.some((w) => w.field === "narr-operationalCondition-criticalResult"))
  })

  test("a single machine agrees with a singular verb, and a single drill takes the right article", () => {
    const { generated } = run(OPERATIONAL_SECTION, {
      assessment: "SATISFACTORY",
      machineryScope: ["MAIN_ENGINE"],
      machineryMethod: "PERFORMANCE_RECORDED",
      machineryResult: "WITHIN",
      drills: ["ENCLOSED"],
      drillResult: "IMPROVEMENT",
    })
    assert.match(generated.text, /The main engine had its performance recorded during the voyage and was operating within/)
    assert.match(generated.text, /An enclosed-space rescue drill was witnessed, and improvement points were debriefed with the crew\./)
  })

  test("written-in drills join the standard drills, and an empty “Other” is an error", () => {
    const both = run(OPERATIONAL_SECTION, {
      assessment: "GOOD",
      drills: ["FIRE", "OTHER"],
      otherDrills: [
        { id: "a", name: "Ballast water spill drill" },
        { id: "b", name: "Cargo pump room rescue" },
      ],
      drillResult: "SATISFACTORY",
    })
    assert.match(both.generated.text, /Fire, ballast water spill and cargo pump room rescue drills were witnessed, and the crew’s response was satisfactory\./)
    assert.deepEqual(both.validation.errors, [])
    const single = run(OPERATIONAL_SECTION, { assessment: "GOOD", drills: ["OTHER"], otherDrills: [{ id: "a", name: "Engine room flooding" }], drillResult: "SATISFACTORY" })
    assert.match(single.generated.text, /An engine room flooding drill was witnessed/)
    const empty = run(OPERATIONAL_SECTION, { assessment: "GOOD", drills: ["FIRE", "OTHER"], drillResult: "SATISFACTORY" })
    assert.ok(empty.validation.errors.some((e) => e.field === "narr-operationalCondition-otherDrills"))
    assert.match(empty.generated.text, /A fire drill was witnessed/)
    const hidden = run(OPERATIONAL_SECTION, { assessment: "GOOD", drills: ["FIRE"], otherDrills: [{ id: "a", name: "Stale drill name" }], drillResult: "SATISFACTORY" })
    assert.doesNotMatch(hidden.generated.text, /stale/i, "written-in drills are ignored once “Other” is unticked")
  })

  test("“no operational issues” with a defective BWTS is flagged", () => {
    const { validation } = run(OPERATIONAL_SECTION, { assessment: "GOOD", issues: "NONE", bwts: "DEFECTIVE" })
    assert.ok(validation.warnings.some((w) => /No operational issues/.test(w.message)))
  })
})

describe("Performance", () => {
  test("charter party, hull and engine, and inspections stated with counts", () => {
    const { generated, validation } = run(PERFORMANCE_SECTION, {
      speed: "WITHIN_CP",
      cpMet: true,
      cargoOps: "NO_ISSUES",
      cargoPlace: "Quanzhou, China",
      offHire: "NONE",
      hull: "SATISFACTORY",
      lastDryDock: "2026-02-15",
      meTest: "TESTED",
      meRpm: "70",
      seaTrial: true,
      sfoc: "158.5",
      epl: true,
      eplLimit: "19,433 kW at 66 rpm",
      cii: "C",
      ciiYear: "2025",
      seemp: true,
      inspections: [
        { id: "a", type: "SIRE", by: "IMT", place: "Jieyang, China", date: "2026-08-23", result: "COUNT", count: "2", positive: "2", closure: "CLOSED", kpi: true },
        { id: "b", type: "FSI", by: "Marshall Islands", place: "Singapore", date: "2026-08-29", result: "NIL", kpi: false },
        { id: "c", type: "USCG", place: "San Diego, USA", date: "2026-06-02", result: "COUNT", count: "1", closure: "CLOSED" },
      ],
    })
    assertClean(generated)
    assert.deepEqual(validation.errors, [])
    assert.match(generated.text, /Recent cargo operations at Quanzhou, China, were completed without issues\./)
    assert.match(generated.text, /Hull performance since the last dry-docking in February 2026 has been satisfactory\./)
    assert.match(generated.text, /A main engine performance test was carried out during the attendance at 70 rpm, and the results were compared with the sea-trial data\./)
    assert.match(generated.text, /The SIRE 2\.0 inspection by IMT at Jieyang, China, on 23 August 2026 was completed with 2 negative observations and 2 positive observations, all of which have been closed, in line with the Company’s KPI\./)
    assert.match(generated.text, /The Flag State inspection by Marshall Islands at Singapore on 29 August 2026 was completed with nil deficiencies\./)
    assert.match(generated.text, /The USCG examination at San Diego, USA, on 2 June 2026 was completed with 1 deficiency, which has been closed\./)
  })

  test("CII D/E and a detention raise warnings; a non-numeric SFOC is an error", () => {
    const { validation } = run(PERFORMANCE_SECTION, {
      speed: "SATISFACTORY",
      cii: "E",
      ciiYear: "2025",
      sfoc: "about 160",
      inspections: [{ id: "a", type: "PSC", result: "DETENTION" }],
    })
    assert.ok(validation.warnings.some((w) => /SEEMP Part III/.test(w.message)))
    assert.ok(validation.warnings.some((w) => /detention/i.test(w.message)))
    assert.ok(validation.errors.some((e) => e.field === "narr-performance-sfoc"))
  })
})

describe("Significant Problems", () => {
  test("a problem with impact, actions, expected date and Flag dispensation", () => {
    const { generated, validation } = run(PROBLEMS_SECTION, {
      status: "LISTED",
      problems: [
        {
          id: "p1",
          system: "BWTS",
          description: "Inoperative because of a defective C2E cell",
          impact: "COMPLIANCE",
          actions: ["SPARES", "DISPENSATION", "COMPANY"],
          expected: "2026-10-20",
          validUntil: "2026-12-19",
        },
        { id: "p2", system: "LSA", description: "lifeboat davit handle limit switch not functioning", impact: "SAFETY", actions: ["RECTIFY"] },
      ],
    })
    assertClean(generated)
    assert.deepEqual(validation.errors, [])
    assert.match(generated.text, /^The following significant problems were identified:/)
    assert.match(
      generated.text,
      /1\. Ballast water management system: inoperative because of a defective C2E cell, affecting regulatory compliance\. Spares have been ordered; a dispensation has been obtained from the Flag Administration, valid until 19 December 2026; and the matter has been reported to the Company\. Completion is expected by 20 October 2026\./,
    )
    assert.match(generated.text, /2\. Life-saving appliances: lifeboat davit handle limit switch not functioning, affecting safety\. The vessel has been instructed to rectify the defect\./)
    assert.ok(validation.warnings.some((w) => /detainable at Port State Control/.test(w.message)), "safety-critical defect without Company/RA is flagged")
  })

  test("“None” while the report has Deficient items is flagged", () => {
    const { generated, validation } = run(PROBLEMS_SECTION, { status: "NONE", defectsHandedOver: true }, ctxWith({ steering: "deficient" }))
    assert.match(generated.text, /^No significant problems were identified during the attendance\. Defects identified during the inspection have been entered in the DDRL/)
    assert.ok(validation.warnings.some((w) => /steering gear/.test(w.message)))
  })

  test("an expired dispensation is flagged", () => {
    const { validation } = run(PROBLEMS_SECTION, {
      status: "LISTED",
      problems: [{ id: "p", system: "BWTS", description: "inoperative", actions: ["DISPENSATION"], validUntil: "2026-09-01" }],
    })
    assert.ok(validation.warnings.some((w) => /already passed/.test(w.message)))
  })
})

describe("Projects and Upgrades", () => {
  test("upcoming Special Survey and a completed Class-approved retrofit", () => {
    const { generated, validation } = run(PROJECTS_SECTION, {
      status: "LISTED",
      projects: [
        { id: "a", category: "DRY_DOCK", description: "the second Special Survey and dry-docking", status: "DUE", timing: "DATE", date: "2027-08-31", driver: "CLASS", approvals: [] },
        { id: "b", category: "REGULATORY", description: "upgrade of the BWTS to the non-filter type", status: "COMPLETED", timing: "DATE", date: "2026-08-29", approvals: ["CLASS_APPROVED", "CERT_REISSUED", "MOC"] },
        { id: "c", category: "FUEL", description: "the use of biofuel", status: "PLANNED", timing: "NEAR_FUTURE", driver: "CHARTERERS", approvals: [] },
      ],
    })
    assertClean(generated)
    assert.deepEqual(validation.errors, [])
    assert.match(generated.text, /The second Special Survey and dry-docking is due by 31 August 2027, as required by the Classification Society\./)
    assert.match(generated.text, /Upgrade of the BWTS to the non-filter type was completed on 29 August 2026\. The work was approved by the Classification Society, the relevant statutory certificate was reissued, and the change is managed/)
    assert.match(generated.text, /The use of biofuel is planned in the near future, in line with the charterers’ requirements\./)
    assert.ok(validation.warnings.some((w) => /Management of Change/.test(w.message)), "fuel project without MOC is flagged")
  })

  test("no projects", () => {
    const { generated } = run(PROJECTS_SECTION, { status: "NONE" })
    assert.equal(generated.text, "No projects or upgrades are currently planned.")
  })
})

describe("engine behaviour common to every section", () => {
  for (const spec of SUMMARY_SECTIONS) {
    test(`${spec.title}: empty inputs produce no broken text, saved state restores exactly`, () => {
      const empty = generateSection(spec, defaultSectionInputs(spec), ctxWith())
      assert.deepEqual(placeholderProblems(empty.text), [], `${spec.title}: ${empty.text}`)
      const state = { status: "DRAFT" as const, inputs: defaultSectionInputs(spec), generatedText: "", lastGeneratedAt: null, updatedAt: 1 }
      assert.deepEqual(normaliseSectionState(spec, JSON.parse(JSON.stringify(state))), state)
    })
  }

  test("unknown or damaged saved values fall back to defaults; list order is fixed", () => {
    const restored = normaliseSectionState(OVERALL_SECTION, {
      status: "WEIRD",
      inputs: { assessment: "RETIRED", hullObservations: ["MARKS_CLEAR", "NOPE", "NO_DAMAGE"], includeRatings: "yes" },
    })
    assert.equal(restored.status, "DRAFT")
    assert.equal(restored.inputs.assessment, "")
    assert.deepEqual(restored.inputs.hullObservations, ["NO_DAMAGE", "MARKS_CLEAR"])
    assert.equal(restored.inputs.includeRatings, true)
  })

  test("hidden fields never reach the text", () => {
    const inputs = { ...defaultSectionInputs(STRUCTURAL_SECTION), assessment: "GOOD", uwStatus: "PLANNED", uwPlace: "Fujairah", uwDate: "2020-01-01", uwFindings: ["AF_DEGRADED"] }
    const text = generateSection(STRUCTURAL_SECTION, inputs, ctxWith()).text
    assert.doesNotMatch(text, /2020|degradation/)
    assert.equal(pruneSectionInputs(STRUCTURAL_SECTION, inputs, ctxWith()).uwDate, "")
  })

  test("placeholders typed into text fields are errors", () => {
    const { validation } = run(PROBLEMS_SECTION, { status: "LISTED", problems: [{ id: "p", system: "BWTS", description: "XXXX unit defective", actions: ["SPARES"] }] })
    assert.ok(validation.errors.some((e) => e.field === "narr-significantProblems-problems-0-description"))
  })

  test("the same selections always give the same text", () => {
    const a = run(OPERATIONAL_SECTION, { assessment: "GOOD", sms: ["REST_HOURS", "PMS"], smsResult: "NO_NC" }).generated.text
    const b = run(OPERATIONAL_SECTION, { assessment: "GOOD", sms: ["PMS", "REST_HOURS"], smsResult: "NO_NC" }).generated.text
    assert.equal(a, b)
  })
})
