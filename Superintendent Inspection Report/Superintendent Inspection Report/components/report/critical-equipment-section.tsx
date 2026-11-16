"use client"

import { Checkbox } from "@/components/ui/checkbox"
import { FieldGroups } from "@/components/report/field-grid"
import { CRITICAL_EQUIPMENT_ITEMS, MANAGEMENT_SECTION_GROUPS } from "@/lib/form-schema"

export function CriticalEquipmentSection({
  values,
  onChange,
}: {
  values: Record<string, string>
  onChange: (key: string, value: string) => void
}) {
  const description = MANAGEMENT_SECTION_GROUPS.critical[0].description

  return (
    <div className="flex flex-col gap-6">
      {description && (
        <p className="rounded-lg border border-dashed bg-muted/50 p-3 text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}

      <fieldset className="rounded-xl border bg-card p-4">
        <legend className="px-1 text-sm font-semibold">Select tests carried out</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {CRITICAL_EQUIPMENT_ITEMS.map((item) => (
            <label
              key={item.key}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-sm transition-colors hover:border-border hover:bg-muted/60 has-[:checked]:border-primary/30 has-[:checked]:bg-primary/5"
            >
              <Checkbox
                checked={values[item.key] === "true" || item.legacyKeys?.some((key) => values[key] === "true")}
                onCheckedChange={(checked) => {
                  onChange(item.key, checked ? "true" : "")
                  item.legacyKeys?.forEach((key) => onChange(key, ""))
                }}
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <FieldGroups
        groups={[{ title: "Test Results and Parameters", fields: MANAGEMENT_SECTION_GROUPS.critical[0].fields }]}
        values={values}
        idPrefix="critical"
        onChange={onChange}
      />
    </div>
  )
}
