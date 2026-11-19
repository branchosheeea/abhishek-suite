// DNV error correlation. Associates DNV Emissions Connect errors/warnings (entered or imported by the user) with
// the independent findings. The classifications are kept distinct and are never merged:
//   DNV Reported            the item exists in the supplied DNV results (always true for a DNV item)
//   Independently Reproduced an independent rule shows a discrepancy of the same kind in the same window
//   Not Reproduced          the relevant rules ran over the window and found no such discrepancy
//   Unresolved              the relevant rules could not run (missing data / no rule / no AIS data)
//   Possible Cause          hypotheses attached from related findings; never a confirmation
// DNV's own validation logic is proprietary and not documented here; "Not Reproduced" means only that the
// independent calculation, under its stated assumptions, does not show the discrepancy.

import { parseDec } from "./decimal"
import type { FuelAnalysis } from "./rules/fuel"
import type { Finding, RuleCoverage } from "./types"

export type DnvCategory =
  | "BOY_ROB" | "FUEL_AVAILABLE" | "PORT_CODE" | "CARGO" | "ARRIVAL_DEPARTURE" | "SEA_PASSAGE"
  | "DURATION" | "MANEUVERING_IN_PORT" | "CONSUMPTION_DEVIATION" | "CII_BOILER"
  | "DISTANCE" | "POSITION" | "AIS" | "OTHER"

/**
 * scope "record": DNV points at one event report; findings of comparable span near it are related.
 * scope "segment": DNV points at a voyage or port stay; a finding spanning that segment is related when it
 * contains the DNV event time (±24 h).
 */
export type DnvCategoryDef = Readonly<{ label: string; rules: readonly string[]; scope: "record" | "segment" }>

/** Labels follow the check names shown in OVD Admin, so an item can be entered as it appears there. */
export const DNV_CATEGORIES: Readonly<Record<DnvCategory, DnvCategoryDef>> = {
  BOY_ROB: { label: "ROBs reported (beginning of year)", rules: ["D01"], scope: "record" },
  FUEL_AVAILABLE: { label: "Reported ROB vs. available fuel", rules: ["D04", "D02", "D06"], scope: "segment" },
  PORT_CODE: { label: "Port code consistency", rules: ["C01", "C07", "C04", "C05", "C08", "C02"], scope: "record" },
  CARGO: { label: "Cargo consistency", rules: ["E01"], scope: "record" },
  ARRIVAL_DEPARTURE: { label: "Arrival / departure consistency", rules: ["C03", "C01", "C07", "C09", "B01", "B02"], scope: "record" },
  SEA_PASSAGE: { label: "Sea passage consistency", rules: ["C09", "C03"], scope: "record" },
  DURATION: { label: "Duration vs. reporting times", rules: ["F01", "B01"], scope: "record" },
  MANEUVERING_IN_PORT: { label: "Maneuvering in port", rules: ["G05"], scope: "record" },
  CONSUMPTION_DEVIATION: { label: "Consumption deviation (voyage / port stay)", rules: ["D09"], scope: "segment" },
  CII_BOILER: { label: "CII: FC boiler (consumption)", rules: ["D10", "D08"], scope: "record" },
  DISTANCE: { label: "Distance deviation (per voyage)", rules: ["G06", "G01", "G02"], scope: "segment" },
  POSITION: { label: "Reported-position inconsistency", rules: ["G03", "G04"], scope: "record" },
  AIS: { label: "AIS-related warning", rules: [], scope: "record" },
  OTHER: { label: "Other", rules: [], scope: "record" },
}

export type DnvFinding = Readonly<{
  id: string
  category: DnvCategory
  severity: "error" | "warning"
  description: string
  imo: string | null
  /** UTC window of the events DNV refers to (ISO 8601). Either may be null. */
  fromUtc: string | null
  toUtc: string | null
  /** UTC time of the event report DNV lists (OVD Admin's date/time column). Preferred over from/to when given. */
  eventUtc?: string | null
  voyageOrPortStay: string | null
  portCodes: readonly string[]
  fuel: string | null
  /** Quantity as DNV states it, as a decimal string; never used to change a source value. */
  quantity: string | null
  entryMethod: "manual" | "import" | "screenshot"
  /** The user confirmed the entry matches DNV's own result (required for screenshot transcriptions). */
  confirmed: boolean
  /** For an entry read from a screenshot: the image's SHA-256, its file name and the local reader used. */
  evidence?: Readonly<{ sha256: string; name: string | null; reader: string }> | null
}>

