import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import type { ValidationResult } from "../lib/engine/run"
import { buildJsonReport, buildXlsxReport, REPORT_BANNER, reportFilename } from "../lib/export/report"
import { zip } from "../lib/export/xlsx-writer"
import { parseXlsx } from "../lib/parsers/xlsx"
import { readZipDirectory, readZipEntry } from "../lib/parsers/zip"
import { memoryDiagnostics } from "../lib/server/diagnostics"
import { guard, readBody } from "../lib/server/http"
import {
  addDnv, addDnvBatch, addNote, createSession, investigation, listDnv, registerSource, runSession, type Services, setFindingStatus, updateDnv, updateSession,
} from "../lib/server/service"
import { MemorySourceStore, sha256 } from "../lib/server/source-store"
import { baseRows, brTable, IMO, ovdlaBytes, toCsv, BR_HEADERS } from "./helpers"

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")

function services(): Services & { sources: MemorySourceStore } {
  let n = 0
  return {
    sources: new MemorySourceStore(),
    db: memoryDiagnostics(),
    actor: () => "tester",
    now: () => `2026-11-18T00:00:${String(n % 60).padStart(2, "0")}Z`,
    id: () => `id-${String(++n).padStart(6, "0")}`,
  }
}

const enc = (s: string) => new TextEncoder().encode(s)
const blobs = (store: MemorySourceStore) => (store as unknown as { blobs: Map<string, Uint8Array> }).blobs

async function sessionWithSources(s: Services) {
  const laRows = baseRows().map((r, i) => (i === 1 ? { ...r, LFO_ROB: "470" } : r))
  const la = await registerSource(s, enc(toCsv(laRows)), "DHT_TEST_LA.csv", "LA")
  const ovdla = await registerSource(s, ovdlaBytes(baseRows().slice(0, 3)), "OVDLA.xlsx", "OVDLA")
  const br = await registerSource(s, enc(toCsv([{ IMO, Date_UTC: "2025-03-05", Time_UTC: "10:00", Fuel_Type: "LFO", Mass_Mt: "50", BDN_Number: "X1", Port: "NLRTM" }], BR_HEADERS)), "BR.csv", "BR")
  const session = await createSession(s, { vessel: "DHT COLT", imo: IMO, period: { from: "2025-01-01", to: "2025-12-31" } })
  for (const [kind, r] of [["LA", la], ["OVDLA", ovdla], ["BR", br]] as const) await updateSession(s, session._id, { attach: { kind, sha256: r.artifact._id } })
  return { session, la, ovdla, br }
}

describe("source registration (initial ingestion is the only write to originals)", () => {
  test("registers exact bytes under their SHA-256; identical bytes never overwrite; a different kind is refused", async () => {
    const s = services()
    const bytes = enc(toCsv(baseRows()))
    const first = await registerSource(s, bytes, "la.csv", "LA")
    assert.equal(first.created, true)
    assert.equal(first.artifact._id, sha256(bytes))
    const again = await registerSource(s, new Uint8Array(bytes), "la-copy.csv", "LA")
    assert.equal(again.created, false)
    assert.equal(again.artifact.filename, "la.csv") // the original record stands
    assert.deepEqual(s.sources.occurrences.map((o) => o.outcome), ["registered", "duplicate"])
    await assert.rejects(registerSource(s, bytes, "la.csv", "BR"), /already registered as LA/)
    const stored = await s.sources.read(first.artifact._id)
    assert.ok(Buffer.from(stored.bytes).equals(Buffer.from(bytes)))
  })

  test("unsafe or malformed files are rejected BEFORE anything is stored", async () => {
    const s = services()
    const macro = zip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "xl/vbaProject.bin", data: Buffer.from("x") },
    ])
    await assert.rejects(registerSource(s, macro, "o.xlsx", "OVDLA"), /macros/)
    await assert.rejects(registerSource(s, enc("A,B\n1,2\n"), "la.xlsx", "LA"), /\.csv/)
    await assert.rejects(registerSource(s, enc("%PDF-1.4"), "la.csv", "LA"), /PDF/)
    assert.equal((await s.sources.list()).length, 0)
  })
})

