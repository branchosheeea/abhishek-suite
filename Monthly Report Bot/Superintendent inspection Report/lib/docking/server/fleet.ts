import "server-only"
import { getDb } from "../../mongodb"
import { listVessels } from "../../vessel-master/repo"
import { isSelectable } from "../../vessel-master/view"
import { DEFAULT_FLEET, type FleetVessel } from "./repo"

// Vessels a docking can be for: the Vessel Master's vessels (as offered for new inspection reports), with the key
// existing records use ("DHT_LEOPARD"). If the master cannot be read, the fixed fleet list, so Docking keeps working.
// Kept for five minutes.

let cached: { at: number; fleet: readonly FleetVessel[] } | undefined

export async function dockingFleet(): Promise<readonly FleetVessel[]> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.fleet
  try {
    const fleet = (await listVessels(await getDb())).filter(isSelectable)
      .map((v) => ({ name: v.name, key: v.legacyKeys[0] ?? v.name.toUpperCase().replace(/\s+/g, "_") }))
    if (fleet.length) {
      cached = { at: Date.now(), fleet }
      return fleet
    }
  } catch (error) {
    console.error("[docking] Vessel Master not readable; using the fixed fleet list:", error)
  }
  return DEFAULT_FLEET
}
