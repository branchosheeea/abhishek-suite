// Shared shape for controlled-narrative sections of the Superintendent's Detailed Inspection Report.
// The Preamble is the first section built this way; the others are listed so their state can be added
// under `report.narratives` later without changing the report format.

export const NARRATIVE_SECTIONS = [
  { id: "preamble", title: "Executive Summary – Preamble" },
  { id: "overallCondition", title: "Overall Condition" },
  { id: "structuralCondition", title: "Structural Condition" },
  { id: "operationalCondition", title: "Operational Condition" },
  { id: "performance", title: "Performance" },
  { id: "significantProblems", title: "Significant Problems" },
  { id: "projectsUpgrades", title: "Projects and Upgrades" },
  { id: "vesselCondition", title: "Vessel Condition Report" },
  { id: "machineryCondition", title: "Machinery Condition" },
  { id: "pmsDefectsCompliance", title: "PMS, Defects and Compliance" },
  { id: "criticalEquipment", title: "Critical Equipment Testing" },
  { id: "inspectionWorklist", title: "Inspection Worklist" },
  { id: "photographs", title: "Photographs" },
  { id: "finalReport", title: "Final Report Generation" },
] as const

export type NarrativeSectionId = (typeof NARRATIVE_SECTIONS)[number]["id"]

export const NARRATIVE_STATUSES = [
  { id: "DRAFT", label: "Draft" },
  { id: "UNDER_REVIEW", label: "Under Review" },
  { id: "FINAL", label: "Final" },
] as const

export type NarrativeStatus = (typeof NARRATIVE_STATUSES)[number]["id"]

/** Saved state of one narrative section: the structured inputs plus the text generated from them. */
export type NarrativeState<TInputs> = {
  status: NarrativeStatus
  inputs: TInputs
  /** Text last saved into the report (empty until the user saves it). */
  generatedText: string
  lastGeneratedAt: number | null
  updatedAt: number
}

export type Issue = { field: string; message: string }

export type ValidationResult = { errors: Issue[]; warnings: Issue[] }

export type Option<Id extends string = string> = { id: Id; label: string }
