"use client"

import type { jsPDF as JsPDF } from "jspdf"
import companyLogo from "../public/logo.png"
import {
  CONDITION_SECTIONS,
  CRITICAL_EQUIPMENT_ITEMS,
  DETAILS_GROUPS,
  FORM_CODE,
  MANAGEMENT_SECTION_GROUPS,
  PARTICULARS_GROUPS,
  RATINGS,
  SCOPE_ITEMS,
  SUMMARY_FIELDS,
  WORKLIST_ITEMS,
  conditionRiskBand,
  conditionRiskScore,
  type ConditionEntry,
  type ConditionItem,
  type FieldDef,
  type Photo,
  type Report,
} from "./form-schema"

const NAVY: [number, number, number] = [16, 42, 76]
const INK: [number, number, number] = [28, 33, 43]
const MUTED: [number, number, number] = [108, 117, 132]
const LINE: [number, number, number] = [214, 220, 228]
const TINT: [number, number, number] = [237, 243, 249]
const ROW_TINT: [number, number, number] = [248, 250, 252]
const RATING_COLORS: Record<string, [number, number, number]> = {
  good: [214, 240, 224],
  fair: [252, 239, 204],
  poor: [250, 218, 216],
  na: [233, 236, 240],
}

type TextRun = { text: string; bold?: boolean; italic?: boolean; underline?: boolean }
type RichCellLine = TextRun[]

function parseFormattedText(source: string): TextRun[] {
  const runs: TextRun[] = []
  const pattern = /(\*\*[\s\S]+?\*\*|__[\s\S]+?__|\*[\s\S]+?\*)/g
  for (const line of source.split(/\r?\n/)) {
    const bullet = /^\s*-\s+/.test(line)
    const content = bullet ? line.replace(/^\s*-\s+/, "") : line
    if (bullet) runs.push({ text: "• " })
    let cursor = 0
    for (const match of content.matchAll(pattern)) {
      const index = match.index ?? 0
      if (index > cursor) runs.push({ text: content.slice(cursor, index) })
      const token = match[0]
      if (token.startsWith("**")) runs.push({ text: token.slice(2, -2), bold: true })
      else if (token.startsWith("__")) runs.push({ text: token.slice(2, -2), underline: true })
      else runs.push({ text: token.slice(1, -1), italic: true })
      cursor = index + token.length
    }
    if (cursor < content.length) runs.push({ text: content.slice(cursor) })
    runs.push({ text: "\n" })
  }
  if (runs.at(-1)?.text === "\n") runs.pop()
  return runs
}

function plainFormattedText(runs: TextRun[]) {
  return runs.map((run) => run.text).join("")
}

function wrapFormattedText(doc: JsPDF, runs: TextRun[], width: number): RichCellLine[] {
  const lines: RichCellLine[] = [[]]
  let lineWidth = 0
  const append = (text: string, style: Omit<TextRun, "text">) => {
    if (!text) return
    const line = lines[lines.length - 1]
    const previous = line[line.length - 1]
    if (previous && previous.bold === style.bold && previous.italic === style.italic && previous.underline === style.underline) {
      previous.text += text
    } else line.push({ text, ...style })
  }

  for (const run of runs) {
    const style = { bold: run.bold, italic: run.italic, underline: run.underline }
    doc.setFont("helvetica", run.bold && run.italic ? "bolditalic" : run.bold ? "bold" : run.italic ? "italic" : "normal")
    for (const token of run.text.split(/(\n|\s+)/).filter(Boolean)) {
      if (token === "\n") {
        lines.push([])
        lineWidth = 0
        continue
      }
      const tokenWidth = doc.getTextWidth(token)
      if (!/^\s+$/.test(token) && lineWidth > 0 && lineWidth + tokenWidth > width) {
        lines.push([])
        lineWidth = 0
      }
      if (/^\s+$/.test(token) && lineWidth === 0) continue
      append(token, style)
      lineWidth += tokenWidth
    }
  }
  return lines
}

const MARGIN = 14
const TOP = 26

