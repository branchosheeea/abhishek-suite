import { json, route } from "@/lib/server/http"
import { configured, getServices } from "@/lib/server/runtime"

// Small summary for the NeraVeda desktop Home (latest completed run per session). Read-only. The launcher calls it
// with a 60 s service ticket; a signed-in browser may read it too.
export const GET = route({ mutating: false, auth: "user-or-service" }, async () => {
  if (!configured()) return json({ configured: false, sessions: [] })
  const s = getServices()
  const sessions = await s.db.sessions.find({}, { sort: "updatedAt", descending: true, limit: 50 })
  const out = []
  for (const session of sessions) {
    const [run] = (await s.db.runs.find({ sessionId: session._id }, { sort: "startedAt", descending: true, limit: 10 })).filter((r) => r.state === "completed")
    out.push({
      id: session._id, title: session.title, vessel: session.vessel, period: session.config.period,
      run: run ? { id: run._id, finishedAt: run.finishedAt, summary: run.summary } : null,
    })
  }
  return json({ configured: true, generatedAt: s.now(), sessions: out })
})
