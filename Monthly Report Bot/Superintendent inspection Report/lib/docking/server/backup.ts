// Digital Docking · Stage 1B: consistent backups and a restore that is checked, not assumed.
//   <backups>/<stamp>/docking.sqlite3   online snapshot of the database (node:sqlite backup, safe while in use)
//   <backups>/<stamp>/manifest.json     schema version, record counts and every stored file with its SHA-256
//   <backups>/files/…                   the files, content-addressed and shared by all snapshots (incremental)
// <backups> is DOCKING_BACKUP_DIR (e.g. another drive or a synced folder), else <data>/docking/backups.
// A backup on the same disk protects against mistakes and damage, not against losing the PC: point
// DOCKING_BACKUP_DIR somewhere else for that.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { copyFile, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { backup, DatabaseSync } from "node:sqlite"
import { closeStore, openStore, SCHEMA_VERSION, type Store } from "./db"
import { sha256 } from "./files"

export type Manifest = Readonly<{
  schema: number
  created_at: string
  counts: Record<string, number>
  files: readonly { path: string; sha256: string }[]
}>

const COUNTED = ["dockings", "days", "submissions", "activities", "photos", "jobs", "annotations", "audit", "daily_reports", "report_versions"] as const

export function backupDir(store: Store): string {
  return process.env.DOCKING_BACKUP_DIR || join(store.root, "backups")
}

function referencedFiles(db: DatabaseSync): { path: string; sha256: string }[] {
  return db.prepare(`SELECT stored_path AS path, sha256 FROM source_files
                     UNION SELECT stored_path AS path, sha256 FROM photos WHERE stored_path IS NOT NULL
                     UNION SELECT pdf_path AS path, pdf_sha256 AS sha256 FROM report_versions
                     ORDER BY path`).all() as { path: string; sha256: string }[]
}

function counts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(COUNTED.map((t) => [t, Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)]))
}

/** Make a snapshot. Returns its folder. Keeps the newest `keep` snapshots. */
export async function backupStore(store: Store, options: { dest?: string; keep?: number; now?: Date } = {}): Promise<string> {
  const dest = options.dest ?? backupDir(store)
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-")
  const folder = join(dest, stamp)
  if (existsSync(folder)) throw new Error(`A backup named ${stamp} already exists.`)
  mkdirSync(folder, { recursive: true })
  const dbCopy = join(folder, "docking.sqlite3")
  await backup(store.db, dbCopy)

  const snapshot = new DatabaseSync(dbCopy, { readOnly: true })
  let manifest: Manifest
  try {
    const check = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
    if (check.integrity_check !== "ok") throw new Error(`The database snapshot failed its integrity check: ${check.integrity_check}`)
    manifest = { schema: SCHEMA_VERSION, created_at: new Date().toISOString(), counts: counts(snapshot), files: referencedFiles(snapshot) }
  } finally {
    snapshot.close()
  }
  // Asynchronous file work: the daily backup runs inside the web server and must not hold up requests while it copies
  // thousands of photos (a docking holds about 3,000).
  for (const file of manifest.files) {
    const target = join(dest, "files", ...file.path.split("/"))
    if (existsSync(target) && sha256(await readFile(target)) === file.sha256) continue
    const source = join(store.root, ...file.path.split("/"))
    const data = await readFile(source)
    if (sha256(data) !== file.sha256) throw new Error(`Backup stopped: the stored file ${file.path} is damaged (hash mismatch).`)
    mkdirSync(dirname(target), { recursive: true })
    await copyFile(source, target)
  }
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest, null, 1))

  const keep = options.keep ?? 30
  const snapshots = readdirSync(dest).filter((n) => n !== "files" && existsSync(join(dest, n, "manifest.json"))).sort()
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - keep))) rmSync(join(dest, old), { recursive: true, force: true })
  return folder
}

/**
 * Restore a snapshot into an EMPTY data folder (it never overwrites a store), checking every file's hash and the
 * record counts. Returns the opened store; the caller closes it.
 */
export async function restoreStore(snapshot: string, targetRoot: string): Promise<{ store: Store; manifest: Manifest }> {
  if (existsSync(join(targetRoot, "docking.sqlite3"))) throw new Error("The target folder already holds a docking database; restore only into an empty folder.")
  const manifest = JSON.parse(readFileSync(join(snapshot, "manifest.json"), "utf8")) as Manifest
  if (manifest.schema > SCHEMA_VERSION) throw new Error(`This backup needs a newer NeraVeda (schema ${manifest.schema}).`)
  const filesRoot = join(dirname(snapshot), "files")
  for (const file of manifest.files) {
    const source = join(filesRoot, ...file.path.split("/"))
    if (!existsSync(source)) throw new Error(`Restore stopped: ${file.path} is missing from the backup.`)
    if (sha256(readFileSync(source)) !== file.sha256) throw new Error(`Restore stopped: ${file.path} in the backup is damaged (hash mismatch).`)
  }
  mkdirSync(targetRoot, { recursive: true })
  copyFileSync(join(snapshot, "docking.sqlite3"), join(targetRoot, "docking.sqlite3"))
  for (const file of manifest.files) {
    const target = join(targetRoot, ...file.path.split("/"))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(filesRoot, ...file.path.split("/")), target)
  }
  const store = await openStore(targetRoot)
  const restored = counts(store.db)
  for (const [table, n] of Object.entries(manifest.counts)) {
    if (restored[table] !== n) {
      closeStore(store)
      throw new Error(`Restore check failed: ${table} has ${restored[table]} records, the backup recorded ${n}.`)
    }
  }
  return { store, manifest }
}
