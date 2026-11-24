import { readBody } from "@/lib/docking/server/api"
import { getDb, getMongoClient } from "@/lib/mongodb"
import { AppError } from "@/lib/server/errors"
import { json, route } from "@/lib/server/http"
import { actor } from "@/lib/server/report-audit"
import { VESSEL_ID_PATTERN } from "@/lib/vessel-master/flags"
import { verifyField } from "@/lib/vessel-master/repo"
import { verificationFrom } from "@/lib/vessel-master/verify"
import { vesselView } from "@/lib/vessel-master/view"

// Vessel Master · "Verify on board" (any SIR user, with evidence): the master value becomes VERIFIED at once and the
// evidence is recorded (lib/vessel-master/verify.ts has the rules and safeguards).

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export const POST = route<Ctx>({ mutating: true, limit: ["vessel-verify", 60] }, async (req, { params }) => {
  const { id } = await params
  if (!VESSEL_ID_PATTERN.test(id)) throw new AppError(400, "Not a vessel id.")
  const body = await readBody(req, 8_000)
  const who = actor()
  const db = await getDb()
  const result = await verifyField(await getMongoClient(), db, id, (vessel) => verificationFrom(body, vessel, who))
  const view = vesselView(result.doc)
  return json({ verification: result.verification, vessel: view, fetchedAt: new Date().toISOString() }, 201)
})
