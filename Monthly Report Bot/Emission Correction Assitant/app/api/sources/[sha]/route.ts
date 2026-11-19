import { mapHeaders } from "@/lib/engine/schema"
import { json, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { loadTable } from "@/lib/server/service"

type Ctx = { params: Promise<{ sha: string }> }

// Read-only view of a registered source: exact original cell text, original line numbers, parse issues and the
// schema's column mapping. Rows are paged. GET only.
export const GET = route<Ctx>({ mutating: false }, async (req, { params }) => {
  const { sha } = await params
  const url = new URL(req.url)
  const sheet = url.searchParams.get("sheet") ?? undefined
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0)
  const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get("limit") ?? 2000) || 2000))
  const { artifact, table, sheets } = await loadTable(getServices(), sha, sheet)
  return json({
    artifact,
    sheets,
    map: mapHeaders(table.headers, table.kind),
    table: {
      kind: table.kind,
      sha256: table.sha256,
      filename: table.filename,
      format: table.format,
      headerLine: table.headerLine,
      headers: table.headers,
      meta: table.meta,
      issues: table.issues,
      totalRows: table.rows.length,
      offset,
      rows: table.rows.slice(offset, offset + limit).map((r) => ({ index: r.index, line: r.line, cells: r.cells, blankLine: r.blankLine, dateFormatted: r.dateFormatted })),
    },
  })
})
