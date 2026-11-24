// Backups of the inspections database (lib/server/mongo-backup.ts). The server takes them daily by itself; this script
// lists them, checks one, takes one now, or restores one into a NEW, empty database for inspection or recovery.
//
//   npm run backup -- list
//   npm run backup -- verify <snapshot folder>
//   npm run backup -- run
//   npm run backup -- restore <snapshot folder> <new database name>
//
// Uses MONGODB_URI (from the environment or .env.local). A restore never writes to the live "inspections" database: to
// use restored data, check it first, then switch the app over deliberately.

import { MongoClient } from "mongodb"
import { backupDatabase, backupRoot, restoreSnapshot, snapshots, verifySnapshot } from "../lib/server/mongo-backup"

const LIVE = "inspections"
const [command = "list", ...args] = process.argv.slice(2)
const dest = backupRoot(LIVE)

async function withDb<T>(name: string, fn: (db: ReturnType<MongoClient["db"]>) => Promise<T>): Promise<T> {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error("MONGODB_URI is not set (environment or .env.local).")
  const client = await new MongoClient(uri, { appName: "sir-backup" }).connect()
  try {
    return await fn(client.db(name))
  } finally {
    await client.close()
  }
}

async function main() {
  if (command === "list") {
    for (const folder of snapshots(dest)) console.log(folder)
    if (!snapshots(dest).length) console.log(`No backups yet in ${dest}.`)
  } else if (command === "verify" && args.length === 1) {
    const counts = verifySnapshot(args[0])
    console.log(`OK: ${Object.values(counts).reduce((a, b) => a + b, 0)} documents checked.`, counts)
  } else if (command === "run") {
    const folder = await withDb(LIVE, (db) =>
      backupDatabase(
        {
          collections: async () => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system.")),
          documents: (name) => db.collection(name).find({}).sort({ _id: 1 }),
        },
        { dest, database: LIVE },
      ),
    )
    console.log(`Backup written: ${folder}`)
  } else if (command === "restore" && args.length === 2) {
    const [folder, target] = args
    if (target === LIVE) throw new Error(`Refusing to restore into the live "${LIVE}" database. Give a new database name.`)
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(target)) throw new Error("The database name may use letters, digits, _ and - only.")
    const counts = await withDb(target, (db) =>
      restoreSnapshot(folder, {
        collections: async () => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
        insert: async (name, docs) => void (await db.collection(name).insertMany(docs, { ordered: true })),
        count: (name) => db.collection(name).countDocuments(),
      }),
    )
    console.log(`Restored into the database "${target}" and checked:`, counts)
  } else {
    console.log("Usage: npm run backup -- list | verify <snapshot> | run | restore <snapshot> <new database name>")
    process.exitCode = 2
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
