// Read-only XLSX worksheet reader. Cells keep their stored text (numbers exactly as written in the file, not
// re-formatted), with the cell type, date formatting and formula presence recorded alongside. No formula is
// evaluated: a formula cell shows its cached value, and a formula without one is reported, not computed.
// Macro-enabled workbooks, external links, ActiveX controls and embedded objects are rejected.

import { deepFreeze } from "../engine/hash"
import type { ParseIssue, SourceKind, SourceRow, SourceTable, XlsxCellType } from "../engine/types"
import { child, elements, parseXml, textOf, type XmlElement, XmlError } from "./xml"
import { readZipDirectory, readZipEntry, ZipError, type ZipEntry } from "./zip"

export class XlsxError extends Error {}

export const XLSX_LIMITS = Object.freeze({ maxRows: 200_000, maxColumns: 1_000 })

const FORBIDDEN_PARTS: Array<[RegExp, string]> = [
  [/(^|\/)vbaProject\.bin$/i, "contains macros (VBA)"],
  [/^xl\/externalLinks\//i, "links to external workbooks"],
  [/^xl\/activeX\//i, "contains ActiveX controls"],
  [/^xl\/embeddings\//i, "contains embedded objects"],
]

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])

export function isDateFormat(id: number, code: string | undefined): boolean {
  if (BUILTIN_DATE_FORMATS.has(id)) return true
  if (!code) return false
  const stripped = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?!h+\]|m+\]|s+\])[^\]]*\]/gi, "")
  if (/^general$/i.test(stripped.trim())) return false
  return /[ydhs]|m/i.test(stripped.replace(/[#0?.,%E+\-]/g, ""))
}

function columnIndex(ref: string): number {
  const letters = /^([A-Z]{1,3})\d+$/.exec(ref)?.[1]
  if (!letters) return -1
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

type Workbook = { sheets: { name: string; target: string }[]; date1904: boolean }

function readPart(buf: Buffer, entries: Map<string, ZipEntry>, name: string): string | undefined {
  const entry = entries.get(name)
  return entry ? readZipEntry(buf, entry).toString("utf8") : undefined
}

function resolveTarget(target: string): string {
  const clean = target.startsWith("/") ? target.slice(1) : `xl/${target}`
  const parts: string[] = []
  for (const segment of clean.split("/")) {
    if (segment === "..") parts.pop()
    else if (segment && segment !== ".") parts.push(segment)
  }
  return parts.join("/")
}

function readWorkbook(buf: Buffer, entries: Map<string, ZipEntry>): Workbook {
  const workbookXml = readPart(buf, entries, "xl/workbook.xml")
  const relsXml = readPart(buf, entries, "xl/_rels/workbook.xml.rels")
  if (!workbookXml || !relsXml) throw new XlsxError("The file is not an Excel workbook (xl/workbook.xml is missing).")
  const rels = new Map<string, string>()
  for (const rel of elements(parseXml(relsXml), "Relationship")) {
    if ((rel.attrs.TargetMode ?? "").toLowerCase() === "external") {
      throw new XlsxError("The workbook references an external resource, so it is not accepted.")
    }
    rels.set(rel.attrs.Id, rel.attrs.Target)
  }
  const workbook = parseXml(workbookXml)
  const date1904 = ["1", "true"].includes((child(workbook, "workbookPr")?.attrs.date1904 ?? "").toLowerCase())
  const sheetsNode = child(workbook, "sheets")
  const sheets = (sheetsNode ? elements(sheetsNode, "sheet") : []).map((s) => {
    const target = rels.get(s.attrs.id ?? "")
    if (!target) throw new XlsxError(`Worksheet "${s.attrs.name}" has no part in the workbook.`)
    return { name: s.attrs.name ?? "", target: resolveTarget(target) }
  })
  if (sheets.length === 0) throw new XlsxError("The workbook has no worksheets.")
  return { sheets, date1904 }
}

function readSharedStrings(buf: Buffer, entries: Map<string, ZipEntry>): string[] {
  const xml = readPart(buf, entries, "xl/sharedStrings.xml")
  if (!xml) return []
  return elements(parseXml(xml), "si").map((si) => {
    let text = ""
    for (const node of si.children) {
      if (typeof node === "string") continue
      if (node.name === "t") text += textOf(node)
      else if (node.name === "r") {
        const t = child(node, "t")
        if (t) text += textOf(t)
      }
      // rPh (phonetic hints) is display-only and excluded.
    }
    return text
  })
}

function readDateStyles(buf: Buffer, entries: Map<string, ZipEntry>): boolean[] {
  const xml = readPart(buf, entries, "xl/styles.xml")
  if (!xml) return []
  const styles = parseXml(xml)
  const custom = new Map<number, string>()
  const numFmts = child(styles, "numFmts")
  for (const f of numFmts ? elements(numFmts, "numFmt") : []) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? "")
  const cellXfs = child(styles, "cellXfs")
  return (cellXfs ? elements(cellXfs, "xf") : []).map((xf) => {
    const id = Number(xf.attrs.numFmtId ?? 0)
    return isDateFormat(id, custom.get(id))
  })
}

export function listSheets(bytes: Uint8Array): string[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = new Map(readZipDirectory(buf).map((e) => [e.name, e]))
  return readWorkbook(buf, entries).sheets.map((s) => s.name)
}

export function parseXlsx(bytes: Uint8Array, kind: SourceKind, sha256: string, filename: string, sheetName?: string): SourceTable {
  try {
    return parse(bytes, kind, sha256, filename, sheetName)
  } catch (error) {
    if (error instanceof ZipError || error instanceof XmlError) throw new XlsxError(error.message)
    throw error
  }
}

function parse(bytes: Uint8Array, kind: SourceKind, sha256: string, filename: string, sheetName?: string): SourceTable {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const list = readZipDirectory(buf)
  for (const entry of list) {
    for (const [pattern, reason] of FORBIDDEN_PARTS) {
      if (pattern.test(entry.name)) throw new XlsxError(`The workbook ${reason}, so it is not accepted.`)
    }
  }
  const entries = new Map(list.map((e) => [e.name, e]))
  const contentTypes = readPart(buf, entries, "[Content_Types].xml")
  if (!contentTypes) throw new XlsxError("The file is not an Office Open XML package ([Content_Types].xml is missing).")
  if (/macroEnabled/i.test(contentTypes)) throw new XlsxError("The workbook is macro-enabled, so it is not accepted.")

  const workbook = readWorkbook(buf, entries)
  const sheet = sheetName ? workbook.sheets.find((s) => s.name === sheetName) : workbook.sheets[0]
  if (!sheet) throw new XlsxError(`The workbook has no worksheet named "${sheetName}".`)
  const strings = readSharedStrings(buf, entries)
  const dateStyles = readDateStyles(buf, entries)
  const sheetXml = readPart(buf, entries, sheet.target)
  if (!sheetXml) throw new XlsxError(`The worksheet "${sheet.name}" could not be found in the workbook.`)
  const sheetData = child(parseXml(sheetXml), "sheetData")
  const issues: ParseIssue[] = []
  if (workbook.sheets.length > 1) {
    issues.push({
      code: "xlsx.sheets",
      severity: "info",
      message: `The workbook has ${workbook.sheets.length} worksheets; "${sheet.name}" was read.`,
    })
  }

  type Cell = { value: string; type: XlsxCellType; date: boolean; formula: boolean }
  const parsedRows: { line: number; cells: Map<number, Cell> }[] = []
  let lastRow = 0
  for (const row of sheetData ? elements(sheetData, "row") : []) {
    const line = row.attrs.r ? Number(row.attrs.r) : lastRow + 1
    if (!Number.isInteger(line) || line <= lastRow) throw new XlsxError("Worksheet rows are out of order or duplicated.")
    lastRow = line
    if (parsedRows.length > XLSX_LIMITS.maxRows) throw new XlsxError(`The worksheet has more than ${XLSX_LIMITS.maxRows} rows.`)
    const cells = new Map<number, Cell>()
    let nextColumn = 0
    for (const c of elements(row, "c")) {
      const column = c.attrs.r ? columnIndex(c.attrs.r) : nextColumn
      if (column < 0 || column >= XLSX_LIMITS.maxColumns) throw new XlsxError(`Cell reference "${c.attrs.r}" is invalid or beyond ${XLSX_LIMITS.maxColumns} columns.`)
      nextColumn = column + 1
      const type = (c.attrs.t ?? "n") as XlsxCellType
      const v = child(c, "v")
      const formula = child(c, "f") !== undefined
      let value = v ? textOf(v) : ""
      if (type === "s") {
        const index = Number(value)
        if (value === "" || !Number.isInteger(index) || index < 0 || index >= strings.length) {
          issues.push({ code: "xlsx.shared-string", severity: "error", line, message: `Row ${line}: cell ${c.attrs.r} points to a missing shared string.` })
          value = ""
        } else {
          value = strings[index]
        }
      } else if (type === "inlineStr") {
        const is = child(c, "is")
        value = is ? inlineText(is) : ""
      }
      if (formula && !v) {
        issues.push({
          code: "xlsx.formula-no-value",
          severity: "warning",
          line,
          message: `Row ${line}: cell ${c.attrs.r} has a formula but no saved value. The formula was not evaluated.`,
        })
      }
      const style = c.attrs.s ? Number(c.attrs.s) : 0
      cells.set(column, { value, type, date: type === "n" && value !== "" && dateStyles[style] === true, formula })
    }
    parsedRows.push({ line, cells })
  }
  if (parsedRows.length === 0) throw new XlsxError(`The worksheet "${sheet.name}" is empty.`)

  const [header, ...data] = parsedRows
  const width = parsedRows.reduce((w, r) => {
    let last = -1
    for (const key of r.cells.keys()) if (key > last) last = key
    return Math.max(w, last + 1)
  }, 0)
  const headerCells = Array.from({ length: width }, (_, i) => header.cells.get(i)?.value ?? "")
  while (headerCells.length > 0 && headerCells[headerCells.length - 1] === "") headerCells.pop()
  const columns = Math.max(headerCells.length, width)

  const rows: SourceRow[] = data.map((r, index) => {
    const span = Array.from({ length: columns }, (_, i) => r.cells.get(i))
    const blank = span.every((cell) => !cell || cell.value === "")
    if (!blank && span.some((cell, i) => i >= headerCells.length && cell !== undefined && cell.value !== "")) {
      issues.push({ code: "xlsx.beyond-header", severity: "warning", line: r.line, message: `Row ${r.line} has values in columns without a header.` })
    }
    return {
      index,
      line: r.line,
      cells: span.map((cell) => cell?.value ?? ""),
      types: span.map((cell) => cell?.type),
      dateFormatted: span.map((cell) => cell?.date ?? false),
      formulas: span.map((cell) => cell?.formula ?? false),
      ...(blank ? { blankLine: true } : {}),
    }
  })

  return deepFreeze({
    kind,
    sha256,
    filename,
    format: "xlsx",
    headerLine: header.line,
    headers: headerCells,
    rows,
    meta: { encoding: "UTF-8 (XML)", sheet: sheet.name, sheets: workbook.sheets.map((s) => s.name), date1904: workbook.date1904 },
    issues,
  } satisfies SourceTable)
}

function inlineText(is: XmlElement): string {
  let text = ""
  for (const node of is.children) {
    if (typeof node === "string") continue
    if (node.name === "t") text += textOf(node)
    else if (node.name === "r") {
      const t = child(node, "t")
      if (t) text += textOf(t)
    }
  }
  return text
}
