"use client"

// Guarantee Claim Manager frame: module header, vessel context, global search (Ctrl+K), the true Outlook sync state,
// the four sections, and the Claim Inspector side panel that any claim row can open.
// The vessel is in the address (?vessel=<id>) so every section and link keeps it; without it the first tracked
// vessel with claims is used (gc_manager/views.py scope).

import { CloudOff, Mail, Search, TriangleAlert } from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react"
import useSWR, { type KeyedMutator } from "swr"
import { ModuleBadge } from "@/components/shell/app-shell"
import { WEB_MODULES } from "@/lib/modules"
import { cn } from "@/lib/utils"
import { ClaimInspector } from "./claim-inspector"
import { API, formatStamp, getJson, type Overview, query, type Sync } from "./client"
import { SearchDialog } from "./search-dialog"
import { Skeleton } from "./states"

const MODULE = WEB_MODULES.find((m) => m.id === "claims")!

type Frame = {
  vesselParam: string | null; overview: Overview | undefined; error: unknown; isLoading: boolean; refresh: KeyedMutator<Overview>
  /** Open the Claim Inspector; focus goes back to `origin` (or the element that had it) when it closes. */
  inspect: (claimId: number, origin?: HTMLElement | null) => void
  inspecting: number | null
}
const FrameContext = createContext<Frame | null>(null)

export function useFrame(): Frame {
  const frame = useContext(FrameContext)
  if (!frame) throw new Error("useFrame outside GcFrame")
  return frame
}

/** A link inside the module that keeps the chosen vessel. */
export function useHref() {
  const { vesselParam } = useFrame()
  return (path: string, extra: Record<string, string | number | null | undefined> = {}) => `${path}${query({ vessel: vesselParam, ...extra })}`
}

const SECTIONS = [
  { href: "/claims", label: "Command Centre", exact: true },
  { href: "/claims/register", label: "Claim Register" },
  { href: "/claims/correspondence", label: "Correspondence" },
  { href: "/claims/reviews", label: "Review Queue" },
] as const

export function GcFrame({ children }: { children: ReactNode }) {
  const params = useSearchParams()
  const vesselParam = params.get("vessel")
  const { data, error, isLoading, mutate } = useSWR(`${API}/overview${query({ vessel: vesselParam })}`, (path: string) => getJson<Overview>(path), { revalidateOnFocus: true })
  const [inspecting, setInspecting] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const origin = useRef<HTMLElement | null>(null)
  const pathname = usePathname()

  const inspect = useCallback((claimId: number, from?: HTMLElement | null) => {
    origin.current = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setInspecting(claimId)
  }, [])
  const close = useCallback(() => {
    setInspecting(null)
    const back = origin.current
    origin.current = null
    if (back && back.isConnected) requestAnimationFrame(() => back.focus())
  }, [])
  useEffect(() => setInspecting(null), [pathname]) // a new page starts without a panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setSearching(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const href = (path: string) => `${path}${query({ vessel: vesselParam })}`
  return (
    <FrameContext.Provider value={{ vesselParam, overview: data, error, isLoading, refresh: mutate, inspect, inspecting }}>
      <main className={cn("mx-auto flex w-full max-w-[1440px] flex-col gap-5 px-4 py-7 sm:px-8", inspecting !== null && "min-[1500px]:pr-[480px]")}>
        <Header overview={data} loading={isLoading} onSearch={() => setSearching(true)} />
        <Sections reviewCount={data?.reviews?.open} />
        {children}
      </main>
      {inspecting !== null && <ClaimInspector claimId={inspecting} href={href} onClose={close} />}
      {searching && (
        <SearchDialog
          vesselParam={vesselParam}
          onClose={() => setSearching(false)}
          onPick={(claimId) => { setSearching(false); inspect(claimId, null) }}
        />
      )}
    </FrameContext.Provider>
  )
}

