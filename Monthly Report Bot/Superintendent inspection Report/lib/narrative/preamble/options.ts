// Controlled vocabulary for the Executive Summary – Preamble.
// Reports store the stable `id` values only; labels and phrases can be reworded here without touching saved data.

// ---------------------------------------------------------------------------------------------------------------
// Inspection type
// ---------------------------------------------------------------------------------------------------------------

export const INSPECTION_TYPES = [
  { id: "ROUTINE", label: "Routine Superintendent’s inspection", phrase: "a routine Superintendent’s inspection" },
  { id: "DETAILED", label: "Detailed Superintendent’s inspection", phrase: "a detailed Superintendent’s inspection" },
  { id: "SAILING", label: "Sailing Superintendent’s inspection", phrase: "a sailing Superintendent’s inspection" },
  { id: "PORT", label: "Port-based Superintendent’s inspection", phrase: "a port-based Superintendent’s inspection" },
  { id: "PRE_DRY_DOCKING", label: "Pre-dry-docking inspection", phrase: "a pre-dry-docking inspection" },
  { id: "DRY_DOCKING_SPECIAL_SURVEY", label: "Dry-docking and Special Survey inspection", phrase: "a dry-docking and Special Survey inspection" },
  { id: "POST_DOCKING", label: "Post-docking verification inspection", phrase: "a post-docking verification inspection" },
  { id: "NEWBUILDING", label: "Newbuilding delivery and maiden-voyage inspection", phrase: "a newbuilding delivery and maiden-voyage inspection" },
  { id: "TECHNICAL_READINESS", label: "Technical condition and operational-readiness inspection", phrase: "a technical condition and operational-readiness inspection" },
  { id: "FOLLOW_UP", label: "Follow-up inspection", phrase: "a follow-up inspection" },
  { id: "ANNUAL", label: "Annual Superintendent’s inspection", phrase: "an annual Superintendent’s inspection" },
] as const

export type InspectionTypeId = (typeof INSPECTION_TYPES)[number]["id"]

// ---------------------------------------------------------------------------------------------------------------
// Attendance action. "remained onboard" in the labels is written "remained on board" (adverbial) in the text.
// ---------------------------------------------------------------------------------------------------------------

export const ATTENDANCE_ACTIONS = [
  { id: "ATTENDED", label: "attended" },
  { id: "BOARDED_REMAINED", label: "boarded and remained onboard" },
  { id: "JOINED_REMAINED", label: "joined and remained onboard" },
  { id: "PORT_CALL", label: "attended the vessel during her port call" },
  { id: "DURING_DRY_DOCKING", label: "attended the vessel during dry-docking" },
  { id: "SEA_PASSAGE", label: "joined the vessel for the sea passage" },
  { id: "BEFORE_DELIVERY_MAIDEN_VOYAGE", label: "attended the vessel before delivery and remained onboard for the maiden voyage" },
] as const

export type AttendanceActionId = (typeof ATTENDANCE_ACTIONS)[number]["id"]

// ---------------------------------------------------------------------------------------------------------------
// Attendance location type
// ---------------------------------------------------------------------------------------------------------------

export const LOCATION_TYPES = [
  { id: "SINGLE", label: "Single location" },
  { id: "PORT_TO_PORT", label: "Port-to-port passage" },
  { id: "SHIPYARD", label: "Shipyard" },
  { id: "AT_SEA", label: "At sea" },
  { id: "OTHER", label: "Other" },
] as const

export type LocationTypeId = (typeof LOCATION_TYPES)[number]["id"]

// ---------------------------------------------------------------------------------------------------------------
// Vessel status. `passage` statuses can carry the destination ("during the vessel’s laden passage to Singapore").
// ---------------------------------------------------------------------------------------------------------------

