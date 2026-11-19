// API plumbing: request guard (local origin only, CSRF header), NeraVeda session (lib/server/auth.ts), bounded body
// reading, rate limiting and error mapping. The server listens on 127.0.0.1 only and is started by the NeraVeda
// launcher, which signs the person in and hands this server its per-run secret.

import { ConfigError } from "../engine/config"
import { ImageRejected } from "../ocr/image"
import { authenticate, type AuthMode, withUser } from "./auth"
import { SourceRejected } from "../parsers"
import { AppError, BadRequest, PayloadTooLarge } from "./errors"

export const CSRF_HEADER = "x-neraveda-request"

function port(): string {
  return process.env.EMISSIONS_PORT || process.env.PORT || "3001"
}

function allowedHosts(): Set<string> {
  const p = port()
  return new Set([`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`])
}

/**
 * - Host must be this machine on this port (defeats DNS-rebinding).
 * - Cross-site requests are refused (Sec-Fetch-Site), and a foreign Origin is refused.
 * - Every state-changing request must carry the custom header, which a cross-origin page cannot send without a
 *   CORS preflight that this server never approves.
 */
export function guard(req: Request, mutating: boolean): void {
  const host = (req.headers.get("host") ?? "").toLowerCase()
  if (!allowedHosts().has(host)) throw new AppError(403, "Requests are accepted from this computer only.")
  const site = req.headers.get("sec-fetch-site")
  if (site && site !== "same-origin" && site !== "none") throw new AppError(403, "Cross-site requests are not accepted.")
  const origin = req.headers.get("origin")
  if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, "").toLowerCase())) throw new AppError(403, "Cross-origin requests are not accepted.")
  if (mutating && req.headers.get(CSRF_HEADER) !== "1") throw new AppError(403, "Missing request header.")
}

const buckets = new Map<string, { tokens: number; at: number }>()

/** Simple token bucket per action (single local user; protects against runaway loops and scripted abuse). */
export function rateLimit(key: string, perMinute: number): void {
  const now = Date.now()
  const bucket = buckets.get(key) ?? { tokens: perMinute, at: now }
  bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.at) / 60_000) * perMinute)
  bucket.at = now
  if (bucket.tokens < 1) throw new AppError(429, "Too many requests. Wait a moment and try again.")
  bucket.tokens -= 1
  buckets.set(key, bucket)
}

/** Read a request body with a hard byte limit, without trusting Content-Length. */
export async function readBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLarge()
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
      await reader.cancel()
      throw new PayloadTooLarge()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export async function readJson(req: Request, maxBytes = 200_000): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? ""
  if (!type.toLowerCase().startsWith("application/json")) throw new BadRequest("Content-Type must be application/json.")
  const text = new TextDecoder().decode(await readBody(req, maxBytes))
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new BadRequest("The request body is not a JSON object.")
  }
}

const NO_STORE = { "Cache-Control": "no-store" }

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) return json({ error: error.message }, error.status)
  if (error instanceof SourceRejected || error instanceof ConfigError) return json({ error: error.message }, 400)
  if (error instanceof ImageRejected) return json({ error: error.message }, 415)
  const name = error instanceof Error ? error.name : "Error"
  if (name === "MongoServerSelectionError" || name === "MongoNetworkError" || name === "MongoNetworkTimeoutError") {
    console.error("[emissions] database unavailable:", (error as Error).message)
    return json({ error: "The database could not be reached. Check the connection and try again." }, 503)
  }
  console.error("[emissions] unexpected error:", error)
  return json({ error: "Internal error. Details are in the server log." }, 500)
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>

/**
 * Wrap a route handler: guard, rate limit, NeraVeda session (default: the signed-in person's cookie), safe errors.
 * The handler runs as that person, so audit records name them.
 */
export function route<C>(options: { mutating: boolean; limit?: [string, number]; auth?: AuthMode }, fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      guard(req, options.mutating)
      if (options.limit) rateLimit(options.limit[0], options.limit[1])
      const claims = authenticate(req, options.auth ?? "user")
      return await withUser(claims, () => fn(req, ctx))
    } catch (error) {
      return errorResponse(error)
    }
  }
}
