// Condition & Assurance Overview: what the inspection found, how much of the vessel it covered, and what is being
// done about the findings. Condition is reported by the worst observed condition per area, never by an average,
// and no risk score is derived from it (risk is assessed under the Company's risk assessment procedure).
// Pure functions: used by the editor, the PDF, the NeraVeda summary API and the tests.

import {
  CONDITION_SECTIONS,
  CRITICAL_EQUIPMENT_ITEMS,
  SAFETY_CRITICAL_ITEMS,
  effectiveRating,
  emptyFinding,
  isCriticalTested,
  type Finding,
  type Rating,
  type Report,
} from "./form-schema"

/** Severity of a condition grade (0 = not a condition grade: unrated, Not inspected, Not applicable). */
const SEVERITY: Partial<Record<Rating, number>> = {
  satisfactory: 1,
  acceptable: 2,
  fair: 3, // Monitor (earlier scale)
  degraded: 4,
  poor: 5, // Action required (earlier scale)
  deficient: 6,
}

export const severity = (rating: Rating | undefined) => SEVERITY[effectiveRating(rating)] ?? 0
export const isGraded = (rating: Rating | undefined) => severity(rating) > 0

/** Short area codes used in finding references, e.g. ENG-02. */
export const AREA_CODES: Record<string, string> = {
  hull: "HUL",
  mainDeck: "DCK",
  cargoBallast: "CBT",
  deckMachinery: "DMC",
  accommodation: "ACC",
  safety: "SAF",
  navigation: "NAV",
  engine: "ENG",
  critical: "CRT",
}

/** Stable reference of a finding: area code and the item's number within its area. */
export const findingRef = (areaId: string, index: number) => `${AREA_CODES[areaId] ?? "GEN"}-${String(index + 1).padStart(2, "0")}`

export type Coverage = "complete" | "limited" | "incomplete" | "notApplicable"

export type AreaOverview = {
  id: string
  title: string
  total: number
  /** Items that apply to the vessel (total minus Not applicable). */
  applicable: number
  /** Items given a condition grade. */
  assessed: number
  notInspected: number
  unrated: number
  /** Worst condition grade observed in the area ("" when nothing is graded). */
  worst: Rating
  deficient: number
  degraded: number
  /** Open findings with Immediate priority. */
  immediate: number
  coverage: Coverage
}

const conditionEntries = (report: Report, section: (typeof CONDITION_SECTIONS)[number]) => {
  const source = (section.source === "deck" ? report.deck : report.engine) ?? {}
  return section.items.map((item, index) => ({ item, index, entry: source[item.key] }))
}

export function areaOverview(report: Report): AreaOverview[] {
  return CONDITION_SECTIONS.map((section) => {
    const entries = conditionEntries(report, section)
    const ratings = entries.map((e) => effectiveRating(e.entry?.rating))
    const count = (rating: Rating) => ratings.filter((r) => r === rating).length
    const total = entries.length
    const applicable = total - count("na")
    const assessed = ratings.filter(isGraded).length
    const notInspected = count("notInspected")
    const unrated = count("")
    const worst = ratings.reduce<Rating>((w, r) => (severity(r) > severity(w) ? r : w), "")
    const immediate = entries.filter(
      (e) => (e.entry?.rating === "degraded" || e.entry?.rating === "deficient") && e.entry.finding?.priority === "immediate" && e.entry.finding.status !== "closed",
    ).length
    const coverage: Coverage = applicable === 0 ? "notApplicable" : unrated ? "incomplete" : notInspected ? "limited" : "complete"
    return { id: section.id, title: section.title, total, applicable, assessed, notInspected, unrated, worst, deficient: count("deficient"), degraded: count("degraded"), immediate, coverage }
  })
}

export type CriticalOverview = { total: number; tested: number; satisfactory: number; defects: number; notRecorded: number }

export function criticalOverview(report: Report): CriticalOverview {
  const results = report.criticalResults ?? {}
  let tested = 0
  let satisfactory = 0
  let defects = 0
  for (const item of CRITICAL_EQUIPMENT_ITEMS) {
    const result = results[item.key]?.result ?? ""
    if (!isCriticalTested(item, report.management) && !result) continue
    tested += 1
    if (result === "satisfactory") satisfactory += 1
    if (result === "defect") defects += 1
  }
  return { total: CRITICAL_EQUIPMENT_ITEMS.length, tested, satisfactory, defects, notRecorded: tested - satisfactory - defects }
}

export type RegisterEntry = {
  ref: string
  areaId: string
  areaTitle: string
  item: string
  /** Degraded or Deficient (a critical-test defect is Deficient: the equipment does not work as required). */
  rating: "degraded" | "deficient"
  source: "condition" | "critical"
  /** The finding as recorded: the item's remarks, or the test defect description. */
  description: string
  finding: Finding
}

