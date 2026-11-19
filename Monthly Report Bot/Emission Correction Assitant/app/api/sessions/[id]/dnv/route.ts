import { json, readJson, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { addDnv, addDnvBatch, listDnv } from "@/lib/server/service"

type Ctx = { params: Promise<{ id: string }> }

export const GET = route<Ctx>({ mutating: false }, async (_req, { params }) => json({ dnv: await listDnv(getServices(), (await params).id) }))

/** One entry, or { items: [...] } for several (e.g. read from OVD Admin screenshots). */
export const POST = route<Ctx>({ mutating: true, limit: ["write", 120] }, async (req, { params }) => {
  const id = (await params).id
  const body = await readJson(req, 1_000_000)
  return json(Array.isArray(body.items) ? await addDnvBatch(getServices(), id, body.items) : await addDnv(getServices(), id, body), 201)
})
