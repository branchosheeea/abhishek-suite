// Digital Docking · Stage 1A: find every picture in a workbook and link it to exactly one activity row and photo
// slot, or reject it with the place it was found and what to do. A picture is never linked by guesswork: it must lie
// inside one slot cell (a few pixels' tolerance), or be placed in that cell with Excel's "Place in Cell".
//
// Read from the package itself (not through a spreadsheet library):
//   floating pictures   xl/worksheets/sheetN.xml <drawing r:id> → xl/drawings/drawingN.xml anchors → blip → xl/media/*
//   pictures in cells    <c vm="n"> → xl/metadata.xml → xl/richData/rdrichvalue.xml (+ structure) → richValueRel → media

import { createHash } from "node:crypto"
import { imageInfo } from "./image-size"
import { columnLetter, layoutFor, parseCellRef, type SlotLayout } from "./layout"
import { DEFAULT_LIMITS, type PackageLimits, readPackage, WorkbookRejected } from "./package"
import { attr, child, list, parseXml, relationships, texts, type XmlNode } from "./xml"

export type PictureStatus = "linked" | "rejected"

export type Picture = Readonly<{
  sheet: string
  /** "over cells" = floating picture (Place over Cells / Insert Picture / paste); "in cell" = Place in Cell. */
  method: "over cells" | "in cell"
  anchor: "two-cell" | "one-cell" | "absolute" | "cell"
  /** Cell that holds the picture (in cell) or its centre (over cells), e.g. "D7". */
  cell: string
  row: number
  rowRef: string
  slot: number | null
  status: PictureStatus
  reason: string
  name: string
  media: string
  bytes: number
  width: number | null
  height: number | null
  format: string | null
  sha256: string
}>

export type Analysis = Readonly<{
  bytes: number
  sha256: string
  template: string
  version: number
  variant: string
  layout: SlotLayout
  pictures: readonly Picture[]
  warnings: readonly string[]
}>

export const MAX_PIXELS = 50_000_000
/** How far (in pixels) a picture may overhang its slot's border and still count as inside it. */
export const EDGE_TOLERANCE_PX = 6

const EMU_PER_PX = 9525
const EMU_PER_PT = 12700
const TOLERANCE = EDGE_TOLERANCE_PX * EMU_PER_PX

type Rel = { target: string; external: boolean; type: string }

