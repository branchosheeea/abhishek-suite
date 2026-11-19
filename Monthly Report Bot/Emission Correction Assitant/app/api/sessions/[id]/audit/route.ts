import { json, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { getSession, listAudit } from "@/lib/server/service"

type Ctx = { params: Promise<{ id: string }> }

export const GET = route<Ctx>({ mutating: false }, async (_req, { params }) => {
  const { id } = await params
  const s = getServices()
  await getSession(s, id)
  return json({ audit: await listAudit(s, id) })
})
