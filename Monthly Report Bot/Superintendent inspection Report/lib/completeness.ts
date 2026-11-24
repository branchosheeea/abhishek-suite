// Mandatory inputs of the Superintendent's Detailed Inspection Report, in one place.
// The editor marks them with *, lists what is outstanding, lets the Fleet Manager approve only when nothing is
// outstanding, and the PDF carries a DRAFT watermark until the report is complete and approved.
// Pure functions: used in the browser, in the API (NeraVeda summary) and in tests.

import {
  CONDITION_SECTIONS,
  CRITICAL_EQUIPMENT_ITEMS,
  DETAILS_GROUPS,
  MANAGEMENT_SECTION_GROUPS,
  PARTICULARS_GROUPS,
  SCOPE_ITEMS,
  SECTIONS,
  SUMMARY_FIELDS,
  isCriticalTested,
  isLegacyToRerate,
  needsFinding,
  needsRemarks,
  ratingLabel,
  type FieldGroup,
  type Finding,
  type Report,
  type SectionId,
} from "./form-schema"
import { CONDITION_ITEM_SECTIONS } from "./narrative/sections"

export type Outstanding = { section: SectionId; label: string }

const filled = (value?: string) => Boolean(value && value.trim())

const WORKLIST_LABELS: Record<string, string> = {
  issued: "Confirm the work list was issued and discussed",
  followUp: "Confirm the Master will report work-list progress",
}

/** The Superintendent is the person named under Inspected by; older reports may only have the sign-off name. */
export function superintendentName(report: Report) {
  return report.details?.inspectedBy?.trim() || report.signoff?.superintendentName?.trim() || ""
}

/** Older reports have the Superintendent's signature in the former "Inspector" box. */
export function superintendentSignature(report: Report) {
  return report.signoff?.superintendentSignature || report.signoff?.inspectorSignature || ""
}

/** Approved by the Fleet Manager: name, date and signature all present. */
export const isApproved = (report: Report) =>
  filled(report.signoff?.fleetManagerName) && filled(report.signoff?.fleetManagerDate) && Boolean(report.signoff?.fleetManagerSignature)

/** Findings-register fields for a Degraded or Deficient item, or a critical-test defect. */
function findingOutstanding(section: SectionId, label: string, deficient: boolean, finding: Finding | undefined, out: Outstanding[]) {
  const f = finding
  if (!filled(f?.action)) out.push({ section, label: `${label}: corrective action / controls` })
  if (!f?.priority) out.push({ section, label: `${label}: priority` })
  if (f?.priority !== "drydock" && f?.status !== "closed" && !filled(f?.dueDate)) out.push({ section, label: `${label}: due date` })
  if ((deficient || f?.priority === "immediate") && !f?.raStatus) out.push({ section, label: `${label}: risk assessment status` })
  if (f?.raStatus === "completed" && !filled(f.raRef)) out.push({ section, label: `${label}: risk assessment number` })
}

function requiredFields(section: SectionId, groups: FieldGroup[], values: Record<string, string> | undefined, out: Outstanding[]) {
  for (const field of groups.flatMap((g) => g.fields)) {
    if (field.required && !filled(values?.[field.key])) out.push({ section, label: field.label })
  }
}

