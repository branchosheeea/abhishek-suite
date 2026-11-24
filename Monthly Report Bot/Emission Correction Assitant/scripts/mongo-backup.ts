// Backups of the emissions database (lib/server/mongo-backup.ts). The server takes them daily by itself; this script
// lists them, checks one, or restores one into a NEW, empty database for inspection or recovery.
//
//   npm run backup -- list
//   npm run backup -- verify <snapshot folder>
//   npm run backup -- restore <snapshot folder> <new database name>
//
// Uses EMISSIONS_MONGODB_URI and EMISSIONS_DNS_SERVERS (from the environment or .env.local); the database user needs
// the right to create the new database. A restore never writes to the live database: to use restored data, check it
// first, then switch EMISSIONS_DB over deliberately. A backup now is taken by opening the workspace (once a day).

import { MongoClient } from "mongodb"
import { applyDnsOverride } from "../lib/server/dns-override"
import { backupRoot, restoreSnapshot, snapshots, verifySnapshot } from "../lib/server/mongo-backup"

const LIVE = process.env.EMISSIONS_DB || "emissions"
const [command = "list", ...args] = process.argv.slice(2)
const dest = backupRoot("emissions")

async function main() {
  if (command === "list") {
    for (const folder of snapshots(dest)) console.log(folder)
    if (!snapshots(dest).length) console.log(`No backups yet in ${dest}.`)
  } else if (command === "verify" && args.length === 1) {
    const counts = verifySnapshot(args[0])
    console.log(`OK: ${Object.values(counts).reduce((a, b) => a + b, 0)} documents checked.`, counts)
  } else if (command === "restore" && args.length === 2) {
    const [folder, target] = args
    if (target === LIVE) throw new Error(`Refusing to restore into the live "${LIVE}" database. Give a new database name.`)
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(target)) throw new Error("The database name may use letters, digits, _ and - only.")
    const uri = process.env.EMISSIONS_MONGODB_URI
    if (!uri) throw new Error("EMISSIONS_MONGODB_URI is not set (environment or .env.local).")
    applyDnsOverride()
    const client = await new MongoClient(uri, { appName: "neraveda-emissions-backup" }).connect()
    try {
      const db = client.db(target)
      const counts = await restoreSnapshot(folder, {
        collections: async () => (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
        insert: async (name, docs) => void (await db.collection(name).insertMany(docs, { ordered: true })),
        count: (name) => db.collection(name).countDocuments(),
      })
      console.log(`Restored into the database "${target}" and checked:`, counts)
    } finally {
      await client.close()
    }
  } else {
    console.log("Usage: npm run backup -- list | verify <snapshot> | restore <snapshot> <new database name>")
    process.exitCode = 2
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
