// Layout reader for OVD Admin validation screenshots. Pure: takes the words the local OCR engine found (text,
// confidence, box in ORIGINAL image pixels) and, optionally, a sampler for icon colours, and rebuilds the
// table: the vessel row, the UnderWay / InPort segment rows, and under each segment the items
//   [icon] Check name | Message | YYYY-MM-DD HH:MM Event
// A wrapped check name or message continues on the following lines in the same column.
// Nothing here guesses a value that is not on the screen; anything uncertain is flagged for the user's review.

import type { DnvCategory } from "../engine/correlate"
import { checkImo } from "../engine/values"

export type OcrWord = Readonly<{ text: string; conf: number; x0: number; y0: number; x1: number; y1: number }>

export type IconColor = "red" | "amber"
/** Dominant icon colour inside a rectangle of the original image, or null when there is no icon there. */
export type IconSampler = (x0: number, y0: number, x1: number, y1: number) => IconColor | null

export type OvdAdminSegment = Readonly<{
  type: "UnderWay" | "InPort"
  fromUtc: string | null
  toUtc: string | null
  fromPort: string | null
  toPort: string | null
}>

export type OvdAdminItem = Readonly<{
  severity: "error" | "warning"
  /** icon: read from the icon colour; glyph: from the OCR'd icon shape; unknown: not visible, review it. */
  severitySource: "icon" | "glyph" | "unknown"
  /** The canonical OVD Admin check name when recognised, else the text as read. */
  checkName: string
  checkRead: string
  category: DnvCategory
  message: string
  eventUtc: string | null
  eventName: string | null
  /** Window stated in the message ("between … and …"), else the segment's window. */
  fromUtc: string | null
  toUtc: string | null
  segment: OvdAdminSegment | null
  fuel: string | null
  /** Words the OCR engine read with low confidence (to check against the screenshot). */
  uncertain: readonly string[]
  /** Vertical position in the screenshot (original pixels), for pointing at the row. */
  top: number
  bottom: number
}>

export type OvdAdminParse = Readonly<{
  vessel: Readonly<{ name: string | null; imo: string | null }>
  period: Readonly<{ from: string; to: string }> | null
  /** OVD Admin's own totals for the vessel ("3 issues", "7 warnings" badges), when visible. */
  totals: Readonly<{ issues: number | null; warnings: number | null }>
  segments: readonly OvdAdminSegment[]
  items: readonly OvdAdminItem[]
  warnings: readonly string[]
}>

/** OVD Admin check names (as shown in the filter chips) and the DNV category each belongs to. Order matters. */
export const OVD_ADMIN_CHECKS: readonly Readonly<{ name: string; category: DnvCategory; test: RegExp }>[] = [
  { name: "Sea passage consistency", category: "SEA_PASSAGE", test: /sea ?passage/ },
  { name: "Arrival / departure consistency", category: "ARRIVAL_DEPARTURE", test: /arrival.*departure/ },
  { name: "Duration vs. reporting times", category: "DURATION", test: /duration/ },
  { name: "Maneuvering in port", category: "MANEUVERING_IN_PORT", test: /ma?n(o|e)?euv/ },
  { name: "CII: FC boiler (consumption)", category: "CII_BOILER", test: /boiler/ },
  { name: "Consumption deviation (voyage)", category: "CONSUMPTION_DEVIATION", test: /consumption ?deviation/ },
  { name: "Distance deviation (per voyage)", category: "DISTANCE", test: /distance/ },
  { name: "ROBs reported (beginning of year)", category: "BOY_ROB", test: /beginning ?of ?(the )?year|^robs? reported/ },
  { name: "Reported ROB vs. available fuel", category: "FUEL_AVAILABLE", test: /available ?fuel|rob ?vs/ },
  { name: "Port code consistency", category: "PORT_CODE", test: /port ?code/ },
  { name: "Cargo consistency", category: "CARGO", test: /cargo/ },
  { name: "", category: "POSITION", test: /position/ },
  { name: "", category: "AIS", test: /\bais\b/ },
]

const LOW_CONFIDENCE = 60

// ── to a DNV entry ───────────────────────────────────────────────────────────

export type ItemDraft = Pick<OvdAdminItem, "severity" | "category" | "checkName" | "message" | "eventUtc" | "eventName" | "fromUtc" | "toUtc" | "segment" | "fuel">

