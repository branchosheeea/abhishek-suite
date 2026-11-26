import { actor, readBody, snoozeBody } from "@/lib/gc/body"
import { GC_MODULE, gcHelper, WRITE_LIMIT } from "@/lib/gc/helper"
import { idFrom } from "@/lib/gc/params"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · snooze (spec 22): hides the claim from the Next Best Action until a date. Due dates, age,
// overdue days and totals do not change. DELETE ends the snooze. Both are changes with the GC right and recorded.
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export const POST = route<Ctx>({ mutating: true, limit: WRITE_LIMIT, module: GC_MODULE }, async (req, { params }) => {
  const claimId = idFrom((await params).id, "Claim")
  return json(await gcHelper().call("claim.snooze", { actor: actor(), claim_id: claimId, ...snoozeBody(await readBody(req)) }))
})

export const DELETE = route<Ctx>({ mutating: true, limit: WRITE_LIMIT, module: GC_MODULE }, async (_req, { params }) => {
  const claimId = idFrom((await params).id, "Claim")
  return json(await gcHelper().call("claim.unsnooze", { actor: actor(), claim_id: claimId }))
})
