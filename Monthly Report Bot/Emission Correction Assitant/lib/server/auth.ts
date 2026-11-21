// NeraVeda sign-in for this local web workspace. The desktop launcher signs the person in (Microsoft work account)
// and starts this server with a per-run secret (NERAVEDA_WEB_SECRET). It opens the browser on /api/auth/enter with a
// short-lived signed ticket; this sets an HttpOnly session cookie for this workspace only. Every API request then
// needs that cookie (or, for the Home summary, a 60 s service ticket from the launcher). Without a secret the
// workspace refuses all API requests: it must be opened from NeraVeda.
//
// Ticket format (identical in suite_services/access/tickets.py):  nv1.<b64url(json)>.<b64url(HMAC-SHA256)>
// KEEP IN SYNC with "Superintendent inspection Report/lib/server/auth.ts" (only APP, COOKIE, DEFAULT_NEXT, MODULES and PAGE_MODULES differ).
// No Next.js imports, so it can be tested directly.

import { AsyncLocalStorage } from "node:async_hooks"
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { AppError, SessionError } from "./errors"

export const APP = "evi"
export const COOKIE = "neraveda_evi"
export const DEFAULT_NEXT = "/"
export const SERVICE_HEADER = "x-neraveda-service"
/** The workspaces this server hosts. A session is valid with the right to any of them; each page and API route then
 *  needs the right to its own workspace (route({ module }), PAGE_MODULES). APP is the default. */
export const MODULES: readonly string[] = ["evi"]
/** Which workspace a page belongs to, by path prefix (first match). Other pages (e.g. the home page) need any of MODULES. */
/** For routes any workspace of this server may use (e.g. the session check behind the shell). */
export const ANY_MODULE = ""
export const PAGE_MODULES: readonly (readonly [string, string])[] = []
const SESSION_SECONDS = 12 * 3600

export type Grant = Readonly<{ module: string; role: string }>
export type Claims = Readonly<{ typ: "enter" | "service" | "session"; aud: string; sub: string; name: string; adm: boolean; grants: readonly Grant[]; iat: number; exp: number; jti: string }>
export type AuthMode = "user" | "user-or-service" | "service" | "none"

const nowSeconds = () => Math.floor(Date.now() / 1000)

function b64url(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromB64url(text: string): Buffer {
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64")
}

export function secret(): string | null {
  const value = process.env.NERAVEDA_WEB_SECRET ?? ""
  return /^[0-9a-f]{64,}$/i.test(value) ? value : null
}

export function sign(key: string, claims: Claims): string {
  const body = `nv1.${b64url(Buffer.from(JSON.stringify(claims), "utf8"))}`
  return `${body}.${b64url(createHmac("sha256", Buffer.from(key, "ascii")).update(body, "ascii").digest())}`
}

export function verify(key: string, token: string | null | undefined, typ: Claims["typ"], aud: string, now = nowSeconds()): Claims {
  const parts = (token ?? "").split(".")
  if (parts.length !== 3 || parts[0] !== "nv1") throw new SessionError(401, "Malformed NeraVeda ticket.")
  const expected = createHmac("sha256", Buffer.from(key, "ascii")).update(`${parts[0]}.${parts[1]}`, "ascii").digest()
  const given = fromB64url(parts[2])
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new SessionError(401, "Invalid NeraVeda ticket.")
  let claims: Claims
  try {
    claims = JSON.parse(fromB64url(parts[1]).toString("utf8")) as Claims
  } catch {
    throw new SessionError(401, "Malformed NeraVeda ticket.")
  }
  if (!claims || claims.typ !== typ || claims.aud !== aud) throw new SessionError(401, "This ticket is not for this workspace.")
  if (!Number.isInteger(claims.exp) || claims.exp < now) throw new SessionError(401, "Your NeraVeda session has expired. Open the workspace again from NeraVeda.")
  if (typeof claims.sub !== "string" || !claims.sub) throw new SessionError(401, "Invalid NeraVeda ticket.")
  return claims
}

// Revocation: session cookies issued at or before this moment are refused (in memory; a server restart rotates the secret).
const state = globalThis as unknown as { __neravedaNotBefore?: Record<string, number> }
state.__neravedaNotBefore ??= {}
const notBefore = () => state.__neravedaNotBefore![APP] ?? 0

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=")
    if (k === name) return v.join("=")
  }
  return null
}

