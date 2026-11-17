"use client"

import { Check } from "lucide-react"
import type { Outstanding } from "@/lib/completeness"
import { SECTIONS, type SectionId } from "@/lib/form-schema"
import { cn } from "@/lib/utils"

type Props = {
  active: SectionId
  progress: Record<SectionId, { done: number; total: number }>
  /** Mandatory items still outstanding, by section: shown as a red * */
  outstanding?: Map<SectionId, Outstanding[]>
  onSelect: (id: SectionId) => void
}

export function SectionNav({ active, progress, outstanding, onSelect }: Props) {
  return (
    <nav aria-label="Report sections">
      <ol className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {SECTIONS.map((section, i) => {
          const p = progress[section.id]
          const complete = p.total > 0 && p.done >= p.total
          const isActive = active === section.id
          const missing = outstanding?.get(section.id)?.length ?? 0
          return (
            <li key={section.id} className="shrink-0">
              <button
                type="button"
                onClick={() => onSelect(section.id)}
                aria-current={isActive ? "step" : undefined}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-[11px]",
                    isActive && "border-primary-foreground/40",
                    !isActive && complete && "border-success bg-success text-success-foreground",
                  )}
                >
                  {complete && !isActive ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className="flex flex-1 flex-col">
                  <span className="font-medium whitespace-nowrap">
                    {section.short}
                    {missing > 0 && (
                      <span aria-hidden className={cn("ml-1", isActive ? "text-primary-foreground" : "text-destructive")} title={`${missing} mandatory item(s) outstanding`}>
                        *
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "hidden font-mono text-[11px] lg:block",
                      isActive ? "text-primary-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    {section.id === "photos" ? (p.done ? "Added" : "None yet") : `${p.done}/${p.total}`}
                  </span>
                </span>
                <span className="sr-only">
                  {complete ? "complete" : `${p.done} of ${p.total} complete`}
                  {missing > 0 ? `, ${missing} mandatory item${missing === 1 ? "" : "s"} outstanding` : ""}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
