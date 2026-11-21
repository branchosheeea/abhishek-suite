// Diagnostic reports (JSON, XLSX). They describe findings ABOUT the reporting files and are never in an OVD
// reporting format: no corrected Log Abstract, Bunker Report or OVD file is ever produced. Every sheet and the
// JSON root carry the diagnostic banner.

import { DNV_CATEGORIES, OUTCOME_LABEL } from "../engine/correlate"
import { RULE_GROUP_LABEL, EVIDENCE_LABEL, type Finding, type SourceRef } from "../engine/types"
import { UNMATCHED_LABEL } from "../engine/reconcile"
import { RULES } from "../engine/rules/registry"
import type { ValidationResult } from "../engine/run"
import type { DnvDoc, LinkDoc, NoteDoc, RunDoc, SessionDoc, StatusDoc, StatusHistoryDoc } from "../server/diagnostics"
import type { SourceArtifact } from "../server/source-store"
import { FINDINGS_PRODUCT_NAME, filePrefix, PRODUCT_NAME, REPORT_BANNER } from "./brand"
import { writeXlsx, type XlsxCell, type XlsxSheet } from "./xlsx-writer"

export { REPORT_BANNER }

export type ReportInput = Readonly<{
  session: SessionDoc
  run: RunDoc
  result: ValidationResult
  artifacts: readonly SourceArtifact[]
  dnv: readonly DnvDoc[]
  investigation: Readonly<{ statuses: StatusDoc[]; history: StatusHistoryDoc[]; notes: NoteDoc[]; links: LinkDoc[] }>
  storageProtection: string
  generatedAt: string
  generatedBy: string
}>

export function limitations(input: Pick<ReportInput, "result" | "storageProtection">): string[] {
  const out: string[] = []
  if (!input.result.schema.verified) out.push(`Schema ${input.result.schema.id}: ${input.result.schema.note}`)
  else out.push(`Schema ${input.result.schema.id}: ${input.result.schema.note}`)
  if (!input.result.coverage.sources.BR) {
    out.push("No Bunker Report was supplied: bunkering and de-bunkering are not in the fuel balances, and DNV \"Reported ROB vs available fuel\" items are left Unresolved.")
  }
  out.push(
    "Only the exact OVD event names (Arrival, Departure, ArrivalSTS, DepartureSTS, STS, BOSP/EOSP and documented alternatives) drive voyage logic; other event names are used as context only.",
    "DNV's own validation logic is proprietary and not documented here. 'Not Reproduced' means only that the independent calculation, under its stated assumptions, does not show the discrepancy.",
    "All tolerances are configurable screening thresholds chosen for investigation. They are not DNV tolerances.",
    "No de-bunkering, internal transfer, sludge or ROB-correction records were available; fuel balances list this as a qualification.",
    "No AIS data was used. Distances are compared with the WGS-84 geodesic between reported positions, which is a lower bound on the sailed distance.",
    "Possible causes are hypotheses for investigation, not established errors.",
    `Original-file storage protection: ${input.storageProtection}`,
    "This report is a diagnostic document. It must not be submitted as, or used to regenerate, an official vessel reporting file.",
  )
  return out
}

export function refText(refs: readonly SourceRef[]): string {
  const byKind = new Map<string, number[]>()
  for (const r of refs) byKind.set(r.kind, [...(byKind.get(r.kind) ?? []), r.line])
  return [...byKind.entries()].map(([kind, lines]) => `${kind} ${kind === "OVDLA" ? "row" : "line"} ${[...new Set(lines)].join(", ")}`).join("; ")
}

export function statusOf(input: ReportInput, id: string): string {
  return input.investigation.statuses.find((s) => s.findingId === id)?.status ?? "New"
}

export function notesFor(input: ReportInput, id: string | null): NoteDoc[] {
  return input.investigation.notes.filter((n) => n.findingId === id)
}

