// Vessel Master · how the workbook becomes master records: field status (VERIFIED / PROVISIONAL / CONFLICT / MISSING),
// and whether the SIR may fill, offer or must withhold each value. Pure: tested without a database.
//
// The rules are conservative; where two sheets disagree, the stricter outcome wins and the reason is kept.
//   1. A blank cell is MISSING (stored as null, never 0).
//   2. A Data_Quality item with a BLOCK-type disposition (or ORANGE / physical verify) withholds the field (CONFLICT).
//   3. An orange cell needs physical verification: at most PROVISIONAL, and withheld until verified.
//   4. A field is VERIFIED only if its workbook group status is VERIFIED *and* a VERIFIED Source_Register row for that
//      vessel covers that field. Group-level status alone never verifies a field. Otherwise PROVISIONAL.
//   5. Caps ("PROVISIONAL ONLY", "PARTIAL ONLY", "LEAVE BLANK OR PROVISIONAL") keep a field at PROVISIONAL at most.
//   6. A group status of CONFLICT keeps the group's other fields at PROVISIONAL and offers them (never fills them).
// Release: VERIFIED -> fill; PROVISIONAL -> fill when the field allows provisional values, otherwise offer (the
// Superintendent confirms it); CONFLICT / physical verification -> withhold; MISSING -> nothing.
//
// The reviewed tables below say which fields a free-text sheet entry means. Anything they do not cover becomes a
// review exception and makes the import more cautious, never less.

import { F_KEYS, FIELD, FIELDS, PERFORMANCE_KEYS, STATUS_COLUMNS, type FieldSpec, type Status, type StatusGroup } from "./fields"
import type { Cell, ParsedWorkbook, Row, VesselRow } from "./workbook"

export type Release = "fill" | "offer" | "withhold" | "master-only"
export type BasisType = "CONTRACTUAL" | "SEA_TRIAL_MEASURED" | "SHOP_TEST" | "SERIES_SPEC_CANDIDATE" | "HISTORICAL_SIR" | "UNSPECIFIED"

export type MasterField = {
  value: string | number | null
  /** The cell exactly as read, when parsing changed it (e.g. the text "336.0"). */
  raw?: Cell
  unit?: string
  status: Status
  release: Release
  physicalVerification: boolean
  reasons: string[]
  sourceIds: string[]
  issueIds: string[]
}

export type MasterDraft = {
  workbookId: string | null
  /** NeraVeda's name (upper case, as the existing fleet lists and records use it). */
  name: string
  aliases: string[]
  /** Keys used by existing records: SIR details.vesselId and Digital Docking vessel_id ("DHT_LEOPARD"). */
  legacyKeys: string[]
  imo: string | null
  fleetGroup: string | null
  activeStatus: string
  groupStatus: Record<StatusGroup, Status | null>
  performanceBasis: BasisType | null
  sourceNote: string | null
  fields: Record<string, MasterField>
}

export type Rejected = { row: number; workbookId: string | null; reasons: string[] }
export type ReviewException = { workbookId: string | null; text: string }

export type BuildResult = { vessels: MasterDraft[]; rejected: Rejected[]; exceptions: ReviewException[] }

// ── Reviewed interpretation tables (each entry is from the 24 Nov 2026 workbook review in the approved plan) ──────

const REGISTRY = ["vessel_name", "flag", "port_of_registry", "official_number", "call_sign"]
const DIMENSIONS = ["loa_m", "breadth_moulded_m", "depth_moulded_m"]
const TONNAGE = ["gross_tonnage", "net_tonnage"]
const ENGINE = ["main_engine", "mcr_kw", "mcr_rpm"]
const RATINGS = ["mcr_kw", "mcr_rpm", "ncr_kw", "ncr_rpm", "statutory_power_kw"]

