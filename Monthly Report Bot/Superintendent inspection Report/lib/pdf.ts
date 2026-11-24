"use client"

import type { jsPDF as JsPDF } from "jspdf"
import type { RowInput } from "jspdf-autotable"
import companyLogo from "../public/logo.png"
import { outstandingForFinal, outstandingForReview, superintendentName, superintendentSignature } from "./completeness"
import { particularsForPdf } from "./particulars"
import {
  COVERAGE_LABELS,
  areaOverview,
  conclusion,
  findingRef,
  findingsRegister,
  keyFigures,
  limitations,
  raPending,
  type Coverage,
} from "./condition-overview"
import {
  CONDITION_SECTIONS,
  CRITICAL_EQUIPMENT_ITEMS,
  DETAILS_GROUPS,
  FORM_CODE,
  MANAGEMENT_SECTION_GROUPS,
  RATINGS,
  SCOPE_ITEMS,
  SUMMARY_FIELDS,
  WORKLIST_ITEMS,
  FINDING_PRIORITIES,
  effectiveRating,
  emptyFinding,
  isCriticalTested,
  needsFinding,
  ratingLabel,
  type ConditionEntry,
  type ConditionItem,
  type FieldDef,
  type Finding,
  type Photo,
  type Report,
} from "./form-schema"

