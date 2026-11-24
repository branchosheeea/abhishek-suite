// Vessel Master · the field catalogue: what the master holds, which SIR group shows it, its unit, and when it may be
// filled into a report. Source: the workbook's Field_Definitions sheet (32 fields) and, for the fields it does not
// define (associated speeds, fuel basis, lube oils, statutory power, public DWT), Copilot's specification §5.
// Pure data, no I/O: used by the importer, the API, the editor and the PDF.

/** VERIFIED_ONLY: filled only when VERIFIED (a PROVISIONAL value is offered, not filled). VERIFIED_OR_PROVISIONAL: filled
 *  when VERIFIED or PROVISIONAL. MASTER_ONLY: kept in the master, never shown in the SIR (e.g. statutory power). */
export type Autofill = "VERIFIED_ONLY" | "VERIFIED_OR_PROVISIONAL" | "MASTER_ONLY"
/** Which workbook group status ("Registry Status", "Technical Status", "Performance Status") caps the field. */
export type StatusGroup = "registry" | "technical" | "performance"
export type ValueType = "text" | "integer" | "decimal"
export type SirGroup = "A" | "B" | "C" | "D" | "E" | "F"

export type FieldSpec = Readonly<{
  key: string
  label: string
  /** The SIR group, or null for a master-only field. */
  group: SirGroup | null
  /** Header of the Vessel_Master column. */
  column: string
  type: ValueType
  unit?: string
  autofill: Autofill
  statusGroup: StatusGroup
  /** Mandatory in a new (six-group) SIR before approval. */
  required?: boolean
}>

export const SIR_GROUPS: readonly { id: SirGroup; title: string }[] = [
  { id: "A", title: "Vessel Identification & Registration" },
  { id: "B", title: "Construction & Class" },
  { id: "C", title: "Ownership & Management" },
  { id: "D", title: "Principal Dimensions & Tonnage" },
  { id: "E", title: "Main Propulsion" },
  { id: "F", title: "Guaranteed / Reference Performance" },
]

const V = "VERIFIED_ONLY" as const
const VP = "VERIFIED_OR_PROVISIONAL" as const
const M = "MASTER_ONLY" as const

