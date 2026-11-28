import { actor, readBody, reviewBody } from "@/lib/gc/body"
import { GC_MODULE, gcHelper, WRITE_LIMIT } from "@/lib/gc/helper"
import { idFrom } from "@/lib/gc/params"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · resolve one Review Queue email with the desktop's own rules (Repository.resolve_review,
// resolve_multiple_gc_review): link it to a claim, register its GC number and link, link it to several claims, or
// mark it not relevant. A change with the GC right; audit under the signed-in person.
export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export const POST = route<Ctx>({ mutating: true, limit: WRITE_LIMIT, module: GC_MODULE }, async (req, { params }) => {
  const reviewId = idFrom((await params).id, "Review item")
  const { cmd, args } = reviewBody(await readBody(req))
  return json(await gcHelper().call(cmd, { actor: actor(), review_id: reviewId, ...args }))
})
