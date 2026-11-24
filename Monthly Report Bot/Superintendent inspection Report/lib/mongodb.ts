import "server-only"
import { MongoClient, type Db } from "mongodb"
import { backupRoot, dailyBackup, type BackupSource } from "./server/mongo-backup"

const globalForMongo = globalThis as unknown as { _mongoClient?: Promise<MongoClient>; __inspectionsBackupDay?: string }

function getClient() {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error("MONGODB_URI is not set")
  if (!globalForMongo._mongoClient) {
    globalForMongo._mongoClient = new MongoClient(uri, { appName: "sir-inspection" }).connect()
  }
  return globalForMongo._mongoClient
}

let indexesReady: Promise<unknown> | undefined

export async function getDb(): Promise<Db> {
  const db = (await getClient()).db("inspections")
  indexesReady ??= Promise.all([
    db.collection("reports").createIndex({ id: 1 }, { unique: true }),
    db.collection("reports").createIndex({ updatedAt: -1 }),
    db.collection("photos").createIndex({ id: 1 }, { unique: true }),
    db.collection("photos").createIndex({ reportId: 1 }),
    // Approved-report protection (lib/report-write.ts): audit trail, withdrawn approvals, deleted drafts.
    db.collection("report_audit").createIndex({ reportId: 1, at: 1 }),
    db.collection("report_revisions").createIndex({ reportId: 1, revision: 1 }, { unique: true }),
    db.collection("report_revision_photos").createIndex({ revisionId: 1 }),
    db.collection("reports_deleted").createIndex({ id: 1 }),
    db.collection("photos_deleted").createIndex({ reportId: 1 }),
  ]).catch(() => {
    indexesReady = undefined
  })
  await indexesReady
  scheduleDailyBackup(db)
  return db
}

/** Every collection of the inspections database, read in _id order. */
export function inspectionsBackupSource(db: Db): BackupSource {
  return {
    collections: async () =>
      (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((name) => !name.startsWith("system.")),
    documents: (name) => db.collection(name).find({}).sort({ _id: 1 }),
  }
}

/**
 * Daily backup of the inspection reports (lib/server/mongo-backup.ts): the first time the database is used each day,
 * in the background. A failure is logged, never shown as lost data; the next day (or server start) tries again.
 */
function scheduleDailyBackup(db: Db) {
  const today = new Date().toISOString().slice(0, 10)
  if (globalForMongo.__inspectionsBackupDay === today) return
  globalForMongo.__inspectionsBackupDay = today
  dailyBackup(inspectionsBackupSource(db), { dest: backupRoot("inspections"), database: "inspections" })
    .then((folder) => folder && console.log(`[inspections] daily backup written: ${folder}`))
    .catch((error) => console.error("[inspections] daily backup failed:", error))
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