// Goodwood brand palette (from the company templates): navy #003152, logo indigo #1E1161, green #7AC043,
// wordmark grey #5A5B5D, light greys #F2F2F2 / #DDDFDE. Severity colours are muted so they stay readable in print.
type RGB = [number, number, number]
const NAVY: RGB = [0, 49, 82]
const GREEN: RGB = [122, 192, 67]
const INK: RGB = [33, 35, 38]
const MUTED: RGB = [90, 91, 93]
const LINE: RGB = [221, 223, 222]
const TINT: RGB = [242, 242, 242]
const ROW_TINT: RGB = [249, 249, 249]
// Condition colours: a light fill for table cells and a stronger tone for text and markers (muted for print).
// Earlier-scale ratings use the colour of the nearest current grade.
const RATING_COLORS: Record<string, RGB> = {
  satisfactory: [228, 242, 216],
  good: [228, 242, 216],
  acceptable: [221, 235, 247],
  degraded: [252, 240, 207],
  fair: [252, 240, 207],
  deficient: [247, 218, 214],
  poor: [247, 218, 214],
  notInspected: [236, 237, 237],
  na: [236, 237, 237],
}
const RATING_TONES: Record<string, RGB> = {
  satisfactory: [61, 120, 36],
  good: [61, 120, 36],
  acceptable: [32, 96, 150],
  degraded: [150, 104, 0],
  fair: [150, 104, 0],
  deficient: [166, 42, 36],
  poor: [166, 42, 36],
  notInspected: [90, 91, 93],
  na: [90, 91, 93],
}
const COVERAGE_COLORS: Record<Coverage, { fill: RGB; text: RGB }> = {
  complete: { fill: RATING_COLORS.satisfactory, text: RATING_TONES.satisfactory },
  limited: { fill: RATING_COLORS.degraded, text: RATING_TONES.degraded },
  incomplete: { fill: RATING_COLORS.deficient, text: RATING_TONES.deficient },
  notApplicable: { fill: RATING_COLORS.na, text: MUTED },
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


/** RA wording for a finding: the number and its status as at the report date. */
function raText(f: Finding) {
  const ref = f.raRef.trim()
  if (f.raStatus === "notRequired") return "Not required"
  if (f.raStatus === "completed") return ref || "Completed"
  if (f.raStatus === "pending") return ref ? `${ref} (pending)` : "Pending"
  return "Not stated"
}

const priorityLabel = (f: Finding) => FINDING_PRIORITIES.find((p) => p.value === f.priority)?.label ?? "Not set"

/** One-paragraph reference line printed under a finding in the condition tables. */
function findingLine(ref: string, f: Finding) {
  const parts = [`Finding ${ref}`, `Priority: ${priorityLabel(f)}`]
  if (f.dueDate && f.priority !== "drydock") parts.push(`Due: ${formatDate(f.dueDate)}`)
  parts.push(`RA: ${raText(f)}`)
  if (f.defectRef.trim()) parts.push(`Defect list: ${f.defectRef.trim()}`)
  parts.push(f.status === "closed" ? "Closed" : "Open")
  if (f.safetyCritical) parts.push("Safety-critical")
  return `${parts.join(" · ")}\nAction / controls: ${cleanReportText(f.action.trim()) || "-"}`
}

export async function generateReportPdf(report: Report, photos: Photo[]) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")])
  const doc = new jsPDF({ unit: "mm", format: "a4" })
  // A report is final only when every mandatory input is complete and the Fleet Manager has approved it.
  const missingForReview = outstandingForReview(report, photos.length).length
  const draft = outstandingForFinal(report, photos.length).length > 0
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
    // Room for the heading plus the start of its content, so a heading is never left alone at the foot of a page.
    ensureSpace(36)
    // Navy title with the brand-green accent and a hairline rule.
    doc.setFillColor(...GREEN)
    doc.rect(MARGIN, y + 0.6, 1.3, 6.4, "F")
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11.5)
    doc.setTextColor(...NAVY)
    doc.text(text.toUpperCase(), MARGIN + 4, y + 5.6)
    doc.setDrawColor(...LINE)
    doc.setLineWidth(0.3)
    doc.line(MARGIN, y + 8.6, MARGIN + contentW, y + 8.6)
    y += 11
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

  /**
   * Written sections: the label sits on a tinted bar above the text, and the text uses the full page width, justified.
   * Each paragraph is its own row, because a justified block stretches every line except its very last one.
   */
  const longTextTable = (fields: FieldDef[], values: Record<string, string>, options: { hideLabels?: boolean } = {}) => {
    const body: RowInput[] = []
    const labelRows = new Set<number>()
    for (const field of fields) {
      if (!options.hideLabels) labelRows.add(body.length)
      if (!options.hideLabels) body.push([{ content: field.label.toUpperCase(), styles: { fillColor: TINT, textColor: NAVY, fontStyle: "bold", fontSize: 7.5, cellPadding: { top: 1.9, right: 2.6, bottom: 1.9, left: 4 } } }])
      const text = cleanReportText(values[field.key]?.trim() ?? "")
      const paragraphs = text ? text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean) : ["-"]
      paragraphs.forEach((paragraph, index) => {
        const justify = !paragraph.includes("\n") && !/^\s*[-•]/.test(paragraph)
        body.push([
          {
            content: paragraph,
            styles: {
              halign: justify ? "justify" : "left",
              fontSize: 9,
              cellPadding: { top: index === 0 ? 2.4 : 0.8, right: 2.6, bottom: index === paragraphs.length - 1 ? 3.4 : 1.4, left: 2.6 },
            },
          },
        ])
      })
    }
    autoTable(doc, {
      ...baseTable,
      theme: "plain",
      startY: y,
      body,
      alternateRowStyles: {},
      styles: { ...baseTable.styles, lineWidth: 0 },
      columnStyles: { 0: { cellWidth: contentW } },
      didDrawCell: (data) => {
        if (data.section === "body" && labelRows.has(data.row.index)) {
          doc.setFillColor(...GREEN)
          doc.rect(data.cell.x, data.cell.y, 1.1, data.cell.height, "F")
        }
        drawFormattedCell(data)
      },
    })
    y = lastY() + 4
  }

  const conditionTable = (items: ConditionItem[], values: Record<string, ConditionEntry>, areaId: string) => {
    const rows: RowInput[] = []
    // What each body row is, so colours do not depend on row parity (a finding adds a third row to an item).
    const kinds: { kind: "item" | "remarks" | "finding"; rating: string }[] = []
    items.forEach((item, i) => {
      const entry = values[item.key]
      const rating = effectiveRating(entry?.rating)
      const label = item.hint ? `${item.label}\n(${item.hint})` : item.label
      const remarks = cleanReportText(entry?.remarks?.trim() ?? "") || "-"
      const remarksLabel = rating === "notInspected" ? "Reason not inspected" : "Remarks / Findings"
      rows.push([String(i + 1), label, ratingLabel(rating) || "-"])
      kinds.push({ kind: "item", rating })
      // One row per paragraph, so every paragraph is justified (only a block's last line stays short); inner borders
      // are hidden, so the paragraphs read as one remarks box.
      const paragraphs = remarks.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      paragraphs.forEach((text, p) => {
        const first = p === 0
        const last = p === paragraphs.length - 1
        rows.push([
          {
            content: first ? `${remarksLabel}: ${text}` : text,
            colSpan: 3,
            styles: {
              halign: text.includes("\n") ? ("left" as const) : ("justify" as const),
              lineWidth: { top: first ? 0.12 : 0, bottom: last ? 0.12 : 0, left: 0.12, right: 0.12 },
              cellPadding: { top: first ? 2.4 : 0.6, bottom: last ? 2.4 : 0.6, left: 2.6, right: 2.6 },
            },
          },
        ])
        kinds.push({ kind: "remarks", rating })
      })
      if (needsFinding(rating)) {
        rows.push([{ content: findingLine(findingRef(areaId, i), entry?.finding ?? emptyFinding()), colSpan: 3, styles: { fontSize: 7.6, halign: "left" as const } }])
        kinds.push({ kind: "finding", rating })
      }
    })
    autoTable(doc, {
      ...baseTable,
      startY: y,
      head: [["#", "Inspection item", "Rating"]],
      body: rows,
      columnStyles: {
        0: { cellWidth: 10, halign: "center" },
        1: { cellWidth: contentW - 34, fontStyle: "bold" },
        2: { cellWidth: 24, halign: "center", fontStyle: "bold" },
      },
      didParseCell: (data) => {
        if (data.section === "body") {
          const row = kinds[data.row.index]
          data.cell.styles.fillColor = row.kind === "item" ? ROW_TINT : row.kind === "finding" ? RATING_COLORS[row.rating] : [255, 255, 255]
          if (row.kind === "item" && data.column.index === 2 && row.rating) {
            data.cell.styles.fillColor = RATING_COLORS[row.rating]
            data.cell.styles.textColor = RATING_TONES[row.rating]
          }
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
  doc.setFillColor(...GREEN)
  doc.rect(MARGIN, y + 15.2, 22, 0.9, "F")
  doc.setFont("helvetica", "normal")
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  const vesselLine = [report.details.vessel, report.details.port].filter(Boolean).join("  |  ")
  if (vesselLine) doc.text(vesselLine, MARGIN, y + 20)
  if (draft) {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    doc.setTextColor(180, 35, 35)
    doc.text(
      missingForReview
        ? `DRAFT – ${missingForReview} mandatory item${missingForReview === 1 ? "" : "s"} outstanding; not approved by the Fleet Manager`
        : "DRAFT – awaiting the Fleet Manager's review and approval",
      MARGIN,
      y + 24,
    )
    doc.setFont("helvetica", "normal")
  }
  const logo = await loadLogo()
  if (logo) {
    doc.addImage(logo, "PNG", pageW - MARGIN - 22, y - 2, 22, 22)
  } else {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8)
    doc.setTextColor(...NAVY)
    doc.text("GOODWOOD SHIPMANAGEMENT", pageW - MARGIN, y + 8, { align: "right" })
  }
  y += draft ? 29 : 25

  heading("Inspection Details")
  for (const group of DETAILS_GROUPS) {
    if (group.title) subheading(group.title)
    kvTable(group.fields, report.details)
  }
  const suptSignature = superintendentSignature(report)
  if (suptSignature) {
    ensureSpace(26)
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    doc.text("SUPERINTENDENT SIGNATURE", MARGIN, y + 3)
    doc.addImage(suptSignature, "PNG", MARGIN, y + 4, 50, 18)
    y += 26
  }

  heading("Principal Particulars")
  // Earlier reports print their four groups exactly as before; new reports the six Vessel Master groups.
  for (const group of particularsForPdf(report)) {
    if (group.title) subheading(group.title)
    kvTable(group.fields, group.values)
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
      0: { cellWidth: 10, halign: "center" },
      1: { cellWidth: contentW - 32 },
      2: { cellWidth: 22, halign: "center", fontStyle: "bold" },
    },
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 2) {
        data.cell.styles.fillColor = report.scope[SCOPE_ITEMS[data.row.index].key] ? RATING_COLORS.satisfactory : RATING_COLORS.na
      }
      prepareFormattedCell(data)
    },
  })
  y = lastY() + 5

  const sectionValues = (section: (typeof CONDITION_SECTIONS)[number]) => {
    const source = section.source === "deck" ? report.deck : report.engine
    return Object.fromEntries(section.items.map((item) => [item.key, source[item.key]])) as Record<string, ConditionEntry>
  }
  const areas = areaOverview(report)
  const figures = keyFigures(report)
  const register = findingsRegister(report)

  // Condition & Assurance Overview: worst observed condition per area, coverage, critical tests and the findings
  // raised. Condition ratings are not risk ratings, so no score or average is derived from them.
  ensureSpace(120)
  heading(
    "Condition & Assurance Overview",
    "Observed condition by area, inspection coverage, critical-equipment tests and the findings raised. Condition ratings describe the observed condition; they are not risk ratings. Risk is assessed under the Company’s risk assessment procedure.",
  )
  // The overall conclusion is withheld while coverage is incomplete; no overall grade is calculated.
  const verdict = conclusion(report)
  const verdictTone = verdict.state === "withheld" ? "degraded" : verdict.state === "limited" ? "acceptable" : "satisfactory"
  doc.setFont("helvetica", "bold")
  doc.setFontSize(8.5)
  const verdictLines = doc.splitTextToSize(verdict.text, contentW - 8) as string[]
  const verdictH = verdictLines.length * 3.8 + 4
  doc.setFillColor(...RATING_COLORS[verdictTone])
  doc.rect(MARGIN, y, contentW, verdictH, "F")
  doc.setFillColor(...RATING_TONES[verdictTone])
  doc.rect(MARGIN, y, 1.2, verdictH, "F")
  doc.setTextColor(...INK)
  doc.text(verdictLines, MARGIN + 4, y + 4.7)
  y += verdictH + 3

  // Key figures
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const tiles = [
    { label: "COVERAGE", value: `${figures.coverage.assessed} / ${figures.coverage.applicable}`, note: figures.coverage.percent === null ? "" : `${figures.coverage.percent}%`, alert: false },
    { label: "CRITICAL TESTS", value: `${figures.critical.tested} / ${figures.critical.total}`, note: figures.critical.defects ? plural(figures.critical.defects, "defect") : "", alert: figures.critical.defects > 0 },
    { label: "DEFICIENT (NC)", value: String(figures.deficient), note: "", alert: figures.deficient > 0 },
    { label: "IMMEDIATE ACTIONS", value: String(figures.immediate), note: "", alert: figures.immediate > 0 },
    { label: "OPEN FINDINGS", value: String(figures.openFindings), note: "", alert: false },
    { label: "RA PENDING", value: String(figures.raPending), note: "", alert: figures.raPending > 0 },
  ]
  const tileGap = 2.4
  const tileW = (contentW - tileGap * (tiles.length - 1)) / tiles.length
  tiles.forEach((tile, index) => {
    const x = MARGIN + index * (tileW + tileGap)
    doc.setDrawColor(...LINE)
    doc.setLineWidth(0.25)
    doc.setFillColor(255, 255, 255)
    doc.rect(x, y, tileW, 14, "FD")
    doc.setFont("helvetica", "bold")
    doc.setFontSize(6.3)
    doc.setTextColor(...MUTED)
    doc.text(tile.label, x + 2.4, y + 4.4)
    doc.setFontSize(11)
    doc.setTextColor(...(tile.alert ? RATING_TONES.deficient : NAVY))
    doc.text(tile.value, x + 2.4, y + 10.9)
    if (tile.note) {
      const valueW = doc.getTextWidth(tile.value)
      doc.setFont("helvetica", "normal")
      doc.setFontSize(7)
      doc.setTextColor(...(tile.alert ? RATING_TONES.deficient : MUTED))
      doc.text(tile.note, x + 2.4 + valueW + 1.5, y + 10.9)
    }
  })
  y += 18

  // Condition by area
  const tight = { top: 1.8, right: 1.6, bottom: 1.8, left: 1.6 }
  autoTable(doc, {
    ...baseTable,
    startY: y,
    head: [["Area", "Assessed", "Worst observed condition", "Deficient", "Degraded", "Immediate", "Coverage"]],
    body: areas.map((a) => [
      a.title,
      `${a.assessed} / ${a.applicable}`,
      a.worst ? ratingLabel(a.worst) : "Not assessed",
      String(a.deficient),
      String(a.degraded),
      String(a.immediate),
      COVERAGE_LABELS[a.coverage],
    ]),
    styles: { ...baseTable.styles, fontSize: 8, cellPadding: tight, valign: "middle" },
    headStyles: { ...baseTable.headStyles, cellPadding: { ...tight, top: 2.4, bottom: 2.4 } },
    columnStyles: {
      0: { cellWidth: 50 },
      1: { cellWidth: 16, halign: "center" },
      2: { cellWidth: 34, halign: "center", fontStyle: "bold" },
      3: { cellWidth: 18, halign: "center" },
      4: { cellWidth: 18, halign: "center" },
      5: { cellWidth: 18, halign: "center" },
      6: { cellWidth: contentW - 154, halign: "center", fontStyle: "bold" },
    },
    didParseCell: (data) => {
      if (data.section === "head" && data.column.index > 0) data.cell.styles.halign = "center"
      if (data.section !== "body") return
      const area = areas[data.row.index]
      const strong = (tone: string) => {
        data.cell.styles.textColor = RATING_TONES[tone]
        data.cell.styles.fontStyle = "bold"
      }
      if (data.column.index === 2) {
        if (area.worst) {
          data.cell.styles.fillColor = RATING_COLORS[area.worst]
          data.cell.styles.textColor = RATING_TONES[area.worst]
        } else data.cell.styles.textColor = MUTED
      }
      if (data.column.index === 3 && area.deficient) strong("deficient")
      if (data.column.index === 4 && area.degraded) strong("degraded")
      if (data.column.index === 5 && area.immediate) strong("deficient")
      if (data.column.index === 6) {
        data.cell.styles.fillColor = COVERAGE_COLORS[area.coverage].fill
        data.cell.styles.textColor = COVERAGE_COLORS[area.coverage].text
      }
    },
  })
  y = lastY() + 2.5

  // Rating definitions, so every reader applies the same meaning.
  autoTable(doc, {
    startY: y,
    margin: baseTable.margin,
    theme: "plain",
    body: RATINGS.map((r) => [r.label, r.definition]),
    styles: { font: "helvetica", fontSize: 7, textColor: MUTED, cellPadding: { top: 0.4, right: 2, bottom: 0.4, left: 0 }, overflow: "linebreak" },
    columnStyles: { 0: { cellWidth: 24, fontStyle: "bold", textColor: INK }, 1: { cellWidth: contentW - 24 } },
  })
  y = lastY() + 6

  // Findings register
  heading(
    "Findings Register",
    "Every Degraded or Deficient condition and every critical-equipment test defect, Deficient first. Deficient findings are non-conformities (ISM Code 9 and 10.2). SC = safety-critical.",
  )
  if (!register.length) {
    doc.setFont("helvetica", "italic")
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text("No Degraded or Deficient conditions and no critical-equipment test defects were recorded.", MARGIN, y + 2.5)
    y += 8
  } else {
    autoTable(doc, {
      ...baseTable,
      startY: y,
      head: [["Ref", "Item", "Condition", "Finding and action", "Priority / due", "RA", "Status"]],
      // A finding is read as one unit: never split a row across pages.
      rowPageBreak: "avoid",
      body: register.map((entry) => {
        const f = entry.finding
        const due = f.priority === "drydock" || f.status === "closed" ? (f.dueDate ? formatDate(f.dueDate) : "") : f.dueDate ? formatDate(f.dueDate) : "No due date"
        const text = [
          cleanReportText(entry.description) || "-",
          `Action: ${cleanReportText(f.action.trim()) || "-"}`,
          f.defectRef.trim() ? `Defect list: ${f.defectRef.trim()}` : "",
        ]
          .filter(Boolean)
          .join("\n")
        return [
          entry.ref,
          `${entry.item}\n${entry.areaTitle}${f.safetyCritical ? " · SC" : ""}`,
          ratingLabel(entry.rating),
          text,
          due ? `${priorityLabel(f)}\n${due}` : priorityLabel(f),
          raText(f),
          f.status === "closed" ? "Closed" : "Open",
        ]
      }),
      styles: { ...baseTable.styles, fontSize: 7.6, cellPadding: { top: 1.8, right: 1.8, bottom: 1.8, left: 1.8 } },
      headStyles: { ...baseTable.headStyles, cellPadding: { top: 2.4, right: 1.8, bottom: 2.4, left: 1.8 } },
      columnStyles: {
        0: { cellWidth: 14, fontStyle: "bold" },
        1: { cellWidth: 36 },
        2: { cellWidth: 19, halign: "center", fontStyle: "bold" },
        3: { cellWidth: contentW - 131 },
        4: { cellWidth: 26 },
        5: { cellWidth: 22 },
        6: { cellWidth: 14, halign: "center", fontStyle: "bold" },
      },
      didParseCell: (data) => {
        if (data.section === "body") {
          const entry = register[data.row.index]
          if (data.column.index === 2) {
            data.cell.styles.fillColor = RATING_COLORS[entry.rating]
            data.cell.styles.textColor = RATING_TONES[entry.rating]
          }
          if (data.column.index === 4 && entry.finding.priority === "immediate" && entry.finding.status !== "closed") {
            data.cell.styles.textColor = RATING_TONES.deficient
            data.cell.styles.fontStyle = "bold"
          }
          if (data.column.index === 5 && raPending(entry)) {
            data.cell.styles.textColor = RATING_TONES.degraded
            data.cell.styles.fontStyle = "bold"
          }
          if (data.column.index === 6 && entry.finding.status === "closed") data.cell.styles.textColor = RATING_TONES.satisfactory
        }
        prepareFormattedCell(data)
      },
    })
    y = lastY() + 5
  }

  // Inspection limitations: what could not be inspected, and why.
  const limits = limitations(report)
  if (limits.length) {
    subheading("Inspection limitations")
    autoTable(doc, {
      ...baseTable,
      startY: y,
      head: [["Area", "Item not inspected", "Reason"]],
      body: limits.map((l) => [l.areaTitle, l.item, cleanReportText(l.reason) || "Reason not stated"]),
      styles: { ...baseTable.styles, fontSize: 8 },
      columnStyles: { 0: { cellWidth: 44 }, 1: { cellWidth: 56 }, 2: { cellWidth: contentW - 100 } },
    })
    y = lastY() + 6
  }

  for (const section of CONDITION_SECTIONS) {
    ensureSpace(30)
    heading(section.title)
    const values = sectionValues(section)
    const area = areas.find((a) => a.id === section.id)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8)
    if (!area?.worst) {
      doc.setTextColor(...MUTED)
      doc.text(`Worst observed condition: not assessed · ${area?.assessed ?? 0} of ${area?.applicable ?? section.items.length} assessed`, MARGIN, y + 1.5)
    } else {
      doc.setFillColor(...RATING_TONES[area.worst])
      doc.rect(MARGIN, y - 1.2, 2.8, 2.8, "F")
      doc.setTextColor(...INK)
      doc.text(
        `Worst observed condition: ${ratingLabel(area.worst)} · ${area.assessed} of ${area.applicable} assessed · Coverage ${COVERAGE_LABELS[area.coverage].toLowerCase()}`,
        MARGIN + 4.5,
        y + 1.5,
      )
    }
    y += 5
    conditionTable(section.items, values, section.id)
  }

  const managementTitles = [
    ["critical", "Critical Equipment"], ["system", "System Implementation"],
    ["survey", "Class Survey Status"], ["budget", "Budget"], ["crew", "Crew Evaluation"],
  ] as const
  for (const [key, title] of managementTitles) {
    heading(title)
    const groups = MANAGEMENT_SECTION_GROUPS[key]
    // A single text field under its own section heading needs no extra subheading or label (e.g. Budget).
    const singleText = groups.length === 1 && groups[0].fields.length === 1 && groups[0].fields[0].type === "textarea"
    for (const group of groups) {
      const repeatsHeading = group.title?.trim().toLowerCase() === title.toLowerCase()
      const oneTextField = group.fields.length === 1 && group.fields[0].type === "textarea"
      if (group.title && !repeatsHeading && !singleText && !oneTextField) subheading(group.title)
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
        const critical = figures.critical
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        doc.setTextColor(...INK)
        doc.text(
          `Tests carried out: ${critical.tested} of ${critical.total} · Satisfactory ${critical.satisfactory} · Defects ${critical.defects}${critical.notRecorded ? ` · Result not recorded ${critical.notRecorded}` : ""}`,
          MARGIN,
          y + 1.5,
        )
        y += 5
        const testRows = CRITICAL_EQUIPMENT_ITEMS.map((item, index) => {
          const result = report.criticalResults?.[item.key]
          const tested = isCriticalTested(item, report.management) || Boolean(result?.result)
          const kind = result?.result || (tested ? "unrecorded" : "none")
          const defect = result?.result === "defect" ? cleanReportText(result.description?.trim() ?? "") : ""
          return {
            kind,
            cells: [
              findingRef("critical", index),
              defect ? `${item.label}\nDefect: ${defect}` : item.label,
              { satisfactory: "Satisfactory", defect: "Defect", unrecorded: "Result not recorded", none: "Not tested" }[kind] ?? "Not tested",
            ],
          }
        })
        autoTable(doc, {
          ...baseTable,
          startY: y,
          head: [["Ref", "Critical equipment test", "Result"]],
          body: testRows.map((row) => row.cells),
          styles: { ...baseTable.styles, fontSize: 8, cellPadding: { top: 1.8, right: 2.4, bottom: 1.8, left: 2.4 } },
          columnStyles: {
            0: { cellWidth: 14, textColor: MUTED },
            1: { cellWidth: contentW - 48 },
            2: { cellWidth: 34, halign: "center", fontStyle: "bold" },
          },
          didParseCell: (data) => {
            if (data.section !== "body" || data.column.index !== 2) return
            const kind = testRows[data.row.index].kind
            const tone = kind === "satisfactory" ? "satisfactory" : kind === "defect" ? "deficient" : kind === "unrecorded" ? "degraded" : "na"
            data.cell.styles.fillColor = RATING_COLORS[tone]
            data.cell.styles.textColor = RATING_TONES[tone]
          },
        })
        y = lastY() + 3
      }
      if (key === "crew") kvTable(group.fields, report.management)
      else longTextTable(group.fields, report.management, { hideLabels: singleText })
    }
  }

  ensureSpace(86)
  heading("Sign-off")
  autoTable(doc, {
    ...baseTable,
    startY: y,
    body: WORKLIST_ITEMS.map((w) => [report.worklist[w.key] ? "Yes" : "No", cleanReportText(w.label)]),
    columnStyles: { 0: { cellWidth: 14, halign: "center", fontStyle: "bold" }, 1: { cellWidth: contentW - 14, halign: "justify" } },
  })
  y = lastY() + 5
  ensureSpace(44)
  const signBlock = (x: number, title: string, name: string, signature: string, note: string) => {
    doc.setFont("helvetica", "bold")
    doc.setFontSize(7.5)
    doc.setTextColor(...MUTED)
    doc.text(title, x, y + 3)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10)
    doc.setTextColor(...INK)
    doc.text(name || "-", x, y + 9)
    if (signature) doc.addImage(signature, "PNG", x, y + 11, 56, 20)
    doc.setDrawColor(...LINE)
    doc.line(x, y + 32, x + 70, y + 32)
    doc.setFontSize(7)
    doc.setTextColor(...MUTED)
    doc.text(note, x, y + 35.5)
  }
  signBlock(MARGIN, "SUPERINTENDENT", superintendentName(report), superintendentSignature(report), "Signature")
  const approvedOn = report.signoff.fleetManagerDate ? formatDate(report.signoff.fleetManagerDate) : ""
  signBlock(
    MARGIN + contentW / 2,
    "REVIEWED AND APPROVED – FLEET MANAGER",
    report.signoff.fleetManagerName ?? "",
    report.signoff.fleetManagerSignature ?? "",
    approvedOn ? `Signature  ·  Approved ${approvedOn}` : "Signature and date",
  )
  y += 42

  const ownerPhotos = photos.filter((p) => p.includeInOwnerReport)
  if (ownerPhotos.length) {
    // Every photograph gets the same 3:2 landscape frame, two per page. Landscape photos fill the frame (trimmed
    // slightly if their shape differs); portrait or unusually shaped photos are shown whole over a faded copy of
    // themselves, so nothing is cut off and the frame is never left half empty.
    const frameW = 162
    const frameH = 108
    const frameX = MARGIN + (contentW - frameW) / 2
    for (let start = 0; start < ownerPhotos.length; start += 2) {
      const end = Math.min(start + 2, ownerPhotos.length)
      doc.addPage()
      y = TOP
      heading(`Photographs (${start + 1}–${end} of ${ownerPhotos.length})`)
      for (let i = start; i < end; i++) {
        const photo = ownerPhotos[i]
        const frameY = y + 1 + (i - start) * (frameH + 15)
        const size = await loadImageSize(photo.dataUrl)
        drawPhotoInFrame(doc, photo, size, frameX, frameY, frameW, frameH)
        doc.setDrawColor(...NAVY)
        doc.setLineWidth(0.4)
        doc.rect(frameX, frameY, frameW, frameH, "S")
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8.5)
        doc.setTextColor(...NAVY)
        doc.text(`${i + 1}. ${photo.category}`, frameX, frameY + frameH + 4.6, { maxWidth: frameW })
        if (photo.caption) {
          doc.setFont("helvetica", "normal")
          doc.setFontSize(7.5)
          doc.setTextColor(...MUTED)
          doc.text(doc.splitTextToSize(photo.caption, frameW).slice(0, 2), frameX, frameY + frameH + 8.6)
        }
      }
    }
  }

  drawChrome(doc, report, pageW, pageH, draft)
  if (draft) drawDraftWatermark(doc, pageW, pageH)

  const vesselSlug = (report.details.vessel || "vessel").replace(/[^A-Za-z0-9]+/g, "-")
  const reportSlug = (report.details.reportNo || report.id.slice(0, 6)).replace(/[^A-Za-z0-9]+/g, "-")
  doc.save(`SIR_${vesselSlug}_${reportSlug}${draft ? "_DRAFT" : ""}.pdf`)
}

