import { IMAGE_LIMITS } from "@/lib/ocr/image"
import { BadRequest } from "@/lib/server/errors"
import { json, readBody, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { readOvdAdminScreenshot } from "@/lib/server/screenshot"

type Ctx = { params: Promise<{ id: string }> }

export const runtime = "nodejs"

/** Reads an OVD Admin screenshot (PNG body) with the local OCR engine. Stores nothing but an audit entry. */
export const POST = route<Ctx>({ mutating: true, limit: ["ocr", 30] }, async (req, { params }) => {
  const id = (await params).id
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("image/png")) throw new BadRequest("Send the screenshot as image/png.")
  let name = ""
  try {
    name = decodeURIComponent(req.headers.get("x-filename") ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200)
  } catch {
    throw new BadRequest("The file name header is not valid.")
  }
  const bytes = await readBody(req, IMAGE_LIMITS.maxBytes)
  return json(await readOvdAdminScreenshot(getServices(), id, bytes, name))
})
