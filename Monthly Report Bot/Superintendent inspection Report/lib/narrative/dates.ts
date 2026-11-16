// Dates are stored as ISO "YYYY-MM-DD" strings and rendered in formal report style ("25 September 2026").

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

export type DateParts = { year: number; month: number; day: number }

export function parseIsoDate(value: string | undefined): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? "").trim())
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number)
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return { year, month, day }
}

export function isValidIsoDate(value: string | undefined) {
  return parseIsoDate(value) !== null
}

/** Compares two ISO dates; returns a negative number when a is earlier than b. Invalid dates compare as null. */
export function compareIsoDates(a: string | undefined, b: string | undefined) {
  const pa = parseIsoDate(a)
  const pb = parseIsoDate(b)
  if (!pa || !pb) return null
  return pa.year - pb.year || pa.month - pb.month || pa.day - pb.day
}

/** "25 September 2026", or "" for a missing or invalid date. */
export function formatDate(value: string | undefined) {
  const parts = parseIsoDate(value)
  return parts ? `${parts.day} ${MONTHS[parts.month - 1]} ${parts.year}` : ""
}

/**
 * The date or date range without its preposition:
 *   same day        → "25 September 2026"
 *   same month      → "25 to 30 September 2026"
 *   same year       → "28 September to 3 October 2026"
 *   different years → "30 December 2026 to 2 January 2027"
 * Returns null when the start date is missing or invalid, or the end date is earlier than the start date.
 * A missing end date is treated as a single-day attendance.
 */
export function formatDateRange(start: string | undefined, end: string | undefined) {
  const s = parseIsoDate(start)
  if (!s) return null
  const e = end ? parseIsoDate(end) : s
  if (!e) return null
  const order = compareIsoDates(start, end || start)
  if (order === null || order > 0) return null
  if (order === 0) return { single: true, text: formatDate(start) }
  if (s.year === e.year && s.month === e.month) {
    return { single: false, text: `${s.day} to ${e.day} ${MONTHS[e.month - 1]} ${e.year}` }
  }
  if (s.year === e.year) {
    return { single: false, text: `${s.day} ${MONTHS[s.month - 1]} to ${e.day} ${MONTHS[e.month - 1]} ${e.year}` }
  }
  return { single: false, text: `${formatDate(start)} to ${formatDate(end)}` }
}

/** The range with its preposition: "on 25 September 2026" or "from 25 to 30 September 2026". */
export function datePhrase(start: string | undefined, end: string | undefined) {
  const range = formatDateRange(start, end)
  if (!range) return ""
  return range.single ? `on ${range.text}` : `from ${range.text}`
}
