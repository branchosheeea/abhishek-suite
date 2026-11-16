import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { generatePreamble } from "../../lib/narrative/preamble/generate"
import type { PreambleFacts, PreambleInputs } from "../../lib/narrative/preamble/model"
import { validatePreamble } from "../../lib/narrative/preamble/validate"
import { FACTS, inputs } from "./helpers"

function check(patch: Partial<PreambleInputs> = {}, facts: Partial<PreambleFacts> = {}) {
  const i = inputs(patch)
  const f = { ...FACTS, ...facts }
  return validatePreamble(i, f, generatePreamble(i, f))
}

const errorFields = (patch: Partial<PreambleInputs> = {}, facts: Partial<PreambleFacts> = {}) =>
  check(patch, facts).errors.map((e) => e.field)

describe("blocking errors", () => {
  test("a complete preamble has no errors", () => {
    assert.deepEqual(check({ deficiencyStatus: "OBSERVATIONS_ONLY", followUpMethods: ["INSPECTION_WORKLIST"], additionalFocusAreas: ["NONE"], vesselStatus: "ALONGSIDE" }), {
      errors: [],
      warnings: [],
    })
  })

  test("missing vessel, inspection type, start date and location", () => {
    const fields = errorFields({ inspectionType: "", location: "" }, { vesselName: "", startDate: "" })
    for (const field of ["vessel", "inspectionType", "startDate", "location"]) assert.ok(fields.includes(field), field)
  })

  test("end date earlier than start date", () => {
    assert.ok(errorFields({}, { startDate: "2026-09-30", endDate: "2026-09-25" }).includes("endDate"))
  })

  test("sailing inspection without joining or disembarkation location, or without a passage status", () => {
    const fields = errorFields({ inspectionType: "SAILING", locationType: "PORT_TO_PORT", vesselStatus: "ALONGSIDE" })
    assert.ok(fields.includes("joiningLocation"))
    assert.ok(fields.includes("disembarkationLocation"))
    assert.ok(fields.includes("vesselStatus"))
    assert.ok(errorFields({ inspectionType: "SAILING", locationType: "SINGLE" }).includes("locationType"))
  })

  test("no primary objective", () => {
    assert.ok(errorFields({ primaryObjectives: [] }).includes("primaryObjectives"))
  })

  test("'Other' without supporting text", () => {
    const fields = errorFields({ primaryObjectives: ["OTHER"], followUpMethods: ["OTHER"] })
    assert.ok(fields.includes("customObjective"))
    assert.ok(fields.includes("customFollowUpMethod"))
  })

  test("dry-docking inspection without shipyard or location", () => {
    assert.ok(errorFields({ inspectionType: "DRY_DOCKING_SPECIAL_SURVEY", locationType: "SHIPYARD" }).includes("shipyardName"))
    assert.ok(errorFields({ attendanceAction: "DURING_DRY_DOCKING", locationType: "AT_SEA" }).includes("locationType"))
  })

  test("mutually exclusive selections active together", () => {
    const fields = errorFields({ additionalFocusAreas: ["NONE", "PMS_DEFECTS"], followUpMethods: ["NO_SEPARATE_RECORD", "INSPECTION_WORKLIST"] })
    assert.ok(fields.includes("additionalFocusAreas"))
    assert.ok(fields.includes("followUpMethods"))
  })

  test("unresolved placeholders typed into a field", () => {
    assert.ok(errorFields({ location: "[port]" }).includes("location"))
    assert.ok(errorFields({ additionalNote: "Crew change TBA." }).includes("additionalNote"))
    assert.ok(errorFields({}, { vesselName: "DHT {name}" }).includes("vessel"))
  })

  test("hidden fields are not validated", () => {
    // A placeholder in a field that is not shown (port-to-port location while "Single location" is selected) is ignored.
    assert.deepEqual(errorFields({ joiningLocation: "[old]" }), [])
  })
})

describe("warnings", () => {
  test("optional choices left empty produce warnings, not errors", () => {
    const result = check({ openingMeeting: "NOT_APPLICABLE", closingStatement: "NONE" })
    assert.deepEqual(result.errors, [])
    const fields = result.warnings.map((w) => w.field)
    for (const field of ["followUpMethods", "openingMeeting", "closingStatement", "additionalFocusAreas", "deficiencyStatus", "vesselStatus"]) {
      assert.ok(fields.includes(field), field)
    }
  })

  test("'No deficiencies' with items listed for follow-up is flagged", () => {
    const result = check({ deficiencyStatus: "NO_DEFICIENCIES", followUpMethods: ["INSPECTION_WORKLIST"] })
    assert.ok(result.warnings.some((w) => w.field === "followUpMethods" && /No deficiencies/.test(w.message)))
  })

  test("bunkering selected but not witnessed is flagged", () => {
    assert.ok(check({ additionalFocusAreas: ["BUNKERING_OPERATIONS"] }).warnings.some((w) => w.field === "bunkeringWitnessed"))
  })
})
