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
import { normalisePreambleInputs, pruneHidden, type PreambleInputs } from "./preamble/model"
import { DRY_DOCK_STATUSES, SAILING_STATUSES } from "./preamble/options"

export type VesselCondition = { loading: "LADEN" | "BALLAST" | ""; situation: "SEA" | "PORT" | "DRY_DOCK" | "" }

const PORT_STATUSES = ["ALONGSIDE", "AT_ANCHORAGE", "CARGO_OPERATIONS", "BUNKERING_OPERATIONS"]

/** Laden / ballast and sea / port / dry-dock from the Preamble selections. */
export function vesselConditionFrom(raw: PreambleInputs): VesselCondition {
  // Only what the Preamble actually shows counts (a hidden, stale laden/ballast answer is ignored).
  const p = pruneHidden(raw)
  const status = p.vesselStatus
  const loading =
    status === "LADEN_PASSAGE" || p.loadingCondition === "LADEN" || p.operatingCondition === "LADEN_SEAGOING"
      ? "LADEN"
      : status === "BALLAST_PASSAGE" || p.loadingCondition === "BALLAST" || p.operatingCondition === "BALLAST_SEAGOING"
        ? "BALLAST"
        : ""
  const situation =
    status && (DRY_DOCK_STATUSES as readonly string[]).includes(status)
      ? "DRY_DOCK"
      : (status && ((SAILING_STATUSES as readonly string[]).includes(status) || status === "MAIDEN_VOYAGE")) || p.locationType === "AT_SEA"
        ? "SEA"
        : status && PORT_STATUSES.includes(status)
          ? "PORT"
          : ""
  return { loading, situation }
}

export const LOADING_WORDS = { LADEN: "laden", BALLAST: "ballast" } as const
export const SITUATION_WORDS = { SEA: "at sea", PORT: "in port", DRY_DOCK: "in dry-dock" } as const

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
  /**
   * The vessel's condition during the attendance, stated once in the Preamble and carried through the whole report:
   * laden or ballast, and whether she was at sea, in port or in dry-dock ("" when the Preamble does not say).
   */
  vesselCondition: VesselCondition
  /** Saved selections of the other narrative sections (raw), for cross-checks between them. */
  sectionInputs: Partial<Record<string, Record<string, unknown>>>
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
  const preamble = normalisePreambleInputs(report.narratives?.preamble?.inputs, { port: report.details?.port })
  return {
    vesselName: report.details?.vessel ?? "",
    startDate: report.details?.dateFrom ?? "",
    endDate: report.details?.dateTo ?? "",
    preamble,
    vesselCondition: vesselConditionFrom(preamble),
    items,
    critical: { tested, defects, total: CRITICAL_EQUIPMENT_ITEMS.length },
    vesselAge: ageAt(report.particulars?.yearBuilt ?? report.particulars?.year_built, report.details?.dateFrom ?? ""),
    sectionInputs: Object.fromEntries(
      Object.entries(report.narratives ?? {}).map(([key, value]) => [key, ((value as { inputs?: Record<string, unknown> } | undefined)?.inputs ?? {})]),
    ),
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
    sectionInputs: {},
    vesselCondition: { loading: "", situation: "" },
    ...patch,
  }
}

export const ratedAs = (ctx: ReportContext, rating: Rating, keys?: string[]) =>
  ctx.items.filter((item) => item.rating === rating && (!keys || keys.includes(item.key)))
