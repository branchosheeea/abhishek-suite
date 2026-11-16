import { z } from "zod";

const meterValue = z.number().finite().nonnegative().nullable();
const meterSeries = z.array(meterValue).length(13);
const sourceReport = z.object({
  begin: meterValue.optional(),
  end: meterValue.optional(),
  reported: meterValue.optional()
}).passthrough();
const manualReport = z.object({
  begin: meterValue.optional(),
  end: meterValue.optional(),
  engineer: z.string().min(1),
  note: z.string().max(1000).optional(),
  updated_at: z.string().min(1)
}).passthrough();
const workbookSource = z.object({
  file: z.string().min(1),
  imported_at: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/)
}).passthrough();
const equipmentGroup = z.enum([
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

export const vesselStateSchema = z.object({
  schema: z.literal(1),
  revision: z.number().int().nonnegative(),
  vessel: z.string().min(1).max(100).refine((value) => value.trim().length > 0),
  machines: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1).max(100).refine((value) => value.trim().length > 0),
    active: z.boolean(),
    group: equipmentGroup.optional()
  }).passthrough()).min(1),
  years: z.record(z.string().regex(/^\d{4}$/), z.record(z.string(), meterSeries)).refine(
    (years) => Object.keys(years).length > 0,
    "At least one reporting year is required"
  ),
  source_reports: z.record(z.string(), z.record(
    z.string(),
    z.array(sourceReport.nullable()).length(12)
  )).optional(),
  manual_reports: z.record(z.string(), z.record(
    z.string(),
    z.array(manualReport.nullable()).length(12)
  )).optional(),
  workbook_sources: z.record(z.string(), z.record(
    z.string(),
    z.array(workbookSource.nullable()).length(13)
  )).optional(),
  entry_audit: z.array(z.record(z.string(), z.unknown())).optional(),
  import_batches: z.array(z.record(z.string(), z.unknown())).optional(),
  workbook_import_batches: z.array(z.record(z.string(), z.unknown())).optional(),
  import_info: z.object({
    source: z.string().optional(),
    imported_at: z.string().optional(),
    note: z.string().optional(),
    records: z.number().optional(),
    files: z.number().optional()
  }).passthrough().optional()
}).passthrough().superRefine((state, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, machine] of state.machines.entries()) {
    if (ids.has(machine.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["machines", index, "id"], message: "Duplicate machinery ID" });
    }
    ids.add(machine.id);
    const normalizedName = machine.name.toLocaleLowerCase();
    if (names.has(normalizedName)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["machines", index, "name"], message: "Machinery names must be unique" });
    }
    names.add(normalizedName);
  }

  for (const [year, records] of Object.entries(state.years)) {
    for (const id of Object.keys(records)) {
      if (!ids.has(id)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["years", year, id], message: "Unknown machinery ID in year record" });
      }
    }
  }

  for (const [year, records] of Object.entries(state.source_reports ?? {})) {
    if (!(year in state.years)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["source_reports", year], message: "Source reports refer to an unknown year" });
    }
    for (const id of Object.keys(records)) {
      if (!state.years[year]?.[id]) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["source_reports", year, id], message: "Source report refers to an unknown machine/year record" });
      }
    }
  }
});

export type VesselState = z.infer<typeof vesselStateSchema>;

export function validateVesselState(value: unknown): VesselState {
  return vesselStateSchema.parse(value);
}

