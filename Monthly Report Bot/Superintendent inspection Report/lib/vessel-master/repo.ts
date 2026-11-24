// Vessel Master · MongoDB storage in the `inspections` database (shared by every PC, covered by the daily backup).
// The only code that writes master records: imports (import.ts) and recorded corrections. No Next.js or server-only
// imports, so the admin script can use it too.
//   vessels                   one record per vessel (current values, per-field status and provenance)
//   vessel_master_revisions   every change, field by field, with who, when and why (append-only)
//   vessel_master_imports     each committed import: workbook hash, preview, counts, refused rows (append-only)
//   vessel_master_sources     Source_Register rows, as last imported
//   vessel_master_issues      Data_Quality and Physical_Verification rows, as last imported
//   vessel_master_flags       "Report master data issue" entries from the SIR (append-only; status kept per entry)
//   vessel_master_verifications  "Verify on board" records with their evidence (append-only)

import type { ClientSession, Db, MongoClient } from "mongodb"
import { AppError } from "../server/errors"
import type { ImportRecord, MasterStore, MasterTx, Revision, StoredVessel } from "./import"
import type { verificationFrom } from "./verify"

export const COLLECTIONS = {
  vessels: "vessels", revisions: "vessel_master_revisions", imports: "vessel_master_imports",
  sources: "vessel_master_sources", issues: "vessel_master_issues", flags: "vessel_master_flags",
  verifications: "vessel_master_verifications",
} as const

export async function ensureVesselIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection(COLLECTIONS.vessels).createIndex({ vesselId: 1 }, { unique: true }),
    db.collection(COLLECTIONS.vessels).createIndex({ workbookId: 1 }, { unique: true, partialFilterExpression: { workbookId: { $type: "string" } } }),
    db.collection(COLLECTIONS.vessels).createIndex({ imo: 1 }, { unique: true, partialFilterExpression: { imo: { $type: "string" } } }),
    db.collection(COLLECTIONS.revisions).createIndex({ vesselId: 1, revision: 1 }, { unique: true }),
    db.collection(COLLECTIONS.imports).createIndex({ sha256: 1 }, { unique: true, partialFilterExpression: { outcome: "committed" } }),
    db.collection(COLLECTIONS.sources).createIndex({ key: 1 }, { unique: true }),
    db.collection(COLLECTIONS.issues).createIndex({ key: 1 }, { unique: true }),
    db.collection(COLLECTIONS.flags).createIndex({ vesselId: 1, at: -1 }),
    db.collection(COLLECTIONS.verifications).createIndex({ vesselId: 1, at: -1 }),
  ])
}

const NO_ID = { projection: { _id: 0 } }

/** Imports need multi-document transactions: refused on a server that cannot provide them (not a replica set). */
export async function requireTransactions(db: Db): Promise<void> {
  const hello = await db.admin().command({ hello: 1 })
  if (!hello.setName && hello.msg !== "isdbgrid") {
    throw new Error("This MongoDB server does not support transactions (not a replica set), so the Vessel Master import cannot run safely.")
  }
}

export function mongoMasterStore(client: MongoClient, db: Db): MasterStore {
  const vessels = db.collection<StoredVessel>(COLLECTIONS.vessels)
  const txFor = (session: ClientSession): MasterTx => ({
    listVessels: () => vessels.find({}, { ...NO_ID, session }).toArray() as Promise<StoredVessel[]>,
    insertVessel: async (doc) => void (await vessels.insertOne({ ...doc }, { session })),
    replaceVessel: async (doc, expectedRevision) => (await vessels.replaceOne({ vesselId: doc.vesselId, revision: expectedRevision }, doc, { session })).matchedCount === 1,
    insertRevision: async (revision: Revision) => void (await db.collection(COLLECTIONS.revisions).insertOne({ ...revision }, { session })),
    upsertReference: async (collection, key, doc) => void (await db.collection(COLLECTIONS[collection]).replaceOne({ key }, { ...doc, key }, { upsert: true, session })),
    insertImport: async (record: ImportRecord) => void (await db.collection(COLLECTIONS.imports).insertOne({ ...record }, { session })),
  })
  return {
    listVessels: () => vessels.find({}, NO_ID).toArray() as Promise<StoredVessel[]>,
    async transaction(fn) {
      await requireTransactions(db)
      const session = client.startSession()
      try {
        let result: Awaited<ReturnType<typeof fn>> | undefined
        await session.withTransaction(async () => {
          result = await fn(txFor(session))
        })
        return result as Awaited<ReturnType<typeof fn>>
      } finally {
        await session.endSession()
      }
    },
  }
}

