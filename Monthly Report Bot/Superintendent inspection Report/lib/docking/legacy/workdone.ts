// Digital Docking: read the vessel's own "Dry Dock Work Done" workbook, the format vessels send today (before the
// NeraVeda template). One workbook holds both departments, one sheet per department and performer:
//   DECK - SHIP STAFF · DECK - YARD STAFF · DECK - SERVICE ENGINEER · ENGINE - SHIP STAFF · ENGINE - YARD STAFF ·
//   ENGINE - SERVICE VENDORS, plus "Stagging …" tables, and on the last day sometimes a plain list sheet ("Engine").
// Work sheets: serial number in column B, one sentence in column C, floating photos below it until the next item.
// The text is sometimes one row above its serial number (C9 / B10), so a text-only row directly followed by a
// number-only row is one item. A numbered item with no text is kept as an item without a description (Leopard
// Day 15 has 21 of them): its photos are never moved to a neighbouring item.
//
// Read with the same hardened package reader as the NeraVeda template (size limits, no macros, no DTDs).

import { createHash } from "node:crypto"
import { anchorsIn, cellAt, cellsOf, cellText, geometry, sharedStrings } from "../photos/analyze"
import { imageInfo } from "../photos/image-size"
import { columnLetter, parseCellRef } from "../photos/layout"
import { DEFAULT_LIMITS, type PackageLimits, readPackage } from "../photos/package"
import { attr, child, list, parseXml, relationships } from "../photos/xml"
import type { ActivityInput, Department, PhotoInput } from "../server/repo"

export const LEGACY_TEMPLATE = "VESSEL-WORKDONE"
export const LEGACY_VERSION = 1

export type SheetKind = "work" | "staging" | "list"
export type SheetSummary = Readonly<{
  name: string; kind: SheetKind | "unknown"; department: Department | null; performedBy: string
  items: number; itemsWithoutText: number; photos: number; photosRejected: number
}>
export type DepartmentPart = { activities: ActivityInput[]; photos: PhotoInput[] }
export type LegacyWorkbook = Readonly<{
  sha256: string; bytes: number; reportDate: string | null; dayNo: number | null
  sheets: readonly SheetSummary[]; deck: DepartmentPart; engine: DepartmentPart; warnings: readonly string[]
}>

const STORABLE = new Set(["jpeg", "jpg", "png", "gif", "bmp", "webp"])
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

const clean = (s: string) => s.replace(/ /g, " ").replace(/\s+/g, " ").trim()

export function classifySheet(name: string): { kind: SheetKind; department: Department; performedBy: string } | null {
  const n = clean(name).toUpperCase()
  if (/STAG/.test(n)) return { kind: "staging", department: /ENGINE|\bE\/?R\b/.test(n) ? "engine" : "deck", performedBy: "Yard staff" }
  const department: Department | null = n.startsWith("DECK") ? "deck" : n.startsWith("ENGINE") ? "engine" : null
  if (!department) return null
  const performedBy = /SHIP/.test(n) ? "Ship staff" : /YARD/.test(n) ? "Yard staff" : /SERVICE|VENDOR/.test(n) ? "Service engineer" : ""
  return { kind: performedBy ? "work" : "list", department, performedBy }
}

/** Excel's date serial (1900 system) to YYYY-MM-DD; text dates are returned as written. */
function excelDate(value: string): string {
  const n = Number(value)
  if (!value || !Number.isFinite(n) || n < 20000 || n > 80000) return clean(value)
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000).toISOString().slice(0, 10)
}