function num(value: string | undefined, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

// ---------------------------------------------------------------- strings and cells

/** Plain or rich text of an <si> or <is> element. */
function richText(node: XmlNode | undefined): string {
  if (!node) return ""
  if (node.t !== undefined) return texts(node, "t").join("")
  return list(node, "r").map((r) => texts(r, "t").join("")).join("")
}

function sharedStrings(entries: Map<string, Buffer>, part: string | undefined): string[] {
  if (!part || !entries.has(part)) return []
  return list(parseXml(entries.get(part), part).sst, "si").map(richText)
}

function cellText(cell: XmlNode, strings: string[]): string {
  const type = attr(cell, "t")
  const value = texts(cell, "v")[0] ?? ""
  if (type === "s") return strings[num(value, -1)] ?? ""
  if (type === "inlineStr") return richText(child(cell, "is"))
  return value
}

function cellsOf(sheet: XmlNode): XmlNode[] {
  return list(child(sheet.worksheet, "sheetData"), "row").flatMap((row) => list(row, "c"))
}

// ---------------------------------------------------------------- sheet geometry (for one-cell and absolute anchors)

type Geometry = { colLeft: (c0: number) => number; rowTop: (r0: number) => number }

function geometry(sheet: XmlNode): Geometry {
  const ws = sheet.worksheet as XmlNode
  const format = child(ws, "sheetFormatPr")
  const defaultWidth = num(attr(format, "defaultColWidth"), num(attr(format, "baseColWidth"), 8) + 0.43)
  const defaultHeight = num(attr(format, "defaultRowHeight"), 15)
  const widths = new Map<number, number>()
  for (const col of list(child(ws, "cols"), "col")) {
    const min = num(attr(col, "min"), 1)
    const max = Math.min(num(attr(col, "max"), min), min + 16384)
    for (let c = min; c <= max; c++) widths.set(c, num(attr(col, "width"), defaultWidth))
  }
  const heights = new Map<number, number>()
  for (const row of list(child(ws, "sheetData"), "row")) {
    const ht = attr(row, "ht")
    if (ht !== undefined) heights.set(num(attr(row, "r")), num(ht, defaultHeight))
  }
  // Excel's column width (characters of the default font) to pixels, for a 7-pixel-wide digit (Calibri 11).
  const colPx = (c1: number) => Math.floor(7 * (widths.get(c1) ?? defaultWidth) + 0.492)
  const rowEmu = (r1: number) => (heights.get(r1) ?? defaultHeight) * EMU_PER_PT
  const colCache: number[] = [0]
  const rowCache: number[] = [0]
  return {
    colLeft: (c0) => {
      for (let c = colCache.length; c <= c0; c++) colCache[c] = colCache[c - 1] + colPx(c) * EMU_PER_PX
      return colCache[c0]
    },
    rowTop: (r0) => {
      for (let r = rowCache.length; r <= r0; r++) rowCache[r] = rowCache[r - 1] + rowEmu(r)
      return rowCache[r0]
    },
  }
}

function markerEmu(marker: XmlNode | undefined, g: Geometry): { x: number; y: number } {
  const value = (name: string) => num(texts(marker, name)[0])
  return { x: g.colLeft(value("col")) + value("colOff"), y: g.rowTop(value("row")) + value("rowOff") }
}

/** 0-based column and row whose cell contains the point. */
function cellAt(g: Geometry, x: number, y: number): { c0: number; r0: number } {
  let c0 = 0
  while (c0 < 16384 && g.colLeft(c0 + 1) <= x) c0++
  let r0 = 0
  while (r0 < 1048576 && g.rowTop(r0 + 1) <= y) r0++
  return { c0, r0 }
}

// ---------------------------------------------------------------- drawings

type Placed = { name: string; hidden: boolean; embed?: string; link?: string; grouped: boolean }
type AnchorBox = { kind: Picture["anchor"]; x1: number; y1: number; x2: number; y2: number; pictures: Placed[] }

function picturesIn(node: XmlNode, grouped: boolean): Placed[] {
  const out: Placed[] = []
  for (const pic of list(node, "pic")) {
    const cNvPr = child(child(pic, "nvPicPr"), "cNvPr")
    const blip = child(child(pic, "blipFill"), "blip")
    out.push({ name: attr(cNvPr, "name") ?? "Picture", hidden: attr(cNvPr, "hidden") === "1" || attr(cNvPr, "hidden") === "true", embed: attr(blip, "embed"), link: attr(blip, "link"), grouped })
  }
  for (const group of list(node, "grpSp")) out.push(...picturesIn(group, true))
  for (const alt of list(node, "AlternateContent")) {
    const branch = child(alt, "Choice") ?? child(alt, "Fallback")
    if (branch) out.push(...picturesIn(branch, grouped))
  }
  return out
}

function anchorsIn(container: XmlNode, g: Geometry): AnchorBox[] {
  const out: AnchorBox[] = []
  for (const a of list(container, "twoCellAnchor")) {
    const from = markerEmu(child(a, "from"), g)
    const to = markerEmu(child(a, "to"), g)
    out.push({ kind: "two-cell", x1: from.x, y1: from.y, x2: to.x, y2: to.y, pictures: picturesIn(a, false) })
  }
  for (const a of list(container, "oneCellAnchor")) {
    const from = markerEmu(child(a, "from"), g)
    const ext = child(a, "ext")
    out.push({ kind: "one-cell", x1: from.x, y1: from.y, x2: from.x + num(attr(ext, "cx")), y2: from.y + num(attr(ext, "cy")), pictures: picturesIn(a, false) })
  }
  for (const a of list(container, "absoluteAnchor")) {
    const pos = child(a, "pos")
    const ext = child(a, "ext")
    const x = num(attr(pos, "x"))
    const y = num(attr(pos, "y"))
    out.push({ kind: "absolute", x1: x, y1: y, x2: x + num(attr(ext, "cx")), y2: y + num(attr(ext, "cy")), pictures: picturesIn(a, false) })
  }
  for (const alt of list(container, "AlternateContent")) {
    const branch = child(alt, "Choice") ?? child(alt, "Fallback")
    if (branch) out.push(...anchorsIn(branch, g))
  }
  return out
}

// ---------------------------------------------------------------- pictures in cells

type InCellResolver = (vm: number) => { media?: string; problem?: string }

function inCellResolver(entries: Map<string, Buffer>, workbookRels: Map<string, Rel>): InCellResolver | null {
  const byType = (suffix: string, fallback: string) => [...workbookRels.values()].find((r) => r.type.endsWith(suffix))?.target ?? fallback
  const metadataPart = byType("/sheetMetadata", "xl/metadata.xml")
  if (!entries.has(metadataPart)) return null
  const valuePart = byType("/rdRichValue", "xl/richData/rdrichvalue.xml")
  const structurePart = byType("/rdRichValueStructure", "xl/richData/rdrichvaluestructure.xml")
  const relPart = byType("/richValueRel", "xl/richData/richValueRel.xml")

  const metadata = parseXml(entries.get(metadataPart), metadataPart).metadata as XmlNode
  const types = list(child(metadata, "metadataTypes"), "metadataType").map((t) => attr(t, "name") ?? "")
  const richBlocks = list(metadata, "futureMetadata").find((f) => attr(f, "name") === "XLRICHVALUE")
  const richIndex = list(richBlocks, "bk").map((bk) => {
    const rvb = list(child(bk, "extLst"), "ext").flatMap((e) => list(e, "rvb"))[0]
    return rvb ? num(attr(rvb, "i"), -1) : -1
  })
  const valueBlocks = list(child(metadata, "valueMetadata"), "bk").map((bk) => list(bk, "rc")[0])
  const values = entries.has(valuePart) ? list(child(parseXml(entries.get(valuePart), valuePart), "rvData"), "rv") : []
  const structures = entries.has(structurePart) ? list(child(parseXml(entries.get(structurePart), structurePart), "rvStructures"), "s") : []
  const rels = entries.has(relPart) ? list(child(parseXml(entries.get(relPart), relPart), "richValueRels"), "rel").map((r) => attr(r, "id") ?? "") : []
  const relTargets = relationships(entries, relPart)

  return (vm) => {
    const rc = valueBlocks[vm - 1]
    if (!rc) return { problem: "its cell refers to picture data that is missing" }
    if (types[num(attr(rc, "t")) - 1] !== "XLRICHVALUE") return {}
    const rvIndex = richIndex[num(attr(rc, "v"), -1)]
    const rv = values[rvIndex ?? -1]
    if (!rv) return { problem: "its cell refers to picture data that is missing" }
    const structure = structures[num(attr(rv, "s"), -1)]
    const kind = attr(structure, "t") ?? ""
    if (kind !== "_localImage") return { problem: kind === "_webimage" ? "it is a web picture (IMAGE function), not a photo stored in the file" : "its cell holds data that is not a stored picture" }
    const keyIndex = list(structure, "k").findIndex((k) => attr(k, "n") === "_rvRel:LocalImageIdentifier")
    const relIndex = keyIndex < 0 ? -1 : num(texts(rv, "v")[keyIndex], -1)
    const target = relTargets.get(rels[relIndex] ?? "")
    if (!target || target.external) return { problem: target?.external ? "it is linked to a file outside the workbook" : "its picture data is missing" }
    return { media: target.target }
  }
}

// ---------------------------------------------------------------- the workbook

function readIdentity(entries: Map<string, Buffer>, sheetPart: string | undefined, strings: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!sheetPart || !entries.has(sheetPart)) return out
  const cells = cellsOf(parseXml(entries.get(sheetPart), sheetPart))
  const byRef = new Map(cells.map((c) => [attr(c, "r") ?? "", c]))
  for (let r = 1; r <= 20; r++) {
    const key = byRef.get(`A${r}`)
    const value = byRef.get(`B${r}`)
    if (key && value) out[cellText(key, strings).trim().toLowerCase()] = cellText(value, strings).trim()
  }
  return out
}

