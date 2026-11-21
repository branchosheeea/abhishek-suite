// NeraVeda sign-in for this workspace: tickets shared with the Python launcher, the entry exchange, and route().
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { ANY_MODULE, APP, type Claims, COOKIE, currentUser, handleEnter, pageGate, revokeAll, safeNext, sessionInfo, sign, verify } from "../lib/server/auth"
import { AppError, SESSION_HEADER } from "../lib/server/errors"
import { json, route } from "../lib/server/http"

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const VECTORS = JSON.parse(readFileSync(join(ROOT, "..", "tests", "fixtures", "neraveda_ticket_vectors.json"), "utf8"))
const SECRET = "ab".repeat(32)
const now = () => Math.floor(Date.now() / 1000)
const claims = (over: Partial<Claims> = {}): Claims => ({ typ: "enter", aud: APP, sub: "alice@x.com", name: "Alice", adm: false, grants: [{ module: APP, role: "use" }], iat: now(), exp: now() + 120, jti: "t1", ...over })
const HOST = { host: "localhost:3000" }

beforeEach(() => { process.env.NERAVEDA_WEB_SECRET = SECRET })
afterEach(() => { delete process.env.NERAVEDA_WEB_SECRET })

describe("tickets shared with the Python launcher", () => {
  test("the shared vectors verify (and fail) exactly as in Python", () => {
    for (const v of VECTORS.valid) assert.equal(verify(VECTORS.secret, v.token, v.typ, v.aud, VECTORS.now).sub, v.sub)
    for (const v of VECTORS.invalid) assert.throws(() => verify(VECTORS.secret, v.token, v.typ, v.aud, VECTORS.now), Error, v.why)
  })
})

