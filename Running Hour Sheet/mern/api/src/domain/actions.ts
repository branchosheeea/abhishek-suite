import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateVesselState, type VesselState } from "./state.js";

const yearSchema = z.string().regex(/^\d{4}$/);
const equipmentGroupSchema = z.enum([
  "power-generation",
  "purifiers",
  "fo-purification",
  "lo-purification",
  "boilers",
  "compressed-air",
  "refrigeration",
  "egcs",
  "inert-gas",
  "auxiliaries"
]);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("vessel"), revision: z.number().int().nonnegative(), name: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal("add"), revision: z.number().int().nonnegative(), year: yearSchema, name: z.string().trim().min(1).max(100), group: equipmentGroupSchema.default("auxiliaries") }),
  z.object({ type: z.literal("rename"), revision: z.number().int().nonnegative(), id: z.string().min(1), name: z.string().trim().min(1).max(100), group: equipmentGroupSchema.optional() }),
  z.object({ type: z.literal("group"), revision: z.number().int().nonnegative(), id: z.string().min(1), group: equipmentGroupSchema }),
  z.object({ type: z.literal("active"), revision: z.number().int().nonnegative(), year: yearSchema, id: z.string().min(1), active: z.boolean() }),
  z.object({ type: z.literal("readings"), revision: z.number().int().nonnegative(), year: yearSchema, id: z.string().min(1), readings: z.array(z.number().finite().nonnegative().nullable()).length(13) }),
  z.object({ type: z.literal("rollover"), revision: z.number().int().nonnegative(), year: yearSchema }),
  z.object({
    type: z.literal("monthly_entry"),
    revision: z.number().int().nonnegative(),
    year: yearSchema,
    month: z.number().int().min(0).max(11),
    engineer: z.string().trim().min(1).max(100),
    entries: z.array(z.object({
      id: z.string().min(1),
      begin: z.number().finite().nonnegative().nullable(),
      end: z.number().finite().nonnegative().nullable(),
      note: z.string().max(1000).default("")
    })).min(1)
  }),
  z.object({ type: z.literal("import"), revision: z.number().int().nonnegative(), data: z.unknown() })
]);

export type StateAction = z.infer<typeof actionSchema>;

export class StateActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateActionError";
  }
}

export function parseAction(value: unknown): StateAction {
  return actionSchema.parse(value);
}

function assertUniqueName(state: VesselState, name: string, exceptId?: string) {
  const normalized = name.trim().toLocaleLowerCase();
  if (state.machines.some((machine) => machine.id !== exceptId && machine.name.trim().toLocaleLowerCase() === normalized)) {
    throw new StateActionError("Machinery names must be unique");
  }
}

