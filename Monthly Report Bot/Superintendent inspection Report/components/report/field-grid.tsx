"use client"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { FieldDef, FieldGroup } from "@/lib/form-schema"
import { cn } from "@/lib/utils"
import { useRef, useState, type ReactNode } from "react"
import { FormatToolbar } from "./format-toolbar"

/** Today's date in local time as YYYY-MM-DD (what a date input expects). */
function localToday() {
  return new Date().toLocaleDateString("en-CA")
}

/** Latest date allowed for a field that must be in the past and before another date (e.g. the inspection start). */
export function latestAllowed(before: string | undefined) {
  const today = localToday()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(before ?? "")
  if (!match) return today
  const dayBefore = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - 86_400_000).toISOString().slice(0, 10)
  return dayBefore < today ? dayBefore : today
}

const OTHER = "__other__"

type Props = {
  groups: FieldGroup[]
  values: Record<string, string>
  idPrefix: string
  onChange: (key: string, value: string) => void
  /** Replaces the input of a field (e.g. the Vessel Master picker for Vessel); undefined keeps the standard input. */
  renderField?: (field: FieldDef, id: string) => ReactNode | undefined
}

export function FieldGroups({ groups, values, idPrefix, onChange, renderField }: Props) {
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
            {group.fields.map((field) => {
              const custom = renderField?.(field, `${idPrefix}-${field.key}`)
              return custom ? (
                <div key={field.key} className="contents">{custom}</div>
              ) : (
                <FieldInput
                  key={field.key}
                  id={`${idPrefix}-${field.key}`}
                  field={field}
                  value={values[field.key] ?? ""}
                  max={field.type === "date" && field.before ? latestAllowed(values[field.before]) : undefined}
                  onChange={(v) => onChange(field.key, v)}
                />
              )
            })}
          </div>
        </fieldset>
      ))}
    </div>
  )
}

/** Dropdown of names plus "Other (type a name)". A saved name that is not in the list opens in "Other" mode. */
export function ComboInput({ id, field, value, onChange, disabled }: { id: string; field: FieldDef; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const options = field.options ?? []
  const listed = options.includes(value)
  const [typing, setTyping] = useState(Boolean(value) && !listed)
  const other = typing || (Boolean(value) && !listed)
  return (
    <div className="flex flex-col gap-2">
      <select
        id={id}
        disabled={disabled}
        value={other ? OTHER : value}
        onChange={(e) => {
          const next = e.target.value
          setTyping(next === OTHER)
          onChange(next === OTHER ? (listed ? "" : value) : next)
        }}
        className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-input/30"
      >
        <option value="">Select…</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        <option value={OTHER}>Other (type a name)</option>
      </select>
      {other && (
        <Input
          id={`${id}-other`}
          aria-label={`${field.label} (other)`}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Full name"
          autoFocus={typing && !value}
          className="h-10"
        />
      )}
    </div>
  )
}

export function FieldInput({
  id,
  field,
  value,
  max,
  onChange,
}: {
  id: string
  field: FieldDef
  value: string
  /** Latest allowed date (date fields with `before`). */
  max?: string
  onChange: (value: string) => void
}) {
  const isTextarea = field.type === "textarea"
  const textRef = useRef<HTMLTextAreaElement>(null)
  const span = isTextarea ? 3 : (field.span ?? 1)
  const tooLate = Boolean(max && value && value > max)
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        span === 2 && "sm:col-span-2",
        span === 3 && "sm:col-span-2 lg:col-span-3",
      )}
    >
      <Label htmlFor={id} className="text-sm font-medium">
        <span>
          {field.label}
          {field.required && (
            <>
              {" "}
              <span aria-hidden className="text-destructive" title="Mandatory: the report stays DRAFT until this is completed">*</span>
              <span className="sr-only">(mandatory)</span>
            </>
          )}
        </span>
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
      ) : field.type === "combo" ? (
        <ComboInput id={id} field={field} value={value} onChange={onChange} />
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
            max={max}
            aria-invalid={tooLate || undefined}
            aria-describedby={tooLate ? `${id}-error` : undefined}
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
      {field.hint && <p className="text-xs leading-snug text-muted-foreground">{field.hint}</p>}
      {tooLate && (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive">
          Must be a past date, before the start of this inspection.
        </p>
      )}
    </div>
  )
}