export function buildJsonReport(input: ReportInput) {
  const { session, run, result } = input
  return {
    banner: REPORT_BANNER,
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy,
    vessel: session.vessel,
    imo: session.imo,
    reportingPeriod: session.config.period,
    session: { id: session._id, title: session.title },
    run: { id: run._id, startedAt: run.startedAt, finishedAt: run.finishedAt, by: run.actor, state: run.state },
    versions: { engine: result.engineVersion, ruleSet: result.ruleSetVersion, schema: result.schema, configHash: result.configHash },
    configuration: run.config,
    sources: input.artifacts.map((a) => ({
      kind: a.kind, filename: a.filename, sha256: a._id, bytes: a.size, registeredAt: a.registeredAt, registeredBy: a.registeredBy,
      integrityBefore: run.integrity.before.find((c) => c.sha256 === a._id)?.ok ?? null,
      integrityAfter: run.integrity.after.find((c) => c.sha256 === a._id)?.ok ?? null,
    })),
    exclusions: result.exclusions,
    coverage: result.coverage,
    findings: result.findings.map((f) => ({
      ...f,
      groupLabel: RULE_GROUP_LABEL[f.group],
      evidenceLabel: EVIDENCE_LABEL[f.evidence],
      investigationStatus: statusOf(input, f.id),
      notes: notesFor(input, f.id).map((n) => ({ at: n.createdAt, by: n.createdBy, text: n.text })),
    })),
    dnv: input.dnv.map((d) => ({ ...d, correlation: result.correlations.find((c) => c.dnvId === d.id) ?? null })),
    reconciliation: result.reconciliation,
    fuel: result.fuel,
    investigation: { history: input.investigation.history, links: input.investigation.links, sessionNotes: notesFor(input, null) },
    storageProtection: input.storageProtection,
    knownLimitations: limitations(input),
  }
}

const b = (text: string): XlsxCell => ({ bold: text })

function sheet(name: string, header: string[], rows: XlsxCell[][], widths?: number[]): XlsxSheet {
  return { name, rows: [[b(REPORT_BANNER)], [], header.map(b), ...rows], widths }
}

