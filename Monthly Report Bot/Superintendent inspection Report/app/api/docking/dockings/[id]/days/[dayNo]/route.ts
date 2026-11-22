import { dayActionFrom, dayView, readBody } from "@/lib/docking/server/api"
import { dockingStore } from "@/lib/docking/server/instance"
import { actor, DD_MODULE, WRITE_LIMIT } from "@/lib/docking/server/route-kit"
import { json, route } from "@/lib/server/http"

type Ctx = { params: Promise<{ id: string; dayNo: string }> }

/** The day as received: each department's file, entries with photos and job links, and the notes. */
export const GET = route<Ctx>({ mutating: false, module: DD_MODULE }, async (_req, { params }) => {
  const { id, dayNo } = await params
  return json(dayView(await dockingStore(), id, dayNo))
})

/** { action: "no_report", reason } or { action: "reviewed" } */
export const POST = route<Ctx>({ mutating: true, module: DD_MODULE, limit: WRITE_LIMIT }, async (req, { params }) => {
  const { id, dayNo } = await params
  return json({ day: dayActionFrom(await dockingStore(), id, dayNo, await readBody(req), actor()) })
})