function cleanReportText(value: string) {
  return value
    .replace(
      /\s*SUPERINTENDENT[’']S\s+DETAILED\s+INSPECTION\s+REPORT\s+Page\s+\d+\s+of\s+\d+\s*/gi,
      " ",
    )
    .replace(/(?:^|\n)\s*16\.02\.00\.003\.04\s*(?=\n|$)/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

export function formatDate(value?: string) {
  if (!value) return ""
  const d = new Date(`${value}T00:00:00`)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

function fieldValue(field: FieldDef, values: Record<string, string>) {
  const raw = cleanReportText(values[field.key]?.trim() ?? "")
  if (!raw) return "-"
  if (field.type === "date") return formatDate(raw)
  return field.unit ? `${raw} ${field.unit}` : raw
}

function loadImageSize(dataUrl: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight })
    img.onerror = () => resolve({ w: 4, h: 3 })
    img.src = dataUrl
  })
}

function loadLogo(): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = companyLogo.src
  })
}

function drawConditionRisk(
  doc: JsPDF,
  label: string,
  values: Record<string, ConditionEntry>,
  x: number,
  y: number,
  width: number,
) {
  const score = conditionRiskScore(values)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8.5)
  doc.setTextColor(...INK)
  doc.text(
    score === null ? `${label}: Not assessed` : `${label}: ${score}% - ${conditionRiskBand(score)}`,
    x,
    y,
  )

  const barY = y + 3
  const barH = 4
  const segments = [
    { start: 10, end: 30, color: [101, 168, 66] as [number, number, number] },
    { start: 30, end: 50, color: [224, 197, 45] as [number, number, number] },
    { start: 50, end: 70, color: [239, 139, 34] as [number, number, number] },
    { start: 70, end: 100, color: [207, 60, 51] as [number, number, number] },
  ]
  const scaleX = x + width * (10 / 100)
  const scaleW = width * (90 / 100)
  for (const segment of segments) {
    const segmentX = x + width * (segment.start / 100)
    const segmentW = width * ((segment.end - segment.start) / 100)
    doc.setFillColor(...segment.color)
    doc.rect(segmentX, barY, segmentW, barH, "F")
  }
  doc.setDrawColor(0, 0, 0)
  doc.setLineWidth(0.2)
  doc.rect(scaleX, barY, scaleW, barH, "S")
  if (score !== null) {
    const markerX = x + width * (score / 100)
    doc.setFillColor(20, 20, 20)
    doc.triangle(markerX - 1.6, barY - 1, markerX + 1.6, barY - 1, markerX, barY + 1.4, "F")
  }

  doc.setFont("helvetica", "normal")
  doc.setFontSize(6.5)
  doc.setTextColor(...MUTED)
  for (const tick of [10, 30, 50, 70, 100]) {
    const tickX = x + width * (tick / 100)
    doc.text(`${tick}%`, tickX, barY + 8, {
      align: tick === 10 ? "left" : tick === 100 ? "right" : "center",
    })
  }
}

