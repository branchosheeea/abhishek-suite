"use client"

// Form primitives for controlled-narrative sections: every control has a visible label, an optional hint, and
// error/warning text tied to it with aria-describedby. Colour is never the only signal (icons and words are used).

import { AlertCircle, AlertTriangle, Info, Lightbulb } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

export type FieldMessages = { error?: string; warning?: string }

export const fieldId = (field: string) => `preamble-${field}`

function describedBy(id: string, hint?: ReactNode, messages: FieldMessages = {}) {
  return [hint && `${id}-hint`, messages.error && `${id}-error`, messages.warning && `${id}-warning`].filter(Boolean).join(" ") || undefined
}

export function RequiredMark() {
  return (
    <>
      <span aria-hidden className="text-destructive">*</span>
      <span className="sr-only">(required)</span>
    </>
  )
}

function Messages({ id, hint, messages }: { id: string; hint?: ReactNode; messages: FieldMessages }) {
  return (
    <>
      {hint && (
        <p id={`${id}-hint`} className="text-xs leading-snug text-muted-foreground">
          {hint}
        </p>
      )}
      {messages.error && (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-xs leading-snug font-medium text-destructive">
          <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="sr-only">Error: </span>
            {messages.error}
          </span>
        </p>
      )}
      {messages.warning && (
        <p id={`${id}-warning`} className="flex items-start gap-1.5 text-xs leading-snug text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="sr-only">Warning: </span>
            {messages.warning}
          </span>
        </p>
      )}
    </>
  )
}

function FieldLabel({ htmlFor, label, required, tooltip }: { htmlFor: string; label: string; required?: boolean; tooltip?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={htmlFor} className="text-sm leading-tight font-medium">
        {label} {required && <RequiredMark />}
      </label>
      {tooltip && <Tooltip text={tooltip} />}
    </div>
  )
}

export function Tooltip({ text }: { text: string }) {
  return (
    <span className="group/tip relative inline-flex">
      <button
        type="button"
        aria-label={`About this field: ${text}`}
        className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Info className="size-3.5" aria-hidden />
      </button>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-30 mb-1.5 w-64 -translate-x-1/2 rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-snug text-background opacity-0 shadow-md transition-opacity group-focus-within/tip:visible group-focus-within/tip:opacity-100 group-hover/tip:visible group-hover/tip:opacity-100"
      >
        {text}
      </span>
    </span>
  )
}

const controlClass =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30"

type BaseProps = {
  field: string
  label: string
  required?: boolean
  hint?: ReactNode
  tooltip?: string
  messages?: FieldMessages
  disabled?: boolean
  className?: string
}

export type SelectOption = { id: string; label: string; disabled?: boolean }

export function SelectField({
  field,
  label,
  required,
  hint,
  tooltip,
  messages = {},
  disabled,
  className,
  value,
  options,
  placeholder,
  onChange,
  recommendation,
}: BaseProps & {
  value: string
  options: readonly SelectOption[]
  placeholder?: string
  onChange: (value: string) => void
  recommendation?: ReactNode
}) {
  const id = fieldId(field)
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <FieldLabel htmlFor={id} label={label} required={required} tooltip={tooltip} />
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={messages.error ? true : undefined}
        aria-describedby={describedBy(id, hint, messages)}
        aria-required={required || undefined}
        className={controlClass}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {recommendation}
      <Messages id={id} hint={hint} messages={messages} />
    </div>
  )
}

export function TextField({
  field,
  label,
  required,
  hint,
  tooltip,
  messages = {},
  disabled,
  className,
  value,
  placeholder,
  onChange,
  type = "text",
  list,
  inputMode,
}: BaseProps & {
  value: string
  placeholder?: string
  onChange: (value: string) => void
  type?: "text" | "date"
  list?: string
  inputMode?: "numeric" | "text"
}) {
  const id = fieldId(field)
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <FieldLabel htmlFor={id} label={label} required={required} tooltip={tooltip} />
      <Input
        id={id}
        type={type}
        value={value}
        list={list}
        inputMode={inputMode}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={messages.error ? true : undefined}
        aria-describedby={describedBy(id, hint, messages)}
        aria-required={required || undefined}
        autoComplete="off"
        className="h-9"
      />
      <Messages id={id} hint={hint} messages={messages} />
    </div>
  )
}

