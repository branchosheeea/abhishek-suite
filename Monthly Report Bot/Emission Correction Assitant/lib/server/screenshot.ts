// Reading an OVD Admin screenshot for a session. Read-only: nothing is stored except an audit entry with the
// image's SHA-256; the user reviews the items and adds them as DNV entries in a separate step.

import { sameItem } from "../ocr/ovd-admin"
import { readScreenshot } from "./ocr"
import { audit, getSession, listDnv, type Services } from "./service"

export async function readOvdAdminScreenshot(s: Services, sessionId: string, bytes: Uint8Array, name: string) {
  const session = await getSession(s, sessionId)
  const reading = await readScreenshot(bytes)
  const existing = (await listDnv(s, sessionId)).filter((d) => !d.withdrawn)
  const items = reading.parse.items.map((item) => ({ ...item, duplicateOf: existing.find((d) => sameItem(d, item))?.id ?? null }))
  const warnings = [...reading.parse.warnings]
  const imo = reading.parse.vessel.imo
  if (imo && session.imo && imo !== session.imo) warnings.unshift(`The screenshot is for IMO ${imo}${reading.parse.vessel.name ? ` (${reading.parse.vessel.name})` : ""}, but this session is for IMO ${session.imo}.`)
  await audit(s, "dnv.screenshot.read", `${name || "screenshot"} (SHA-256 ${reading.sha256.slice(0, 12)}…): ${items.length} item(s) read locally in ${Math.round(reading.ms / 100) / 10} s`, sessionId)
  return {
    name: name || null,
    sha256: reading.sha256,
    width: reading.width,
    height: reading.height,
    engine: reading.engine,
    ms: reading.ms,
    vessel: reading.parse.vessel,
    period: reading.parse.period,
    totals: reading.parse.totals,
    segments: reading.parse.segments,
    items,
    warnings,
  }
}

export type ScreenshotResponse = Awaited<ReturnType<typeof readOvdAdminScreenshot>>
