import "server-only"
import { randomUUID } from "node:crypto"
import { userInfo } from "node:os"
import { type Db, MongoClient } from "mongodb"
import { currentUser } from "./auth"
import { DIAGNOSTIC_COLLECTIONS, memoryDiagnostics, mongoDiagnostics } from "./diagnostics"
import { backupRoot, dailyBackup, type BackupSource } from "./mongo-backup"
import { applyDnsOverride } from "./dns-override"
import { StorageNotConfigured } from "./errors"
import type { Services } from "./service"
import { MemorySourceStore, MongoSourceStore, SOURCE_COLLECTIONS } from "./source-store"

// Three connection roles. Separate database users are recommended (see .env.example):
//   source-write  insert + find on the source collections (registration only)
//   source-read   find only on the source collections (viewer, validation)
//   diagnostics   read/write on diagnostic collections
// Without them, every role falls back to EMISSIONS_MONGODB_URI and the Integrity panel says protection is
// application-only.

type Role = "sourceWrite" | "sourceRead" | "diagnostics"

const ENV: Record<Role, string[]> = {
  sourceWrite: ["EMISSIONS_SOURCE_WRITE_URI", "EMISSIONS_MONGODB_URI"],
  sourceRead: ["EMISSIONS_SOURCE_READ_URI", "EMISSIONS_MONGODB_URI"],
  diagnostics: ["EMISSIONS_MONGODB_URI"],
}

function uriFor(role: Role): { uri: string; variable: string } | null {
  for (const variable of ENV[role]) {
    const uri = process.env[variable]
    if (uri) return { uri, variable }
  }
  return null
}

export function dbName(): string {
  const name = process.env.EMISSIONS_DB || "emissions"
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error("EMISSIONS_DB is not a valid database name.")
  return name
}

const globalForMongo = globalThis as unknown as { _emissionsClients?: Map<string, Promise<MongoClient>> }

function client(uri: string): Promise<MongoClient> {
  applyDnsOverride() // before the driver resolves mongodb+srv records
  globalForMongo._emissionsClients ??= new Map()
  let c = globalForMongo._emissionsClients.get(uri)
  if (!c) {
    c = new MongoClient(uri, { appName: "neraveda-emissions", serverSelectionTimeoutMS: 10_000 }).connect()
    c.catch(() => globalForMongo._emissionsClients?.delete(uri))
    globalForMongo._emissionsClients.set(uri, c)
  }
  return c
}

/** EMISSIONS_STORAGE=memory: temporary in-process storage for testing and demonstration. Nothing is persisted. */
export function memoryMode(): boolean {
  return process.env.EMISSIONS_STORAGE === "memory"
}

export function configured(): boolean {
  return memoryMode() || uriFor("diagnostics") !== null
}

function db(role: Role): () => Promise<Db> {
  return async () => {
    const found = uriFor(role)
    if (!found) throw new StorageNotConfigured()
    return (await client(found.uri)).db(dbName())
  }
}

/** The person signed in to NeraVeda for this request; the OS user only outside a request (scripts, tests). */
export function actor(): string {
  const user = currentUser()
  if (user && user.typ === "session") return user.sub
  try {
    return userInfo().username || "unknown"
  } catch {
    return "unknown"
  }
}

const globalForServices = globalThis as unknown as { _emissionsServices?: Services }

export function getServices(): Services {
  if (!memoryMode() && configured()) scheduleDailyBackup()
  globalForServices._emissionsServices ??= memoryMode()
    ? { sources: new MemorySourceStore(), db: memoryDiagnostics(), actor, now: () => new Date().toISOString(), id: () => randomUUID() }
    : {
        sources: new MongoSourceStore({ read: db("sourceRead"), write: db("sourceWrite"), diagnostics: db("diagnostics") }),
        db: mongoDiagnostics(db("diagnostics")),
        actor,
        now: () => new Date().toISOString(),
        id: () => randomUUID(),
      }
  return globalForServices._emissionsServices
}

// ── Daily backup (lib/server/mongo-backup.ts, audit item P1-1) ──────────────

/** The original source files are read with the read-only source role; everything else with the diagnostics role. */
const BACKUP_SOURCE_NAMES = [SOURCE_COLLECTIONS.artifacts, `${SOURCE_COLLECTIONS.bucket}.files`, `${SOURCE_COLLECTIONS.bucket}.chunks`]

export function emissionsBackupSource(): BackupSource {
  return {
    collections: async () => [...BACKUP_SOURCE_NAMES, SOURCE_COLLECTIONS.occurrences, ...Object.values(DIAGNOSTIC_COLLECTIONS)],
    documents: async function* (name) {
      const database = await db(BACKUP_SOURCE_NAMES.includes(name) ? "sourceRead" : "diagnostics")()
      yield* database.collection(name).find({}).sort({ _id: 1 })
    },
  }
}

