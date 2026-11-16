"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { FieldDef, FieldGroup } from "@/lib/form-schema"
import { cn } from "@/lib/utils"
import { useRef } from "react"
import { FormatToolbar } from "./format-toolbar"

type Props = {
  groups: FieldGroup[]
  values: Record<string, string>
  idPrefix: string
  onChange: (key: string, value: string) => void
}

export function FieldGroups({ groups, values, idPrefix, onChange }: Props) {
  return (
    <div className="flex flex-col gap-8">
      {groups.map((group, gi) => (
        <fieldset key={group.title ?? gi} className="flex flex-col gap-4">
          {group.title && (
            <legend className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.title}
            </legend>
          )}
          {group.description && (
            <p className="-mt-2 rounded-lg border border-dashed bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
              {group.description}
            </p>
          )}
          <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
            {group.fields.map((field) => (
              <FieldInput
                key={field.key}
                id={`${idPrefix}-${field.key}`}
                field={field}
                value={values[field.key] ?? ""}
                onChange={(v) => onChange(field.key, v)}
              />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  )
}

export function FieldInput({
  id,
  field,
  value,
  onChange,
}: {
  id: string
  field: FieldDef
  value: string
  onChange: (value: string) => void
}) {
  const isTextarea = field.type === "textarea"
  const textRef = useRef<HTMLTextAreaElement>(null)
  const span = isTextarea ? 3 : (field.span ?? 1)
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        span === 2 && "sm:col-span-2",
        span === 3 && "sm:col-span-2 lg:col-span-3",
      )}
    >
      <Label htmlFor={id} className="text-sm font-medium">
        {field.label}
        {field.unit && <span className="font-normal text-muted-foreground">({field.unit})</span>}
      </Label>
      {isTextarea ? (
        <div><FormatToolbar value={value} onChange={onChange} inputRef={textRef} /><Textarea
          id={id}
          ref={textRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? "Enter observations…"}
          className="min-h-28 resize-y rounded-t-none leading-relaxed"
        /></div>
      ) : field.type === "select" ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          <option value="">Select…</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ) : (
        <div className="relative">
          <Input
            id={id}
            type={field.type === "date" ? "date" : "text"}
            inputMode={field.type === "number" || field.unit ? "decimal" : undefined}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={field.placeholder}
            className={cn("h-10", field.unit && "pr-16")}
          />
          {field.unit && (
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-xs text-muted-foreground">
              {field.unit}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
