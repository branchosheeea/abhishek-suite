// Vessel Master · what the SIR sees of a master record: the six groups (A-F) with each value, its unit, status and what
// a report may do with it (fill / offer / withhold). Master-only fields (statutory power, public fleet DWT) are left out.
// Pure (no I/O): used by the API, the review page and, in the report, the particulars.

import { FIELDS, PAIRED, SIR_GROUPS, type SirGroup, type Status } from "./fields"
import type { StoredVessel } from "./import"
import { BASIS_LABEL, type BasisType, type Release } from "./rules"

export type ViewField = {
  key: string
  label: string
  value: string | number | null
  unit: string | null
  /** The value as shown: thousands separators, unit appended ("299,629 MT"); "" when there is no value. */
  display: string
  status: Status
  release: Release
  physicalVerification: boolean
  reasons: string[]
  sourceIds: string[]
  issueIds: string[]
}
export type ViewGroup = { id: SirGroup; title: string; fields: ViewField[] }
export type VesselView = {
  vesselId: string
  name: string
  imo: string | null
  workbookId: string | null
  fleetGroup: string | null
  activeStatus: string
  revision: number
  updatedAt: string
  legacyKeys: string[]
  performanceBasis: BasisType | null
  /** Section F's basis, e.g. "Reference: shop test". "Guaranteed" only for a contractual basis. */
  basisLabel: string | null
  groups: ViewGroup[]
}
export type PickerEntry = Pick<VesselView, "vesselId" | "name" | "imo" | "workbookId" | "fleetGroup" | "activeStatus" | "revision"> & {
  /** Offered in a new report's vessel picker (not a name-only record, not a vessel still to be delivered). */
  selectable: boolean
}

const NO_GROUPING = new Set(["year_built"])

export function formatValue(key: string, value: string | number | null, unit?: string | null): string {
  if (value === null || value === "") return ""
  const text = typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 6, useGrouping: !NO_GROUPING.has(key) }) : value
  return unit ? `${text} ${unit}` : text
}

export const isSelectable = (v: Pick<StoredVessel, "workbookId" | "activeStatus">) => Boolean(v.workbookId) && v.activeStatus !== "NOT DELIVERED"

export function pickerEntry(v: StoredVessel): PickerEntry {
  return {
    vesselId: v.vesselId, name: v.name, imo: v.imo, workbookId: v.workbookId, fleetGroup: v.fleetGroup, activeStatus: v.activeStatus,
    revision: v.revision, selectable: isSelectable(v),
  }
}

export function vesselView(v: StoredVessel): VesselView {
  const field = (key: string): ViewField => {
    const spec = FIELDS.find((f) => f.key === key)!
    const f = v.fields[key]
    // The vessel name is NeraVeda's (upper case, as existing reports and fleet lists use it); the workbook spelling is an alias.
    const value = key === "vessel_name" && f?.value !== null && f?.value !== undefined ? v.name : (f?.value ?? null)
    const unit = spec.unit ?? null
    return {
      key, label: spec.label, value, unit, display: formatValue(key, value, unit),
      status: f?.status ?? "MISSING", release: f?.release ?? "withhold", physicalVerification: f?.physicalVerification ?? false,
      reasons: f?.reasons ?? [], sourceIds: f?.sourceIds ?? [], issueIds: f?.issueIds ?? [],
    }
  }
  const groups = SIR_GROUPS.map((g) => ({ id: g.id, title: g.title, fields: FIELDS.filter((f) => f.group === g.id).map((f) => field(f.key)) }))
  return {
    vesselId: v.vesselId, name: v.name, imo: v.imo, workbookId: v.workbookId, fleetGroup: v.fleetGroup, activeStatus: v.activeStatus,
    revision: v.revision, updatedAt: v.updatedAt, legacyKeys: v.legacyKeys, performanceBasis: v.performanceBasis,
    basisLabel: basisLabel(v.performanceBasis, groups.find((g) => g.id === "F")!.fields),
    groups,
  }
}

/** "Guaranteed" only for a contractual basis whose values are VERIFIED. A contractual document not yet verified for this
 *  vessel (e.g. a specification whose hull number differs) is a reference, so no report calls it a guarantee. */
function basisLabel(basis: BasisType | null, performance: ViewField[]): string | null {
  if (!basis) return null
  const withValue = performance.filter((f) => f.value !== null)
  if (basis === "CONTRACTUAL" && !(withValue.length && withValue.every((f) => f.status === "VERIFIED"))) {
    return "Reference: shipbuilding specification (not yet verified for this vessel)"
  }
  return BASIS_LABEL[basis]
}

/** A paired value as one phrase: "18,350 kW @ 62 rpm", "52.68 MT/day @ 14 kn"; the main value alone when its pair is blank. */
export function pairedDisplay(view: VesselView, key: string): string {
  const fields = view.groups.flatMap((g) => g.fields)
  const main = fields.find((f) => f.key === key)
  const pair = PAIRED[key] ? fields.find((f) => f.key === PAIRED[key]) : undefined
  if (!main?.display) return ""
  return pair?.display ? `${main.display} @ ${pair.display}` : main.display
}

/** What the SIR does with a field, in words for the Superintendent. */
export const RELEASE_LABEL: Readonly<Record<Release, string>> = {
  fill: "Filled in", offer: "Offered (confirm to use)", withhold: "Not released", "master-only": "Master only",
}
