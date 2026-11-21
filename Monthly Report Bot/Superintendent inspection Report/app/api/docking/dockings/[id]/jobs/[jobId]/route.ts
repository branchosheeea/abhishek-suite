import { jobView } from "@/lib/docking/server/api"
import { dockingStore } from "@/lib/docking/server/instance"
import { DD_MODULE } from "@/lib/docking/server/route-kit"
import { json, route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string; jobId: string }> }

export const GET = route<Ctx>({ mutating: false, module: DD_MODULE }, async (_req, { params }) => {
  const { id, jobId } = await params
  return json(jobView(await dockingStore(), id, jobId))
})
