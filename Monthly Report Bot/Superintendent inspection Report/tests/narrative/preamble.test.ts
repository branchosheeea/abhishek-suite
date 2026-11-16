import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { generatePreamble } from "../../lib/narrative/preamble/generate"
import { pruneHidden, toggleExclusive } from "../../lib/narrative/preamble/model"
import { assertProfessional, FACTS, generate, inputs, sentences } from "./helpers"

const first = (text: string) => text.split("\n\n")[0]

describe("attendance paragraph", () => {
  test("port inspection alongside", () => {
    const r = generate(
      { inspectionType: "PORT", location: "Singapore", vesselStatus: "ALONGSIDE", operatingCondition: "PREVAILING_PORT" },
      { startDate: "2026-03-12", endDate: "2026-03-12", vesselName: "DHT COLT" },
    )
    assert.equal(
      first(r.text),
      "The Superintendent attended the vessel DHT COLT at Singapore on 12 March 2026 while she was alongside in port, to conduct a port-based Superintendent’s inspection in accordance with the Company’s inspection requirements.",
    )
    assert.match(r.text, /under the prevailing port conditions, and the available records/)
    assertProfessional(r)
  })

  test("laden sailing inspection carries the destination in the passage", () => {
    const r = generate({
      inspectionType: "SAILING",
      attendanceAction: "JOINED_REMAINED",
      locationType: "PORT_TO_PORT",
      joiningLocation: "Galle, Sri Lanka",
      disembarkationLocation: "Singapore",
      vesselStatus: "LADEN_PASSAGE",
    })
    assert.match(first(r.text), /joined the vessel DHT LEOPARD at Galle, Sri Lanka, and remained on board from 25 to 30 September 2026 during the vessel’s laden passage to Singapore, to conduct a sailing Superintendent’s inspection/)
    assertProfessional(r)
  })

  test("ballast sailing inspection", () => {
    const r = generate({
      inspectionType: "SAILING",
      attendanceAction: "BOARDED_REMAINED",
      locationType: "PORT_TO_PORT",
      joiningLocation: "Fujairah",
      disembarkationLocation: "Ras Tanura",
      vesselStatus: "BALLAST_PASSAGE",
      operatingCondition: "BALLAST_SEAGOING",
    })
    assert.match(first(r.text), /boarded the vessel DHT LEOPARD at Fujairah and remained on board from 25 to 30 September 2026 during the vessel’s ballast passage to Ras Tanura,/)
    assert.match(r.text, /under ballast sea-going conditions/)
    assertProfessional(r)
  })

  test("sea-passage action uses the passage once, not twice", () => {
    const r = generate({
      inspectionType: "SAILING",
      attendanceAction: "SEA_PASSAGE",
      locationType: "PORT_TO_PORT",
      joiningLocation: "Galle",
      disembarkationLocation: "Singapore",
      vesselStatus: "LADEN_PASSAGE",
    })
    assert.match(first(r.text), /joined the vessel DHT LEOPARD at Galle for the laden passage to Singapore from 25 to 30 September 2026, to conduct/)
    assert.equal(first(r.text).match(/passage/g)?.length, 1)
    assertProfessional(r)
  })

  test("non-passage status with a port-to-port attendance names the arrival port", () => {
    const r = generate({
      attendanceAction: "JOINED_REMAINED",
      locationType: "PORT_TO_PORT",
      joiningLocation: "Galle",
      disembarkationLocation: "Singapore",
      vesselStatus: "NORMAL_SEAGOING",
    })
    assert.match(first(r.text), /remained on board from 25 to 30 September 2026 until her arrival at Singapore while she was operating under normal sea-going conditions,/)
    assertProfessional(r)
  })

  test("dry-docking inspection at a shipyard with Special Survey number and completion date", () => {
    const r = generate({
      inspectionType: "DRY_DOCKING_SPECIAL_SURVEY",
      attendanceAction: "DURING_DRY_DOCKING",
      locationType: "SHIPYARD",
      shipyardName: "Sembcorp Marine Admiralty Yard",
      shipyardPort: "Singapore",
      shipyardCountry: "Singapore",
      vesselStatus: "SPECIAL_SURVEY_DRY_DOCKING",
      operatingCondition: "DRY_DOCKING_REPAIR",
      specialSurveyNumber: "3",
      dockingCompletionDate: "2026-09-29",
      additionalFocusAreas: ["DRY_DOCKING"],
    })
    assert.match(
      first(r.text),
      /attended the vessel DHT LEOPARD during dry-docking at Sembcorp Marine Admiralty Yard, Singapore, from 25 to 30 September 2026 while she was undergoing Special Survey dry-docking, to conduct a dry-docking and Special Survey inspection/,
    )
    assert.match(first(r.text), /The dry-docking was undertaken in connection with the vessel’s third Special Survey and was completed on 29 September 2026\./)
    assert.match(r.text, /Particular attention was given to the verification of repairs/)
    assertProfessional(r)
  })

  test("dry-docking completion after the attendance is described as planned, not completed", () => {
    const r = generate({ inspectionType: "DRY_DOCKING_SPECIAL_SURVEY", locationType: "SHIPYARD", shipyardName: "Yard", dockingCompletionDate: "2026-10-15" })
    assert.match(r.text, /Completion of the dry-docking was planned for 15 October 2026\./)
    assert.doesNotMatch(r.text, /was completed/)
  })

  test("dry-docking does not claim repairs were verified unless the user selects it", () => {
    const r = generate({ inspectionType: "DRY_DOCKING_SPECIAL_SURVEY", locationType: "SHIPYARD", shipyardName: "Yard" })
    assert.doesNotMatch(r.text, /verification of repairs|verifying the repairs/)
  })

  test("post-docking inspection", () => {
    const r = generate({
      inspectionType: "POST_DOCKING",
      vesselStatus: "NORMAL_SEAGOING",
      operatingCondition: "POST_DOCKING_TRIAL",
      dockingCompletionDate: "2026-08-20",
      primaryObjectives: ["POST_DOCKING_ASSESSMENT", "DRY_DOCK_REPAIRS"],
    })
    assert.match(first(r.text), /to conduct a post-docking verification inspection in accordance with the Company’s inspection requirements\. The attendance followed completion of the vessel’s dry-docking on 20 August 2026\./)
    assert.match(r.text, /focused on assessing the vessel following completion of dry-docking and major overhaul works and verifying the repairs, renewals and overhaul works completed during dry-docking\./)
    assert.match(r.text, /under post-docking sea-trial and operating conditions/)
    assertProfessional(r)
  })

  test("newbuilding delivery and maiden voyage", () => {
    const r = generate({
      inspectionType: "NEWBUILDING",
      attendanceAction: "BEFORE_DELIVERY_MAIDEN_VOYAGE",
      locationType: "PORT_TO_PORT",
      joiningLocation: "Mokpo, South Korea",
      disembarkationLocation: "Singapore",
      vesselStatus: "MAIDEN_VOYAGE",
      operatingCondition: "POST_DELIVERY",
      builder: "Hyundai Samho Heavy Industries",
      deliveryDate: "2026-09-25",
      guaranteeEndDate: "2027-09-24",
      primaryObjectives: ["POST_DELIVERY_READINESS"],
      additionalFocusAreas: ["NEWBUILDING_GUARANTEE"],
      followUpMethods: ["GUARANTEE_REGISTER"],
    })
    assert.match(
      first(r.text),
      /attended the vessel DHT LEOPARD at Mokpo, South Korea, before delivery and remained on board for the maiden voyage to Singapore from 25 to 30 September 2026, to conduct a newbuilding delivery and maiden-voyage inspection/,
    )
    assert.match(first(r.text), /The vessel was built by Hyundai Samho Heavy Industries and delivered on 25 September 2026\. The guarantee period ends on 24 September 2027\./)
    assert.match(r.text, /included in the guarantee-claim register for tracking through to closure/)
    assertProfessional(r)
  })

  test("missing vessel, location and dates are flagged but never written as placeholders", () => {
    const r = generatePreamble(inputs({ location: "" }), { vesselName: "", startDate: "", endDate: "" })
    const p1 = r.paragraphs[0]
    assert.ok(p1.incomplete)
    assert.deepEqual(
      p1.segments.filter((s) => "gap" in s).map((s) => ("gap" in s ? s.gap : "")),
      ["vessel name", "location", "attendance dates"],
    )
    assert.equal(p1.text, "The Superintendent attended the vessel, to conduct a detailed Superintendent’s inspection in accordance with the Company’s inspection requirements.")
    const sailing = generatePreamble(
      inputs({ inspectionType: "SAILING", attendanceAction: "JOINED_REMAINED", locationType: "PORT_TO_PORT", joiningLocation: "Galle" }),
      FACTS,
    )
    assert.equal(
      sailing.paragraphs[0].text,
      "The Superintendent joined the vessel DHT LEOPARD at Galle and remained on board from 25 to 30 September 2026, to conduct a sailing Superintendent’s inspection in accordance with the Company’s inspection requirements.",
    )
    assert.doesNotMatch(r.text, /[[\]{}]|undefined/)
  })
})

