"use client"

// Inspection Reports opens through NeraVeda. Pages are cached shells (offline-first); the server enforces the
// session on every API request. This gate checks it once on load and whenever an API call answers 401/403/503:
//   - signed in: normal use, the person's name is shown in the sidebar
//   - refused: a panel explains how to reopen from NeraVeda (drafts saved in this browser are kept)
//   - server not running: a quiet note; drafts keep working offline and sync after reopening from NeraVeda

import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { SESSION_ENDED } from "@/lib/api"

export type NeraVedaUser = { sub: string; name: string; admin: boolean; modules?: string[] }

const UserContext = createContext<NeraVedaUser | null>(null)

export function useNeraVedaUser(): NeraVedaUser | null {
  return useContext(UserContext)
}

export function SessionGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ok" | "locked" | "offline">("checking")
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
      .catch(() => alive && setState("offline"))
    const ended = () => setState("locked")
    window.addEventListener(SESSION_ENDED, ended)
    return () => {
      alive = false
      window.removeEventListener(SESSION_ENDED, ended)
    }
  }, [])

  return (
    <UserContext.Provider value={user}>
      {state === "offline" && (
        <p role="status" className="bg-amber-50 px-4 py-2 text-center text-xs text-amber-900">
          Working offline in this browser. Drafts are kept here and sync when you open Inspection Reports from NeraVeda.
        </p>
      )}
      {/* The real protection is on the server (proxy.ts for pages, route() for data); this only avoids showing the
          app before the session is confirmed. "offline" = the NeraVeda server is not running: drafts stay usable. */}
      {(state === "ok" || state === "offline") && children}
      {state === "checking" && <p role="status" className="p-6 text-center text-sm text-muted-foreground">Checking your NeraVeda session…</p>}
      {state === "locked" && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/95 p-4" role="alertdialog" aria-modal="true" aria-labelledby="locked-title">
          <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-xl">
            <h2 id="locked-title" className="text-lg font-bold">Open Inspection Reports from NeraVeda</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Your NeraVeda session has ended, or this tab was not opened from NeraVeda. Go to the NeraVeda home screen and click
              <strong> Open Inspection Reports</strong> (or <strong>Open in browser</strong>) to sign in again. Drafts saved in this browser are kept.
            </p>
          </div>
        </div>
      )}
    </UserContext.Provider>
  )
}
