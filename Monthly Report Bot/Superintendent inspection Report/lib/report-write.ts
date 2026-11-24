// Whether a report save from a device may replace the copy in the cloud. Pure: used by the API route and in tests.
//
// A device sends the cloud version its copy is based on (`baseUpdatedAt`: the cloud's updatedAt when this device last
// synced the report). The save is accepted only if the cloud still holds that version. Otherwise another device or tab
// saved in between, and replacing the cloud copy would silently discard that work: the device is told "conflict" and
// keeps its own copy until the person chooses what to keep.
//
// Older tabs do not send a base. For them the previous rule applies: a save older than the cloud copy is refused.
// A save the cloud already holds (same updatedAt, e.g. a retry after a lost response) is accepted without writing.

export type WriteDecision = "insert" | "write" | "unchanged" | "conflict"

export function decideReportWrite(input: {
  /** updatedAt of the cloud copy, or null when the cloud has no copy yet. */
  serverUpdatedAt: number | null
  /** updatedAt of the copy being saved. */
  updatedAt: number
  /** The cloud version the saved copy is based on; undefined when the device did not send one. */
  baseUpdatedAt?: number
}): WriteDecision {
  const { serverUpdatedAt, updatedAt, baseUpdatedAt } = input
  if (serverUpdatedAt === null) return "insert"
  if (serverUpdatedAt === updatedAt) return "unchanged"
  if (baseUpdatedAt !== undefined) return serverUpdatedAt === baseUpdatedAt ? "write" : "conflict"
  return serverUpdatedAt > updatedAt ? "conflict" : "write"
}

/** The base version from a request body: a finite number, otherwise undefined (older tabs send none). */
export function readBaseUpdatedAt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
