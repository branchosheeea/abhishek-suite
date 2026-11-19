import { json, readJson, route } from "@/lib/server/http"
import { getServices } from "@/lib/server/runtime"
import { createSession } from "@/lib/server/service"

export const GET = route({ mutating: false }, async () => {
  const s = getServices()
  const sessions = await s.db.sessions.find({}, { sort: "updatedAt", descending: true, limit: 200 })
  const withRuns = await Promise.all(
    sessions.map(async (session) => {
      const [latest] = await s.db.runs.find({ sessionId: session._id }, { sort: "startedAt", descending: true, limit: 1 })
      return { ...session, latestRun: latest ? { _id: latest._id, state: latest.state, startedAt: latest.startedAt, summary: latest.summary } : null }
    }),
  )
  return json({ sessions: withRuns })
})

export const POST = route({ mutating: true, limit: ["write", 120] }, async (req) => json(await createSession(getServices(), await readJson(req)), 201))
