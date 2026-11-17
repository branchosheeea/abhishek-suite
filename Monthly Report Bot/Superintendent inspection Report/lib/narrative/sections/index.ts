// Executive Summary sections built on the generic controlled-narrative engine, in report order.
import type { SectionSpec } from "../section"
import { OPERATIONAL_SECTION } from "./operational"
import { OVERALL_SECTION } from "./overall"
import { PERFORMANCE_SECTION } from "./performance"
import { PROBLEMS_SECTION } from "./problems"
import { PROJECTS_SECTION } from "./projects"
import { STRUCTURAL_SECTION } from "./structural"

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
