import { UPLOAD_LIMITS } from "@/lib/parsers"
import { BadRequest } from "@/lib/server/errors"
import { json, readBody, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { assertKind, registerSource } from "@/lib/server/service"

// Original source files: list and REGISTER only. There is deliberately no PUT, PATCH or DELETE here or under
// /api/sources/[sha]; registered files cannot be changed, replaced or removed through the application.

export const GET = route({ mutating: false }, async () => json({ sources: await getServices().sources.list() }))

export const POST = route({ mutating: true, limit: ["upload", 30] }, async (req) => {
  const url = new URL(req.url)
  const kind = assertKind(url.searchParams.get("kind"))
  let filename = ""
  try {
    filename = decodeURIComponent(req.headers.get("x-filename") ?? "")
  } catch {
    throw new BadRequest("The file name header is not valid.")
  }
  const bytes = await readBody(req, UPLOAD_LIMITS.maxBytes)
  const result = await registerSource(getServices(), bytes, filename, kind)
  return json(result, result.created ? 201 : 200)
})
