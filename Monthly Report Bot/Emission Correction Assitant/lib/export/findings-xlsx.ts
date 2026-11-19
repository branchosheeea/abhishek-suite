// Findings export for vessel review (Excel). One row per finding with an Investigation status dropdown and an
// empty "Vessel remarks" column for the vessel to fill in. A diagnostic document, never a reporting file.

import { RULE_BY_ID } from "../engine/rules/registry"
import { EVIDENCE_LABEL, type Finding, RULE_GROUP_LABEL } from "../engine/types"
import { FINDING_STATUSES } from "../server/diagnostics"
import { type ExportScope, SCOPE_LABEL } from "./findings-filter"
import { limitations, notesFor, refText, REPORT_BANNER, type ReportInput, statusOf } from "./report"
import { type CellStyle, writeXlsx, type XlsxCell, type XlsxSheet } from "./xlsx-writer"

export type FindingsExportOptions = Readonly<{ scope: ExportScope; includeNotes: boolean }>

const b = (text: string): XlsxCell => ({ bold: text })
const w = (text: string | number, style: CellStyle = "wrap"): XlsxCell => ({ text, style })

export function vesselLine(input: ReportInput): string {
  const p = input.session.config.period
  return `${input.session.vessel} · IMO ${input.session.imo ?? "not set"} · Reporting period ${p ? `${p.from} to ${p.to}` : "not set"}`
}

export const FILL_IN_STEPS = [
  "Each finding shows what was found, the source records (line numbers of the submitted files) and the calculation.",
  "Check the source records on board and correct the reporting files in the normal way. This file is never submitted to DNV and cannot replace a reporting file.",
  "Choose an Investigation status for each finding from the list, and write in Vessel remarks what was corrected or why the entry is right.",
  "Save the file and return it to the office.",
]

export function buildFindingsXlsx(input: ReportInput, findings: readonly Finding[], options: FindingsExportOptions): Buffer {
  const { session, run, result } = input
  const header = [
    "No.", "Severity", "Rule", "Check", "Group", "Evidence", "Finding", "Detail", "Source records", "Columns", "Fuel", "Result",
    "Qualifications", "Possible causes (hypotheses — not verified)", "Recommended check", "Investigation status", "Vessel remarks / correction made",
    ...(options.includeNotes ? ["Office notes"] : []), "Finding id",
  ]
  const statusColumn = 15
  const top: XlsxCell[][] = [[b(REPORT_BANNER)], [w(vesselLine(input), "muted")], []]
  const rows: XlsxCell[][] = findings.map((f, i) => [
    i + 1,
    w(f.severity, f.severity === "error" ? "error" : f.severity === "warning" ? "warning" : "info"),
    w(f.ruleId), w(RULE_BY_ID.get(f.ruleId)?.name ?? ""), w(RULE_GROUP_LABEL[f.group]), w(EVIDENCE_LABEL[f.evidence]),
    w(f.title), w(f.detail), w(refText(f.refs)), w((f.columns ?? []).join(", ")), w(f.fuel ?? ""), w(f.calculation?.result ?? ""),
    w((f.calculation?.qualifications ?? []).join("\n")), w((f.possibleCauses ?? []).join("\n")), w(f.recommendation),
    w(statusOf(input, f.id)), w(""),
    ...(options.includeNotes ? [w(notesFor(input, f.id).map((n) => `${n.createdAt} ${n.createdBy}: ${n.text}`).join("\n"), "muted")] : []),
    w(f.id, "muted"),
  ])
  const widths = [5, 10, 7, 30, 18, 20, 45, 70, 22, 22, 6, 16, 50, 50, 40, 26, 45, ...(options.includeNotes ? [40] : []), 22]
  const findingsSheet: XlsxSheet = {
    name: "Findings",
    rows: [...top, header.map((h) => w(h, "header")), ...rows],
    widths,
    freezeRows: top.length + 1,
    autoFilter: { row: top.length, fromColumn: 0, toColumn: header.length - 1 },
    validations: rows.length ? [{ column: statusColumn, fromRow: top.length + 1, toRow: top.length + rows.length, list: FINDING_STATUSES, title: "Investigation status", prompt: "Choose the status of this finding." }] : [],
    autoHeight: true,
  }

  const calcRows: XlsxCell[][] = []
  findings.forEach((f, i) => {
    if (!f.calculation) return
    const n = i + 1
    calcRows.push([n, w(f.ruleId), w("Formula"), w(f.calculation.formula)])
    for (const x of f.calculation.inputs) calcRows.push([n, w(f.ruleId), w("Input"), w(x.label), w(x.value), w(x.ref ? refText([x.ref]) : ""), w(x.column ?? "")])
    for (const s of f.calculation.steps) calcRows.push([n, w(f.ruleId), w("Step"), w(s)])
    calcRows.push([n, w(f.ruleId), w("Result"), w(f.calculation.result)])
    for (const q of f.calculation.qualifications) calcRows.push([n, w(f.ruleId), w("Qualification"), w(q)])
  })

  const count = (sev: string) => findings.filter((f) => f.severity === sev).length
  const readMe: XlsxCell[][] = [
    [b(REPORT_BANNER)],
    [],
    [b("Findings for vessel review")],
    [b("Vessel"), session.vessel],
    [b("IMO"), session.imo ?? "not set"],
    [b("Reporting period"), session.config.period ? `${session.config.period.from} to ${session.config.period.to}` : "not set"],
    [b("Session"), session.title],
    [b("Validation run"), `${run.startedAt} by ${run.actor} · rule set ${result.ruleSetVersion} · engine ${result.engineVersion}`],
    [b("Sources"), input.artifacts.map((a) => `${a.kind} ${a.filename} (SHA-256 ${a._id.slice(0, 16)}…)`).join("\n")],
    [b("Exported"), `${SCOPE_LABEL[options.scope]}: ${findings.length} finding(s) — ${count("error")} error(s), ${count("warning")} warning(s), ${count("info")} information`],
    [b("Generated"), `${input.generatedAt} by ${input.generatedBy}`],
    [],
    [b("How to use this file")],
    ...FILL_IN_STEPS.map((s, i): XlsxCell[] => [`${i + 1}.`, w(s)]),
    [],
    [b("Known limitations")],
    ...limitations(input).map((l): XlsxCell[] => ["", w(l, "muted")]),
  ]

  return writeXlsx([
    { name: "Read me", rows: readMe, widths: [20, 110], autoHeight: true },
    findingsSheet,
    { name: "Calculations", rows: [[b(REPORT_BANNER)], [], ["No.", "Rule", "Item", "Label / text", "Value", "Source record", "Column"].map((h) => w(h, "header")), ...calcRows], widths: [5, 7, 13, 80, 18, 22, 26], freezeRows: 3, autoHeight: true },
  ])
}
