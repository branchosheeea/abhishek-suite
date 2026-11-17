"use client"

// Renders a section's field specs with the shared form primitives. Conditional fields appear only when their rule
// applies; item lists ("Add problem", "Add inspection") are edited in place.

import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ReportContext } from "@/lib/narrative/context"
import {
  isShown,
  normaliseItem,
  sectionFieldId,
  type FieldSpec,
  type InputValue,
  type ItemFieldSpec,
  type ItemValue,
  type ItemsSpec,
  type SectionInputs,
  type SectionSpec,
} from "@/lib/narrative/section"
import type { ValidationResult } from "@/lib/narrative/types"
import { cn } from "@/lib/utils"
import { ConfirmField, FormSection, MultiSelectField, SelectField, TextAreaField, TextField, type FieldMessages } from "../preamble/fields"

type Props = {
  spec: SectionSpec
  inputs: SectionInputs
  ctx: ReportContext
  validation: ValidationResult
  disabled: boolean
  set: (patch: SectionInputs) => void
}

function messagesFor(validation: ValidationResult, id: string): FieldMessages {
  return {
    error: validation.errors.find((issue) => issue.field === id)?.message,
    warning: validation.warnings.find((issue) => issue.field === id)?.message,
  }
}

/** Toggles an option in a multi-select, honouring an exclusive option and keeping the fixed option order. */
function toggle(options: readonly { id: string }[], current: string[], id: string, checked: boolean, exclusive?: string) {
  let next: string[]
  if (!checked) next = current.filter((value) => value !== id)
  else if (exclusive && id === exclusive) next = [exclusive]
  else next = [...current.filter((value) => value !== exclusive), id]
  return options.map((o) => o.id).filter((optionId) => next.includes(optionId))
}

function ScalarField({
  field,
  id,
  value,
  onChange,
  validation,
  disabled,
}: {
  field: ItemFieldSpec | Extract<FieldSpec, { kind: "note" }>
  id: string
  value: InputValue | undefined
  onChange: (value: InputValue) => void
  validation: ValidationResult
  disabled: boolean
}) {
  const messages = messagesFor(validation, id)
  const common = { field: field.key, id, label: field.label, required: field.required, hint: field.hint, tooltip: field.tooltip, messages, disabled }
  const wide = field.wide || field.kind === "multi" || field.kind === "note" || field.kind === "confirm"
  const className = cn(wide && "@md:col-span-2")
  switch (field.kind) {
    case "select":
      return (
        <SelectField
          {...common}
          className={className}
          value={typeof value === "string" ? value : ""}
          options={field.options}
          placeholder={field.placeholder ?? "Select…"}
          onChange={onChange}
        />
      )
    case "multi":
      return (
        <MultiSelectField
          {...common}
          className={className}
          options={field.options}
          values={Array.isArray(value) ? (value as string[]) : []}
          columns={field.columns}
          onToggle={(optionId, checked) => onChange(toggle(field.options, Array.isArray(value) ? (value as string[]) : [], optionId, checked, field.exclusive))}
        />
      )
    case "confirm":
      return (
        <div className={className}>
          <ConfirmField {...common} hint={field.hint ?? field.tooltip} checked={value === true} onChange={onChange} />
        </div>
      )
    case "note":
      return <TextAreaField {...common} className={className} value={typeof value === "string" ? value : ""} placeholder={field.placeholder} onChange={onChange} />
    default:
      return (
        <TextField
          {...common}
          className={className}
          type={field.kind === "date" ? "date" : "text"}
          value={typeof value === "string" ? value : ""}
          placeholder={field.kind === "text" ? field.placeholder : undefined}
          onChange={onChange}
        />
      )
  }
}

function ItemsField({ spec, field, inputs, ctx, validation, disabled, set }: Props & { field: ItemsSpec }) {
  const stored = (inputs[field.key] as ItemValue[] | undefined) ?? []
  const id = sectionFieldId(spec.id, field.key)
  const messages = messagesFor(validation, id)
  const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `item-${Date.now()}-${Math.random()}`)
  // A list that needs at least one entry opens with a blank entry ready to type into; it is stored on first edit.
  const pending = stored.length === 0 && !!field.required && !disabled
  const list = pending ? [{ ...normaliseItem(field.fields, {}, 0), id: "pending" }] : stored
  const write = (next: ItemValue[]) => set({ [field.key]: next.map((item) => (item.id === "pending" ? { ...item, id: newId() } : item)) })
  const add = () => write([...list, { ...normaliseItem(field.fields, {}, list.length), id: newId() }])
  return (
    <div id={id} className="flex flex-col gap-3 @md:col-span-2" role="group" aria-label={field.label}>
      {list.map((item, index) => (
        <section key={item.id} aria-label={`${field.itemLabel} ${index + 1}`} className="flex flex-col gap-3 rounded-lg border bg-background p-3">
          <header className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">
              {field.itemLabel} {index + 1}
            </h4>
            {!pending && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => write(list.filter((_, i) => i !== index))}
                aria-label={`Remove ${field.itemLabel.toLowerCase()} ${index + 1}`}
              >
                <Trash2 aria-hidden />
                Remove
              </Button>
            )}
          </header>
          <div className="grid gap-4 @md:grid-cols-2">
            {field.fields
              .filter((sub) => isShown(sub, item, ctx, inputs))
              .map((sub) => (
                <ScalarField
                  key={sub.key}
                  field={sub}
                  id={sectionFieldId(spec.id, field.key, index, sub.key)}
                  value={item[sub.key]}
                  validation={validation}
                  disabled={disabled}
                  onChange={(value) => write(list.map((it, i) => (i === index ? { ...it, [sub.key]: value as ItemValue[string] } : it)))}
                />
              ))}
          </div>
        </section>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={add} disabled={disabled || list.length >= field.max}>
          <Plus aria-hidden />
          {field.addLabel ?? `Add ${field.itemLabel.toLowerCase()}`}
        </Button>
        {list.length >= field.max && <span className="text-xs text-muted-foreground">Maximum of {field.max} reached.</span>}
      </div>
      {messages.error && <p className="text-xs font-medium text-destructive">{messages.error}</p>}
    </div>
  )
}

export function SpecForm(props: Props) {
  const { spec, inputs, ctx, validation, disabled, set } = props
  return (
    <>
      {spec.groups
        .filter((group) => isShown(group, inputs, ctx, inputs))
        .map((group) => (
          <FormSection key={group.title} title={group.title} description={group.description}>
            <div className="grid gap-4 @md:grid-cols-2">
              {group.fields
                .filter((field) => isShown(field, inputs, ctx, inputs))
                .map((field) =>
                  field.kind === "items" ? (
                    <ItemsField key={field.key} {...props} field={field} />
                  ) : (
                    <ScalarField
                      key={field.key}
                      field={field}
                      id={sectionFieldId(spec.id, field.key)}
                      value={inputs[field.key]}
                      validation={validation}
                      disabled={disabled}
                      onChange={(value) => set({ [field.key]: value })}
                    />
                  ),
                )}
            </div>
          </FormSection>
        ))}
    </>
  )
}
