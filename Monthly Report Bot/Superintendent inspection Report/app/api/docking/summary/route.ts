import { dockingStore } from "@/lib/docking/server/instance"
import { DD_MODULE } from "@/lib/docking/server/route-kit"
import { dockingsSummary } from "@/lib/docking/server/summary"
import { json, route } from "@/lib/server/http"

// Read-only summary for the NeraVeda desktop Home page (lib/docking/server/summary.ts). The launcher reads it with a
// 60 s service ticket while this server runs; a signed-in browser with the Digital Docking right may read it too.
export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, auth: "user-or-service", module: DD_MODULE }, async () => json(dockingsSummary(await dockingStore())))
