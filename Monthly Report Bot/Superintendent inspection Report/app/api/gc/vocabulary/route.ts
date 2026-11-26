import { GC_MODULE, gcHelper, READ_LIMIT } from "@/lib/gc/helper"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · statuses, allowed status steps and owner names for the edit forms (gc_manager/rules.py).
export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, limit: READ_LIMIT, module: GC_MODULE }, async () => json(await gcHelper().call("vocabulary")))
