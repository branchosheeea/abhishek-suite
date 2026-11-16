// Structured state of the Executive Summary – Preamble, its defaults, conditional-field rules and recommendations.
//
// Vessel name and attendance dates are not duplicated here: they are the report's existing Inspection Details
// (`details.vessel`, `details.dateFrom`, `details.dateTo`), passed to the generator as `PreambleFacts`.

import type { NarrativeState, NarrativeStatus } from "../types"
import {
  ATTENDANCE_ACTIONS,
  CARGO_OPERATION_TYPES,
  CLOSING_STATEMENTS,
  DEFICIENCY_STATUSES,
  DRY_DOCK_STATUSES,
  FOCUS_AREAS,
  FOLLOW_UP_METHODS,
  INSPECTION_TYPES,
  LOADING_CONDITIONS,
  LOCATION_TYPES,
  OPENING_MEETINGS,
  OPERATING_CONDITIONS,
  PRIMARY_OBJECTIVES,
  VESSEL_STATUSES,
  findOption,
  isOptionId,
  type AttendanceActionId,
  type CargoOperationId,
  type ClosingStatementId,
  type DeficiencyStatusId,
  type FocusAreaId,
  type FollowUpMethodId,
  type InspectionTypeId,
  type LoadingConditionId,
  type LocationTypeId,
  type ObjectiveId,
  type OpeningMeetingId,
  type OperatingConditionId,
  type VesselStatusId,
} from "./options"

export type PreambleInputs = {
  inspectionType: InspectionTypeId | ""
  attendanceAction: AttendanceActionId
  locationType: LocationTypeId
  location: string
  joiningLocation: string
  disembarkationLocation: string
  shipyardName: string
  shipyardPort: string
  shipyardCountry: string
  voyageRoute: string
  otherLocation: string
  vesselStatus: VesselStatusId | ""
  loadingCondition: LoadingConditionId | ""
  operatingCondition: OperatingConditionId
  openingMeeting: OpeningMeetingId
  primaryObjectives: ObjectiveId[]
  customObjective: string
  additionalFocusAreas: FocusAreaId[]
  deficiencyStatus: DeficiencyStatusId | ""
  followUpMethods: FollowUpMethodId[]
  customFollowUpMethod: string
  closingStatement: ClosingStatementId
  specialSurveyNumber: string
  dockingCompletionDate: string
  builder: string
  deliveryDate: string
  guaranteeEndDate: string
  expectedSireDate: string
  previousInspectionDate: string
  previousWorklistReference: string
  cargoOperationsWitnessed: boolean
  cargoType: string
  cargoOperationType: CargoOperationId | ""
  bunkeringWitnessed: boolean
  fuelGrade: string
  bunkeringPort: string
  additionalNote: string
}

export type PreambleField = keyof PreambleInputs
export type PreambleState = NarrativeState<PreambleInputs>

/** Facts that belong to the report as a whole and are read from Inspection Details. */
export type PreambleFacts = { vesselName: string; startDate: string; endDate: string }

/** Fields that live in Inspection Details; validation messages use these ids too. */
export type FactField = "vessel" | "startDate" | "endDate"

export function defaultPreambleInputs(seed: { port?: string } = {}): PreambleInputs {
  return {
    inspectionType: "DETAILED",
    attendanceAction: "ATTENDED",
    locationType: "SINGLE",
    location: (seed.port ?? "").trim(),
    joiningLocation: "",
    disembarkationLocation: "",
    shipyardName: "",
    shipyardPort: "",
    shipyardCountry: "",
    voyageRoute: "",
    otherLocation: "",
    vesselStatus: "",
    loadingCondition: "",
    operatingCondition: "PREVAILING_ATTENDANCE",
    openingMeeting: "MANAGEMENT_OFFICERS",
    primaryObjectives: [],
    customObjective: "",
    additionalFocusAreas: [],
    deficiencyStatus: "",
    followUpMethods: [],
    customFollowUpMethod: "",
    closingStatement: "APPRECIATED",
    specialSurveyNumber: "",
    dockingCompletionDate: "",
    builder: "",
    deliveryDate: "",
    guaranteeEndDate: "",
    expectedSireDate: "",
    previousInspectionDate: "",
    previousWorklistReference: "",
    cargoOperationsWitnessed: false,
    cargoType: "",
    cargoOperationType: "",
    bunkeringWitnessed: false,
    fuelGrade: "",
    bunkeringPort: "",
    additionalNote: "",
  }
}

