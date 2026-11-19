import { json, readJson, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { updateDnv } from "@/lib/server/service"

type Ctx = { params: Promise<{ id: string; dnvId: string }> }

// Edit, confirm or withdraw a DNV entry (application-owned record). Withdrawn entries stay in the audit trail.
export const PATCH = route<Ctx>({ mutating: true, limit: ["write", 120] }, async (req, { params }) => {
  const { id, dnvId } = await params
  return json(await updateDnv(getServices(), id, dnvId, await readJson(req)))
})