const PRIORITY_ORDER: Record<string, number> = { immediate: 0, priority: 1, planned: 2, drydock: 3, "": 4 }

/** Every Degraded or Deficient item and every critical-test defect: Deficient first, then by priority, then in report order. */
export function findingsRegister(report: Report): RegisterEntry[] {
  const entries: RegisterEntry[] = []
  for (const section of CONDITION_SECTIONS) {
    for (const { item, index, entry } of conditionEntries(report, section)) {
      if (entry?.rating !== "degraded" && entry?.rating !== "deficient") continue
      entries.push({
        ref: findingRef(section.id, index),
        areaId: section.id,
        areaTitle: section.title,
        item: item.label,
        rating: entry.rating,
        source: "condition",
        description: entry.remarks?.trim() ?? "",
        finding: entry.finding ?? emptyFinding(SAFETY_CRITICAL_ITEMS.includes(item.key)),
      })
    }
  }
  CRITICAL_EQUIPMENT_ITEMS.forEach((item, index) => {
    const result = report.criticalResults?.[item.key]
    if (result?.result !== "defect") return
    entries.push({
      ref: findingRef("critical", index),
      areaId: "critical",
      areaTitle: "Critical Equipment",
      item: item.label,
      rating: "deficient",
      source: "critical",
      description: result.description?.trim() ?? "",
      finding: result.finding ?? emptyFinding(true),
    })
  })
  return entries
    .map((entry, order) => ({ entry, order }))
    .sort(
      (a, b) =>
        severity(b.entry.rating) - severity(a.entry.rating) ||
        PRIORITY_ORDER[a.entry.finding.priority] - PRIORITY_ORDER[b.entry.finding.priority] ||
        a.order - b.order,
    )
    .map(({ entry }) => entry)
}

/** Findings that need a risk assessment and do not have a completed one: Deficient or Immediate, still open. */
export const raPending = (entry: RegisterEntry) =>
  entry.finding.status !== "closed" &&
  (entry.rating === "deficient" || entry.finding.priority === "immediate") &&
  entry.finding.raStatus !== "completed" &&
  entry.finding.raStatus !== "notRequired"

export type Limitation = { areaTitle: string; item: string; reason: string }

/** Items that could not be inspected, with the reason recorded. */
export function limitations(report: Report): Limitation[] {
  return CONDITION_SECTIONS.flatMap((section) =>
    conditionEntries(report, section)
      .filter((e) => e.entry?.rating === "notInspected")
      .map((e) => ({ areaTitle: section.title, item: e.item.label, reason: e.entry?.remarks?.trim() ?? "" })),
  )
}

export type KeyFigures = {
  coverage: { assessed: number; applicable: number; percent: number | null }
  critical: CriticalOverview
  /** Deficient items and critical-test defects: the non-conformities. */
  deficient: number
  degraded: number
  immediate: number
  openFindings: number
  raPending: number
}

export function keyFigures(report: Report): KeyFigures {
  const areas = areaOverview(report)
  const register = findingsRegister(report)
  const assessed = areas.reduce((n, a) => n + a.assessed, 0)
  const applicable = areas.reduce((n, a) => n + a.applicable, 0)
  const open = register.filter((e) => e.finding.status !== "closed")
  return {
    coverage: { assessed, applicable, percent: applicable ? Math.round((assessed / applicable) * 100) : null },
    critical: criticalOverview(report),
    deficient: register.filter((e) => e.rating === "deficient").length,
    degraded: register.filter((e) => e.rating === "degraded").length,
    immediate: open.filter((e) => e.finding.priority === "immediate").length,
    openFindings: open.length,
    raPending: register.filter(raPending).length,
  }
}

export type Conclusion = { state: "withheld" | "limited" | "complete"; text: string }

const items = (n: number) => `${n} ${n === 1 ? "item" : "items"}`

/** The overall statement: withheld while coverage is incomplete. No overall grade is calculated. */
export function conclusion(report: Report): Conclusion {
  const areas = areaOverview(report)
  const unrated = areas.reduce((n, a) => n + a.unrated, 0)
  const notInspected = areas.reduce((n, a) => n + a.notInspected, 0)
  if (unrated) {
    return { state: "withheld", text: `Overall conclusion withheld – ${items(unrated)} not assessed. Recorded findings are shown below.` }
  }
  if (notInspected) {
    return { state: "limited", text: `All areas assessed, with stated limitations: ${items(notInspected)} not inspected (reasons under Inspection limitations).` }
  }
  return { state: "complete", text: "All applicable items assessed." }
}

export const COVERAGE_LABELS: Record<Coverage, string> = {
  complete: "Complete",
  limited: "Limited",
  incomplete: "Incomplete",
  notApplicable: "Not applicable",
}