describe("entry from NeraVeda", () => {
  const enter = (t: string, next = "/inspections/report?id=abc") => handleEnter(new Request(`http://localhost:3000/api/auth/enter?t=${encodeURIComponent(t)}&next=${encodeURIComponent(next)}`, { headers: HOST }))

  test("a valid ticket becomes an HttpOnly session cookie and a same-origin redirect", () => {
    const res = enter(sign(SECRET, claims()))
    assert.equal(res.status, 303)
    assert.equal(res.headers.get("location"), "/inspections/report?id=abc")
    const cookie = res.headers.get("set-cookie")!
    assert.match(cookie, new RegExp(`^${COOKIE}=nv1\\.`))
    for (const part of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=43200"]) assert.ok(cookie.includes(part), part)
    const session = verify(SECRET, cookie.split(";")[0].slice(COOKIE.length + 1), "session", APP)
    assert.equal(session.sub, "alice@x.com")
    assert.equal(res.headers.get("referrer-policy"), "no-referrer")
  })

  test("expired, tampered, other-workspace and no-access tickets are refused with a page, not a cookie", () => {
    for (const t of [sign(SECRET, claims({ exp: now() - 1 })), sign("cd".repeat(32), claims()), sign(SECRET, claims({ aud: "evi" })), sign(SECRET, claims({ typ: "service" }))]) {
      const res = enter(t)
      assert.equal(res.status, 401)
      assert.equal(res.headers.get("set-cookie"), null)
    }
    assert.equal(enter(sign(SECRET, claims({ grants: [] }))).status, 403)
  })

  test("only same-origin paths outside /api are accepted as the destination", () => {
    for (const bad of ["//evil.example", "https://evil.example", "/\\evil.example", "/api/sessions", "javascript:alert(1)", "/a b"]) assert.equal(safeNext(bad), "/inspections", bad)
    assert.equal(safeNext("/inspections/report?id=x"), "/inspections/report?id=x")
  })

  test("without a secret the workspace cannot be entered", () => {
    delete process.env.NERAVEDA_WEB_SECRET
    assert.equal(enter(sign(SECRET, claims())).status, 503)
  })
})

describe("route() requires the NeraVeda session", () => {
  const echo = (auth?: "user" | "user-or-service" | "service") => route({ mutating: false, ...(auth ? { auth } : {}) }, async () => json({ who: currentUser()?.sub ?? null, via: currentUser()?.typ ?? null }))
  const session = (over: Partial<Claims> = {}) => `${COOKIE}=${sign(SECRET, claims({ typ: "session", ...over }))}`
  const call = (handler: ReturnType<typeof echo>, headers: Record<string, string> = {}) => handler(new Request("http://localhost:3000/api/x", { headers: { ...HOST, ...headers } }), {})

  test("no cookie 401, no secret 503, valid cookie runs the handler as that person", async () => {
    assert.equal((await call(echo())).status, 401)
    const ok = await call(echo(), { cookie: session() })
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json(), { who: "alice@x.com", via: "session" })
    delete process.env.NERAVEDA_WEB_SECRET
    assert.equal((await call(echo(), { cookie: session() })).status, 503)
  })

  test("only session errors are marked as such; a database outage is not mistaken for an ended session", async () => {
    const noCookie = await call(echo())
    assert.equal(noCookie.headers.get(SESSION_HEADER), "ended")
    assert.equal((await call(echo(), { cookie: session({ grants: [{ module: "other", role: "use" }] }) })).headers.get(SESSION_HEADER), "ended")
    delete process.env.NERAVEDA_WEB_SECRET
    assert.equal((await call(echo(), { cookie: session() })).headers.get(SESSION_HEADER), "ended") // 503: not opened from NeraVeda
    process.env.NERAVEDA_WEB_SECRET = SECRET
    const dbDown = route({ mutating: false }, async () => { throw new AppError(503, "The database could not be reached.") })
    const res = await call(dbDown, { cookie: session() })
    assert.equal(res.status, 503)
    assert.equal(res.headers.get(SESSION_HEADER), null)
  })

  test("a session without this workspace's grant is refused", async () => {
    assert.equal((await call(echo(), { cookie: session({ grants: [{ module: "evi", role: "use" }] }) })).status, 403)
  })

  test("service tickets work only where allowed", async () => {
    const service = { "x-neraveda-service": sign(SECRET, claims({ typ: "service", exp: now() + 60 })) }
    assert.equal((await call(echo(), service)).status, 401)
    assert.equal((await call(echo("user-or-service"), service)).status, 200)
    assert.equal((await call(echo("service"), { cookie: session() })).status, 401)
  })

  test("the person stays attached across awaits, and revoke ends existing sessions", async () => {
    const slow = route({ mutating: false }, async () => {
      await new Promise((r) => setTimeout(r, 5))
      return json({ who: currentUser()?.sub })
    })
    const [a, b] = await Promise.all([call(slow, { cookie: session({ sub: "a@x.com", iat: now() - 5 }) }), call(slow, { cookie: session({ sub: "b@x.com", iat: now() - 5 }) })])
    assert.deepEqual([(await a.json()).who, (await b.json()).who], ["a@x.com", "b@x.com"])
    const old = session({ iat: now() - 5 })
    revokeAll()
    assert.equal((await call(echo(), { cookie: old })).status, 401)
  })
})

describe("static: every API route goes through route()", () => {
  function routes(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) routes(path, out)
      else if (name === "route.ts") out.push(path)
    }
    return out
  }

  test("only /api/health answers without the session wrapper", () => {
    for (const p of routes(join(ROOT, "app", "api"))) {
      const rel = relative(ROOT, p).replace(/\\/g, "/")
      const text = readFileSync(p, "utf8")
      if (rel === "app/api/health/route.ts") continue
      assert.ok(/=\s*route[<(]/.test(text), `${rel} does not use route()`)
      assert.ok(!/export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH)\b/.test(text), `${rel} exports a bare handler`)
    }
  })
})