export const VESSEL_STATUSES = [
  { id: "ALONGSIDE", label: "alongside in port", clause: "while she was alongside in port", loading: true },
  { id: "AT_ANCHORAGE", label: "at anchorage", clause: "while she was at anchorage", loading: true },
  { id: "CARGO_OPERATIONS", label: "undergoing cargo operations", clause: "while she was undergoing cargo operations" },
  { id: "BUNKERING_OPERATIONS", label: "undergoing bunkering operations", clause: "while she was undergoing bunkering operations", loading: true },
  { id: "REPAIRS", label: "undergoing repairs", clause: "while she was undergoing repairs", loading: true },
  { id: "SCHEDULED_DRY_DOCKING", label: "undergoing scheduled dry-docking", clause: "while she was undergoing scheduled dry-docking" },
  { id: "SPECIAL_SURVEY_DRY_DOCKING", label: "undergoing Special Survey dry-docking", clause: "while she was undergoing Special Survey dry-docking" },
  { id: "LADEN_PASSAGE", label: "on a laden sea passage", clause: "during the vessel’s laden passage", passage: "laden passage" },
  { id: "BALLAST_PASSAGE", label: "on a ballast sea passage", clause: "during the vessel’s ballast passage", passage: "ballast passage" },
  { id: "COASTAL_PASSAGE", label: "on a coastal passage", clause: "during the vessel’s coastal passage", passage: "coastal passage" },
  { id: "MAIDEN_VOYAGE", label: "on her maiden voyage following delivery", clause: "during the vessel’s maiden voyage", passage: "maiden voyage", suffix: "following delivery" },
  { id: "NEWBUILDING_PREPARATIONS", label: "completing final newbuilding and delivery preparations", clause: "while she was completing final newbuilding and delivery preparations" },
  { id: "NORMAL_SEAGOING", label: "operating under normal sea-going conditions", clause: "while she was operating under normal sea-going conditions", loading: true },
  { id: "PORT_AND_SEA", label: "undergoing port and sea-passage operations", clause: "while she was undergoing port and sea-passage operations" },
] as const satisfies readonly { id: string; label: string; clause: string; passage?: string; suffix?: string; loading?: boolean }[]

export type VesselStatusId = (typeof VESSEL_STATUSES)[number]["id"]

export const SAILING_STATUSES: readonly VesselStatusId[] = ["LADEN_PASSAGE", "BALLAST_PASSAGE", "COASTAL_PASSAGE"]
export const DRY_DOCK_STATUSES: readonly VesselStatusId[] = ["SCHEDULED_DRY_DOCKING", "SPECIAL_SURVEY_DRY_DOCKING"]

export const LOADING_CONDITIONS = [
  { id: "LADEN", label: "Laden", phrase: "in laden condition" },
  { id: "BALLAST", label: "Ballast", phrase: "in ballast condition" },
] as const

export type LoadingConditionId = (typeof LOADING_CONDITIONS)[number]["id"]

// ---------------------------------------------------------------------------------------------------------------
// Opening meeting and closing acknowledgment (complete sentences, inserted verbatim)
// ---------------------------------------------------------------------------------------------------------------

export const OPENING_MEETINGS = [
  {
    id: "MANAGEMENT_OFFICERS",
    label: "Opening meeting with the Master, Chief Engineer and management officers",
    text: "An opening meeting was held with the Master, Chief Engineer and management officers to confirm the scope and objectives of the attendance.",
  },
  {
    id: "SAFETY_DISCUSSION",
    label: "Opening meeting and safety discussion with the management team and crew",
    text: "An opening meeting and safety discussion were held with the vessel’s management team and crew to confirm the inspection scope and address relevant safety, operational and maintenance matters.",
  },
  {
    id: "MASTER_CHIEF_ENGINEER",
    label: "Scope discussed with the Master and Chief Engineer at commencement",
    text: "The inspection scope and key areas of focus were discussed with the Master and Chief Engineer at the commencement of the attendance.",
  },
  { id: "NOT_APPLICABLE", label: "Not applicable", text: "" },
] as const

export type OpeningMeetingId = (typeof OPENING_MEETINGS)[number]["id"]

export const CLOSING_STATEMENTS = [
  {
    id: "APPRECIATED",
    label: "Cooperation and assistance appreciated",
    text: "The cooperation and assistance extended by the Master, Chief Engineer, officers and crew throughout the attendance are appreciated.",
  },
  {
    id: "ACKNOWLEDGED",
    label: "Cooperation and professional assistance acknowledged",
    text: "The cooperation and professional assistance provided by the vessel’s officers and crew throughout the attendance are acknowledged.",
  },
  {
    id: "THANKED",
    label: "Master, Chief Engineer, officers and crew thanked",
    text: "The Master, Chief Engineer, officers and crew are thanked for their cooperation and assistance throughout the inspection.",
  },
  { id: "NONE", label: "No closing acknowledgment", text: "" },
] as const

export type ClosingStatementId = (typeof CLOSING_STATEMENTS)[number]["id"]

// ---------------------------------------------------------------------------------------------------------------
// Primary objectives. `phrase` completes "The inspection focused on …".
// "{conditions}" is replaced with the selected operating conditions.
// ---------------------------------------------------------------------------------------------------------------

