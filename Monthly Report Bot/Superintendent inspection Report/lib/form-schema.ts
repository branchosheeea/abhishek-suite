export const FORM_CODE = "16.02.00.003.04"
export const FORM_TITLE = "Superintendent's Detailed Inspection Report"

export type FieldType = "text" | "date" | "textarea" | "number" | "select"

export type FieldDef = {
  key: string
  label: string
  type?: FieldType
  unit?: string
  placeholder?: string
  span?: 1 | 2 | 3
  options?: string[]
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
      { key: "vessel", label: "Vessel", placeholder: "e.g. MV Ocean Star" },
      { key: "port", label: "Port", placeholder: "e.g. Singapore" },
      { key: "dateFrom", label: "Inspection from", type: "date" },
      { key: "dateTo", label: "Inspection to", type: "date" },
      { key: "reportNo", label: "Inspection report no.", placeholder: "e.g. SIR-2026-014" },
      { key: "lastInspection", label: "Date of last inspection", type: "date" },
      { key: "nextInspection", label: "Next planned inspection", type: "date" },
    ],
  },
  {
    title: "Inspected by",
    fields: [
      { key: "inspectedBy", label: "Name" },
      { key: "inspectedDate", label: "Date", type: "date" },
      { key: "inspectedPlace", label: "Place" },
    ],
  },
]

export const PARTICULARS_GROUPS: FieldGroup[] = [
  {
    title: "Identification",
    fields: [
      { key: "shipName", label: "Ship name" },
      { key: "imo", label: "IMO no.", placeholder: "7 digits" },
      { key: "flag", label: "Flag" },
      { key: "portOfRegistry", label: "Port of registry" },
      { key: "officialNo", label: "Official no." },
      { key: "callSign", label: "Call sign" },
      { key: "hullNo", label: "Hull no." },
      { key: "yearBuilt", label: "Year of built", type: "number" },
      { key: "builder", label: "Builder" },
      { key: "shipType", label: "Ship type" },
      { key: "owners", label: "Owners" },
      { key: "managers", label: "Managers" },
      { key: "classification", label: "Classification" },
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
      { key: "deadweight", label: "Deadweight", unit: "mt" },
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
  { key: "preamble", label: "Preamble", type: "textarea" },
  { key: "overall", label: "Overall condition", type: "textarea" },
  { key: "structural", label: "Structural condition", type: "textarea" },
  { key: "operational", label: "Operational condition", type: "textarea" },
  { key: "performance", label: "Performance", type: "textarea" },
  { key: "problems", label: "Significant problems", type: "textarea" },
  { key: "projects", label: "Projects and upgrades", type: "textarea" },
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
      { key: "pmsLast", label: "Evaluation of implementation for last 3 months", type: "textarea" },
      { key: "pmsNext", label: "Evaluation of plan for next 3 months", type: "textarea" },
    ],
  },
  {
    title: "Status & Crew",
    fields: [
      { key: "survey", label: "Survey status", type: "textarea" },
      { key: "budget", label: "Budget", type: "textarea" },
      { key: "crew", label: "Crew evaluation / training needs", type: "textarea" },
    ],
  },
  {
    title: "Critical Equipment",
    description:
      "Critical equipment listed in 14.07.02.002 (Critical Equipment Performance form) to be tested and performance evaluated. Mention equipment tried out with the parameters.",
    fields: [{ key: "critical", label: "Critical equipment findings", type: "textarea" }],
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
        { key: "totalCrew", label: "Total crew onboard", type: "select", options: Array.from({ length: 31 }, (_, count) => String(count)) },
        { key: "officersCount", label: "Officers", type: "select", options: Array.from({ length: 16 }, (_, count) => String(count)) },
        { key: "otherCrewCount", label: "Crew / ratings", type: "select", options: Array.from({ length: 21 }, (_, count) => String(count)) },
      ],
    },
    {
      title: "Management Officers",
      fields: [
        { key: "masterName", label: "Master", span: 2 },
        { key: "masterMonths", label: "Months onboard", type: "number", unit: "months" },
        { key: "chiefEngineerName", label: "Chief Engineer", span: 2 },
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

export const RATINGS = [
  { value: "good", label: "Satisfactory", short: "SAT" },
  { value: "fair", label: "Monitor", short: "MON" },
  { value: "poor", label: "Action required", short: "ACT" },
  { value: "na", label: "Not applicable", short: "N/A" },
] as const

export type Rating = (typeof RATINGS)[number]["value"] | ""

export type ConditionEntry = { rating: Rating; remarks: string }

const CONDITION_RISK_POINTS = {
  good: 20,
  fair: 40,
  poor: 80,
} as const

export function conditionRiskScore(values: Record<string, ConditionEntry | undefined>) {
  const scores = Object.values(values).flatMap((entry) => {
    const rating = entry?.rating
    if (rating === "good" || rating === "fair" || rating === "poor") return [CONDITION_RISK_POINTS[rating]]
    return []
  })
  return scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null
}

export function conditionRiskBand(score: number) {
  if (score < 30) return "Low Risk"
  if (score < 50) return "Moderate Risk"
  if (score < 70) return "High Risk"
  return "Very High Risk"
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
  signoff: {
    inspectorSignature: string
    superintendentName: string
    superintendentSignature: string
  }
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
    signoff: { inspectorSignature: "", superintendentName: "", superintendentSignature: "" },
    deletedPhotoIds: [],
  }
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
    particulars: fieldsProgress(PARTICULARS_GROUPS, report.particulars),
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
        (filled(report.signoff.superintendentName) ? 1 : 0) +
        (report.signoff.superintendentSignature ? 1 : 0),
      total: 2,
    },
  }
}

export function overallProgress(report: Report, photoCount: number) {
  const parts = Object.values(sectionProgress(report, photoCount))
  const done = parts.reduce((a, p) => a + p.done, 0)
  const total = parts.reduce((a, p) => a + p.total, 0)
  return total ? Math.round((done / total) * 100) : 0
}
