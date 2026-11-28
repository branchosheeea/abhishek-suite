// Guarantee Claim Manager · the bridge to the Python claim helper: replies, safe errors, time limits, restarts after
// a crash, the restart guard, no secrets passed on, and the "gc" right on every route and page. Synthetic data only.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, afterEach, before, beforeEach, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { GC_MODULE, GcHelper, helperOptions, type HelperOptions } from "../lib/gc/helper"
import { closeBody, decideBody, reviewBody, setupBody, snoozeBody, statusBody, updateBody } from "../lib/gc/body"
import { correspondenceArgs, idFrom, registerArgs, searchArgs, vesselArgs } from "../lib/gc/params"
import { APP, type Claims, COOKIE, pageGate, sign } from "../lib/server/auth"
import { AppError, SessionError } from "../lib/server/errors"
import { errorResponse, json, route } from "../lib/server/http"

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const PROJECT = join(ROOT, "..")
let dir: string

// A stand-in helper (Node, not Python) whose behaviour each test picks: it speaks the same JSON-lines protocol.
const FAKE = `
import { createInterface } from "node:readline"
const mode = process.argv[2]
if (mode === "crash") process.exit(3)
process.stdout.write(JSON.stringify({ event: "ready", version: 1, available: true }) + "\\n")
if (mode === "noise") process.stdout.write("this is not json\\n")
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, cmd, args } = JSON.parse(line)
  const reply = (obj) => process.stdout.write(JSON.stringify({ id, ...obj }) + "\\n")
  if (mode === "silent") return
  if (cmd === "die") process.exit(1)
  if (cmd === "fail") return reply({ ok: false, error: { kind: args.kind, message: "detail " + args.kind } })
  if (cmd === "split") { const text = JSON.stringify({ id, ok: true, result: "two parts" }); process.stdout.write(text.slice(0, 7)); setTimeout(() => process.stdout.write(text.slice(7) + "\\n"), 20); return }
  reply({ ok: true, result: { cmd, args } })
})
`

const fake = (mode: string, over: Partial<HelperOptions> = {}) =>
  new GcHelper({ command: process.execPath, args: [join(dir, "fake-helper.mjs"), mode], cwd: tmpdir(), timeoutMs: 2000, log: () => undefined, ...over })
const refused = async (promise: Promise<unknown>, status: number, pattern?: RegExp) =>
  assert.rejects(promise, (e: unknown) => e instanceof AppError && e.status === status && (!pattern || pattern.test(e.message)))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nv-gc-helper-"))
  writeFileSync(join(dir, "fake-helper.mjs"), FAKE)
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))

describe("the bridge", () => {
  test("replies come back to the call that asked, also when they arrive in pieces", async () => {
    const helper = fake("echo")
    try {
      const [a, b, c] = await Promise.all([helper.call("one", { n: 1 }), helper.call("two"), helper.call("split")])
      assert.deepEqual(a, { cmd: "one", args: { n: 1 } })
      assert.deepEqual(b, { cmd: "two", args: {} })
      assert.equal(c, "two parts")
    } finally {
      helper.stop()
    }
  })

  test("error kinds become HTTP statuses; internal details are not passed on", async () => {
    const helper = fake("echo")
    try {
      await refused(helper.call("fail", { kind: "bad_request" }), 400, /detail bad_request/)
      await refused(helper.call("fail", { kind: "validation" }), 400, /detail validation/)
      await refused(helper.call("fail", { kind: "not_found" }), 404)
      await refused(helper.call("fail", { kind: "conflict" }), 409)
      await refused(helper.call("fail", { kind: "unavailable" }), 503)
      await refused(helper.call("fail", { kind: "internal" }), 500, /^Internal error\. Details are in the server log\.$/)
      await refused(helper.call("fail", { kind: "something-new" }), 500, /^Internal error/)
    } finally {
      helper.stop()
    }
  })

  test("lines that are not replies are ignored", async () => {
    const helper = fake("noise")
    try {
      assert.deepEqual(await helper.call("ping"), { cmd: "ping", args: {} })
    } finally {
      helper.stop()
    }
  })

  test("no answer in time: 504, the helper is stopped, and the next call starts a new one", async () => {
    const helper = fake("silent", { timeoutMs: 300 })
    try {
      await refused(helper.call("ping"), 504, /did not answer in time/)
      assert.equal(helper.running, false)
    } finally {
      helper.stop()
    }
  })

  test("a helper that stops fails the waiting call with 503 and is started again on the next call", async () => {
    const helper = fake("echo")
    try {
      await refused(helper.call("die"), 503, /stopped/)
      assert.deepEqual(await helper.call("ping"), { cmd: "ping", args: {} })
    } finally {
      helper.stop()
    }
  })

  test("a helper that keeps crashing is left stopped for a while instead of restarting endlessly", async () => {
    const helper = fake("crash", { maxStarts: 2, windowMs: 60_000, coolDownMs: 60_000 })
    await refused(helper.call("ping"), 503)
    await refused(helper.call("ping"), 503)
    await refused(helper.call("ping"), 503, /keeps stopping/)
    await refused(helper.call("ping"), 503, /keeps stopping/)
  })

  test("a missing interpreter is a 503, not a crash of the server", async () => {
    const helper = new GcHelper({ command: join(dir, "no-such-python.exe"), args: [], cwd: tmpdir(), timeoutMs: 2000, log: () => undefined })
    await refused(helper.call("ping"), 503)
  })
})