/** The person behind a request, or an error response (401/403/503). */
export function authenticate(req: Request, mode: AuthMode, module: string = APP): Claims | null {
  if (mode === "none") return null
  const key = secret()
  if (!key) throw new SessionError(503, "This workspace must be opened from NeraVeda.")
  const service = req.headers.get(SERVICE_HEADER)
  if (mode !== "user" && service) return verify(key, service, "service", APP)
  if (mode === "service") throw new SessionError(401, "A NeraVeda service ticket is required.")
  return sessionClaims(key, req, module)
}

/** This workspace's session cookie, verified: signed by this run's secret, not expired or revoked, with the grant. */
function sessionClaims(key: string, req: Request, module?: string): Claims {
  const claims = verify(key, cookie(req, COOKIE), "session", APP)
  if (claims.iat <= notBefore()) throw new SessionError(401, "Your NeraVeda session has ended. Open the workspace again from NeraVeda.")
  const needed = module ? [module] : MODULES
  if (!claims.grants.some((g) => needed.includes(g.module))) throw new SessionError(403, "You do not have access to this workspace.")
  return claims
}

/**
 * Page requests (proxy.ts): the app's pages are sent only with a valid session, so a tab that was not opened from
 * NeraVeda gets an explanation page, not an app whose lock screen could be removed in the browser's developer tools.
 * null = allowed. The API routes check the session themselves on every request (route()).
 */
export function pageGate(req: Request): Response | null {
  const key = secret()
  if (!key) return page(503, "Open from NeraVeda", "This workspace was not started by NeraVeda. Open it from the NeraVeda home screen.")
  try {
    const path = new URL(req.url).pathname
    const owner = PAGE_MODULES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))
    sessionClaims(key, req, owner?.[1])
    return null
  } catch (error) {
    if (error instanceof AppError && error.status === 403) return page(403, "No access", "You do not have access to this workspace. Ask your NeraVeda admin.")
    return page(401, "Open from NeraVeda", "Your NeraVeda session has ended, or this tab was not opened from NeraVeda. Open the workspace again from the NeraVeda home screen.")
  }
}

const users = new AsyncLocalStorage<Claims | null>()

export function withUser<T>(claims: Claims | null, fn: () => T): T {
  return users.run(claims, fn)
}

/** The signed-in person for the current request (null outside a request, e.g. in tests). */
export function currentUser(): Claims | null {
  return users.getStore() ?? null
}

export function safeNext(next: string | null): string {
  if (!next || !/^\/(?!\/)[^\\\s\u0000-\u001f]*$/.test(next) || next.toLowerCase().startsWith("/api/")) return DEFAULT_NEXT
  return next
}

function page(status: number, title: string, text: string): Response {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>NeraVeda</title><body style="font-family:Segoe UI,sans-serif;background:#f3f6f9;color:#0f1b2a;display:grid;place-items:center;min-height:90vh"><div style="background:#fff;border:1px solid #e3e8ee;border-radius:14px;padding:28px 32px;max-width:460px"><h1 style="font-size:20px;margin:0 0 8px">${esc(title)}</h1><p style="margin:0;color:#5f6b7a">${esc(text)}</p></div></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  )
}

/** GET /api/auth/enter?t=<ticket>&next=<path>: exchange the launcher's ticket for this workspace's session cookie. */
export function handleEnter(req: Request): Response {
  const url = new URL(req.url)
  const key = secret()
  if (!key) return page(503, "Open from NeraVeda", "This workspace was not started by NeraVeda. Open it from the NeraVeda home screen.")
  let ticket: Claims
  try {
    ticket = verify(key, url.searchParams.get("t"), "enter", APP)
  } catch {
    return page(401, "Sign-in link expired", "This link has expired or is not valid. Open the workspace again from NeraVeda.")
  }
  if (!ticket.grants.some((g) => MODULES.includes(g.module))) return page(403, "No access", "You do not have access to this workspace. Ask your NeraVeda admin.")
  const issued = Math.max(nowSeconds(), notBefore() + 1)
  const session = sign(key, { ...ticket, typ: "session", iat: issued, exp: issued + SESSION_SECONDS, jti: randomBytes(8).toString("hex") })
  return new Response(null, {
    status: 303,
    headers: {
      // Relative: the browser stays on this exact origin (http://localhost:<port>), where drafts and data live.
      Location: safeNext(url.searchParams.get("next")),
      "Set-Cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  })
}

export function sessionInfo(claims: Claims | null) {
  return claims
    ? { app: APP, sub: claims.sub, name: claims.name, admin: claims.adm, via: claims.typ, modules: claims.grants.map((g) => g.module).filter((m) => MODULES.includes(m)) }
    : null
}

/** POST /api/auth/revoke (service ticket): end every browser session issued so far. */
export function revokeAll(): void {
  state.__neravedaNotBefore![APP] = nowSeconds()
}