export function entryDescription(item: Pick<ItemDraft, "category" | "checkName" | "message" | "eventName">): string {
  const prefix = item.category === "OTHER" || item.category === "AIS" || item.category === "POSITION" ? `${item.checkName}: ` : ""
  return `${prefix}${item.message}${item.eventName ? ` (event: ${item.eventName})` : ""}`.slice(0, 2000)
}

export function segmentText(segment: OvdAdminSegment | null): string | null {
  if (!segment) return null
  const when = segment.fromUtc || segment.toUtc ? ` (${(segment.fromUtc ?? "?").replace("T", " ").replace("Z", "")} – ${(segment.toUtc ?? "?").replace("T", " ").replace("Z", "")} UTC)` : ""
  return `${segment.type} ${segment.fromPort ?? "?"} → ${segment.toPort ?? "?"}${when}`
}

/** The body of a DNV entry for an item read from a screenshot (the user may have edited the draft). */
export function toDnvEntry(item: ItemDraft, imo: string | null, evidence: { sha256: string; name: string | null; reader: string }, confirmed: boolean) {
  return {
    category: item.category,
    severity: item.severity,
    description: entryDescription(item),
    imo,
    eventUtc: item.eventUtc,
    fromUtc: item.fromUtc,
    toUtc: item.toUtc,
    voyageOrPortStay: segmentText(item.segment),
    portCodes: [...new Set([item.segment?.fromPort, item.segment?.toPort].filter((p): p is string => !!p))],
    fuel: item.fuel,
    quantity: null,
    entryMethod: "screenshot" as const,
    confirmed,
    evidence,
  }
}

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "")

/** The same OVD Admin item already entered: same check, same event time (or window) and the same message. */
export function sameItem(entry: Readonly<{ category: DnvCategory; eventUtc?: string | null; fromUtc: string | null; toUtc: string | null; description: string }>, item: Pick<ItemDraft, "category" | "eventUtc" | "fromUtc" | "toUtc" | "message">): boolean {
  if (entry.category !== item.category) return false
  const when = item.eventUtc ? (entry.eventUtc ?? null) === item.eventUtc : !entry.eventUtc && entry.fromUtc === item.fromUtc && entry.toUtc === item.toUtc
  return when && squash(entry.description).includes(squash(item.message).slice(0, 80))
}

// ── tokens ───────────────────────────────────────────────────────────────────

/** Fix the usual OCR digit confusions, but only inside a token that then reads as a date and/or time. */
function digits(text: string): string {
  const fixed = text.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1")
  return /^\d{4}-\d{2}-\d{2}(\d{2}:\d{2})?$|^\d{2}:\d{2}$/.test(fixed) ? fixed : text
}

