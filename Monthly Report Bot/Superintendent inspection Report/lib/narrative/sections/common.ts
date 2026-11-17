// Vocabulary and helpers shared by the Executive Summary condition sections.
// Wording rules: formal British English; state what was verified and how; never infer a condition, a test or
// a result that the Superintendent did not select.

import { ratedAs, type RatedItem, type ReportContext } from "../context"
import type { ItemValue, OptionDef, SectionInputs } from "../section"
import { joinList } from "../text"

export const ASSESSMENTS = [
  { id: "GOOD", label: "Good", phrase: "good" },
  { id: "SATISFACTORY", label: "Satisfactory", phrase: "satisfactory" },
  { id: "FAIR", label: "Fair – improvement required", phrase: "fair, with improvement required" },
  { id: "POOR", label: "Poor – corrective action required", phrase: "poor, with corrective action required" },
] as const

export const AREA_ASSESSMENTS = [
  ...ASSESSMENTS,
  { id: "NOT_ASSESSED", label: "Not assessed during this attendance", phrase: "" },
] as const

export function assessment(id: unknown) {
  return ASSESSMENTS.find((a) => a.id === id)?.phrase ?? ""
}

export const isAdverse = (id: unknown) => id === "FAIR" || id === "POOR"
export const isFavourable = (id: unknown) => id === "GOOD" || id === "SATISFACTORY"

// --- Reading inputs -----------------------------------------------------------------------------------------------

export const str = (inputs: Record<string, unknown>, key: string) => {
  const value = inputs[key]
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : ""
}
export const list = (inputs: Record<string, unknown>, key: string) => {
  const value = inputs[key]
  return Array.isArray(value) ? (value as string[]) : []
}
export const flag = (inputs: Record<string, unknown>, key: string) => inputs[key] === true
export const items = (inputs: SectionInputs, key: string) => (Array.isArray(inputs[key]) ? (inputs[key] as ItemValue[]) : [])
export const has = (inputs: Record<string, unknown>, key: string, id: string) => list(inputs, key).includes(id)

/** Phrases of the selected options, in the fixed option order. */
export function phrases<T extends OptionDef & { phrase: string }>(options: readonly T[], ids: readonly string[]) {
  return options.filter((o) => ids.includes(o.id) && o.phrase).map((o) => o.phrase)
}

export function optionLabel(options: readonly OptionDef[], id: unknown) {
  return options.find((o) => o.id === id)?.label ?? ""
}

// --- Facts from the Vessel Condition Report ------------------------------------------------------------------------

const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1)

/** "main engine; steering gear" style list of item names. */
export function itemNames(found: RatedItem[]) {
  return found.map((item) => lower(item.label)).join("; ")
}

/**
 * One-sentence summary of the condition ratings recorded in the report, or "" when nothing is rated.
 * It states counts only: no average and no risk figure is derived from condition ratings.
 */
export function ratingSummary(ctx: ReportContext, keys?: string[]) {
  const scope = keys ? ctx.items.filter((i) => keys.includes(i.key)) : ctx.items
  const of = (rating: string) => scope.filter((i) => i.rating === rating)
  const deficient = of("deficient")
  const earlierAction = of("poor")
  const groups = [
    { n: of("satisfactory").length, label: "Satisfactory" },
    { n: of("acceptable").length, label: "Acceptable" },
    { n: of("degraded").length, label: "Degraded" },
    { n: deficient.length, label: `Deficient (${itemNames(deficient)})` },
    { n: of("fair").length, label: "Monitor on the earlier rating scale" },
    { n: earlierAction.length, label: `Action required on the earlier rating scale (${itemNames(earlierAction)})` },
  ].filter((g) => g.n > 0)
  const rated = groups.reduce((n, g) => n + g.n, 0)
  if (!rated) return ""
  if (rated === 1) return `The only condition item rated in this report so far was rated ${groups[0].label}.`
  // Only the first group carries the verb: "20 were rated Satisfactory, 2 Acceptable and 1 Deficient (…)".
  const parts = groups.map((g, index) => (index === 0 ? `${g.n} ${g.n === 1 ? "was" : "were"} rated ${g.label}` : `${g.n} ${g.label}`))
  const na = of("na").length
  const notInspected = of("notInspected").length
  const excluded = [na && `${na} not applicable`, notInspected && `${notInspected} not inspected`].filter(Boolean)
  const excludedText = excluded.length ? ` (excluding ${joinList(excluded as string[])})` : ""
  return `Of the ${rated} condition items rated in this report${excludedText}, ${joinList(parts)}.`
}

/** Items rated Deficient (or Action required on the earlier scale). */
export const deficientItems = (ctx: ReportContext, keys?: string[]) => [...ratedAs(ctx, "deficient", keys), ...ratedAs(ctx, "poor", keys)]
/** Items rated Degraded (or Monitor on the earlier scale). */
export const degradedItems = (ctx: ReportContext, keys?: string[]) => [...ratedAs(ctx, "degraded", keys), ...ratedAs(ctx, "fair", keys)]

/** Condition-report keys that relate to each part of the summary. */
export const HULL_KEYS = ["hull"]
export const DECK_KEYS = ["weatherDeck", "hatchCovers", "ventilators"]
export const TANK_KEYS = ["cargoHolds", "ballastTanks"]
export const STRUCTURE_KEYS = [...HULL_KEYS, ...DECK_KEYS, ...TANK_KEYS, "accommodation"]
export const MACHINERY_KEYS = ["erGeneral", "mainEngine", "dieselGenerator", "boiler", "auxMachinery", "piping", "electrical", "hydro", "steering", "engineMisc"]
export const NAVIGATION_KEYS = ["navigation"]
export const CARGO_KEYS = ["cargoEquipment", "cranes", "mooring"]
export const SAFETY_KEYS = ["lsa", "ffa"]