export function defaultPreambleState(seed: { port?: string } = {}): PreambleState {
  return { status: "DRAFT", inputs: defaultPreambleInputs(seed), generatedText: "", lastGeneratedAt: null, updatedAt: 0 }
}

// ---------------------------------------------------------------------------------------------------------------
// Restoring saved data. Anything unknown (renamed option, damaged record) falls back to the default value, so an
// old or partial draft always opens.
// ---------------------------------------------------------------------------------------------------------------

const STATUSES: readonly NarrativeStatus[] = ["DRAFT", "UNDER_REVIEW", "FINAL"]

function str(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback
}

function pick<T extends { readonly id: string }>(options: readonly T[], value: unknown, fallback: T["id"]): T["id"] {
  return isOptionId(options, value) ? value : fallback
}

function pickOptional<T extends { readonly id: string }>(options: readonly T[], value: unknown): T["id"] | "" {
  return isOptionId(options, value) ? value : ""
}

/** Keeps known ids only, without duplicates, in the canonical option order. */
function pickMany<T extends { readonly id: string }>(options: readonly T[], value: unknown): T["id"][] {
  const chosen = new Set(Array.isArray(value) ? value : [])
  return options.filter((option) => chosen.has(option.id)).map((option) => option.id)
}

export function normalisePreambleInputs(raw: unknown, seed: { port?: string } = {}): PreambleInputs {
  const d = defaultPreambleInputs(seed)
  if (!raw || typeof raw !== "object") return d
  const r = raw as Record<string, unknown>
  return {
    inspectionType: r.inspectionType === "" ? "" : pick(INSPECTION_TYPES, r.inspectionType, d.inspectionType as InspectionTypeId),
    attendanceAction: pick(ATTENDANCE_ACTIONS, r.attendanceAction, d.attendanceAction),
    locationType: pick(LOCATION_TYPES, r.locationType, d.locationType),
    location: str(r.location, d.location),
    joiningLocation: str(r.joiningLocation),
    disembarkationLocation: str(r.disembarkationLocation),
    shipyardName: str(r.shipyardName),
    shipyardPort: str(r.shipyardPort),
    shipyardCountry: str(r.shipyardCountry),
    voyageRoute: str(r.voyageRoute),
    otherLocation: str(r.otherLocation),
    vesselStatus: pickOptional(VESSEL_STATUSES, r.vesselStatus),
    loadingCondition: pickOptional(LOADING_CONDITIONS, r.loadingCondition),
    operatingCondition: pick(OPERATING_CONDITIONS, r.operatingCondition, d.operatingCondition),
    openingMeeting: pick(OPENING_MEETINGS, r.openingMeeting, d.openingMeeting),
    primaryObjectives: pickMany(PRIMARY_OBJECTIVES, r.primaryObjectives),
    customObjective: str(r.customObjective),
    additionalFocusAreas: pickMany(FOCUS_AREAS, r.additionalFocusAreas),
    deficiencyStatus: pickOptional(DEFICIENCY_STATUSES, r.deficiencyStatus),
    followUpMethods: pickMany(FOLLOW_UP_METHODS, r.followUpMethods),
    customFollowUpMethod: str(r.customFollowUpMethod),
    closingStatement: pick(CLOSING_STATEMENTS, r.closingStatement, d.closingStatement),
    specialSurveyNumber: str(r.specialSurveyNumber),
    dockingCompletionDate: str(r.dockingCompletionDate),
    builder: str(r.builder),
    deliveryDate: str(r.deliveryDate),
    guaranteeEndDate: str(r.guaranteeEndDate),
    expectedSireDate: str(r.expectedSireDate),
    previousInspectionDate: str(r.previousInspectionDate),
    previousWorklistReference: str(r.previousWorklistReference),
    cargoOperationsWitnessed: r.cargoOperationsWitnessed === true,
    cargoType: str(r.cargoType),
    cargoOperationType: pickOptional(CARGO_OPERATION_TYPES, r.cargoOperationType),
    bunkeringWitnessed: r.bunkeringWitnessed === true,
    fuelGrade: str(r.fuelGrade),
    bunkeringPort: str(r.bunkeringPort),
    additionalNote: str(r.additionalNote),
  }
}

