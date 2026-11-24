import { readBody } from "@/lib/docking/server/api"
import { getDb } from "@/lib/mongodb"
import { AppError } from "@/lib/server/errors"
import { json, route } from "@/lib/server/http"
import { actor } from "@/lib/server/report-audit"
import { flagFrom, VESSEL_ID_PATTERN } from "@/lib/vessel-master/flags"
import { flagsOf, getVessel, insertFlag } from "@/lib/vessel-master/repo"

// Vessel Master · "Report master data issue" (any SIR user). Recorded for review; the master itself is not changed.

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

async function vesselFor(params: Ctx["params"]) {
  const { id } = await params
  if (!VESSEL_ID_PATTERN.test(id)) throw new AppError(400, "Not a vessel id.")
  const db = await getDb()
  const vessel = await getVessel(db, id)
  if (!vessel) throw new AppError(404, "This vessel is not in the Vessel Master.")
  return { db, vessel }
}

export const GET = route<Ctx>({ mutating: false, limit: ["vessels", 240] }, async (_req, { params }) => {
  const { db, vessel } = await vesselFor(params)
  return json({ flags: await flagsOf(db, vessel.vesselId) })
})

export const POST = route<Ctx>({ mutating: true, limit: ["vessel-flags", 30] }, async (req, { params }) => {
  const { db, vessel } = await vesselFor(params)
  const flag = flagFrom(await readBody(req, 8_000), vessel, actor())
  await insertFlag(db, flag)
  return json({ flag }, 201)
})
