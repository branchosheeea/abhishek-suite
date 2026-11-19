// Interpretation of raw cell text for analysis. Blank, zero, invalid and unavailable are always distinct:
// a blank cell is never read as zero, and text that is not a plain number is reported, not coerced.

import { type Dec, fromInt, mul, parseDec, round, toString } from "./decimal"
import type { XlsxCellType } from "./types"

export type NumState =
  | Readonly<{ state: "blank"; raw: string }>
  | Readonly<{ state: "number"; value: Dec; raw: string; trimmed: boolean }>
  | Readonly<{ state: "invalid"; raw: string; reason: string }>

export function readNumber(raw: string): NumState {
  if (raw.trim() === "") return { state: "blank", raw }
  const text = raw.trim()
  const value = parseDec(text)
  if (value) return { state: "number", value, raw, trimmed: text !== raw }
  let reason = "not a plain decimal number"
  if (/\d,\d/.test(text)) reason = "contains a comma (thousands separator or decimal comma), so it was not interpreted"
  else if (/[A-Za-z]/.test(text)) reason = "contains text"
  return { state: "invalid", raw, reason }
}

export type CellMeta = Readonly<{ type?: XlsxCellType; dateFormatted?: boolean }>

export type TimeState =
  | Readonly<{ state: "ok"; ms: number; iso: string; basis: string }>
  | Readonly<{ state: "blank" }>
  | Readonly<{ state: "invalid"; reason: string }>

const MS_PER_DAY = 86_400_000
const EXCEL_EPOCH_OFFSET_DAYS = 25_569 // 1970-01-01 as a 1900-system serial
const EXCEL_1904_OFFSET_DAYS = 1_462

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

function utcDayMs(year: number, month: number, day: number): number | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null
  const ms = Date.UTC(year, month - 1, day)
  const check = new Date(ms)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return ms
}

function serialToMs(raw: string, date1904: boolean): number | null {
  const serial = parseDec(raw.trim())
  if (!serial) return null
  // Excel serials are fractional days. Round to the nearest second: Excel stores times to ~1e-5 s precision,
  // and reporting times are recorded to the minute.
  const ms = round(mul(serial, fromInt(MS_PER_DAY)), 0)
  const totalMs = Number(toString(ms))
  const offset = (date1904 ? EXCEL_EPOCH_OFFSET_DAYS - EXCEL_1904_OFFSET_DAYS : EXCEL_EPOCH_OFFSET_DAYS) * MS_PER_DAY
  return Math.round((totalMs - offset) / 1000) * 1000
}

type DatePart = { ok: true; ms: number; basis: string } | { ok: false; reason: string } | { ok: "blank" }

export function readDate(raw: string, meta: CellMeta = {}, date1904 = false): DatePart {
  if (raw.trim() === "") return { ok: "blank" }
  if (meta.type === "n" && meta.dateFormatted) {
    const ms = serialToMs(raw, date1904)
    if (ms === null) return { ok: false, reason: `Excel date value "${raw}" is not a number` }
    return { ok: true, ms: Math.floor(ms / MS_PER_DAY) * MS_PER_DAY, basis: "Excel date serial" }
  }
  const text = raw.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) ?? /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(text)
  if (m) {
    const ms = utcDayMs(Number(m[1]), Number(m[2]), Number(m[3]))
    return ms === null ? { ok: false, reason: `"${raw}" is not a valid calendar date` } : { ok: true, ms, basis: "ISO date" }
  }
  m = /^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{4})$/.exec(text)
  if (m) {
    const month = MONTHS.indexOf(m[2].toLowerCase()) + 1
    const ms = month ? utcDayMs(Number(m[3]), month, Number(m[1])) : null
    return ms === null ? { ok: false, reason: `"${raw}" is not a valid calendar date` } : { ok: true, ms, basis: "day-month-name-year" }
  }
  if (/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(text)) {
    return { ok: false, reason: `"${raw}" uses a numeric day/month order that cannot be determined from the value alone` }
  }
  return { ok: false, reason: `"${raw}" is not a recognised date format` }
}

type TimePart = { ok: true; ms: number } | { ok: false; reason: string } | { ok: "blank" }

export function readTime(raw: string, meta: CellMeta = {}): TimePart {
  if (raw.trim() === "") return { ok: "blank" }
  if (meta.type === "n") {
    const fraction = parseDec(raw.trim())
    if (!fraction) return { ok: false, reason: `Excel time value "${raw}" is not a number` }
    const ms = Number(toString(round(mul(fraction, fromInt(MS_PER_DAY)), 0)))
    if (ms < 0 || ms >= MS_PER_DAY) return { ok: false, reason: `Excel time value "${raw}" is outside one day` }
    return { ok: true, ms: Math.round(ms / 1000) * 1000 }
  }
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim())
  if (!m) return { ok: false, reason: `"${raw}" is not a time in HH:MM or HH:MM:SS form` }
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
  if (h > 23 || min > 59 || s > 59) return { ok: false, reason: `"${raw}" is not a valid time of day` }
  return { ok: true, ms: ((h * 60 + min) * 60 + s) * 1000 }
}

export function isoUtc(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z")
}