describe("objectives, opening meeting and scope", () => {
  test("one primary objective", () => {
    const r = generate({ primaryObjectives: ["STANDARDS"] })
    assert.match(r.text, /The inspection focused on assessing safety, maintenance, compliance and operational standards\. It covered the vessel’s overall/)
  })

  test("multiple primary objectives are joined in a fixed order with correct punctuation", () => {
    const r = generate({ primaryObjectives: ["STANDARDS", "OVERALL_CONDITION", "MAINTENANCE_EFFECTIVENESS"] })
    assert.match(
      r.text,
      /focused on assessing the vessel’s overall technical condition and operational readiness, reviewing the effectiveness of onboard maintenance and defect management, and assessing safety, maintenance, compliance and operational standards\./,
    )
  })

  test("other objective becomes its own sentence", () => {
    const r = generate({ primaryObjectives: ["OVERALL_CONDITION", "OTHER"], customObjective: "The condition of the exhaust gas cleaning system." })
    assert.match(r.text, /readiness\. The inspection also addressed the condition of the exhaust gas cleaning system\. It covered/)
  })

  test("no opening meeting omits the sentence cleanly", () => {
    const r = generate({ openingMeeting: "NOT_APPLICABLE" })
    assert.match(r.paragraphs[1].text, /^The inspection focused on/)
    assert.doesNotMatch(r.text, /opening meeting/i)
  })

  test("the Safety Management System and Planned Maintenance System are named in full before 'PMS' is used", () => {
    const r = generate({ additionalFocusAreas: ["PMS_DEFECTS"], followUpMethods: ["PMS_WORK_ORDERS"] })
    assert.ok(r.text.indexOf("Planned Maintenance System") < r.text.indexOf("PMS"))
    assert.match(r.text, /Safety Management System/)
  })
})

