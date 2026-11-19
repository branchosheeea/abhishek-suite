// Findings export for vessel review (PDF). The layout mirrors the Findings & investigation screen: a summary, an
// index like the findings list, and one card per finding like the detail panel (title, detail, evidence, source
// records, calculation, qualifications, possible causes, recommended check). Each card ends with a fillable
// Investigation status dropdown and a Vessel remarks field, named after the finding id so answers can be read back.
// Every page carries the diagnostic banner. Built in memory with an embedded open-licence font (DejaVu); nothing
// is downloaded or written to disk.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import fontkit from "@pdf-lib/fontkit"
import { type Color, PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib"
import { RULE_BY_ID } from "../engine/rules/registry"
import { EVIDENCE_LABEL, type Finding, RULE_GROUP_LABEL } from "../engine/types"
import { FINDING_STATUSES } from "../server/diagnostics"
import { SCOPE_LABEL } from "./findings-filter"
import { FILL_IN_STEPS, type FindingsExportOptions, vesselLine } from "./findings-xlsx"
import { notesFor, REPORT_BANNER, type ReportInput, statusOf } from "./report"

export const statusField = (findingId: string) => `status__${findingId}`
export const remarksField = (findingId: string) => `remarks__${findingId}`

// ── look (NeraVeda light theme, app/globals.css) ─────────────────────────────

function hex(h: string): Color {
  return rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255)
}
const C = {
  navy: hex("#10233d"), primary: hex("#1557a0"), fg: hex("#0f1b2a"), muted: hex("#5f6b7a"), border: hex("#d5dce5"), line: hex("#e3e8ee"),
  mutedBg: hex("#f3f6f9"), card: hex("#ffffff"), infoBg: hex("#e6effc"), critical: hex("#8f2414"), criticalBg: hex("#fbe9e6"),
  warning: hex("#6e4500"), warningBg: hex("#fff1d6"), success: hex("#1e7a45"), successBg: hex("#e3f4ea"), bandText: hex("#c9d6e8"), white: hex("#ffffff"),
}
const TONE = {
  error: { fg: C.critical, bg: C.criticalBg, icon: "▲" },
  warning: { fg: C.warning, bg: C.warningBg, icon: "●" },
  info: { fg: C.primary, bg: C.infoBg, icon: "i" },
} as const

const PAGE: [number, number] = [595.28, 841.89] // A4
const M = 36
const CW = PAGE[0] - 2 * M
const TOP = PAGE[1] - 80
const BOTTOM = 46
const PAD = 11
const IX = M + PAD
const IW = CW - 2 * PAD

// ── fonts ────────────────────────────────────────────────────────────────────

export function fontDirectory(root = process.cwd()): string {
  return join(root, "node_modules", "dejavu-fonts-ttf", "ttf")
}

type FontFiles = { sans: Uint8Array; bold: Uint8Array; mono: Uint8Array }
let files: FontFiles | null = null
function fontFiles(): FontFiles {
  if (!files) {
    const dir = fontDirectory()
    const read = (name: string) => new Uint8Array(readFileSync(join(dir, name)))
    files = { sans: read("DejaVuSans.ttf"), bold: read("DejaVuSans-Bold.ttf"), mono: read("DejaVuSansMono.ttf") }
  }
  return files
}

const FALLBACK: Record<string, string> = { " ": " ", " ": " ", " ": " ", "‑": "-" }
type Coverage = { hasGlyphForCodePoint(cp: number): boolean }
const coverage = new Map<Uint8Array, Coverage>()

/** Text the font can show: control characters become spaces, missing glyphs a safe substitute. */
function cleaner(bytes: Uint8Array): (text: string) => string {
  let cov = coverage.get(bytes)
  if (!cov) {
    cov = (fontkit as unknown as { create(b: Uint8Array): Coverage }).create(bytes)
    coverage.set(bytes, cov)
  }
  const font = cov
  return (text) => {
    let out = ""
    for (const ch of text.replace(/\r\n?/g, "\n").replace(/\t/g, " ")) {
      const cp = ch.codePointAt(0)!
      if (ch === "\n") out += ch
      else if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) out += " "
      else if (font.hasGlyphForCodePoint(cp)) out += ch
      else out += FALLBACK[ch] ?? "?"
    }
    return out
  }
}

