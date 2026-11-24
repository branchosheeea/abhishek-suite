import { getDb } from "@/lib/mongodb"
import { AppError } from "@/lib/server/errors"
import { json, route } from "@/lib/server/http"
import { VESSEL_ID_PATTERN } from "@/lib/vessel-master/flags"
import { flagsOf, getVessel, referenceRows, revisionsOf } from "@/lib/vessel-master/repo"
import { vesselView } from "@/lib/vessel-master/view"

// Vessel Master · one vessel as the SIR sees it (six groups, each value with its status and release). With ?review=1
// also its sources, data-quality items, reported issues and revisions, for the review page. Read-only.

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export const GET = route<Ctx>({ mutating: false, limit: ["vessels", 240] }, async (req, { params }) => {
  const { id } = await params
  if (!VESSEL_ID_PATTERN.test(id)) throw new AppError(400, "Not a vessel id.")
  const db = await getDb()
  const vessel = await getVessel(db, id)
  if (!vessel) throw new AppError(404, "This vessel is not in the Vessel Master.")
  const view = vesselView(vessel)
  if (new URL(req.url).searchParams.get("review") !== "1") return json({ vessel: view, fetchedAt: new Date().toISOString() })
  const [{ sources, issues }, flags, revisions] = await Promise.all([referenceRows(db, vessel.workbookId), flagsOf(db, id), revisionsOf(db, id)])
  return json({
    vessel: view, sources, issues, flags,
    revisions: revisions.map((r) => ({ revision: r.revision, at: r.at, by: r.by, reason: r.reason, changed: Array.isArray(r.changes) ? r.changes.length : 0 })),
    fetchedAt: new Date().toISOString(),
  })
})