describe("examination and focus areas", () => {
  test("SIRE 2.0 preparation with an expected date", () => {
    const r = generate({ additionalFocusAreas: ["SIRE_PREPARATION"], expectedSireDate: "2026-11-15" })
    assert.match(r.text, /The vessel’s readiness for the forthcoming SIRE 2.0 inspection, expected on 15 November 2026, was reviewed, including/)
  })

  test("previous-inspection follow-up with date and worklist reference", () => {
    const r = generate({
      additionalFocusAreas: ["PREVIOUS_INSPECTION"],
      previousInspectionDate: "2026-03-12",
      previousWorklistReference: "WL-2026-014",
    })
    assert.match(r.text, /Previously reported observations from the inspection of 12 March 2026 and outstanding items on worklist WL-2026-014 were reviewed, and their status was verified as far as practicable\./)
  })

  test("repeated 'Particular attention' openings are varied", () => {
    const r = generate({ additionalFocusAreas: ["DRY_DOCKING", "NEWBUILDING_GUARANTEE", "PMS_DEFECTS"], inspectionType: "DETAILED" })
    const openings = sentences(r.paragraphs[2].text).map((s) => s.split(" ").slice(0, 3).join(" "))
    assert.ok(openings.includes("Particular attention was"))
    assert.ok(openings.includes("Attention was also"))
    assert.ok(openings.includes("Further attention was"))
    assert.equal(r.text.match(/Particular attention/g)?.length, 1)
  })

  test("bunkering wording only when bunkering was witnessed", () => {
    const notWitnessed = generate({ additionalFocusAreas: ["BUNKERING_OPERATIONS"] })
    assert.doesNotMatch(notWitnessed.text, /[Bb]unkering/)
    const witnessed = generate({ additionalFocusAreas: ["BUNKERING_OPERATIONS"], bunkeringWitnessed: true, fuelGrade: "VLSFO", bunkeringPort: "Singapore" })
    assert.match(witnessed.text, /Bunkering of VLSFO at Singapore was witnessed, and the associated procedures, communications, safety precautions and records were reviewed\./)
  })

  test("cargo operations are not claimed as witnessed unless confirmed", () => {
    const reviewed = generate({ additionalFocusAreas: ["CARGO_OPERATIONS"], cargoType: "crude oil" })
    assert.doesNotMatch(reviewed.text, /witnessed/)
    const witnessed = generate({
      additionalFocusAreas: ["CARGO_OPERATIONS"],
      cargoOperationsWitnessed: true,
      cargoType: "crude oil",
      cargoOperationType: "DISCHARGING",
    })
    assert.match(witnessed.text, /Crude oil discharging operations were witnessed, and cargo-system condition/)
  })

  test("hidden conditional fields do not contribute stale values", () => {
    const stale = inputs({
      locationType: "SINGLE",
      location: "Singapore",
      joiningLocation: "Galle",
      disembarkationLocation: "Colombo",
      shipyardName: "Old Yard",
      builder: "Old Builder",
      dockingCompletionDate: "2026-01-01",
      expectedSireDate: "2026-12-01",
      previousWorklistReference: "OLD-1",
      bunkeringWitnessed: true,
      fuelGrade: "HSFO",
      customObjective: "something old",
      customFollowUpMethod: "old tracker",
    })
    const r = generatePreamble(stale, FACTS)
    for (const value of ["Galle", "Colombo", "Old Yard", "Old Builder", "1 January 2026", "SIRE", "OLD-1", "HSFO", "something old", "old tracker"]) {
      assert.ok(!r.text.includes(value), `hidden value "${value}" must not appear`)
    }
    assert.deepEqual(generatePreamble(pruneHidden(stale), FACTS).text, r.text)
  })

  test("additional factual note is inserted as written, before the discussion sentence", () => {
    const r = generate({ additionalNote: "the vessel was at reduced crew complement during the attendance" })
    assert.match(r.paragraphs[2].text, /The vessel was at reduced crew complement during the attendance\. Relevant safety, operational/)
  })
})