describe("validation runs: integrity verified before and after, sources unchanged", () => {
  test("a run verifies every source, stores a reproducible result and leaves the bytes identical", async () => {
    const s = services()
    const { session } = await sessionWithSources(s)
    const before = new Map([...blobs(s.sources)].map(([k, v]) => [k, sha256(v)]))
    const run = await runSession(s, session._id)
    assert.equal(run.state, "completed")
    assert.equal(run.integrity.before.length, 3)
    assert.ok(run.integrity.before.every((c) => c.ok) && run.integrity.after.every((c) => c.ok))
    for (const [id, hash] of before) assert.equal(sha256(blobs(s.sources).get(id)!), hash)
    for (const [id, hash] of before) assert.equal(id, hash) // id IS the hash of the stored bytes
    const result = JSON.parse(run.resultJson!) as ValidationResult
    assert.ok(result.findings.some((f) => f.ruleId === "D02"))
    assert.equal(result.reconciliation!.counts.submittedOnly, 1)
    const second = await runSession(s, session._id)
    const a = JSON.parse(run.resultJson!)
    const b = JSON.parse(second.resultJson!)
    assert.deepEqual(a, b) // identical inputs + rule versions + configuration → identical results
  })

  test("storage corruption stops the run, withholds results and is audited; nothing is 'repaired'", async () => {
    const s = services()
    const { session, la } = await sessionWithSources(s)
    blobs(s.sources).get(la.artifact._id)![0] ^= 0xff // simulate tampering outside the application
    const run = await runSession(s, session._id)
    assert.equal(run.state, "integrity-failed")
    assert.equal(run.resultJson, null)
    assert.match(run.error!, /Integrity check failed/)
    const audit = await s.db.audit.find({ sessionId: session._id })
    assert.ok(audit.some((e) => e.action === "run.integrity-failed"))
    assert.notEqual(sha256(blobs(s.sources).get(la.artifact._id)!), la.artifact._id) // still corrupted: not silently fixed
  })

  test("exclusions apply to one record of an attached source and are carried into the run", async () => {
    const s = services()
    const { session, la } = await sessionWithSources(s)
    await assert.rejects(updateSession(s, session._id, { exclude: { sha256: "f".repeat(64), line: 2, reason: "x" } }), /attached to this session/)
    await updateSession(s, session._id, { exclude: { sha256: la.artifact._id, line: 3, reason: "DNV template record" } })
    const run = await runSession(s, session._id)
    assert.deepEqual(run.exclusions, [{ sha256: la.artifact._id, line: 3, reason: "DNV template record" }])
    const result = JSON.parse(run.resultJson!) as ValidationResult
    assert.ok(result.exclusions[0].found)
  })
})