export const FIELDS: readonly FieldSpec[] = [
  // A · Field_Definitions rows 2-8
  { key: "vessel_name", label: "Vessel Name", group: "A", column: "Vessel Name", type: "text", autofill: VP, statusGroup: "registry", required: true },
  { key: "imo", label: "IMO Number", group: "A", column: "IMO Number", type: "text", autofill: VP, statusGroup: "registry", required: true },
  { key: "flag", label: "Flag", group: "A", column: "Flag", type: "text", autofill: V, statusGroup: "registry", required: true },
  { key: "port_of_registry", label: "Port of Registry", group: "A", column: "Port of Registry", type: "text", autofill: V, statusGroup: "registry" },
  { key: "official_number", label: "Official Number", group: "A", column: "Official Number", type: "text", autofill: V, statusGroup: "registry" },
  { key: "call_sign", label: "Call Sign", group: "A", column: "Call Sign", type: "text", autofill: V, statusGroup: "registry" },
  { key: "vessel_type", label: "Vessel Type", group: "A", column: "Vessel Type", type: "text", autofill: VP, statusGroup: "technical", required: true },
  // B · rows 9-13
  { key: "year_built", label: "Year Built", group: "B", column: "Year Built", type: "integer", autofill: VP, statusGroup: "technical", required: true },
  { key: "builder", label: "Builder", group: "B", column: "Builder / Yard", type: "text", autofill: VP, statusGroup: "technical" },
  { key: "hull_number", label: "Hull Number", group: "B", column: "Hull Number", type: "text", autofill: V, statusGroup: "technical" },
  { key: "class_society", label: "Classification Society", group: "B", column: "Classification Society", type: "text", autofill: VP, statusGroup: "technical", required: true },
  { key: "class_notation", label: "Class Notation", group: "B", column: "Class Notation", type: "text", autofill: VP, statusGroup: "technical" },
  // C · rows 14-16 (three separate fields: owner, manager and ISM company are not assumed to be the same)
  { key: "registered_owner", label: "Registered Owner", group: "C", column: "Registered Owner", type: "text", autofill: V, statusGroup: "registry", required: true },
  { key: "technical_manager", label: "Technical Manager", group: "C", column: "Technical Manager", type: "text", autofill: VP, statusGroup: "registry", required: true },
  { key: "ism_company", label: "ISM Company", group: "C", column: "ISM Company", type: "text", autofill: V, statusGroup: "registry" },
  // D · rows 17-24, plus the public fleet DWT kept apart from the verified summer DWT
  { key: "loa_m", label: "LOA", group: "D", column: "LOA (m)", type: "decimal", unit: "m", autofill: VP, statusGroup: "technical" },
  { key: "breadth_moulded_m", label: "Breadth Moulded", group: "D", column: "Breadth Moulded (m)", type: "decimal", unit: "m", autofill: VP, statusGroup: "technical" },
  { key: "depth_moulded_m", label: "Depth Moulded", group: "D", column: "Depth Moulded (m)", type: "decimal", unit: "m", autofill: VP, statusGroup: "technical" },
  { key: "summer_draft_m", label: "Summer Draft", group: "D", column: "Summer Draft (m)", type: "decimal", unit: "m", autofill: V, statusGroup: "technical" },
  { key: "summer_dwt_mt", label: "Summer Deadweight", group: "D", column: "Verified Summer DWT (MT)", type: "decimal", unit: "MT", autofill: VP, statusGroup: "technical", required: true },
  { key: "lightweight_mt", label: "Lightweight", group: "D", column: "Lightweight (MT)", type: "decimal", unit: "MT", autofill: VP, statusGroup: "technical" },
  { key: "gross_tonnage", label: "Gross Tonnage", group: "D", column: "Gross Tonnage", type: "integer", autofill: V, statusGroup: "registry" },
  { key: "net_tonnage", label: "Net Tonnage", group: "D", column: "Net Tonnage", type: "integer", autofill: V, statusGroup: "registry" },
  { key: "public_dwt_mt", label: "DHT public fleet DWT", group: null, column: "DHT Website DWT (MT)", type: "decimal", unit: "MT", autofill: M, statusGroup: "technical" },
  // E · rows 25-31, plus statutory propelling power kept apart from MCR
  { key: "main_engine", label: "Main Engine Make / Model", group: "E", column: "Main Engine Make / Model", type: "text", autofill: VP, statusGroup: "technical" },
  { key: "mcr_kw", label: "MCR", group: "E", column: "MCR (kW)", type: "decimal", unit: "kW", autofill: VP, statusGroup: "technical" },
  { key: "mcr_rpm", label: "MCR rpm", group: "E", column: "MCR (rpm)", type: "decimal", unit: "rpm", autofill: VP, statusGroup: "technical" },
  { key: "ncr_kw", label: "NCR/CSR", group: "E", column: "NCR/CSR (kW)", type: "decimal", unit: "kW", autofill: VP, statusGroup: "technical" },
  { key: "ncr_rpm", label: "NCR/CSR rpm", group: "E", column: "NCR/CSR (rpm)", type: "decimal", unit: "rpm", autofill: VP, statusGroup: "technical" },
  { key: "service_speed_laden_kn", label: "Service Speed - Laden", group: "E", column: "Service Speed Laden (kn)", type: "decimal", unit: "kn", autofill: VP, statusGroup: "performance" },
  { key: "service_speed_ballast_kn", label: "Service Speed - Ballast", group: "E", column: "Service Speed Ballast (kn)", type: "decimal", unit: "kn", autofill: VP, statusGroup: "performance" },
  { key: "statutory_power_kw", label: "Statutory Propelling Power", group: null, column: "Statutory Propelling Power (kW)", type: "decimal", unit: "kW", autofill: M, statusGroup: "technical" },
  // F · rows 32-33 and Copilot's specification §5 (fuel is never shown without its speed and basis)
  { key: "fuel_laden_mt_day", label: "Fuel Consumption - Laden", group: "F", column: "Guaranteed Fuel Consumption Laden (MT/day)", type: "decimal", unit: "MT/day", autofill: VP, statusGroup: "performance" },
  { key: "fuel_laden_speed_kn", label: "Associated Laden Speed", group: "F", column: "Associated Laden Speed (kn)", type: "decimal", unit: "kn", autofill: VP, statusGroup: "performance" },
  { key: "fuel_ballast_mt_day", label: "Fuel Consumption - Ballast", group: "F", column: "Guaranteed Fuel Consumption Ballast (MT/day)", type: "decimal", unit: "MT/day", autofill: VP, statusGroup: "performance" },
  { key: "fuel_ballast_speed_kn", label: "Associated Ballast Speed", group: "F", column: "Associated Ballast Speed (kn)", type: "decimal", unit: "kn", autofill: VP, statusGroup: "performance" },
  { key: "fuel_basis", label: "Fuel Grade / Reference Basis", group: "F", column: "Fuel Grade / Reference Basis", type: "text", autofill: VP, statusGroup: "performance" },
  // Lube-oil entries are free text in the workbook (e.g. "1.52 g/kWh running-in; 446 L/day"): kept as text, never converted.
  { key: "me_system_oil", label: "ME System Oil Consumption", group: "F", column: "ME System Oil Consumption", type: "text", autofill: VP, statusGroup: "performance" },
  { key: "me_cylinder_oil", label: "ME Cylinder Oil Consumption", group: "F", column: "ME Cylinder Oil Consumption", type: "text", autofill: VP, statusGroup: "performance" },
  { key: "dg_lube_oil", label: "DG Lube Oil Consumption", group: "F", column: "DG Lube Oil Consumption", type: "text", autofill: VP, statusGroup: "performance" },
]

