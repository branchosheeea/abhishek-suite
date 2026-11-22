import { dockingStore } from "@/lib/docking/server/instance"
import { checkImport, readUpload, runImport } from "@/lib/docking/server/imports"
import { actor, DD_MODULE, IMPORT_LIMIT } from "@/lib/docking/server/route-kit"
import { json, route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string }> }

/**
 * A vessel's daily workbook, as multipart form data (file, reportDate?, receivedVia?, correctionReason?).
 * ?mode=check reads it and says what would happen, storing nothing; without it the file is imported.
 */
export const POST = route<Ctx>({ mutating: true, module: DD_MODULE, limit: IMPORT_LIMIT }, async (req, { params }) => {
  const { id } = await params
  const { upload, fields } = await readUpload(req)
  const store = await dockingStore()
  if (new URL(req.url).searchParams.get("mode") === "check") return json({ plan: await checkImport(store, id, upload, fields) })
  return json(await runImport(store, id, upload, fields, actor()))
})