export type CorrelationOutcome = "independently-reproduced" | "not-reproduced" | "unresolved"

export const OUTCOME_LABEL: Record<CorrelationOutcome, string> = {
  "independently-reproduced": "Independently Reproduced",
  "not-reproduced": "Not Reproduced",
  unresolved: "Unresolved",
}

export type Correlation = Readonly<{
  dnvId: string
  dnvReported: true
  evidenceConfirmed: boolean
  outcome: CorrelationOutcome
  explanation: string
  rulesConsidered: readonly string[]
  matchedFindings: readonly string[]
  possibleCauses: readonly string[]
  relatedDnvIds: readonly string[]
}>

const MARGIN_MS = 24 * 3_600_000
const DAY_MS = 24 * 3_600_000

/** Longest finding window accepted for a voyage / port-stay item anchored on one event time. */
const SEGMENT_MAX_MS = 60 * DAY_MS

type Window = { fromMs: number; toMs: number; spanMs: number; eventMs: number | null }

function windowOf(d: DnvFinding): Window | null {
  const e = d.eventUtc ? Date.parse(d.eventUtc) : NaN
  if (!Number.isNaN(e)) return { fromMs: e - MARGIN_MS, toMs: e + MARGIN_MS, spanMs: 0, eventMs: e }
  const a = d.fromUtc ? Date.parse(d.fromUtc) : NaN
  const b = d.toUtc ? Date.parse(d.toUtc) : NaN
  if (Number.isNaN(a) && Number.isNaN(b)) return null
  const from = Number.isNaN(a) ? b : a
  const to = Number.isNaN(b) ? a : b
  return { fromMs: Math.min(from, to) - MARGIN_MS, toMs: Math.max(from, to) + MARGIN_MS, spanMs: Math.abs(to - from), eventMs: null }
}

/**
 * A finding relates to a DNV item when its window overlaps the DNV window (±24 h) AND is of comparable scope:
 * no longer than twice the DNV window or 4 days, whichever is larger. This keeps a period-wide balance from
 * "matching" a single port stay, and a timestamp error spanning years from matching everything.
 * A voyage / port-stay item anchored on one event time instead relates to a finding whose window contains that
 * time (±24 h) and spans at most 60 days — one segment, not the whole period.
 */
function overlaps(f: Finding, w: Window | null, scope: DnvCategoryDef["scope"]): boolean {
  if (!w) return true
  if (!f.window) return false
  const span = f.window.toMs - f.window.fromMs
  if (w.eventMs !== null && scope === "segment") return f.window.fromMs <= w.toMs && f.window.toMs >= w.fromMs && span <= SEGMENT_MAX_MS
  return f.window.fromMs <= w.toMs && f.window.toMs >= w.fromMs && span <= Math.max(2 * w.spanMs, 4 * DAY_MS)
}

