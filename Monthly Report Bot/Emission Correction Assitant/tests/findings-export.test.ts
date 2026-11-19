// Findings export for vessel review: selection, PDF (fillable status dropdown per finding) and Excel (status
// dropdown column). Synthetic data only.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { PDFDocument, PDFDropdown, PDFTextField } from "pdf-lib"
import type { Finding } from "../lib/engine/types"
import { exportParams, NO_FILTER, parseExportParams, selectFindings } from "../lib/export/findings-filter"
import { buildFindingsPdf, remarksField, statusField } from "../lib/export/findings-pdf"
import { buildFindingsXlsx } from "../lib/export/findings-xlsx"
import { REPORT_BANNER, reportFilename, statusOf } from "../lib/export/report"
import { readZipDirectory, readZipEntry } from "../lib/parsers/zip"
import { FINDING_STATUSES, memoryDiagnostics } from "../lib/server/diagnostics"
import { loadReportInput } from "../lib/server/reporting"
import { addNote, createSession, registerSource, runSession, type Services, setFindingStatus, updateSession } from "../lib/server/service"
import { MemorySourceStore } from "../lib/server/source-store"
import { baseRows, IMO, ovdlaBytes, toCsv } from "./helpers"

function services(): Services {
  let n = 0
  return {
    sources: new MemorySourceStore(),
    db: memoryDiagnostics(),
    actor: () => "tester",
    now: () => `2026-11-18T00:00:${String(n % 60).padStart(2, "0")}Z`,
    id: () => `id-${String(++n).padStart(6, "0")}`,
  }
}

async function completedRun() {
  const s = services()
  const rows = baseRows().map((r, i) => (i === 1 ? { ...r, LFO_ROB: "470", Distance: "100" } : i === 2 ? { ...r, Time_Since_Previous_Report: "20" } : r))
  const la = await registerSource(s, new TextEncoder().encode(toCsv(rows)), "TEST_LA.csv", "LA")
  const ovdla = await registerSource(s, ovdlaBytes(baseRows().slice(0, 3)), "OVDLA.xlsx", "OVDLA")
  const session = await createSession(s, { vessel: "TEST VESSEL", imo: IMO, period: { from: "2025-01-01", to: "2025-12-31" } })
  for (const [kind, r] of [["LA", la], ["OVDLA", ovdla]] as const) await updateSession(s, session._id, { attach: { kind, sha256: r.artifact._id } })
  const run = await runSession(s, session._id)
  const input = await loadReportInput(s, session._id, run._id, "Application-only (test)")
  return { s, session, run, input }
}

describe("which findings are exported", () => {
  test("errors and warnings by default; all; or exactly the current screen filter", async () => {
    const { input } = await completedRun()
    const all = [...input.result.findings, { ...input.result.findings[0], id: "I01-0000000000000001", severity: "info" as const }]
    const status = (id: string) => statusOf(input, id)
    assert.deepEqual(selectFindings(all, status, "errors-warnings").map((f) => f.severity).filter((x) => x === "info"), [])
    assert.equal(selectFindings(all, status, "errors-warnings").length, all.length - all.filter((f) => f.severity === "info").length)
    assert.equal(selectFindings(all, status, "all").length, all.length)
    const d02 = selectFindings(all, status, "filter", { ...NO_FILTER, query: "D02" })
    assert.ok(d02.length > 0 && d02.every((f) => f.ruleId === "D02"))
    const p = exportParams("filter", { ...NO_FILTER, severity: "error", query: "line 3" })
    assert.deepEqual(parseExportParams(p, FINDING_STATUSES).filter, { ...NO_FILTER, severity: "error", query: "line 3" })
    assert.throws(() => parseExportParams(new URLSearchParams({ scope: "everything" }), FINDING_STATUSES), /scope/)
    assert.throws(() => parseExportParams(new URLSearchParams({ scope: "filter", status: "Done" }), FINDING_STATUSES), /status/)
  })
})

