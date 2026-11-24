import { getDb } from "@/lib/mongodb"
import { json, route } from "@/lib/server/http"
import { listVessels } from "@/lib/vessel-master/repo"
import { pickerEntry } from "@/lib/vessel-master/view"

// Vessel Master · the vessel list for the SIR (picker and review page). Read-only: the master is written only by the
// admin command (scripts/vessel-master.ts).

export const dynamic = "force-dynamic"

export const GET = route({ mutating: false, limit: ["vessels", 240] }, async () => {
  const vessels = (await listVessels(await getDb())).map(pickerEntry)
  return json({ vessels, fetchedAt: new Date().toISOString() })
})
