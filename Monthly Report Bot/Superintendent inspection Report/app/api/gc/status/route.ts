import { GC_MODULE, gcHelper, READ_LIMIT } from "@/lib/gc/helper"
import { json, route } from "@/lib/server/http"

// Guarantee Claim Manager (Phase 1): is the Python claim helper answering? Needs the NeraVeda session and the
// Guarantee Claim Manager right. Read-only; returns no claim data.
export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, limit: READ_LIMIT, module: GC_MODULE }, async () => json({ helper: await gcHelper().call("ping") }))
