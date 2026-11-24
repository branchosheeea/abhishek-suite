// Principal Particulars, two versions:
//   v1  reports made before the Vessel Master (no vesselSnapshot): the earlier four groups, typed by hand, unchanged.
//   v2  new reports: the six Vessel Master groups (A-F). Choosing the vessel captures a snapshot of the master and fills
//       the values the rules release ("fill"); "offer" values wait for the Superintendent's "Use this value"; values in
//       conflict, awaiting physical verification or missing stay empty with the reason shown. Anything the
//       Superintendent types is kept and recorded as theirs. A later master change never alters a report; only
//       "Refresh from Vessel Master" does, after a field-by-field comparison is confirmed.
// Pure: used by the editor, the PDF, completeness and tests.

import {
  PARTICULARS_GROUPS,
  emptyVesselSnapshot,
  type FieldDef,
  type Report,
  type SnapshotField,
  type VesselSnapshot,
} from "./form-schema"
import { PARTICULARS_GROUPS_V2, V2_KEYS, WIDE_KEYS } from "./particulars-groups"
import { FIELDS, PAIRED, SIR_GROUPS } from "./vessel-master/fields"
import { formatValue, type VesselView } from "./vessel-master/view"
import { vesselIdFor } from "./vessels"

export { PARTICULARS_GROUPS_V2, V2_KEYS }
const LABEL = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]))

export const isV2 = (report: Pick<Report, "vesselSnapshot">) => Boolean(report.vesselSnapshot)
export const particularsGroups = (report: Pick<Report, "vesselSnapshot">) => (isV2(report) ? PARTICULARS_GROUPS_V2 : PARTICULARS_GROUPS)
/** The particulars key holding the vessel name (linked to Vessel in Inspection Details). */
export const nameKey = (report: Pick<Report, "vesselSnapshot">) => (isV2(report) ? "vessel_name" : "shipName")
/** Linked to a Vessel Master record (its particulars come from the master, its name is chosen, not typed). */
export const fromMaster = (s: VesselSnapshot | undefined) => Boolean(s?.vesselId) && s!.source !== "not-in-master"

// ── Capturing a vessel ───────────────────────────────────────────────────────

export function snapshotFields(view: VesselView): Record<string, SnapshotField> {
  return Object.fromEntries(view.groups.flatMap((g) => g.fields).map((f) => [f.key, {
    value: formatValue(f.key, f.value, null), status: f.status, release: f.release, reasons: f.reasons, physicalVerification: f.physicalVerification,
  }]))
}

const released = (f: SnapshotField | undefined) => Boolean(f && f.release === "fill" && f.value)

export type Capture =
  | { kind: "view"; view: VesselView; source: "master" | "offline-cache"; fetchedAt: string; legacyKey?: string }
  | { kind: "pending"; vesselId: string; name: string; imo: string | null; legacyKey?: string }

/**
 * Choose a Vessel Master vessel. The particulars are replaced by what the master releases; with `keepEntered`
 * (a pending snapshot being completed) values the Superintendent already typed are kept.
 */
export function selectVessel(report: Report, capture: Capture, by: string, now: string, keepEntered = false): Report {
  const previous = report.vesselSnapshot ?? emptyVesselSnapshot()
  const base: VesselSnapshot = { ...emptyVesselSnapshot(), history: previous.history }
  let snapshot: VesselSnapshot
  let name: string
  if (capture.kind === "view") {
    const { view } = capture
    name = view.name
    snapshot = {
      ...base, source: capture.source, vesselId: view.vesselId, name, imo: view.imo, masterRevision: view.revision, capturedAt: now,
      fetchedAt: capture.fetchedAt, basisLabel: view.basisLabel, fields: snapshotFields(view),
    }
  } else {
    name = capture.name
    snapshot = { ...base, source: "pending", vesselId: capture.vesselId, name, imo: capture.imo, capturedAt: now }
  }
  const particulars: Record<string, string> = {}
  for (const key of V2_KEYS) {
    const kept = keepEntered ? report.particulars[key] : undefined
    if (kept && kept.trim()) {
      particulars[key] = kept
      const entered = previous.entered[key]
      if (entered && kept !== snapshot.fields[key]?.value) snapshot.entered[key] = entered
      continue
    }
    if (released(snapshot.fields[key])) particulars[key] = snapshot.fields[key].value
  }
  particulars.vessel_name = name
  const action = keepEntered ? "resolved" : "select"
  snapshot.history = [...snapshot.history, { at: now, by, action, masterRevision: snapshot.masterRevision, changed: [] }]
  const legacyKey = capture.legacyKey ?? vesselIdFor(name)
  return { ...report, details: { ...report.details, vessel: name, vesselId: legacyKey }, particulars, vesselSnapshot: snapshot }
}

