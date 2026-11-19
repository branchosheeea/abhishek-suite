"use client"

import { House } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import { WEB_MODULES, moduleForPath, type WebModule } from "@/lib/modules"
import { cn } from "@/lib/utils"
import { SessionGate, useNeraVedaUser } from "./session-gate"

// Mirrors the NeraVeda desktop dashboard: navy sidebar, brand mark, workspace list, tagline.
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <SessionGate>
      <Shell>{children}</Shell>
    </SessionGate>
  )
}

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const current = moduleForPath(pathname)
  const onHome = pathname === "/"
  const user = useNeraVedaUser()

  return (
    <div className="flex min-h-dvh flex-col xl:flex-row">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col bg-shell text-shell-foreground xl:flex">
        <Link href="/" className="flex items-center gap-3.5 px-5 pt-7 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-shell-muted">
          <BrandMark />
          <span className="flex flex-col">
            <span className="text-base font-bold text-white">NeraVeda</span>
            <span className="text-xs text-shell-muted">Fleet Intelligence Suite</span>
          </span>
        </Link>
        <div className="mx-5 mt-6 mb-5 h-px bg-shell-hover" />
        <p className="px-6 pb-2 text-[11px] font-bold tracking-wider text-shell-muted">WORKSPACES</p>
        <nav aria-label="NeraVeda workspaces" className="flex flex-col gap-0.5 px-3">
          <SideLink href="/" label="Home" active={onHome} badge={<House className="size-4" aria-hidden />} />
          {WEB_MODULES.map((m) => (
            <SideLink key={m.id} href={m.href} label={m.navLabel} active={current?.id === m.id} badge={<ModuleBadge module={m} />} />
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
        <div className="mx-5 h-px bg-shell-hover" />
        <p className="px-6 pt-4 text-sm leading-snug">
          Smarter Data.
          <br />
          Sharper Decisions.
          <br />
          Smoother Sailing.
        </p>
        <p className="px-6 pt-2 pb-6 text-xs text-shell-muted">v2026 · AKG</p>
      </aside>

      <header className="flex items-center gap-3 bg-shell px-4 py-2.5 text-shell-foreground xl:hidden">
        <Link href="/" className="flex items-center gap-2.5" aria-label="NeraVeda home">
          <BrandMark small />
          <span className="text-sm font-bold text-white">NeraVeda</span>
        </Link>
        <nav aria-label="NeraVeda workspaces" className="ml-auto flex items-center gap-1 text-sm">
          <TopLink href="/" active={onHome}>
            Home
          </TopLink>
          {WEB_MODULES.map((m) => (
            <TopLink key={m.id} href={m.href} active={current?.id === m.id}>
              {m.navLabel}
            </TopLink>
          ))}
        </nav>
      </header>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function BrandMark({ small }: { small?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center bg-[#1557A0] font-bold text-white",
        small ? "size-8 rounded-lg text-base" : "size-11 rounded-xl text-xl",
      )}
    >
      N
    </span>
  )
}

export function ModuleBadge({ module, large }: { module: WebModule; large?: boolean }) {
  return (
    <span
      aria-hidden
      style={{ backgroundColor: module.tint, color: module.accent }}
      className={cn(
        "flex shrink-0 items-center justify-center font-bold",
        large ? "size-12 rounded-xl text-xs" : "size-7 rounded-md text-[8px]",
      )}
    >
      {module.badge}
    </span>
  )
}

function SideLink({ href, label, active, badge }: { href: string; label: string; active: boolean; badge: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-11 items-center gap-3 rounded-lg px-2.5 text-sm transition-colors hover:bg-shell-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-shell-muted",
        active && "bg-shell-hover font-semibold text-white",
      )}
    >
      <span className="flex size-7 items-center justify-center">{badge}</span>
      {label}
    </Link>
  )
}

function TopLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn("rounded-md px-2.5 py-1.5 hover:bg-shell-hover", active && "bg-shell-hover font-semibold text-white")}
    >
      {children}
    </Link>
  )
}
