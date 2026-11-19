// Minimal XLSX writer (Node zlib only) for DIAGNOSTIC reports. It never writes formulas: text is always an inline
// string, and text that a spreadsheet could treat as a formula (= + - @ TAB CR at the start) also gets Excel's
// quotePrefix style, so it stays text even if a user edits the cell. The value itself is not altered, which keeps
// every quoted source value traceable.

import { crc32, deflateRawSync } from "node:zlib"

/** Extra cell looks (wrapped text, header band, severity colours). Formula protection applies to them too. */
export type CellStyle = "wrap" | "header" | "error" | "warning" | "info" | "muted"
export type XlsxCell = string | number | null | { date: string } | { bold: string } | { text: string | number; style: CellStyle }
export type XlsxValidation = Readonly<{ column: number; fromRow: number; toRow: number; list: readonly string[]; title?: string; prompt?: string }>
export type XlsxSheet = {
  name: string
  rows: XlsxCell[][]
  widths?: number[]
  /** Rows (from the top) kept visible while scrolling. */
  freezeRows?: number
  /** 0-based header row and column span of an AutoFilter; it runs to the last row. */
  autoFilter?: Readonly<{ row: number; fromColumn: number; toColumn: number }>
  /** In-cell dropdown lists (0-based rows and column). */
  validations?: readonly XlsxValidation[]
  /** Set row heights from the wrapped text length, so long texts are readable without resizing. */
  autoHeight?: boolean
}

const RISKY_START = /^[=+\-@\t\r]/

export function isFormulaLike(text: string): boolean {
  return RISKY_START.test(text)
}