/** Everything that must be complete before the Fleet Manager can approve the report. */
export function outstandingForReview(report: Report, photoCount: number): Outstanding[] {
  const out: Outstanding[] = []
  requiredFields("details", DETAILS_GROUPS, report.details, out)
  requiredFields("particulars", PARTICULARS_GROUPS, report.particulars, out)
  for (const field of SUMMARY_FIELDS) {
    if (!filled(report.summary?.[field.key])) out.push({ section: "summary", label: `${field.label} (save the generated text)` })
  }
  if (!SCOPE_ITEMS.some((item) => report.scope?.[item.key])) out.push({ section: "scope", label: "At least one area of inspection" })
  // Reports approved before the four-grade scale and the critical-test results keep their approval.
  const approvedEarlier = isApproved(report)
  for (const section of CONDITION_SECTIONS) {
    const values = section.source === "deck" ? report.deck : report.engine
    for (const item of section.items) {
      const entry = values?.[item.key]
      const rating = entry?.rating
      if (!rating) out.push({ section: section.id, label: `${item.label}: rating` })
      else if (isLegacyToRerate(rating)) {
        if (!approvedEarlier) {
          const earlier = ratingLabel(rating).replace(" (earlier scale)", "")
          out.push({ section: section.id, label: `${item.label}: re-rate on the current scale (earlier rating: ${earlier})` })
        }
      } else {
        if (needsRemarks(rating) && !filled(entry.remarks)) {
          const what = rating === "notInspected" ? "reason it was not inspected" : `remarks (rated ${ratingLabel(rating)})`
          out.push({ section: section.id, label: `${item.label}: ${what}` })
        } else if (CONDITION_ITEM_SECTIONS[item.key] && rating !== "na" && !filled(entry.remarks) && !approvedEarlier) {
          // Items with a remarks builder (e.g. Hull) always need their description, as the Executive Summary does.
          out.push({ section: section.id, label: `${item.label}: remarks (save the text from the ${CONDITION_ITEM_SECTIONS[item.key]!.title} builder)` })
        }
        if (needsFinding(rating)) findingOutstanding(section.id, item.label, rating === "deficient", entry.finding, out)
      }
    }
  }
  // Critical equipment: every test carried out needs its result; a defect needs its description and a finding.
  if (!(approvedEarlier && report.criticalResults === undefined)) {
    for (const item of CRITICAL_EQUIPMENT_ITEMS) {
      const result = report.criticalResults?.[item.key]
      if (!isCriticalTested(item, report.management) && !result?.result) continue
      if (!result?.result) out.push({ section: "critical", label: `${item.label}: test result` })
      else if (result.result === "defect") {
        if (!filled(result.description)) out.push({ section: "critical", label: `${item.label}: defect found` })
        findingOutstanding("critical", item.label, true, result.finding, out)
      }
    }
  }
  for (const key of ["critical", "system", "survey", "budget", "crew"] as const) {
    requiredFields(key, MANAGEMENT_SECTION_GROUPS[key], report.management, out)
  }
  if (photoCount < 1) out.push({ section: "photos", label: "At least one photograph" })
  for (const [key, label] of Object.entries(WORKLIST_LABELS)) {
    if (!report.worklist?.[key]) out.push({ section: "signoff", label })
  }
  if (!superintendentSignature(report)) out.push({ section: "signoff", label: "Superintendent’s signature" })
  return out
}

/** Review items plus the Fleet Manager's approval. An empty list means the report is complete and submitted. */
export function outstandingForFinal(report: Report, photoCount: number): Outstanding[] {
  const out = outstandingForReview(report, photoCount)
  if (!filled(report.signoff?.fleetManagerName)) out.push({ section: "signoff", label: "Fleet Manager’s name" })
  if (!filled(report.signoff?.fleetManagerDate)) out.push({ section: "signoff", label: "Fleet Manager’s approval date" })
  if (!report.signoff?.fleetManagerSignature) out.push({ section: "signoff", label: "Fleet Manager’s signature" })
  return out
}

export function isFinal(report: Report, photoCount: number) {
  return outstandingForFinal(report, photoCount).length === 0
}

export type ReportStage = "draft" | "awaiting-approval" | "approved"

/** draft: mandatory inputs outstanding · awaiting-approval: complete, waiting for the Fleet Manager · approved: final. */
export function reportStage(report: Report, photoCount: number): ReportStage {
  if (outstandingForReview(report, photoCount).length) return "draft"
  return isFinal(report, photoCount) ? "approved" : "awaiting-approval"
}

export function outstandingBySection(items: Outstanding[]) {
  const map = new Map<SectionId, Outstanding[]>()
  for (const item of items) map.set(item.section, [...(map.get(item.section) ?? []), item])
  return map
}

export function sectionTitle(id: SectionId) {
  return SECTIONS.find((s) => s.id === id)?.title ?? id
}
