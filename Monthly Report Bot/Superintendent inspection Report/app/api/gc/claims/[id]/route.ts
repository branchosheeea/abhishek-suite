import { actor, readBody, updateBody } from "@/lib/gc/body"
import { GC_MODULE, gcHelper, READ_LIMIT, WRITE_LIMIT } from "@/lib/gc/helper"
import { idFrom } from "@/lib/gc/params"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · one claim: controlled record, story, status history and its emails (without bodies).
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export const GET = route<Ctx>({ mutating: false, limit: READ_LIMIT, module: GC_MODULE }, async (_req, { params }) =>
  json(await gcHelper().call("web.claim", { claim_id: idFrom((await params).id, "Claim") })))

// Edit the claim record (Repository.update_claim): a change with the GC right; history and audit under the person.
export const PATCH = route<Ctx>({ mutating: true, limit: WRITE_LIMIT, module: GC_MODULE }, async (req, { params }) => {
  const claimId = idFrom((await params).id, "Claim")
  return json(await gcHelper().call("claim.update", { actor: actor(), claim_id: claimId, ...updateBody(await readBody(req)) }))
})