function parseHeaderDate(text: string): string | null {
  const m = /Date\s*:?\s*(\d{1,2})[-\s./]([A-Za-z]{3})[A-Za-z]*[-\s./,]+(\d{4})/i.exec(text)
  if (!m) return null
  const month = MONTHS.indexOf(m[2].toLowerCase())
  if (month < 0) return null
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`
}

type Grid = Map<number, Map<number, string>>
type Item = { row: number; serial: string; text: string; inferred: boolean; extra: Partial<ActivityInput> }
type Found = { c1: number; r1: number; name: string; media?: string; problem?: string; anchor: string }

function gridOf(sheetXml: ReturnType<typeof parseXml>, strings: string[]): Grid {
  const grid: Grid = new Map()
  for (const c of cellsOf(sheetXml)) {
    const ref = parseCellRef(attr(c, "r") ?? "")
    const value = cellText(c, strings)
    if (!ref || !value.trim()) continue
    if (!grid.has(ref.row)) grid.set(ref.row, new Map())
    grid.get(ref.row)!.set(ref.column, value)
  }
  return grid
}

const at = (grid: Grid, r: number, c: number) => clean(grid.get(r)?.get(c) ?? "")
const rows = (grid: Grid) => [...grid.keys()].sort((a, b) => a - b)

function workItems(grid: Grid): Item[] {
  const header = rows(grid).find((r) => [...grid.get(r)!.values()].some((v) => /^S(R)?\.?\s*NO\.?$/i.test(clean(v)))) ?? rows(grid)[0] ?? 1
  const starts: Item[] = []
  for (const r of rows(grid)) {
    if (r < header) continue
    const b = at(grid, r, 2)
    const c = at(grid, r, 3)
    const serial = /^\d{1,3}(\.0+)?$/.test(b) ? String(Number(b)) : ""
    const text = c && !/^(JOBS|S(R)?\.?\s*NO\.?)$/i.test(c) ? c : ""
    if (serial || text) starts.push({ row: r, serial, text, inferred: false, extra: {} })
  }
  const items: Item[] = []
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i]
    const next = starts[i + 1]
    if (cur.text && !cur.serial && next && next.serial && !next.text) {
      items.push({ ...cur, serial: next.serial, inferred: true }) // text written one or more rows above its number
      i++
    } else items.push(cur)
  }
  return items
}

const ITEM_NO = /^(\d{1,3})\s*[.)]\s*/

function listItems(grid: Grid): Item[] {
  const items: Item[] = []
  let performer = ""
  for (const r of rows(grid)) {
    const line = [...grid.get(r)!.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => clean(v)).filter(Boolean).join(" ")
    if (!line) continue
    if (/ship'?s?\s*staff/i.test(line) && !ITEM_NO.test(line)) performer = "Ship staff"
    else if (/yard\s*staff/i.test(line) && !ITEM_NO.test(line)) performer = "Yard staff"
    else if (/service\s*engineer|service\s*vendor/i.test(line) && !ITEM_NO.test(line)) performer = "Service engineer"
    else if (/class\s*surveyor/i.test(line) && !ITEM_NO.test(line)) performer = "Class surveyor"
    else if (/^none\.?$/i.test(line)) continue
    else {
      const m = ITEM_NO.exec(line)
      items.push({ row: r, serial: m ? m[1] : "", text: m ? line.slice(m[0].length) : line, inferred: false, extra: { performedBy: performer } })
    }
  }
  return items
}

function stagingItems(grid: Grid): Item[] {
  const header = rows(grid).find((r) => /^location$/i.test(at(grid, r, 1)))
  if (header === undefined) return []
  const cols = new Map<string, number>()
  for (const [c, v] of grid.get(header)!) cols.set(clean(v).toLowerCase(), c)
  const col = (...names: string[]) => names.map((n) => [...cols.entries()].find(([k]) => k.startsWith(n))?.[1]).find((c) => c !== undefined)
  const qty = col("quantity", "qty")
  const dim = col("dimension")
  const purpose = col("purpose")
  const rigged = col("rigged")
  const removed = col("removed")
  const items: Item[] = []
  for (const r of rows(grid)) {
    if (r <= header) continue
    const location = at(grid, r, 1)
    if (!location || /length|breadth|height/i.test(location)) continue
    const size = dim ? [0, 1, 2].map((k) => at(grid, r, dim + k)).filter((v) => v && v !== "-" && v !== "0") : []
    const what = purpose ? at(grid, r, purpose) : ""
    const on = rigged ? excelDate(grid.get(r)?.get(rigged) ?? "") : ""
    const off = removed ? excelDate(grid.get(r)?.get(removed) ?? "") : ""
    const count = qty ? at(grid, r, qty) : ""
    const parts = [`Staging${what ? ` for ${what.toLowerCase()}` : ""}`, size.length ? `(${count ? `${count} × ` : ""}${size.join(" × ")} m)` : count ? `(${count})` : ""]
    items.push({
      row: r, serial: "", text: parts.filter(Boolean).join(" "), inferred: false,
      extra: { location, area: "Staging", status: off ? `Removed ${off}` : on ? `Rigged ${on}` : "", raw: { quantity: count, size, purpose: what, riggedOn: on, removedOn: off } },
    })
  }
  return items
}

/** Read one "Work Done" workbook. Never throws for layout problems: they become warnings and rejected photos. */
export async function readWorkDoneWorkbook(data: Buffer, limits: PackageLimits = DEFAULT_LIMITS): Promise<LegacyWorkbook> {
  const entries = await readPackage(data, limits)
  const workbookPart = "xl/workbook.xml"
  const workbook = parseXml(entries.get(workbookPart), workbookPart).workbook
  const workbookRels = relationships(entries, workbookPart)
  const strings = sharedStrings(entries, [...workbookRels.values()].find((r) => r.type.endsWith("/sharedStrings"))?.target)
  const sheets = list(child(workbook, "sheets"), "sheet").map((s) => ({ name: attr(s, "name") ?? "", part: workbookRels.get(attr(s, "id") ?? "")?.target }))

  const out: Record<Department, DepartmentPart> = { deck: { activities: [], photos: [] }, engine: { activities: [], photos: [] } }
  const summaries: SheetSummary[] = []
  const warnings: string[] = []
  let reportDate: string | null = null
  let dayNo: number | null = null

  for (const sheet of sheets) {
    if (!sheet.part || !entries.has(sheet.part)) continue
    const sheetXml = parseXml(entries.get(sheet.part), sheet.part)
    const grid = gridOf(sheetXml, strings)
    for (const r of rows(grid).slice(0, 8)) {
      for (const v of grid.get(r)!.values()) {
        reportDate ??= parseHeaderDate(v)
        const d = /Day\s*:?\s*(\d{1,3})\b/i.exec(v)
        if (d && dayNo === null) dayNo = Number(d[1])
      }
    }
    const name = clean(sheet.name)
    const kind = classifySheet(sheet.name)

    // Pictures on this sheet, top-left cell first.
    const found: Found[] = []
    const drawingId = attr(child(sheetXml.worksheet, "drawing"), "id")
    const drawingPart = drawingId ? relationships(entries, sheet.part).get(drawingId) : undefined
    if (drawingPart && !drawingPart.external && entries.has(drawingPart.target)) {
      const g = geometry(sheetXml)
      const drawingRels = relationships(entries, drawingPart.target)
      for (const box of anchorsIn(parseXml(entries.get(drawingPart.target), drawingPart.target).wsDr as Record<string, unknown>, g)) {
        const { c0, r0 } = cellAt(g, box.x1, box.y1)
        for (const p of box.pictures) {
          const rel = p.embed ? drawingRels.get(p.embed) : undefined
          const problem = p.link || rel?.external ? "it is linked to a file outside the workbook" : p.hidden ? "it is hidden" : !rel ? "its picture data is missing" : undefined
          found.push({ c1: c0 + 1, r1: r0 + 1, name: p.name, media: rel && !rel.external ? rel.target : undefined, problem, anchor: box.kind })
        }
      }
    }
    found.sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1)

    if (!kind) {
      if (found.length || grid.size) warnings.push(`Sheet "${name}" is not a Deck, Engine or staging sheet; it was not imported${found.length ? ` (${found.length} photos left out)` : ""}.`)
      summaries.push({ name, kind: "unknown", department: null, performedBy: "", items: 0, itemsWithoutText: 0, photos: 0, photosRejected: found.length })
      continue
    }

    const parsed = kind.kind === "work" ? workItems(grid) : kind.kind === "staging" ? stagingItems(grid) : listItems(grid)
    const ownerOf = (f: Found) => [...parsed].reverse().find((i) => i.row <= f.r1)
    const placed = found.map((f) => {
      const bytes = f.media ? entries.get(f.media) : undefined
      const ext = (f.media?.split(".").pop() ?? "").toLowerCase()
      const info = bytes ? imageInfo(bytes) : null
      const owner = ownerOf(f)
      let reason = f.problem ?? ""
      if (!reason && !bytes) reason = "its picture data is missing from the file"
      if (!reason && (!STORABLE.has(ext) || !info)) reason = `it is a .${ext || "unknown"} drawing, not a photo`
      if (!reason && !owner) reason = `it is above the first item of "${name}" (cell ${columnLetter(f.c1)}${f.r1})`
      return { f, bytes, ext, info, owner, reason }
    })
    // A numbered row with neither text nor photos is an unused row of the vessel's form, not an item.
    const withPhotos = new Set(placed.filter((p) => !p.reason).map((p) => p.owner!.row))
    const items = parsed.filter((i) => i.text || withPhotos.has(i.row))
    const part = out[kind.department]
    for (const item of items) {
      part.activities.push({
        sheet: name, rowNo: item.row,
        rowRef: item.serial ? `No. ${item.serial}` : kind.kind === "staging" ? String(item.extra.location ?? `Row ${item.row}`) : `Row ${item.row}`,
        workText: item.text, performedBy: kind.performedBy || "", ...item.extra,
        raw: { ...(item.extra.raw as object | undefined), serial: item.serial, noText: !item.text, textAboveNumber: item.inferred, sheetKind: kind.kind },
      })
    }

    const slots = new Map<number, number>()
    let rejected = 0
    for (const { f, bytes, ext, info, owner, reason } of placed) {
      const slot = reason ? null : (slots.get(owner!.row) ?? 0) + 1
      if (slot !== null) slots.set(owner!.row, slot)
      else rejected++
      part.photos.push({
        sheet: name, rowNo: owner?.row ?? f.r1, cell: `${columnLetter(f.c1)}${f.r1}`, slot, method: "over cells", anchor: f.anchor,
        mediaPart: f.media ?? "", data: reason ? null : bytes!, extension: ext === "jpg" ? "jpeg" : ext, width: info?.width ?? null, height: info?.height ?? null,
        format: info?.format ?? null, status: reason ? "rejected" : "linked", reason,
      })
    }
    summaries.push({
      name, kind: kind.kind, department: kind.department, performedBy: kind.performedBy, items: items.length,
      itemsWithoutText: items.filter((i) => !i.text).length, photos: found.length, photosRejected: rejected,
    })
  }

  const blank = summaries.reduce((n, s) => n + s.itemsWithoutText, 0)
  if (blank) warnings.push(`${blank} numbered item${blank === 1 ? " has" : "s have"} photos but no description; they are kept as "no description" items.`)
  if (!reportDate) warnings.push("The report date was not found on the sheets.")
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, reportDate, dayNo, sheets: summaries, deck: out.deck, engine: out.engine, warnings }
}
