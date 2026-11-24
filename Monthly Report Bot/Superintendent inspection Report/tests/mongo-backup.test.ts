// Daily MongoDB backups (lib/server/mongo-backup.ts, audit item P1-1), with an in-memory database and temporary
// folders only: no MongoDB, no real data.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { Binary, ObjectId, type Document } from "mongodb"
import {
  backupDatabase,
  backupRoot,
  dailyBackup,
  latestBackupDay,
  restoreSnapshot,
  snapshots,
  verifySnapshot,
  type BackupSource,
  type RestoreTarget,
} from "../lib/server/mongo-backup"

const temp = mkdtempSync(join(tmpdir(), "neraveda-mongo-backup-"))
after(() => rmSync(temp, { recursive: true, force: true }))
let n = 0
const freshDest = () => join(temp, `dest-${++n}`)

/** An in-memory database that is both a backup source and a restore target. */
function memoryDb(initial: Record<string, Document[]> = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, [...v]]))
  const source: BackupSource = {
    collections: async () => [...data.keys()],
    documents: async function* (name) {
      for (const doc of data.get(name) ?? []) yield doc
    },
  }
  const target: RestoreTarget = {
    collections: async () => [...data.keys()],
    insert: async (name, docs) => void data.set(name, [...(data.get(name) ?? []), ...docs]),
    count: async (name) => data.get(name)?.length ?? 0,
  }
  return { data, source, target }
}

const reportId = new ObjectId("665f1c2b9d3e4a0012345678")
const chunk = new Binary(Buffer.from("%PDF-1.7 original bytes"))
const sample = () =>
  memoryDb({
    reports: [{ _id: reportId, id: "report00000001", updatedAt: 1_700_000_000_000, details: { vessel: "DHT LEOPARD" } }],
    photos: [
      { _id: new ObjectId("665f1c2b9d3e4a0012345679"), id: "photo1", reportId: "report00000001", dataUrl: "data:image/png;base64,AA==" },
      { _id: new ObjectId("665f1c2b9d3e4a001234567a"), id: "photo2", reportId: "report00000001", dataUrl: "data:image/png;base64,BB==" },
    ],
    "source_files.chunks": [{ _id: new ObjectId("665f1c2b9d3e4a001234567b"), n: 0, data: chunk }],
    report_audit: [{ _id: new ObjectId("665f1c2b9d3e4a001234567c"), action: "approve", at: new Date("2026-11-24T08:00:00Z") }],
  })

const DAY = new Date("2026-11-24T08:00:00Z")
const days = (d: number) => new Date(DAY.getTime() + d * 86_400_000)