describe("findings PDF for vessel review", () => {
  test("one status dropdown (the 5 statuses, current status selected) and one remarks field per finding; banner metadata", async () => {
    const { s, session, input: before } = await completedRun()
    const target = before.result.findings.find((f) => f.severity !== "info")!
    await setFindingStatus(s, session._id, target.id, "Awaiting Vessel Clarification")
    await addNote(s, session._id, { findingId: target.id, text: "Internal: chase the chief engineer" })
    const input = await loadReportInput(s, session._id, before.run._id, "Application-only (test)")
    const findings = selectFindings(input.result.findings, (id) => statusOf(input, id), "errors-warnings")
    const bytes = await buildFindingsPdf(input, findings, { scope: "errors-warnings", includeNotes: false })
    const pdf = await PDFDocument.load(bytes)
    assert.equal(pdf.getSubject(), REPORT_BANNER)
    assert.ok(pdf.getPageCount() >= 2)
    const form = pdf.getForm()
    for (const f of findings) {
      const dd = form.getField(statusField(f.id))
      assert.ok(dd instanceof PDFDropdown)
      assert.deepEqual(dd.getOptions(), [...FINDING_STATUSES])
      assert.deepEqual(dd.getSelected(), [f.id === target.id ? "Awaiting Vessel Clarification" : "New"])
      assert.ok(form.getField(remarksField(f.id)) instanceof PDFTextField)
    }
    assert.equal(form.getFields().length, findings.length * 2)
    // office notes are left out unless asked for
    const raw = Buffer.from(bytes).toString("latin1")
    assert.ok(!raw.includes("chase the chief engineer"))
  })

  test("symbols used in finding texts are drawn, and characters the font lacks are replaced instead of failing", async () => {
    const { input } = await completedRun()
    const base = input.result.findings.find((f) => f.calculation)!
    const odd: Finding = { ...base, id: "X99-0000000000000001", title: "Σ residual −7.25 mt → 2× threshold ≤ ≥ … 🚢", detail: "Tab\tand\nnew line, NBSP and control \u0007 characters." }
    const bytes = await buildFindingsPdf(input, [odd], { scope: "filter", includeNotes: true })
    const pdf = await PDFDocument.load(bytes)
    assert.ok(pdf.getForm().getField(statusField(odd.id)))
  })

  test("a long export paginates and every finding keeps its fields", async () => {
    const { input } = await completedRun()
    const base = input.result.findings.find((f) => f.calculation)!
    const many: Finding[] = Array.from({ length: 40 }, (_, i) => ({ ...base, id: `Y${String(i).padStart(2, "0")}-${"0".repeat(15)}${i % 10}`, detail: `${base.detail} `.repeat(4) }))
    const pdf = await PDFDocument.load(await buildFindingsPdf(input, many, { scope: "all", includeNotes: false }))
    assert.ok(pdf.getPageCount() >= 20)
    assert.equal(pdf.getForm().getFields().length, 80)
  })
})

describe("findings Excel for vessel review", () => {
  test("banner on every sheet, status dropdown over the status column, empty remarks, formula-like text kept as text", async () => {
    const { input } = await completedRun()
    const findings = selectFindings(input.result.findings, (id) => statusOf(input, id), "errors-warnings")
    const xlsx = buildFindingsXlsx(input, findings, { scope: "errors-warnings", includeNotes: false })
    const sheets = readZipDirectory(xlsx).filter((e) => e.name.startsWith("xl/worksheets/"))
    assert.equal(sheets.length, 3)
    const text = sheets.map((e) => readZipEntry(xlsx, e).toString("utf8"))
    for (const t of text) assert.ok(t.includes(REPORT_BANNER))
    const findingsSheet = text[1]
    assert.match(findingsSheet, new RegExp(`<dataValidation type="list"[^>]*sqref="P5:P${4 + findings.length}"><formula1>&quot;New,Under Investigation,Awaiting Vessel Clarification,Reviewed,Closed&quot;</formula1>`))
    assert.match(findingsSheet, /<pane ySplit="4" topLeftCell="A5"/)
    assert.match(findingsSheet, /<autoFilter ref="A4:R\d+"\/>/)
    assert.ok(!/<f>/.test(text.join("")))
    // the remarks column (Q) of the first finding row exists and is empty
    assert.match(findingsSheet, /<c r="Q5" t="inlineStr" s="\d+"><is><t xml:space="preserve"><\/t><\/is><\/c>/)
    const workbook = readZipEntry(xlsx, readZipDirectory(xlsx).find((e) => e.name === "xl/workbook.xml")!).toString("utf8")
    assert.match(workbook, /<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">'Findings'!\$A\$4:\$R\$\d+<\/definedName>/)
  })

  test("export file names say FINDINGS and are never reporting-file names", async () => {
    const { input } = await completedRun()
    assert.match(reportFilename(input.session, input.run, "pdf", "FINDINGS"), /^NERAVEDA-FINDINGS_TEST-VESSEL_2025-01-01_2025-12-31_run-.+\.pdf$/)
  })
})