type Fonts = { sans: PDFFont; bold: PDFFont; mono: PDFFont; clean: (t: string) => string; cleanMono: (t: string) => string }

// ── text ─────────────────────────────────────────────────────────────────────

const widths = new WeakMap<PDFFont, Map<string, number>>()

/**
 * Width of text from cached per-character advances. pdf-lib's widthOfTextAtSize shapes the whole string on every
 * call (≈0.7 ms), which made wrapping long exports slow; PDF text is drawn without kerning, so the sum of advances
 * is the drawn width.
 */
function measure(font: PDFFont, text: string, size: number): number {
  let cache = widths.get(font)
  if (!cache) widths.set(font, (cache = new Map()))
  let total = 0
  for (const ch of text) {
    let w = cache.get(ch)
    if (w === undefined) cache.set(ch, (w = font.widthOfTextAtSize(ch, 1000)))
    total += w
  }
  return (total * size) / 1000
}

export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = []
  for (const para of text.split("\n")) {
    let line = ""
    for (const word of para.split(" ")) {
      const candidate = line ? `${line} ${word}` : word
      if (measure(font,candidate, size) <= width) {
        line = candidate
        continue
      }
      if (line) out.push(line)
      let rest = word
      while (rest && measure(font,rest, size) > width) {
        let k = rest.length - 1
        while (k > 1 && measure(font,rest.slice(0, k), size) > width) k -= 1
        out.push(rest.slice(0, k))
        rest = rest.slice(k)
      }
      line = rest
    }
    out.push(line)
  }
  return out
}

function fit(text: string, font: PDFFont, size: number, width: number): string {
  if (measure(font,text, size) <= width) return text
  let t = text
  while (t.length > 1 && measure(font,`${t}…`, size) > width) t = t.slice(0, -1)
  return `${t.trimEnd()}…`
}

// ── layout: blocks placed on pages, then drawn ───────────────────────────────

type Deco = (page: PDFPage, top: number, h: number) => void
type Block = {
  h: number
  /** Keep on the same page as the next block. */
  keep?: boolean
  newPage?: boolean
  /** Inside a finding card (after its header): the label shown in a strip when the card continues on a new page. */
  cont?: string
  deco?: readonly Deco[]
  draw?: (page: PDFPage, top: number) => void
  placed?: (pageIndex: number, top: number) => void
}

const cardSides: Deco = (page, top, h) => {
  page.drawRectangle({ x: M, y: top - h, width: CW, height: h, color: C.card })
  page.drawLine({ start: { x: M, y: top }, end: { x: M, y: top - h }, thickness: 0.8, color: C.border })
  page.drawLine({ start: { x: M + CW, y: top }, end: { x: M + CW, y: top - h }, thickness: 0.8, color: C.border })
}
const boxSides: Deco = (page, top, h) => {
  page.drawLine({ start: { x: IX, y: top }, end: { x: IX, y: top - h }, thickness: 0.8, color: C.line })
  page.drawLine({ start: { x: IX + IW, y: top }, end: { x: IX + IW, y: top - h }, thickness: 0.8, color: C.line })
}
// Tinted strips overlap the next strip slightly, so stacked lines show no hairline seams in viewers.
const tint = (color: Color, x: number, width: number): Deco => (page, top, h) => page.drawRectangle({ x, y: top - h - 0.75, width, height: h + 0.75, color })

function roundRect(page: PDFPage, x: number, top: number, w: number, h: number, r: number, opts: { color?: Color; borderColor?: Color; borderWidth?: number }) {
  const path = `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h} H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`
  page.drawSvgPath(path, { x, y: top, color: opts.color, borderColor: opts.borderColor, borderWidth: opts.borderWidth })
}

