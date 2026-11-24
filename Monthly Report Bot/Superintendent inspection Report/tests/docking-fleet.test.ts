// Digital Docking takes its vessels from the Vessel Master (lib/docking/server/fleet.ts passes them in); the fixed
// fleet list is the fallback. Synthetic data only.
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { closeStore, openStore } from "../lib/docking/server/db"
import { createDocking, DockingError, updateDocking } from "../lib/docking/server/repo"

const BODY = { code: "OTH-2026-SS", vesselName: "MT OTHER MANAGED", yard: "Yard", location: "", dockingType: "Special survey", utcOffsetMinutes: 480, day0Date: "2026-10-13" }

test("a Vessel Master vessel can be docked with its key; the fixed list remains the fallback; a docking keeps its vessel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nv-docking-fleet-"))
  const store = await openStore(dir)
  try {
    assert.throws(() => createDocking(store, BODY, "supt@x.com"), (e: unknown) => e instanceof DockingError && /not in the fleet list/.test(e.message))
    const fleet = [{ name: "MT OTHER MANAGED", key: "MT_OTHER_MANAGED" }]
    const d = createDocking(store, { ...BODY, vesselName: "mt other managed" }, "supt@x.com", fleet)
    assert.deepEqual([d.vessel_name, d.vessel_id], ["MT OTHER MANAGED", "MT_OTHER_MANAGED"])
    const leo = createDocking(store, { ...BODY, code: "LEO-2026-SS", vesselName: "DHT LEOPARD" }, "supt@x.com")
    assert.equal(leo.vessel_id, "DHT_LEOPARD")
    // No longer offered (empty fleet), but its own vessel is still valid when other details change.
    assert.equal(updateDocking(store, d.id, { yard: "New yard" }, d.rev, "supt@x.com", []).yard, "New yard")
  } finally {
    closeStore(store)
    rmSync(dir, { recursive: true, force: true })
  }
})