describe("starting the real Python helper", () => {
  test("it runs the launcher's Python in the project folder and gets no server secrets", () => {
    const options = helperOptions({ NERAVEDA_PROJECT_ROOT: PROJECT, NERAVEDA_PYTHON: "C:\\py\\python.exe", NERAVEDA_WEB_SECRET: "ab".repeat(32),
      MONGODB_URI: "mongodb://x", EMISSIONS_SOURCE_READ_URI: "mongodb://y", AZURE_CLIENT_ID: "client", GC_GRAPH_ENABLED: "true" })
    assert.equal(options.command, "C:\\py\\python.exe")
    assert.deepEqual(options.args, ["-m", "gc_manager.service"])
    assert.equal(options.cwd, PROJECT)
    for (const key of ["NERAVEDA_WEB_SECRET", "MONGODB_URI", "EMISSIONS_SOURCE_READ_URI"]) assert.equal(options.env![key], undefined, key)
    assert.equal(options.env!.AZURE_CLIENT_ID, "client")
    assert.equal(options.env!.PYTHONIOENCODING, "utf-8")
  })

  test("background Outlook sync only under the real NeraVeda web server, never in tests or scripts", () => {
    assert.equal(helperOptions({ NERAVEDA_PROJECT_ROOT: PROJECT, NERAVEDA_WEB_SECRET: "ab".repeat(32) }).env!.GC_AUTO_SYNC, "1")
    assert.equal(helperOptions({ NERAVEDA_PROJECT_ROOT: PROJECT }).env!.GC_AUTO_SYNC, "0")
    assert.equal(helperOptions({ NERAVEDA_PROJECT_ROOT: PROJECT, NERAVEDA_WEB_SECRET: "ab".repeat(32), GC_AUTO_SYNC: "0" }).env!.GC_AUTO_SYNC, "0")
    const hook = readFileSync(join(ROOT, "instrumentation.ts"), "utf8")
    assert.match(hook, /NEXT_RUNTIME !== "nodejs" \|\| !process\.env\.NERAVEDA_WEB_SECRET/, "starts only on the real server")
    assert.match(hook, /\.catch\(/, "a helper that cannot start must not stop the web server")
  })

  test("a folder without gc_manager is refused", () => {
    assert.throws(() => helperOptions({ NERAVEDA_PROJECT_ROOT: dir }), (e: unknown) => e instanceof AppError && e.status === 503)
  })

  const python = join(PROJECT, ".venv", "Scripts", "python.exe")
  test("the real helper answers against an empty Suite database", { skip: !existsSync(python) && "no project .venv" }, async () => {
    const data = mkdtempSync(join(tmpdir(), "nv-gc-data-"))
    const helper = new GcHelper({ ...helperOptions({ ...process.env, NERAVEDA_PROJECT_ROOT: PROJECT, NERAVEDA_PYTHON: python, ABHISHEK_SUITE_DATA: data }), timeoutMs: 30_000, log: () => undefined })
    try {
      assert.deepEqual(await helper.call("ping"), { service: "gc", protocol: 1, schema: 3, read_only: false })
      assert.deepEqual(await helper.call("claims.list"), [])
      await refused(helper.call("claims.delete"), 400, /Unknown command/)
      await refused(helper.call("claim.get", { claim_id: 5 }), 404, /not found/)
    } finally {
      helper.stop()
      await new Promise((r) => setTimeout(r, 300)) // let the process release the database file
      rmSync(data, { recursive: true, force: true })
    }
  })
})

describe("the Guarantee Claim right", () => {
  const SECRET = "cd".repeat(32)
  const now = () => Math.floor(Date.now() / 1000)
  const session = (modules: string[]) => `${COOKIE}=${sign(SECRET, { typ: "session", aud: APP, sub: "alice@x.com", name: "Alice", adm: false,
    grants: modules.map((module) => ({ module, role: "use" })), iat: now() + 1, exp: now() + 600, jti: "g1" } satisfies Claims)}`
  const gcRoute = route({ mutating: false, module: GC_MODULE }, async () => json({ ok: true }))
  const call = (headers: Record<string, string>) => gcRoute(new Request("http://localhost:3000/api/gc/status", { headers: { host: "localhost:3000", ...headers } }), {})
  before(() => { process.env.NERAVEDA_WEB_SECRET = SECRET })
  after(() => { delete process.env.NERAVEDA_WEB_SECRET })

  test("GC routes need a NeraVeda session with the Guarantee Claim Manager right", async () => {
    assert.equal((await call({ cookie: session(["gc"]) })).status, 200)
    assert.equal((await call({})).status, 401)
    assert.equal((await call({ cookie: session(["sir", "dd"]) })).status, 403)
    assert.equal((await call({ cookie: session(["gc"]), origin: "http://localhost:3001" })).status, 403)
    assert.equal((await call({ cookie: session(["gc"]), "sec-fetch-site": "cross-site" })).status, 403)
    assert.equal((await gcRoute(new Request("http://evil.example/api/gc/status", { headers: { host: "evil.example", cookie: session(["gc"]) } }), {})).status, 403)
  })

  test("/claims pages need the right too, and the GC right does not open the other workspaces", () => {
    const page = (path: string, cookie: string) => pageGate(new Request(`http://localhost:3000${path}`, { headers: { host: "localhost:3000", cookie } }))
    assert.equal(page("/claims", session(["gc"])), null)
    assert.equal(page("/claims/12", session(["gc"])), null)
    assert.equal(page("/claims", session(["sir"]))!.status, 403)
    assert.equal(page("/inspections", session(["gc"]))!.status, 403)
    assert.equal(page("/docking", session(["gc"]))!.status, 403)
  })

  test("every GC route declares the Guarantee Claim right; reads are reads, changes are protected writes by the signed-in person", () => {
    const files = (readdirSync(join(ROOT, "app", "api", "gc"), { recursive: true }) as string[]).filter((f) => f.endsWith("route.ts"))
    assert.ok(files.length >= 14, files.join(", "))
    let writes = 0
    for (const file of files) {
      const source = readFileSync(join(ROOT, "app", "api", "gc", file), "utf8")
      const handlers = [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE) = (.*)/g)]
      assert.ok(handlers.length > 0, `${file} exports no handler`)
      for (const [, method, rest] of handlers) {
        if (method === "GET") {
          assert.match(rest, /^route(<\w+>)?\(\{ mutating: false, limit: READ_LIMIT, module: GC_MODULE \}/, `${file} GET needs the GC right and read limits`)
        } else {
          writes += 1
          assert.notEqual(method, "PUT", `${file}: no PUT routes`)
          assert.match(rest, /^route(<\w+>)?\(\{ mutating: true, limit: WRITE_LIMIT, module: GC_MODULE \}/, `${file} ${method} must be a protected write with the GC right`)
        }
      }
      if (handlers.some(([, m]) => m !== "GET")) assert.match(source, /actor\(\)/, `${file}: a change names the signed-in person`)
      assert.doesNotMatch(source, /sqlite|DatabaseSync|child_process|suite\.sqlite3/i, `${file} must not reach the database itself`)
    }
    assert.ok(writes >= 8, `only ${writes} change handlers`)
  })

  test("a change without the write header, or by someone without the GC right, is refused before the helper is asked", async () => {
    let asked = 0
    const change = route({ mutating: true, module: GC_MODULE }, async () => { asked += 1; return json({ ok: true }) })
    const post = (headers: Record<string, string>) => change(new Request("http://localhost:3000/api/gc/claims/1/setup", { method: "POST", headers: { host: "localhost:3000", ...headers } }), {})
    assert.equal((await post({ cookie: session(["gc"]) })).status, 403) // no x-neraveda-request header (a form from another site)
    assert.equal((await post({ cookie: session(["sir"]), "x-neraveda-request": "1" })).status, 403)
    assert.equal((await post({ "x-neraveda-request": "1" })).status, 401)
    assert.equal(asked, 0)
    assert.equal((await post({ cookie: session(["gc"]), "x-neraveda-request": "1" })).status, 200)
  })
})

describe("query values from the browser", () => {
  const url = (q: string) => new URL(`http://localhost:3000/api/gc/x${q}`)
  const bad = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AppError && e.status === 400 && pattern.test(e.message))

  test("known names and shapes only", () => {
    assert.deepEqual(vesselArgs(url("")), {})
    assert.deepEqual(vesselArgs(url("?vessel=12")), { vessel_id: 12 })
    bad(() => vesselArgs(url("?vessel=12;DROP")), /positive whole number/)
    bad(() => vesselArgs(url("?vessel=0")), /positive whole number/)
    bad(() => vesselArgs(url("?cmd=claims.delete")), /Unknown query value: cmd/)
    assert.deepEqual(registerArgs(url("?vessel=3&search=GC001&status=DRAFT")), { vessel_id: 3, search: "GC001", status: "DRAFT" })
    bad(() => registerArgs(url("?status=draft'--")), /not a known claim status/)
    bad(() => registerArgs(url(`?search=${"x".repeat(201)}`)), /longer than 200/)
    assert.deepEqual(correspondenceArgs(url("?direction=OUTGOING&offset=50&search=awb")), { direction: "OUTGOING", offset: 50, search: "awb" })
    assert.deepEqual(correspondenceArgs(url("?offset=0")), {})
    bad(() => correspondenceArgs(url("?direction=ALL")), /INCOMING or OUTGOING/)
    bad(() => correspondenceArgs(url("?offset=-5")), /positive whole number/)
    assert.equal(idFrom("42", "Claim"), 42)
    bad(() => idFrom("../etc", "Claim"), /positive whole number/)
  })

  test("register views and Ctrl+K search take only the fixed words", () => {
    assert.deepEqual(registerArgs(url("?focus=overdue&owner=Not%20established&sort=priority")), { focus: "overdue", owner: "Not established", sort: "priority" })
    bad(() => registerArgs(url("?focus=all;drop")), /Focus is not one of/)
    bad(() => registerArgs(url("?owner=Admin")), /Owner is not one of/)
    bad(() => registerArgs(url("?sort=updated_at")), /Sort is not one of/)
    assert.deepEqual(searchArgs(url("?vessel=2&q=GC%20025")), { vessel_id: 2, text: "GC 025" })
    assert.deepEqual(searchArgs(url("?q=")), {})
    bad(() => searchArgs(url("?text=x")), /Unknown query value/)
    bad(() => searchArgs(url(`?q=${"y".repeat(201)}`)), /longer than 200/)
  })
})