export async function buildFindingsPdf(input: ReportInput, findings: readonly Finding[], options: FindingsExportOptions): Promise<Uint8Array> {
  const { session, run, result } = input
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const ff = fontFiles()
  const embed = (bytes: Uint8Array) => doc.embedFont(bytes, { subset: true, features: { liga: false } })
  const fonts: Fonts = { sans: await embed(ff.sans), bold: await embed(ff.bold), mono: await embed(ff.mono), clean: cleaner(ff.sans), cleanMono: cleaner(ff.mono) }
  const { sans, bold, mono } = fonts
  const form = doc.getForm()

  doc.setTitle(`Findings for vessel review — ${session.vessel}`)
  doc.setSubject(REPORT_BANNER)
  doc.setAuthor(input.generatedBy)
  doc.setCreator("NeraVeda Emissions Validation")
  doc.setProducer("NeraVeda")
  doc.setKeywords(["NeraVeda", "diagnostic", "findings", session.vessel, ...(session.imo ? [session.imo] : [])])

  const blocks: Block[] = []
  const add = (...b: Block[]) => blocks.push(...b)

  /** Lines of wrapped text, one block each (so long texts break across pages). */
  function text(t: string, o: { font?: PDFFont; size?: number; color?: Color; x?: number; width?: number; deco?: readonly Deco[]; lead?: number; mono?: boolean }): Block[] {
    const font = o.font ?? (o.mono ? mono : sans)
    const size = o.size ?? 9
    const lead = o.lead ?? size * 1.4
    const x = o.x ?? IX
    const width = o.width ?? IW
    const clean = o.mono ? fonts.cleanMono : fonts.clean
    return wrapText(clean(t), font, size, width).map((ln) => ({
      h: lead,
      deco: o.deco,
      draw: (page, top) => page.drawText(ln, { x, y: top - lead + (lead - size) / 2 + size * 0.22, size, font, color: o.color ?? C.fg }),
    }))
  }
  function bullets(items: readonly string[], o: { size?: number; color?: Color; x?: number; width?: number; deco?: readonly Deco[]; marker?: (i: number) => string }): Block[] {
    const size = o.size ?? 9
    const x = o.x ?? IX
    const width = o.width ?? IW
    return items.flatMap((item, i) => {
      const lines = text(item, { size, color: o.color, x: x + 12, width: width - 12, deco: o.deco })
      if (lines.length) {
        const first = lines[0]
        const marker = o.marker ? o.marker(i) : "•"
        lines[0] = { ...first, draw: (page, top) => { first.draw?.(page, top); page.drawText(marker, { x, y: top - first.h + (first.h - size) / 2 + size * 0.22, size, font: sans, color: o.color ?? C.fg }) } }
      }
      return lines
    })
  }
  const space = (h: number, deco?: readonly Deco[]): Block => ({ h, deco })
  const heading = (label: string, deco: readonly Deco[], x = IX): Block[] => [space(5, deco), { h: 13, deco, keep: true, draw: (page, top) => page.drawText(label, { x, y: top - 10, size: 7.5, font: bold, color: C.muted }) }]

  function pill(page: PDFPage, x: number, top: number, severity: Finding["severity"]): number {
    const tone = TONE[severity]
    const label = `${tone.icon} ${severity}`
    const w = measure(bold,label, 7.5) + 12
    roundRect(page, x, top, w, 14, 3.5, { color: tone.bg })
    page.drawText(label, { x: x + 6, y: top - 10.2, size: 7.5, font: bold, color: tone.fg })
    return w
  }

  // ── summary page ──
  const count = (sev: string) => findings.filter((f) => f.severity === sev).length
  const statusCount = (s: string) => findings.filter((f) => statusOf(input, f.id) === s).length
  add({ h: 28, draw: (page, top) => page.drawText("Findings for vessel review", { x: M, y: top - 20, size: 18, font: bold, color: C.fg }) })
  add(...text(vesselLine(input), { x: M, width: CW, size: 10.5, color: C.muted }))
  add(space(10))
  const kv = (label: string, value: string): Block[] => {
    const lines = text(value, { x: M + 118, width: CW - 118, size: 9 })
    if (lines.length) {
      const first = lines[0]
      lines[0] = { ...first, draw: (page, top) => { page.drawText(label, { x: M, y: top - first.h + 3.4, size: 8, font: bold, color: C.muted }); first.draw?.(page, top) } }
    }
    return [...lines, space(3)]
  }
  add(
    ...kv("Session", session.title),
    ...kv("Validation run", `${run.startedAt.replace("T", " ").slice(0, 16)} UTC by ${run.actor} · rule set ${result.ruleSetVersion} · engine ${result.engineVersion}`),
    ...kv("Source files", input.artifacts.map((a) => `${a.kind}  ${a.filename}  (SHA-256 ${a._id.slice(0, 16)}…)`).join("\n") || "none"),
    ...kv("Exported", `${SCOPE_LABEL[options.scope]}: ${findings.length} finding(s)`),
    ...kv("Generated", `${input.generatedAt.replace("T", " ").slice(0, 16)} UTC by ${input.generatedBy}`),
  )
  add(space(10))
  const tiles: { label: string; value: number; tone: { fg: Color; bg: Color } }[] = [
    { label: "Errors", value: count("error"), tone: { fg: C.critical, bg: C.criticalBg } },
    { label: "Warnings", value: count("warning"), tone: { fg: C.warning, bg: C.warningBg } },
    ...(count("info") ? [{ label: "Information", value: count("info"), tone: { fg: C.primary, bg: C.infoBg } }] : []),
    { label: "Awaiting vessel clarification", value: statusCount("Awaiting Vessel Clarification"), tone: { fg: C.fg, bg: C.mutedBg } },
  ]
  add({
    h: 52,
    draw: (page, top) => {
      const gap = 8
      const w = (CW - gap * (tiles.length - 1)) / tiles.length
      tiles.forEach((t, i) => {
        const x = M + i * (w + gap)
        roundRect(page, x, top, w, 46, 6, { color: t.tone.bg })
        page.drawText(t.label, { x: x + 10, y: top - 15, size: 8, font: bold, color: t.tone.fg })
        page.drawText(String(t.value), { x: x + 10, y: top - 37, size: 18, font: bold, color: t.tone.fg })
      })
    },
  })
  add(space(10))
  const howDeco = [tint(C.infoBg, M, CW)]
  add(space(8, howDeco), { h: 16, deco: howDeco, keep: true, draw: (page, top) => page.drawText("How to use this file", { x: M + 12, y: top - 12, size: 10, font: bold, color: C.primary }) })
  add(...bullets([...FILL_IN_STEPS, "Fields can be filled in Adobe Acrobat Reader, Microsoft Edge or Google Chrome; save the PDF after filling it."], { x: M + 12, width: CW - 24, size: 8.8, deco: howDeco, marker: (i) => `${i + 1}.` }))
  add(space(8, howDeco), space(14))

  // ── index (like the findings list) ──
  const pageOfCard = new Map<string, { page: number; top: number }>()
  const pages: PDFPage[] = []
  add({ h: 22, keep: true, draw: (page, top) => page.drawText(`Findings in this file (${findings.length})`, { x: M, y: top - 15, size: 12, font: bold, color: C.fg }) })
  const COL = { no: M + 6, sev: M + 30, rule: M + 92, title: M + 128, status: M + CW - 158, page: M + CW - 30 }
  add({
    h: 18, keep: true,
    draw: (page, top) => {
      page.drawRectangle({ x: M, y: top - 18, width: CW, height: 18, color: C.mutedBg })
      for (const [label, x] of [["No.", COL.no], ["Severity", COL.sev], ["Rule", COL.rule], ["Finding", COL.title], ["Status", COL.status], ["Page", COL.page]] as const) {
        page.drawText(label, { x, y: top - 12.5, size: 7.5, font: bold, color: C.muted })
      }
    },
  })
  if (!findings.length) add(...text("No finding matches this export.", { x: M + 6, width: CW - 12, color: C.muted }))
  findings.forEach((f, i) => {
    const titleLines = wrapText(fonts.clean(f.title), sans, 8.5, COL.status - COL.title - 10).slice(0, 2)
    const all = wrapText(fonts.clean(f.title), sans, 8.5, COL.status - COL.title - 10)
    if (all.length > 2) titleLines[1] = fit(`${titleLines[1]} ${all.slice(2).join(" ")}`, sans, 8.5, COL.status - COL.title - 10)
    const h = titleLines.length * 11 + 8
    add({
      h,
      draw: (page, top) => {
        page.drawText(String(i + 1), { x: COL.no, y: top - 13, size: 8.5, font: bold, color: C.fg })
        pill(page, COL.sev, top - 3, f.severity)
        page.drawText(f.ruleId, { x: COL.rule, y: top - 13, size: 8.5, font: mono, color: C.muted })
        titleLines.forEach((ln, k) => page.drawText(ln, { x: COL.title, y: top - 13 - k * 11, size: 8.5, font: sans, color: C.fg }))
        page.drawText(fit(statusOf(input, f.id), sans, 7.5, COL.page - COL.status - 6), { x: COL.status, y: top - 13, size: 7.5, font: sans, color: C.muted })
        const target = pageOfCard.get(f.id)
        if (target) {
          page.drawText(String(target.page + 1), { x: COL.page, y: top - 13, size: 8.5, font: bold, color: C.primary })
          // whole row links to the finding's card
          const link = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [M, top - h, M + CW, top], Border: [0, 0, 0], Dest: [pages[target.page].ref, "XYZ", null, target.top + 4, null] }))
          page.node.addAnnot(link)
        }
        page.drawLine({ start: { x: M, y: top - h }, end: { x: M + CW, y: top - h }, thickness: 0.5, color: C.line })
      },
    })
  })

  // ── one card per finding (like the detail panel) ──
  const card = [cardSides]
  const inBox = [cardSides, boxSides]
  findings.forEach((f, i) => {
    const def = RULE_BY_ID.get(f.ruleId)
    const status = statusOf(input, f.id)
    const first = blocks.length
    add({
      h: 30, keep: true, newPage: i === 0,
      placed: (page, top) => pageOfCard.set(f.id, { page, top }),
      draw: (page, top) => {
        page.drawRectangle({ x: M, y: top - 30, width: CW, height: 30, color: C.mutedBg, borderColor: C.border, borderWidth: 0.8 })
        const w = pill(page, IX, top - 8, f.severity)
        const right = `No. ${i + 1}`
        const rw = measure(bold,right, 8.5)
        page.drawText(fit(fonts.clean(`${f.ruleId} · ${def?.name ?? ""}`), bold, 10, IW - w - rw - 20), { x: IX + w + 8, y: top - 19, size: 10, font: bold, color: C.fg })
        page.drawText(right, { x: IX + IW - rw, y: top - 19, size: 8.5, font: bold, color: C.muted })
      },
    })
    add({ ...space(7, card), keep: true })
    add(...text(f.title, { font: bold, size: 11.5, deco: card }).map((b, k) => (k === 0 ? { ...b, keep: true } : b)))
    add(space(3, card), ...text(f.detail, { size: 9.5, deco: card }))
    const reference = def?.specReference ? `reference: ${def.specReference}` : "no DNV specification reference (independent check)"
    add(space(2, card), ...text(`Evidence: ${EVIDENCE_LABEL[f.evidence]}${f.schemaVerified ? "" : " · computed through the superseded provisional schema"} · rule ${f.ruleId} v${f.ruleVersion} · ${RULE_GROUP_LABEL[f.group]} · ${reference}`, { size: 7.5, color: C.muted, deco: card }))

    if (f.refs.length) {
      add(...heading("SOURCE RECORDS", card))
      const byKind = new Map<string, number[]>()
      for (const r of f.refs) byKind.set(r.kind, [...new Set([...(byKind.get(r.kind) ?? []), r.line])])
      const chips = [...byKind.entries()].map(([kind, lines]) => `${kind} ${kind === "OVDLA" ? "row" : "line"}${lines.length > 1 ? "s" : ""} ${lines.slice(0, 12).join(", ")}${lines.length > 12 ? ` +${lines.length - 12}` : ""}`)
      let row: string[] = []
      let used = 0
      const flush = () => {
        const items = row
        if (!items.length) return
        add({
          h: 20, deco: card,
          draw: (page, top) => {
            let x = IX
            for (const chip of items) {
              const cw = measure(sans,chip, 8.5) + 16
              roundRect(page, x, top - 2, cw, 16, 4, { borderColor: C.border, borderWidth: 0.8, color: C.card })
              page.drawText(chip, { x: x + 8, y: top - 13.2, size: 8.5, font: sans, color: C.fg })
              x += cw + 6
            }
          },
        })
        row = []
        used = 0
      }
      for (const chip of chips.map((c) => fit(fonts.clean(c), sans, 8.5, IW - 16))) {
        const cw = measure(sans,chip, 8.5) + 22
        if (used + cw > IW) flush()
        row.push(chip)
        used += cw
      }
      flush()
      if (f.columns?.length) add(...text(`Columns: ${f.columns.join(", ")}`, { size: 7.5, color: C.muted, deco: card }))
    }

    if (f.calculation) {
      const calc = f.calculation
      const bx = IX + 9
      const bw = IW - 18
      add(space(7, card))
      add({ h: 6, deco: inBox, keep: true, draw: (page, top) => page.drawLine({ start: { x: IX, y: top }, end: { x: IX + IW, y: top }, thickness: 0.8, color: C.line }) })
      add(...heading("CALCULATION", inBox, bx))
      add(...text(calc.formula, { size: 8.3, x: bx, width: bw, deco: inBox }))
      add(space(3, inBox))
      const labelW = bw * 0.42
      const valueRight = bx + bw * 0.66
      const refX = bx + bw * 0.69
      const refW = bx + bw - refX
      for (const x of calc.inputs) {
        const label = wrapText(fonts.clean(x.label), sans, 8.3, labelW)
        const ref = wrapText(fonts.clean([x.ref ? `${x.ref.kind} ${x.ref.kind === "OVDLA" ? "row" : "line"} ${x.ref.line}` : "", x.column ?? ""].filter(Boolean).join(" · ")), sans, 7.5, refW)
        const value = fit(fonts.cleanMono(x.value), mono, 8.3, valueRight - (bx + labelW) - 6)
        const lines = Math.max(label.length, ref.length, 1)
        const h = lines * 11 + 4
        add({
          h, deco: inBox,
          draw: (page, top) => {
            label.forEach((ln, k) => page.drawText(ln, { x: bx, y: top - 10 - k * 11, size: 8.3, font: sans, color: C.fg }))
            page.drawText(value, { x: valueRight - measure(mono,value, 8.3), y: top - 10, size: 8.3, font: mono, color: C.fg })
            ref.forEach((ln, k) => page.drawText(ln, { x: refX, y: top - 10 - k * 11, size: 7.5, font: sans, color: C.primary }))
            page.drawLine({ start: { x: bx, y: top - h + 1 }, end: { x: bx + bw, y: top - h + 1 }, thickness: 0.4, color: C.line })
          },
        })
      }
      add(space(4, inBox))
      for (const s of calc.steps) add(...text(s, { mono: true, size: 8.2, x: bx, width: bw, deco: inBox }))
      add(...text(`Result: ${calc.result}`, { font: bold, size: 10, x: bx, width: bw, deco: inBox }))
      if (calc.qualifications.length) {
        const q = [...inBox, tint(C.infoBg, bx, bw)]
        add(space(4, inBox), space(5, q), { h: 13, deco: q, keep: true, draw: (page, top) => page.drawText("Qualifications", { x: bx + 8, y: top - 10, size: 8.3, font: bold, color: C.fg }) })
        add(...bullets(calc.qualifications, { size: 8, x: bx + 8, width: bw - 16, deco: q }))
        add(space(5, q))
      }
      add({ h: 6, deco: inBox, draw: (page, top) => page.drawLine({ start: { x: IX, y: top - 6 }, end: { x: IX + IW, y: top - 6 }, thickness: 0.8, color: C.line }) })
    }

    if (f.possibleCauses?.length) {
      add(...heading("POSSIBLE CAUSES (HYPOTHESES — NOT VERIFIED)", card))
      add(...bullets(f.possibleCauses, { size: 9, deco: card }))
    }
    add(...heading("RECOMMENDED CHECK", card))
    add(...text(f.recommendation, { size: 9.5, deco: card }))

    // investigation: fillable status dropdown and vessel remarks
    add(space(8, card))
    add({ h: 8, deco: card, keep: true, draw: (page, top) => page.drawLine({ start: { x: IX, y: top - 4 }, end: { x: IX + IW, y: top - 4 }, thickness: 0.8, color: C.line }) })
    add({
      h: 26, deco: card, keep: true,
      draw: (page, top) => {
        page.drawText("Investigation status", { x: IX, y: top - 15, size: 9.5, font: bold, color: C.fg })
        // The box and its ▼ are drawn on the page; the dropdown widget lies on top with a transparent background,
        // so every viewer shows it as a list to choose from even before it is clicked.
        const fx = IX + 118
        const fy = top - 21
        const fw = 210
        const fh = 18
        page.drawRectangle({ x: fx, y: fy, width: fw, height: fh, color: C.card, borderColor: C.border, borderWidth: 1 })
        page.drawRectangle({ x: fx + fw - 18, y: fy, width: 18, height: fh, color: C.mutedBg, borderColor: C.border, borderWidth: 1 })
        page.drawText("▼", { x: fx + fw - 13.2, y: fy + 5.5, size: 7, font: sans, color: C.muted })
        const dd = form.createDropdown(statusField(f.id))
        dd.addOptions([...FINDING_STATUSES])
        dd.select(status)
        dd.addToPage(page, { x: fx, y: fy, width: fw, height: fh, borderWidth: 0, borderColor: undefined, backgroundColor: undefined, textColor: C.fg })
        dd.setFontSize(9)
        page.drawText("Choose from the list", { x: fx + fw + 8, y: top - 15, size: 7.5, font: sans, color: C.muted })
      },
    })
    add({ h: 16, deco: card, keep: true, draw: (page, top) => page.drawText("Vessel remarks / correction made", { x: IX, y: top - 12, size: 9.5, font: bold, color: C.fg }) })
    add({
      h: 58, deco: card,
      draw: (page, top) => {
        const tf = form.createTextField(remarksField(f.id))
        tf.enableMultiline()
        tf.addToPage(page, { x: IX, y: top - 54, width: IW, height: 52, borderColor: C.border, borderWidth: 1, backgroundColor: hex("#fbfcfe"), textColor: C.fg })
        tf.setFontSize(9)
      },
    })
    if (options.includeNotes) {
      const notes = notesFor(input, f.id)
      if (notes.length) {
        add(...heading("OFFICE NOTES", card))
        add(...bullets(notes.map((n) => `${n.createdAt.replace("T", " ").slice(0, 16)} · ${n.createdBy}: ${n.text}`), { size: 8, color: C.muted, deco: card }))
      }
    }
    add({ h: PAD, deco: card, draw: (page, top) => page.drawLine({ start: { x: M, y: top - PAD }, end: { x: M + CW, y: top - PAD }, thickness: 0.8, color: C.border }) })
    const cont = fonts.clean(`No. ${i + 1} · ${f.ruleId} · ${f.title} (continued)`)
    for (let k = first + 1; k < blocks.length; k += 1) blocks[k] = { ...blocks[k], cont }
    add(space(14))
  })

  /** Strip at the top of a page where a finding card continues, so the fields stay tied to their finding. */
  const continuation = (label: string): Block => ({
    h: 20,
    draw: (page, top) => {
      page.drawRectangle({ x: M, y: top - 20, width: CW, height: 20, color: C.mutedBg, borderColor: C.border, borderWidth: 0.8 })
      page.drawText(fit(label, sans, 8, IW), { x: IX, y: top - 13.5, size: 8, font: sans, color: C.muted })
    },
  })

  // ── place ──
  type Placed = { block: Block; page: number; top: number }
  const placed: Placed[] = []
  let pageIndex = 0
  let y = TOP
  const usable = TOP - BOTTOM
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]
    let broke = false
    if (b.newPage && y !== TOP) {
      pageIndex += 1
      y = TOP
      broke = true
    }
    let need = b.h
    for (let j = i; blocks[j].keep && j + 1 < blocks.length && need <= usable; j += 1) need += blocks[j + 1].h
    if (y - Math.min(need, usable) < BOTTOM && y !== TOP) {
      pageIndex += 1
      y = TOP
      broke = true
    }
    if (broke && b.cont) {
      const strip = continuation(b.cont)
      placed.push({ block: strip, page: pageIndex, top: y })
      y -= strip.h
    }
    placed.push({ block: b, page: pageIndex, top: y })
    b.placed?.(pageIndex, y)
    y -= b.h
  }
  for (let p = 0; p <= pageIndex; p += 1) pages.push(doc.addPage(PAGE))

  // ── draw ──
  for (const { block, page, top } of placed) {
    for (const d of block.deco ?? []) d(pages[page], top, block.h)
    block.draw?.(pages[page], top)
  }
  const period = session.config.period ? `${session.config.period.from} to ${session.config.period.to}` : "period not set"
  pages.forEach((page, i) => {
    const [w, h] = PAGE
    page.drawRectangle({ x: 0, y: h - 48, width: w, height: 48, color: C.navy })
    roundRect(page, M, h - 10, 28, 28, 6, { color: C.primary })
    page.drawText("N", { x: M + 9, y: h - 30, size: 14, font: bold, color: C.white })
    page.drawText("NeraVeda", { x: M + 38, y: h - 23, size: 12, font: bold, color: C.white })
    page.drawText("Emissions Validation · Findings for vessel review", { x: M + 38, y: h - 35, size: 7.5, font: sans, color: C.bandText })
    const vessel = fit(fonts.clean(session.vessel), bold, 11, 220)
    page.drawText(vessel, { x: w - M - measure(bold,vessel, 11), y: h - 23, size: 11, font: bold, color: C.white })
    const sub = fonts.clean(`IMO ${session.imo ?? "not set"} · ${period}`)
    page.drawText(sub, { x: w - M - measure(sans,sub, 7.5), y: h - 35, size: 7.5, font: sans, color: C.bandText })
    page.drawRectangle({ x: 0, y: h - 66, width: w, height: 18, color: C.criticalBg })
    page.drawText(REPORT_BANNER, { x: M, y: h - 60, size: 8, font: bold, color: C.critical })
    page.drawLine({ start: { x: M, y: 32 }, end: { x: w - M, y: 32 }, thickness: 0.5, color: C.line })
    const foot = fit(fonts.clean(`Run ${run.startedAt.replace("T", " ").slice(0, 16)} UTC (${run._id.slice(0, 8)}) · ${session.title} · generated ${input.generatedAt.replace("T", " ").slice(0, 16)} UTC by ${input.generatedBy}`), sans, 7, CW - 70)
    page.drawText(foot, { x: M, y: 20, size: 7, font: sans, color: C.muted })
    const label = `Page ${i + 1} of ${pages.length}`
    page.drawText(label, { x: w - M - measure(sans,label, 7), y: 20, size: 7, font: sans, color: C.muted })
  })

  return doc.save({ updateFieldAppearances: true })
}
