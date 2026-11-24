// Daily backup of a MongoDB database (audit item P1-1): the inspection reports (Superintendent inspection Report) and
// the emissions validation records and source files (Emission Correction Assitant).
//
// KEEP IDENTICAL in "Superintendent inspection Report/lib/server/mongo-backup.ts" and
// "Emission Correction Assitant/lib/server/mongo-backup.ts" (Next.js cannot share code between the two apps; a test in
// Superintendent inspection Report compares the files).
//
//   <dest>/<stamp>/manifest.json   database, time, and for each collection its count and the SHA-256 of every document
//   <dest>/files/ab/<sha256>.json.gz   each document once (Extended JSON, so types such as dates, ids and binary file
//                                      chunks survive), shared by all snapshots: after the first, a day adds only what changed
// <dest> is <backups>/<name>-daily, where <backups> is NERAVEDA_BACKUP_DIR, else <suite data>/backups on this PC (outside
// OneDrive). The newest 30 snapshots are kept. A snapshot is written as "<stamp>.partial" and renamed only when complete.
// A restore goes only into an EMPTY database, never over live data, and is checked against the manifest.
// No Next.js or server-only imports, so it can be tested and used from scripts.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { BSON, type Document } from "mongodb"

export const KEEP = 30

/** Where documents come from: a database's collections, read one document at a time. */
export type BackupSource = {
  collections: () => Promise<string[]>
  documents: (collection: string) => AsyncIterable<Document>
}

/** Where a restore goes: must have no collections before it starts. */
export type RestoreTarget = {
  collections: () => Promise<string[]>
  insert: (collection: string, documents: Document[]) => Promise<void>
  count: (collection: string) => Promise<number>
}

export type MongoManifest = {
  kind: "mongodb"
  database: string
  created_at: string
  collections: Record<string, { count: number; documents: string[] }>
}

