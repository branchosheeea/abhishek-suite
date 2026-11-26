import { GC_MODULE, gcHelper, READ_LIMIT } from "@/lib/gc/helper"
import { vesselArgs } from "@/lib/gc/params"
import { currentUser } from "@/lib/server/auth"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · Command Centre facts for one vessel (gc_manager/views.py overview). Read-only.
export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, limit: READ_LIMIT, module: GC_MODULE }, async (req) =>
  json(await gcHelper().call("web.overview", { ...vesselArgs(new URL(req.url)), user: currentUser()?.sub ?? "" })))
