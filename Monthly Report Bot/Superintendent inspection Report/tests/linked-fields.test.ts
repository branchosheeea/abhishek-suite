import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createEmptyReport } from "../lib/form-schema"
import { applyLinkedChange, vesselNameMismatch } from "../lib/linked-fields"

describe("linked fields", () => {
  test("Vessel and Ship name always carry the same value, whichever is edited", () => {
    let r = applyLinkedChange(createEmptyReport("a"), "details", "vessel", "DHT BRONCO")
    assert.equal(r.particulars.shipName, "DHT BRONCO")
    assert.equal(r.details.vesselId, "DHT_BRONCO")
    r = applyLinkedChange(r, "particulars", "shipName", "DHT LEOPARD")
    assert.equal(r.details.vessel, "DHT LEOPARD")
    assert.equal(r.details.vesselId, "DHT_LEOPARD")
    assert.equal(vesselNameMismatch(r), null)
  })

  test("Port fills Place, and keeps it in step until the user enters a different place", () => {
    let r = applyLinkedChange(createEmptyReport("b"), "details", "port", "Zhoushan")
    assert.equal(r.details.inspectedPlace, "Zhoushan")
    r = applyLinkedChange(r, "details", "port", "Singapore")
    assert.equal(r.details.inspectedPlace, "Singapore", "follows the port while unchanged")
    r = applyLinkedChange(r, "details", "inspectedPlace", "Singapore anchorage")
    r = applyLinkedChange(r, "details", "port", "Fujairah")
    assert.equal(r.details.inspectedPlace, "Singapore anchorage", "a place typed by the user is kept")
  })

  test("Inspection to fills the Inspected-by date the same way", () => {
    let r = applyLinkedChange(createEmptyReport("c"), "details", "dateTo", "2026-11-27")
    assert.equal(r.details.inspectedDate, "2026-11-27")
    r = applyLinkedChange(r, "details", "inspectedDate", "2026-11-30")
    r = applyLinkedChange(r, "details", "dateTo", "2026-11-28")
    assert.equal(r.details.inspectedDate, "2026-11-30")
  })

  test("names saved differently by an older version are detected", () => {
    const r = createEmptyReport("d")
    r.details.vessel = "DHT BRONCO"
    r.particulars.shipName = "DHT Bronco"
    assert.deepEqual(vesselNameMismatch(r), { vessel: "DHT BRONCO", ship: "DHT Bronco" })
  })

  test("unrelated fields change on their own", () => {
    const r = applyLinkedChange(createEmptyReport("e"), "particulars", "imo", "9733961")
    assert.equal(r.particulars.imo, "9733961")
    assert.equal(r.details.vessel, undefined)
  })
})
