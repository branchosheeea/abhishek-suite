import { dockingStore } from "@/lib/docking/server/instance"
import { pdfHeaders, previewPdf } from "@/lib/docking/server/reports"
import { DD_MODULE, PDF_LIMIT } from "@/lib/docking/server/route-kit"
import { route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string; dayNo: string }> }

/** The working draft as a PDF (marked DRAFT), opened in the browser to check before issuing. */
export const GET = route<Ctx>({ mutating: false, module: DD_MODULE, limit: PDF_LIMIT }, async (_req, { params }) => {
  const { id, dayNo } = await params
  const { data, file_name } = previewPdf(await dockingStore(), id, dayNo)
  return new Response(new Uint8Array(data), { headers: pdfHeaders(file_name, true) })
})
