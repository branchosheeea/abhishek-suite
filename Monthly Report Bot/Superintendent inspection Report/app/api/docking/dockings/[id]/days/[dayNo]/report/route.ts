import { readBody } from "@/lib/docking/server/api"
import { dockingStore } from "@/lib/docking/server/instance"
import { reportActionFrom, reportView } from "@/lib/docking/server/reports"
import { actor, actorName, DD_MODULE, WRITE_LIMIT } from "@/lib/docking/server/route-kit"
import { json, route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string; dayNo: string }> }

/** The day's Daily Report: the working draft, the issued versions and what stands in the way of issuing. */
export const GET = route<Ctx>({ mutating: false, module: DD_MODULE }, async (_req, { params }) => {
  const { id, dayNo } = await params
  return json(reportView(await dockingStore(), id, dayNo))
})

/** { action: "start" } · { action: "save", rev, content } · { action: "rebuild", rev } · { action: "issue", rev, reason? } */
export const POST = route<Ctx>({ mutating: true, module: DD_MODULE, limit: WRITE_LIMIT }, async (req, { params }) => {
  const { id, dayNo } = await params
  return json(reportActionFrom(await dockingStore(), id, dayNo, await readBody(req, 1024 * 1024), actor(), actorName()))
})