/** Source_Register "Field / Field Group" text -> the fields it covers. scope: evidence of fleet scope, never of a value. */
export const SOURCE_FIELD_GROUPS: Readonly<Record<string, { fields: readonly string[]; scope?: boolean; unmapped?: string }>> = {
  "fleet membership; built year; yard; public dwt; class": { fields: ["public_dwt_mt", "year_built", "builder", "class_society"], scope: true },
  "identity, registry, owner, gt/nt": { fields: [...REGISTRY, "registered_owner", ...TONNAGE] },
  "identity, registry, owner, gt/nt, statutory power": { fields: [...REGISTRY, "registered_owner", ...TONNAGE, "statutory_power_kw"] },
  "current identity and registry": { fields: REGISTRY },
  "ism company": { fields: ["ism_company"] },
  "ism company, identity and tonnage": { fields: ["ism_company", "vessel_name", ...TONNAGE] },
  "load-line condition / dwt": { fields: ["summer_dwt_mt"] },
  "imo number": { fields: ["imo"] },
  "mcr and company": { fields: ["mcr_kw"], unmapped: "company (which of technical manager / ISM company is not stated)" },
  "hull, dimensions, dwt, gt/nt, lightweight, class notation": { fields: ["hull_number", ...DIMENSIONS, "summer_dwt_mt", ...TONNAGE, "lightweight_mt", "class_notation"] },
  "identity, owner, hull, year, statutory power, itc dimensions and tonnage": { fields: ["vessel_name", "registered_owner", "hull_number", "year_built", "statutory_power_kw", ...TONNAGE] },
  "principal dimensions, dwt, class and notation": { fields: [...DIMENSIONS, "summer_dwt_mt", "class_society", "class_notation"] },
  "current registry, dimensions, tonnage, engine and rating": { fields: [...REGISTRY.slice(1), ...DIMENSIONS, ...TONNAGE, ...ENGINE] },
  "identity, dimensions, tonnage, engine/rating, class": { fields: ["vessel_name", ...DIMENSIONS, ...TONNAGE, ...ENGINE, "class_society"] },
  "current identity, dimensions, tonnage, class notation": { fields: [...REGISTRY, ...DIMENSIONS, ...TONNAGE, "class_notation"] },
  "current dimensions, dwt, tonnage and class notation": { fields: [...DIMENSIONS, "summer_dwt_mt", ...TONNAGE, "class_notation"] },
  "sea trial speed and performance": { fields: PERFORMANCE_KEYS },
  "visible reference-performance values": { fields: F_KEYS },
  "eedi/shop-test sfoc and clo basis": { fields: ["fuel_basis", "me_cylinder_oil"] },
  "speed, fuel consumption and cylinder oil": { fields: ["service_speed_laden_kn", "service_speed_ballast_kn", "fuel_laden_mt_day", "fuel_laden_speed_kn", "fuel_ballast_mt_day", "fuel_ballast_speed_kn", "fuel_basis", "me_cylinder_oil"] },
  "contract speed and daily fuel consumption": { fields: ["service_speed_laden_kn", "fuel_laden_mt_day", "fuel_laden_speed_kn", "fuel_basis"] },
  "candidate contract speed and consumption": { fields: ["service_speed_laden_kn", "fuel_laden_mt_day", "fuel_laden_speed_kn", "fuel_basis"] },
  "speed, fuel and lube reference": { fields: PERFORMANCE_KEYS },
}

/** Data_Quality items -> the fields they concern (the effect comes from the row's own disposition). "*" = every field. */
export const ISSUE_FIELDS: Readonly<Record<string, { vessel: string; fields: readonly string[] | "*" }>> = {
  "DQ-001": { vessel: "DIMP", fields: ["hull_number"] },
  "DQ-002": { vessel: "DPUM", fields: ["mcr_kw", "statutory_power_kw"] },
  "DQ-003": { vessel: "DSUN", fields: ["summer_dwt_mt", "public_dwt_mt"] },
  "DQ-004": { vessel: "DLIO", fields: [...REGISTRY.slice(1), "registered_owner"] },
  "DQ-005": { vessel: "DNOK", fields: "*" },
  "DQ-006": { vessel: "DLEO", fields: ["fuel_laden_mt_day", "fuel_laden_speed_kn", "fuel_basis"] },
  "DQ-007": { vessel: "DGAZ", fields: ["class_notation"] },
  "DQ-008": { vessel: "DANT", fields: ["summer_dwt_mt", "public_dwt_mt"] },
  "DQ-009": { vessel: "ALL", fields: F_KEYS },
  "DQ-010": { vessel: "DOSP", fields: [...REGISTRY.slice(1), "registered_owner"] },
  "DQ-011": { vessel: "DRED", fields: "*" },
  "DQ-012": { vessel: "DAMA", fields: "*" },
  "DQ-013": { vessel: "DGAZ", fields: PERFORMANCE_KEYS },
  "DQ-014": { vessel: "DANT", fields: [...RATINGS, "service_speed_laden_kn", "service_speed_ballast_kn", ...F_KEYS] },
  "DQ-015": { vessel: "DIMP", fields: ["fuel_basis", "me_cylinder_oil"] },
  "DQ-016": { vessel: "DSUN", fields: PERFORMANCE_KEYS },
}

