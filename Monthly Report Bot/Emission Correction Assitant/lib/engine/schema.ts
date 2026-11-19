// Versioned source schemas: which header means what. Rules work on ROLES (timestamp, ROB of a fuel,
// consumption of a fuel by a consumer, ...), so correcting a column name is a schema change, not a rule change.
//
// ovd-3.13-1 (default, VERIFIED): exact data-field names from the DNV "OVD 3.13 interface description.xlsx"
//   supplied for this project, sheets "Log abstract" and "Bunker report". Names match case-insensitively (DNV's own
//   OVDLA export re-cases headers, e.g. Inert_Gas_Consumption_MGO); a case difference is reported as information.
//   Columns the description calls a "portion of total consumption" (cargo heating, DP, DPP cargo pumps) are
//   allocations and are never added to consumption. Lube-oil, projected and per-engine columns are not fuel
//   consumption roles.
// ovd-3.13-provisional-1: the earlier pattern-based mapping, kept only so runs made with it stay reproducible.
//
// Headers that match nothing are listed (never guessed). A role claimed by two columns is ambiguous and unused.

import type { SourceKind } from "./types"

export type Role =
  | { kind: "imo" }
  | { kind: "date" }
  | { kind: "time" }
  | { kind: "datetime" }
  | { kind: "event" }
  | { kind: "voyageFrom" }
  | { kind: "voyageTo" }
  | { kind: "durationHours" }
  | { kind: "maneuveringHours" }
  | { kind: "distanceNm" }
  | { kind: "cargoMt" }
  | { kind: "rob"; fuel: string }
  | { kind: "consumption"; fuel: string; consumer: string }
  | { kind: "allocation"; fuel: string; purpose: string }
  | { kind: "bdnConsumption"; consumer: string }
  | { kind: "bunkerFuel" }
  | { kind: "bunkerMass" }
  | { kind: "bunkerByFuel"; fuel: string }
  | { kind: "bdn" }
  | { kind: "port" }
  | { kind: "latDeg" }
  | { kind: "latMin" }
  | { kind: "latHem" }
  | { kind: "lonDeg" }
  | { kind: "lonMin" }
  | { kind: "lonHem" }
  | { kind: "latDecimal" }
  | { kind: "lonDecimal" }
  | { kind: "metadata"; name: string }

export type RoleKind = Role["kind"]

type Pattern = Readonly<{
  id: string
  pattern: RegExp
  role: (m: RegExpExecArray) => Role
  basis: "documented" | "unverified"
  /** The documented spelling, when the pattern is an exact documented field name. */
  name?: string
}>

type KindSchema = Readonly<{
  patterns: readonly Pattern[]
  /** Each entry is a set of alternatives; at least one alternative must be fully present. */
  required: readonly (readonly (readonly RoleKind[])[])[]
}>

export type SchemaVersion = Readonly<{
  id: string
  ovdVersion: string
  label: string
  verified: boolean
  note: string
  source: string
  kinds: Readonly<Record<SourceKind, KindSchema>>
}>

// ── Verified OVD 3.13 ────────────────────────────────────────────────────────

export const INTERFACE_SOURCE = "DNV OVD Interface Description 3.13 (supplied file \"OVD 3.13 interface description.xlsx\", SHA-256 115f8d8f055321c939bdeeb42f746bebd67a3ef82c4762eea86399062a4f6be6)"

/** Consumption column fuel suffix (sheet "Log abstract", rows 47–92) → canonical fuel code. */
const CONSUMPTION_FUELS: Readonly<Record<string, string>> = {
  HFO: "HFO", LFO: "LFO", MGO: "MGO", MDO: "MDO", LPGP: "LPGP", LPGB: "LPGB", LNG: "LNG", M: "METHANOL", E: "ETHANOL", O: "OTHER",
}
/** ROB column prefix (rows 127–137) → canonical fuel code. Methanol/Ethanol ROB are spelled out. */
const ROB_FUELS: Readonly<Record<string, string>> = {
  HFO: "HFO", LFO: "LFO", MGO: "MGO", MDO: "MDO", LPGP: "LPGP", LPGB: "LPGB", LNG: "LNG", Methanol: "METHANOL", Ethanol: "ETHANOL", O: "OTHER",
}
/** Fuel-type-scheme consumers (rows 47–92). Incinerators report only "other" fuel. */
const CONSUMERS = ["ME", "AE", "Boiler", "Inert_gas"] as const

