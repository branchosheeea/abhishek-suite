import type { PreambleState } from "./narrative/preamble/model"
import type { SectionState } from "./narrative/section"
import type { NarrativeSectionId } from "./narrative/types"
import { PARTICULARS_GROUPS_V2 } from "./particulars-groups"
import { SUPERINTENDENTS } from "./superintendents"
import type { Status } from "./vessel-master/fields"
import type { Release } from "./vessel-master/rules"

export const FORM_CODE = "16.02.00.003.04"
export const FORM_TITLE = "Superintendent's Detailed Inspection Report"

export type FieldType = "text" | "date" | "textarea" | "number" | "select" | "combo"

export type FieldDef = {
  key: string
  label: string
  /** "combo": a dropdown of `options` plus "Other (type a name)" for anything not listed. */
  type?: FieldType
  unit?: string
  placeholder?: string
  span?: 1 | 2 | 3
  options?: readonly string[]
  /** Date fields only: the date must be in the past and before the date held in this other field. */
  before?: string
  /** Mandatory: marked * and must be completed before the Fleet Manager can approve the report. */
  required?: boolean
  /** Short help shown under the field. */
  hint?: string
}

export type FieldGroup = {
  title?: string
  description?: string
  fields: FieldDef[]
}

export const DETAILS_GROUPS: FieldGroup[] = [
  {
    title: "Vessel & Visit",
    fields: [
      { key: "vessel", label: "Vessel", placeholder: "e.g. MV Ocean Star", required: true, hint: "Also fills Ship name in Principal Particulars." },
      { key: "port", label: "Port", placeholder: "e.g. Singapore", required: true },
      { key: "dateFrom", label: "Inspection from", type: "date", required: true },
      { key: "dateTo", label: "Inspection to", type: "date", required: true },
      { key: "reportNo", label: "Inspection report no.", placeholder: "e.g. SIR-2026-014", required: true },
      { key: "lastInspection", label: "Date of last inspection", type: "date", before: "dateFrom" },
      { key: "nextInspection", label: "Next planned inspection", type: "date", required: true },
    ],
  },
  {
    title: "Inspected by",
    fields: [
      { key: "inspectedBy", label: "Name", type: "combo", options: SUPERINTENDENTS, required: true },
      { key: "inspectedDate", label: "Date", type: "date", required: true, hint: "Filled from Inspection to; change it if the report is dated differently." },
      { key: "inspectedPlace", label: "Place", required: true, hint: "Filled from Port; change it if different." },
    ],
  },
]

/** Principal Particulars of reports made before the Vessel Master (no vesselSnapshot): four groups, typed by hand.
 *  Kept unchanged so those reports open, complete and print exactly as before. New reports use lib/particulars.ts. */
export const PARTICULARS_GROUPS: FieldGroup[] = [
  {
    title: "Identification",
    fields: [
      { key: "shipName", label: "Ship name", required: true, hint: "Linked to Vessel in Inspection Details: editing either updates both." },
      { key: "imo", label: "IMO no.", placeholder: "7 digits", required: true },
      { key: "flag", label: "Flag", required: true },
      { key: "portOfRegistry", label: "Port of registry", required: true },
      { key: "officialNo", label: "Official no." },
      { key: "callSign", label: "Call sign" },
      { key: "hullNo", label: "Hull no." },
      { key: "yearBuilt", label: "Year of built", type: "number", required: true },
      { key: "builder", label: "Builder" },
      { key: "shipType", label: "Ship type", required: true },
      { key: "owners", label: "Owners", required: true },
      { key: "managers", label: "Managers", required: true },
      { key: "classification", label: "Classification", required: true },
      { key: "classNotation", label: "Class notation" },
      { key: "shipDescription", label: "Ship's description", type: "textarea", span: 3 },
    ],
  },
  {
    title: "Dimensions & Tonnage",
    fields: [
      { key: "loa", label: "Length, overall", unit: "m" },
      { key: "breadth", label: "Breadth, moulded", unit: "m" },
      { key: "depth", label: "Depth, moulded", unit: "m" },
      { key: "draft", label: "Draft (summer)", unit: "m" },
      { key: "deadweight", label: "Deadweight", unit: "mt", required: true },
      { key: "lightweight", label: "Lightweight", unit: "mt" },
      { key: "grossTonnage", label: "Gross tonnage (ITC)" },
      { key: "netTonnage", label: "Net tonnage" },
    ],
  },
  {
    title: "Main Propulsion",
    fields: [
      { key: "propulsionType", label: "Main propulsion type", span: 3 },
      { key: "mcoPs", label: "M.C.O. power", unit: "ps" },
      { key: "mcoRpm", label: "M.C.O. at", unit: "rpm" },
      { key: "csoPs", label: "C.S.O. power", unit: "ps" },
      { key: "csoRpm", label: "C.S.O. at", unit: "rpm" },
      { key: "csoKw", label: "C.S.O. power", unit: "kW" },
    ],
  },
  {
    title: "Consumption & Speed",
    fields: [
      { key: "dgSea", label: "DG at sea", unit: "mt" },
      { key: "dgAnchorage", label: "DG at anchorage", unit: "mt" },
      { key: "dgLoadPort", label: "DG at load port", unit: "mt" },
      { key: "dgDischPort", label: "DG at disch. port", unit: "mt" },
      { key: "serviceSpeed", label: "Service speed", unit: "knots" },
      { key: "presentSpeed", label: "Present speed", unit: "knots" },
      { key: "ifoCst", label: "Fuel IFO grade", unit: "cst" },
      { key: "foMt", label: "Fuel consumption loaded", unit: "mt" },
      { key: "foKnots", label: "at speed", unit: "knots" },
      { key: "meccLo", label: "MECC lube", unit: "ltrs/day" },
      { key: "cylOil", label: "Cylinder oil", unit: "ltrs/day" },
      { key: "dgLo", label: "DG L.O. consumption", unit: "ltrs/day" },
    ],
  },
]