/** Decisions taken in the approved plan where a sheet's disposition alone would release a doubtful value (§12). */
export const REVIEW_HOLDS: readonly { vessel: string; fields: readonly string[]; effect: "block" | "cap"; reason: string }[] = [
  { vessel: "DPUM", fields: ["mcr_kw"], effect: "block", reason: "Plan Q3: the 24,400 kW in the MCR column may be the statutory propelling power (DQ-002; the SIR shows 25,325 kW). Withheld until the EIAPP / NOx Technical File is checked." },
  { vessel: "DANT", fields: ["summer_dwt_mt"], effect: "block", reason: "Plan Q4: 321,012 MT is the scantling figure (DQ-008); the SIR needs the load-line summer deadweight." },
  { vessel: "DADD", fields: PERFORMANCE_KEYS, effect: "cap", reason: "Plan Q1: the contract source is specification H5508-FS-R1-G1, but DHT Addax is hull 5509 (5508 is DHT Antelope, see DQ-014). Kept PROVISIONAL until the specification is confirmed for Addax." },
]

/** Which kind of performance source each vessel's section F values come from (workbook notes, DQ-006/013/015/016). */
export const PERFORMANCE_BASIS: Readonly<Record<string, BasisType>> = {
  DADD: "CONTRACTUAL", DGAZ: "SEA_TRIAL_MEASURED", DIMP: "SHOP_TEST", DANT: "SERIES_SPEC_CANDIDATE",
  DSUN: "HISTORICAL_SIR", DLEO: "HISTORICAL_SIR", DPUM: "UNSPECIFIED",
}