/**
 * Bunker Report Fuel_Type → Log Abstract fuel category, from the "EU/UK fuel type name" column of the
 * "Fuel types" sheet. Fuels without a fuel-type-scheme category (bio, e-fuels, blends) are not mapped.
 */
export const BUNKER_FUEL_CATEGORY: Readonly<Record<string, string>> = {
  HFO: "HFO", LFO: "LFO", MGO: "MGO", MDO: "MDO", LPGP: "LPGP", LPGB: "LPGB", LNG: "LNG", METHANOL: "METHANOL", ETHANOL: "ETHANOL",
  LSHFO: "HFO", LSLFO: "LFO", LSMGO: "MGO", ULSFO2020: "HFO", ULSLFO2020: "LFO", ULSMDO2020: "MDO", ULSMGO2020: "MGO",
  VLSFO: "HFO", VLSFO2020: "HFO", VLSLFO2020: "LFO",
}

const exact = (name: string, role: Role): Pattern => ({
  id: name,
  name,
  pattern: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  role: () => role,
  basis: "documented",
})

function logAbstractFields(): Pattern[] {
  const fields: Pattern[] = [
    exact("IMO", { kind: "imo" }),
    exact("Date_UTC", { kind: "date" }),
    exact("Time_UTC", { kind: "time" }),
    exact("Event", { kind: "event" }),
    exact("Voyage_From", { kind: "voyageFrom" }),
    exact("Voyage_To", { kind: "voyageTo" }),
    exact("Time_Since_Previous_Report", { kind: "durationHours" }),
    exact("Time_Elapsed_Maneuvering", { kind: "maneuveringHours" }),
    exact("Distance", { kind: "distanceNm" }),
    exact("Cargo_Mt", { kind: "cargoMt" }),
    exact("Latitude_Degree", { kind: "latDeg" }),
    exact("Latitude_Minutes", { kind: "latMin" }),
    exact("Latitude_North_South", { kind: "latHem" }),
    exact("Longitude_Degree", { kind: "lonDeg" }),
    exact("Longitude_Minutes", { kind: "lonMin" }),
    exact("Longitude_East_West", { kind: "lonHem" }),
  ]
  for (const consumer of CONSUMERS) {
    for (const [suffix, fuel] of Object.entries(CONSUMPTION_FUELS)) fields.push(exact(`${consumer}_Consumption_${suffix}`, { kind: "consumption", consumer, fuel }))
    fields.push(exact(`${consumer}_Consumption_O_type`, { kind: "metadata", name: `${consumer}_Consumption_O_type` }))
  }
  fields.push(exact("Incinerator_Consumption_O", { kind: "consumption", consumer: "Incinerator", fuel: "OTHER" }))
  fields.push(exact("Incinerator_Consumption_O_Type", { kind: "metadata", name: "Incinerator_Consumption_O_Type" }))
  for (const [prefix, fuel] of Object.entries(ROB_FUELS)) fields.push(exact(`${prefix}_ROB`, { kind: "rob", fuel }))
  // Allocations: "portion of total consumption" (rows 163–187; Notes rows 42–44). Never added to consumption.
  for (const [suffix, fuel] of Object.entries(CONSUMPTION_FUELS)) {
    fields.push(exact(`Cargo_heating_Consumption_${suffix}`, { kind: "allocation", fuel, purpose: "Cargo heating" }))
    fields.push(exact(`DP_Consumption_${suffix}`, { kind: "allocation", fuel, purpose: "Dynamic positioning" }))
  }
  fields.push(exact("DPP_Cargo_Pump_Consumption_MDO", { kind: "allocation", fuel: "MDO", purpose: "DPP cargo pumps" }))
  fields.push(exact("DPP_Cargo_Pump_Consumption_O", { kind: "allocation", fuel: "OTHER", purpose: "DPP cargo pumps" }))
  // BDN-based consumption scheme (rows 93–126, 138–162). Detected so the two schemes are never mixed silently.
  for (const consumer of ["ME", "AE", "Boiler", "IGG", "GCU", "DPP", "Incinerator"]) {
    fields.push(exact(`${consumer}_Consumption`, { kind: "bdnConsumption", consumer }))
    for (const n of [2, 3, 4]) fields.push(exact(`${consumer}_Consumption_BDN_${n}`, { kind: "bdnConsumption", consumer }))
  }
  for (const n of [1, 2, 3, 4]) fields.push(exact(`ME_${n}_Consumption`, { kind: "bdnConsumption", consumer: `ME_${n}` }), exact(`Boiler_${n}_Consumption`, { kind: "bdnConsumption", consumer: `Boiler_${n}` }))
  for (const n of [1, 2, 3, 4, 5, 6]) fields.push(exact(`AE_${n}_Consumption`, { kind: "bdnConsumption", consumer: `AE_${n}` }))
  // Context fields used for explanations (no calculation role)
  for (const name of [
    "Voyage_Type", "Voyage_Number", "Offhire_Reasons", "Mode", "Purposes_Of_Call", "Period_Event_Type", "Previous_Port_of_Call",
    "Next_Port_of_Call", "Previous_Port_of_Call_FuelEU", "Next_Port_of_Call_FuelEU", "Time_Elapsed_Sailing", "Time_Elapsed_Anchoring",
    "Time_Elapsed_DP", "Time_Elapsed_Ice", "Time_Elapsed_Waiting", "Time_Elapsed_Loading_Unloading",
    "Time_Elapsed_Drifting", "Deadweight_Carried", "Cargo_M3", "Passengers", "Crew", "ROB_Fuel_Total", "Event_Id", "Sort_Number",
    "Remarks", "ME_Fuel_BDN", "AE_Fuel_BDN", "ROB_Fuel_BDN", "BDN_ROB", "O_ROB_type", "Shore_Side_Electricity_Reception",
    "Duration_Shore_Side_Electricity_Reception",
  ]) fields.push(exact(name, { kind: "metadata", name }))
  return fields
}

