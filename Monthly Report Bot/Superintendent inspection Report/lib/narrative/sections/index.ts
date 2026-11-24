// Executive Summary sections built on the generic controlled-narrative engine, in report order.
import type { SectionSpec } from "../section"
import { OPERATIONAL_SECTION } from "./operational"
import { OVERALL_SECTION } from "./overall"
import { PERFORMANCE_SECTION } from "./performance"
import { PROBLEMS_SECTION } from "./problems"
import { PROJECTS_SECTION } from "./projects"
import { STRUCTURAL_SECTION } from "./structural"
import { HULL_SECTION } from "./hull"
import { MAIN_DECK_SECTION } from "./mainDeck"

export const SUMMARY_SECTIONS: SectionSpec[] = [
  OVERALL_SECTION,
  STRUCTURAL_SECTION,
  OPERATIONAL_SECTION,
  PERFORMANCE_SECTION,
  PROBLEMS_SECTION,
  PROJECTS_SECTION,
]

export function summarySection(id: string) {
  return SUMMARY_SECTIONS.find((spec) => spec.id === id)
}

/**
 * Condition items whose remarks are written by a builder (item key → section), shown on that item's page.
 * Add the next item (e.g. weatherDeck) here once its section is written.
 */
export const CONDITION_ITEM_SECTIONS: Partial<Record<string, SectionSpec>> = {
  hull: HULL_SECTION,
  weatherDeck: MAIN_DECK_SECTION,
}
