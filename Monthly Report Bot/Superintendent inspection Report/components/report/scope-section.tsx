"use client"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { SCOPE_ITEMS } from "@/lib/form-schema"

type Props = {
  values: Record<string, boolean>
  onChange: (values: Record<string, boolean>) => void
}

export function ScopeSection({ values, onChange }: Props) {
  const checked = SCOPE_ITEMS.filter((s) => values[s.key]).length
  const allChecked = checked === SCOPE_ITEMS.length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          The scope of this inspection covered the following areas.{" "}
          <span className="font-mono font-semibold text-foreground">
            {checked}/{SCOPE_ITEMS.length}
          </span>{" "}
          selected.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            onChange(Object.fromEntries(SCOPE_ITEMS.map((s) => [s.key, !allChecked])))
          }
        >
          {allChecked ? "Clear all" : "Select all"}
        </Button>
      </div>
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
        {SCOPE_ITEMS.map((item, i) => {
          const id = `scope-${item.key}`
          return (
            <li key={item.key}>
              <label
                htmlFor={id}
                className="flex h-full cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 text-sm leading-snug transition-colors hover:bg-muted/60 has-data-checked:border-primary/50 has-data-checked:bg-accent"
              >
                <Checkbox
                  id={id}
                  checked={Boolean(values[item.key])}
                  onCheckedChange={(v) => onChange({ ...values, [item.key]: Boolean(v) })}
                  className="mt-0.5"
                />
                <span className="flex-1">
                  <span className="mr-1.5 font-mono text-xs text-muted-foreground">{String(i + 1).padStart(2, "0")}</span>
                  {item.label}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