const TIMESTAMP_REQUIRED: readonly (readonly RoleKind[])[] = [["date", "time"], ["datetime"]]

export const OVD_3_13: SchemaVersion = Object.freeze({
  id: "ovd-3.13-1",
  ovdVersion: "3.13",
  label: "OVD 3.13 (verified against the supplied Interface Description)",
  verified: true,
  note: `Field names, units and the fuel-type mapping are taken from the ${INTERFACE_SOURCE}.`,
  source: INTERFACE_SOURCE,
  kinds: {
    LA: { patterns: logAbstractFields(), required: [[["imo"]], TIMESTAMP_REQUIRED, [["event"]]] },
    OVDLA: {
      patterns: [
        ...logAbstractFields(),
        // System-generated export columns (not part of the interface description)
        { id: "Source_System", pattern: /^Source_System$/i, role: () => ({ kind: "metadata", name: "Source_System" }), basis: "unverified" },
        { id: "Last_Updated", pattern: /^Last_Updated$/i, role: () => ({ kind: "metadata", name: "Last_Updated" }), basis: "unverified" },
      ],
      required: [[["imo"]], TIMESTAMP_REQUIRED, [["event"]]],
    },
    BR: {
      patterns: [
        exact("IMO", { kind: "imo" }),
        exact("BDN_Number", { kind: "bdn" }),
        exact("Bunker_Delivery_Date", { kind: "date" }),
        exact("Bunker_Delivery_Time", { kind: "time" }),
        exact("Fuel_Type", { kind: "bunkerFuel" }),
        exact("Mass", { kind: "bunkerMass" }),
        exact("Bunker_Port", { kind: "port" }),
      ],
      required: [[["bunkerFuel"]], [["bunkerMass"]], TIMESTAMP_REQUIRED],
    },
  },
} satisfies SchemaVersion)

// ── Provisional (superseded, kept for reproducibility) ──────────────────────

const FUEL = "HFO|LFO|MGO|MDO|LNG|LPG(?:_[A-Za-z]+)?|Methanol|Ethanol|VLSFO|ULSFO|ULSMGO|Other(?:_[A-Za-z0-9]+)?"
const fuelCode = (text: string) => text.toUpperCase()
const u = (id: string, pattern: RegExp, role: (m: RegExpExecArray) => Role): Pattern => ({ id, pattern, role, basis: "unverified" })

const TIME_PATTERNS: Pattern[] = [
  u("imo", /^IMO$/i, () => ({ kind: "imo" })),
  u("date-utc", /^Date_UTC$/i, () => ({ kind: "date" })),
  u("time-utc", /^Time_UTC$/i, () => ({ kind: "time" })),
  u("datetime-utc", /^(?:Date_Time_UTC|DateTime_UTC|Timestamp_UTC)$/i, () => ({ kind: "datetime" })),
]