export function applyAction(original: VesselState, action: StateAction): VesselState {
  if (action.revision !== original.revision) {
    throw new StateActionError("Another user changed the data. Refresh before editing.");
  }
  const updated = structuredClone(original);

  switch (action.type) {
    case "import": {
      const imported = validateVesselState(action.data);
      imported.revision = original.revision + 1;
      return imported;
    }
    case "vessel":
      updated.vessel = action.name;
      break;
    case "add": {
      if (!updated.years[action.year]) throw new StateActionError("Unknown reporting year");
      assertUniqueName(updated, action.name);
      const id = randomUUID();
      updated.machines.push({ id, name: action.name, active: true, group: action.group });
      updated.years[action.year][id] = Array.from({ length: 13 }, () => null);
      break;
    }
    case "rename": {
      const machine = updated.machines.find((item) => item.id === action.id);
      if (!machine) throw new StateActionError("Unknown machine");
      assertUniqueName(updated, action.name, machine.id);
      machine.name = action.name;
      if (action.group) machine.group = action.group;
      break;
    }
    case "group": {
      const machine = updated.machines.find((item) => item.id === action.id);
      if (!machine) throw new StateActionError("Unknown machine");
      machine.group = action.group;
      break;
    }
    case "active": {
      const machine = updated.machines.find((item) => item.id === action.id);
      const year = updated.years[action.year];
      if (!machine || !year) throw new StateActionError("Unknown machine or reporting year");
      machine.active = action.active;
      if (machine.active) year[machine.id] ??= Array.from({ length: 13 }, () => null);
      break;
    }
    case "readings": {
      const records = updated.years[action.year];
      if (!records?.[action.id]) throw new StateActionError("Unknown machine record");
      if (updated.source_reports?.[action.year]?.[action.id]) {
        throw new StateActionError("Imported source records are read-only; no readings have been changed.");
      }
      if (updated.workbook_sources?.[action.year]?.[action.id]) {
        throw new StateActionError("Use monthly entry to update annual workbook readings; no readings have been changed.");
      }
      if (updated.manual_reports?.[action.year]?.[action.id]) {
        throw new StateActionError("Use monthly entry to update audited manual records.");
      }
      records[action.id] = action.readings;
      break;
    }
    case "rollover": {
      const current = updated.years[action.year];
      if (!current) throw new StateActionError("Unknown reporting year");
      const target = String(Number(action.year) + 1);
      if (updated.years[target]) throw new StateActionError("Next year already exists; history will not be overwritten");
      updated.years[target] = Object.fromEntries(
        updated.machines
          .filter((machine) => machine.active)
          .map((machine) => [machine.id, [current[machine.id]?.[12] ?? null, ...Array.from({ length: 12 }, () => null)]])
      );
      break;
    }
    case "monthly_entry": {
      const records = updated.years[action.year];
      if (!records) throw new StateActionError("Choose an existing reporting year and month");
      const seen = new Set<string>();
      for (const entry of action.entries) {
        if (seen.has(entry.id) || !records[entry.id]) throw new StateActionError("Duplicate or unknown machine");
        seen.add(entry.id);
        const source = updated.source_reports?.[action.year]?.[entry.id]?.[action.month];
        if (source) throw new StateActionError("Imported monthly records are read-only; nothing was saved");
        const manual = updated.manual_reports?.[action.year]?.[entry.id]?.[action.month];
        const meters = records[entry.id];
        const workbookMeter = updated.workbook_sources?.[action.year]?.[entry.id]?.[action.month + 1] !== null
          && updated.workbook_sources?.[action.year]?.[entry.id]?.[action.month + 1] !== undefined;
        const note = entry.note.trim();
        if (!manual && meters[action.month + 1] !== null && !workbookMeter) {
          throw new StateActionError("An existing legacy meter is present; review before replacing it");
        }
        if (workbookMeter && !manual && meters[action.month + 1] !== entry.end && !note) {
          throw new StateActionError("A correction note is required when changing an imported workbook meter");
        }
        if (!manual && entry.begin === null && entry.end === null) continue;
        if (manual && (manual.begin ?? null) !== entry.begin || manual && (manual.end ?? null) !== entry.end) {
          if (!note) throw new StateActionError("A correction note is required when changing a saved meter");
        }
        if (meters[action.month] !== null && meters[action.month] !== entry.begin && !note) {
          throw new StateActionError("Explain why the opening meter differs from the previous closing meter");
        }
        const report = {
          begin: entry.begin,
          end: entry.end,
          engineer: action.engineer,
          note,
          updated_at: new Date().toISOString()
        };
        updated.manual_reports ??= {};
        updated.manual_reports[action.year] ??= {};
        updated.manual_reports[action.year][entry.id] ??= Array.from({ length: 12 }, () => null);
        updated.manual_reports[action.year][entry.id][action.month] = report;
        meters[action.month + 1] = entry.end;
        if (action.month === 0 && meters[0] === null) meters[0] = entry.begin;
        updated.entry_audit ??= [];
        updated.entry_audit.push({
          year: action.year,
          month: action.month + 1,
          id: entry.id,
          before: manual ?? null,
          after: report
        });
      }
      break;
    }
  }

  updated.revision = original.revision + 1;
  return validateVesselState(updated);
}