/** Combine a UTC date column and a UTC time column. */
export function readTimestamp(dateRaw: string | null, timeRaw: string | null, dateMeta: CellMeta, timeMeta: CellMeta, date1904 = false): TimeState {
  if (dateRaw === null) return { state: "invalid", reason: "no date column" }
  const date = readDate(dateRaw, dateMeta, date1904)
  if (date.ok === "blank") return { state: "blank" }
  if (date.ok === false) return { state: "invalid", reason: date.reason }
  if (timeRaw === null) return { state: "invalid", reason: "no time column" }
  const time = readTime(timeRaw, timeMeta)
  if (time.ok === "blank") return { state: "invalid", reason: "date given but time is blank" }
  if (time.ok === false) return { state: "invalid", reason: time.reason }
  const ms = date.ms + time.ms
  return { state: "ok", ms, iso: isoUtc(ms), basis: `${date.basis} + time` }
}

/** A single date-time column: ISO 8601 text or an Excel date serial with a time fraction. */
export function readDateTime(raw: string, meta: CellMeta = {}, date1904 = false): TimeState {
  if (raw.trim() === "") return { state: "blank" }
  if (meta.type === "n" && meta.dateFormatted) {
    const ms = serialToMs(raw, date1904)
    return ms === null ? { state: "invalid", reason: `Excel date value "${raw}" is not a number` } : { state: "ok", ms, iso: isoUtc(ms), basis: "Excel date serial" }
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]00:?00)?$/.exec(raw.trim())
  if (!m) return { state: "invalid", reason: `"${raw}" is not an ISO 8601 UTC date-time` }
  const day = utcDayMs(Number(m[1]), Number(m[2]), Number(m[3]))
  const [h, min, s] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)]
  if (day === null || h > 23 || min > 59 || s > 59) return { state: "invalid", reason: `"${raw}" is not a valid date-time` }
  const ms = day + ((h * 60 + min) * 60 + s) * 1000
  return { state: "ok", ms, iso: isoUtc(ms), basis: "ISO date-time" }
}

/** IMO ship identification number: 7 digits, the last a check digit over the first six (weights 7..2). */
export function checkImo(raw: string): { valid: true; imo: string } | { valid: false; reason: string } {
  const text = raw.trim()
  if (text === "") return { valid: false, reason: "blank" }
  if (!/^\d{7}$/.test(text)) return { valid: false, reason: `"${raw}" is not a 7-digit IMO number` }
  const digits = [...text].map(Number)
  const total = digits.slice(0, 6).reduce((acc, d, i) => acc + d * (7 - i), 0)
  if (total % 10 !== digits[6]) return { valid: false, reason: `"${raw}" fails the IMO check digit` }
  return { valid: true, imo: text }
}

export type Position = Readonly<{ lat: number; lon: number }>
export type PositionState = Readonly<{ state: "ok"; position: Position } | { state: "blank" } | { state: "invalid"; reason: string }>

function part(raw: string | null): number | null | "blank" {
  if (raw === null || raw.trim() === "") return "blank"
  const value = parseDec(raw.trim())
  return value ? Number(toString(value)) : null
}

export function readPosition(p: {
  latDeg?: string | null; latMin?: string | null; latHem?: string | null
  lonDeg?: string | null; lonMin?: string | null; lonHem?: string | null
  latDecimal?: string | null; lonDecimal?: string | null
}): PositionState | null {
  if (p.latDecimal !== undefined || p.lonDecimal !== undefined) {
    const lat = part(p.latDecimal ?? null)
    const lon = part(p.lonDecimal ?? null)
    if (lat === "blank" && lon === "blank") return { state: "blank" }
    if (lat === null || lon === null || lat === "blank" || lon === "blank") return { state: "invalid", reason: "latitude or longitude is blank or not a number" }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { state: "invalid", reason: `position ${lat}, ${lon} is outside valid ranges` }
    return { state: "ok", position: { lat, lon } }
  }
  if (p.latDeg === undefined && p.lonDeg === undefined) return null
  const values = [part(p.latDeg ?? null), part(p.latMin ?? null), part(p.lonDeg ?? null), part(p.lonMin ?? null)]
  const hems = [(p.latHem ?? "").trim().toUpperCase(), (p.lonHem ?? "").trim().toUpperCase()]
  if (values.every((v) => v === "blank") && hems.every((h) => h === "")) return { state: "blank" }
  if (values.some((v) => v === null || v === "blank")) return { state: "invalid", reason: "a degree or minute value is blank or not a number" }
  const [latDeg, latMin, lonDeg, lonMin] = values as number[]
  // The interface defines the hemisphere fields as Text (5); both "N" and "North" (etc.) occur in practice.
  const HEMISPHERE: Record<string, string> = { N: "N", NORTH: "N", S: "S", SOUTH: "S", E: "E", EAST: "E", W: "W", WEST: "W" }
  hems[0] = HEMISPHERE[hems[0]] ?? hems[0]
  hems[1] = HEMISPHERE[hems[1]] ?? hems[1]
  if (!["N", "S"].includes(hems[0]) || !["E", "W"].includes(hems[1])) return { state: "invalid", reason: "hemisphere must be North/South (N/S) and East/West (E/W)" }
  if (latDeg < 0 || latDeg > 90 || lonDeg < 0 || lonDeg > 180 || latMin < 0 || latMin >= 60 || lonMin < 0 || lonMin >= 60) {
    return { state: "invalid", reason: "degrees or minutes are outside valid ranges" }
  }
  const lat = (latDeg + latMin / 60) * (hems[0] === "S" ? -1 : 1)
  const lon = (lonDeg + lonMin / 60) * (hems[1] === "W" ? -1 : 1)
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { state: "invalid", reason: "position is outside valid ranges" }
  return { state: "ok", position: { lat, lon } }
}
