// API plumbing for the Inspection Reports web shell: request guard (this computer only, no cross-site requests, a
// custom header on writes), NeraVeda session (lib/server/auth.ts), rate limiting and safe error responses.
// Same rules as the Emissions Validation app (Emission Correction Assitant/lib/server/http.ts).

import { authenticate, type AuthMode, withUser } from "./auth"
import { AppError } from "./errors"

export const CSRF_HEADER = "x-neraveda-request"

function port(): string {
  return process.env.SIR_PORT || process.env.PORT || "3000"
}

function allowedHosts(): Set<string> {
  const p = port()
  return new Set([`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`])
}

/**
 * - Host must be this machine on this port (defeats DNS rebinding).
 * - Cross-site requests are refused (Sec-Fetch-Site), and a foreign Origin is refused — including another
 *   localhost port, which browsers treat as "same-site" but not "same-origin".
 * - Every write must carry the custom header, which a cross-origin page cannot send without a CORS preflight.
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

export function rateLimit(key: string, perMinute: number): void {
  const now = Date.now()
  const bucket = buckets.get(key) ?? { tokens: perMinute, at: now }
  bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.at) / 60_000) * perMinute)
  bucket.at = now
  if (bucket.tokens < 1) throw new AppError(429, "Too many requests. Wait a moment and try again.")
  bucket.tokens -= 1
  buckets.set(key, bucket)
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } })
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) return json({ error: error.message }, error.status)
  console.error("[inspections] unexpected error:", error)
  return json({ error: "Internal error. Details are in the server log." }, 500)
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>

/** Guard, rate limit, NeraVeda session (default: the signed-in person's cookie), safe errors. */
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
