import { actor, closeBody, readBody } from "@/lib/gc/body"
import { GC_MODULE, gcHelper, WRITE_LIMIT } from "@/lib/gc/helper"
import { idFrom } from "@/lib/gc/params"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · close a claim with a closure date and reason (Repository.close_claim).
// A change: NeraVeda session with the GC right, same-origin request with the write header, rate limit. The Python
// helper applies the claim rules and records history and audit under the signed-in person.
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export const POST = route<Ctx>({ mutating: true, limit: WRITE_LIMIT, module: GC_MODULE }, async (req, { params }) => {
  const claimId = idFrom((await params).id, "Claim")
  return json(await gcHelper().call("claim.close", { actor: actor(), claim_id: claimId, ...closeBody(await readBody(req)) }))
})
