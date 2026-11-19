// NeraVeda sign-in for this workspace: tickets shared with the Python launcher, the entry exchange, and route().
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { APP, type Claims, COOKIE, currentUser, handleEnter, revokeAll, safeNext, sign, verify } from "../lib/server/auth"
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