function validDate(y: string, m: string, d: string): boolean {
  const iso = `${y}-${m}-${d}`
  const t = Date.parse(`${iso}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === iso
}

/** Read "YYYY-MM-DD HH:MM" (also run together as "YYYY-MM-DDHH:MM") from the start of a token list. */
function readDateTime(tokens: readonly string[], i: number): { iso: string; dateOnly: boolean; used: number } | null {
  const a = digits(tokens[i] ?? "")
  const merged = /^(\d{4})-(\d{2})-(\d{2})(\d{2}):(\d{2})$/.exec(a)
  if (merged && validDate(merged[1], merged[2], merged[3]) && +merged[4] < 24 && +merged[5] < 60) {
    return { iso: `${merged[1]}-${merged[2]}-${merged[3]}T${merged[4]}:${merged[5]}Z`, dateOnly: false, used: 1 }
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a)
  if (!date || !validDate(date[1], date[2], date[3])) return null
  const time = /^(\d{2}):(\d{2})$/.exec(digits(tokens[i + 1] ?? ""))
  if (time && +time[1] < 24 && +time[2] < 60) return { iso: `${date[1]}-${date[2]}-${date[3]}T${time[1]}:${time[2]}Z`, dateOnly: false, used: 2 }
  return { iso: `${date[1]}-${date[2]}-${date[3]}`, dateOnly: true, used: 1 }
}

const ICON_GLYPH = /^(B|8|E|\[?!\]?|A\.?|A'|A’|a\.)$/
const PORT = /^[A-Z]{2}[A-Z0-9]{3}$/
const SEGMENT = /^(under ?way|in ?port|ln ?port)$/i

function glyphSeverity(text: string): "error" | "warning" | null {
  if (/^(B|8|E|\[?!\]?)$/.test(text)) return "error"
  if (/^(A\.?|A'|A’|a\.)$/.test(text)) return "warning"
  return null
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/\bcl[il1|]:?/g, "cii:").replace(/[^a-z0-9:/().]+/g, " ").replace(/\s+/g, " ").trim()
}

export function checkOf(read: string): { name: string; category: DnvCategory } {
  const text = normalise(read).replace(/\(\d+\)$/, "").trim()
  for (const c of OVD_ADMIN_CHECKS) if (c.test.test(text)) return { name: c.name || cleanSpaces(read), category: c.category }
  return { name: cleanSpaces(read), category: "OTHER" }
}

function cleanSpaces(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\s+([.,;:)])/g, "$1").replace(/\(\s+/g, "(").trim()
}

/** Message text: rejoin date and time that OCR ran together, tidy spaces. */
function cleanMessage(text: string): string {
  return cleanSpaces(text.replace(/(\d{4}-\d{2}-\d{2})(\d{2}:\d{2})/g, "$1 $2"))
}

// ── geometry ─────────────────────────────────────────────────────────────────

type Row = { top: number; bottom: number; words: OcrWord[] }
type Cell = { x0: number; x1: number; words: OcrWord[] }

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function rowsOf(words: readonly OcrWord[], h: number): Row[] {
  const rows: (Row & { yc: number; n: number })[] = []
  for (const w of [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1))) {
    const yc = (w.y0 + w.y1) / 2
    const row = rows.find((r) => Math.abs(r.yc - yc) <= 0.55 * h)
    if (row) {
      row.words.push(w)
      row.yc = (row.yc * row.n + yc) / (row.n + 1)
      row.n += 1
      row.top = Math.min(row.top, w.y0)
      row.bottom = Math.max(row.bottom, w.y1)
    } else rows.push({ yc, n: 1, top: w.y0, bottom: w.y1, words: [w] })
  }
  rows.sort((a, b) => a.yc - b.yc)
  for (const r of rows) r.words.sort((a, b) => a.x0 - b.x0)
  return rows
}

function cellsOf(row: Row, h: number): Cell[] {
  const cells: Cell[] = []
  for (const w of row.words) {
    const last = cells[cells.length - 1]
    if (last && w.x0 - last.x1 <= 1.6 * h) {
      last.words.push(w)
      last.x1 = Math.max(last.x1, w.x1)
    } else cells.push({ x0: w.x0, x1: w.x1, words: [w] })
  }
  return cells
}

const textOf = (words: readonly OcrWord[]) => words.map((w) => w.text).join(" ")

/** An event cell: date, optional time and at most a two-word event name, nothing else. */
function eventOf(cell: Cell): { iso: string; name: string | null } | null {
  const tokens = cell.words.map((w) => w.text)
  const dt = readDateTime(tokens, 0)
  if (!dt || dt.dateOnly) return null
  const rest = tokens.slice(dt.used)
  if (rest.length > 2) return null
  return { iso: dt.iso, name: rest.length ? rest.join(" ") : null }
}

/**
 * A segment row is labelled with the single word "UnderWay" / "InPort" (or the capitalised pair "In Port"),
 * followed by its UTC window. A message such as "Distance in port was detected" is not a segment row.
 */
function segmentOf(row: Row): OvdAdminSegment | null {
  const tokens = row.words.map((w) => w.text)
  let label: string | null = null
  for (let i = 0; i < Math.min(tokens.length, 6) && !label; i += 1) {
    if (SEGMENT.test(tokens[i]) && /^[A-Zl]/.test(tokens[i])) label = tokens[i]
    else if (/^(In|ln|Under)$/.test(tokens[i]) && /^(Port|Way)$/.test(tokens[i + 1] ?? "")) label = `${tokens[i]}${tokens[i + 1]}`
  }
  if (!label) return null
  const type = /under/i.test(label) ? "UnderWay" : "InPort"
  const times: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const dt = readDateTime(tokens, i)
    if (dt && !dt.dateOnly) {
      times.push(dt.iso)
      i += dt.used - 1
    }
  }
  if (!times.length) return null
  const ports = tokens.filter((t) => PORT.test(t) && !/^\d/.test(t))
  return { type, fromUtc: times[0] ?? null, toUtc: times[1] ?? null, fromPort: ports[0] ?? null, toPort: ports[1] ?? null }
}

/** A vessel row of the list: carries a valid IMO number. */
function imoOf(row: Row): string | null {
  return row.words.map((w) => w.text).find((t) => /^\d{7}$/.test(t) && checkImo(t).valid) ?? null
}

// ── parse ────────────────────────────────────────────────────────────────────

export function parseOvdAdmin(words: readonly OcrWord[], sampler?: IconSampler): OvdAdminParse {
  const warnings: string[] = []
  const clean = words.filter((w) => w.text.trim() !== "")
  const h = median(clean.filter((w) => /[A-Za-z0-9]{2,}/.test(w.text)).map((w) => w.y1 - w.y0)) || 12
  const rows = rowsOf(clean, h)

  // Vessel and period: the row holding a valid IMO number above the first segment, or the "NAME (IMO)" chip.
  const firstSegment = rows.findIndex((r) => segmentOf(r) !== null)
  const head = firstSegment >= 0 ? rows.slice(0, firstSegment) : rows
  let vessel: { name: string | null; imo: string | null } = { name: null, imo: null }
  let period: { from: string; to: string } | null = null
  const headText = head.map((r) => textOf(r.words)).join(" \n ")
  const issues = /(\d{1,4})\s*issues?\b/i.exec(headText)
  const warningsBadge = /(\d{1,4})\s*warnings?\b/i.exec(headText)
  const totals = { issues: issues ? Number(issues[1]) : null, warnings: warningsBadge ? Number(warningsBadge[1]) : null }
  for (const r of head) {
    const tokens = r.words.map((w) => w.text)
    const chip = /^(.+?)\s*\((\d{7})\)/.exec(textOf(r.words))
    if (chip && checkImo(chip[2]).valid && !vessel.imo) vessel = { name: cleanSpaces(chip[1]).replace(/^[^A-Za-z0-9]+/, "") || null, imo: chip[2] }
    const at = tokens.findIndex((t) => /^\d{7}$/.test(t) && checkImo(t).valid)
    if (at < 0) continue
    const dates: { iso: string; dateOnly: boolean; index: number }[] = []
    for (let i = at + 1; i < tokens.length; i += 1) {
      const dt = readDateTime(tokens, i)
      if (dt) {
        dates.push({ ...dt, index: i })
        i += dt.used - 1
      }
    }
    const nameEnd = dates.length ? dates[0].index : tokens.length
    const name = cleanSpaces(tokens.slice(at + 1, nameEnd).filter((t) => /[A-Za-z]{2,}/.test(t)).join(" "))
    vessel = { name: name || vessel.name, imo: tokens[at] }
    const only = dates.filter((d) => d.dateOnly).map((d) => d.iso)
    if (only.length >= 2 && only[0] <= only[1]) period = { from: only[0], to: only[1] }
  }

  // Columns, learned from the item rows: x of the check name and x of the message.
  const body = firstSegment >= 0 ? rows.slice(firstSegment) : rows
  type Open = { severity: OvdAdminItem["severity"]; severitySource: OvdAdminItem["severitySource"]; check: OcrWord[]; message: OcrWord[]; event: { iso: string; name: string | null } | null; eventWords: OcrWord[]; segment: OvdAdminSegment | null; top: number; bottom: number }
  const items: OvdAdminItem[] = []
  const segments: OvdAdminSegment[] = []
  let segment: OvdAdminSegment | null = null
  let open: Open | null = null
  let checkX: number | null = null
  let messageX: number | null = null

  const close = () => {
    if (!open) return
    const o: Open = open
    open = null
    const checkRead = cleanSpaces(textOf(o.check))
    const message = cleanMessage(textOf(o.message))
    if (!checkRead && !message) return
    const check = checkOf(checkRead)
    const between = /between (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) and (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/i.exec(message)
    const fuel = /fuel type:?\s+([A-Za-z]{2,8})\b/i.exec(message)
    const uncertain = [...o.check, ...o.message, ...o.eventWords].filter((w) => w.conf < LOW_CONFIDENCE && /[A-Za-z0-9]/.test(w.text)).map((w) => w.text)
    items.push({
      severity: o.severity,
      severitySource: o.severitySource,
      checkName: check.name,
      checkRead,
      category: check.category,
      message,
      eventUtc: o.event?.iso ?? null,
      eventName: o.event?.name ?? null,
      fromUtc: between ? `${between[1]}T${between[2]}Z` : (o.segment?.fromUtc ?? null),
      toUtc: between ? `${between[3]}T${between[4]}Z` : (o.segment?.toUtc ?? null),
      segment: o.segment,
      fuel: fuel ? fuel[1].toUpperCase() : null,
      uncertain: [...new Set(uncertain)],
      top: o.top,
      bottom: o.bottom,
    })
  }

  for (const row of body) {
    const seg = segmentOf(row)
    if (seg) {
      close()
      segment = seg
      segments.push(seg)
      continue
    }
    const imo = imoOf(row)
    if (imo) {
      close()
      segment = null
      if (vessel.imo && imo !== vessel.imo) warnings.push(`The screenshot shows more than one vessel (IMO ${vessel.imo} and ${imo}). Take one screenshot per vessel.`)
      continue
    }
    const cells = cellsOf(row, h)
    if (!cells.length) continue
    // The icon, when OCR read it as a glyph, is the first word of the first cell.
    let glyph: OcrWord | null = null
    if (cells[0].words.length > 1 && ICON_GLYPH.test(cells[0].words[0].text)) {
      glyph = cells[0].words[0]
      cells[0] = { ...cells[0], x0: cells[0].words[1].x0, words: cells[0].words.slice(1) }
    }
    const last = cells[cells.length - 1]
    const event = cells.length >= 2 ? eventOf(last) : null
    const textCells = event ? cells.slice(0, -1) : cells
    const firstX = textCells[0]?.x0 ?? last.x0
    const color = sampler ? sampler(firstX - 2.2 * h - 2, row.top - 2, firstX - 1, row.bottom + 2) : null
    const glyphSev = glyph ? glyphSeverity(glyph.text) : null
    const looksLikeCheck = textCells.length >= 1 && OVD_ADMIN_CHECKS.some((c) => c.test.test(normalise(textOf(textCells[0].words))))
    const nearCheckColumn = checkX === null || Math.abs(firstX - checkX) <= 2 * h
    const starts = nearCheckColumn && (color !== null || (glyphSev !== null && (textCells.length >= 2 || !!event)) || (!sampler && looksLikeCheck && (textCells.length >= 2 || !!event)))
    if (starts) {
      close()
      const severity = color === "red" ? "error" : color === "amber" ? "warning" : (glyphSev ?? "warning")
      open = {
        severity,
        severitySource: color ? "icon" : glyphSev ? "glyph" : "unknown",
        check: [...textCells[0].words],
        message: textCells.slice(1).flatMap((c) => c.words),
        event,
        eventWords: event ? last.words : [],
        segment,
        top: row.top,
        bottom: row.bottom,
      }
      checkX = checkX === null ? textCells[0].x0 : Math.min(checkX, textCells[0].x0)
      if (textCells[1]) messageX = messageX === null ? textCells[1].x0 : Math.min(messageX, textCells[1].x0)
      continue
    }
    if (!open) continue
    // Continuation of the open item (a wrapped line sits close below): each cell goes to the column it lines up with.
    const o: Open = open
    if (row.top - o.bottom > 1.5 * h) {
      close()
      continue
    }
    for (const cell of cells) {
      const toCheck = checkX !== null && (messageX === null ? cell.x0 < checkX + 4 * h : Math.abs(cell.x0 - checkX) < Math.abs(cell.x0 - messageX))
      if (toCheck) o.check.push(...cell.words)
      else if (!o.event && eventOf(cell) && cell === last && cells.length > 1) {
        o.event = eventOf(cell)
        o.eventWords = cell.words
      } else o.message.push(...cell.words)
    }
    o.bottom = Math.max(o.bottom, row.bottom)
  }
  close()

  if (!items.length) warnings.push("No OVD Admin items were recognised. Use a screenshot of the expanded vessel list showing the check names, messages and event times.")
  if (firstSegment < 0 && items.length) warnings.push("No UnderWay / InPort row is visible, so the items are not tied to a voyage or port stay.")
  const unknown = items.filter((i) => i.severitySource === "unknown").length
  if (unknown) warnings.push(`${unknown} item(s) without a recognisable error/warning icon: their severity is set to warning — check it.`)
  return { vessel, period, totals, segments, items, warnings }
}

/**
 * What is still missing against OVD Admin's own totals, over all screenshots read so far (items counted once).
 * Null when no totals were visible.
 */
export function missingAgainstTotals(totals: OvdAdminParse["totals"] | null, items: readonly Pick<OvdAdminItem, "severity">[]): { issues: number; warnings: number } | null {
  if (!totals || (totals.issues === null && totals.warnings === null)) return null
  const errors = items.filter((i) => i.severity === "error").length
  const warns = items.filter((i) => i.severity === "warning").length
  return { issues: Math.max(0, (totals.issues ?? errors) - errors), warnings: Math.max(0, (totals.warnings ?? warns) - warns) }
}