export function correlate(
  dnv: readonly DnvFinding[],
  findings: readonly Finding[],
  coverage: readonly RuleCoverage[],
  fuel: readonly FuelAnalysis[],
  context: Readonly<{ bunkerReportSupplied: boolean }> = { bunkerReportSupplied: true },
): Correlation[] {
  const coverageOf = new Map(coverage.map((c) => [c.ruleId, c]))
  const results = dnv.map((d): Correlation => {
    const category = DNV_CATEGORIES[d.category]
    const rules = category.rules
    const w = windowOf(d)
    const base = { dnvId: d.id, dnvReported: true as const, evidenceConfirmed: d.confirmed, rulesConsidered: rules, relatedDnvIds: [] as string[] }
    const unconfirmed = d.confirmed ? "" : " The DNV entry has not been confirmed by the user, so it is not yet verified DNV evidence."
    if (rules.length === 0) {
      return {
        ...base, outcome: "unresolved", matchedFindings: [], possibleCauses: [],
        explanation: (d.category === "AIS" ? "No AIS dataset is available, so AIS-based warnings cannot be checked independently." : "No independent rule covers this category.") + unconfirmed,
      }
    }
    const fuelCode = d.fuel ? d.fuel.trim().toUpperCase() : null
    const matched = findings.filter((f) => rules.includes(f.ruleId) && overlaps(f, w, category.scope) && (!fuelCode || !f.fuel || f.fuel === fuelCode))
    const causes = [...new Set(matched.flatMap((f) => f.possibleCauses ?? []))]
    const hypotheses = findings.filter((f) => f.evidence === "hypothesis" && overlaps(f, w, category.scope) && (!fuelCode || !f.fuel || f.fuel === fuelCode))
    const where = !w ? "" : w.eventMs !== null ? (category.scope === "segment" ? " around the DNV event time (the voyage / port stay containing it, ±24 h)" : " within ±24 h of the DNV event time") : " in the DNV window (±24 h)"
    for (const h of hypotheses) causes.push(h.title)
    // DNV's "available fuel" includes bunkering, de-bunkering and mixing from the Bunker Report. Without it the
    // independent residuals cannot separate a transaction from a reporting discrepancy.
    if (d.category === "FUEL_AVAILABLE" && !context.bunkerReportSupplied) {
      return {
        ...base, outcome: "unresolved", matchedFindings: matched.map((f) => f.id), possibleCauses: [...new Set(causes)],
        explanation: `${matched.length ? `${matched.length} independent fuel-balance finding(s) fall${where || " in the DNV window"}, but` : `No independent residual falls${where || " in the DNV window"}, and`} no Bunker Report was supplied, so bunkering, de-bunkering or fuel mixing cannot be separated from a reporting discrepancy. Supply the Bunker Report to reproduce or rule out this item.${unconfirmed}`,
      }
    }
    if (matched.length) {
      const quantityNote = d.quantity && parseDec(d.quantity) === null ? " DNV's quantity is not a plain number and was not compared." : ""
      return {
        ...base, outcome: "independently-reproduced", matchedFindings: matched.map((f) => f.id), possibleCauses: [...new Set(causes)],
        explanation: `${matched.length} independent finding(s) of rule(s) ${[...new Set(matched.map((f) => f.ruleId))].join(", ")} ${w ? `fall${where}` : "match this category (no DNV time given)"}${fuelCode ? ` for ${fuelCode}` : ""}.${quantityNote}${unconfirmed}`,
      }
    }
    const ran = rules.filter((r) => {
      const c = coverageOf.get(r)
      return c && c.status !== "not-executable" && c.evaluated > 0
    })
    if (ran.length === 0) {
      const reasons = rules.map((r) => `${r}: ${coverageOf.get(r)?.reason ?? "not run"}`).join("; ")
      return { ...base, outcome: "unresolved", matchedFindings: [], possibleCauses: [...new Set(causes)], explanation: `The relevant rules could not run (${reasons}).${unconfirmed}` }
    }
    // Fuel balance: if no step in the window could be calculated, the absence of a finding proves nothing.
    if (d.category === "FUEL_AVAILABLE") {
      const inWindow = fuel
        .flatMap((a) => a.steps)
        .filter((s) => (!fuelCode || s.fuel === fuelCode) && (!w || (s.window !== undefined && s.window.fromMs <= w.toMs && s.window.toMs >= w.fromMs)))
      if (inWindow.length === 0 || inWindow.every((s) => s.status === "not-computable")) {
        return {
          ...base, outcome: "unresolved", matchedFindings: [], possibleCauses: [...new Set(causes)],
          explanation: `${inWindow.length === 0 ? "No" : "No computable"} ${fuelCode ?? "fuel"} balance step falls in the DNV window, so the balance could not be checked (blank/invalid ROB or consumption, or uninterpretable timestamps).${unconfirmed}`,
        }
      }
    }
    return {
      ...base, outcome: "not-reproduced", matchedFindings: [], possibleCauses: [...new Set(causes)],
      explanation: `Rule(s) ${ran.join(", ")} ran and show no matching discrepancy${where} under their stated assumptions and screening thresholds. DNV's validation logic is not documented here and may differ.${unconfirmed}`,
    }
  })
  // Related DNV items: their reproducing findings share a source record.
  const refsOf = new Map<string, Set<string>>()
  const byId = new Map(findings.map((f) => [f.id, f]))
  for (const r of results) {
    const set = new Set<string>()
    for (const id of r.matchedFindings) for (const ref of byId.get(id)?.refs ?? []) set.add(`${ref.sha256}:${ref.line}`)
    refsOf.set(r.dnvId, set)
  }
  return results.map((r) => {
    const mine = refsOf.get(r.dnvId)!
    const related = results.filter((o) => o.dnvId !== r.dnvId && [...refsOf.get(o.dnvId)!].some((k) => mine.has(k))).map((o) => o.dnvId)
    return related.length ? { ...r, relatedDnvIds: related } : r
  })
}
