import { auditView } from "@/lib/docking/server/api"
import { dockingStore } from "@/lib/docking/server/instance"
import { DD_MODULE } from "@/lib/docking/server/route-kit"
import { json, route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string }> }

export const GET = route<Ctx>({ mutating: false, module: DD_MODULE }, async (_req, { params }) => {
  const { id } = await params
  return json({ audit: auditView(await dockingStore(), id) })
})
