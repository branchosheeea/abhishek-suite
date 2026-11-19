"use client"

// Browser-side API calls. Every state-changing request carries the CSRF header the server requires.

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Raised on the window when the NeraVeda session ended (401): the SessionGate shows how to reopen. */
export const SESSION_ENDED = "neraveda:session-ended"

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T
  if ((res.status === 401 || res.status === 503) && typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_ENDED))
  let message = `Request failed (${res.status})`
  try {
    const body = await res.json()
    if (body && typeof body.error === "string") message = body.error
  } catch {
    // keep the generic message
  }
  throw new ApiError(res.status, message)
}

export async function get<T>(path: string): Promise<T> {
  return handle<T>(await fetch(path, { cache: "no-store" }))
}

export async function send<T>(method: "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
  return handle<T>(
    await fetch(path, {
      method,
      headers: { "Content-Type": "application/json", "x-neraveda-request": "1" },
      body: body === undefined ? "{}" : JSON.stringify(body),
    }),
  )
}

export async function upload<T>(kind: string, file: File): Promise<T> {
  return handle<T>(
    await fetch(`/api/sources?kind=${encodeURIComponent(kind)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-neraveda-request": "1", "x-filename": encodeURIComponent(file.name) },
      body: file,
    }),
  )
}

/** A PNG screenshot for the local OCR reader. */
export async function sendImage<T>(path: string, png: Blob, name: string): Promise<T> {
  return handle<T>(
    await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "image/png", "x-neraveda-request": "1", "x-filename": encodeURIComponent(name) },
      body: png,
    }),
  )
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, "Z").replace(/\.\d{3}Z$/, "Z")
}
