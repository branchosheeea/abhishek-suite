// Integration test of the MongoDB storage path (GridFS source store + diagnostic store).
// `npm run test:mongo` loads .env.local and uses EMISSIONS_TEST_MONGODB_URI, or else the app's own
// EMISSIONS_MONGODB_URI (same cluster). It works in a NEW database named emissions_it_<random> and drops only
// that database at the end; it never writes to the real "emissions" database. Synthetic data only.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"
import { MongoClient, type Db } from "mongodb"
import type { ValidationResult } from "../lib/engine/run"
import { mongoDiagnostics } from "../lib/server/diagnostics"
import { applyDnsOverride } from "../lib/server/dns-override"
import { createSession, registerSource, runSession, type Services, updateSession } from "../lib/server/service"
import { MongoSourceStore, sha256 } from "../lib/server/source-store"
import { baseRows, IMO, ovdlaBytes, toCsv } from "./helpers"

const uri = process.env.EMISSIONS_TEST_MONGODB_URI || process.env.EMISSIONS_MONGODB_URI
const dbName = `emissions_it_${randomUUID().slice(0, 8)}`
applyDnsOverride()

describe("MongoDB storage path", { skip: uri ? false : "set EMISSIONS_MONGODB_URI (or EMISSIONS_TEST_MONGODB_URI) to run" }, () => {
  let client: MongoClient
  let db: Db
  let s: Services

  before(async () => {
    client = await new MongoClient(uri!, { appName: "neraveda-emissions-it", serverSelectionTimeoutMS: 15_000 }).connect()
    db = client.db(dbName)
    const get = async () => db
    s = { sources: new MongoSourceStore({ read: get, write: get, diagnostics: get }), db: mongoDiagnostics(get), actor: () => "integration-test", now: () => new Date().toISOString(), id: () => randomUUID() }
  })

  after(async () => {
    if (db && db.databaseName.startsWith("emissions_it_")) await db.dropDatabase()
    await client?.close()
  })

  test("GridFS registration is byte-exact, verified on read, and never overwritten", async () => {
    const bytes = new TextEncoder().encode(toCsv(baseRows()))
    const first = await registerSource(s, bytes, "it_la.csv", "LA")
    assert.equal(first.created, true)
    assert.equal(first.artifact._id, sha256(bytes))
    const again = await registerSource(s, bytes, "it_la_copy.csv", "LA")
    assert.equal(again.created, false)
    assert.equal(again.artifact.filename, "it_la.csv")
    const { bytes: stored } = await s.sources.read(first.artifact._id)
    assert.ok(Buffer.from(stored).equals(Buffer.from(bytes)))
    assert.equal(await db.collection("source_artifacts").countDocuments(), 1)
    assert.equal(await db.collection("source_occurrences").countDocuments(), 2)
  })

  test("a full run stores a verified, reproducible result", async () => {
    const la = await registerSource(s, new TextEncoder().encode(toCsv(baseRows().map((r, i) => (i === 1 ? { ...r, LFO_ROB: "470" } : r)))), "it_la2.csv", "LA")
    const ovdla = await registerSource(s, ovdlaBytes(baseRows()), "it_ovdla.xlsx", "OVDLA")
    const session = await createSession(s, { vessel: "DHT COLT", imo: IMO, period: { from: "2025-01-01", to: "2025-12-31" } })
    await updateSession(s, session._id, { attach: { kind: "LA", sha256: la.artifact._id } })
    await updateSession(s, session._id, { attach: { kind: "OVDLA", sha256: ovdla.artifact._id } })
    const run = await runSession(s, session._id)
    assert.equal(run.state, "completed", run.error ?? "")
    const stored = await s.db.runs.get(run._id)
    assert.ok(stored!.integrity.before.every((c) => c.ok) && stored!.integrity.after.every((c) => c.ok))
    const result = JSON.parse(stored!.resultJson!) as ValidationResult
    assert.ok(result.findings.some((f) => f.ruleId === "D02"))
    const second = await runSession(s, session._id)
    assert.deepEqual(JSON.parse((await s.db.runs.get(second._id))!.resultJson!).findings, result.findings)
  })
})