export const SUMMARY_FIELDS: FieldDef[] = [
  { required: true, key: "preamble", label: "Preamble", type: "textarea" },
  { required: true, key: "overall", label: "Overall condition", type: "textarea" },
  { required: true, key: "structural", label: "Structural condition", type: "textarea" },
  { required: true, key: "operational", label: "Operational condition", type: "textarea" },
  { required: true, key: "performance", label: "Performance", type: "textarea" },
  { required: true, key: "problems", label: "Significant problems", type: "textarea" },
  { required: true, key: "projects", label: "Projects and upgrades", type: "textarea" },
]

export const SCOPE_ITEMS: { key: string; label: string }[] = [
  "Physical examination of all closed defects reported last inspection and review the ones deferred",
  "Verification of defect/damage list and that all defects are recorded",
  "Follow up and audit of planned/un-planned maintenance",
  "Class related matters",
  "Review repairs, upgrades and modifications",
  "Ship's documentation and certification",
  "Drawings, manuals and publications for hull and machinery",
  "Hull, structural condition and structural integrity",
  "Safety equipment and related procedures & drills",
  "Safety standards and training",
  "Ship security",
  "Random verification of functional trips and alarms",
  "Random test of stand-by equipment and occasionally used equipment",
  "Cargo and ballast handling systems and adherence to cargo and ballast plans",
  "Navigation and communication equipment and documented procedures",
  "Steering system and procedures",
  "Mooring equipment and procedures",
  "Machinery spaces and machinery-related procedures",
  "Maintenance procedures and evidence of maintenance recorded in PMS by random cross check of records and machinery. Observe engineering practices, engine room management standards and machinery housekeeping",
  "Inventory control and year to date operating expenditure",
  "Verified critical and essential spares ROB",
  "Sighted work rest hour records",
  "Personnel planning",
].map((label, i) => ({ key: `s${i + 1}`, label }))

export const WORKLIST_ITEMS = [
  {
    key: "issued",
    label:
      "A work list has been issued and discussed with the Master and Chief Engineer, covering recommendations for improvement and the maintenance plan for the forthcoming period.",
  },
  {
    key: "followUp",
    label:
      "The Master has been asked to update the Company with progress on the issued work list at regular intervals up to their closure.",
  },
]

export type ConditionItem = { key: string; label: string; hint?: string }

export const DECK_ITEMS: ConditionItem[] = [
  { key: "hull", label: "Hull structure, coating and hull marking" },
  { key: "weatherDeck", label: "Weather deck" },
  { key: "cargoHolds", label: "Cargo tanks / holds" },
  { key: "hatchCovers", label: "Hatch cover / coaming / manifold / tank coaming" },
  { key: "ballastTanks", label: "Water ballast tanks" },
  { key: "accommodation", label: "Accommodation block and interior" },
  { key: "galley", label: "Galley and provision rooms" },
  { key: "cargoEquipment", label: "Cargo handling equipment and instrumentation" },
  { key: "cranes", label: "Cranes / gangway" },
  { key: "ventilators", label: "Ventilator / air pipe heads" },
  { key: "mooring", label: "Mooring machinery" },
  { key: "lsa", label: "Life saving appliances" },
  { key: "ffa", label: "Fire fighting appliances" },
  { key: "navigation", label: "Navigation equipment" },
  { key: "deckMisc", label: "Miscellaneous" },
]

