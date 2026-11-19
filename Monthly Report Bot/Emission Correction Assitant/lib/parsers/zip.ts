// Minimal, defensive ZIP reader for XLSX workbooks (Node zlib only, no third-party archive code).
// Protections: entry-count and size limits checked from the central directory BEFORE anything is inflated,
// a compression-ratio limit (decompression bombs), inflate output capped at the declared size, CRC-32 checked,
// encrypted and ZIP64 archives rejected. Nothing is ever written to disk.

import { crc32, inflateRawSync } from "node:zlib"

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 2_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 160 * 1024 * 1024,
  /** Uncompressed / compressed. Ordinary XML compresses ~5–20×; bombs are thousands. */
  maxRatio: 150,
  /** The ratio rule applies only to entries larger than this (tiny entries compress oddly). */
  ratioFloorBytes: 1024 * 1024,
})

export class ZipError extends Error {}

export type ZipEntry = Readonly<{
  name: string
  method: number
  compressedSize: number
  size: number
  crc: number
  localOffset: number
}>

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

function findEndOfCentralDirectory(buf: Buffer): number {
  const minimum = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= minimum; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) return i
  }
  throw new ZipError("Not a ZIP archive (no end-of-central-directory record).")
}

export function readZipDirectory(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new ZipError("File too small to be a ZIP archive.")
  const eocd = findEndOfCentralDirectory(buf)
  const total = buf.readUInt16LE(eocd + 10)
  const dirSize = buf.readUInt32LE(eocd + 12)
  const dirOffset = buf.readUInt32LE(eocd + 16)
  if (total === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new ZipError("ZIP64 archives are not supported.")
  if (total > ZIP_LIMITS.maxEntries) throw new ZipError(`The workbook has ${total} parts; the limit is ${ZIP_LIMITS.maxEntries}.`)
  if (dirOffset + dirSize > eocd) throw new ZipError("The ZIP central directory is out of bounds.")

  const entries: ZipEntry[] = []
  let declaredTotal = 0
  let p = dirOffset
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipError("Corrupt ZIP central directory.")
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString("utf8", p + 46, p + 46 + nameLength)
    if (flags & 0x1) throw new ZipError("Encrypted workbooks are not accepted.")
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("ZIP64 entries are not supported.")
    if (method !== 0 && method !== 8) throw new ZipError(`Unsupported compression method ${method} in "${name}".`)
    if (size > ZIP_LIMITS.maxEntryBytes) throw new ZipError(`Workbook part "${name}" is larger than the ${ZIP_LIMITS.maxEntryBytes / 1048576} MB limit.`)
    if (size > ZIP_LIMITS.ratioFloorBytes && size / Math.max(1, compressedSize) > ZIP_LIMITS.maxRatio) {
      throw new ZipError(`Workbook part "${name}" has a compression ratio above ${ZIP_LIMITS.maxRatio}:1 (possible decompression bomb).`)
    }
    declaredTotal += size
    if (declaredTotal > ZIP_LIMITS.maxTotalBytes) throw new ZipError(`The workbook expands to more than ${ZIP_LIMITS.maxTotalBytes / 1048576} MB.`)
    entries.push({ name, method, compressedSize, size, crc, localOffset })
    p += 46 + nameLength + extraLength + commentLength
  }
  const names = new Set<string>()
  for (const entry of entries) {
    if (names.has(entry.name)) throw new ZipError(`The workbook contains the part "${entry.name}" twice.`)
    names.add(entry.name)
  }
  return entries
}

export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localOffset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL) throw new ZipError(`Corrupt local header for "${entry.name}".`)
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28)
  const end = start + entry.compressedSize
  if (end > buf.length) throw new ZipError(`"${entry.name}" extends past the end of the file.`)
  const raw = buf.subarray(start, end)
  let data: Buffer
  if (entry.method === 0) {
    data = Buffer.from(raw)
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) })
    } catch {
      throw new ZipError(`"${entry.name}" could not be decompressed within its declared size.`)
    }
  }
  if (data.length !== entry.size) throw new ZipError(`"${entry.name}" does not match its declared size.`)
  if ((crc32(data) >>> 0) !== entry.crc) throw new ZipError(`"${entry.name}" failed its CRC-32 check.`)
  return data
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}
