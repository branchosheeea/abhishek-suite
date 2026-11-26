"use client"

// Guarantee Claim Manager: loading, error and "nothing recorded" states. A failure is never shown as zero.
import { CircleAlert, PlugZap, ShieldAlert, WifiOff } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { NOT_RECORDED, RequestFailed } from "./client"

export function ErrorPanel({ error, what }: { error: unknown; what: string }) {
  const status = error instanceof RequestFailed ? error.status : -1
  const message = error instanceof Error ? error.message : String(error)
  const [Icon, title] =
    status === 0 ? [WifiOff, "Not connected"]
      : status === 401 || status === 403 ? [ShieldAlert, "No access"]
        : status === 503 || status === 504 ? [PlugZap, "Claim service unavailable"]
          : status === 404 ? [CircleAlert, "Not found"]
            : [CircleAlert, `Could not load ${what}`]
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
      <Icon className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
      <div>
        <p className="font-semibold text-destructive">{title}</p>
        <p className="mt-0.5 text-foreground/80">{message}</p>
        <p className="mt-1 text-xs text-muted-foreground">Nothing is shown for {what} until it loads, so no figure here can be mistaken for a real zero.</p>
      </div>
    </div>
  )
}

/** Grey blocks in the shape of the content that is loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-lg bg-muted", className)} />
}

export function Loading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" aria-label={label}>
      {children}
    </div>
  )
}

/** A value, or "Not recorded" in a quieter style. */
export function Value({ value, children }: { value: unknown; children?: ReactNode }) {
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground italic">{NOT_RECORDED}</span>
  return <>{children ?? String(value)}</>
}
