import { GC_MODULE, gcHelper, READ_LIMIT } from "@/lib/gc/helper"
import { vesselArgs } from "@/lib/gc/params"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · guided register set-up: open claims with the suggestions from their emails and the quoted
// sentence (gc_manager/views.py setup). Read-only: confirming a suggestion arrives with the controlled writes.
export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, limit: READ_LIMIT, module: GC_MODULE }, async (req) =>
  json(await gcHelper().call("web.setup", vesselArgs(new URL(req.url)))))