const LOG_PATTERNS: Pattern[] = [
  ...TIME_PATTERNS,
  u("event", /^Event$/i, () => ({ kind: "event" })),
  u("voyage-from", /^Voyage_From$/i, () => ({ kind: "voyageFrom" })),
  u("voyage-to", /^Voyage_To$/i, () => ({ kind: "voyageTo" })),
  u("duration", /^Time_Since_Previous_Report$/i, () => ({ kind: "durationHours" })),
  u("distance", /^Distance$/i, () => ({ kind: "distanceNm" })),
  u("cargo", /^Cargo_Mt$/i, () => ({ kind: "cargoMt" })),
  u("consumption", new RegExp(`^([A-Za-z]+(?:_[A-Za-z]+)*?)_Consumption_(${FUEL})$`, "i"), (m) => ({ kind: "consumption", consumer: m[1], fuel: fuelCode(m[2]) })),
  u("rob-suffix", new RegExp(`^(${FUEL})_ROB$`, "i"), (m) => ({ kind: "rob", fuel: fuelCode(m[1]) })),
  u("rob-prefix", new RegExp(`^ROB_(${FUEL})$`, "i"), (m) => ({ kind: "rob", fuel: fuelCode(m[1]) })),
  u("lat-deg", /^Latitude_Degree$/i, () => ({ kind: "latDeg" })),
  u("lat-min", /^Latitude_Minutes?$/i, () => ({ kind: "latMin" })),
  u("lat-hem", /^Latitude_North_South$/i, () => ({ kind: "latHem" })),
  u("lon-deg", /^Longitude_Degree$/i, () => ({ kind: "lonDeg" })),
  u("lon-min", /^Longitude_Minutes?$/i, () => ({ kind: "lonMin" })),
  u("lon-hem", /^Longitude_East_West$/i, () => ({ kind: "lonHem" })),
  u("lat-dec", /^Latitude$/i, () => ({ kind: "latDecimal" })),
  u("lon-dec", /^Longitude$/i, () => ({ kind: "lonDecimal" })),
]

export const OVD_3_13_PROVISIONAL: SchemaVersion = Object.freeze({
  id: "ovd-3.13-provisional-1",
  ovdVersion: "3.13",
  label: "OVD 3.13 (provisional mapping, superseded)",
  verified: false,
  note:
    "Superseded by ovd-3.13-1. Column roles were inferred from header-name patterns before the official Interface " +
    "Description was available; it counted cargo-heating allocation columns as consumption.",
  source: "header-name patterns (no document)",
  kinds: {
    LA: { patterns: LOG_PATTERNS, required: [[["imo"]], TIMESTAMP_REQUIRED, [["event"]]] },
    OVDLA: {
      patterns: [
        ...LOG_PATTERNS,
        u("source-system", /^Source_System$/i, () => ({ kind: "metadata", name: "Source_System" })),
        u("last-updated", /^Last_Updated$/i, () => ({ kind: "metadata", name: "Last_Updated" })),
      ],
      required: [[["imo"]], TIMESTAMP_REQUIRED, [["event"]]],
    },
    BR: {
      patterns: [
        ...TIME_PATTERNS,
        u("bunker-fuel", /^(?:Fuel_Type|Fuel|Fuel_Grade|Grade)$/i, () => ({ kind: "bunkerFuel" })),
        u("bunker-mass", /^(?:Mass|Mass_Mt|Quantity|Quantity_Mt|Bunkered_Mt|Bunker_Mt|Amount_Mt)$/i, () => ({ kind: "bunkerMass" })),
        u("bunker-by-fuel", new RegExp(`^(${FUEL})_(?:Bunkered|Bunker|Delivered|Received)(?:_Mt)?$`, "i"), (m) => ({ kind: "bunkerByFuel", fuel: fuelCode(m[1]) })),
        u("bdn", /^(?:BDN|BDN_Number|BDN_No|Bunker_Delivery_Note(?:_Number)?)$/i, () => ({ kind: "bdn" })),
        u("port", /^(?:Port|Port_Code|Bunker_Port|Location)$/i, () => ({ kind: "port" })),
      ],
      required: [TIMESTAMP_REQUIRED],
    },
  },
} satisfies SchemaVersion)

export const DEFAULT_SCHEMA = OVD_3_13
export const SCHEMAS: readonly SchemaVersion[] = [OVD_3_13, OVD_3_13_PROVISIONAL]

export function schemaById(id: string): SchemaVersion | undefined {
  return SCHEMAS.find((s) => s.id === id)
}

export type MappedColumn = Readonly<{ index: number; header: string; role: Role | null; patternId: string | null }>

