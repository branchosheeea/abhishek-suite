import "server-only"
import { MongoClient, type Db } from "mongodb"

const globalForMongo = globalThis as unknown as { _mongoClient?: Promise<MongoClient> }

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
  ]).catch(() => {
    indexesReady = undefined
  })
  await indexesReady
  return db
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/