export const ENGINE_ITEMS: ConditionItem[] = [
  { key: "erGeneral", label: "Engine room general condition / cleanliness" },
  { key: "mainEngine", label: "Main engine" },
  { key: "dieselGenerator", label: "Diesel generator" },
  { key: "boiler", label: "Boiler / E.G.E" },
  {
    key: "auxMachinery",
    label: "Auxiliary machinery",
    hint: "Pumps, OWS, incinerator, sewage plant, EGCS, BWTS etc.",
  },
  { key: "piping", label: "Piping" },
  { key: "electrical", label: "Electric / automation system and machinery" },
  { key: "hydro", label: "Hydro / pneumatic system" },
  { key: "steering", label: "Steering gear" },
  { key: "engineMisc", label: "Miscellaneous" },
]

export const CRITICAL_EQUIPMENT_ITEMS: { key: string; label: string; legacyKeys?: string[] }[] = [
  { key: "critical_auxiliaryEngineAlarms", label: "Auxiliary Engines — Alarms and Trips Test" },
  { key: "critical_bunkerTankLevelAlarms", label: "Bunker Tank Level Alarms" },
  { key: "critical_cargoTankLevelOverfillAlarms", label: "Cargo Tank Level / Overfill Alarms" },
  { key: "critical_deadManAlarms", label: "Dead-Man Alarm — Functional Test and Timer Verification" },
  { key: "critical_emergencyAirCompressor", label: "Emergency Air Compressor Testing" },
  { key: "critical_emergencyFirePump", label: "Emergency Fire Pump — Performance Test" },
  { key: "critical_emergencyGenerator", label: "Stand by Generator — Starting, Auto-Start and Load Test", legacyKeys: ["critical_generatorAutoStart"] },
  { key: "critical_engineRoomBlowerFunnelFlaps", label: "Ventilation Dampers, Funnel Flaps and Blower Flaps — Operation and Closure Test" },
  { key: "critical_fireAlarmSystem", label: "Fire Detection System — Detector and Manual Call Point Test" },
  { key: "critical_fireDoors", label: "Fire Doors — Automatic Closure Test" },
  { key: "critical_hypermistSystem", label: "Water Mist Fire Protection System — Functional Test" },
  { key: "critical_incineratorAlarmsTrips", label: "Incinerator — Alarms, Trips and Safety Interlocks Test" },
  { key: "critical_lifeboats", label: "Lifeboats — Engine, Launching, Manoeuvring and Sprinkler Test" },
  { key: "critical_mainEngineAlarmsTrips", label: "Main Engine — Emergency Manoeuvring, Trips and Emergency Stop Test" },
  { key: "critical_owsCleanDrainMonitoring", label: "Oily Water Separator — 15 PPM Alarm Test" },
  { key: "critical_paintRoom", label: "Paint Room Sprinkler" },
  { key: "critical_provisionRoomHospitalAlarms", label: "Provision Room / Hospital Alarms — Functional Test" },
  { key: "critical_steeringGear", label: "Steering Gear — Alarms and Trips Test" },
  { key: "critical_toppingUpAirCompressor", label: "Topping-up Air Compressor" },
  { key: "critical_emergencyBatteries", label: "Emergency Batteries — Inspection" },
  { key: "critical_emergencySteeringGear", label: "Emergency Steering Gear — Operational Test" },
  { key: "critical_generalAlarm", label: "General Alarm — Including ECR Alarm Test" },
  { key: "critical_bilgeAlarms", label: "Bilge Alarms — Engine Room, Pump Room, Emergency Fire Pump Room and Forecastle Store" },
  { key: "critical_watertightDoors", label: "Watertight Doors and Enclosures — Inspection and Test" },
  { key: "critical_fixedGasDetection", label: "Fixed Gas Detection System — Testing and Calibration" },
  { key: "critical_accommodationGasDetection", label: "Accommodation Gas Detection System — Functional Test" },
  { key: "critical_radar", label: "Radar — Performance Test" },
  { key: "critical_gyroCompass", label: "Gyro Compass — Performance Check" },
  { key: "critical_magneticCompass", label: "Magnetic Compass — Deviation Check" },
  { key: "critical_gmdss", label: "GMDSS Equipment — Functional Test" },
  { key: "critical_vdr", label: "Voyage Data Recorder (VDR) — Data Download and Operational Check" },
  { key: "critical_shipWhistles", label: "Ship's Whistles — Forward and Aft Operational Test" },
  { key: "critical_co2FoamDcpRoom", label: "CO2 / Foam / DCP Systems Room Inspection" },
  { key: "critical_embarkationLights", label: "Embarkation Lights — Inspection and Test" },
  { key: "critical_oilMistDetector", label: "Oil Mist Detector — Alarm and Functional Test" },
  { key: "critical_inertGasSystem", label: "Inert Gas System — System Testing" },
  { key: "critical_boilerTrips", label: "Boiler — Low and Low-Low Water Level Trips and Safety Interlocks" },
  { key: "critical_engineersCallAlarm", label: "Engineers' Call Alarm — UMS Alarm Activation and Timer Test" },
  { key: "critical_bnwas", label: "Bridge Navigational Watch Alarm System (BNWAS) — Functional Test" },

]

