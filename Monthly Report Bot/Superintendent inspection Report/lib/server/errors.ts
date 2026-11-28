// Errors that carry an HTTP status. Recognised by a shared marker (Symbol.for), not by class identity: the server can
// hold two copies of this module (the instrumentation hook that starts the Guarantee Claim helper is bundled apart
// from the routes), and an error made by one copy must still be an AppError to the other. Without this, an expected
// refusal such as "already resolved" (409) became an "unexpected error" (500).
const APP_ERROR = Symbol.for("neraveda.AppError")
const SESSION_ERROR = Symbol.for("neraveda.SessionError")

const marked = (value: unknown, brand: symbol) =>
  typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[brand] === true

/** An error with an HTTP status and a message that is safe to show. */
export class AppError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    ;(this as unknown as Record<symbol, boolean>)[APP_ERROR] = true
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return marked(value, APP_ERROR)
  }
}

/**
 * The NeraVeda session is missing, ended or lacks this workspace (401/403/503 from lib/server/auth.ts). Only these
 * responses carry SESSION_HEADER, so the page asks the person to reopen the workspace only when that is the cause —
 * never for a database or other server error that happens to share the status code.
 */
export class SessionError extends AppError {
  constructor(status: number, message: string) {
    super(status, message)
    ;(this as unknown as Record<symbol, boolean>)[SESSION_ERROR] = true
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return marked(value, SESSION_ERROR)
  }
}

export const SESSION_HEADER = "x-neraveda-session"