export function TextAreaField({
  field,
  label,
  hint,
  tooltip,
  messages = {},
  disabled,
  className,
  value,
  placeholder,
  onChange,
}: BaseProps & { value: string; placeholder?: string; onChange: (value: string) => void }) {
  const id = fieldId(field)
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <FieldLabel htmlFor={id} label={label} tooltip={tooltip} />
      <Textarea
        id={id}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={messages.error ? true : undefined}
        aria-describedby={describedBy(id, hint, messages)}
        className="min-h-20 resize-y text-sm leading-relaxed"
      />
      <Messages id={id} hint={hint} messages={messages} />
    </div>
  )
}

/** A multi-select checkbox group (spec: MultiSelectField). Exclusive options are handled by the caller's onChange. */
export function MultiSelectField({
  field,
  label,
  required,
  hint,
  tooltip,
  messages = {},
  disabled,
  className,
  options,
  values,
  onToggle,
  recommended = [],
  columns = 1,
}: BaseProps & {
  options: readonly { id: string; label: string }[]
  values: readonly string[]
  onToggle: (id: string, checked: boolean) => void
  recommended?: readonly string[]
  columns?: 1 | 2
}) {
  const id = fieldId(field)
  return (
    <fieldset
      id={id}
      className={cn("flex flex-col gap-2", className)}
      aria-invalid={messages.error ? true : undefined}
      aria-describedby={describedBy(id, hint, messages)}
    >
      <legend className="mb-1 flex items-center gap-1.5 text-sm leading-tight font-medium">
        {label} {required && <RequiredMark />}
        {tooltip && <Tooltip text={tooltip} />}
      </legend>
      <ul className={cn("grid gap-1.5", columns === 2 && "@md:grid-cols-2")}>
        {options.map((option) => {
          const optionId = `${id}-${option.id}`
          const checked = values.includes(option.id)
          const isRecommended = recommended.includes(option.id) && !checked
          return (
            <li key={option.id}>
              <label
                htmlFor={optionId}
                className={cn(
                  "flex h-full cursor-pointer items-start gap-2.5 rounded-lg border bg-card px-3 py-2 text-sm leading-snug transition-colors hover:bg-muted/60 has-data-checked:border-primary/50 has-data-checked:bg-accent",
                  disabled && "cursor-not-allowed opacity-60 hover:bg-card",
                )}
              >
                <Checkbox
                  id={optionId}
                  checked={checked}
                  disabled={disabled}
                  onCheckedChange={(value) => onToggle(option.id, Boolean(value))}
                  className="mt-0.5"
                />
                <span className="flex-1">
                  {option.label}
                  {isRecommended && (
                    <span className="ml-1.5 inline-flex items-center gap-1 rounded-full border border-primary/30 px-1.5 text-[11px] font-medium text-primary">
                      <Lightbulb className="size-3" aria-hidden />
                      Recommended
                    </span>
                  )}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <Messages id={id} hint={hint} messages={messages} />
    </fieldset>
  )
}

/** A single confirmation checkbox, e.g. "Bunkering operations were witnessed". */
export function ConfirmField({
  field,
  label,
  hint,
  messages = {},
  disabled,
  checked,
  onChange,
}: BaseProps & { checked: boolean; onChange: (checked: boolean) => void }) {
  const id = fieldId(field)
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className={cn("flex cursor-pointer items-start gap-2.5 text-sm leading-snug", disabled && "cursor-not-allowed opacity-60")}>
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onChange(Boolean(value))}
          aria-describedby={describedBy(id, hint, messages)}
          className="mt-0.5"
        />
        <span className="font-medium">{label}</span>
      </label>
      <Messages id={id} hint={hint} messages={messages} />
    </div>
  )
}

/** Shows dependent fields only when their condition applies (spec: ConditionalField). */
export function ConditionalField({ show, label, children }: { show: boolean; label?: string; children: ReactNode }) {
  if (!show) return null
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-3 border-l-2 border-primary/25 pl-3">
      {children}
    </div>
  )
}

/** "Recommended for sailing inspections: … [Apply]" — offered, never applied automatically. */
export function Recommendation({ text, onApply, disabled }: { text: string; onApply: () => void; disabled?: boolean }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Lightbulb className="size-3.5 shrink-0 text-primary" aria-hidden />
      <span>{text}</span>
      <Button type="button" variant="link" size="xs" className="h-auto px-0" onClick={onApply} disabled={disabled}>
        Apply
      </Button>
    </p>
  )
}

export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="@container flex flex-col gap-4 rounded-xl border bg-card p-4" aria-labelledby={`${title.replace(/\W+/g, "-")}-title`}>
      <header className="flex flex-col gap-0.5">
        <h3 id={`${title.replace(/\W+/g, "-")}-title`} className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {title}
        </h3>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </header>
      {children}
    </section>
  )
}