export function demonstrationState(): VesselState {
  const profiles = [
    [720, 680, 730, 710, 740, 680, 720, 730, 700, 720],
    [650, 620, 640, 600, 650, 620, 90, 100, 590, 610],
    [80, 90, 70, 85, 80, 90, 0, 0, 60, 0],
    [30, 40, 20, 50, 40, 30, 0, 0, 0, 0],
    [720, 700, 710, 720, 730, 700, 710, 720, 700, 720],
    [20, 15, 30, 20, 25, 10, 0, 0, 0, 0],
    [40, 35, 45, 30, 40, 35, 30, 35, 40, 30]
  ];
  const machines = [
    "Diesel Generator Set No. 1",
    "Diesel Generator Set No. 2",
    "Emergency Generator",
    "Main Boiler",
    "Oil Purifier No. 1",
    "Air Compressor No. 1",
    "Refrigeration Compressor No. 1"
  ].map((name, index) => ({
    id: `demo-machine-${index + 1}`,
    name,
    active: true
  }));
  const records = Object.fromEntries(machines.map((machine, index) => {
    const readings: Array<number | null> = Array.from({ length: 13 }, () => null);
    readings[0] = 12_000 + index * 3_000;
    profiles[index].forEach((hours, month) => {
      const opening = readings[month];
      readings[month + 1] = opening === null ? null : opening + hours;
    });
    return [machine.id, readings];
  }));
  return validateVesselState({
    schema: 1,
    revision: 0,
    vessel: "MT Meridian · demonstration",
    machines,
    years: { "2026": records }
  });
}

export function summarizeVesselState(state: VesselState) {
  const years = Object.entries(state.years).map(([year, records]) => {
    const series = Object.values(records);
    const meters = series.flat();
    return {
      year,
      machineryRecords: series.length,
      meterValues: meters.filter((value) => value !== null).length,
      zeroValues: meters.filter((value) => value === 0).length,
      missingValues: meters.filter((value) => value === null).length
    };
  });
  const sourceReports = Object.entries(state.source_reports ?? {}).flatMap(([year, records]) =>
    Object.values(records).flatMap((months) =>
      months.flatMap((report) => report === null ? [] : [{ year, report }])
    )
  );
  const sourceReportsByYear = Object.entries(state.source_reports ?? {}).map(([year, records]) => ({
    year,
    records: Object.values(records).flat().filter((report) => report !== null).length
  }));
  const sourceMeterValues = sourceReports.reduce((count, { report }) =>
    count + ["begin", "end", "reported"].filter((field) => typeof report[field] === "number").length, 0);
  return {
    vessel: state.vessel,
    revision: state.revision,
    machines: state.machines.length,
    years,
    sourceReportsByYear,
    sourceReportRecords: sourceReports.length,
    sourceMeterValues
  };
}

export function monthlyHours(readings: Array<number | null>): Array<number | null> {
  return readings.slice(1).map((closing, month) => {
    const opening = readings[month];
    return opening !== null && closing !== null ? closing - opening : null;
  });
}

export function utilisation(hours: Array<number | null>, month: number): "amber" | "red" | null {
  if (month < 1) return null;
  const pair = hours.slice(month - 1, month + 1);
  if (pair.length !== 2 || pair.some((value) => value === null || value < 0)) return null;
  const history = hours.slice(0, month - 1).filter((value): value is number => value !== null && value >= 0);
  if (history.length < 3) return null;
  const pairHours = pair as number[];
  const average = history.reduce((total, value) => total + value, 0) / history.length;
  if (average >= 200) return pairHours[0] + pairHours[1] < 300 ? "amber" : null;
  return pairHours[0] === 0 && pairHours[1] === 0 ? "red" : null;
}

