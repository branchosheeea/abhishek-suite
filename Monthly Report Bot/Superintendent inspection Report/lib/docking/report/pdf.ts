// Digital Docking · the Daily Report as a PDF (server side, jsPDF's Node build). Photos are embedded as stored:
// JPEGs pass through without re-encoding, so the file size is about the sum of the photos. A photo used twice is
// embedded once. Same palette as the inspection report (Goodwood navy and green).

import { jsPDF } from "jspdf"
import { dateLine, filledSections, itemLine, longDate, type ReportContent, type ReportContext } from "./content"

type RGB = [number, number, number]
const NAVY: RGB = [0, 49, 82]
const GREEN: RGB = [122, 192, 67]
const INK: RGB = [33, 35, 38]
const MUTED: RGB = [90, 91, 93]
const LINE: RGB = [221, 223, 222]
const TINT: RGB = [242, 242, 242]

const PAGE_W = 210
const PAGE_H = 297
const MARGIN = 15
const WIDTH = PAGE_W - 2 * MARGIN
const BOTTOM = PAGE_H - 16
const COLS = 3
const GAP = 3
const INDENT = 8
const PHOTO_W = (WIDTH - INDENT - GAP * (COLS - 1)) / COLS
const PHOTO_H = PHOTO_W * 0.75

export type PdfPhoto = { data: Buffer; format: string; width: number | null; height: number | null; sha256: string }
export type PdfInput = {
  content: ReportContent
  context: ReportContext
  docking: { vessel_name: string; code: string; yard: string; location: string }
  photo: (id: string) => PdfPhoto | null
  /** A preview of the working draft (marked DRAFT on every page) or an issued version. */
  stamp: { draft: true } | { draft: false; version: number; issuedBy: string; issuedAt: string }
  logo?: Buffer | null
}

// The standard PDF fonts cover Windows-1252 only; anything else would print as garbage, so it is replaced.
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"
export function pdfSafe(text: string): string {
  return text
    .replace(/\t/g, " ")
    .replace(/[‐-‒]/g, "-")
    .replace(/[−]/g, "-")
    .replace(/[   ]/g, " ")
    .replace(/./gu, (ch) => {
      const c = ch.codePointAt(0)!
      return c === 10 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || CP1252_EXTRA.includes(ch) ? ch : "?"
    })
}

const IMAGE_FORMAT: Record<string, string> = { jpeg: "JPEG", jpg: "JPEG", png: "PNG" }

