import { json, readJson, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { addNote, linkFindings } from "@/lib/server/service"

type Ctx = { params: Promise<{ id: string }> }

// Investigation notes are append-only and stored apart from source data. { link: {a, b, reason} } links findings.
export const POST = route<Ctx>({ mutating: true, limit: ["write", 120] }, async (req, { params }) => {
  const { id } = await params
  const body = await readJson(req)
  if (body.link && typeof body.link === "object") return json(await linkFindings(getServices(), id, body.link as Record<string, unknown>), 201)
  return json(await addNote(getServices(), id, body), 201)
})
