import { json, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { getRun } from "@/lib/server/service"

type Ctx = { params: Promise<{ id: string; runId: string }> }

export const GET = route<Ctx>({ mutating: false }, async (_req, { params }) => {
  const { id, runId } = await params
  const { resultJson, ...run } = await getRun(getServices(), id, runId)
  return json({ run, result: resultJson ? JSON.parse(resultJson) : null })
})
