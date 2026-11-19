import { FilterError, parseExportParams, selectFindings } from "@/lib/export/findings-filter"
import { buildFindingsPdf } from "@/lib/export/findings-pdf"
import { buildFindingsXlsx } from "@/lib/export/findings-xlsx"
import { reportFilename, statusOf } from "@/lib/export/report"
import { FINDING_STATUSES } from "@/lib/server/diagnostics"
import { BadRequest } from "@/lib/server/errors"
import { route } from "@/lib/server/http"
import { loadReportInput, recordReport } from "@/lib/server/reporting"
import { getServices, protectionStatus } from "@/lib/server/runtime"

type Ctx = { params: Promise<{ id: string; runId: string }> }

export const runtime = "nodejs"

// Findings export for vessel review: PDF (with a fillable status dropdown per finding) or Excel. Built in memory,
// streamed to the browser, recorded with its SHA-256 and audited; never written next to original files.
export const GET = route<Ctx>({ mutating: false, limit: ["report", 60] }, async (req, { params }) => {
  const { id, runId } = await params
  const url = new URL(req.url)
  const format = url.searchParams.get("format") ?? "pdf"
  if (format !== "pdf" && format !== "xlsx") throw new BadRequest("format must be pdf or xlsx.")
  let selection
  try {
    selection = parseExportParams(url.searchParams, FINDING_STATUSES)
  } catch (error) {
    throw error instanceof FilterError ? new BadRequest(error.message) : error
  }
  const includeNotes = url.searchParams.get("notes") === "1"
  const s = getServices()
  const input = await loadReportInput(s, id, runId, (await protectionStatus()).summary)
  const findings = selectFindings(input.result.findings, (fid) => statusOf(input, fid), selection.scope, selection.filter)
  const options = { scope: selection.scope, includeNotes }
  const bytes = format === "pdf" ? await buildFindingsPdf(input, findings, options) : buildFindingsXlsx(input, findings, options)
  const filename = reportFilename(input.session, input.run, format, "FINDINGS")
  await recordReport(s, input, format === "pdf" ? "findings-pdf" : "findings-xlsx", bytes, filename)
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
})
