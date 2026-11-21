// Digital Docking · Stage 1A: read an .xlsx package safely, before anything inside it is parsed.
// The workbook comes from outside (a vessel), so it is untrusted: limits on file size, number of entries and total
// unzipped size; no paths that climb out of the package; no encrypted, legacy (.xls) or macro-enabled workbooks.

import yauzl from "yauzl"

export type PackageLimits = Readonly<{
  maxFileBytes: number
  maxEntries: number
  maxTotalUnzippedBytes: number
  maxEntryBytes: number
}>

/** 50 MB covers a Teams-shared workbook with better photos (D6); email copies are at most 8 MB for both files. */
export const DEFAULT_LIMITS: PackageLimits = {
  maxFileBytes: 50 * 1024 * 1024,
  maxEntries: 5000,
  maxTotalUnzippedBytes: 400 * 1024 * 1024,
  maxEntryBytes: 60 * 1024 * 1024,
}

export class WorkbookRejected extends Error {}

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const MACRO_TYPES = /macroEnabled|vbaProject|ms-office\.activeX|application\/vnd\.ms-excel\.(sheet\.binary|addin)/i

function safeName(name: string): boolean {
  return !!name && !name.startsWith("/") && !name.includes("\\") && !/^[a-z]:/i.test(name) && !name.split("/").includes("..") && !name.includes("\u0000")
}

/** Every entry of the package, by name. Throws WorkbookRejected with a reason a Superintendent can act on. */
export async function readPackage(data: Buffer, limits: PackageLimits = DEFAULT_LIMITS): Promise<Map<string, Buffer>> {
  if (data.length > limits.maxFileBytes) {
    throw new WorkbookRejected(`The file is ${(data.length / 1048576).toFixed(1)} MB; the limit is ${(limits.maxFileBytes / 1048576).toFixed(0)} MB.`)
  }
  if (data.subarray(0, 8).equals(OLE_SIGNATURE)) {
    throw new WorkbookRejected("This is an old-format (.xls) or password-protected workbook. Save it as an Excel Workbook (.xlsx) without a password and send it again.")
  }
  if (data.subarray(0, 2).toString("latin1") !== "PK") throw new WorkbookRejected("This file is not an Excel .xlsx workbook.")

  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true, strictFileNames: false }, (error, file) =>
      error || !file ? reject(new WorkbookRejected(`The workbook could not be opened: ${error?.message ?? "unknown error"}.`)) : resolve(file),
    ),
  )
  const entries = new Map<string, Buffer>()
  let total = 0
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        zip.close()
        reject(new WorkbookRejected(message))
      }
      zip.on("error", (error: Error) =>
        fail(/invalid relative path|absolute path|invalid characters in fileName/i.test(error.message)
          ? `The workbook contains an unsafe part name (${error.message.replace(/^.*?:\s*/, "")}).`
          : `The workbook is damaged: ${error.message}.`))
      zip.on("end", () => resolve())
      zip.on("entry", (entry: yauzl.Entry) => {
        if (entries.size + 1 > limits.maxEntries) return fail(`The workbook has more than ${limits.maxEntries} parts.`)
        if (!safeName(entry.fileName)) return fail(`The workbook contains an unsafe part name (${JSON.stringify(entry.fileName)}).`)
        if (/\/$/.test(entry.fileName)) return zip.readEntry()
        if ((entry.generalPurposeBitFlag & 0x1) !== 0) return fail("The workbook is encrypted. Remove the password and send it again.")
        if (entry.uncompressedSize > limits.maxEntryBytes) return fail(`A part of the workbook (${entry.fileName}) is larger than ${limits.maxEntryBytes / 1048576} MB.`)
        total += entry.uncompressedSize
        if (total > limits.maxTotalUnzippedBytes) return fail("The workbook unpacks to more than the allowed size.")
        if (entries.has(entry.fileName)) return fail(`The workbook contains the part ${entry.fileName} twice.`)
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return fail(`A part of the workbook could not be read (${entry.fileName}).`)
          const chunks: Buffer[] = []
          stream.on("data", (chunk: Buffer) => chunks.push(chunk))
          stream.on("error", (e: Error) => fail(`A part of the workbook is damaged (${entry.fileName}): ${e.message}.`))
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks))
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }

  const types = entries.get("[Content_Types].xml")?.toString("utf8")
  if (!types || !entries.has("xl/workbook.xml")) throw new WorkbookRejected("This file is not an Excel .xlsx workbook.")
  if (MACRO_TYPES.test(types) || [...entries.keys()].some((name) => /vbaProject\.bin$|activeX/i.test(name))) {
    throw new WorkbookRejected("The workbook contains macros or ActiveX controls. Save it as an Excel Workbook (.xlsx) and send it again.")
  }
  return entries
}