export async function generateReportPdf(report: Report, photos: Photo[]) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")])
  const doc = new jsPDF({ unit: "mm", format: "a4" })
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  const contentW = pageW - MARGIN * 2
  let y = TOP

  const lastY = () => (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY

  const ensureSpace = (needed: number) => {
    if (y + needed > pageH - 18) {
      doc.addPage()
      y = TOP
    }
  }

  const heading = (text: string, sub?: string) => {
    ensureSpace(20)
    doc.setFillColor(...NAVY)
    doc.setFillColor(221, 232, 244)
    doc.roundedRect(MARGIN, y, contentW, 8, 1.2, 1.2, "F")
    doc.setFillColor(...NAVY)
    doc.roundedRect(MARGIN, y, 1.4, 8, 0.7, 0.7, "F")
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11.5)
    doc.setTextColor(...NAVY)
    doc.text(text.toUpperCase(), MARGIN + 5, y + 5.4)
    y += 10
    if (sub) {
      doc.setFont("helvetica", "normal")
      doc.setFontSize(8)
      doc.setTextColor(...MUTED)
      const lines = doc.splitTextToSize(sub, contentW)
      doc.text(lines, MARGIN, y + 2.5)
      y += lines.length * 3.6 + 2
    }
  }

  const subheading = (text: string) => {
    ensureSpace(14)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    doc.setTextColor(...MUTED)
    doc.text(text.toUpperCase(), MARGIN, y + 3)
    y += 5
  }

  const formattedCells = new WeakMap<object, { runs: TextRun[]; color: [number, number, number] }>()
  const prepareFormattedCell = (data: Parameters<NonNullable<Parameters<typeof autoTable>[1]["didParseCell"]>>[0]) => {
    if (data.section !== "body") return
    const source = typeof data.cell.raw === "string" ? data.cell.raw : data.cell.text.join("\n")
    if (!/(\*\*|__|\*[^*])/.test(source)) return
    const runs = parseFormattedText(source)
    const plain = plainFormattedText(runs)
    if (plain === source) return
    const originalColor = data.cell.styles.textColor
    const color = Array.isArray(originalColor) ? originalColor as [number, number, number] : INK
    formattedCells.set(data.cell, { runs, color })
    data.cell.text = plain.split(/\r?\n/)
    const fill = data.cell.styles.fillColor
    data.cell.styles.textColor = Array.isArray(fill) ? fill : [255, 255, 255]
  }

  const drawFormattedCell = (data: Parameters<NonNullable<Parameters<typeof autoTable>[1]["didDrawCell"]>>[0]) => {
    const formatted = formattedCells.get(data.cell)
    if (!formatted) return
    const { cell } = data
    const fontSize = cell.styles.fontSize
    const scale = doc.internal.scaleFactor
    const paddingLeft = cell.padding("left")
    const paddingRight = cell.padding("right")
    const lines = wrapFormattedText(doc, formatted.runs, Math.max(4, cell.width - paddingLeft - paddingRight))
    const lineHeight = (fontSize / scale) * 1.15
    let baseline = cell.y + cell.padding("top") + (fontSize / scale) * 0.8
    for (const line of lines) {
      let x = cell.x + paddingLeft
      for (const run of line) {
        const fontStyle = run.bold && run.italic ? "bolditalic" : run.bold ? "bold" : run.italic ? "italic" : "normal"
        doc.setFont("helvetica", fontStyle)
        doc.setFontSize(fontSize)
        doc.setTextColor(...formatted.color)
        doc.text(run.text, x, baseline)
        const width = doc.getTextWidth(run.text)
        if (run.underline) {
          doc.setDrawColor(...formatted.color)
          doc.setLineWidth(0.15)
          doc.line(x, baseline + 0.45, x + width, baseline + 0.45)
        }
        x += width
      }
      baseline += lineHeight
    }
  }

  const baseTable = {
    margin: { left: MARGIN, right: MARGIN, top: TOP, bottom: 18 },
    theme: "grid" as const,
    styles: {
      font: "helvetica",
      fontSize: 8.5,
      cellPadding: { top: 2.4, right: 2.6, bottom: 2.4, left: 2.6 },
      textColor: INK,
      lineColor: LINE,
      lineWidth: 0.12,
      halign: "left" as const,
      valign: "top" as const,
      overflow: "linebreak" as const,
    },
    headStyles: {
      fillColor: NAVY,
      textColor: [255, 255, 255] as [number, number, number],
      fontStyle: "bold" as const,
      halign: "left" as const,
      cellPadding: { top: 3, right: 2.6, bottom: 3, left: 2.6 },
    },
    alternateRowStyles: { fillColor: ROW_TINT },
    didParseCell: prepareFormattedCell,
    didDrawCell: drawFormattedCell,
  }

  const kvTable = (fields: FieldDef[], values: Record<string, string>) => {
    const rows: string[][] = []
    const half = fields.filter((f) => f.type !== "textarea")
    const full = fields.filter((f) => f.type === "textarea")
    for (let i = 0; i < half.length; i += 2) {
      const a = half[i]
      const b = half[i + 1]
      rows.push([a.label, fieldValue(a, values), b?.label ?? "", b ? fieldValue(b, values) : ""])
    }
    if (rows.length) {
      autoTable(doc, {
        ...baseTable,
        startY: y,
        body: rows,
        columnStyles: {
          0: { cellWidth: 36, fillColor: TINT, fontStyle: "bold", fontSize: 7.5, textColor: MUTED },
          1: { cellWidth: contentW / 2 - 36 },
          2: { cellWidth: 36, fillColor: TINT, fontStyle: "bold", fontSize: 7.5, textColor: MUTED },
          3: { cellWidth: contentW / 2 - 36 },
        },
      })
      y = lastY() + 3
    }
    if (full.length) longTextTable(full, values)
  }

  const longTextTable = (fields: FieldDef[], values: Record<string, string>) => {
    autoTable(doc, {
      ...baseTable,
      startY: y,
      body: fields.map((f) => [f.label, cleanReportText(values[f.key]?.trim() ?? "") || "-"]),
      columnStyles: {
        0: { cellWidth: 44, fillColor: TINT, fontStyle: "bold", fontSize: 7.5, textColor: MUTED },
        1: { cellWidth: contentW - 44 },
      },
    })
    y = lastY() + 5
  }

  const conditionTable = (items: ConditionItem[], values: Record<string, ConditionEntry>) => {
    autoTable(doc, {
      ...baseTable,
      startY: y,
      head: [["#", "Inspection item", "Rating"]],
      body: items.flatMap((item, i) => {
        const entry = values[item.key]
        const rating = RATINGS.find((r) => r.value === entry?.rating)?.label ?? "-"
        const label = item.hint ? `${item.label}\n(${item.hint})` : item.label
        const remarks = cleanReportText(entry?.remarks?.trim() ?? "") || "-"
        return [
          [String(i + 1), label, rating],
          [{ content: `Remarks / Findings: ${remarks}`, colSpan: 3, styles: { halign: "left" as const } }],
        ]
      }),
      columnStyles: {
        0: { cellWidth: 8, halign: "center" },
        1: { cellWidth: contentW - 30, fontStyle: "bold" },
        2: { cellWidth: 22, halign: "center", fontStyle: "bold" },
      },
      didParseCell: (data) => {
        if (data.section === "body" && data.column.index === 2 && data.row.index % 2 === 0) {
          const entry = values[items[Math.floor(data.row.index / 2)].key]
          const color = entry?.rating ? RATING_COLORS[entry.rating] : undefined
          if (color) data.cell.styles.fillColor = color
        }
        prepareFormattedCell(data)
      },
    })
    y = lastY() + 5
  }

  // Cover block
  doc.setFont("helvetica", "bold")
  doc.setFontSize(18)
  doc.setTextColor(...NAVY)
  doc.text("SUPERINTENDENT'S DETAILED", MARGIN, y + 6)
  doc.text("INSPECTION REPORT", MARGIN, y + 13)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  const vesselLine = [report.details.vessel, report.details.port].filter(Boolean).join("  |  ")
  if (vesselLine) doc.text(vesselLine, MARGIN, y + 19)
  const logo = await loadLogo()
  if (logo) {
    doc.addImage(logo, "PNG", pageW - MARGIN - 22, y - 2, 22, 22)
  } else {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8)
    doc.setTextColor(...NAVY)
    doc.text("GOODWOOD SHIPMANAGEMENT", pageW - MARGIN, y + 8, { align: "right" })
  }
  y += 25

  heading("Inspection Details")
  for (const group of DETAILS_GROUPS) {
    if (group.title) subheading(group.title)
    kvTable(group.fields, report.details)
  }
  if (report.signoff.inspectorSignature) {
    ensureSpace(26)
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    doc.text("INSPECTOR SIGNATURE", MARGIN, y + 3)
    doc.addImage(report.signoff.inspectorSignature, "PNG", MARGIN, y + 4, 50, 18)
    y += 26
  }

  heading("Principal Particulars")
  for (const group of PARTICULARS_GROUPS) {
    if (group.title) subheading(group.title)
    kvTable(group.fields, report.particulars)
  }

  heading("Executive Summary")
  longTextTable(SUMMARY_FIELDS, report.summary)

  heading("Scope of Inspection", "The scope of this inspection covered the following areas:")
  autoTable(doc, {
    ...baseTable,
    startY: y,
    head: [["#", "Area", "Covered"]],
    body: SCOPE_ITEMS.map((s, i) => [String(i + 1), s.label, report.scope[s.key] ? "Yes" : "No"]),
    columnStyles: {
      0: { cellWidth: 8, halign: "center" },
      1: { cellWidth: contentW - 30 },
      2: { cellWidth: 22, halign: "center", fontStyle: "bold" },
    },
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 2) {
        data.cell.styles.fillColor = report.scope[SCOPE_ITEMS[data.row.index].key] ? RATING_COLORS.good : RATING_COLORS.na
      }
      prepareFormattedCell(data)
    },
  })
  y = lastY() + 5

  ensureSpace(48)
  heading("Vessel Condition Risk Overview")
  drawConditionRisk(doc, "Overall vessel condition", { ...report.deck, ...report.engine }, MARGIN, y, contentW)
  y += 15
  for (const section of CONDITION_SECTIONS) {
    ensureSpace(30)
    heading(section.title)
    const sourceValues = section.source === "deck" ? report.deck : report.engine
    const values = Object.fromEntries(section.items.map((item) => [item.key, sourceValues[item.key]]))
    drawConditionRisk(doc, `${section.title} condition`, values, MARGIN, y, contentW)
    y += 15
    conditionTable(section.items, values)
  }

  const managementTitles = [
    ["critical", "Critical Equipment"], ["system", "System Implementation"],
    ["survey", "Class Survey Status"], ["budget", "Budget"], ["crew", "Crew Evaluation"],
  ] as const
  for (const [key, title] of managementTitles) {
    heading(title)
    for (const group of MANAGEMENT_SECTION_GROUPS[key]) {
      if (group.title) subheading(group.title)
      if (group.description) {
        doc.setFont("helvetica", "italic")
        doc.setFontSize(7.5)
        doc.setTextColor(...MUTED)
        const lines = doc.splitTextToSize(group.description, contentW)
        ensureSpace(lines.length * 3.4 + 4)
        doc.text(lines, MARGIN, y + 2.5)
        y += lines.length * 3.4 + 1.5
      }
      if (key === "critical") {
        autoTable(doc, {
          ...baseTable,
          startY: y,
          head: [["Selected", "Critical equipment"]],
          body: CRITICAL_EQUIPMENT_ITEMS.map((item) => [
            report.management[item.key] === "true" || item.legacyKeys?.some((key) => report.management[key] === "true") ? "Yes" : "No",
            item.label,
          ]),
          columnStyles: {
            0: { cellWidth: 20, halign: "center", fontStyle: "bold" },
            1: { cellWidth: contentW - 20 },
          },
        })
        y = lastY() + 3
      }
      if (key === "crew") kvTable(group.fields, report.management)
      else longTextTable(group.fields, report.management)
    }
  }

  heading("Superintendent Sign-off")
  autoTable(doc, {
    ...baseTable,
    startY: y,
    body: WORKLIST_ITEMS.map((w) => [report.worklist[w.key] ? "Yes" : "No", cleanReportText(w.label)]),
    columnStyles: { 0: { cellWidth: 14, halign: "center", fontStyle: "bold" }, 1: { cellWidth: contentW - 14 } },
  })
  y = lastY() + 5
  ensureSpace(36)
  doc.setFont("helvetica", "bold")
  doc.setFontSize(7.5)
  doc.setTextColor(...MUTED)
  doc.text("SUPERINTENDENT ENGINEER", MARGIN, y + 3)
  doc.setFont("helvetica", "normal")
  doc.setFontSize(10)
  doc.setTextColor(...INK)
  doc.text(report.signoff.superintendentName || "-", MARGIN, y + 9)
  if (report.signoff.superintendentSignature) {
    doc.addImage(report.signoff.superintendentSignature, "PNG", MARGIN, y + 11, 56, 20)
  }
  doc.setDrawColor(...LINE)
  doc.line(MARGIN, y + 32, MARGIN + 70, y + 32)
  doc.setFontSize(7)
  doc.setTextColor(...MUTED)
  doc.text("Signature", MARGIN, y + 35.5)
  y += 40

  const ownerPhotos = photos.filter((p) => p.includeInOwnerReport)
  if (ownerPhotos.length) {
    const frameX = MARGIN + 10
    const frameW = contentW - 20
    const imageH = 94
    for (let start = 0; start < ownerPhotos.length; start += 2) {
      const end = Math.min(start + 2, ownerPhotos.length)
      doc.addPage()
      y = TOP
      heading(
        `Photographs (${start + 1}-${end} of ${ownerPhotos.length})`,
        "Two photographs per page; images are centered and framed for printing.",
      )
      for (let i = start; i < end; i++) {
        const photo = ownerPhotos[i]
        const row = i - start
        const frameY = y + 2 + row * 112
        const { w, h } = await loadImageSize(photo.dataUrl)
        const ratio = Math.min(frameW / w, imageH / h)
        const dw = w * ratio
        const dh = h * ratio
        doc.setFillColor(255, 255, 255)
        doc.rect(frameX, frameY, frameW, imageH, "F")
        doc.addImage(
          photo.dataUrl,
          "JPEG",
          frameX + (frameW - dw) / 2,
          frameY + (imageH - dh) / 2,
          dw,
          dh,
          undefined,
          "FAST",
        )
        doc.setDrawColor(0, 0, 0)
        doc.setLineWidth(0.5)
        doc.rect(frameX, frameY, frameW, imageH, "S")
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        doc.setTextColor(...INK)
        doc.text(`${i + 1}. ${photo.category}`, frameX, frameY + imageH + 4, { maxWidth: frameW })
        if (photo.caption) {
          doc.setFont("helvetica", "normal")
          doc.setFontSize(7.5)
          doc.setTextColor(...MUTED)
          doc.text(doc.splitTextToSize(photo.caption, frameW).slice(0, 2), frameX, frameY + imageH + 8)
        }
      }
    }
  }

  drawChrome(doc, report, pageW, pageH)

  const vesselSlug = (report.details.vessel || "vessel").replace(/[^A-Za-z0-9]+/g, "-")
  const reportSlug = (report.details.reportNo || report.id.slice(0, 6)).replace(/[^A-Za-z0-9]+/g, "-")
  doc.save(`SIR_${vesselSlug}_${reportSlug}.pdf`)
}

function drawChrome(doc: JsPDF, report: Report, pageW: number, pageH: number) {
  const total = doc.getNumberOfPages()
  for (let i = 1; i <= total; i++) {
    doc.setPage(i)
    doc.setFillColor(...NAVY)
    doc.rect(0, 0, pageW, 14, "F")
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    doc.setTextColor(255, 255, 255)
    doc.text("SUPERINTENDENT'S DETAILED INSPECTION REPORT", MARGIN, 8.8)
    doc.setFont("helvetica", "normal")
    doc.text(`Form ${FORM_CODE}`, pageW - MARGIN, 8.8, { align: "right" })

    doc.setDrawColor(...LINE)
    doc.line(MARGIN, pageH - 12, pageW - MARGIN, pageH - 12)
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    const left = [report.details.vessel, report.details.reportNo && `Report ${report.details.reportNo}`]
      .filter(Boolean)
      .join("  |  ")
    doc.text(left || "Draft report", MARGIN, pageH - 7.5)
    doc.text(`Page ${i} of ${total}`, pageW - MARGIN, pageH - 7.5, { align: "right" })
  }
}
