// What the browser last said about its own copy of the inspection reports (audit P1-7). Only the browser knows which
// drafts have not reached the cloud yet; the report list tells this server after each sync, and the Home summary
// (/api/inspections/summary) passes it on, so the desktop Home page can say "N reports only on this device".
// Kept in memory: it is a hint about this PC's browser, never report data, and is re-sent whenever the list is opened.

export type DeviceStatus = { reports: number; pending: number; conflicts: number; locked: number; at: number }

const COUNTS = ["reports", "pending", "conflicts", "locked"] as const
const state = globalThis as unknown as { __sirDeviceStatus?: DeviceStatus }

/** The counts from a request body, or null when they are not whole numbers in a sensible range. */
export function readDeviceStatus(body: Record<string, unknown>, now = Date.now()): DeviceStatus | null {
  const out: Partial<DeviceStatus> = { at: now }
  for (const key of COUNTS) {
    const value = body[key]
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) return null
    out[key] = value
  }
  if (out.pending! > out.reports! || out.conflicts! > out.reports! || out.locked! > out.reports!) return null
  return out as DeviceStatus
}

export const rememberDeviceStatus = (status: DeviceStatus) => void (state.__sirDeviceStatus = status)
export const deviceStatus = (): DeviceStatus | null => state.__sirDeviceStatus ?? null
