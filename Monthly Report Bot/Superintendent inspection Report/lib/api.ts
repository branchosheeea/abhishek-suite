"use client"

// Every call to this app's API goes through apiFetch: writes carry the header the server requires (a cross-origin
// page cannot send it), and an ended NeraVeda session (401/403/503) is announced so the shell can say how to reopen.
// A network error (server not running) is passed through unchanged: drafts keep working offline in this browser.

export const SESSION_ENDED = "neraveda:session-ended"

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase()
  const headers = new Headers(init.headers)
  if (method !== "GET" && method !== "HEAD") headers.set("x-neraveda-request", "1")
  const res = await fetch(input, { ...init, headers })
  if ((res.status === 401 || res.status === 403 || res.status === 503) && typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_ENDED))
  }
  return res
}
