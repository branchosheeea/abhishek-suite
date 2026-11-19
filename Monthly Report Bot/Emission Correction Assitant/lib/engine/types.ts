// Shared types of the validation engine. The engine is pure: no React, no MongoDB, no file system.
// Source data reaches it as frozen tables and is never written back anywhere.

export type SourceKind = "LA" | "BR" | "OVDLA"

export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  LA: "Log Abstract (vessel-submitted CSV)",
  BR: "Bunker Report (vessel-submitted CSV)",
  OVDLA: "OVDLA (system-generated Excel)",
}

/** Where a value came from: the registered file (by SHA-256) and the original line / sheet row. */
export type SourceRef = Readonly<{
  sha256: string
  kind: SourceKind
  /** 1-based physical line in the CSV where the record starts, or the 1-based worksheet row number. */
  line: number
  /** 0-based position among the data rows, in original order. */
  index: number
}>

export type XlsxCellType = "s" | "inlineStr" | "str" | "n" | "b" | "e" | "d"

export type SourceRow = Readonly<{
  index: number
  line: number
  /** Raw cell text exactly as stored (CSV field after RFC 4180 unquoting; XLSX stored value). */
  cells: readonly string[]
  /** XLSX only: stored cell type, whether the cell is date-formatted, and whether it holds a formula. */
  types?: readonly (XlsxCellType | undefined)[]
  dateFormatted?: readonly boolean[]
  formulas?: readonly boolean[]
  /** CSV: the line held no characters at all. */
  blankLine?: boolean
}>

export type ParseIssue = Readonly<{
  code: string
  message: string
  line?: number
  severity: Severity
}>

export type SourceTable = Readonly<{
  kind: SourceKind
  sha256: string
  filename: string
  format: "csv" | "xlsx"
  headerLine: number
  headers: readonly string[]
  rows: readonly SourceRow[]
  meta: Readonly<{
    encoding: string
    bom?: boolean
    delimiter?: string
    lineEndings?: "CRLF" | "LF" | "CR" | "mixed" | "none"
    sheet?: string
    sheets?: readonly string[]
    date1904?: boolean
  }>
  issues: readonly ParseIssue[]
}>

export type Severity = "error" | "warning" | "info"

/**
 * How strong the basis of a finding is. These are distinct and must never be conflated:
 * - official-interface / official-validation: traceable to a DNV document (requires a verified schema)
 * - independent-calculation: shown by an explicit, reproducible calculation
 * - screening-threshold: a configurable engineering threshold, not a DNV tolerance
 * - hypothesis: a plausible explanation that needs more evidence
 */
export type EvidenceClass =
  | "official-interface"
  | "official-validation"
  | "independent-calculation"
  | "screening-threshold"
  | "hypothesis"

export const EVIDENCE_LABEL: Record<EvidenceClass, string> = {
  "official-interface": "Official interface requirement",
  "official-validation": "Official validation requirement",
  "independent-calculation": "Independent calculation",
  "screening-threshold": "Screening threshold",
  hypothesis: "Investigation hypothesis",
}

export type RuleGroup = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "R"

export const RULE_GROUP_LABEL: Record<RuleGroup, string> = {
  A: "Structure",
  B: "Chronology",
  C: "Voyage and port continuity",
  D: "Fuel reconciliation",
  E: "Cargo consistency",
  F: "Duration",
  G: "Distance and position",
  R: "Source reconciliation",
}

export type CalculationInput = Readonly<{ label: string; value: string; ref?: SourceRef; column?: string }>

export type Calculation = Readonly<{
  formula: string
  inputs: readonly CalculationInput[]
  steps: readonly string[]
  result: string
  /** Every assumption or missing input that limits what the result shows. */
  qualifications: readonly string[]
}>

export type Finding = Readonly<{
  /** Deterministic: the same inputs, rule version and configuration always give the same id. */
  id: string
  ruleId: string
  ruleVersion: string
  group: RuleGroup
  severity: Severity
  evidence: EvidenceClass
  title: string
  detail: string
  refs: readonly SourceRef[]
  /** Columns involved, for highlighting in the source viewer. */
  columns?: readonly string[]
  fuel?: string
  /** UTC window the finding concerns (epoch ms), used for DNV correlation. */
  window?: Readonly<{ fromMs: number; toMs: number }>
  calculation?: Calculation
  recommendation: string
  /** Hypotheses attached to this finding (possible causes); never treated as confirmed. */
  possibleCauses?: readonly string[]
  /** Related finding ids, linked only when a shared source record or calculation connects them. */
  related?: readonly string[]
  schemaVerified: boolean
}>

export type RuleCoverage = Readonly<{
  ruleId: string
  ruleVersion: string
  status: "executed" | "not-executable" | "partial"
  reason?: string
  evaluated: number
  findings: number
}>
