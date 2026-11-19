// Event classification. Source: OVD Interface Description 3.13, sheet "Event types" (row 2) and "Log abstract"
// (row 18): only Arrival, Departure, ArrivalSTS, DepartureSTS, STS, BOSP / BeginOfSeaPassage / FAOP /
// FullAheadOnPassage and EOSP / EndOfSeaPassage are fixed in spelling and recognised by OVD voyage logic. The
// spelling of every other event is flexible; those are classified only for context (noon, anchoring…).

export type EventClass =
  | "DEPARTURE"
  | "ARRIVAL"
  | "ARRIVAL_STS"
  | "DEPARTURE_STS"
  | "STS"
  | "BEGIN_SEA_PASSAGE"
  | "END_SEA_PASSAGE"
  | "NOON"
  | "ANCHORING_DRIFTING"
  | "SHIFTING"
  | "CANAL"
  | "BEGIN_OFFHIRE"
  | "END_OFFHIRE"
  | "OTHER"
  | "BLANK"

export const EVENT_CLASSIFICATION_VERIFIED = true

/** The fixed spellings recognised by OVD voyage logic. */
export const FIXED_EVENTS: Readonly<Record<string, EventClass>> = {
  Departure: "DEPARTURE",
  Arrival: "ARRIVAL",
  ArrivalSTS: "ARRIVAL_STS",
  DepartureSTS: "DEPARTURE_STS",
  STS: "STS",
  BOSP: "BEGIN_SEA_PASSAGE",
  BeginOfSeaPassage: "BEGIN_SEA_PASSAGE",
  FAOP: "BEGIN_SEA_PASSAGE",
  FullAheadOnPassage: "BEGIN_SEA_PASSAGE",
  EOSP: "END_SEA_PASSAGE",
  EndOfSeaPassage: "END_SEA_PASSAGE",
}

const FIXED_LOWER = new Map(Object.entries(FIXED_EVENTS).map(([name, cls]) => [name.toLowerCase(), { name, cls }]))

export type EventSpelling = Readonly<{ fixed: boolean; exact: boolean; documented: string | null }>

/** Whether the event is one of the fixed OVD events and whether it is written in the exact documented spelling. */
export function eventSpelling(raw: string | null): EventSpelling {
  const text = (raw ?? "").trim()
  if (FIXED_EVENTS[text]) return { fixed: true, exact: true, documented: text }
  const hit = FIXED_LOWER.get(text.toLowerCase().replace(/\s+/g, ""))
  return hit ? { fixed: true, exact: false, documented: hit.name } : { fixed: false, exact: false, documented: null }
}

export function classifyEvent(raw: string | null): EventClass {
  if (raw === null || raw.trim() === "") return "BLANK"
  const spelling = eventSpelling(raw)
  // Only the exact spelling counts for voyage logic, as in OVD; a near miss is reported by rule A08.
  if (spelling.exact) return FIXED_EVENTS[spelling.documented!]
  if (spelling.fixed) return "OTHER"
  const text = raw.toLowerCase()
  if (/noon/.test(text)) return "NOON"
  if (/anchor|drift/.test(text)) return "ANCHORING_DRIFTING"
  if (/shift/.test(text)) return "SHIFTING"
  if (/canal/.test(text)) return "CANAL"
  if (/beginofoffhire|begin\s*of\s*off\s*hire/.test(text)) return "BEGIN_OFFHIRE"
  if (/endofoffhire|end\s*of\s*off\s*hire/.test(text)) return "END_OFFHIRE"
  return "OTHER"
}

/** Events at which a cargo quantity change at sea is operationally expected (STS operations). */
export const STS_EVENTS: ReadonlySet<EventClass> = new Set(["STS", "ARRIVAL_STS", "DEPARTURE_STS"])

/**
 * Names vessels commonly use for the start / end of sea passage that are NOT among the documented OVD spellings
 * (BOSP, BeginOfSeaPassage, FAOP, FullAheadOnPassage / EOSP, EndOfSeaPassage). Rule C09 treats them as the
 * intended event, with a stated qualification, so the sequence can still be checked.
 */
export function seaPassageAlias(raw: string | null): "start" | "end" | null {
  const text = (raw ?? "").trim().toLowerCase().replace(/[^a-z]+/g, " ").trim()
  if (/^(cosp|sosp|commence(ment)? (of )?sea passage|start (of )?sea passage|begin(ning)? (of )?sea passage)$/.test(text)) return "start"
  if (/^(fosp|finish(ed)? (of )?sea passage|end(ing)? (of )?sea passage|completion (of )?sea passage)$/.test(text)) return "end"
  return null
}
