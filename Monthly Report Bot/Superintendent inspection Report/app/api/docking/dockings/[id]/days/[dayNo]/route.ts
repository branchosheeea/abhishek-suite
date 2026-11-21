import { dayActionFrom, readBody } from "@/lib/docking/server/api"
import { dockingStore } from "@/lib/docking/server/instance"
import { actor, DD_MODULE, WRITE_LIMIT } from "@/lib/docking/server/route-kit"
import { json, route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string; dayNo: string }> }

/** { action: "no_report", reason } or { action: "reviewed" } */
export const POST = route<Ctx>({ mutating: true, module: DD_MODULE, limit: WRITE_LIMIT }, async (req, { params }) => {
  const { id, dayNo } = await params
  return json({ day: dayActionFrom(await dockingStore(), id, dayNo, await readBody(req), actor()) })
})