export const CONDITION_SECTIONS: { id: SectionId; title: string; items: ConditionItem[]; source: "deck" | "engine" }[] = [
  { id: "hull", title: "Hull", source: "deck", items: DECK_ITEMS.filter((i) => i.key === "hull") },
  { id: "mainDeck", title: "Main Deck", source: "deck", items: DECK_ITEMS.filter((i) => i.key === "weatherDeck") },
  { id: "cargoBallast", title: "Cargo Tank / Water Ballast Tanks", source: "deck", items: DECK_ITEMS.filter((i) => ["cargoHolds", "ballastTanks"].includes(i.key)) },
  { id: "deckMachinery", title: "Deck Machinery", source: "deck", items: DECK_ITEMS.filter((i) => ["hatchCovers", "cargoEquipment", "cranes", "ventilators", "mooring", "deckMisc"].includes(i.key)) },
  { id: "accommodation", title: "Accommodation", source: "deck", items: DECK_ITEMS.filter((i) => ["accommodation", "galley"].includes(i.key)) },
  { id: "safety", title: "Safety Equipments", source: "deck", items: DECK_ITEMS.filter((i) => ["lsa", "ffa"].includes(i.key)) },
  { id: "navigation", title: "Navigation Equipment", source: "deck", items: DECK_ITEMS.filter((i) => i.key === "navigation") },
  { id: "engine", title: "Engine Room", source: "engine", items: ENGINE_ITEMS },
]

export const MANAGEMENT_GROUPS: FieldGroup[] = [
  {
    title: "Planned Maintenance System",
    fields: [
      { key: "pmsLast", label: "Evaluation of implementation for last 3 months", type: "textarea", required: true },
      { key: "pmsNext", label: "Evaluation of plan for next 3 months", type: "textarea", required: true },
    ],
  },
  {
    title: "Status & Crew",
    fields: [
      { key: "survey", label: "Survey status", type: "textarea", required: true },
      { key: "budget", label: "Budget", type: "textarea", required: true },
      { key: "crew", label: "Crew evaluation / training needs", type: "textarea", required: true },
    ],
  },
  {
    title: "Critical Equipment",
    description:
      "Critical equipment listed in 14.07.02.002 (Critical Equipment Performance form) to be tested and performance evaluated. Mention equipment tried out with the parameters.",
    fields: [{ key: "critical", label: "Critical equipment findings", type: "textarea", required: true }],
  },
]

