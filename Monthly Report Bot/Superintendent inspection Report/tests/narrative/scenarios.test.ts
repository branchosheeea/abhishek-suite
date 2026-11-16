// End-to-end scenarios from the specification: inputs → preamble → saved report (JSON, as stored in IndexedDB and
// MongoDB) → restored draft → identical wording.

import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { generatePreamble } from "../../lib/narrative/preamble/generate"
import {
  defaultPreambleInputs,
  normalisePreambleInputs,
  normalisePreambleState,
  type PreambleFacts,
  type PreambleInputs,
  type PreambleState,
} from "../../lib/narrative/preamble/model"
import { validatePreamble } from "../../lib/narrative/preamble/validate"
import { assertProfessional } from "./helpers"

type Scenario = { name: string; facts: PreambleFacts; inputs: Partial<PreambleInputs>; expect: RegExp[]; absent?: RegExp[] }

const SCENARIOS: Scenario[] = [
  {
    name: "1. Sailing inspection from Galle to Singapore during a laden passage",
    facts: { vesselName: "DHT LEOPARD", startDate: "2026-09-25", endDate: "2026-09-30" },
    inputs: {
      inspectionType: "SAILING",
      attendanceAction: "JOINED_REMAINED",
      locationType: "PORT_TO_PORT",
      joiningLocation: "Galle, Sri Lanka",
      disembarkationLocation: "Singapore",
      vesselStatus: "LADEN_PASSAGE",
      operatingCondition: "NORMAL_SEAGOING",
      openingMeeting: "SAFETY_DISCUSSION",
      primaryObjectives: ["OVERALL_CONDITION", "MACHINERY_PERFORMANCE"],
      additionalFocusAreas: ["PREVIOUS_INSPECTION"],
      deficiencyStatus: "DEFICIENCIES_IDENTIFIED",
      followUpMethods: ["INSPECTION_WORKLIST", "DEFECT_DAMAGE_LIST"],
      closingStatement: "APPRECIATED",
    },
    expect: [/during the vessel’s laden passage to Singapore/],
  },
  {
    name: "2. Port inspection at Singapore while alongside",
    facts: { vesselName: "DHT COLT", startDate: "2026-03-12", endDate: "2026-03-12" },
    inputs: {
      inspectionType: "PORT",
      locationType: "SINGLE",
      location: "Singapore",
      vesselStatus: "ALONGSIDE",
      operatingCondition: "PREVAILING_PORT",
      primaryObjectives: ["OVERALL_CONDITION", "MAINTENANCE_EFFECTIVENESS"],
      additionalFocusAreas: ["PMS_DEFECTS"],
      deficiencyStatus: "OBSERVATIONS_ONLY",
      followUpMethods: ["INSPECTION_WORKLIST"],
    },
    expect: [
      /^The Superintendent attended the vessel DHT COLT at Singapore on 12 March 2026 while she was alongside in port, to conduct a port-based Superintendent’s inspection/,
      /under the prevailing port conditions/,
    ],
    absent: [/passage|joined|disembark/],
  },
  {
    name: "3. Special Survey dry-docking inspection at a shipyard",
    facts: { vesselName: "DHT JAGUAR", startDate: "2026-06-01", endDate: "2026-06-14" },
    inputs: {
      inspectionType: "DRY_DOCKING_SPECIAL_SURVEY",
      attendanceAction: "DURING_DRY_DOCKING",
      locationType: "SHIPYARD",
      shipyardName: "Sembcorp Marine Admiralty Yard",
      shipyardPort: "Singapore",
      shipyardCountry: "Singapore",
      vesselStatus: "SPECIAL_SURVEY_DRY_DOCKING",
      operatingCondition: "DRY_DOCKING_REPAIR",
      specialSurveyNumber: "3",
      dockingCompletionDate: "2026-06-12",
      primaryObjectives: ["DRY_DOCK_REPAIRS", "STANDARDS"],
      additionalFocusAreas: ["DRY_DOCKING"],
      deficiencyStatus: "DEFICIENCIES_IDENTIFIED",
      followUpMethods: ["DRY_DOCKING_WORKLIST", "DEFECT_DAMAGE_LIST"],
    },
    expect: [
      /during dry-docking at Sembcorp Marine Admiralty Yard, Singapore, from 1 to 14 June 2026/,
      /third Special Survey and was completed on 12 June 2026\./,
      /included in the Defect and Damage Report List and dry-docking worklist/,
    ],
  },
  {
    name: "4. Newbuilding delivery and maiden voyage from Mokpo to Singapore",
    facts: { vesselName: "DHT AMAZON", startDate: "2026-09-28", endDate: "2026-10-12" },
    inputs: {
      inspectionType: "NEWBUILDING",
      attendanceAction: "BEFORE_DELIVERY_MAIDEN_VOYAGE",
      locationType: "PORT_TO_PORT",
      joiningLocation: "Mokpo, South Korea",
      disembarkationLocation: "Singapore",
      vesselStatus: "MAIDEN_VOYAGE",
      operatingCondition: "POST_DELIVERY",
      builder: "Hyundai Samho Heavy Industries",
      deliveryDate: "2026-09-30",
      guaranteeEndDate: "2027-09-29",
      openingMeeting: "MASTER_CHIEF_ENGINEER",
      primaryObjectives: ["POST_DELIVERY_READINESS", "MACHINERY_PERFORMANCE"],
      additionalFocusAreas: ["NEWBUILDING_GUARANTEE"],
      deficiencyStatus: "DEFICIENCIES_IDENTIFIED",
      followUpMethods: ["GUARANTEE_REGISTER", "INSPECTION_WORKLIST"],
      closingStatement: "THANKED",
    },
    expect: [
      /at Mokpo, South Korea, before delivery and remained on board for the maiden voyage to Singapore from 28 September to 12 October 2026, to conduct a newbuilding delivery and maiden-voyage inspection/,
      /built by Hyundai Samho Heavy Industries and delivered on 30 September 2026\./,
      /under post-delivery operating conditions/,
    ],
  },
  {
    name: "5. SIRE 2.0 preparation attendance with previous worklist follow-up",
    facts: { vesselName: "DHT TIGER", startDate: "2026-11-02", endDate: "2026-11-04" },
    inputs: {
      inspectionType: "TECHNICAL_READINESS",
      attendanceAction: "ATTENDED",
      locationType: "SINGLE",
      location: "Fujairah anchorage, United Arab Emirates",
      vesselStatus: "AT_ANCHORAGE",
      loadingCondition: "LADEN",
      primaryObjectives: ["SIRE_READINESS", "PREVIOUS_DEFICIENCIES"],
      additionalFocusAreas: ["PREVIOUS_INSPECTION", "SIRE_PREPARATION"],
      expectedSireDate: "2026-11-20",
      previousInspectionDate: "2026-05-18",
      previousWorklistReference: "WL-2026-007",
      deficiencyStatus: "ASSESSMENT_PENDING",
      followUpMethods: ["INSPECTION_WORKLIST", "COMPANY_TRACKING"],
      closingStatement: "ACKNOWLEDGED",
    },
    expect: [
      /at Fujairah anchorage, United Arab Emirates, from 2 to 4 November 2026 while she was at anchorage in laden condition, to conduct a technical condition and operational-readiness inspection/,
      /Previously reported observations from the inspection of 18 May 2026 and outstanding items on worklist WL-2026-007 were reviewed/,
      /SIRE 2.0 inspection, expected on 20 November 2026, was reviewed/,
      /with items requiring further review identified accordingly\./,
    ],
  },
]

