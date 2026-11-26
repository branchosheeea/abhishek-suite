import { GC_MODULE, gcHelper, READ_LIMIT } from "@/lib/gc/helper"
import { vesselArgs } from "@/lib/gc/params"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · open review items of one vessel and those without a vessel (gc_manager/views.py reviews).
export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, limit: READ_LIMIT, module: GC_MODULE }, async (req) =>
  json(await gcHelper().call("web.reviews", vesselArgs(new URL(req.url)))))
