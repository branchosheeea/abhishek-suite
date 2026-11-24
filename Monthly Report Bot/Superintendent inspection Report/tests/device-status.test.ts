// What the browser tells the server about reports not in the cloud yet (lib/server/device-status.ts, audit P1-7).
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { deviceStatus, readDeviceStatus, rememberDeviceStatus } from "../lib/server/device-status"

describe("device status for the Home page", () => {
  test("counts are accepted as whole numbers and remembered with the time", () => {
    const status = readDeviceStatus({ reports: 4, pending: 2, conflicts: 1, locked: 0 }, 1_000)
    assert.deepEqual(status, { reports: 4, pending: 2, conflicts: 1, locked: 0, at: 1_000 })
    rememberDeviceStatus(status!)
    assert.deepEqual(deviceStatus(), status)
  })

  test("anything else is refused", () => {
    assert.equal(readDeviceStatus({ reports: 4, pending: "2", conflicts: 0, locked: 0 }), null)
    assert.equal(readDeviceStatus({ reports: 4, pending: 1.5, conflicts: 0, locked: 0 }), null)
    assert.equal(readDeviceStatus({ reports: 4, pending: -1, conflicts: 0, locked: 0 }), null)
    assert.equal(readDeviceStatus({ reports: 1, pending: 2, conflicts: 0, locked: 0 }), null, "more pending than reports")
    assert.equal(readDeviceStatus({ reports: 1, pending: 0, conflicts: 0 }), null, "a count is missing")
  })
})