/** A vessel the Vessel Master does not hold: the name as typed, particulars entered by hand. */
export function selectOtherVessel(report: Report, name: string, by: string, now: string): Report {
  const previous = report.vesselSnapshot ?? emptyVesselSnapshot()
  const wasMaster = fromMaster(previous)
  const snapshot: VesselSnapshot = {
    ...emptyVesselSnapshot(), source: "not-in-master", name,
    history: wasMaster || previous.source !== "not-in-master" ? [...previous.history, { at: now, by, action: "other-vessel", masterRevision: null, changed: [] }] : previous.history,
  }
  // Values that came from another vessel's master record are not this vessel's: start from blank.
  const particulars = wasMaster ? {} : { ...report.particulars }
  particulars.vessel_name = name
  return { ...report, details: { ...report.details, vessel: name, vesselId: vesselIdFor(name) }, particulars, vesselSnapshot: snapshot }
}

// ── Editing ─────────────────────────────────────────────────────────────────

export type Origin = "master" | "confirmed" | "entered" | "empty"

/** Where the report's value comes from: the master (filled), an offered value the Superintendent chose, their own entry. */
export function originOf(report: Report, key: string): Origin {
  const value = report.particulars[key]?.trim() ?? ""
  const s = report.vesselSnapshot
  if (!value) return "empty"
  if (!s) return "entered"
  const m = s.fields[key]
  if (m && m.release === "fill" && m.value === value) return "master"
  if (s.confirmed[key]?.value === value) return "confirmed"
  return "entered"
}

/** Mandatory fields whose entered value the master does not hold get a correction flag for the office (once). */
const flagsWhenEntered = (key: string) => FIELDS.some((f) => f.key === key && f.required) && key !== "vessel_name"

export function setParticular(report: Report, key: string, value: string, by: string, now: string): Report {
  const s = report.vesselSnapshot
  const particulars = { ...report.particulars, [key]: value }
  if (!s) return { ...report, particulars }
  const entered = { ...s.entered }
  const confirmed = { ...s.confirmed }
  if (confirmed[key] && confirmed[key].value !== value) delete confirmed[key]
  const next = { ...report, particulars, vesselSnapshot: { ...s, confirmed, entered } }
  if (originOf(next, key) === "entered") {
    const before = s.entered[key]
    const flag = fromMaster(s) && flagsWhenEntered(key) ? (before?.flag ?? "pending") : undefined
    entered[key] = { by, at: now, ...(flag ? { flag } : {}), ...(before?.flagId ? { flagId: before.flagId } : {}) }
  } else {
    delete entered[key]
  }
  if (key === "vessel_name" && !fromMaster(s)) {
    return { ...next, details: { ...report.details, vessel: value, vesselId: vesselIdFor(value) }, vesselSnapshot: { ...next.vesselSnapshot!, name: value } }
  }
  return next
}

/** "Use this value": an offered (provisional) master value, used with the Superintendent's confirmation. */
export function confirmOffer(report: Report, key: string, by: string, now: string): Report {
  const s = report.vesselSnapshot
  const m = s?.fields[key]
  if (!s || !m?.value || m.release !== "offer") return report
  const entered = { ...s.entered }
  delete entered[key]
  return {
    ...report, particulars: { ...report.particulars, [key]: m.value },
    vesselSnapshot: { ...s, confirmed: { ...s.confirmed, [key]: { value: m.value, by, at: now } }, entered },
  }
}

/** Entered values whose automatic correction flag still has to be sent. */
export const pendingFlags = (report: Report) =>
  Object.entries(report.vesselSnapshot?.entered ?? {}).filter(([key, e]) => e.flag === "pending" && report.particulars[key]?.trim()).map(([key]) => key)

export function markFlagSent(report: Report, key: string, flagId: string): Report {
  const s = report.vesselSnapshot
  if (!s?.entered[key]) return report
  return { ...report, vesselSnapshot: { ...s, entered: { ...s.entered, [key]: { ...s.entered[key], flag: "sent", flagId } } } }
}

// ── Refresh from the Vessel Master ───────────────────────────────────────────

export type RefreshRow = {
  key: string
  label: string
  before: SnapshotField | null
  after: SnapshotField
  reportValue: string
  /** What happens to the report's value: the master's new value, kept (the Superintendent's own), or cleared. */
  outcome: "updated" | "kept" | "cleared" | "unchanged"
}

/** Field-by-field comparison of the report's snapshot with the master now. Only fields that differ are listed. */
export function refreshPlan(report: Report, view: VesselView): RefreshRow[] {
  const s = report.vesselSnapshot
  if (!s) return []
  const after = snapshotFields(view)
  const rows: RefreshRow[] = []
  for (const key of V2_KEYS) {
    const before = s.fields[key] ?? null
    const next = after[key]
    if (!next) continue
    if (before && before.value === next.value && before.status === next.status && before.release === next.release) continue
    const origin = originOf(report, key)
    const fromTheMaster = origin === "master" || origin === "confirmed" || origin === "empty"
    const nextValue = released(next) ? next.value : ""
    const reportValue = report.particulars[key] ?? ""
    const outcome: RefreshRow["outcome"] = key === "vessel_name" || !fromTheMaster ? "kept" : nextValue === reportValue ? "unchanged" : nextValue ? "updated" : "cleared"
    rows.push({ key, label: LABEL[key] ?? key, before, after: next, reportValue, outcome })
  }
  return rows
}

