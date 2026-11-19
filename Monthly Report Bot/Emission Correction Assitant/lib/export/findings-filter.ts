// Which findings a view or an export shows. Pure and shared by the Findings tab and the findings export, so
// "export the current filter" gives exactly the findings on the screen.

import { EVIDENCE_LABEL, type EvidenceClass, type Finding, RULE_GROUP_LABEL, type RuleGroup } from "../engine/types"

export type ExportScope = "errors-warnings" | "all" | "filter"

export const SCOPE_LABEL: Record<ExportScope, string> = {
  "errors-warnings": "All errors and warnings",
  all: "All findings, including information",
  filter: "The findings shown by the current filter",
}

export type FindingFilter = Readonly<{
  group: RuleGroup | ""
  severity: "" | "error" | "warning" | "info"
  evidence: EvidenceClass | ""
  status: string
  query: string
}>

export const NO_FILTER: FindingFilter = Object.freeze({ group: "", severity: "", evidence: "", status: "", query: "" })

export function matchesFilter(f: Finding, statusOf: (id: string) => string, filter: FindingFilter): boolean {
  const q = filter.query.trim().toLowerCase()
  return (
    (!filter.group || f.group === filter.group) &&
    (!filter.severity || f.severity === filter.severity) &&
    (!filter.evidence || f.evidence === filter.evidence) &&
    (!filter.status || statusOf(f.id) === filter.status) &&
    (!q || f.title.toLowerCase().includes(q) || f.detail.toLowerCase().includes(q) || f.ruleId.toLowerCase() === q || f.refs.some((r) => String(r.line) === q))
  )
}

/** Findings in the order the run lists them (errors first). */
export function selectFindings(findings: readonly Finding[], statusOf: (id: string) => string, scope: ExportScope, filter: FindingFilter = NO_FILTER): Finding[] {
  if (scope === "all") return [...findings]
  if (scope === "errors-warnings") return findings.filter((f) => f.severity !== "info")
  return findings.filter((f) => matchesFilter(f, statusOf, filter))
}

/** Query-string form of a scope and filter (for the export link). */
export function exportParams(scope: ExportScope, filter: FindingFilter): URLSearchParams {
  const p = new URLSearchParams({ scope })
  if (scope === "filter") for (const [k, v] of Object.entries(filter)) if (v) p.set(k, String(v))
  return p
}

export class FilterError extends Error {}

/** Strict reading of the export parameters; unknown values are refused, never guessed. */
export function parseExportParams(params: URLSearchParams, statuses: readonly string[]): { scope: ExportScope; filter: FindingFilter } {
  const scope = (params.get("scope") ?? "errors-warnings") as ExportScope
  if (!(scope in SCOPE_LABEL)) throw new FilterError("scope must be errors-warnings, all or filter.")
  const group = (params.get("group") ?? "") as FindingFilter["group"]
  const severity = (params.get("severity") ?? "") as FindingFilter["severity"]
  const evidence = (params.get("evidence") ?? "") as FindingFilter["evidence"]
  const status = params.get("status") ?? ""
  const query = (params.get("query") ?? "").slice(0, 200)
  if (group && !(group in RULE_GROUP_LABEL)) throw new FilterError("Unknown rule group.")
  if (severity && !["error", "warning", "info"].includes(severity)) throw new FilterError("Unknown severity.")
  if (evidence && !(evidence in EVIDENCE_LABEL)) throw new FilterError("Unknown evidence class.")
  if (status && !statuses.includes(status)) throw new FilterError("Unknown investigation status.")
  return { scope, filter: { group, severity, evidence, status, query } }
}