describe("change requests from the browser", () => {
  const bad = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, (e: unknown) => e instanceof AppError && e.status === 400 && pattern.test(e.message))
  const at = "2026-11-26T01:00:00.000000+00:00"

  test("edits take only editable fields, dates as dates, and the updated time the person saw", () => {
    assert.deepEqual(updateBody({ fields: { title: "Pump", action_since: "2026-11-02", notes: "" }, expected_updated_at: at }),
      { fields: { title: "Pump", action_since: "2026-11-02", notes: null }, reason: "", expected_updated_at: at })
    bad(() => updateBody({ fields: { current_status: "CLOSED" }, expected_updated_at: at }), /cannot be edited/)
    bad(() => updateBody({ fields: { updated_by: "x" }, expected_updated_at: at }), /cannot be edited/)
    bad(() => updateBody({ fields: { action_since: "2 Nov" }, expected_updated_at: at }), /must be a date/)
    bad(() => updateBody({ fields: { title: "x" } }), /expected updated at is required/)
    bad(() => updateBody({ fields: { title: "x" }, expected_updated_at: at, sql: "drop" }), /Unknown value/)
    bad(() => updateBody({ fields: {}, expected_updated_at: at }), /Nothing to change/)
  })

  test("set-up, status, close, snooze and suggestion decisions", () => {
    const set = setupBody({ fields: { waiting_on: "SHIPYARD", action_since: "2026-11-03" }, status: "SUBMITTED", used: ["OWNER:4:12:SHIPYARD"], expected_updated_at: at })
    assert.deepEqual(set, { fields: { waiting_on: "SHIPYARD", action_since: "2026-11-03" }, status: "SUBMITTED", used: ["OWNER:4:12:SHIPYARD"], rejected: [], expected_updated_at: at })
    bad(() => setupBody({ fields: { title: "x" }, used: ["../../etc"], expected_updated_at: at }), /suggestion keys/)
    bad(() => statusBody({ status: "closed'--", expected_updated_at: at }), /not a known claim status/)
    bad(() => statusBody({ status: "SUBMITTED", override: "yes", expected_updated_at: at }), /true or false/)
    bad(() => closeBody({ closure_date: "2026-11-25", expected_updated_at: at }), /reason is required/)
    bad(() => snoozeBody({ until: "soon", reason: "x" }), /must be a date/)
    assert.deepEqual(decideBody({ key: "LINK:3:9:9", decision: "ACCEPTED" }), { key: "LINK:3:9:9", decision: "ACCEPTED", reason: "" })
    bad(() => decideBody({ key: "LINK:3:9:9", decision: "MAYBE" }), /ACCEPTED or REJECTED/)
  })

  test("review queue resolutions take only the known actions and ids", () => {
    assert.deepEqual(reviewBody({ action: "link", register: true, vessel_id: 2, link_matching: true }),
      { cmd: "review.resolve", args: { action: "link", register: true, link_matching: true, notes: "", vessel_id: 2 } })
    assert.deepEqual(reviewBody({ action: "multiple", claim_ids: [3, 4], notes: "AWB covers both" }), { cmd: "review.resolve_multiple", args: { claim_ids: [3, 4], notes: "AWB covers both" } })
    bad(() => reviewBody({ action: "delete" }), /link, irrelevant or multiple/)
    bad(() => reviewBody({ action: "link", claim_id: "5; drop" }), /positive whole number/)
    bad(() => reviewBody({ action: "multiple", claim_ids: [3] }), /at least two/)
    bad(() => reviewBody({ action: "link", path: "C:/x" }), /Unknown value/)
  })
})

describe("errors made by another copy of the code", () => {
  test("an AppError from a second module copy keeps its status and message (not a 500)", async () => {
    const copy = Object.assign(new Error("This email was already resolved."), { status: 409, [Symbol.for("neraveda.AppError")]: true })
    assert.ok(copy instanceof AppError)
    assert.ok(!(copy instanceof SessionError))
    const res = errorResponse(copy)
    assert.equal(res.status, 409)
    assert.deepEqual(await res.json(), { error: "This email was already resolved." })
    assert.ok(!(new Error("boom") instanceof AppError))
    assert.equal(errorResponse(new Error("boom")).status, 500)
    assert.ok(new SessionError(401, "x") instanceof AppError)
    assert.ok(!(new AppError(403, "x") instanceof SessionError))
  })
})
