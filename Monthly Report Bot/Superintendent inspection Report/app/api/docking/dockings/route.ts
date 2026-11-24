import { createDockingFrom, dockingsView, readBody } from "@/lib/docking/server/api"
import { dockingFleet } from "@/lib/docking/server/fleet"
import { dockingStore } from "@/lib/docking/server/instance"
import { actor, DD_MODULE, WRITE_LIMIT } from "@/lib/docking/server/route-kit"
import { json, route } from "@/lib/server/http"

export const GET = route({ mutating: false, module: DD_MODULE }, async () => json({ dockings: dockingsView(await dockingStore()) }))

export const POST = route({ mutating: true, module: DD_MODULE, limit: WRITE_LIMIT }, async (req) =>
  json({ docking: createDockingFrom(await dockingStore(), await readBody(req), actor(), await dockingFleet()) }, 201))
