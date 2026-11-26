import { GC_MODULE, gcHelper, READ_LIMIT } from "@/lib/gc/helper"
import { searchArgs } from "@/lib/gc/params"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · Ctrl+K search over the vessel's claims and stored correspondence (gc_manager/views.py search).
export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, limit: READ_LIMIT, module: GC_MODULE }, async (req) =>
  json(await gcHelper().call("web.search", searchArgs(new URL(req.url)))))
