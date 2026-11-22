// Digital Docking · Stage 1B: immutable, content-addressed files (original workbooks, photos, issued report PDFs).
// A file is written to staging, flushed to disk, then renamed into originals/ or photos/ under its SHA-256, so a
// half-written file never appears under a real name and writing the same bytes twice changes nothing.
// Files are written BEFORE the database transaction that refers to them; if that transaction fails, the files are
// orphans, which sweepOrphans() removes later. A database transaction can never point to a file that does not exist.

import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import type { Store } from "./db"

export type Kind = "originals" | "photos" | "reports"

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex")

const EXTENSIONS = new Set(["xlsx", "jpeg", "jpg", "png", "gif", "bmp", "webp", "pdf"])

/** Relative path, e.g. "originals/ab/ab12….xlsx" (stored in the database so the data folder can move). */
export function storedPath(kind: Kind, hash: string, extension: string): string {
  const ext = extension.toLowerCase().replace(/^\./, "")
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("invalid file hash")
  if (!EXTENSIONS.has(ext)) throw new Error(`file type .${ext} is not stored`)
  return `${kind}/${hash.slice(0, 2)}/${hash}.${ext}`
}

export function absolute(store: Store, path: string): string {
  const full = join(store.root, ...path.split("/"))
  const rel = relative(store.root, full)
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) throw new Error("path outside the docking data folder")
  return full
}

/** Write bytes under their hash. Returns the hash and relative path; an existing copy is checked, not rewritten. */
export function putFile(store: Store, kind: Kind, data: Buffer, extension: string): { sha256: string; path: string } {
  const hash = sha256(data)
  const path = storedPath(kind, hash, extension)
  const target = absolute(store, path)
  if (existsSync(target)) {
    if (sha256(readFileSync(target)) !== hash) throw new Error(`The stored copy of ${path} is damaged (hash mismatch). Restore it from a backup.`)
    return { sha256: hash, path }
  }
  mkdirSync(dirname(target), { recursive: true })
  const temp = join(store.root, "staging", `${randomUUID()}.part`)
  const fd = openSync(temp, "wx")
  try {
    writeSync(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    if (!existsSync(target)) throw error // another writer won the race with the same bytes: fine
  }
  return { sha256: hash, path }
}

export function readStored(store: Store, path: string, expectedHash: string): Buffer {
  const data = readFileSync(absolute(store, path))
  if (sha256(data) !== expectedHash) throw new Error(`The stored copy of ${path} is damaged (hash mismatch). Restore it from a backup.`)
  return data
}

/** Every stored file (relative paths). */
export function listStored(store: Store, kind: Kind): string[] {
  const base = join(store.root, kind)
  if (!existsSync(base)) return []
  return readdirSync(base).flatMap((dir) => {
    const sub = join(base, dir)
    return statSync(sub).isDirectory() ? readdirSync(sub).map((name) => `${kind}/${dir}/${name}`) : []
  })
}

/** Remove files that no database record refers to, older than `minAgeMs` (so an import in progress is never touched). */
export function sweepOrphans(store: Store, minAgeMs = 60 * 60 * 1000, now = Date.now()): string[] {
  const referenced = new Set<string>([
    ...(store.db.prepare("SELECT stored_path AS p FROM source_files").all() as { p: string }[]).map((r) => r.p),
    ...(store.db.prepare("SELECT stored_path AS p FROM photos WHERE stored_path IS NOT NULL").all() as { p: string }[]).map((r) => r.p),
    ...(store.db.prepare("SELECT pdf_path AS p FROM report_versions").all() as { p: string }[]).map((r) => r.p),
  ])
  const removed: string[] = []
  for (const path of [...listStored(store, "originals"), ...listStored(store, "photos"), ...listStored(store, "reports")]) {
    if (referenced.has(path)) continue
    const full = absolute(store, path)
    if (now - statSync(full).mtimeMs < minAgeMs) continue
    rmSync(full, { force: true })
    removed.push(path)
  }
  return removed
}