describe("findings, follow-up and closing", () => {
  test("deficiencies identified", () => {
    const r = generate({ deficiencyStatus: "DEFICIENCIES_IDENTIFIED" })
    assert.match(r.paragraphs[3].text, /^The observations, deficiencies and follow-up actions arising from the attendance are detailed/)
  })

  test("observations only", () => {
    const r = generate({ deficiencyStatus: "OBSERVATIONS_ONLY" })
    assert.match(r.paragraphs[3].text, /^The observations and matters reviewed during the attendance are detailed/)
  })

  test("'no deficiencies' wording appears only when deliberately selected", () => {
    const chosen = generate({ deficiencyStatus: "NO_DEFICIENCIES" })
    assert.match(chosen.paragraphs[3].text, /^The matters examined and verified during the attendance are recorded/)
    const unset = generate({ deficiencyStatus: "" })
    assert.match(unset.paragraphs[3].text, /^The matters reviewed during the attendance are recorded in the relevant sections of this report\./)
    assert.doesNotMatch(unset.text, /verified during the attendance|no deficienc|satisfactory|all defects|fully operational/i)
  })

  test("one follow-up method", () => {
    const r = generate({ followUpMethods: ["DEFECT_DAMAGE_LIST"] })
    assert.match(r.text, /included in the Defect and Damage Report List for tracking through to closure\./)
  })

  test("multiple follow-up methods with articles and punctuation", () => {
    const r = generate({ followUpMethods: ["REPAIR_MAINTENANCE_PLAN", "INSPECTION_WORKLIST", "OTHER"], customFollowUpMethod: "the fleet technical action log" })
    assert.match(
      r.text,
      /included in the associated inspection worklist, the repair and maintenance plan, and the fleet technical action log for tracking through to closure\./,
    )
  })

  test("no separate follow-up record omits the follow-up sentence", () => {
    const r = generate({ followUpMethods: ["NO_SEPARATE_RECORD"] })
    assert.doesNotMatch(r.text, /Items requiring further action/)
  })

  test("no closing statement omits the sentence cleanly", () => {
    const r = generate({ closingStatement: "NONE", deficiencyStatus: "OBSERVATIONS_ONLY" })
    assert.equal(r.paragraphs[3].text, "The observations and matters reviewed during the attendance are detailed in the relevant sections of this report.")
  })
})

describe("mutually exclusive selections", () => {
  test("ticking an exclusive option clears the others, and ticking another clears it", () => {
    assert.deepEqual(toggleExclusive(["DRY_DOCKING", "PMS_DEFECTS"], "NONE", true, "NONE"), ["NONE"])
    assert.deepEqual(toggleExclusive(["NONE"], "PMS_DEFECTS", true, "NONE"), ["PMS_DEFECTS"])
    assert.deepEqual(toggleExclusive(["A", "B"], "A", false, "X"), ["B"])
  })
})

describe("determinism", () => {
  test("the same inputs always give the same text", () => {
    const a = generate({ additionalFocusAreas: ["PMS_DEFECTS", "SIRE_PREPARATION"], followUpMethods: ["INSPECTION_WORKLIST"] })
    const b = generate({ additionalFocusAreas: ["SIRE_PREPARATION", "PMS_DEFECTS"], followUpMethods: ["INSPECTION_WORKLIST"] })
    assert.equal(a.text, b.text, "selection order does not change the wording")
  })
})