describe("DNV entries and investigation records", () => {
  test("screenshot transcriptions stay unconfirmed until confirmed; DNV items are never auto-confirmed as reproduced", async () => {
    const s = services()
    const { session } = await sessionWithSources(s)
    const d = await addDnv(s, session._id, { category: "FUEL_AVAILABLE", severity: "error", description: "LFO available vs consumed", fromUtc: "2025-03-02T06:00Z", toUtc: "2025-03-03T06:00Z", fuel: "lfo", entryMethod: "screenshot" })
    assert.equal(d.confirmed, false)
    assert.equal(d.fuel, "LFO")
    let result = JSON.parse((await runSession(s, session._id)).resultJson!) as ValidationResult
    assert.equal(result.correlations[0].evidenceConfirmed, false)
    await updateDnv(s, session._id, d.id, { action: "confirm" })
    result = JSON.parse((await runSession(s, session._id)).resultJson!) as ValidationResult
    assert.equal(result.correlations[0].evidenceConfirmed, true)
    assert.equal(result.correlations[0].outcome, "independently-reproduced")
    await assert.rejects(addDnv(s, session._id, { category: "NOPE", severity: "error", description: "x" }), /Unknown DNV category/)
  })

  test("an OVD Admin item keeps its event time and segment; a non-UTC event time is refused", async () => {
    const s = services()
    const { session } = await sessionWithSources(s)
    const d = await addDnv(s, session._id, { category: "MANEUVERING_IN_PORT", severity: "warning", description: "Distance in port without maneuvering time", eventUtc: "2025-03-04T06:00Z", voyageOrPortStay: "InPort" })
    assert.equal(d.eventUtc, "2025-03-04T06:00Z")
    assert.equal(d.voyageOrPortStay, "InPort")
    await assert.rejects(addDnv(s, session._id, { category: "SEA_PASSAGE", severity: "error", description: "x", eventUtc: "04/03/2025 06:00" }), /Event time must be a UTC date-time/)
  })

  test("items read from a screenshot are added together, keep their evidence, and one invalid item stores none", async () => {
    const s = services()
    const { session } = await sessionWithSources(s)
    const evidence = { sha256: "b".repeat(64), name: "ovd-admin.png", reader: "local OCR" }
    const item = { category: "DURATION", severity: "warning", description: "Reported duration …", eventUtc: "2025-03-03T06:00Z", entryMethod: "screenshot", confirmed: false, evidence }
    await assert.rejects(addDnvBatch(s, session._id, [item, { ...item, eventUtc: "yesterday" }]), /Entry 2: Event time/)
    assert.equal((await listDnv(s, session._id)).length, 0)
    await assert.rejects(addDnvBatch(s, session._id, [{ ...item, evidence: { ...evidence, sha256: "not-a-hash" } }]), /evidence\.sha256/)
    const res = await addDnvBatch(s, session._id, [item, { ...item, category: "SEA_PASSAGE", severity: "error", eventUtc: "2025-03-02T06:00Z" }])
    assert.equal(res.added, 2)
    const stored = await listDnv(s, session._id)
    assert.deepEqual(stored.map((d) => [d.category, d.confirmed, d.evidence?.name]), [["DURATION", false, "ovd-admin.png"], ["SEA_PASSAGE", false, "ovd-admin.png"]])
    await assert.rejects(addDnvBatch(s, session._id, []), /non-empty/)
  })

  test("statuses are validated and keep history; notes and links are append-only", async () => {
    const s = services()
    const { session } = await sessionWithSources(s)
    const result = JSON.parse((await runSession(s, session._id)).resultJson!) as ValidationResult
    const f = result.findings[0]
    await assert.rejects(setFindingStatus(s, session._id, f.id, "Fixed"), /status must be one of/)
    await setFindingStatus(s, session._id, f.id, "Under Investigation")
    await setFindingStatus(s, session._id, f.id, "Awaiting Vessel Clarification")
    await addNote(s, session._id, { findingId: f.id, text: "Asked the vessel for the ORB extract." })
    const inv = await investigation(s, session._id)
    assert.deepEqual(inv.history.map((h) => `${h.from}→${h.to}`), ["null→Under Investigation", "Under Investigation→Awaiting Vessel Clarification"])
    await assert.rejects(s.db.notes.update(inv.notes[0]._id, { text: "changed" }), /append-only/)
    await assert.rejects(s.db.audit.update("x", {}), /append-only/)
  })
})

describe("diagnostic reports", () => {
  test("every sheet carries the banner, cells cannot execute as formulas, and the name is not an OVD file name", async () => {
    const s = services()
    const { session } = await sessionWithSources(s)
    const run = await runSession(s, session._id)
    const result = JSON.parse(run.resultJson!) as ValidationResult
    const input = {
      session: (await s.db.sessions.get(session._id))!, run, result,
      artifacts: await s.sources.list(), dnv: [], investigation: await investigation(s, session._id),
      storageProtection: "Application-only (test)", generatedAt: "2026-11-18T00:00:00Z", generatedBy: "tester",
    }
    const xlsx = buildXlsxReport(input)
    const entries = readZipDirectory(xlsx)
    const sheets = entries.filter((e) => e.name.startsWith("xl/worksheets/"))
    assert.ok(sheets.length >= 8)
    for (const sheet of sheets) assert.ok(readZipEntry(xlsx, sheet).toString("utf8").includes(REPORT_BANNER), sheet.name)
    // Negative residuals such as "-7.25" are formula-like text: written as inline strings with quotePrefix style, never <f>.
    const all = sheets.map((e) => readZipEntry(xlsx, e).toString("utf8")).join("")
    assert.ok(!/<f>/.test(all))
    assert.match(all, /<c r="[A-Z]+\d+" t="inlineStr" s="1"><is><t xml:space="preserve">-7\.25<\/t>/)
    // Our own reader can open it (round trip) and sees the banner first.
    const parsed = parseXlsx(xlsx, "OVDLA", sha256(xlsx), "r.xlsx", "Findings")
    assert.equal(parsed.headers[0], REPORT_BANNER)
    const json = buildJsonReport(input)
    assert.equal(json.banner, REPORT_BANNER)
    assert.ok(json.sources.every((x) => x.integrityBefore === true && x.integrityAfter === true))
    assert.ok(json.knownLimitations.some((l) => /not.*DNV tolerances/i.test(l)))
    const name = reportFilename(input.session, run, "xlsx")
    assert.match(name, /^NERAVEDA-DIAGNOSTIC_DHT-COLT_2025-01-01_2025-12-31_run-/)
    assert.ok(!/\.csv$/.test(name))
  })
})