export const BASIS_LABEL: Readonly<Record<BasisType, string>> = {
  CONTRACTUAL: "Guaranteed (shipbuilding contract)", SEA_TRIAL_MEASURED: "Reference: sea-trial measured", SHOP_TEST: "Reference: shop test",
  SERIES_SPEC_CANDIDATE: "Reference: series specification (applicability unconfirmed)", HISTORICAL_SIR: "Reference: earlier inspection report",
  UNSPECIFIED: "Reference: basis not specified",
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const RANK: Record<Status, number> = { CONFLICT: 0, MISSING: 1, PROVISIONAL: 2, VERIFIED: 3 }
const atMost = (status: Status, cap: Status): Status => (RANK[status] > RANK[cap] ? cap : status)

export function validImo(value: string): boolean {
  if (!/^\d{7}$/.test(value)) return false
  const sum = [...value.slice(0, 6)].reduce((n, d, i) => n + Number(d) * (7 - i), 0)
  return sum % 10 === Number(value[6])
}

/** A cell as the field's type: numbers from number cells or numeric text (raw kept), text trimmed; blank is null. */
export function parseValue(cell: Cell, spec: FieldSpec): { value: string | number | null; raw?: Cell; error?: string } {
  if (cell === null) return { value: null }
  if (spec.type === "text") return { value: String(cell).trim() }
  const n = typeof cell === "number" ? cell : Number(String(cell).replace(/,/g, "").trim())
  if (!Number.isFinite(n)) return { value: null, raw: cell, error: `"${cell}" is not a number` }
  if (spec.type === "integer" && !Number.isInteger(n)) return { value: null, raw: cell, error: `"${cell}" is not a whole number` }
  return typeof cell === "number" ? { value: n } : { value: n, raw: cell }
}

const text = (cell: Cell) => (cell === null ? "" : String(cell).trim())
const statusOf = (cell: Cell): Status | null => {
  const s = text(cell).toUpperCase()
  return (["VERIFIED", "PROVISIONAL", "CONFLICT", "MISSING"] as const).find((x) => x === s) ?? null
}

/** The effect of a Data_Quality disposition while the item is open. */
export function dispositionEffect(disposition: string): "block" | "cap" | "allow" | "unknown" {
  const d = disposition.toUpperCase()
  if (d.includes("BLOCK VERIFIED")) return "cap"
  if (d.includes("BLOCK")) return "block"
  if (d.includes("ORANGE") || d.includes("PHYSICAL VERIF")) return "block"
  if (d.includes("PROVISIONAL") || d.includes("PARTIAL") || d.includes("LEAVE BLANK")) return "cap"
  if (d.includes("ALLOW")) return "allow"
  return "unknown"
}

const isOpen = (status: Cell) => !/^RESOLVED/i.test(text(status))

// ── Building the master records ─────────────────────────────────────────────

/** legacyNames: the vessel names NeraVeda already uses (FLEET_VESSELS / suite `vessels`), matched ignoring case. */
export function buildMaster(book: ParsedWorkbook, legacyNames: readonly string[]): BuildResult {
  const exceptions: ReviewException[] = []
  const rejected: Rejected[] = []

  // Identity checks: id format, name, IMO format and check digit, duplicates.
  const ids = new Map<string, number>()
  const imos = new Map<string, number>()
  for (const v of book.vessels) {
    ids.set(text(v.values["Vessel ID"]), (ids.get(text(v.values["Vessel ID"])) ?? 0) + 1)
    imos.set(text(v.values["IMO Number"]), (imos.get(text(v.values["IMO Number"])) ?? 0) + 1)
  }
  const accepted: VesselRow[] = []
  for (const v of book.vessels) {
    const id = text(v.values["Vessel ID"])
    const imo = text(v.values["IMO Number"])
    const reasons: string[] = []
    if (!/^[A-Z0-9]{2,12}$/.test(id)) reasons.push(`Vessel ID "${id}" is missing or not a short code`)
    else if ((ids.get(id) ?? 0) > 1) reasons.push(`Vessel ID ${id} appears more than once`)
    if (!text(v.values["Vessel Name"])) reasons.push("Vessel Name is blank")
    if (imo && !validImo(imo)) reasons.push(`IMO ${imo} is not a valid IMO number (7 digits with a check digit)`)
    else if (imo && (imos.get(imo) ?? 0) > 1) reasons.push(`IMO ${imo} appears more than once`)
    if (reasons.length) rejected.push({ row: v.row, workbookId: id || null, reasons })
    else accepted.push(v)
  }

  // Source_Register: which VERIFIED sources cover which fields, per vessel ("ALL" applies to every vessel).
  const sourcesFor = new Map<string, { id: string; fields: Set<string>; verified: boolean }[]>()
  for (const s of book.sources) {
    const id = text(s["Source ID"])
    const group = text(s["Field / Field Group"]).toLowerCase()
    const mapped = SOURCE_FIELD_GROUPS[group]
    if (!mapped) exceptions.push({ workbookId: text(s["Vessel ID"]) || null, text: `Source ${id}: "${s["Field / Field Group"]}" is not mapped to fields; it cannot verify any value.` })
    else if (mapped.unmapped) exceptions.push({ workbookId: text(s["Vessel ID"]) || null, text: `Source ${id}: "${mapped.unmapped}" is not mapped to a field.` })
    const entry = { id, fields: new Set(mapped?.fields ?? []), verified: statusOf(s["Verification Status"]) === "VERIFIED" && !mapped?.scope }
    const vessel = text(s["Vessel ID"])
    sourcesFor.set(vessel, [...(sourcesFor.get(vessel) ?? []), entry])
  }

  // Data_Quality: each open item's effect on its fields.
  type Effect = { issueId: string; effect: "block" | "cap" | "allow"; reason: string }
  const effects = new Map<string, Effect[]>() // key: `${vessel}|${field}`
  const add = (vessel: string, fields: readonly string[] | "*", e: Effect) => {
    for (const f of fields === "*" ? FIELDS.map((x) => x.key) : fields) effects.set(`${vessel}|${f}`, [...(effects.get(`${vessel}|${f}`) ?? []), e])
  }
  for (const issue of book.issues) {
    const issueId = text(issue["Issue ID"])
    const vessel = text(issue["Vessel ID"])
    const disposition = text(issue["Disposition for SIR Autofill"])
    const reason = `${issueId} (${text(issue["Issue Type"])}): ${text(issue["Field"])}; ${disposition}${issue["Notes"] ? `. ${text(issue["Notes"])}` : ""}`
    if (!isOpen(issue["Status"])) {
      add(vessel, ISSUE_FIELDS[issueId]?.fields ?? [], { issueId, effect: "allow", reason: `${reason} (${text(issue["Status"])})` })
      continue
    }
    let effect = dispositionEffect(disposition)
    if (effect === "unknown") {
      exceptions.push({ workbookId: vessel, text: `${issueId}: the disposition "${disposition}" is not recognised; treated as PROVISIONAL only.` })
      effect = "cap"
    }
    const scope = ISSUE_FIELDS[issueId]
    if (!scope || scope.vessel !== vessel) {
      // Not in the reviewed table (or changed since): find the field by its label, otherwise be cautious with the whole vessel.
      const byLabel = FIELDS.find((f) => [f.label, f.column].some((l) => l.toLowerCase() === text(issue["Field"]).toLowerCase()))
      exceptions.push({ workbookId: vessel, text: `${issueId} is not in the reviewed table; ${byLabel ? `applied to ${byLabel.label}` : "every field of the vessel kept at PROVISIONAL at most"}.` })
      add(vessel, byLabel ? [byLabel.key] : "*", { issueId, effect: byLabel ? effect : effect === "allow" ? "allow" : "cap", reason })
      continue
    }
    add(vessel, scope.fields, { issueId, effect, reason })
  }
  for (const hold of REVIEW_HOLDS) add(hold.vessel, hold.fields, { issueId: "PLAN", effect: hold.effect, reason: hold.reason })

  const physicalFor = new Map<string, Row[]>()
  for (const p of book.physical) physicalFor.set(text(p["Vessel ID"]), [...(physicalFor.get(text(p["Vessel ID"])) ?? []), p])

  const readme = book.readme.map((r) => r.text).join(" ")
  const legacyByName = new Map(legacyNames.map((n) => [n.toUpperCase(), n]))
  const matchedLegacy = new Set<string>()

  const vessels: MasterDraft[] = accepted.map((v) => {
    const id = text(v.values["Vessel ID"])
    const name = text(v.values["Vessel Name"])
    const legacy = legacyByName.get(name.toUpperCase())
    if (legacy) matchedLegacy.add(legacy)
    const groupStatus = Object.fromEntries((Object.keys(STATUS_COLUMNS) as StatusGroup[]).map((g) => {
      const s = statusOf(v.values[STATUS_COLUMNS[g]])
      if (!s && text(v.values[STATUS_COLUMNS[g]])) exceptions.push({ workbookId: id, text: `${STATUS_COLUMNS[g]} "${v.values[STATUS_COLUMNS[g]]}" is not a recognised status; treated as PROVISIONAL.` })
      return [g, s]
    })) as Record<StatusGroup, Status | null>
    for (const fill of v.otherFill) {
      exceptions.push({ workbookId: id, text: `${fill.column} is highlighted in a colour the README does not define (${fill.argb}); kept at PROVISIONAL and offered only.` })
    }
    const pv = physicalFor.get(id) ?? []
    const vesselSources = [...(sourcesFor.get(id) ?? []), ...(sourcesFor.get("ALL") ?? [])]

    const fields: Record<string, MasterField> = {}
    for (const spec of FIELDS) {
      const parsed = parseValue(v.values[spec.column] ?? null, spec)
      const covering = vesselSources.filter((s) => s.fields.has(spec.key))
      const field: MasterField = {
        value: parsed.value, unit: spec.unit, status: "PROVISIONAL", release: "fill", physicalVerification: false,
        reasons: [], sourceIds: covering.map((s) => s.id), issueIds: [],
        ...(parsed.raw !== undefined ? { raw: parsed.raw } : {}),
      }
      if (parsed.error) {
        field.status = "CONFLICT"
        field.release = "withhold"
        field.reasons.push(`The workbook value ${parsed.error}.`)
        fields[spec.key] = field
        continue
      }
      if (parsed.value === null) {
        field.status = "MISSING"
        field.release = spec.autofill === "MASTER_ONLY" ? "master-only" : "withhold"
        fields[spec.key] = field
        continue
      }
      const group = groupStatus[spec.statusGroup]
      let status: Status = group === "VERIFIED" && covering.some((s) => s.verified) ? "VERIFIED" : "PROVISIONAL"
      let withhold = false
      let offerOnly = false
      if (group === "VERIFIED" && status !== "VERIFIED") field.reasons.push(`${STATUS_COLUMNS[spec.statusGroup]} is VERIFIED, but no VERIFIED source in Source_Register covers this field.`)
      if (group === "CONFLICT") {
        offerOnly = true
        field.reasons.push(`${STATUS_COLUMNS[spec.statusGroup]} is CONFLICT: offered for confirmation, never filled automatically.`)
      }
      if (group === "MISSING") field.reasons.push(`${STATUS_COLUMNS[spec.statusGroup]} is MISSING although a value is present.`)
      if (v.otherFill.some((f) => f.column === spec.column)) offerOnly = true
      for (const e of [...(effects.get(`${id}|${spec.key}`) ?? []), ...(effects.get(`ALL|${spec.key}`) ?? [])]) {
        if (e.issueId !== "PLAN") field.issueIds.push(e.issueId)
        field.reasons.push(e.reason)
        if (e.effect === "block") withhold = true
        if (e.effect === "cap") status = atMost(status, "PROVISIONAL")
      }
      if (v.orange.includes(spec.column)) {
        field.physicalVerification = true
        status = atMost(status, "PROVISIONAL")
        withhold = true
        const rule = pv.map((p) => text(p["Release rule"])).filter(Boolean)
        field.reasons.push(`Physical verification required (orange cell)${rule.length ? `: ${rule.join(" ")}` : ""}`)
      }
      field.status = withhold ? "CONFLICT" : status
      field.release = spec.autofill === "MASTER_ONLY" ? "master-only"
        : withhold ? "withhold"
        : field.status === "VERIFIED" && !offerOnly ? "fill"
        : spec.autofill === "VERIFIED_OR_PROVISIONAL" && !offerOnly ? "fill"
        : "offer"
      fields[spec.key] = field
    }
    const hasPerformance = F_KEYS.some((k) => fields[k].value !== null)
    return {
      workbookId: id,
      name: legacy ?? name.toUpperCase(),
      aliases: [...new Set([name, legacy].filter(Boolean) as string[])],
      legacyKeys: legacy ? [legacy.replace(/\s+/g, "_")] : [],
      imo: text(v.values["IMO Number"]) || null,
      fleetGroup: text(v.values["Fleet Group"]) || null,
      activeStatus: text(v.values["Active Status"]) || "UNCONFIRMED",
      groupStatus,
      performanceBasis: hasPerformance ? PERFORMANCE_BASIS[id] ?? "UNSPECIFIED" : null,
      sourceNote: text(v.values["Primary Source Note"]) || null,
      fields,
    }
  })

  // Vessels NeraVeda already knows that the workbook does not list: kept as identity-only records, never deleted.
  for (const legacy of legacyNames) {
    if (matchedLegacy.has(legacy)) continue
    const word = legacy.replace(/^DHT\s+/i, "")
    const futureDelivery = new RegExp(`\\b${word}\\b[^.]*\\bexcluded as future deliver`, "i").test(readme) || new RegExp(`excluded[^.]*\\b${word}\\b`, "i").test(readme)
    exceptions.push({ workbookId: null, text: `${legacy} is in NeraVeda but not in the workbook; kept as an identity-only record${futureDelivery ? " (README: excluded as a future delivery)" : ""}.` })
    vessels.push({
      workbookId: null, name: legacy, aliases: [legacy], legacyKeys: [legacy.replace(/\s+/g, "_")], imo: null, fleetGroup: null,
      activeStatus: futureDelivery ? "NOT DELIVERED" : "UNCONFIRMED", groupStatus: { registry: null, technical: null, performance: null },
      performanceBasis: null, sourceNote: null,
      fields: Object.fromEntries(FIELDS.map((f) => [f.key, {
        value: f.key === "vessel_name" ? legacy : null, unit: f.unit, status: f.key === "vessel_name" ? "PROVISIONAL" : "MISSING",
        release: f.autofill === "MASTER_ONLY" ? "master-only" : f.key === "vessel_name" ? "fill" : "withhold", physicalVerification: false,
        reasons: f.key === "vessel_name" ? ["Name from NeraVeda's existing fleet list; not in the workbook."] : [], sourceIds: [], issueIds: [],
      } satisfies MasterField])),
    })
  }
  return { vessels, rejected, exceptions }
}

/** True when the value may be shown in a SIR without the Superintendent's confirmation. */
export const fills = (f: MasterField) => f.release === "fill" && f.value !== null
export { FIELD }