export function analytics(state: VesselState) {
  type Observation = {
    recorded: boolean;
    exception: boolean;
    missing: boolean;
    zero_months: number;
    baseline: number | null;
    baseline_months: number[];
    change_pct: number | null;
    last_run: number | null;
    baseline_labels: string[];
    last_run_label: string | null;
    zero_since: string | null;
  };
  type MachineResult = {
    hours: Array<number | null>;
    alerts: Array<"amber" | "red" | null>;
    issues: string[][];
    review: Observation[];
  };
  const result: Record<string, Record<string, MachineResult>> = {};
  const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (const [year, records] of Object.entries(state.years)) {
    result[year] = {};
    for (const [id, readings] of Object.entries(records)) {
      let hours = monthlyHours(readings);
      const reports = state.source_reports?.[year]?.[id];
      const manual = state.manual_reports?.[year]?.[id];
      const observations = reports ?? manual;
      const issues = Array.from({ length: 12 }, () => [] as string[]);
      if (observations) {
        hours = observations.map((report) => {
          if (!report || typeof report.begin !== "number" || typeof report.end !== "number") return null;
          return report.end - report.begin;
        });
        observations.forEach((report, month) => {
          if (!report) return;
          const opening = report.begin;
          const previous = readings[month];
          if (typeof opening === "number" && previous !== null && Math.abs(opening - previous) > 0.01) {
            const difference = opening - previous;
            issues[month].push(`Continuity gap: prior closing ${previous}, reported opening ${opening}; difference ${difference >= 0 ? "+" : ""}${difference} RH. Source monthly RH retained.`);
          }
          const hoursForMonth = hours[month];
          if (hoursForMonth === null && report.reported !== null && report.reported !== undefined) {
            issues[month].push("Reported RH has no supporting opening/closing meter; treated as missing, not zero.");
          }
          if (hoursForMonth !== null && typeof report.reported === "number" && Math.abs(hoursForMonth - report.reported) > 0.01) {
            issues[month].push("Reported RH differs from closing minus opening meter.");
          }
        });
      }
      hours.forEach((value, month) => {
        const calendarLimit = new Date(Date.UTC(Number(year), month + 1, 0)).getUTCDate() * 24;
        if (value !== null && value > calendarLimit + 0.01) {
          issues[month].push(`${Number(value.toFixed(1))} RH exceeds ${calendarLimit} calendar hours; verify reporting times. Reading retained.`);
        }
      });
      result[year][id] = { hours, alerts: hours.map((_, month) => utilisation(hours, month)), issues, review: [] };
    }
  }
  const allYears = Object.keys(result).map(Number);
  if (!allYears.length) return result;
  const firstYear = Math.min(...allYears);
  const lastYear = Math.max(...allYears);
  const periods = Array.from({ length: (lastYear - firstYear + 1) * 12 }, (_, index) => ({
    year: String(firstYear + Math.floor(index / 12)),
    month: index % 12
  }));
  for (const machine of state.machines) {
    const timeline = periods.map(({ year, month }) => result[year]?.[machine.id]?.hours[month] ?? null);
    const flags = periods.map(({ year, month }) => result[year]?.[machine.id]?.issues[month] ?? []);
    const reviews = timeline.map((value, index) => {
      const exception = value !== null && (value < 0 || flags[index].length > 0);
      let zeroMonths = 0;
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        if (timeline[cursor] !== 0 || flags[cursor].length) break;
        zeroMonths += 1;
      }
      const baselineMonths = timeline
        .map((prior, priorIndex) => ({ prior, priorIndex }))
        .filter(({ prior, priorIndex }) => priorIndex < index && prior !== null && prior >= 0 && !flags[priorIndex].length)
        .slice(-3)
        .map(({ priorIndex }) => priorIndex);
      const baseline = baselineMonths.length === 3
        ? baselineMonths.reduce((sum, priorIndex) => sum + (timeline[priorIndex] ?? 0), 0) / 3
        : null;
      const recorded = value !== null && value >= 0;
      const changePct = recorded && !exception && baseline !== null && baseline > 0
        ? ((value - baseline) / baseline) * 100
        : null;
      let lastRun: number | null = null;
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        if (timeline[cursor] !== null && timeline[cursor]! > 0 && !flags[cursor].length) {
          lastRun = cursor;
          break;
        }
      }
      const label = (periodIndex: number) => {
        const period = periods[periodIndex];
        return `${monthLabels[period.month]} ${period.year}`;
      };
      return {
        recorded,
        exception,
        missing: value === null,
        zero_months: zeroMonths,
        baseline,
        baseline_months: baselineMonths,
        change_pct: changePct,
        last_run: lastRun,
        baseline_labels: baselineMonths.map(label),
        last_run_label: lastRun === null ? null : label(lastRun),
        zero_since: zeroMonths ? label(index - zeroMonths + 1) : null
      };
    });
    periods.forEach(({ year, month }, index) => {
      const item = result[year]?.[machine.id];
      if (!item) return;
      item.review[month] = reviews[index];
      item.alerts[month] = utilisation(timeline, index);
    });
  }
  return result;
}