describe("request guard", () => {
  const req = (headers: Record<string, string>, method = "POST") => new Request("http://localhost:3001/api/x", { method, headers })
  test("only this computer, same origin, with the CSRF header on writes", () => {
    assert.doesNotThrow(() => guard(req({ host: "localhost:3001", "x-neraveda-request": "1", "sec-fetch-site": "same-origin", origin: "http://localhost:3001" }), true))
    assert.throws(() => guard(req({ host: "evil.example:3001", "x-neraveda-request": "1" }), true), /this computer/)
    assert.throws(() => guard(req({ host: "localhost:3001", "x-neraveda-request": "1", "sec-fetch-site": "cross-site" }), true), /Cross-site/)
    assert.throws(() => guard(req({ host: "localhost:3001", "x-neraveda-request": "1", origin: "https://evil.example" }), true), /Cross-origin/)
    assert.throws(() => guard(req({ host: "localhost:3001" }), true), /Missing request header/)
    assert.doesNotThrow(() => guard(req({ host: "127.0.0.1:3001" }, "GET"), false))
  })

  test("bodies are capped without trusting Content-Length", async () => {
    const big = new Request("http://localhost:3001/api/x", { method: "POST", body: new Uint8Array(2048) })
    await assert.rejects(readBody(big, 1024), /too large/)
    const ok = new Request("http://localhost:3001/api/x", { method: "POST", body: new Uint8Array(10) })
    assert.equal((await readBody(ok, 1024)).length, 10)
  })
})

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "reference" || name === "tests") continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(path)
  }
  return out
}

describe("static guarantees: no source write-back path exists", () => {
  const files = walk(ROOT)
  const read = (p: string) => readFileSync(p, "utf8")

  test("no API route under /api/sources can update or delete, and no route deletes anything", () => {
    const routes = files.filter((p) => /[\\/]app[\\/]api[\\/].*route\.ts$/.test(p))
    assert.ok(routes.length >= 10)
    for (const p of routes) {
      const text = read(p)
      assert.ok(!/export\s+(const|async function|function)\s+DELETE\b/.test(text), `${relative(ROOT, p)} exports DELETE`)
      if (/[\\/]api[\\/]sources[\\/]/.test(p)) assert.ok(!/export\s+(const|async function|function)\s+(PUT|PATCH)\b/.test(text), `${relative(ROOT, p)} exports a write method`)
    }
  })

  test("the source store has no update, replace, rename or delete operation", () => {
    const text = read(join(ROOT, "lib", "server", "source-store.ts"))
    assert.ok(!/\.(updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|findOneAndReplace|findOneAndDelete|bulkWrite|drop|dropDatabase|rename|delete)\s*\(/.test(text))
  })

  test("diagnostic, export and API code never addresses the source collections directly", () => {
    for (const p of files) {
      if (p.endsWith(join("server", "source-store.ts")) || p.endsWith(join("server", "runtime.ts"))) continue
      const text = read(p)
      assert.ok(!/["'`]source_(artifacts|files)/.test(text), `${relative(ROOT, p)} names a source collection`)
    }
  })

  test("no code writes to the file system (reports are streamed, never saved next to originals)", () => {
    for (const p of files) {
      const text = read(p)
      assert.ok(!/\b(writeFile|writeFileSync|appendFile|createWriteStream|renameSync|unlinkSync|rmSync|copyFile)\b/.test(text), `${relative(ROOT, p)} writes files`)
    }
  })

  test("screenshots are read locally: the OCR model is a local path, never a URL, and no AI/HTTP client is used", () => {
    const ocr = read(join(ROOT, "lib", "server", "ocr.ts"))
    assert.match(ocr, /langPath,/)
    assert.match(ocr, /cacheMethod: "none"/)
    assert.ok(!/https?:\/\//.test(ocr), "ocr.ts names a URL")
    for (const p of files.filter((f) => /[\\/](lib[\\/](ocr|server)|components)[\\/]/.test(f))) {
      const text = read(p)
      assert.ok(!/\b(fetch|request)\s*\(\s*["'`]https?:/.test(text) && !/anthropic|openai|generativelanguage|vision\.googleapis/i.test(text), `${relative(ROOT, p)} contacts an external service`)
    }
  })

  test("the BR table helper is used (sanity) and fixtures contain no real vessel data", () => {
    assert.equal(brTable([]).rows.length, 0)
    assert.ok(!read(join(ROOT, "tests", "helpers.ts")).includes("DHT COLT"))
  })
})