export type ColumnMap = Readonly<{
  columns: readonly MappedColumn[]
  missingRequired: readonly string[]
  duplicateHeaders: readonly string[]
  whitespaceHeaders: readonly string[]
  conflictingRoles: readonly string[]
  unmapped: readonly string[]
  /** Headers that match a documented field name only when case is ignored. */
  caseDifferences: readonly Readonly<{ header: string; documented: string }>[]
}>

export function roleKey(role: Role): string {
  switch (role.kind) {
    case "rob":
    case "bunkerByFuel":
      return `${role.kind}:${role.fuel}`
    case "consumption":
      return `consumption:${role.fuel}:${role.consumer.toLowerCase()}`
    case "allocation":
      return `allocation:${role.fuel}:${role.purpose.toLowerCase()}`
    case "metadata":
      return `metadata:${role.name.toLowerCase()}`
    case "bdnConsumption":
      return `bdn:${role.consumer.toLowerCase()}`
    default:
      return role.kind
  }
}

export function describeRole(role: Role): string {
  switch (role.kind) {
    case "rob":
      return `ROB ${role.fuel}`
    case "consumption":
      return `${role.consumer.replace(/_/g, " ")} consumption ${role.fuel}`
    case "allocation":
      return `${role.purpose} ${role.fuel} (portion of total, not added)`
    case "bdnConsumption":
      return `${role.consumer.replace(/_/g, " ")} consumption (BDN scheme)`
    case "bunkerByFuel":
      return `Bunkered ${role.fuel}`
    case "metadata":
      return `Context: ${role.name}`
    default:
      return role.kind
  }
}

/** Map headers to roles. Matching uses the trimmed header; surrounding whitespace is reported, not hidden. */
export function mapHeaders(headers: readonly string[], kind: SourceKind, schema: SchemaVersion = DEFAULT_SCHEMA): ColumnMap {
  const patterns = schema.kinds[kind].patterns
  const seen = new Map<string, number>()
  const duplicateHeaders = new Set<string>()
  const whitespaceHeaders: string[] = []
  const caseDifferences: { header: string; documented: string }[] = []
  const roleColumns = new Map<string, number[]>()
  const columns: MappedColumn[] = headers.map((header, index) => {
    const trimmed = header.trim()
    if (trimmed !== header) whitespaceHeaders.push(header)
    const lower = trimmed.toLowerCase()
    if (seen.has(lower)) duplicateHeaders.add(trimmed)
    seen.set(lower, index)
    for (const p of patterns) {
      const m = p.pattern.exec(trimmed)
      if (m) {
        const role = p.role(m)
        const key = roleKey(role)
        roleColumns.set(key, [...(roleColumns.get(key) ?? []), index])
        if (p.name && p.name !== trimmed) caseDifferences.push({ header: trimmed, documented: p.name })
        return { index, header, role, patternId: p.id }
      }
    }
    return { index, header, role: null, patternId: null }
  })
  const conflictingRoles = [...roleColumns.entries()].filter(([, idx]) => idx.length > 1).map(([key, idx]) => `${key} (columns ${idx.map((i) => i + 1).join(", ")})`)
  // A role claimed by two columns is ambiguous: neither is used, so no value is silently chosen.
  const ambiguous = new Set([...roleColumns.entries()].filter(([, idx]) => idx.length > 1).flatMap(([, idx]) => idx))
  const finalColumns = columns.map((c) => (ambiguous.has(c.index) ? { ...c, role: null, patternId: null } : c))
  const present = new Set(finalColumns.filter((c) => c.role).map((c) => c.role!.kind))
  const missingRequired = schema.kinds[kind].required
    .filter((alternatives) => !alternatives.some((set) => set.every((k) => present.has(k))))
    .map((alternatives) => alternatives.map((set) => set.join(" + ")).join(" or "))
  return {
    columns: finalColumns,
    missingRequired,
    duplicateHeaders: [...duplicateHeaders],
    whitespaceHeaders,
    conflictingRoles,
    unmapped: finalColumns.filter((c) => !c.role && c.header.trim() !== "").map((c) => c.header),
    caseDifferences,
  }
}

export function columnFor(map: ColumnMap, predicate: (role: Role) => boolean): MappedColumn | undefined {
  return map.columns.find((c) => c.role !== null && predicate(c.role))
}

export function columnsFor(map: ColumnMap, predicate: (role: Role) => boolean): MappedColumn[] {
  return map.columns.filter((c) => c.role !== null && predicate(c.role))
}