function esc(text: string): string {
  // Strip characters XML 1.0 cannot carry; escape the rest.
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function columnName(index: number): string {
  let n = index + 1
  let name = ""
  while (n > 0) {
    const r = (n - 1) % 26
    name = String.fromCharCode(65 + r) + name
    n = Math.floor((n - 1) / 26)
  }
  return name
}

// Styles: 0 default, 1 quotePrefix text, 2 date-time (numFmt 22), 3 bold, 4 bold + quotePrefix. These indexes are
// fixed. Each CellStyle adds two more (plain, quotePrefix) after them, in the order of EXTRA.
const EXTRA: readonly { style: CellStyle; font: number; fill: number; align: string }[] = [
  { style: "wrap", font: 0, fill: 0, align: `<alignment vertical="top" wrapText="1"/>` },
  { style: "header", font: 1, fill: 2, align: `<alignment vertical="center" wrapText="1"/>` },
  { style: "error", font: 2, fill: 3, align: `<alignment vertical="top" wrapText="1"/>` },
  { style: "warning", font: 3, fill: 4, align: `<alignment vertical="top" wrapText="1"/>` },
  { style: "info", font: 4, fill: 5, align: `<alignment vertical="top" wrapText="1"/>` },
  { style: "muted", font: 5, fill: 0, align: `<alignment vertical="top" wrapText="1"/>` },
]
const fill = (rgb: string) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="6"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF8F2414"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF6E4500"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF1557A0"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF5F6B7A"/><name val="Calibri"/></font></fonts>
<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>${fill("DCE6F2")}${fill("FBE9E6")}${fill("FFF1D6")}${fill("E6EFFC")}</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${5 + EXTRA.length * 2}">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1" applyNumberFormat="1"/>
<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" quotePrefix="1" applyFont="1" applyNumberFormat="1"/>
${EXTRA.map((e) => `<xf numFmtId="0" fontId="${e.font}" fillId="${e.fill}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1">${e.align}</xf>
<xf numFmtId="49" fontId="${e.font}" fillId="${e.fill}" borderId="0" xfId="0" quotePrefix="1" applyFont="1" applyFill="1" applyAlignment="1" applyNumberFormat="1">${e.align}</xf>`).join("\n")}
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

function styleIndex(style: CellStyle, quote: boolean): number {
  return 5 + EXTRA.findIndex((e) => e.style === style) * 2 + (quote ? 1 : 0)
}

function cellXml(ref: string, value: XlsxCell): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `<c r="${ref}" t="inlineStr"><is><t>${esc(String(value))}</t></is></c>`
    return `<c r="${ref}"><v>${value}</v></c>`
  }
  if (typeof value === "object" && "date" in value) {
    // value.date is an Excel serial as text (exact), used only by tests and fixtures
    return `<c r="${ref}" s="2"><v>${esc(value.date)}</v></c>`
  }
  if (typeof value === "object" && "style" in value) {
    if (typeof value.text === "number" && Number.isFinite(value.text)) return `<c r="${ref}" s="${styleIndex(value.style, false)}"><v>${value.text}</v></c>`
    const text = String(value.text)
    return `<c r="${ref}" t="inlineStr" s="${styleIndex(value.style, isFormulaLike(text))}"><is><t xml:space="preserve">${esc(text)}</t></is></c>`
  }
  const bold = typeof value === "object" && "bold" in value
  const text = bold ? value.bold : (value as string)
  const style = isFormulaLike(text) ? (bold ? 4 : 1) : bold ? 3 : 0
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${esc(text)}</t></is></c>`
}

function textOfCell(value: XlsxCell): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "number" || typeof value === "string") return String(value)
  if ("date" in value) return ""
  if ("bold" in value) return value.bold
  return String(value.text)
}

/** Estimated height (points) of a row whose cells wrap within their column widths. */
function rowHeight(row: XlsxCell[], widths: readonly number[]): number | null {
  let lines = 1
  row.forEach((cell, c) => {
    const text = textOfCell(cell)
    if (!text) return
    const perLine = Math.max(4, Math.floor((widths[c] ?? 10) * 1.15))
    lines = Math.max(lines, text.split("\n").reduce((n, part) => n + Math.max(1, Math.ceil(part.length / perLine)), 0))
  })
  return lines > 1 ? Math.min(409, Math.round(lines * 14.5 + 3)) : null
}

function sheetXml(sheet: XlsxSheet): string {
  const views = sheet.freezeRows
    ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${sheet.freezeRows}" topLeftCell="A${sheet.freezeRows + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sheet.freezeRows + 1}" sqref="A${sheet.freezeRows + 1}"/></sheetView></sheetViews>`
    : ""
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : ""
  const rows = sheet.rows
    .map((row, r) => {
      const ht = sheet.autoHeight ? rowHeight(row, sheet.widths ?? []) : null
      return `<row r="${r + 1}"${ht ? ` ht="${ht}" customHeight="1"` : ""}>${row.map((v, c) => cellXml(`${columnName(c)}${r + 1}`, v)).join("")}</row>`
    })
    .join("")
  const filter = filterRef(sheet)
  const validations = sheet.validations?.length
    ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map((v) => {
        const list = v.list.map((x) => x.replace(/[",]/g, " ")).join(",")
        const sqref = `${columnName(v.column)}${v.fromRow + 1}:${columnName(v.column)}${v.toRow + 1}`
        return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="${esc(v.title ?? "Choose from the list")}" error="Choose a value from the list."${v.prompt ? ` showInputMessage="1" promptTitle="${esc(v.title ?? "")}" prompt="${esc(v.prompt)}"` : ""} sqref="${sqref}"><formula1>${esc(`"${list}"`)}</formula1></dataValidation>`
      }).join("")}</dataValidations>`
    : ""
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${views}${cols}<sheetData>${rows}</sheetData>${filter ? `<autoFilter ref="${filter}"/>` : ""}${validations}</worksheet>`
}

function filterRef(sheet: XlsxSheet): string | null {
  const f = sheet.autoFilter
  if (!f) return null
  const last = Math.max(f.row + 1, sheet.rows.length)
  return `${columnName(f.fromColumn)}${f.row + 1}:${columnName(f.toColumn)}${last}`
}

type ZipFile = { name: string; data: Buffer }

export function zip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8")
    const compressed = deflateRawSync(f.data)
    const crc = crc32(f.data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(f.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(f.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + compressed.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

/** Excel expects the hidden _FilterDatabase name for each sheet with an AutoFilter. */
function definedNames(sheets: readonly XlsxSheet[], names: readonly string[]): string {
  const items = sheets.flatMap((s, i) => {
    const ref = filterRef(s)
    if (!ref) return []
    const abs = ref.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")
    return [`<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(`'${names[i].replace(/'/g, "''")}'!${abs}`)}</definedName>`]
  })
  return items.length ? `<definedNames>${items.join("")}</definedNames>` : ""
}

export function writeXlsx(sheets: XlsxSheet[]): Buffer {
  const names = sheets.map((s, i) => (s.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Sheet${i + 1}`))
  const files: ZipFile[] = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>${definedNames(sheets, names)}</workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    },
    { name: "xl/styles.xml", data: Buffer.from(STYLES) },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s)) })),
  ]
  return zip(files)
}