export const PRIMARY_OBJECTIVES = [
  {
    id: "OVERALL_CONDITION",
    label: "Assess the vessel’s overall technical condition and operational readiness",
    phrase: "assessing the vessel’s overall technical condition and operational readiness",
  },
  {
    id: "MACHINERY_PERFORMANCE",
    label: "Verify the condition and performance of machinery and equipment under operating conditions",
    phrase: "verifying the condition and performance of machinery and equipment under {conditions}",
  },
  {
    id: "MAINTENANCE_EFFECTIVENESS",
    label: "Review the effectiveness of onboard maintenance and defect management",
    phrase: "reviewing the effectiveness of onboard maintenance and defect management",
  },
  {
    id: "POST_DOCKING_ASSESSMENT",
    label: "Assess the vessel following completion of dry-docking and major overhaul works",
    phrase: "assessing the vessel following completion of dry-docking and major overhaul works",
  },
  {
    id: "DRY_DOCK_REPAIRS",
    label: "Verify repairs, renewals and overhaul works completed during dry-docking",
    phrase: "verifying the repairs, renewals and overhaul works completed during dry-docking",
  },
  {
    id: "POST_DELIVERY_READINESS",
    label: "Confirm post-delivery readiness and identify guarantee items",
    phrase: "confirming post-delivery readiness and identifying guarantee items",
  },
  {
    id: "SIRE_READINESS",
    label: "Evaluate preparation and readiness for an upcoming SIRE 2.0 inspection",
    phrase: "evaluating preparation and readiness for an upcoming SIRE 2.0 inspection",
  },
  {
    id: "PREVIOUS_DEFICIENCIES",
    label: "Review previously reported deficiencies and verify corrective actions",
    phrase: "reviewing previously reported deficiencies and verifying the corrective actions taken",
  },
  {
    id: "STANDARDS",
    label: "Assess safety, maintenance, compliance and operational standards",
    phrase: "assessing safety, maintenance, compliance and operational standards",
  },
  { id: "OTHER", label: "Other", phrase: "" },
] as const

export type ObjectiveId = (typeof PRIMARY_OBJECTIVES)[number]["id"]

// ---------------------------------------------------------------------------------------------------------------
// Operating conditions. `phrase` completes "examined and tested, where practicable, under …".
// ---------------------------------------------------------------------------------------------------------------

export const OPERATING_CONDITIONS = [
  { id: "PREVAILING_PORT", label: "the prevailing port conditions" },
  { id: "NORMAL_SEAGOING", label: "normal sea-going conditions" },
  { id: "LADEN_SEAGOING", label: "laden sea-going conditions" },
  { id: "BALLAST_SEAGOING", label: "ballast sea-going conditions" },
  { id: "MANOEUVRING_PASSAGE", label: "manoeuvring and sea-passage conditions" },
  { id: "CARGO_OPERATIONS", label: "cargo-operation conditions" },
  { id: "BUNKERING_OPERATIONS", label: "bunkering-operation conditions" },
  { id: "DRY_DOCKING_REPAIR", label: "dry-docking and repair conditions" },
  { id: "POST_DELIVERY", label: "post-delivery operating conditions" },
  { id: "POST_DOCKING_TRIAL", label: "post-docking sea-trial and operating conditions" },
  { id: "PREVAILING_ATTENDANCE", label: "the conditions prevailing during the attendance" },
] as const

export type OperatingConditionId = (typeof OPERATING_CONDITIONS)[number]["id"]

// ---------------------------------------------------------------------------------------------------------------
// Additional focus areas, listed in the order their sentences appear in the preamble.
// Sentences starting "Particular attention was given to" are re-worded when more than one is selected.
// ---------------------------------------------------------------------------------------------------------------

export const FOCUS_AREAS = [
  {
    id: "DRY_DOCKING",
    label: "Dry-docking",
    text: "Particular attention was given to the verification of repairs, renewals, overhauls, Class-related items and outstanding work completed or remaining from the dry-docking period.",
  },
  {
    id: "NEWBUILDING_GUARANTEE",
    label: "Newbuilding or guarantee",
    text: "Particular attention was given to handover completeness, early machinery performance, crew familiarisation and the identification and documentation of defects requiring follow-up under the vessel’s guarantee arrangements.",
  },
  {
    id: "PREVIOUS_INSPECTION",
    label: "Previous-inspection follow-up",
    text: "Previously reported observations and outstanding worklist items were reviewed, and their status was verified as far as practicable.",
  },
  {
    id: "PMS_DEFECTS",
    label: "PMS and defect management",
    text: "Particular attention was given to PMS implementation, maintenance-reporting quality, outstanding defects, machinery history and the timely follow-up of corrective actions.",
  },
  {
    id: "CARGO_OPERATIONS",
    label: "Cargo operations",
    text: "Cargo-system condition, operational procedures, associated records and crew familiarity were reviewed as far as practicable during the attendance.",
  },
  {
    id: "BUNKERING_OPERATIONS",
    label: "Bunkering operations",
    text: "Bunkering operations and the associated procedures, communications, safety precautions and records were reviewed during the attendance.",
  },
  {
    id: "SIRE_PREPARATION",
    label: "SIRE 2.0 preparation",
    text: "The vessel’s readiness for the forthcoming SIRE 2.0 inspection was reviewed, including machinery condition, operational readiness, documentation, housekeeping and crew familiarisation.",
  },
  { id: "NONE", label: "None", text: "" },
] as const

