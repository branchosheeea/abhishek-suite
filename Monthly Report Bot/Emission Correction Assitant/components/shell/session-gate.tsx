"use client"

// The workspace opens only through NeraVeda. Pages are static shells; this gate checks the session once on load
// and whenever an API call answers 401, and then shows how to get back in. The server enforces it on every request.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { SESSION_ENDED } from "../api"

export type NeraVedaUser = { sub: string; name: string; admin: boolean }

const UserContext = createContext<NeraVedaUser | null>(null)

export function useNeraVedaUser(): NeraVedaUser | null {
  return useContext(UserContext)
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ok" | "locked">("checking")
  const [user, setUser] = useState<NeraVedaUser | null>(null)

  useEffect(() => {
    let alive = true
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (res) => {
        if (!alive) return
        if (res.ok) {
          setUser((await res.json()) as NeraVedaUser)
          setState("ok")
        } else setState("locked")
      })
      .catch(() => alive && setState("locked"))
    const ended = () => setState("locked")
    window.addEventListener(SESSION_ENDED, ended)
    return () => {
      alive = false
      window.removeEventListener(SESSION_ENDED, ended)
    }
  }, [])

  return (
    <UserContext.Provider value={user}>
      {/* The real protection is on the server (proxy.ts for pages, route() for data); this only avoids showing the
          app before the session is confirmed. */}
      {state === "ok" && children}
      {state === "checking" && <p role="status" className="p-6 text-center text-sm text-muted-foreground">Checking your NeraVeda session…</p>}
      {state === "locked" && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/95 p-4" role="alertdialog" aria-modal="true" aria-labelledby="locked-title">
          <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-xl">
            <h2 id="locked-title" className="text-lg font-bold">Open this workspace from NeraVeda</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your NeraVeda session has ended, or this tab was not opened from NeraVeda. Go to the NeraVeda home screen and click
              <strong> Open Emissions Validation</strong> (or <strong>Open in browser</strong>) to sign in again. Nothing you saved is lost.
            </p>
          </div>
        </div>
      )}
    </UserContext.Provider>
  )
}
