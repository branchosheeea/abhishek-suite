import { activityActionFrom, readBody } from "@/lib/docking/server/api"
import { dockingStore } from "@/lib/docking/server/instance"
import { actor, DD_MODULE, WRITE_LIMIT } from "@/lib/docking/server/route-kit"
import { json, route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string; activityId: string }> }

/** { action: "link", jobId } · { action: "unlink", reason } · { action: "new_job", title, area } */
export const POST = route<Ctx>({ mutating: true, module: DD_MODULE, limit: WRITE_LIMIT }, async (req, { params }) => {
  const { id, activityId } = await params
  return json({ job: activityActionFrom(await dockingStore(), id, activityId, await readBody(req), actor()) })
})
