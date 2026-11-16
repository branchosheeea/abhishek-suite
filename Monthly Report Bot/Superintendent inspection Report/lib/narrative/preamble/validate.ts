// Validation for the Executive Summary – Preamble.
// Errors block "Final" and saving the preamble text; warnings are shown but do not block.

import { compareIsoDates, isValidIsoDate } from "../dates"
import { placeholderProblems } from "../text"
import type { Issue, ValidationResult } from "../types"
import type { GeneratedPreamble } from "./generate"
import {
  allowedLocationTypes,
  isDryDockingContext,
  isFieldVisible,
  pruneHidden,
  type FactField,
  type PreambleFacts,
  type PreambleField,
  type PreambleInputs,
} from "./model"
import { INSPECTION_TYPES, LOCATION_TYPES, SAILING_STATUSES, findOption } from "./options"

export type IssueField = PreambleField | FactField | "preview"

const FREE_TEXT_FIELDS: PreambleField[] = [
  "location",
  "joiningLocation",
  "disembarkationLocation",
  "shipyardName",
  "shipyardPort",
  "shipyardCountry",
  "voyageRoute",
  "otherLocation",
  "customObjective",
  "customFollowUpMethod",
  "builder",
  "previousWorklistReference",
  "cargoType",
  "fuelGrade",
  "bunkeringPort",
  "additionalNote",
]

const DATE_FIELDS: PreambleField[] = [
  "dockingCompletionDate",
  "deliveryDate",
  "guaranteeEndDate",
  "expectedSireDate",
  "previousInspectionDate",
]

const blank = (value: string) => !value.trim()

