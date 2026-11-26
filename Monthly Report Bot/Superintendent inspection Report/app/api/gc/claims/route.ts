import { GC_MODULE, gcHelper, READ_LIMIT } from "@/lib/gc/helper"
import { registerArgs } from "@/lib/gc/params"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · the claim register of one vessel (gc_manager/views.py register). Read-only.
export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, limit: READ_LIMIT, module: GC_MODULE }, async (req) =>
  json(await gcHelper().call("web.register", registerArgs(new URL(req.url)))))