describe("pages are sent only with a NeraVeda session (proxy.ts)", () => {
  const PAGES = ["/", "/inspections", "/inspections/report"]
  const page = (cookie?: string) => new Request(`http://localhost:3000${PAGES[1]}`, { headers: { ...HOST, ...(cookie ? { cookie } : {}) } })
  // Issued a second ahead, as handleEnter does after a revoke (an earlier test revokes everything issued so far).
  const session = (over: Partial<Claims> = {}) => `${COOKIE}=${sign(SECRET, claims({ typ: "session", iat: now() + 1, ...over }))}`

  test("no, tampered, expired, revoked or other-workspace cookies get an explanation page instead of the app", () => {
    assert.equal(pageGate(page(session())), null)
    const refused = pageGate(page())!
    assert.equal(refused.status, 401)
    assert.match(refused.headers.get("content-type")!, /^text\/html/)
    assert.equal(refused.headers.get("cache-control"), "no-store") // the service worker caches only 200s
    for (const cookie of [`${COOKIE}=${sign("cd".repeat(32), claims({ typ: "session" }))}`, session({ exp: now() - 1 }), session({ typ: "enter" }), `${COOKIE}=nv1.x.y`])
      assert.equal(pageGate(page(cookie))!.status, 401, cookie)
    assert.equal(pageGate(page(session({ grants: [{ module: "other", role: "use" }] })))!.status, 403)
    const old = session({ iat: now() - 5 })
    revokeAll()
    assert.equal(pageGate(page(old))!.status, 401)
    delete process.env.NERAVEDA_WEB_SECRET
    assert.equal(pageGate(page(session()))!.status, 503)
  })

  test("the proxy gates every page and leaves only the API, build assets and public files to themselves", () => {
    const source = readFileSync(join(ROOT, "proxy.ts"), "utf8")
    assert.match(source, /return pageGate\(request\) \?\? NextResponse\.next\(\)/)
    const literal = /matcher:\s*\[\s*("(?:[^"\\]|\\.)*")\s*\]/.exec(source)
    assert.ok(literal, "proxy.ts needs exactly one matcher string")
    const matcher = new RegExp(`^${JSON.parse(literal[1])}$`)
    for (const path of [...PAGES, "/anything/new"]) assert.ok(matcher.test(path), `${path} must be gated`)
    for (const path of ["/api/auth/enter", "/api/x", "/_next/static/chunks/app.js", "/sw.js", "/icon.svg", "/manifest.webmanifest"])
      assert.ok(!matcher.test(path), `${path} must not be gated`)
  })
})

describe("one sign-in, several workspaces on this server (Inspection Reports and Digital Docking)", () => {
  const session = (modules: string[]) => `${COOKIE}=${sign(SECRET, claims({ typ: "session", iat: now() + 1, grants: modules.map((module) => ({ module, role: "use" })) }))}`
  const pageAt = (path: string, cookie: string) => pageGate(new Request(`http://localhost:3000${path}`, { headers: { ...HOST, cookie } }))
  const echo = (module?: string) => route({ mutating: false, ...(module !== undefined ? { module } : {}) }, async () => json({ who: currentUser()?.sub }))
  const call = (handler: ReturnType<typeof echo>, cookie: string) => handler(new Request("http://localhost:3000/api/x", { headers: { ...HOST, cookie } }), {})

  test("each page needs its own workspace; the home page needs any of them", () => {
    const docking = session(["dd"])
    assert.equal(pageAt("/docking", docking), null)
    assert.equal(pageAt("/docking/abc", docking), null)
    assert.equal(pageAt("/", docking), null)
    assert.equal(pageAt("/inspections", docking)!.status, 403)
    assert.equal(pageAt("/inspections/report", docking)!.status, 403)
    assert.equal(pageAt("/docking", session(["sir"]))!.status, 403)
    assert.equal(pageAt("/dockingx", session(["sir"])), null) // a prefix match is by path segment, not by text
    assert.equal(pageAt("/", session(["evi"]))!.status, 403) // another server's workspace
  })

  test("API routes need their workspace (Inspection Reports by default); the session check accepts any", async () => {
    const docking = session(["dd"])
    assert.equal((await call(echo(), docking)).status, 403)
    assert.equal((await call(echo("dd"), docking)).status, 200)
    assert.equal((await call(echo(ANY_MODULE), docking)).status, 200)
    assert.equal((await call(echo("dd"), session(["sir"]))).status, 403)
    assert.deepEqual(sessionInfo(verify(SECRET, session(["dd", "evi", "sir"]).slice(COOKIE.length + 1), "session", APP))!.modules, ["dd", "sir"])
  })

  test("the entry link works with the right to any workspace of this server", () => {
    const enter = (modules: string[]) => handleEnter(new Request(`http://localhost:3000/api/auth/enter?t=${encodeURIComponent(sign(SECRET, claims({ grants: modules.map((module) => ({ module, role: "use" })) })))}&next=%2Fdocking`, { headers: HOST }))
    const ok = enter(["dd"])
    assert.equal(ok.status, 303)
    assert.equal(ok.headers.get("location"), "/docking")
    assert.equal(enter(["evi"]).status, 403)
  })
})
