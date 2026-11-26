import { GC_MODULE, gcHelper, READ_LIMIT } from "@/lib/gc/helper"
import { correspondenceArgs } from "@/lib/gc/params"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · stored claim emails of one vessel, newest first, 50 at a time; the search also looks in the
// stored email text, which is never sent to the browser (gc_manager/views.py correspondence). Read-only.
export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, limit: READ_LIMIT, module: GC_MODULE }, async (req) =>
  json(await gcHelper().call("web.correspondence", correspondenceArgs(new URL(req.url)))))