function Header({ overview, loading, onSearch }: { overview: Overview | undefined; loading: boolean; onSearch: () => void }) {
  const router = useRouter()
  const pathname = usePathname()
  const vessels = overview?.scope.vessels ?? []
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b pb-5">
      <div className="flex items-center gap-3.5">
        <ModuleBadge module={MODULE} large />
        <div>
          <p className="text-[10px] font-bold tracking-wide" style={{ color: MODULE.accent }}>{MODULE.eyebrow}</p>
          <h1 className="text-[28px] leading-tight font-bold tracking-tight">Guarantee Claims</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {loading && !overview ? (
              <Skeleton className="h-5 w-40" />
            ) : vessels.length > 1 ? (
              <label className="flex items-center gap-2">
                <span>Vessel</span>
                <select
                  value={overview?.vessel?.id ?? ""}
                  onChange={(e) => router.push(`${pathname}${query({ vessel: e.target.value })}`)}
                  className="h-8 rounded-md border bg-background px-2 text-sm font-semibold text-foreground"
                >
                  {vessels.map((v) => <option key={v.id} value={v.id}>{v.name} · {v.claims} claims</option>)}
                </select>
              </label>
            ) : overview?.vessel ? (
              <span><span className="font-semibold text-foreground">{overview.vessel.name}</span> · {overview.vessel.claims} claims</span>
            ) : overview ? (
              <span>No tracked vessel has claims yet</span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <button
          type="button"
          onClick={onSearch}
          aria-keyshortcuts="Control+K"
          className="inline-flex h-10 w-64 items-center gap-2 rounded-lg border bg-background px-3 text-sm text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Search className="size-4" aria-hidden />
          <span className="flex-1 text-left">Search claims and emails</span>
          <kbd className="rounded border bg-muted px-1.5 text-[11px] font-medium">Ctrl K</kbd>
        </button>
        {overview && <SyncState sync={overview.sync} />}
      </div>
    </header>
  )
}

/** Only what the records show: when a sync last started, when a mailbox folder was last read, the last error. */
function SyncState({ sync }: { sync: Sync }) {
  if (!sync.enabled || !sync.configured) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CloudOff className="size-4" aria-hidden /> Outlook is not connected on this PC
      </p>
    )
  }
  if (sync.last_error) {
    return (
      <div className="flex max-w-md items-start gap-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground dark:text-warning" aria-hidden />
        <div>
          <p className="font-semibold">Correspondence sync interrupted</p>
          <p className="text-xs text-muted-foreground">
            {sync.last_attempt_at ? `Last attempt ${formatStamp(sync.last_attempt_at)}. ` : ""}
            {sync.last_folder_read_at ? `A mailbox folder was last read ${formatStamp(sync.last_folder_read_at)}. ` : ""}
            Newer emails may not be shown yet.
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground" title={sync.last_error}>{sync.last_error}</p>
        </div>
      </div>
    )
  }
  return (
    <p className="flex flex-col items-end text-right text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 text-sm text-foreground"><Mail className="size-4" aria-hidden /> Outlook (read-only)</span>
      <span>{sync.last_attempt_at ? `Last sync started ${formatStamp(sync.last_attempt_at)}` : "No sync has run yet"}</span>
      {sync.last_folder_read_at && <span>Last folder read {formatStamp(sync.last_folder_read_at)}</span>}
    </p>
  )
}

function Sections({ reviewCount }: { reviewCount: number | undefined }) {
  const pathname = usePathname()
  const href = useHref()
  return (
    <nav aria-label="Guarantee Claim sections" className="-mt-1 flex flex-wrap gap-1">
      {SECTIONS.map((s) => {
        const active = "exact" in s ? pathname === s.href : pathname === s.href || pathname.startsWith(`${s.href}/`)
        return (
          <Link
            key={s.href}
            href={href(s.href)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-10 items-center gap-2 rounded-lg px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              active && "bg-secondary text-foreground",
            )}
          >
            {s.label}
            {s.href === "/claims/reviews" && reviewCount !== undefined && reviewCount > 0 && (
              <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-foreground">{reviewCount}</span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
