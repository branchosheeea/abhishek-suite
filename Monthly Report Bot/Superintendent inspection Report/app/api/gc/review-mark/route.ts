import { actor } from "@/lib/gc/body"
import { GC_MODULE, gcHelper, WRITE_LIMIT } from "@/lib/gc/helper"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · "I have reviewed the developments" (spec 20): records the time for the signed-in person.
// Developments then count from this time. A sync never sets it.
export const dynamic = "force-dynamic"

export const POST = route({ mutating: true, limit: WRITE_LIMIT, module: GC_MODULE }, async () =>
  json(await gcHelper().call("review.mark", { actor: actor() })))