/** The backup folder for one database: <NERAVEDA_BACKUP_DIR or suite data/backups>/<name>-daily. */
export function backupRoot(name: string): string {
  const suite = process.env.ABHISHEK_SUITE_DATA || join(process.env.LOCALAPPDATA || homedir(), "AbhishekAutomationSuite")
  return join(process.env.NERAVEDA_BACKUP_DIR || join(suite, "backups"), `${name}-daily`)
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const fileFor = (dest: string, sha: string) => join(dest, "files", sha.slice(0, 2), `${sha}.json.gz`)
const encode = (doc: Document) => BSON.EJSON.stringify(doc, { relaxed: false })

/** Complete snapshots (with a manifest), oldest first. */
export function snapshots(dest: string): string[] {
  if (!existsSync(dest)) return []
  return readdirSync(dest)
    .filter((n) => n !== "files" && !n.endsWith(".partial") && existsSync(join(dest, n, "manifest.json")))
    .sort()
    .map((n) => join(dest, n))
}

export function latestBackupDay(dest: string): string {
  const all = snapshots(dest)
  return all.length ? (all[all.length - 1].split(/[\\/]/).pop() ?? "").slice(0, 10) : ""
}

const readManifest = (folder: string) => JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")) as MongoManifest

/** Take a snapshot of the whole database. Returns its folder. */
export async function backupDatabase(
  source: BackupSource,
  options: { dest: string; database: string; keep?: number; now?: Date },
): Promise<string> {
  const { dest, database } = options
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-")
  const folder = join(dest, stamp)
  const partial = `${folder}.partial`
  if (existsSync(folder)) throw new Error(`A backup named ${stamp} already exists.`)
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(partial, { recursive: true })

  const manifest: MongoManifest = { kind: "mongodb", database, created_at: new Date().toISOString(), collections: {} }
  for (const name of (await source.collections()).sort()) {
    const documents: string[] = []
    for await (const doc of source.documents(name)) {
      const text = encode(doc)
      const sha = sha256(text)
      const path = fileFor(dest, sha)
      if (!existsSync(path)) {
        mkdirSync(join(dest, "files", sha.slice(0, 2)), { recursive: true })
        writeFileSync(`${path}.tmp`, gzipSync(text))
        renameSync(`${path}.tmp`, path)
      }
      documents.push(sha)
    }
    manifest.collections[name] = { count: documents.length, documents }
  }
  writeFileSync(join(partial, "manifest.json"), JSON.stringify(manifest))
  renameSync(partial, folder)
  prune(dest, options.keep ?? KEEP)
  return folder
}

/** Keep the newest snapshots; remove documents no kept snapshot refers to, and leftovers of interrupted backups. */
function prune(dest: string, keep: number) {
  const all = snapshots(dest)
  for (const old of all.slice(0, Math.max(0, all.length - keep))) rmSync(old, { recursive: true, force: true })
  for (const name of readdirSync(dest)) if (name.endsWith(".partial")) rmSync(join(dest, name), { recursive: true, force: true })
  const wanted = new Set<string>()
  for (const folder of snapshots(dest)) for (const c of Object.values(readManifest(folder).collections)) for (const sha of c.documents) wanted.add(sha)
  const files = join(dest, "files")
  if (!existsSync(files)) return
  for (const bucket of readdirSync(files)) {
    for (const name of readdirSync(join(files, bucket))) {
      if (!wanted.has(name.replace(/\.json\.gz$/, "")) || name.endsWith(".tmp")) rmSync(join(files, bucket, name), { force: true })
    }
  }
}

/** Take today's snapshot if there is none yet (days in UTC). Returns its folder, or null. */
export async function dailyBackup(
  source: BackupSource,
  options: { dest: string; database: string; keep?: number; now?: Date },
): Promise<string | null> {
  const now = options.now ?? new Date()
  if (latestBackupDay(options.dest) === now.toISOString().slice(0, 10)) return null
  return backupDatabase(source, { ...options, now })
}

/** The documents of one collection in a snapshot, each checked against its SHA-256. */
export function* snapshotDocuments(folder: string, collection: string): Generator<Document> {
  const dest = join(folder, "..")
  for (const sha of readManifest(folder).collections[collection]?.documents ?? []) {
    const path = fileFor(dest, sha)
    if (!existsSync(path)) throw new Error(`A document of ${collection} is missing from the backup (${sha}).`)
    const text = gunzipSync(readFileSync(path)).toString("utf8")
    if (sha256(text) !== sha) throw new Error(`A document of ${collection} in the backup is damaged (${sha}).`)
    yield BSON.EJSON.parse(text, { relaxed: false }) as Document
  }
}

/** Check every document of a snapshot. Returns the record count per collection. */
export function verifySnapshot(folder: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const name of Object.keys(readManifest(folder).collections)) {
    let n = 0
    for (const _doc of snapshotDocuments(folder, name)) n++
    counts[name] = n
  }
  return counts
}

/** Restore a snapshot into an EMPTY database, checking it first and the counts after. Indexes are not restored: the
 *  apps create theirs on first use. */
export async function restoreSnapshot(folder: string, target: RestoreTarget, batch = 500): Promise<Record<string, number>> {
  if ((await target.collections()).length) throw new Error("The target database is not empty; restore only into an empty database.")
  const counts = verifySnapshot(folder)
  for (const name of Object.keys(counts)) {
    let pending: Document[] = []
    for (const doc of snapshotDocuments(folder, name)) {
      pending.push(doc)
      if (pending.length >= batch) {
        await target.insert(name, pending)
        pending = []
      }
    }
    if (pending.length) await target.insert(name, pending)
  }
  for (const [name, n] of Object.entries(counts)) {
    const restored = await target.count(name)
    if (restored !== n) throw new Error(`Restore check failed: ${name} has ${restored} documents, the backup recorded ${n}.`)
  }
  return counts
}
