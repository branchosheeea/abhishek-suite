"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import { cn } from "@/components/ui"
import { SessionGate, useNeraVedaUser } from "./session-gate"

// Mirrors the NeraVeda desktop dashboard and web shell: navy sidebar, brand mark, workspace sections, tagline.
const NAV = [
  { href: "/", label: "Validation sessions", match: (p: string) => p === "/" || p.startsWith("/sessions") },
  { href: "/rules", label: "Rule catalogue", match: (p: string) => p.startsWith("/rules") },
  { href: "/integrity", label: "Storage integrity", match: (p: string) => p.startsWith("/integrity") },
]

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SessionGate>
      <Shell>{children}</Shell>
    </SessionGate>
  )
}

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const user = useNeraVedaUser()
  return (
    <div className="flex min-h-dvh flex-col xl:flex-row">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-shell text-shell-foreground xl:flex">
        <Link href="/" className="flex items-center gap-3.5 px-5 pt-7">
          <BrandMark />
          <span className="flex flex-col">
            <span className="text-base font-bold text-white">NeraVeda</span>
            <span className="text-xs text-shell-muted">Fleet Intelligence Suite</span>
          </span>
        </Link>
        <div className="mx-5 mt-6 mb-5 h-px bg-shell-hover" />
        <p className="px-6 pb-1 text-[11px] font-bold tracking-wider text-shell-muted">WORKSPACE 07</p>
        <p className="px-6 pb-3 text-sm font-semibold text-white">Emissions Validation</p>
        <nav aria-label="Emissions Validation" className="flex flex-col gap-0.5 px-3">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              aria-current={n.match(pathname) ? "page" : undefined}
              className={cn("flex h-10 items-center rounded-lg px-3 text-sm transition-colors hover:bg-shell-hover", n.match(pathname) && "bg-shell-hover font-semibold text-white")}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="flex-1" />
        {user && (
          <p className="mx-5 mb-3 text-xs leading-snug" title={user.sub}>
            <span className="text-shell-muted">Signed in</span>
            <br />
            <span className="font-semibold text-white">{user.name || user.sub}</span>
          </p>
        )}
        <p className="mx-5 rounded-lg bg-shell-hover px-3 py-2 text-xs leading-snug">
          Read-only diagnostics. Original reporting files are never modified, corrected or written back.
        </p>
        <div className="mx-5 mt-4 h-px bg-shell-hover" />
        <p className="px-6 pt-4 text-sm leading-snug">
          Smarter Data.
          <br />
          Sharper Decisions.
          <br />
          Smoother Sailing.
        </p>
        <p className="px-6 pt-2 pb-6 text-xs text-shell-muted">v2026 · AKG</p>
      </aside>

      <header className="flex flex-wrap items-center gap-3 bg-shell px-4 py-2.5 text-shell-foreground xl:hidden">
        <Link href="/" className="flex items-center gap-2.5" aria-label="Emissions Validation home">
          <BrandMark small />
          <span className="text-sm font-bold text-white">Emissions Validation</span>
        </Link>
        <nav aria-label="Emissions Validation" className="ml-auto flex flex-wrap items-center gap-1 text-sm">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={n.match(pathname) ? "page" : undefined} className={cn("rounded-md px-2.5 py-1.5 hover:bg-shell-hover", n.match(pathname) && "bg-shell-hover font-semibold text-white")}>
              {n.label}
            </Link>
          ))}
        </nav>
      </header>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function BrandMark({ small }: { small?: boolean }) {
  return (
    <span aria-hidden className={cn("flex shrink-0 items-center justify-center bg-[#1557A0] font-bold text-white", small ? "size-8 rounded-lg text-base" : "size-11 rounded-xl text-xl")}>
      N
    </span>
  )
}