describe("MongoDB daily backup", () => {
  test("a snapshot holds every document and restores exactly, types included", async () => {
    const dest = freshDest()
    const live = sample()
    const folder = await backupDatabase(live.source, { dest, database: "inspections", now: DAY })
    assert.deepEqual(verifySnapshot(folder), { photos: 2, report_audit: 1, reports: 1, "source_files.chunks": 1 })

    const restored = memoryDb()
    await restoreSnapshot(folder, restored.target)
    const report = restored.data.get("reports")![0]
    assert.ok(report._id instanceof ObjectId && report._id.equals(reportId), "ids stay ObjectIds")
    assert.deepEqual(report.details, { vessel: "DHT LEOPARD" })
    assert.ok(restored.data.get("report_audit")![0].at instanceof Date, "dates stay dates")
    const data = restored.data.get("source_files.chunks")![0].data as Binary
    assert.equal(Buffer.from(data.buffer).toString(), "%PDF-1.7 original bytes", "file chunks are byte-identical")
  })

  test("each document is stored once: later days add only what changed", async () => {
    const dest = freshDest()
    const live = sample()
    await backupDatabase(live.source, { dest, database: "inspections", now: DAY })
    const count = () => readdirSync(join(dest, "files")).flatMap((b) => readdirSync(join(dest, "files", b))).length
    assert.equal(count(), 5)
    await backupDatabase(live.source, { dest, database: "inspections", now: days(1) })
    assert.equal(count(), 5, "nothing changed, nothing added")
    live.data.get("reports")![0] = { ...live.data.get("reports")![0], updatedAt: 1_700_000_000_001 }
    await backupDatabase(live.source, { dest, database: "inspections", now: days(2) })
    assert.equal(count(), 6, "only the changed report is added")
  })

  test("once a day; the newest snapshots are kept and unreferenced documents removed", async () => {
    const dest = freshDest()
    const live = sample()
    assert.ok(await dailyBackup(live.source, { dest, database: "inspections", now: DAY }))
    assert.equal(await dailyBackup(live.source, { dest, database: "inspections", now: new Date(DAY.getTime() + 3_600_000) }), null)
    for (let d = 1; d <= 4; d++) {
      live.data.set("reports", [{ ...live.data.get("reports")![0], updatedAt: d }])
      await backupDatabase(live.source, { dest, database: "inspections", keep: 2, now: days(d) })
    }
    assert.deepEqual(snapshots(dest).map((s) => s.split(/[\\/]/).pop()!.slice(0, 10)), ["2026-11-27", "2026-11-28"])
    assert.equal(latestBackupDay(dest), "2026-11-28")
    const files = readdirSync(join(dest, "files")).flatMap((b) => readdirSync(join(dest, "files", b)))
    assert.equal(files.length, 4 + 2, "four unchanged documents plus the two kept versions of the report")
  })

  test("restore goes only into an empty database", async () => {
    const dest = freshDest()
    const folder = await backupDatabase(sample().source, { dest, database: "inspections", now: DAY })
    await assert.rejects(restoreSnapshot(folder, sample().target), /not empty/)
  })

  test("damage and missing documents are detected", async () => {
    const dest = freshDest()
    const folder = await backupDatabase(sample().source, { dest, database: "inspections", now: DAY })
    const bucket = readdirSync(join(dest, "files"))[0]
    const file = readdirSync(join(dest, "files", bucket))[0]
    writeFileSync(join(dest, "files", bucket, file), readFileSync(join(dest, "files", bucket, file)).subarray(0, 0))
    assert.throws(() => verifySnapshot(folder))
    rmSync(join(dest, "files", bucket, file))
    assert.throws(() => verifySnapshot(folder), /missing/)
  })

  test("an interrupted backup is never taken as a good one, and is cleared by the next", async () => {
    const dest = freshDest()
    mkdirSync(join(dest, "2026-11-23T08-00-00-000Z.partial"), { recursive: true })
    assert.equal(latestBackupDay(dest), "")
    await backupDatabase(sample().source, { dest, database: "inspections", now: DAY })
    assert.equal(existsSync(join(dest, "2026-11-23T08-00-00-000Z.partial")), false)
  })

  test("backups go to NERAVEDA_BACKUP_DIR when set, else the suite data folder on this PC", () => {
    const saved = { dir: process.env.NERAVEDA_BACKUP_DIR, data: process.env.ABHISHEK_SUITE_DATA }
    try {
      process.env.NERAVEDA_BACKUP_DIR = join(temp, "elsewhere")
      assert.equal(backupRoot("inspections"), join(temp, "elsewhere", "inspections-daily"))
      delete process.env.NERAVEDA_BACKUP_DIR
      process.env.ABHISHEK_SUITE_DATA = join(temp, "suite")
      assert.equal(backupRoot("emissions"), join(temp, "suite", "backups", "emissions-daily"))
    } finally {
      for (const [key, value] of [["NERAVEDA_BACKUP_DIR", saved.dir], ["ABHISHEK_SUITE_DATA", saved.data]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test("the Emissions Validation app holds an identical copy of this engine", () => {
    const here = readFileSync(join(import.meta.dirname, "..", "lib", "server", "mongo-backup.ts"), "utf8")
    const there = join(import.meta.dirname, "..", "..", "Emission Correction Assitant", "lib", "server", "mongo-backup.ts")
    assert.ok(existsSync(there), "Emission Correction Assitant/lib/server/mongo-backup.ts exists")
    assert.equal(readFileSync(there, "utf8").replace(/\r\n/g, "\n"), here.replace(/\r\n/g, "\n"))
  })
})
