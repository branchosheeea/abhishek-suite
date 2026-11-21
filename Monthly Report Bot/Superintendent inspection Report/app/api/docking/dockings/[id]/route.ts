import { dockingView, readBody, updateDockingFrom } from "@/lib/docking/server/api"
import { dockingStore } from "@/lib/docking/server/instance"
import { actor, DD_MODULE, WRITE_LIMIT } from "@/lib/docking/server/route-kit"
import { json, route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string }> }

export const GET = route<Ctx>({ mutating: false, module: DD_MODULE }, async (_req, { params }) => {
  const { id } = await params
  return json(dockingView(await dockingStore(), id))
})

export const PATCH = route<Ctx>({ mutating: true, module: DD_MODULE, limit: WRITE_LIMIT }, async (req, { params }) => {
  const { id } = await params
  return json({ docking: updateDockingFrom(await dockingStore(), id, await readBody(req), actor()) })
})
