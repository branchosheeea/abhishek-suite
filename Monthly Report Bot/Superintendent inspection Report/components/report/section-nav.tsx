"use client"

import { Check } from "lucide-react"
import { SECTIONS, type SectionId } from "@/lib/form-schema"
import { cn } from "@/lib/utils"

type Props = {
  active: SectionId
  progress: Record<SectionId, { done: number; total: number }>
  onSelect: (id: SectionId) => void
}

export function SectionNav({ active, progress, onSelect }: Props) {
  return (
    <nav aria-label="Report sections">
      <ol className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        {SECTIONS.map((section, i) => {
          const p = progress[section.id]
          const complete = p.total > 0 && p.done >= p.total
          const isActive = active === section.id
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
                  <span className="font-medium whitespace-nowrap">{section.short}</span>
                  <span
                    className={cn(
                      "hidden font-mono text-[11px] lg:block",
                      isActive ? "text-primary-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    {section.id === "photos" ? (p.done ? "Added" : "None yet") : `${p.done}/${p.total}`}
                  </span>
                </span>
                <span className="sr-only">{complete ? "complete" : `${p.done} of ${p.total} complete`}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
