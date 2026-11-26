import { actor } from "@/lib/gc/body"
import { GC_MODULE, gcHelper, READ_LIMIT, WRITE_LIMIT } from "@/lib/gc/helper"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager · Outlook sync (Phase 5). GET: the true state (running, last success, last error, sign-in
// needed). POST: "Sync now", started in the background in the Python helper (one sync at a time on this PC).
export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, limit: READ_LIMIT, module: GC_MODULE }, async () => json(await gcHelper().call("sync.state")))

export const POST = route({ mutating: true, limit: WRITE_LIMIT, module: GC_MODULE }, async () =>
  json(await gcHelper().call("sync.run", { actor: actor() })))