export function validatePreamble(
  rawInputs: PreambleInputs,
  facts: PreambleFacts,
  generated?: GeneratedPreamble,
): ValidationResult {
  const inputs = pruneHidden(rawInputs)
  const errors: Issue[] = []
  const warnings: Issue[] = []
  const error = (field: IssueField, message: string) => errors.push({ field, message })
  const warn = (field: IssueField, message: string) => warnings.push({ field, message })

  // --- Facts from Inspection Details -----------------------------------------------------------------------------
  if (blank(facts.vesselName)) error("vessel", "Select or enter the vessel.")
  if (blank(facts.startDate)) error("startDate", "Enter the start date of the attendance.")
  else if (!isValidIsoDate(facts.startDate)) error("startDate", "Enter a valid start date.")
  if (!blank(facts.endDate) && !isValidIsoDate(facts.endDate)) error("endDate", "Enter a valid end date.")
  else if ((compareIsoDates(facts.startDate, facts.endDate) ?? 0) > 0) {
    error("endDate", "The end date cannot be earlier than the start date.")
  }

  // --- Inspection type and location -------------------------------------------------------------------------------
  const type = findOption(INSPECTION_TYPES, inputs.inspectionType)
  if (!type) error("inspectionType", "Select the inspection type.")

  const allowed = allowedLocationTypes(inputs.inspectionType)
  if (type && !allowed.includes(inputs.locationType)) {
    const labels = allowed.map((id) => findOption(LOCATION_TYPES, id)?.label ?? id)
    error(
      "locationType",
      inputs.inspectionType === "SAILING"
        ? "A sailing inspection needs joining and disembarkation locations: choose “Port-to-port passage”."
        : `This location type is not used for a ${type.label.toLowerCase()}. Choose ${labels.join(" or ")}.`,
    )
  }

  switch (inputs.locationType) {
    case "SINGLE":
      if (blank(inputs.location)) error("location", "Enter the attendance location.")
      break
    case "PORT_TO_PORT":
      if (blank(inputs.joiningLocation)) error("joiningLocation", "Enter the joining location.")
      if (blank(inputs.disembarkationLocation)) error("disembarkationLocation", "Enter the disembarkation location.")
      break
    case "SHIPYARD":
      if (blank(inputs.shipyardName) && blank(inputs.shipyardPort)) error("shipyardName", "Enter the shipyard name or its port.")
      break
    case "OTHER":
      if (blank(inputs.otherLocation)) error("otherLocation", "Describe the attendance location.")
      break
    case "AT_SEA":
      if (isDryDockingContext(inputs)) error("locationType", "A dry-docking attendance needs the shipyard or location, not “At sea”.")
      break
  }

  // --- Vessel status ------------------------------------------------------------------------------------------------
  if (inputs.inspectionType === "SAILING") {
    if (!inputs.vesselStatus || !SAILING_STATUSES.includes(inputs.vesselStatus)) {
      error("vesselStatus", "A sailing inspection needs a laden, ballast or coastal passage status.")
    }
  } else if (!inputs.vesselStatus) {
    warn("vesselStatus", "Vessel status not selected: the preamble will not describe her operational status.")
  }

  // --- Objectives, focus and follow-up ------------------------------------------------------------------------------
  if (!inputs.primaryObjectives.length) error("primaryObjectives", "Select at least one primary objective.")
  if (inputs.primaryObjectives.includes("OTHER") && blank(inputs.customObjective)) {
    error("customObjective", "Describe the other objective, or untick “Other”.")
  }

  const focus = inputs.additionalFocusAreas
  if (focus.includes("NONE") && focus.length > 1) error("additionalFocusAreas", "“None” cannot be combined with other focus areas.")
  else if (!focus.length) warn("additionalFocusAreas", "No additional focus area selected. Tick “None” to confirm.")
  if (focus.includes("BUNKERING_OPERATIONS") && !inputs.bunkeringWitnessed) {
    warn("bunkeringWitnessed", "Bunkering wording is added only when the operations were witnessed.")
  }

  const followUp = inputs.followUpMethods
  if (followUp.includes("NO_SEPARATE_RECORD") && followUp.length > 1) {
    error("followUpMethods", "“No separate follow-up record” cannot be combined with other methods.")
  } else if (!followUp.length) {
    warn("followUpMethods", "No follow-up method selected: the follow-up sentence will be left out.")
  }
  if (followUp.includes("OTHER") && blank(inputs.customFollowUpMethod)) {
    error("customFollowUpMethod", "Name the other follow-up record, or untick “Other”.")
  }

  if (!inputs.deficiencyStatus) {
    warn("deficiencyStatus", "Findings status not confirmed: a neutral findings sentence is used until you choose one.")
  } else if (
    inputs.deficiencyStatus === "NO_DEFICIENCIES" &&
    followUp.some((id) => id !== "NO_SEPARATE_RECORD")
  ) {
    warn("followUpMethods", "“No deficiencies identified” is selected, but items are listed for follow-up. Check both selections.")
  }

  if (inputs.openingMeeting === "NOT_APPLICABLE") warn("openingMeeting", "No opening-meeting sentence will be included.")
  if (inputs.closingStatement === "NONE") warn("closingStatement", "No closing acknowledgment will be included.")

  // --- Conditional facts ----------------------------------------------------------------------------------------------
  if (isFieldVisible("specialSurveyNumber", inputs) && !blank(inputs.specialSurveyNumber)) {
    const n = Number(inputs.specialSurveyNumber.trim())
    if (!/^\d{1,2}$/.test(inputs.specialSurveyNumber.trim()) || n < 1) {
      error("specialSurveyNumber", "Enter the Special Survey number as a whole number, for example 3.")
    }
  }
  for (const field of DATE_FIELDS) {
    const value = inputs[field] as string
    if (isFieldVisible(field, inputs) && !blank(value) && !isValidIsoDate(value)) error(field, "Enter a valid date.")
  }
  if (inputs.inspectionType === "POST_DOCKING" && (compareIsoDates(inputs.dockingCompletionDate, facts.startDate) ?? 0) > 0) {
    warn("dockingCompletionDate", "The dry-docking completion date is after the start of this attendance.")
  }
  if ((compareIsoDates(inputs.expectedSireDate, facts.startDate) ?? 1) < 0) {
    warn("expectedSireDate", "The expected SIRE 2.0 date is before this attendance.")
  }
  if ((compareIsoDates(inputs.previousInspectionDate, facts.startDate) ?? -1) > 0) {
    warn("previousInspectionDate", "The previous inspection date is after this attendance.")
  }
  if ((compareIsoDates(inputs.guaranteeEndDate, inputs.deliveryDate) ?? 1) < 0) {
    warn("guaranteeEndDate", "The guarantee end date is before the delivery date.")
  }

  // --- Placeholders -----------------------------------------------------------------------------------------------------
  for (const field of FREE_TEXT_FIELDS) {
    const value = inputs[field] as string
    if (isFieldVisible(field, inputs) && placeholderProblems(value.replace(/\s+/g, " ").trim()).some((p) => !/space|punctuation/i.test(p))) {
      error(field, "Remove placeholder text such as [ ], { } or TBA.")
    }
  }
  if (/[[\]{}]|\b(?:TBA|TBC|XXX)\b/.test(facts.vesselName)) error("vessel", "Remove placeholder text from the vessel name.")
  if (generated && errors.every((e) => !FREE_TEXT_FIELDS.includes(e.field as PreambleField))) {
    const problems = placeholderProblems(generated.text)
    if (problems.length) error("preview", `The generated text needs attention: ${problems.join("; ")}.`)
  }

  return { errors, warnings }
}

export function issuesFor(result: ValidationResult, field: IssueField) {
  return {
    error: result.errors.find((issue) => issue.field === field)?.message,
    warning: result.warnings.find((issue) => issue.field === field)?.message,
  }
}
