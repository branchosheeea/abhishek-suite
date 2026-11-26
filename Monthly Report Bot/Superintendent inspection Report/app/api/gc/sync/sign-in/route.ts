import { actor } from "@/lib/gc/body"
import { GC_MODULE, gcHelper, WRITE_LIMIT } from "@/lib/gc/helper"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · start a Microsoft device sign-in for Outlook (same app, same read-only access). The code
// comes back to the signed-in person's page only; it is kept in the helper's memory and never logged.
export const dynamic = "force-dynamic"

export const POST = route({ mutating: true, limit: WRITE_LIMIT, module: GC_MODULE }, async () =>
  json(await gcHelper().call("sync.sign_in", { actor: actor() })))
