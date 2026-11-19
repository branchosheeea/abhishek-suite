// Upload gate and parser dispatch. Each source kind accepts exactly one format, checked by extension AND content.

import type { SourceKind, SourceTable } from "../engine/types"
import { CsvError, parseCsv } from "./csv"
import { parseXlsx, XlsxError } from "./xlsx"
import { isZip } from "./zip"

export const UPLOAD_LIMITS = Object.freeze({ maxBytes: 25 * 1024 * 1024, maxFilenameChars: 200 })

export const EXPECTED_FORMAT: Record<SourceKind, "csv" | "xlsx"> = { LA: "csv", BR: "csv", OVDLA: "xlsx" }

export class SourceRejected extends Error {}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b)
}

/** Reject anything that is not plainly the expected kind of file. Returns the format to parse with. */
export function checkUpload(bytes: Uint8Array, filename: string, kind: SourceKind): "csv" | "xlsx" {
  if (bytes.length === 0) throw new SourceRejected("The file is empty.")
  if (bytes.length > UPLOAD_LIMITS.maxBytes) throw new SourceRejected(`The file is larger than ${UPLOAD_LIMITS.maxBytes / 1048576} MB.`)
  if (!filename || filename.length > UPLOAD_LIMITS.maxFilenameChars || /[\\/\u0000-\u001f]/.test(filename)) {
    throw new SourceRejected("The file name is missing, too long or contains path or control characters.")
  }
  const extension = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase() ?? ""
  const expected = EXPECTED_FORMAT[kind]
  if (startsWith(bytes, OLE_MAGIC)) throw new SourceRejected("Legacy .xls (OLE) files are not accepted. Use the .xlsx or .csv file as issued.")
  if (expected === "csv") {
    if (extension !== "csv") throw new SourceRejected(`A ${kind} source must be a .csv file.`)
    if (isZip(bytes)) throw new SourceRejected("The file has a .csv name but is a ZIP/Excel package.")
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) throw new SourceRejected("The file is a PDF, not a CSV file.")
    return "csv"
  }
  if (extension === "xlsm" || extension === "xltm") throw new SourceRejected("Macro-enabled workbooks are not accepted.")
  if (extension !== "xlsx") throw new SourceRejected(`A ${kind} source must be an .xlsx workbook.`)
  if (!isZip(bytes)) throw new SourceRejected("The file has an .xlsx name but is not an Excel workbook.")
  return "xlsx"
}

export function parseSource(bytes: Uint8Array, kind: SourceKind, sha256: string, filename: string, sheet?: string): SourceTable {
  const format = checkUpload(bytes, filename, kind)
  try {
    return format === "csv" ? parseCsv(bytes, kind, sha256, filename) : parseXlsx(bytes, kind, sha256, filename, sheet)
  } catch (error) {
    if (error instanceof CsvError || error instanceof XlsxError) throw new SourceRejected(error.message)
    throw error
  }
}
