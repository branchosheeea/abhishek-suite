import { json, readJson, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { getSession, investigation, listDnv, listRuns, updateSession, type SessionPatch } from "@/lib/server/service"

type Ctx = { params: Promise<{ id: string }> }

export const GET = route<Ctx>({ mutating: false }, async (_req, { params }) => {
  const { id } = await params
  const s = getServices()
  const session = await getSession(s, id)
  const artifacts = await Promise.all(Object.values(session.sources).map((sha) => s.sources.get(sha!)))
  return json({
    session,
    artifacts: artifacts.filter(Boolean),
    dnv: await listDnv(s, id),
    runs: await listRuns(s, id),
    investigation: await investigation(s, id),
  })
})

// Updates the SESSION (title, settings, attached sources, exclusions). Source files are never modified.
export const PATCH = route<Ctx>({ mutating: true, limit: ["write", 120] }, async (req, { params }) => {
  const { id } = await params
  return json(await updateSession(getServices(), id, (await readJson(req)) as SessionPatch))
})
