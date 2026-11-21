"use client"

import Link from "next/link"
import { buttonVariants } from "@/components/ui/button"
import { modulesFor } from "@/lib/modules"
import { ModuleBadge } from "./app-shell"
import { useNeraVedaUser } from "./session-gate"

/** The web workspaces this person may use, as cards. */
export function ModuleCards() {
  const user = useNeraVedaUser()
  return (
    <ul className="grid gap-5 md:grid-cols-2">
      {modulesFor(user?.modules).map((m) => (
        <li key={m.id} className="flex flex-col rounded-2xl border bg-card p-5 pt-3">
          <span aria-hidden className="mb-4 h-1 rounded-full" style={{ backgroundColor: m.accent }} />
          <div className="flex items-center gap-3.5">
            <ModuleBadge module={m} large />
            <div className="flex min-w-0 flex-col">
              <span className="text-[10px] font-bold tracking-wide" style={{ color: m.accent }}>
                {m.eyebrow}
              </span>
              <h2 className="text-lg font-bold">{m.title}</h2>
            </div>
          </div>
          <p className="mt-3 text-sm text-muted-foreground text-pretty">{m.description}</p>
          <div className="mt-5 border-t pt-4">
            <Link href={m.href} className={buttonVariants({ size: "lg" })}>
              {m.cta}
            </Link>
          </div>
        </li>
      ))}
    </ul>
  )
}