export type FocusAreaId = (typeof FOCUS_AREAS)[number]["id"]

export const PARTICULAR_ATTENTION = "Particular attention was given to"
/** Openings used for the second, third… "Particular attention" sentence, so they never repeat. */
export const ATTENTION_VARIANTS = [
  PARTICULAR_ATTENTION,
  "Attention was also given to",
  "Further attention was given to",
] as const

export const CARGO_OPERATION_TYPES = [
  { id: "LOADING", label: "Loading", noun: "loading operations" },
  { id: "DISCHARGING", label: "Discharging", noun: "discharging operations" },
  { id: "SHIP_TO_SHIP", label: "Ship-to-ship transfer", noun: "ship-to-ship transfer operations" },
  { id: "TANK_CLEANING", label: "Tank cleaning", noun: "tank-cleaning operations" },
] as const

export type CargoOperationId = (typeof CARGO_OPERATION_TYPES)[number]["id"]

// ---------------------------------------------------------------------------------------------------------------
// Findings and follow-up
// ---------------------------------------------------------------------------------------------------------------

export const DEFICIENCY_STATUSES = [
  {
    id: "DEFICIENCIES_IDENTIFIED",
    label: "Deficiencies and follow-up actions identified",
    text: "The observations, deficiencies and follow-up actions arising from the attendance are detailed in the relevant sections of this report.",
  },
  {
    id: "OBSERVATIONS_ONLY",
    label: "Observations only",
    text: "The observations and matters reviewed during the attendance are detailed in the relevant sections of this report.",
  },
  {
    id: "NO_DEFICIENCIES",
    label: "No deficiencies identified",
    text: "The matters examined and verified during the attendance are recorded in the relevant sections of this report.",
  },
  {
    id: "ASSESSMENT_PENDING",
    label: "Assessment pending",
    text: "The results of the inspection are recorded in the relevant sections of this report, with items requiring further review identified accordingly.",
  },
] as const

export type DeficiencyStatusId = (typeof DEFICIENCY_STATUSES)[number]["id"]

/** Used while no findings status has been chosen: states where the results are, and claims nothing about them. */
export const NEUTRAL_FINDINGS_TEXT = "The matters reviewed during the attendance are recorded in the relevant sections of this report."

export const FOLLOW_UP_METHODS = [
  { id: "INSPECTION_WORKLIST", label: "Associated inspection worklist", noun: "associated inspection worklist" },
  { id: "DEFECT_DAMAGE_LIST", label: "Defect and Damage Report List", noun: "Defect and Damage Report List" },
  { id: "PMS_WORK_ORDERS", label: "Planned Maintenance System and associated work orders", noun: "PMS and associated work orders" },
  { id: "GUARANTEE_REGISTER", label: "Guarantee-claim register", noun: "guarantee-claim register" },
  { id: "DRY_DOCKING_WORKLIST", label: "Dry-docking worklist", noun: "dry-docking worklist" },
  { id: "REPAIR_MAINTENANCE_PLAN", label: "Repair and maintenance plan", noun: "repair and maintenance plan" },
  { id: "COMPANY_TRACKING", label: "Relevant Company tracking system", noun: "relevant Company tracking system" },
  { id: "NO_SEPARATE_RECORD", label: "No separate follow-up record", noun: "" },
  { id: "OTHER", label: "Other", noun: "" },
] as const

export type FollowUpMethodId = (typeof FOLLOW_UP_METHODS)[number]["id"]

// ---------------------------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------------------------

type WithId = { readonly id: string }

export function findOption<T extends WithId>(options: readonly T[], id: string | undefined): T | undefined {
  return options.find((option) => option.id === id)
}

export function isOptionId<T extends WithId>(options: readonly T[], id: unknown): id is T["id"] {
  return typeof id === "string" && options.some((option) => option.id === id)
}