export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f])) as Readonly<Record<string, FieldSpec>>
export const FIELD_KEYS = FIELDS.map((f) => f.key)

/** Fields that are filled together in the SIR display: "18,350 kW @ 62 rpm", "52.68 MT/day @ 14 kn". */
export const PAIRED: Readonly<Record<string, string>> = {
  mcr_kw: "mcr_rpm", ncr_kw: "ncr_rpm", fuel_laden_mt_day: "fuel_laden_speed_kn", fuel_ballast_mt_day: "fuel_ballast_speed_kn",
}

const keysOf = (...groups: (SirGroup | "statutory" | "public")[]) =>
  FIELDS.filter((f) => groups.includes(f.group as SirGroup) || (groups.includes("statutory") && f.key === "statutory_power_kw")
    || (groups.includes("public") && f.key === "public_dwt_mt")).map((f) => f.key)
export const PERFORMANCE_KEYS = [...keysOf("F"), "service_speed_laden_kn", "service_speed_ballast_kn"]
export const F_KEYS = keysOf("F")

/** Workbook layout the importer requires (Technical_Extraction_Log is not part of this version). */
export const WORKBOOK_SHEETS = ["Vessel_Master", "Source_Register", "Data_Quality", "Field_Definitions", "README", "Physical_Verification"] as const
export const IDENTITY_COLUMNS = ["Vessel ID", "Vessel Name", "Fleet Group", "Active Status", "IMO Number"] as const
export const STATUS_COLUMNS: Readonly<Record<StatusGroup, string>> = {
  registry: "Registry Status", technical: "Technical Status", performance: "Performance Status",
}
export const STATUSES = ["VERIFIED", "PROVISIONAL", "CONFLICT", "MISSING"] as const
export type Status = (typeof STATUSES)[number]
