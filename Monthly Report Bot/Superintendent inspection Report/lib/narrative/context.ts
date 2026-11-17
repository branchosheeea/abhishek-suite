// Facts the Executive Summary can take from other parts of the same report, so the Superintendent never records
// them twice and the summary cannot contradict the detailed sections without a warning.

import {
  CONDITION_SECTIONS,
  CRITICAL_EQUIPMENT_ITEMS,
  DECK_ITEMS,
  ENGINE_ITEMS,
  effectiveRating,
  isCriticalTested,
  type ConditionEntry,
  type Rating,
  type Report,
} from "../form-schema"
import { normalisePreambleInputs, type PreambleInputs } from "./preamble/model"

export type RatedItem = { key: string; label: string; area: "deck" | "engine"; section: string; rating: Rating }

export type ReportContext = {
  vesselName: string
  startDate: string
  endDate: string
  /** Preamble selections (inspection type, vessel status, operating conditions…). */
  preamble: PreambleInputs
  /** Every condition item of the Vessel Condition Report with its rating ("" when not rated yet; earlier "good" reads as "satisfactory"). */
  items: RatedItem[]
  /** Critical-equipment tests carried out, and those with a defect recorded. */
  critical: { tested: string[]; defects: string[]; total: number }
  /** Whole years since the year of build (Principal Particulars), at the attendance start; null when unknown. */
  vesselAge: number | null
}

function ageAt(yearBuilt: string | undefined, startDate: string) {
  const built = Number((yearBuilt ?? "").match(/\b(19|20)\d{2}\b/)?.[0])
  const year = Number(startDate.slice(0, 4)) || new Date().getFullYear()
  return built && year >= built ? year - built : null
}

const SECTION_OF: Record<string, string> = Object.fromEntries(
  CONDITION_SECTIONS.flatMap((section) => section.items.map((item) => [`${section.source}:${item.key}`, section.title])),
)

export function buildReportContext(report: Report): ReportContext {
  const rated = (area: "deck" | "engine", items: { key: string; label: string }[], values: Record<string, ConditionEntry>) =>
    items.map((item) => ({
      key: item.key,
      label: item.label,
      area,
      section: SECTION_OF[`${area}:${item.key}`] ?? (area === "deck" ? "Deck" : "Engine Room"),
      rating: effectiveRating(values?.[item.key]?.rating),
    }))
  const items = [...rated("deck", DECK_ITEMS, report.deck ?? {}), ...rated("engine", ENGINE_ITEMS, report.engine ?? {})]
  const results = report.criticalResults ?? {}
  const tested = CRITICAL_EQUIPMENT_ITEMS.filter((item) => isCriticalTested(item, report.management) || results[item.key]?.result).map((item) => item.label)
  const defects = CRITICAL_EQUIPMENT_ITEMS.filter((item) => results[item.key]?.result === "defect").map((item) => item.label)
  return {
    vesselName: report.details?.vessel ?? "",
    startDate: report.details?.dateFrom ?? "",
    endDate: report.details?.dateTo ?? "",
    preamble: normalisePreambleInputs(report.narratives?.preamble?.inputs, { port: report.details?.port }),
    items,
    critical: { tested, defects, total: CRITICAL_EQUIPMENT_ITEMS.length },
    vesselAge: ageAt(report.particulars?.yearBuilt, report.details?.dateFrom ?? ""),
  }
}

/** A context with nothing recorded yet; used by tests and as a safe fallback. */
export function emptyReportContext(patch: Partial<ReportContext> = {}): ReportContext {
  return {
    vesselName: "",
    startDate: "",
    endDate: "",
    preamble: normalisePreambleInputs(undefined),
    items: [...DECK_ITEMS.map((i) => ({ ...i, area: "deck" as const, section: SECTION_OF[`deck:${i.key}`] ?? "Deck", rating: "" as Rating })),
      ...ENGINE_ITEMS.map((i) => ({ key: i.key, label: i.label, area: "engine" as const, section: "Engine Room", rating: "" as Rating }))],
    critical: { tested: [], defects: [], total: CRITICAL_EQUIPMENT_ITEMS.length },
    vesselAge: null,
    ...patch,
  }
}

export const ratedAs = (ctx: ReportContext, rating: Rating, keys?: string[]) =>
  ctx.items.filter((item) => item.rating === rating && (!keys || keys.includes(item.key)))