export const MANAGEMENT_SECTION_GROUPS: Record<"critical" | "system" | "survey" | "budget" | "crew", FieldGroup[]> = {
  critical: [MANAGEMENT_GROUPS[2]],
  system: [{ title: "Planned Maintenance System", fields: MANAGEMENT_GROUPS[0].fields }],
  survey: [{ title: "Class Survey Status", fields: [MANAGEMENT_GROUPS[1].fields[0]] }],
  budget: [{ title: "Budget", fields: [MANAGEMENT_GROUPS[1].fields[1]] }],
  crew: [
    {
      title: "Crew Complement",
      fields: [
        {
          key: "crewNationality",
          label: "Crew nationality",
          type: "select",
          span: 3,
          options: [
            "Indian", "Filipino", "Indonesian", "East European", "Chinese", "Myanmar",
          
      
          ],
        },
        { key: "totalCrew", label: "Total crew onboard", type: "select", options: Array.from({ length: 31 }, (_, count) => String(count)), required: true },
        { key: "officersCount", label: "Officers", type: "select", options: Array.from({ length: 16 }, (_, count) => String(count)) },
        { key: "otherCrewCount", label: "Crew / ratings", type: "select", options: Array.from({ length: 21 }, (_, count) => String(count)) },
      ],
    },
    {
      title: "Management Officers",
      fields: [
        { key: "masterName", label: "Master", span: 2, required: true },
        { key: "masterMonths", label: "Months onboard", type: "number", unit: "months" },
        { key: "chiefEngineerName", label: "Chief Engineer", span: 2, required: true },
        { key: "chiefEngineerMonths", label: "Months onboard", type: "number", unit: "months" },
        { key: "chiefOfficerName", label: "Chief Officer", span: 2 },
        { key: "chiefOfficerMonths", label: "Months onboard", type: "number", unit: "months" },
        { key: "secondEngineerName", label: "Second Engineer", span: 2 },
        { key: "secondEngineerMonths", label: "Months onboard", type: "number", unit: "months" },
      ],
    },
    {
      title: "Crew Assessment",
      fields: [{ ...MANAGEMENT_GROUPS[1].fields[2], label: "Crew assessment / training needs" }],
    },
  ],
}

export const PHOTO_CATEGORIES = [
  "View from the wharf / launch",
  "Main deck view from monkey island",
  "Main deck",
  "Forecastle deck",
  "Aft deck",
  "Boat deck",
  "Bridge",
  "Bridge deck",
  "Monkey island",
  "Superstructure",
  "Funnel",
  "Forward store",
  "Pump room",
  "Duct keel",
  "Pump trunk",
  "Fore peak tank",
  "After peak tank",
  "DB tanks",
  "DB tanks (port)",
  "DB tanks (starboard)",
  "FW tanks",
  "FO tanks",
  "LO tanks",
  "Accommodation",
  "Cargo control room",
  "Smoke room",
  "Galley & pantry",
  "Engine room",
  "Emergency generator room",
  "Engine control room",
  "Engine local control station",
  "Main engine and turbocharger",
  "Auxiliary engine and alternator",
  "Boilers",
  "Purifiers",
  "Inert gas generator",
  "Inert gas blowers",
  "Incinerator",
  "Air condition & provision compressors",
  "Steering gear",
  "Cargo oil pumps",
  "ODME",
  "OWS and 15 PPM",
  "Various pumps",
  "Exhaust pipes",
  "Others",
]

export const MAX_OWNER_PHOTOS = 50

/**
 * Condition ratings: four condition grades, plus Not inspected and Not applicable. A rating describes the observed
 * condition; it is not a risk rating (risk is assessed under the Company's risk assessment procedure).
 */
export const RATINGS = [
  { value: "satisfactory", label: "Satisfactory", short: "SAT", definition: "As expected for age and service; no defects." },
  { value: "acceptable", label: "Acceptable", short: "ACC", definition: "Minor wear or cosmetic defects; fit for purpose; routine maintenance." },
  {
    value: "degraded",
    label: "Degraded",
    short: "DEG",
    definition: "Deterioration beyond normal wear, or reduced performance or redundancy; requirements still met; corrective action by a due date.",
  },
  {
    value: "deficient",
    label: "Deficient",
    short: "DEF",
    definition: "A statutory, Class, Flag, maker’s or SMS requirement is not met, or the item does not work as required: a non-conformity needing immediate action and controls.",
  },
  { value: "notInspected", label: "Not inspected", short: "N/I", definition: "Could not be inspected during the attendance; the reason is recorded." },
  { value: "na", label: "Not applicable", short: "N/A", definition: "Not fitted, or outside the scope of this inspection." },
] as const

/**
 * Ratings recorded before the four-grade scale. They are never rewritten: "good" reads as Satisfactory (same
 * definition); "fair" and "poor" keep their original meaning and must be re-rated in reports not yet approved.
 */
export const LEGACY_RATINGS = [
  { value: "good", label: "Satisfactory", short: "SAT" },
  { value: "fair", label: "Monitor (earlier scale)", short: "MON" },
  { value: "poor", label: "Action required (earlier scale)", short: "ACT" },
] as const

export type CurrentRating = (typeof RATINGS)[number]["value"]
export type LegacyRating = (typeof LEGACY_RATINGS)[number]["value"]
export type Rating = CurrentRating | LegacyRating | ""

/** The rating as used by the report: earlier "good" becomes "satisfactory"; everything else is unchanged. */
export const effectiveRating = (rating: Rating | undefined): Rating => (rating === "good" ? "satisfactory" : rating ?? "")

