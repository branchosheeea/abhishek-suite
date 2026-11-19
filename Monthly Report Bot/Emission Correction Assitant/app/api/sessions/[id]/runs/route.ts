import { json, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { listRuns, runSession } from "@/lib/server/service"

type Ctx = { params: Promise<{ id: string }> }

export const GET = route<Ctx>({ mutating: false }, async (_req, { params }) => json({ runs: await listRuns(getServices(), (await params).id) }))

export const POST = route<Ctx>({ mutating: true, limit: ["run", 30] }, async (_req, { params }) => {
  const run = await runSession(getServices(), (await params).id)
  const { resultJson: _r, ...summary } = run
  return json(summary, 201)
})