export function applyRefresh(report: Report, view: VesselView, source: "master" | "offline-cache", fetchedAt: string, by: string, now: string): Report {
  const s = report.vesselSnapshot
  if (!s) return report
  const plan = refreshPlan(report, view)
  const particulars = { ...report.particulars }
  const confirmed = { ...s.confirmed }
  for (const row of plan) {
    if (row.outcome === "updated") particulars[row.key] = row.after.value
    if (row.outcome === "cleared") particulars[row.key] = ""
    if (row.outcome !== "kept") delete confirmed[row.key]
  }
  return {
    ...report, particulars,
    vesselSnapshot: {
      ...s, source, imo: view.imo, masterRevision: view.revision, capturedAt: now, fetchedAt, basisLabel: view.basisLabel,
      fields: snapshotFields(view), confirmed,
      history: [...s.history, { at: now, by, action: "refresh", masterRevision: view.revision, changed: plan.map((r) => r.key) }],
    },
  }
}

// ── Completeness, PDF, copy-forward ──────────────────────────────────────────

/** Particulars items still needed before approval (mandatory fields of the report's version; a pending snapshot). */
export function particularsOutstanding(report: Report): string[] {
  const out = particularsGroups(report).flatMap((g) => g.fields).filter((f) => f.required && !report.particulars?.[f.key]?.trim()).map((f) => f.label)
  if (report.vesselSnapshot?.source === "pending") out.push("Vessel particulars from the Vessel Master (open the report once while online)")
  return out
}

/** Rows for the PDF: v1 exactly as before; v2 with units and paired values as one phrase ("18,350 kW @ 62 rpm"). */
export function particularsForPdf(report: Report): { title: string; fields: FieldDef[]; values: Record<string, string> }[] {
  if (!isV2(report)) return PARTICULARS_GROUPS.map((g) => ({ title: g.title ?? "", fields: g.fields, values: report.particulars }))
  const values = report.particulars
  const paired = new Set(Object.values(PAIRED))
  const withUnit = (key: string) => {
    const v = values[key]?.trim()
    const unit = FIELDS.find((f) => f.key === key)?.unit
    return v ? (unit ? `${v} ${unit}` : v) : ""
  }
  return PARTICULARS_GROUPS_V2.map((g, i) => {
    const out: Record<string, string> = {}
    const fields: FieldDef[] = []
    for (const f of g.fields) {
      if (paired.has(f.key)) continue
      const pair = PAIRED[f.key]
      const main = withUnit(f.key)
      const second = pair ? withUnit(pair) : ""
      out[f.key] = main && second ? `${main} @ ${second}` : main || (second ? `@ ${second}` : "")
      fields.push({ key: f.key, label: LABEL[f.key] ?? f.label, type: WIDE_KEYS.has(f.key) && f.key !== "main_engine" ? "textarea" : undefined })
    }
    const basis = SIR_GROUPS[i].id === "F" && report.vesselSnapshot?.basisLabel ? ` (${report.vesselSnapshot.basisLabel})` : ""
    return { title: `${g.title}${basis}`, fields, values: out }
  })
}

/** Earlier (v1) particulars moved to the six-group keys, for "New inspection for this vessel" of a vessel not in the master. */
const V1_TO_V2: Record<string, string> = {
  shipName: "vessel_name", imo: "imo", flag: "flag", portOfRegistry: "port_of_registry", officialNo: "official_number", callSign: "call_sign",
  hullNo: "hull_number", yearBuilt: "year_built", builder: "builder", shipType: "vessel_type", owners: "registered_owner",
  managers: "technical_manager", classification: "class_society", classNotation: "class_notation", loa: "loa_m", breadth: "breadth_moulded_m",
  depth: "depth_moulded_m", draft: "summer_draft_m", deadweight: "summer_dwt_mt", lightweight: "lightweight_mt", grossTonnage: "gross_tonnage",
  netTonnage: "net_tonnage",
}
export function v1ToV2(particulars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(V1_TO_V2).filter(([from]) => particulars[from]?.trim()).map(([from, to]) => [to, particulars[from]]))
}

/** Particulars or other content that choosing another vessel would affect (asks for confirmation first). */
export function hasReportContent(report: Report): boolean {
  const any = (o: object | undefined) => Object.values(o ?? {}).some((v) => (typeof v === "string" ? v.trim() : v && typeof v === "object" ? Object.keys(v).length : Boolean(v)))
  const entered = Object.keys(report.vesselSnapshot?.entered ?? {}).length > 0
  return entered || any(report.summary) || any(report.deck) || any(report.engine) || any(report.management) || any(report.narratives)
}