/** Draws a photo inside a landscape frame: fills it when the shapes are close, otherwise whole over a faded fill. */
function drawPhotoInFrame(
  doc: JsPDF,
  photo: Photo,
  size: { w: number; h: number },
  x: number,
  y: number,
  frameW: number,
  frameH: number,
) {
  const format = /^data:image\/png/i.test(photo.dataUrl) ? "PNG" : "JPEG"
  const alias = `photo-${photo.id}`
  const ratio = size.w / size.h
  const frameRatio = frameW / frameH
  const cover = Math.max(frameW / size.w, frameH / size.h)
  const contain = Math.min(frameW / size.w, frameH / size.h)
  const fill = ratio >= 1 && Math.abs(ratio - frameRatio) / frameRatio <= 0.25
  const GState = (doc as unknown as { GState: new (options: { opacity: number }) => unknown }).GState

  doc.saveGraphicsState()
  doc.rect(x, y, frameW, frameH, null as unknown as string)
  doc.clip()
  doc.discardPath()
  doc.setFillColor(255, 255, 255)
  doc.rect(x, y, frameW, frameH, "F")
  const coverW = size.w * cover
  const coverH = size.h * cover
  if (fill) {
    doc.addImage(photo.dataUrl, format, x + (frameW - coverW) / 2, y + (frameH - coverH) / 2, coverW, coverH, alias, "FAST")
  } else {
    doc.saveGraphicsState()
    doc.setGState(new GState({ opacity: 0.22 }))
    doc.addImage(photo.dataUrl, format, x + (frameW - coverW) / 2, y + (frameH - coverH) / 2, coverW, coverH, alias, "FAST")
    doc.restoreGraphicsState()
    const w = size.w * contain
    const h = size.h * contain
    doc.addImage(photo.dataUrl, format, x + (frameW - w) / 2, y + (frameH - h) / 2, w, h, alias, "FAST")
  }
  doc.restoreGraphicsState()
}

