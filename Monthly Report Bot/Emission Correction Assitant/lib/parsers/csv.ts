// RFC 4180 CSV reader for registered source files. It reads; it never repairs. Every irregularity (stray quotes,
// ragged rows, blank lines, non-UTF-8 bytes) is reported as a ParseIssue and the original text is kept.

import { deepFreeze } from "../engine/hash"
import type { ParseIssue, SourceKind, SourceRow, SourceTable } from "../engine/types"

export const CSV_LIMITS = Object.freeze({
  maxRows: 200_000,
  maxColumns: 1_000,
  maxFieldChars: 100_000,
})

type RawRecord = { line: number; fields: string[]; blankLine: boolean }

export function decodeText(bytes: Uint8Array): { text: string; encoding: string; bom: boolean; issues: ParseIssue[] } {
  const issues: ParseIssue[] = []
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = bom ? bytes.subarray(3) : bytes
  if (body.includes(0)) {
    throw new CsvError("The file contains NUL bytes, so it is not a text CSV file.")
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body), encoding: "UTF-8", bom, issues }
  } catch {
    issues.push({
      code: "csv.encoding",
      severity: "warning",
      message: "The file is not valid UTF-8. It was decoded as Windows-1252 for analysis; the stored file is unchanged.",
    })
    return { text: new TextDecoder("windows-1252").decode(body), encoding: "Windows-1252", bom, issues }
  }
}

export class CsvError extends Error {}

function detectDelimiter(text: string): string {
  const candidates = [",", ";", "\t"]
  let inQuotes = false
  const counts = new Map(candidates.map((c) => [c, 0]))
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break
    else if (!inQuotes && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  let best = ","
  let bestCount = 0
  for (const [c, n] of counts) {
    if (n > bestCount) {
      best = c
      bestCount = n
    }
  }
  return best
}

function tokenize(text: string, delimiter: string, issues: ParseIssue[]) {
  const records: RawRecord[] = []
  const endings = { crlf: 0, lf: 0, cr: 0 }
  let line = 1
  let recordLine = 1
  let fields: string[] = []
  let field = ""
  let quoted = false // the current field started with a quote
  let inQuotes = false
  let afterClosingQuote = false
  let quotedEmpty = false // the record's only field was written as "" (an empty value, not a blank line)
  let i = 0

  const pushField = () => {
    if (field.length > CSV_LIMITS.maxFieldChars) throw new CsvError(`A field on line ${recordLine} exceeds ${CSV_LIMITS.maxFieldChars} characters.`)
    fields.push(field)
    field = ""
    quoted = false
    afterClosingQuote = false
  }
  const pushRecord = () => {
    pushField()
    if (fields.length > CSV_LIMITS.maxColumns) throw new CsvError(`Line ${recordLine} has more than ${CSV_LIMITS.maxColumns} columns.`)
    const blankLine = fields.length === 1 && fields[0] === "" && !quotedEmpty
    records.push({ line: recordLine, fields, blankLine })
    if (records.length > CSV_LIMITS.maxRows + 1) throw new CsvError(`The file has more than ${CSV_LIMITS.maxRows} rows.`)
    fields = []
    quotedEmpty = false
  }

  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        afterClosingQuote = true
        if (field === "") quotedEmpty = fields.length === 0
        i += 1
        continue
      }
      if (ch === "\r" || ch === "\n") {
        // Line break inside a quoted field is part of the value; count physical lines.
        if (ch === "\r" && text[i + 1] === "\n") {
          field += "\r\n"
          i += 2
        } else {
          field += ch
          i += 1
        }
        line += 1
        continue
      }
      field += ch
      i += 1
      continue
    }
    if (ch === delimiter) {
      pushField()
      i += 1
      continue
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") {
        endings.crlf += 1
        i += 2
      } else {
        if (ch === "\r") endings.cr += 1
        else endings.lf += 1
        i += 1
      }
      pushRecord()
      line += 1
      recordLine = line
      continue
    }
    if (ch === '"') {
      if (field === "" && !quoted && !afterClosingQuote) {
        quoted = true
        inQuotes = true
        i += 1
        continue
      }
      issues.push({
        code: "csv.stray-quote",
        severity: "warning",
        line,
        message: `Line ${line}: a quote character appears inside an unquoted field or after a closing quote. The text was kept as written.`,
      })
      field += ch
      i += 1
      continue
    }
    if (afterClosingQuote) {
      issues.push({
        code: "csv.text-after-quote",
        severity: "warning",
        line,
        message: `Line ${line}: characters follow a closing quote before the next delimiter. They were kept as written.`,
      })
      afterClosingQuote = false
    }
    field += ch
    i += 1
  }
  if (inQuotes) {
    issues.push({
      code: "csv.unterminated-quote",
      severity: "error",
      line: recordLine,
      message: `The quoted field that starts on line ${recordLine} is never closed. The rest of the file was read into that field.`,
    })
  }
  // A final line break does not start another record.
  if (field !== "" || fields.length > 0 || quoted || afterClosingQuote) pushRecord()

  const kinds = [endings.crlf > 0, endings.lf > 0, endings.cr > 0].filter(Boolean).length
  const lineEndings: "CRLF" | "LF" | "CR" | "mixed" | "none" =
    kinds === 0 ? "none" : kinds > 1 ? "mixed" : endings.crlf ? "CRLF" : endings.lf ? "LF" : "CR"
  if (lineEndings === "mixed") {
    issues.push({ code: "csv.mixed-line-endings", severity: "info", message: "The file mixes line-ending styles (CRLF / LF / CR)." })
  }
  return { records, lineEndings }
}

/** Parse registered CSV bytes into a frozen table. The first record is the header row. */
export function parseCsv(bytes: Uint8Array, kind: SourceKind, sha256: string, filename: string): SourceTable {
  const decoded = decodeText(bytes)
  const issues: ParseIssue[] = [...decoded.issues]
  if (decoded.text.trim() === "") throw new CsvError("The file is empty.")
  const delimiter = detectDelimiter(decoded.text)
  if (delimiter !== ",") {
    issues.push({
      code: "csv.delimiter",
      severity: "info",
      message: `The header row uses "${delimiter === "\t" ? "TAB" : delimiter}" as the delimiter, not a comma.`,
    })
  }
  const { records, lineEndings } = tokenize(decoded.text, delimiter, issues)
  const [header, ...data] = records
  const headers = header.fields
  const rows: SourceRow[] = data.map((record, index) => {
    if (!record.blankLine && record.fields.length !== headers.length) {
      issues.push({
        code: "csv.column-count",
        severity: "error",
        line: record.line,
        message: `Line ${record.line} has ${record.fields.length} fields; the header has ${headers.length}. No field was moved or filled.`,
      })
    }
    if (record.blankLine) {
      issues.push({ code: "csv.blank-line", severity: "warning", line: record.line, message: `Line ${record.line} is blank.` })
    }
    return { index, line: record.line, cells: record.fields, ...(record.blankLine ? { blankLine: true } : {}) }
  })
  return deepFreeze({
    kind,
    sha256,
    filename,
    format: "csv",
    headerLine: header.line,
    headers,
    rows,
    meta: { encoding: decoded.encoding, bom: decoded.bom, delimiter, lineEndings },
    issues,
  } satisfies SourceTable)
}