/** What the app stores in IndexedDB and syncs to MongoDB, restored the way the editor restores it. */
function saveAndRestore(state: PreambleState) {
  const stored = JSON.parse(JSON.stringify({ narratives: { preamble: state } }))
  return normalisePreambleState(stored.narratives.preamble)
}

describe("end-to-end scenarios", () => {
  for (const scenario of SCENARIOS) {
    test(scenario.name, () => {
      const inputs: PreambleInputs = { ...defaultPreambleInputs(), ...scenario.inputs }
      const result = generatePreamble(inputs, scenario.facts)

      assertProfessional(result)
      assert.deepEqual(validatePreamble(inputs, scenario.facts, result).errors, [], "can be finalised")
      for (const pattern of scenario.expect) assert.match(result.text, pattern)
      for (const pattern of scenario.absent ?? []) assert.doesNotMatch(result.text, pattern)
      // No unsupported claims.
      assert.doesNotMatch(result.text, /satisfactory|all (?:machinery|defects|items)|fully (?:operational|compliant)|no deficiencies/i)

      const state: PreambleState = { status: "FINAL", inputs, generatedText: result.text, lastGeneratedAt: 1, updatedAt: 1 }
      const restored = saveAndRestore(state)
      // Multi-select lists are restored in the fixed option order; every other value is restored as saved.
      assert.deepEqual(restored, { ...state, inputs: normalisePreambleInputs(inputs) }, "saved draft restores exactly")
      assert.deepEqual(saveAndRestore(restored), restored, "restoring again changes nothing")
      assert.equal(generatePreamble(restored.inputs, scenario.facts).text, result.text, "restored draft gives the same wording")
    })
  }

  test("scenario 1 matches the reference preamble word for word", () => {
    const s = SCENARIOS[0]
    const inputs: PreambleInputs = { ...defaultPreambleInputs(), ...s.inputs }
    // The reference text in the specification does not name the vessel.
    const reference = [
      "The Superintendent joined the vessel at Galle, Sri Lanka, and remained on board from 25 to 30 September 2026 during the vessel’s laden passage to Singapore, to conduct a sailing Superintendent’s inspection in accordance with the Company’s inspection requirements.",
      "An opening meeting and safety discussion were held with the vessel’s management team and crew to confirm the inspection scope and address relevant safety, operational and maintenance matters. The inspection focused on assessing the vessel’s overall technical condition and operational readiness and verifying the condition and performance of machinery and equipment under normal sea-going conditions. It covered the vessel’s overall technical and operational condition; accessible deck, cargo, accommodation and machinery spaces; the condition and performance of machinery, equipment, alarms and safety systems; implementation of the Safety Management System and Planned Maintenance System; maintenance and defect records; statutory and Company compliance; and the officers’ and crew’s familiarity with vessel-specific equipment, operating procedures and emergency arrangements.",
      "Machinery and systems were examined and tested, where practicable, under normal sea-going conditions, and the available records were reviewed to verify maintenance quality, equipment reliability and operational readiness. Previously reported observations and outstanding worklist items were reviewed, and their status was verified as far as practicable. Relevant safety, operational and maintenance matters were discussed with the vessel’s staff, and guidance was provided where improvement or further action was required.",
      "The observations, deficiencies and follow-up actions arising from the attendance are detailed in the relevant sections of this report. Items requiring further action have been included in the associated inspection worklist and Defect and Damage Report List for tracking through to closure. The cooperation and assistance extended by the Master, Chief Engineer, officers and crew throughout the attendance are appreciated.",
    ].join("\n\n")
    assert.equal(generatePreamble(inputs, { ...s.facts, vesselName: "" }).text, reference)
    assert.equal(
      generatePreamble(inputs, s.facts).text,
      reference.replace("joined the vessel at Galle", "joined the vessel DHT LEOPARD at Galle"),
      "with the vessel name stored on the report",
    )
  })
})

describe("restoring saved drafts", () => {
  test("a damaged or older record falls back to safe defaults", () => {
    const restored = normalisePreambleState({
      status: "SOMETHING",
      inputs: { inspectionType: "RETIRED_TYPE", primaryObjectives: ["OVERALL_CONDITION", "UNKNOWN", "OVERALL_CONDITION"], bunkeringWitnessed: "yes" },
    })
    assert.equal(restored.status, "DRAFT")
    assert.equal(restored.inputs.inspectionType, "DETAILED")
    assert.deepEqual(restored.inputs.primaryObjectives, ["OVERALL_CONDITION"])
    assert.equal(restored.inputs.bunkeringWitnessed, false)
    assert.equal(normalisePreambleState(undefined, { port: "Singapore" }).inputs.location, "Singapore")
  })

  test("a deliberately cleared inspection type stays cleared", () => {
    assert.equal(normalisePreambleState({ inputs: { inspectionType: "" } }).inputs.inspectionType, "")
  })
})