// ── Reads for the SIR and the review page ────────────────────────────────────

export async function listVessels(db: Db): Promise<StoredVessel[]> {
  return db.collection<StoredVessel>(COLLECTIONS.vessels).find({}, NO_ID).sort({ name: 1 }).toArray() as Promise<StoredVessel[]>
}

export async function getVessel(db: Db, vesselId: string): Promise<StoredVessel | null> {
  return (await db.collection<StoredVessel>(COLLECTIONS.vessels).findOne({ vesselId }, NO_ID)) as StoredVessel | null
}

export async function revisionsOf(db: Db, vesselId: string) {
  return db.collection(COLLECTIONS.revisions).find({ vesselId }, NO_ID).sort({ revision: -1 }).limit(50).toArray()
}

export async function referenceRows(db: Db, workbookId: string | null) {
  const filter = { "Vessel ID": { $in: workbookId ? [workbookId, "ALL"] : ["ALL"] } }
  const [sources, issues] = await Promise.all([
    db.collection(COLLECTIONS.sources).find(filter, NO_ID).toArray(),
    db.collection(COLLECTIONS.issues).find(filter, NO_ID).toArray(),
  ])
  return { sources, issues }
}

// ── Correction flags ("Report master data issue") ────────────────────────────

export type Flag = {
  flagId: string; vesselId: string; vesselName: string; field: string; currentValue: string; proposedValue: string
  reason: string; source: string; reporter: string; reporterName: string; reportId: string | null; at: string
  status: "open" | "accepted" | "rejected"
}

export async function insertFlag(db: Db, flag: Flag): Promise<void> {
  await db.collection(COLLECTIONS.flags).insertOne({ ...flag })
}

export async function flagsOf(db: Db, vesselId?: string) {
  return db.collection(COLLECTIONS.flags).find(vesselId ? { vesselId } : {}, NO_ID).sort({ at: -1 }).limit(200).toArray()
}

// ── Verification on board (lib/vessel-master/verify.ts) ─────────────────────

/**
 * Applies one verification in a transaction: the vessel as stored now is checked by `build` (which throws if the
 * verification is not allowed), then the record, its revision and the verification are written together. A vessel
 * changed meanwhile (another verification, an import) is refused with 409, so nothing is written from a stale copy.
 */
export async function verifyField(client: MongoClient, db: Db, vesselId: string, build: (vessel: StoredVessel) => ReturnType<typeof verificationFrom>) {
  await requireTransactions(db)
  const vessels = db.collection<StoredVessel>(COLLECTIONS.vessels)
  const session = client.startSession()
  try {
    let result: ReturnType<typeof verificationFrom> | undefined
    await session.withTransaction(async () => {
      const vessel = (await vessels.findOne({ vesselId }, { ...NO_ID, session })) as StoredVessel | null
      if (!vessel) throw new AppError(404, "This vessel is not in the Vessel Master.")
      result = build(vessel)
      const { matchedCount } = await vessels.replaceOne({ vesselId, revision: vessel.revision }, result.doc, { session })
      if (matchedCount !== 1) throw new AppError(409, "The vessel was changed at the same moment. Try again.")
      await db.collection(COLLECTIONS.revisions).insertOne({ ...result.revision, verificationId: result.verification.verificationId }, { session })
      await db.collection(COLLECTIONS.verifications).insertOne({ ...result.verification }, { session })
    })
    return result!
  } finally {
    await session.endSession()
  }
}

export async function verificationsOf(db: Db, vesselId: string) {
  return db.collection(COLLECTIONS.verifications).find({ vesselId }, NO_ID).sort({ at: -1 }).limit(200).toArray()
}
