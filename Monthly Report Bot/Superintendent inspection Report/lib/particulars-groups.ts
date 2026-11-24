// The six Vessel Master groups (A-F) as report fields, for reports with a vesselSnapshot (lib/particulars.ts).
// Separate from lib/particulars.ts so lib/form-schema.ts can use it without an import cycle (types only from there).

import type { FieldDef, FieldGroup } from "./form-schema"
import { FIELDS, SIR_GROUPS } from "./vessel-master/fields"

/** Long text fields: full width in the editor, full-width rows in the PDF. */
export const WIDE_KEYS = new Set(["class_notation", "fuel_basis", "me_system_oil", "me_cylinder_oil", "dg_lube_oil", "main_engine"])
const PAIR_LABEL: Record<string, string> = { mcr_rpm: "MCR at", ncr_rpm: "NCR/CSR at", fuel_laden_speed_kn: "at laden speed", fuel_ballast_speed_kn: "at ballast speed" }

/** Master-only fields (statutory power, public fleet DWT) are not part of a report. */
export const PARTICULARS_GROUPS_V2: FieldGroup[] = SIR_GROUPS.map((g) => ({
  title: `${g.id} · ${g.title}`,
  fields: FIELDS.filter((f) => f.group === g.id).map<FieldDef>((f) => ({
    key: f.key, label: PAIR_LABEL[f.key] ?? f.label, unit: f.unit, required: f.required, span: WIDE_KEYS.has(f.key) ? 3 : 1,
  })),
}))
export const V2_KEYS = PARTICULARS_GROUPS_V2.flatMap((g) => g.fields.map((f) => f.key))