export function buildXlsxReport(input: ReportInput): Buffer {
  const { session, run, result } = input
  const findingRow = (f: Finding): XlsxCell[] => [
    f.id, f.ruleId, f.ruleVersion, RULE_GROUP_LABEL[f.group], f.severity, EVIDENCE_LABEL[f.evidence], f.title, f.detail, refText(f.refs),
    (f.columns ?? []).join(", "), f.fuel ?? "", f.calculation?.result ?? "", (f.calculation?.qualifications ?? []).join(" | "),
    (f.possibleCauses ?? []).join(" | "), f.recommendation, statusOf(input, f.id), notesFor(input, f.id).map((n) => `${n.createdAt} ${n.createdBy}: ${n.text}`).join(" | "),
    f.schemaVerified ? "yes" : "no (superseded provisional schema)",
  ]
  const summary: XlsxCell[][] = [
    [b(REPORT_BANNER)],
    [],
    [b("Vessel"), session.vessel],
    [b("IMO"), session.imo ?? "not set"],
    [b("Reporting period"), session.config.period ? `${session.config.period.from} to ${session.config.period.to}` : "not set"],
    [b("Session"), `${session.title} (${session._id})`],
    [b("Validation run"), `${run._id}, ${run.startedAt} → ${run.finishedAt ?? ""}, by ${run.actor}`],
    [b("Engine / rule set"), `${result.engineVersion} / ${result.ruleSetVersion}`],
    [b("Schema"), `${result.schema.id} (OVD ${result.schema.ovdVersion}) — ${result.schema.verified ? "verified" : "NOT VERIFIED"}`],
    [b("Configuration hash"), result.configHash],
    [b("Generated"), `${input.generatedAt} by ${input.generatedBy}`],
    [b("Original-file storage"), input.storageProtection],
    [],
    [b("Sources")],
    [b("Kind"), b("File"), b("SHA-256"), b("Bytes"), b("Registered"), b("Integrity before"), b("Integrity after")],
    ...input.artifacts.map((a): XlsxCell[] => [
      a.kind, a.filename, a._id, a.size, `${a.registeredAt} by ${a.registeredBy}`,
      run.integrity.before.find((c) => c.sha256 === a._id)?.ok ? "verified" : "FAILED",
      run.integrity.after.find((c) => c.sha256 === a._id)?.ok ? "verified" : "FAILED",
    ]),
    [],
    [b("Excluded records (kept visible, left out of calculations)")],
    ...(result.exclusions.length ? result.exclusions.map((e): XlsxCell[] => [e.sha256.slice(0, 12), `line ${e.line}`, e.reason, e.found ? "" : "line not found in source"]) : [["none"]]),
    [],
    [b("Summary")],
    ...Object.entries(run.summary ?? {}).map(([k, v]): XlsxCell[] => [k, v]),
    [],
    [b("Coverage notes")],
    ...result.coverage.notes.map((n): XlsxCell[] => [n]),
    [],
    [b("Known limitations")],
    ...limitations(input).map((l): XlsxCell[] => [l]),
  ]

  const calcRows: XlsxCell[][] = []
  for (const f of result.findings) {
    if (!f.calculation) continue
    calcRows.push([f.id, f.ruleId, "Formula", f.calculation.formula])
    for (const i of f.calculation.inputs) calcRows.push([f.id, f.ruleId, "Input", i.label, i.value, i.ref ? refText([i.ref]) : "", i.column ?? ""])
    for (const s of f.calculation.steps) calcRows.push([f.id, f.ruleId, "Step", s])
    calcRows.push([f.id, f.ruleId, "Result", f.calculation.result])
    for (const q of f.calculation.qualifications) calcRows.push([f.id, f.ruleId, "Qualification", q])
  }

  const rec = result.reconciliation
  const recRows: XlsxCell[][] = rec
    ? [
        ...Object.entries(rec.counts).map(([k, v]): XlsxCell[] => ["count", k, v]),
        ["key", rec.keyDefinition],
        ...rec.submittedOnly.map((u): XlsxCell[] => ["LA only", `LA line ${u.ref.line}`, UNMATCHED_LABEL[u.classification], u.nearMatch ? `near OVDLA row ${u.nearMatch.line} (${u.minutesApart} min)` : ""]),
        ...rec.systemOnly.map((u): XlsxCell[] => ["OVDLA only", `OVDLA row ${u.ref.line}`, UNMATCHED_LABEL[u.classification], u.nearMatch ? `near LA line ${u.nearMatch.line} (${u.minutesApart} min)` : ""]),
        ...rec.matches.flatMap((m) => m.differences.map((d): XlsxCell[] => [d.kind === "value" ? "value difference" : "format only", `LA line ${m.submitted.line} / OVDLA row ${m.system.line}`, d.column, d.submitted, d.system])),
        ...rec.ambiguous.map((g): XlsxCell[] => ["ambiguous", `LA lines ${g.submitted.map((r) => r.line).join(", ")}`, `OVDLA rows ${g.system.map((r) => r.line).join(", ")}`]),
      ]
    : [["Reconciliation not run: needs both the LA and the OVDLA."]]

  const fuelRows: XlsxCell[][] = result.fuel.flatMap((a) =>
    a.steps.map((s): XlsxCell[] => [a.source, s.fuel, s.prev.line, s.cur.line, s.status, s.openingRob ?? "", s.bunkers ?? "", s.consumption ?? "", s.expected ?? "", s.closingRob ?? "", s.residual ?? "", s.qualified ? "qualified" : "", s.beyondTolerance ? "beyond threshold" : "", s.reason ?? ""]),
  )

  const dnvRows = input.dnv.map((d): XlsxCell[] => {
    const c = result.correlations.find((x) => x.dnvId === d.id)
    return [
      d.id, DNV_CATEGORIES[d.category].label, d.severity, d.description, d.eventUtc ?? "", d.fromUtc || d.toUtc ? `${d.fromUtc ?? ""} → ${d.toUtc ?? ""}` : "", d.voyageOrPortStay ?? "", d.fuel ?? "", d.quantity ?? "",
      d.entryMethod, d.confirmed ? "confirmed" : "NOT CONFIRMED", d.withdrawn ? "withdrawn" : "", "DNV Reported",
      c ? OUTCOME_LABEL[c.outcome] : "not in this run", c?.explanation ?? "", (c?.matchedFindings ?? []).join(", "), (c?.possibleCauses ?? []).join(" | "), (c?.relatedDnvIds ?? []).join(", "),
    ]
  })

  const sheets: XlsxSheet[] = [
    { name: "Report", rows: summary, widths: [28, 60, 66, 10, 40, 16, 16] },
    sheet("Findings", ["Finding id", "Rule", "Version", "Group", "Severity", "Evidence", "Title", "Detail", "Source records", "Columns", "Fuel", "Result", "Qualifications", "Possible causes (hypotheses)", "Recommended check", "Investigation status", "Notes", "Schema verified"], result.findings.map(findingRow), [22, 6, 7, 20, 9, 22, 50, 70, 30, 24, 6, 14, 60, 60, 50, 22, 40, 18]),
    sheet("Calculations", ["Finding id", "Rule", "Item", "Label / text", "Value", "Source record", "Column"], calcRows, [22, 6, 13, 80, 16, 22, 24]),
    sheet("DNV correlation", ["DNV id", "Category", "Severity", "Description", "Event time (UTC)", "Window (UTC)", "Voyage / port stay", "Fuel", "Quantity", "Entry", "Evidence", "Withdrawn", "Classification", "Outcome", "Explanation", "Matched findings", "Possible causes (hypotheses)", "Related DNV items"], dnvRows),
    sheet("Reconciliation", ["Type", "Record", "Detail", "LA value", "OVDLA value"], recRows, [18, 30, 50, 24, 24]),
    sheet("Fuel balance", ["Source", "Fuel", "From line", "To line", "Status", "Opening ROB", "Bunkers", "Consumption", "Expected", "Closing ROB", "Residual", "Qualified", "Threshold", "Reason"], fuelRows),
    sheet("Coverage", ["Rule", "Version", "Name", "Status", "Evaluated", "Findings", "Reason"], result.coverage.rules.map((r): XlsxCell[] => [r.ruleId, r.ruleVersion, RULES.find((x) => x.id === r.ruleId)?.name ?? "", r.status, r.evaluated, r.findings, r.reason ?? ""]), [7, 8, 44, 16, 10, 9, 80]),
    sheet("Rules", ["Rule", "Version", "Group", "Name", "Logic", "Evidence", "Specification reference", "Tolerance setting", "Severity"], RULES.map((r): XlsxCell[] => [r.id, r.version, RULE_GROUP_LABEL[r.group], r.name, r.logic, EVIDENCE_LABEL[r.evidence], r.specReference ?? "none (independent check)", r.tolerance ?? "", r.severity]), [7, 8, 22, 40, 90, 26, 30, 22, 9]),
    sheet("Investigation", ["Type", "Finding / item", "From", "To / text", "When", "By"], [
      ...input.investigation.history.map((h): XlsxCell[] => ["status", h.findingId, h.from ?? "New", h.to, h.at, h.by]),
      ...input.investigation.notes.map((n): XlsxCell[] => ["note", n.findingId ?? "session", "", n.text, n.createdAt, n.createdBy]),
      ...input.investigation.links.map((l): XlsxCell[] => ["link", `${l.a} ↔ ${l.b}`, "", l.reason, l.createdAt, l.createdBy]),
    ], [10, 40, 22, 70, 22, 16]),
  ]
  return writeXlsx(sheets)
}

export function reportFilename(session: SessionDoc, run: RunDoc, extension: "json" | "xlsx" | "pdf", kind: "DIAGNOSTIC" | "FINDINGS" = "DIAGNOSTIC"): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)
  const period = session.config.period ? `${session.config.period.from}_${session.config.period.to}` : "no-period"
  const prefix = filePrefix(kind === "FINDINGS" ? FINDINGS_PRODUCT_NAME : PRODUCT_NAME)
  return `${prefix}${kind}_${clean(session.vessel)}_${period}_run-${run._id.slice(0, 8)}.${extension}`
}