export async function analyzeWorkbook(data: Buffer, limits: PackageLimits = DEFAULT_LIMITS): Promise<Analysis> {
  const entries = await readPackage(data, limits)
  const workbookPart = "xl/workbook.xml"
  const workbook = parseXml(entries.get(workbookPart), workbookPart).workbook as XmlNode
  const workbookRels = relationships(entries, workbookPart)
  const strings = sharedStrings(entries, [...workbookRels.values()].find((r) => r.type.endsWith("/sharedStrings"))?.target)
  const sheets = list(child(workbook, "sheets"), "sheet").map((s) => ({ name: attr(s, "name") ?? "", part: workbookRels.get(attr(s, "id") ?? "")?.target }))

  const identity = readIdentity(entries, sheets.find((s) => s.name === "_ID")?.part, strings)
  const template = identity.template ?? ""
  const version = num(identity.version, 0)
  const layout = layoutFor(template, version)
  if (!layout) {
    throw new WorkbookRejected(template
      ? `This workbook is template ${template} version ${version || "?"}, which this version of NeraVeda does not know.`
      : "This workbook was not issued by NeraVeda (its identity sheet is missing). Use the workbook NeraVeda generated.")
  }
  const workSheet = sheets.find((s) => s.name === layout.sheet)
  if (!workSheet?.part || !entries.has(workSheet.part)) throw new WorkbookRejected(`The sheet "${layout.sheet}" is missing or was renamed. Use the workbook as issued.`)

  const warnings: string[] = []
  const pictures: Picture[] = []
  const mediaInfo = (part: string) => {
    const bytes = entries.get(part)
    if (!bytes) return null
    const info = imageInfo(bytes)
    return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: info?.width ?? null, height: info?.height ?? null, format: info?.format ?? null }
  }
  const slotOf = (sheetName: string, c1: number, r1: number) => {
    if (sheetName !== layout.sheet || !layout.rows.includes(r1)) return null
    const index = layout.slotColumns.indexOf(c1)
    return index >= 0 ? index + 1 : null
  }
  const where = (sheetName: string, c1: number, r1: number) => `${sheetName}!${columnLetter(c1)}${r1}`

  for (const sheet of sheets) {
    if (!sheet.part || !entries.has(sheet.part)) continue
    const sheetXml = parseXml(entries.get(sheet.part), sheet.part)
    const sheetRels = relationships(entries, sheet.part)
    const refs = new Map<number, string>()
    if (sheet.name === layout.sheet) {
      for (const c of cellsOf(sheetXml)) {
        const ref = parseCellRef(attr(c, "r") ?? "")
        if (ref && ref.column === layout.refColumn) refs.set(ref.row, cellText(c, strings).trim())
      }
    }
    const rowRef = (r1: number) => refs.get(r1) ?? ""

    const record = (base: { method: Picture["method"]; anchor: Picture["anchor"]; c1: number; r1: number; name: string; media: string | undefined }, problem?: string) => {
      const info = base.media ? mediaInfo(base.media) : null
      let reason = problem ?? ""
      let slot = problem ? null : slotOf(sheet.name, base.c1, base.r1)
      if (!problem) {
        if (!info) reason = "its picture data is missing from the file"
        else if (info.width && info.height && info.width * info.height > MAX_PIXELS) reason = `it is ${info.width} × ${info.height} pixels, larger than the ${MAX_PIXELS / 1e6} megapixel limit`
        else if (sheet.name !== layout.sheet) reason = `it is on the "${sheet.name}" sheet; photos belong in the photo slots of "${layout.sheet}"`
        else if (!layout.rows.includes(base.r1)) reason = `it is in row ${base.r1}, which is not an activity row`
        else if (slot === null) reason = `it is in column ${columnLetter(base.c1)}, not in a photo slot (Photo 1–${layout.slotColumns.length})`
      }
      if (reason) slot = null
      pictures.push({
        sheet: sheet.name, method: base.method, anchor: base.anchor, cell: `${columnLetter(base.c1)}${base.r1}`, row: base.r1, rowRef: rowRef(base.r1),
        slot, status: reason ? "rejected" : "linked", reason, name: base.name, media: base.media ?? "",
        bytes: info?.bytes ?? 0, width: info?.width ?? null, height: info?.height ?? null, format: info?.format ?? null, sha256: info?.sha256 ?? "",
      })
    }

    // Floating pictures.
    const drawingId = attr(child(sheetXml.worksheet, "drawing"), "id")
    const drawingPart = drawingId ? sheetRels.get(drawingId) : undefined
    if (drawingPart && !drawingPart.external && entries.has(drawingPart.target)) {
      const g = geometry(sheetXml)
      const drawingRels = relationships(entries, drawingPart.target)
      const drawing = parseXml(entries.get(drawingPart.target), drawingPart.target).wsDr as XmlNode
      for (const box of anchorsIn(drawing, g)) {
        const centre = cellAt(g, (box.x1 + box.x2) / 2, (box.y1 + box.y2) / 2)
        const c1 = centre.c0 + 1
        const r1 = centre.r0 + 1
        const left = g.colLeft(centre.c0)
        const right = g.colLeft(centre.c0 + 1)
        const top = g.rowTop(centre.r0)
        const bottom = g.rowTop(centre.r0 + 1)
        const inside = box.x1 >= left - TOLERANCE && box.x2 <= right + TOLERANCE && box.y1 >= top - TOLERANCE && box.y2 <= bottom + TOLERANCE
        for (const p of box.pictures) {
          const rel = p.embed ? drawingRels.get(p.embed) : undefined
          const base = { method: "over cells" as const, anchor: box.kind, c1, r1, name: p.name, media: rel && !rel.external ? rel.target : undefined }
          if (sheet.name !== layout.sheet) record(base) // reported as "on the wrong sheet", whatever its position
          else if (p.link || rel?.external) record(base, "it is linked to a file outside the workbook, so the photo is not in the file")
          else if (p.grouped) record(base, "it is grouped with other objects; ungroup it and put it in one slot")
          else if (p.hidden) record(base, "it is hidden")
          else if (!inside && slotOf(sheet.name, c1, r1) !== null) {
            const crosses = box.x1 < left - TOLERANCE || box.x2 > right + TOLERANCE ? "a neighbouring slot or column" : "the row above or below"
            record(base, `it crosses from ${where(sheet.name, c1, r1)} into ${crosses}; resize it to fit inside one slot`)
          } else if (!inside) record(base, `it is not inside a single cell (its centre is in ${where(sheet.name, c1, r1)})`)
          else record(base)
        }
      }
    }

    // Pictures placed in cells.
    const inCells = cellsOf(sheetXml).filter((c) => attr(c, "vm") !== undefined)
    if (inCells.length) {
      const resolve = inCellResolver(entries, workbookRels)
      for (const c of inCells) {
        const ref = parseCellRef(attr(c, "r") ?? "")
        if (!ref) continue
        const found = resolve ? resolve(num(attr(c, "vm"))) : { problem: "the workbook's in-cell picture data is missing" }
        if (!found.media && !found.problem) continue // a value with metadata that is not a picture
        record({ method: "in cell", anchor: "cell", c1: ref.column, r1: ref.row, name: `Picture in ${columnLetter(ref.column)}${ref.row}`, media: found.media }, found.problem)
      }
    }
  }

  // One slot, one photo: two pictures in the same slot cannot be told apart, so neither is linked.
  const bySlot = new Map<string, number[]>()
  pictures.forEach((p, i) => {
    if (p.status !== "linked") return
    const key = `${p.sheet}|${p.row}|${p.slot}`
    bySlot.set(key, [...(bySlot.get(key) ?? []), i])
  })
  for (const indexes of bySlot.values()) {
    if (indexes.length < 2) continue
    for (const i of indexes) {
      const p = pictures[i]
      pictures[i] = { ...p, status: "rejected", slot: null, reason: `${indexes.length} pictures share ${p.sheet}!${p.cell} (Photo ${p.slot}); keep one photo per slot and use the next row for more` }
    }
  }

  if (!pictures.length) warnings.push("No pictures were found in this workbook.")
  pictures.sort((a, b) => a.sheet.localeCompare(b.sheet) || a.row - b.row || a.cell.localeCompare(b.cell))
  return {
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    template, version, variant: identity.variant ?? "", layout, pictures, warnings,
  }
}
