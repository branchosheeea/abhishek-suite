/** An error with an HTTP status and a message that is safe to show. */
export class AppError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * The NeraVeda session is missing, ended or lacks this workspace (401/403/503 from lib/server/auth.ts). Only these
 * responses carry SESSION_HEADER, so the page asks the person to reopen the workspace only when that is the cause —
 * never for a database or other server error that happens to share the status code.
 */
export class SessionError extends AppError {}

export const SESSION_HEADER = "x-neraveda-session"
