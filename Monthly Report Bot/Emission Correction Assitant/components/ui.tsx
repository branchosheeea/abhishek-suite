// Small UI primitives in the NeraVeda look (no component library).
import type { ButtonHTMLAttributes, ReactNode } from "react"

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ")
}

type Variant = "primary" | "secondary" | "ghost" | "danger"

export function Button({ variant = "primary", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-primary text-primary-foreground hover:opacity-90",
        variant === "secondary" && "border bg-card text-foreground hover:bg-muted",
        variant === "ghost" && "text-primary hover:bg-muted",
        variant === "danger" && "border border-critical/30 bg-critical-bg text-critical hover:opacity-90",
        className,
      )}
    />
  )
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border bg-card", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          {title && <h2 className="text-sm font-bold">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export type Tone = "neutral" | "good" | "warning" | "critical" | "info"

const TONE: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  good: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  critical: "bg-critical-bg text-critical",
  info: "bg-info-bg text-primary",
}

const ICON: Record<Tone, string> = { neutral: "•", good: "✓", warning: "●", critical: "▲", info: "i" }

/** Status pill: icon + label, so state is never carried by colour alone. */
export function Pill({ tone = "neutral", children, icon = true }: { tone?: Tone; children: ReactNode; icon?: boolean }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-semibold", TONE[tone])}>
      {icon && <span aria-hidden>{ICON[tone]}</span>}
      {children}
    </span>
  )
}

export function severityTone(severity: string): Tone {
  return severity === "error" ? "critical" : severity === "warning" ? "warning" : "neutral"
}

export function Stat({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: Tone }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card px-4 py-3">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      <span className="text-2xl font-bold">{value}</span>
      {note && <span className="text-xs text-muted-foreground">{tone ? <Pill tone={tone}>{note}</Pill> : note}</span>}
    </div>
  )
}

export function Banner({ tone = "info", title, children }: { tone?: Tone; title: ReactNode; children?: ReactNode }) {
  return (
    <div role={tone === "critical" ? "alert" : "status"} className={cn("rounded-xl border px-4 py-3 text-sm", TONE[tone])}>
      <p className="font-bold">
        <span aria-hidden className="mr-1">{ICON[tone]}</span>
        {title}
      </p>
      {children && <div className="mt-1 text-foreground/90">{children}</div>}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm">
      <span className="font-semibold">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

export const inputClass = "h-9 w-full rounded-lg border border-input bg-card px-2.5 text-sm"

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">{children}</p>
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-xs break-all", className)}>{children}</span>
}