export function normalisePreambleState(raw: unknown, seed: { port?: string } = {}): PreambleState {
  if (!raw || typeof raw !== "object") return defaultPreambleState(seed)
  const r = raw as Record<string, unknown>
  return {
    status: STATUSES.includes(r.status as NarrativeStatus) ? (r.status as NarrativeStatus) : "DRAFT",
    inputs: normalisePreambleInputs(r.inputs, seed),
    generatedText: str(r.generatedText),
    lastGeneratedAt: typeof r.lastGeneratedAt === "number" ? r.lastGeneratedAt : null,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------------------------------------------

export function isDryDockingContext(inputs: PreambleInputs) {
  return (
    inputs.inspectionType === "DRY_DOCKING_SPECIAL_SURVEY" ||
    inputs.attendanceAction === "DURING_DRY_DOCKING" ||
    (inputs.vesselStatus !== "" && DRY_DOCK_STATUSES.includes(inputs.vesselStatus))
  )
}

export function isNewbuildingContext(inputs: PreambleInputs) {
  return inputs.inspectionType === "NEWBUILDING" || inputs.attendanceAction === "BEFORE_DELIVERY_MAIDEN_VOYAGE"
}

const has = <T>(list: readonly T[], value: T) => list.includes(value)

// ---------------------------------------------------------------------------------------------------------------
// Conditional fields. One rule set drives the form (what is shown), the generator and validation (what counts),
// so a hidden field can never contribute a stale value.
// ---------------------------------------------------------------------------------------------------------------

export function isFieldVisible(field: PreambleField, inputs: PreambleInputs): boolean {
  const focus = inputs.additionalFocusAreas
  switch (field) {
    case "location":
      return inputs.locationType === "SINGLE"
    case "joiningLocation":
    case "disembarkationLocation":
      return inputs.locationType === "PORT_TO_PORT"
    case "shipyardName":
    case "shipyardPort":
    case "shipyardCountry":
      return inputs.locationType === "SHIPYARD"
    case "voyageRoute":
      return inputs.locationType === "AT_SEA"
    case "otherLocation":
      return inputs.locationType === "OTHER"
    case "loadingCondition": {
      const status = findOption(VESSEL_STATUSES, inputs.vesselStatus)
      return Boolean(status && "loading" in status && status.loading)
    }
    case "customObjective":
      return has(inputs.primaryObjectives, "OTHER")
    case "customFollowUpMethod":
      return has(inputs.followUpMethods, "OTHER")
    case "specialSurveyNumber":
      return inputs.inspectionType === "DRY_DOCKING_SPECIAL_SURVEY" || inputs.vesselStatus === "SPECIAL_SURVEY_DRY_DOCKING"
    case "dockingCompletionDate":
      return isDryDockingContext(inputs) || inputs.inspectionType === "POST_DOCKING"
    case "builder":
    case "deliveryDate":
    case "guaranteeEndDate":
      return isNewbuildingContext(inputs)
    case "expectedSireDate":
      return has(focus, "SIRE_PREPARATION") || has(inputs.primaryObjectives, "SIRE_READINESS")
    case "previousInspectionDate":
    case "previousWorklistReference":
      return has(focus, "PREVIOUS_INSPECTION")
    case "cargoOperationsWitnessed":
      return has(focus, "CARGO_OPERATIONS")
    case "cargoType":
    case "cargoOperationType":
      return has(focus, "CARGO_OPERATIONS") && inputs.cargoOperationsWitnessed
    case "bunkeringWitnessed":
      return has(focus, "BUNKERING_OPERATIONS")
    case "fuelGrade":
    case "bunkeringPort":
      return has(focus, "BUNKERING_OPERATIONS") && inputs.bunkeringWitnessed
    default:
      return true
  }
}

/** Returns the inputs with every hidden field reset to its default, so stale values never reach the text. */
export function pruneHidden(inputs: PreambleInputs): PreambleInputs {
  const defaults = defaultPreambleInputs()
  const pruned = { ...inputs }
  for (const field of Object.keys(inputs) as PreambleField[]) {
    if (!isFieldVisible(field, inputs)) (pruned as Record<string, unknown>)[field] = defaults[field]
  }
  return pruned
}

// ---------------------------------------------------------------------------------------------------------------
// Recommendations per inspection type. They are offered with an "Apply" action and never change a value on
// their own, so nothing (for example "repairs were verified") is claimed without the user's selection.
// ---------------------------------------------------------------------------------------------------------------

export type Recommendations = {
  locationType?: LocationTypeId
  vesselStatus?: VesselStatusId[]
  operatingCondition?: OperatingConditionId[]
  focus?: FocusAreaId[]
  objectives?: ObjectiveId[]
  reason: string
}

export function recommendationsFor(type: InspectionTypeId | ""): Recommendations | null {
  switch (type) {
    case "PORT":
      return { locationType: "SINGLE", operatingCondition: ["PREVAILING_PORT"], reason: "port-based inspections" }
    case "SAILING":
      return {
        locationType: "PORT_TO_PORT",
        vesselStatus: ["LADEN_PASSAGE", "BALLAST_PASSAGE", "COASTAL_PASSAGE"],
        operatingCondition: ["NORMAL_SEAGOING", "LADEN_SEAGOING", "BALLAST_SEAGOING"],
        reason: "sailing inspections",
      }
    case "DRY_DOCKING_SPECIAL_SURVEY":
      return {
        locationType: "SHIPYARD",
        operatingCondition: ["DRY_DOCKING_REPAIR"],
        focus: ["DRY_DOCKING"],
        reason: "dry-docking inspections",
      }
    case "POST_DOCKING":
      return {
        operatingCondition: ["POST_DOCKING_TRIAL"],
        focus: ["DRY_DOCKING"],
        objectives: ["POST_DOCKING_ASSESSMENT", "DRY_DOCK_REPAIRS"],
        reason: "post-docking inspections",
      }
    case "NEWBUILDING":
      return {
        locationType: "PORT_TO_PORT",
        vesselStatus: ["MAIDEN_VOYAGE"],
        operatingCondition: ["POST_DELIVERY"],
        focus: ["NEWBUILDING_GUARANTEE"],
        objectives: ["POST_DELIVERY_READINESS"],
        reason: "newbuilding inspections",
      }
    case "FOLLOW_UP":
      return { focus: ["PREVIOUS_INSPECTION"], objectives: ["PREVIOUS_DEFICIENCIES"], reason: "follow-up inspections" }
    default:
      return null
  }
}

/** Location types that make sense for the inspection type; the others are shown disabled with a reason. */
export function allowedLocationTypes(type: InspectionTypeId | ""): LocationTypeId[] {
  switch (type) {
    case "PORT":
      return ["SINGLE", "OTHER"]
    case "SAILING":
      return ["PORT_TO_PORT"]
    case "DRY_DOCKING_SPECIAL_SURVEY":
      return ["SHIPYARD", "OTHER"]
    default:
      return LOCATION_TYPES.map((option) => option.id)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Mutually exclusive choices in multi-select groups
// ---------------------------------------------------------------------------------------------------------------

export const EXCLUSIVE_FOCUS: FocusAreaId = "NONE"
export const EXCLUSIVE_FOLLOW_UP: FollowUpMethodId = "NO_SEPARATE_RECORD"

/** Applies a checkbox change, clearing the other options when an exclusive option is ticked and vice versa. */
export function toggleExclusive<T extends string>(current: readonly T[], id: T, checked: boolean, exclusive: T): T[] {
  if (!checked) return current.filter((value) => value !== id)
  if (id === exclusive) return [exclusive]
  return [...current.filter((value) => value !== exclusive && value !== id), id]
}