export function buildReportPdf(input: PdfInput): Buffer {
  const { content, context, docking } = input
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true })
  doc.setProperties({ title: `${docking.vessel_name} – Daily Report – Day ${context.dayNo}`, subject: "Dry dock daily report", creator: "NeraVeda" })
  let y = MARGIN

  const color = (rgb: RGB) => doc.setTextColor(rgb[0], rgb[1], rgb[2])
  const font = (size: number, style: "normal" | "bold" | "italic" = "normal", rgb: RGB = INK) => {
    doc.setFont("helvetica", style)
    doc.setFontSize(size)
    color(rgb)
  }
  const lineHeight = (size: number) => size * 0.3528 * 1.35
  const ensure = (needed: number) => {
    if (y + needed > BOTTOM) {
      doc.addPage()
      y = MARGIN
    }
  }
  /** Wrapped text; breaks across pages line by line. */
  const write = (text: string, x: number, width: number, size: number, style: "normal" | "bold" | "italic" = "normal", rgb: RGB = INK) => {
    font(size, style, rgb)
    const lh = lineHeight(size)
    for (const line of doc.splitTextToSize(pdfSafe(text), width) as string[]) {
      ensure(lh)
      doc.text(line, x, y + lh * 0.75)
      y += lh
    }
  }

  // Title block (first page only).
  if (input.logo) {
    try {
      doc.addImage(new Uint8Array(input.logo), "PNG", PAGE_W - MARGIN - 18, y - 2, 18, 18, "logo", "FAST")
    } catch {
      // a damaged logo never stops the report
    }
  }
  write(docking.vessel_name, MARGIN, WIDTH - 24, 17, "bold", NAVY)
  write(`Dry dock daily report · Day ${context.dayNo} · ${longDate(context.reportDate)}`, MARGIN, WIDTH - 24, 11, "bold", INK)
  write([docking.yard, docking.location].filter(Boolean).join(", ") + ` · ${docking.code}`, MARGIN, WIDTH - 24, 9, "normal", MUTED)
  y = Math.max(y, MARGIN + 18) + 2
  doc.setDrawColor(GREEN[0], GREEN[1], GREEN[2])
  doc.setLineWidth(0.8)
  doc.line(MARGIN, y, PAGE_W - MARGIN, y)
  y += 5

  // Header lines as a two-column table.
  const rows: [string, string][] = [["Date", dateLine(context)], ...content.header.filter((h) => h.label.trim() && h.value.trim()).map((h) => [h.label.trim(), h.value.trim()] as [string, string])]
  const labelW = 52
  for (const [label, value] of rows) {
    font(9.5)
    const lines = doc.splitTextToSize(pdfSafe(value), WIDTH - labelW - 4) as string[]
    const h = Math.max(1, lines.length) * lineHeight(9.5) + 2
    ensure(h)
    doc.setFillColor(TINT[0], TINT[1], TINT[2])
    doc.rect(MARGIN, y, labelW, h, "F")
    doc.setDrawColor(LINE[0], LINE[1], LINE[2])
    doc.setLineWidth(0.2)
    doc.line(MARGIN, y + h, PAGE_W - MARGIN, y + h)
    font(9, "bold", MUTED)
    doc.text(pdfSafe(label), MARGIN + 2, y + 1 + lineHeight(9.5) * 0.75, { maxWidth: labelW - 4 })
    font(9.5)
    lines.forEach((l, i) => doc.text(l, MARGIN + labelW + 3, y + 1 + lineHeight(9.5) * (i + 0.75)))
    y += h
  }
  y += 5

  const summary = content.summary.split("\n").map((l) => l.trim()).filter(Boolean)
  for (const p of summary) {
    write(p, MARGIN, WIDTH, 10)
    y += 1.5
  }
  if (summary.length) y += 2

  for (const e of content.events) {
    const lines = e.text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim())
    if (!e.title.trim() && !lines.length) continue
    ensure(lineHeight(10) * 2)
    if (e.title.trim()) write(e.title.trim(), MARGIN, WIDTH, 10, "bold")
    for (const l of lines) write(l, MARGIN + 2, WIDTH - 2, 9.5)
    y += 3
  }

  const drawPhotos = (ids: string[]) => {
    let col = 0
    for (const id of ids) {
      const photo = input.photo(id)
      if (col === 0) {
        ensure(PHOTO_H + GAP)
      }
      const x = MARGIN + INDENT + col * (PHOTO_W + GAP)
      const format = photo ? IMAGE_FORMAT[photo.format.toLowerCase()] : undefined
      doc.setDrawColor(LINE[0], LINE[1], LINE[2])
      doc.setLineWidth(0.2)
      if (photo && format) {
        const ratio = photo.width && photo.height ? photo.width / photo.height : 4 / 3
        const w = ratio >= PHOTO_W / PHOTO_H ? PHOTO_W : PHOTO_H * ratio
        const h = ratio >= PHOTO_W / PHOTO_H ? PHOTO_W / ratio : PHOTO_H
        doc.addImage(new Uint8Array(photo.data), format, x + (PHOTO_W - w) / 2, y + (PHOTO_H - h) / 2, w, h, `p${photo.sha256}`, "FAST")
      } else {
        doc.setFillColor(TINT[0], TINT[1], TINT[2])
        doc.rect(x, y, PHOTO_W, PHOTO_H, "F")
        font(8, "italic", MUTED)
        doc.text(photo ? `Photo in ${photo.format.toUpperCase()} format (not included)` : "Photo not found", x + PHOTO_W / 2, y + PHOTO_H / 2, { align: "center" })
      }
      col++
      if (col === COLS) {
        col = 0
        y += PHOTO_H + GAP
      }
    }
    if (col) y += PHOTO_H + GAP
  }

  for (const section of filledSections(content)) {
    if (section.showGroup) {
      ensure(9 + lineHeight(10.5) * 3)
      y += 2
      doc.setFillColor(NAVY[0], NAVY[1], NAVY[2])
      doc.rect(MARGIN, y, WIDTH, 7, "F")
      font(11, "bold", [255, 255, 255])
      doc.text(section.group, MARGIN + 2.5, y + 5)
      y += 9
    }
    ensure(lineHeight(10.5) * 3)
    write(`${section.title}:`, MARGIN, WIDTH, 10.5, "bold", NAVY)
    y += 1
    section.items.forEach((item, i) => {
      font(10)
      const lines = doc.splitTextToSize(pdfSafe(itemLine(item)), WIDTH - INDENT) as string[]
      // keep the item's first line with its first row of photos
      ensure(lineHeight(10) * Math.min(lines.length, 3) + (item.photos.length ? PHOTO_H : 0))
      font(10, "bold")
      doc.text(`${i + 1}.`, MARGIN, y + lineHeight(10) * 0.75)
      for (const l of lines) {
        ensure(lineHeight(10))
        font(10)
        doc.text(l, MARGIN + INDENT, y + lineHeight(10) * 0.75)
        y += lineHeight(10)
      }
      y += 1.5
      if (item.photos.length) drawPhotos(item.photos)
      y += 1.5
    })
    y += 3
  }

  // Footer and DRAFT mark on every page.
  const pages = doc.getNumberOfPages()
  const footer = input.stamp.draft
    ? "DRAFT – not issued"
    : `Version ${input.stamp.version} · issued ${input.stamp.issuedAt} by ${input.stamp.issuedBy}`
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    if (input.stamp.draft) {
      const GState = (doc as unknown as { GState: new (o: { opacity: number }) => unknown }).GState
      doc.saveGraphicsState()
      doc.setGState(new GState({ opacity: 0.2 }) as never)
      font(110, "bold", [200, 30, 30])
      // rotated text starts at its baseline's left end: place that end so the word's middle is the page's middle
      const angle = (35 * Math.PI) / 180
      const half = doc.getTextWidth("DRAFT") / 2
      const rise = (110 * 0.3528) / 3
      doc.text("DRAFT", PAGE_W / 2 - half * Math.cos(angle) + rise * Math.sin(angle), PAGE_H / 2 + half * Math.sin(angle) + rise * Math.cos(angle), { angle: 35 })
      doc.restoreGraphicsState()
    }
    doc.setDrawColor(LINE[0], LINE[1], LINE[2])
    doc.setLineWidth(0.2)
    doc.line(MARGIN, PAGE_H - 11, PAGE_W - MARGIN, PAGE_H - 11)
    font(7.5, "normal", MUTED)
    doc.text(pdfSafe(`${docking.vessel_name} · ${docking.code} · Day ${context.dayNo} · ${footer}`), MARGIN, PAGE_H - 7)
    doc.text(`Page ${p} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 7, { align: "right" })
  }
  return Buffer.from(doc.output("arraybuffer"))
}
