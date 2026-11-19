import { buildJsonReport, buildXlsxReport, reportFilename } from "@/lib/export/report"
import { BadRequest } from "@/lib/server/errors"
import { route } from "@/lib/server/http"
import { loadReportInput, recordReport } from "@/lib/server/reporting"
import { getServices, protectionStatus } from "@/lib/server/runtime"

type Ctx = { params: Promise<{ id: string; runId: string }> }

// Diagnostic report download. Built in memory and streamed to the browser; it is never written to the source
// store or to any location holding original files.
export const GET = route<Ctx>({ mutating: false, limit: ["report", 60] }, async (req, { params }) => {
  const { id, runId } = await params
  const format = new URL(req.url).searchParams.get("format") ?? "xlsx"
  if (format !== "json" && format !== "xlsx") throw new BadRequest("format must be json or xlsx.")
  const s = getServices()
  const input = await loadReportInput(s, id, runId, (await protectionStatus()).summary)
  const bytes = format === "json" ? Buffer.from(JSON.stringify(buildJsonReport(input), null, 2)) : buildXlsxReport(input)
  const filename = reportFilename(input.session, input.run, format)
  await recordReport(s, input, format, bytes, filename)
  return new Response(bytes, {
    headers: {
      "Content-Type": format === "json" ? "application/json" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
})
