import { getDb } from "@/lib/mongodb"
import { ANY_MODULE } from "@/lib/server/auth"
import { json, route } from "@/lib/server/http"
import { listVessels } from "@/lib/vessel-master/repo"
import { pickerEntry } from "@/lib/vessel-master/view"

// Vessel Master · the vessel list for the SIR (picker and review page). Read-only: the master is written only by the
// admin command (scripts/vessel-master.ts).

export const dynamic = "force-dynamic"

// Any NeraVeda workspace right (Digital Docking uses the list too) or the launcher's service ticket.
export const GET = route({ mutating: false, auth: "user-or-service", module: ANY_MODULE, limit: ["vessels", 240] }, async () => {
  const vessels = (await listVessels(await getDb())).map(pickerEntry)
  return json({ vessels, fetchedAt: new Date().toISOString() })
})
