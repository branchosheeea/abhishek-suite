import { createJobFrom, readBody } from "@/lib/docking/server/api"
import { dockingStore } from "@/lib/docking/server/instance"
import { actor, DD_MODULE, WRITE_LIMIT } from "@/lib/docking/server/route-kit"
import { json, route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string }> }

export const POST = route<Ctx>({ mutating: true, module: DD_MODULE, limit: WRITE_LIMIT }, async (req, { params }) => {
  const { id } = await params
  return json({ job: createJobFrom(await dockingStore(), id, await readBody(req), actor()) }, 201)
})