export function ratingLabel(rating: Rating | undefined) {
  const value = effectiveRating(rating)
  return [...RATINGS, ...LEGACY_RATINGS].find((r) => r.value === value)?.label ?? ""
}

/** Ratings that need remarks: the finding, or the reason the item was not inspected. */
export const needsRemarks = (rating: Rating | undefined) =>
  rating === "degraded" || rating === "deficient" || rating === "notInspected"
/** Ratings that need a findings-register entry. */
export const needsFinding = (rating: Rating | undefined) => rating === "degraded" || rating === "deficient"
/** Earlier-scale ratings that must be re-rated before a report can be approved. */
export const isLegacyToRerate = (rating: Rating | undefined) => rating === "fair" || rating === "poor"

export const FINDING_PRIORITIES = [
  { value: "immediate", label: "Immediate", hint: "Controls now; rectify before the vessel proceeds or as soon as possible" },
  { value: "priority", label: "Priority", hint: "Rectify by the due date" },
  { value: "planned", label: "Planned", hint: "Through the PMS or routine maintenance by the due date" },
  { value: "drydock", label: "Next dry-docking", hint: "Deferred to the next dry-docking" },
] as const

export const RA_STATUSES = [
  { value: "notRequired", label: "Not required" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
] as const

export type FindingPriority = (typeof FINDING_PRIORITIES)[number]["value"]
export type RaStatus = (typeof RA_STATUSES)[number]["value"]

/** Findings-register entry for a Degraded or Deficient item, or for a critical-equipment test with a defect. */
export type Finding = {
  /** Corrective action and interim controls. */
  action: string
  priority: FindingPriority | ""
  /** ISO date; not needed for Next dry-docking or once closed. */
  dueDate: string
  safetyCritical: boolean
  raStatus: RaStatus | ""
  /** Company risk assessment number, when one applies. */
  raRef: string
  /** Defect list (DDRL / PMS) number. */
  defectRef: string
  status: "open" | "closed"
}

/** Condition items treated as safety-critical by default (the Superintendent can change it per finding). */
export const SAFETY_CRITICAL_ITEMS = ["lsa", "ffa", "navigation", "steering"]

export function emptyFinding(safetyCritical = false): Finding {
  return { action: "", priority: "", dueDate: "", safetyCritical, raStatus: "", raRef: "", defectRef: "", status: "open" }
}

export type ConditionEntry = {
  rating: Rating
  remarks: string
  finding?: Finding
  /** Short statement of the defect for the findings register, written by a remarks builder (e.g. Hull). */
  summary?: string
}

/** Result of a critical-equipment test (ISM Code 10.3). A defect carries its description and a finding. */
export type CriticalResult = { result: "satisfactory" | "defect" | ""; description?: string; finding?: Finding }

/** Critical-equipment tests ticked as carried out (older reports may use a legacy key). */
export const isCriticalTested = (item: (typeof CRITICAL_EQUIPMENT_ITEMS)[number], management: Record<string, string> | undefined) =>
  management?.[item.key] === "true" || Boolean(item.legacyKeys?.some((key) => management?.[key] === "true"))

/**
 * Structured inputs behind generated narrative sections (see lib/narrative). The generated text itself is also
 * written to the matching plain field (e.g. `summary.preamble`), which the PDF and summaries already read.
 * Older reports have no `narratives`; treat it as optional everywhere.
 */
export type Narratives = { preamble?: PreambleState } & { [K in Exclude<NarrativeSectionId, "preamble">]?: SectionState }

/** One Vessel Master value as captured into a report: the value as text (no unit), its status and release. */
export type SnapshotField = { value: string; status: Status; release: Release; reasons: string[]; physicalVerification: boolean }

/**
 * The vessel particulars a report was started from (lib/particulars.ts). Its presence makes the report use the six
 * Vessel Master groups; reports without one keep the earlier four groups. Fixed once captured: a later change in the
 * master never alters it; only "Refresh from Vessel Master" (with confirmation) or choosing another vessel does.
 *   none           no vessel chosen yet
 *   master         captured from the Vessel Master online
 *   offline-cache  captured from the copy saved in this browser (fetchedAt says when that copy was fetched)
 *   pending        vessel chosen offline with no saved copy: particulars follow once online; approval waits
 *   not-in-master  a vessel the master does not hold: particulars typed by hand
 */
export type VesselSnapshot = {
  schema: 1
  source: "none" | "master" | "offline-cache" | "pending" | "not-in-master"
  vesselId: string | null
  name: string
  imo: string | null
  masterRevision: number | null
  capturedAt: string | null
  fetchedAt: string | null
  /** Section F's basis label ("Reference: shop test"; "Guaranteed …" only for a verified contractual basis). */
  basisLabel: string | null
  fields: Record<string, SnapshotField>
  /** Offered values the Superintendent chose to use ("Use this value"). */
  confirmed: Record<string, { value: string; by: string; at: string }>
  /** Values the Superintendent entered that are not the master's; `flag` tracks the automatic correction flag. */
  entered: Record<string, { by: string; at: string; flag?: "pending" | "sent"; flagId?: string }>
  history: { at: string; by: string; action: "select" | "refresh" | "other-vessel" | "resolved"; masterRevision: number | null; changed: string[] }[]
}

export type Report = {
  id: string
  createdAt: number
  updatedAt: number
  syncedAt?: number
  details: Record<string, string>
  particulars: Record<string, string>
  summary: Record<string, string>
  scope: Record<string, boolean>
  worklist: Record<string, boolean>
  deck: Record<string, ConditionEntry>
  engine: Record<string, ConditionEntry>
  management: Record<string, string>
  /** Results of the critical-equipment tests ticked in `management` (optional: older reports have none). */
  criticalResults?: Record<string, CriticalResult>
  signoff: {
    /** Superintendent's signature (the person named under Inspected by). */
    superintendentSignature: string
    /** Fleet Manager's review and approval: the report is submitted once these are complete. */
    fleetManagerName?: string
    fleetManagerDate?: string
    fleetManagerSignature?: string
    /** Older reports only: a separate "Inspector" signature and a separately typed sign-off name. Kept, not edited. */
    inspectorSignature: string
    superintendentName: string
  }
  narratives?: Narratives
  /** Vessel Master particulars (optional: reports made before the Vessel Master have none and keep four groups). */
  vesselSnapshot?: VesselSnapshot
  deletedPhotoIds: string[]
}

export type Photo = {
  id: string
  reportId: string
  category: string
  caption: string
  includeInOwnerReport: boolean
  dataUrl: string
  createdAt: number
  updatedAt: number
  syncedAt?: number
}

export function createEmptyReport(id: string): Report {
  const now = Date.now()
  return {
    id,
    createdAt: now,
    updatedAt: now,
    details: {},
    particulars: {},
    summary: {},
    scope: {},
    worklist: {},
    deck: {},
    engine: {},
    management: {},
    signoff: { superintendentSignature: "", fleetManagerName: "", fleetManagerDate: "", fleetManagerSignature: "", inspectorSignature: "", superintendentName: "" },
    narratives: {},
    deletedPhotoIds: [],
  }
}

export function emptyVesselSnapshot(): VesselSnapshot {
  return {
    schema: 1, source: "none", vesselId: null, name: "", imo: null, masterRevision: null, capturedAt: null, fetchedAt: null,
    basisLabel: null, fields: {}, confirmed: {}, entered: {}, history: [],
  }
}

/** A brand-new report: six-group particulars from the Vessel Master. Never used as defaults for a loaded report
 *  (createEmptyReport is), so a report saved before the Vessel Master never turns into a six-group one. */
export function createNewReport(id: string): Report {
  return { ...createEmptyReport(id), vesselSnapshot: emptyVesselSnapshot() }
}

export type SectionId =
  | "details"
  | "particulars"
  | "summary"
  | "scope"
  | "hull" | "mainDeck" | "cargoBallast" | "deckMachinery" | "accommodation" | "safety" | "navigation" | "engine"
  | "critical" | "system" | "survey" | "budget" | "crew"
  | "photos"
  | "signoff"

export const SECTIONS: { id: SectionId; title: string; short: string }[] = [
  { id: "details", title: "Inspection Details", short: "Details" },
  { id: "particulars", title: "Principal Particulars", short: "Particulars" },
  { id: "summary", title: "Executive Summary", short: "Summary" },
  { id: "scope", title: "Scope of Inspection", short: "Scope" },
  { id: "hull", title: "Hull", short: "Hull" },
  { id: "mainDeck", title: "Main Deck", short: "Main Deck" },
  { id: "cargoBallast", title: "Cargo Tank / Water Ballast Tanks", short: "Cargo / Ballast Tanks" },
  { id: "deckMachinery", title: "Deck Machinery", short: "Deck Machinery" },
  { id: "accommodation", title: "Accommodation", short: "Accommodation" },
  { id: "safety", title: "Safety Equipments", short: "Safety Equipments" },
  { id: "navigation", title: "Navigation Equipment", short: "Navigation Equipment" },
  { id: "engine", title: "Engine Room", short: "Engine Room" },
  { id: "critical", title: "Critical Equipment", short: "Critical Equipment" },
  { id: "system", title: "System Implementation", short: "System Implementation" },
  { id: "survey", title: "Class Survey Status", short: "Class Survey Status" },
  { id: "budget", title: "Budget", short: "Budget" },
  { id: "crew", title: "Crew Evaluation", short: "Crew Evaluation" },
  { id: "photos", title: "Photographs", short: "Photos" },
  { id: "signoff", title: "Sign-off", short: "Sign-off" },
]

const filled = (v?: string) => Boolean(v && v.trim())

function fieldsProgress(groups: FieldGroup[], values: Record<string, string>) {
  const fields = groups.flatMap((g) => g.fields)
  return { done: fields.filter((f) => filled(values[f.key])).length, total: fields.length }
}

function conditionProgress(items: ConditionItem[], values: Record<string, ConditionEntry>) {
  return {
    done: items.filter((i) => values[i.key]?.rating || filled(values[i.key]?.remarks)).length,
    total: items.length,
  }
}

export function sectionProgress(
  report: Report,
  photoCount: number,
): Record<SectionId, { done: number; total: number }> {
  return {
    details: fieldsProgress(DETAILS_GROUPS, report.details),
    particulars: fieldsProgress(report.vesselSnapshot ? PARTICULARS_GROUPS_V2 : PARTICULARS_GROUPS, report.particulars),
    summary: fieldsProgress([{ fields: SUMMARY_FIELDS }], report.summary),
    scope: {
      done:
        SCOPE_ITEMS.filter((s) => report.scope[s.key]).length +
        WORKLIST_ITEMS.filter((w) => report.worklist[w.key]).length,
      total: SCOPE_ITEMS.length + WORKLIST_ITEMS.length,
    },
    hull: conditionProgress(DECK_ITEMS.filter((i) => i.key === "hull"), report.deck),
    mainDeck: conditionProgress(DECK_ITEMS.filter((i) => i.key === "weatherDeck"), report.deck),
    cargoBallast: conditionProgress(DECK_ITEMS.filter((i) => ["cargoHolds", "ballastTanks"].includes(i.key)), report.deck),
    deckMachinery: conditionProgress(DECK_ITEMS.filter((i) => ["hatchCovers", "cargoEquipment", "cranes", "ventilators", "mooring", "deckMisc"].includes(i.key)), report.deck),
    accommodation: conditionProgress(DECK_ITEMS.filter((i) => ["accommodation", "galley"].includes(i.key)), report.deck),
    safety: conditionProgress(DECK_ITEMS.filter((i) => ["lsa", "ffa"].includes(i.key)), report.deck),
    navigation: conditionProgress(DECK_ITEMS.filter((i) => i.key === "navigation"), report.deck),
    engine: conditionProgress(ENGINE_ITEMS, report.engine),
    critical: {
      done:
        CRITICAL_EQUIPMENT_ITEMS.filter((item) =>
          report.management[item.key] === "true" || item.legacyKeys?.some((key) => report.management[key] === "true"),
        ).length +
        (filled(report.management.critical) ? 1 : 0),
      total: CRITICAL_EQUIPMENT_ITEMS.length + 1,
    },
    system: fieldsProgress(MANAGEMENT_SECTION_GROUPS.system, report.management),
    survey: fieldsProgress(MANAGEMENT_SECTION_GROUPS.survey, report.management),
    budget: fieldsProgress(MANAGEMENT_SECTION_GROUPS.budget, report.management),
    crew: fieldsProgress(MANAGEMENT_SECTION_GROUPS.crew, report.management),
    photos: { done: Math.min(photoCount, 1), total: 1 },
    signoff: {
      done:
        (report.signoff.superintendentSignature || report.signoff.inspectorSignature ? 1 : 0) +
        (filled(report.signoff.fleetManagerName) ? 1 : 0) +
        (filled(report.signoff.fleetManagerDate) ? 1 : 0) +
        (report.signoff.fleetManagerSignature ? 1 : 0),
      total: 4,
    },
  }
}

export function overallProgress(report: Report, photoCount: number) {
  const parts = Object.values(sectionProgress(report, photoCount))
  const done = parts.reduce((a, p) => a + p.done, 0)
  const total = parts.reduce((a, p) => a + p.total, 0)
  return total ? Math.round((done / total) * 100) : 0
}