const backupState = globalThis as unknown as { __emissionsBackupDay?: string }

/** The first time the storage is used each day, in the background. A failure is logged, never shown as lost data. */
function scheduleDailyBackup() {
  const today = new Date().toISOString().slice(0, 10)
  if (backupState.__emissionsBackupDay === today) return
  backupState.__emissionsBackupDay = today
  dailyBackup(emissionsBackupSource(), { dest: backupRoot("emissions"), database: dbName() })
    .then((folder) => folder && console.log(`[emissions] daily backup written: ${folder}`))
    .catch((error) => console.error("[emissions] daily backup failed:", error))
}

// ── Storage protection check ────────────────────────────────────────────────

const MODIFYING = ["update", "remove", "dropCollection", "dropDatabase", "renameCollectionSameDB", "collMod", "convertToCapped", "compact", "emptycapped"]
const SOURCE_NAMES = [SOURCE_COLLECTIONS.artifacts, `${SOURCE_COLLECTIONS.bucket}.files`, `${SOURCE_COLLECTIONS.bucket}.chunks`]

type Privilege = { resource?: { db?: string; collection?: string; cluster?: boolean; anyResource?: boolean }; actions?: string[] }

export type RoleCheck = Readonly<{ role: Role; variable: string | null; user: string | null; canModifySources: boolean | null; canInsertSources: boolean | null; error?: string }>

export type ProtectionStatus = Readonly<{
  configured: boolean
  mode: "database-enforced" | "application-only" | "unknown" | "memory"
  summary: string
  roles: readonly RoleCheck[]
}>

async function checkRole(role: Role): Promise<RoleCheck> {
  const found = uriFor(role)
  if (!found) return { role, variable: null, user: null, canModifySources: null, canInsertSources: null, error: "not configured" }
  try {
    const status = await (await client(found.uri)).db(dbName()).command({ connectionStatus: 1, showPrivileges: true })
    const users = (status.authInfo?.authenticatedUsers ?? []) as { user: string; db: string }[]
    if (users.length === 0) {
      // No authentication: the server enforces nothing.
      return { role, variable: found.variable, user: null, canModifySources: true, canInsertSources: true }
    }
    const privileges = (status.authInfo?.authenticatedUserPrivileges ?? []) as Privilege[]
    const name = dbName()
    const actions = new Set<string>()
    for (const p of privileges) {
      const r = p.resource ?? {}
      const applies = r.anyResource || ((r.db === "" || r.db === name) && (r.collection === "" || (r.collection !== undefined && SOURCE_NAMES.includes(r.collection))))
      if (applies) for (const a of p.actions ?? []) actions.add(a)
    }
    return {
      role, variable: found.variable, user: users.map((u) => `${u.user}@${u.db}`).join(", "),
      canModifySources: MODIFYING.some((a) => actions.has(a)), canInsertSources: actions.has("insert"),
    }
  } catch (error) {
    return { role, variable: found.variable, user: null, canModifySources: null, canInsertSources: null, error: error instanceof Error ? error.name : "error" }
  }
}

export async function protectionStatus(): Promise<ProtectionStatus> {
  if (memoryMode()) {
    return { configured: true, mode: "memory", summary: "TEST MODE: temporary in-memory storage (EMISSIONS_STORAGE=memory). Nothing is persisted; stopping the server clears all files and records. Do not use for real investigations.", roles: [] }
  }
  if (!configured()) {
    return { configured: false, mode: "unknown", summary: "Storage is not configured (EMISSIONS_MONGODB_URI is not set).", roles: [] }
  }
  const roles = await Promise.all((["sourceWrite", "sourceRead", "diagnostics"] as const).map(checkRole))
  if (roles.some((r) => r.canModifySources === null)) {
    return { configured: true, mode: "unknown", summary: "The database privileges could not be read, so the protection level is unknown.", roles }
  }
  const enforced = roles.every((r) => r.canModifySources === false) && roles.find((r) => r.role === "sourceRead")!.canInsertSources === false
  return {
    configured: true,
    mode: enforced ? "database-enforced" : "application-only",
    summary: enforced
      ? "Database-enforced: no configured database user can update or delete original files, and the reader cannot write."
      : "Application-only: a configured database user could change or delete original files. The application never does (insert-only code, SHA-256 verified before and after every run), but the database does not prevent it. Configure separate insert/find-only and find-only users to enforce it.",
    roles,
  }
}
