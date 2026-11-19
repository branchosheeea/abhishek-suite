import { json, readJson, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { setFindingStatus } from "@/lib/server/service"

type Ctx = { params: Promise<{ id: string; findingId: string }> }

export const POST = route<Ctx>({ mutating: true, limit: ["write", 120] }, async (req, { params }) => {
  const { id, findingId } = await params
  const body = await readJson(req)
  return json(await setFindingStatus(getServices(), id, findingId, body.status))
})
