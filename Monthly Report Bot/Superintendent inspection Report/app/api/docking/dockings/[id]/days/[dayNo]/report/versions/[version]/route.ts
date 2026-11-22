import { dockingStore } from "@/lib/docking/server/instance"
import { pdfHeaders, versionPdf } from "@/lib/docking/server/reports"
import { DD_MODULE } from "@/lib/docking/server/route-kit"
import { route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string; dayNo: string; version: string }> }

/** An issued version's PDF exactly as it was issued (?download=1 saves it instead of opening it). */
export const GET = route<Ctx>({ mutating: false, module: DD_MODULE }, async (req, { params }) => {
  const { id, dayNo, version } = await params
  const { data, file_name } = versionPdf(await dockingStore(), id, dayNo, version)
  return new Response(new Uint8Array(data), { headers: pdfHeaders(file_name, new URL(req.url).searchParams.get("download") !== "1") })
})