/** Large diagonal "DRAFT" across every page, faint enough to keep the content readable. */
function drawDraftWatermark(doc: JsPDF, pageW: number, pageH: number) {
  const GState = (doc as unknown as { GState: new (options: { opacity: number }) => unknown }).GState
  const angle = 45
  const radians = (angle * Math.PI) / 180
  const total = doc.getNumberOfPages()
  for (let i = 1; i <= total; i++) {
    doc.setPage(i)
    doc.saveGraphicsState()
    doc.setGState(new GState({ opacity: 0.1 }))
    doc.setFont("helvetica", "bold")
    doc.setFontSize(120)
    doc.setTextColor(190, 30, 30)
    const width = doc.getTextWidth("DRAFT")
    // Start point chosen so the rotated word is centred on the page.
    const x = pageW / 2 - (width / 2) * Math.cos(radians)
    const y = pageH / 2 + (width / 2) * Math.sin(radians) + 12
    doc.text("DRAFT", x, y, { angle })
    doc.restoreGraphicsState()
  }
}

function drawChrome(doc: JsPDF, report: Report, pageW: number, pageH: number, draft = false) {
  const total = doc.getNumberOfPages()
  for (let i = 1; i <= total; i++) {
    doc.setPage(i)
    doc.setFillColor(...NAVY)
    doc.rect(0, 0, pageW, 14, "F")
    doc.setFillColor(...GREEN)
    doc.rect(0, 14, pageW, 0.8, "F")
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    doc.setTextColor(255, 255, 255)
    doc.text(`SUPERINTENDENT'S DETAILED INSPECTION REPORT${draft ? "  –  DRAFT" : ""}`, MARGIN, 8.8)
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
