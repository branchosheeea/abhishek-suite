// Vessel Master · reading the workbook (read-only; the file is never written). Turns the six sheets into plain data
// that the rules (rules.ts) can check without Excel, and lists every structural problem that must stop an import.
// No Next.js or server-only imports, so it can be tested and used from scripts.

import { createHash } from "node:crypto"
import ExcelJS from "exceljs"
import { FIELDS, IDENTITY_COLUMNS, STATUS_COLUMNS, WORKBOOK_SHEETS } from "./fields"

export type Cell = string | number | null
export type Row = Record<string, Cell>

/** The README's orange: "Physical verification required" (Vessel_Master fill FFF4B183). */
export const ORANGE = "F4B183"

export type VesselRow = {
  /** Spreadsheet row number, for messages. */
  row: number
  values: Row
  /** Columns whose cell is highlighted orange (physical verification required). */
  orange: string[]
  /** Columns highlighted in any other colour (not defined by the README: reviewed, never ignored). */
  otherFill: { column: string; argb: string }[]
}

export type ParsedWorkbook = {
  sha256: string
  sheets: string[]
  vessels: VesselRow[]
  sources: Row[]
  issues: Row[]
  physical: Row[]
  definitions: Row[]
  readme: { item: string; text: string }[]
  /** Anything listed here stops the import. */
  problems: string[]
}

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  Vessel_Master: [...IDENTITY_COLUMNS, ...Object.values(STATUS_COLUMNS), ...FIELDS.map((f) => f.column)],
  Source_Register: ["Source ID", "Vessel ID", "Field / Field Group", "Source Type", "Source Document", "Authority Level", "Verification Status"],
  Data_Quality: ["Issue ID", "Vessel ID", "Field", "Issue Type", "Disposition for SIR Autofill", "Status"],
  Physical_Verification: ["Vessel ID", "Field(s)", "Release rule", "Status"],
  Field_Definitions: ["Field Key", "Visible SIR Label", "Autofill Rule"],
}

/** A cell's value as the workbook shows it: formula results, rich text and links as text; blank as null. */
export function cellValue(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === "number") return value
  if (typeof value === "string") return value.trim() === "" ? null : value.trim()
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === "object") {
    if ("result" in value) return cellValue((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue)
    if ("richText" in value) return cellValue((value as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join(""))
    if ("text" in value) return cellValue((value as ExcelJS.CellHyperlinkValue).text)
    if ("error" in value) return null
  }
  return String(value)
}

function fillOf(cell: ExcelJS.Cell): string | null {
  const fill = cell.fill as ExcelJS.FillPattern | undefined
  if (!fill || fill.type !== "pattern" || fill.pattern === "none") return null
  const argb = fill.fgColor?.argb
  return argb ? argb.toUpperCase() : null
}

function readTable(ws: ExcelJS.Worksheet): { header: string[]; rows: { row: number; cells: ExcelJS.Cell[] }[] } {
  const header: string[] = []
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => (header[col - 1] = String(cellValue(cell.value) ?? "")))
  const rows: { row: number; cells: ExcelJS.Cell[] }[] = []
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const cells = header.map((_, i) => row.getCell(i + 1))
    if (cells.some((c) => cellValue(c.value) !== null)) rows.push({ row: r, cells })
  }
  return { header, rows }
}

const toRow = (header: string[], cells: ExcelJS.Cell[]): Row =>
  Object.fromEntries(header.map((h, i) => [h, cellValue(cells[i].value)]).filter(([h]) => h))

/** Read and check the workbook's structure. Values are kept exactly as found; interpretation is in rules.ts. */
export async function readWorkbook(data: Buffer): Promise<ParsedWorkbook> {
  const sha256 = createHash("sha256").update(data).digest("hex")
  const book = new ExcelJS.Workbook()
  try {
    await book.xlsx.load(data as unknown as ArrayBuffer)
  } catch {
    return { sha256, sheets: [], vessels: [], sources: [], issues: [], physical: [], definitions: [], readme: [], problems: ["The file could not be read as an .xlsx workbook."] }
  }
  const problems: string[] = []
  const sheets = book.worksheets.map((w) => w.name)
  for (const name of WORKBOOK_SHEETS) if (!sheets.includes(name)) problems.push(`The sheet "${name}" is missing.`)

  const table = (name: string) => {
    const ws = book.getWorksheet(name)
    if (!ws) return { header: [] as string[], rows: [] as { row: number; cells: ExcelJS.Cell[] }[] }
    const t = readTable(ws)
    for (const column of REQUIRED_COLUMNS[name] ?? []) {
      if (!t.header.includes(column)) problems.push(`${name}: the column "${column}" is missing.`)
    }
    return t
  }

  const master = table("Vessel_Master")
  const vessels: VesselRow[] = master.rows.map(({ row, cells }) => {
    const values = toRow(master.header, cells)
    const orange: string[] = []
    const otherFill: { column: string; argb: string }[] = []
    master.header.forEach((column, i) => {
      const argb = fillOf(cells[i])
      if (!argb || /^(FF)?FFFFFF$/.test(argb)) return
      if (argb.endsWith(ORANGE)) orange.push(column)
      else otherFill.push({ column, argb })
    })
    return { row, values, orange, otherFill }
  })
  const rows = (name: string) => {
    const t = table(name)
    return t.rows.map(({ cells }) => toRow(t.header, cells))
  }
  const readmeSheet = book.getWorksheet("README")
  const readme: { item: string; text: string }[] = []
  readmeSheet?.eachRow((row) => {
    const item = cellValue(row.getCell(1).value)
    const text = cellValue(row.getCell(2).value)
    if (item !== null && text !== null) readme.push({ item: String(item), text: String(text) })
  })
  if (!vessels.length) problems.push("Vessel_Master has no vessel rows.")

  return {
    sha256, sheets, vessels, readme, problems,
    sources: rows("Source_Register"), issues: rows("Data_Quality"), physical: rows("Physical_Verification"), definitions: rows("Field_Definitions"),
  }
}
