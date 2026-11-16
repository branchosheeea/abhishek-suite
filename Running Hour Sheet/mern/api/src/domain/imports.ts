import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { validateVesselState, type VesselState } from "./state.js";

const MAX_FILE_BYTES = 15_000_000;
const canonical = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
const hash = (content: Buffer) => createHash("sha256").update(content).digest("hex");
const cellValue = (sheet: ExcelJS.Worksheet, row: number, column: number): unknown =>
  sheet.getCell(row, column).value;

function literal(value: unknown): unknown {
  if (value && typeof value === "object" && "result" in value) return value.result;
  return value;
}

function isFormula(value: unknown): value is { formula: unknown; result?: unknown } {
  return Boolean(value && typeof value === "object" && "formula" in value);
}

function validMeter(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

async function loadWorkbook(content: Buffer): Promise<ExcelJS.Workbook> {
  if (!content.length || content.length > MAX_FILE_BYTES) {
    throw new Error("Workbook must be between 1 byte and 15 MB");
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.read(Readable.from([content]));
  } catch {
    throw new Error("The uploaded file is not a readable Excel workbook");
  }
  return workbook;
}

type AnnualExtract = {
  filename: string;
  sha256: string;
  machines: Array<{ id: string; name: string; active: boolean }>;
  years: Record<string, Record<string, Array<number | null>>>;
};

async function extractAnnualWorkbook(file: UploadedWorkbook): Promise<AnnualExtract> {
  if (!file.name.toLocaleLowerCase().endsWith(".xlsx")) throw new Error("Choose an annual .xlsx workbook");
  const workbook = await loadWorkbook(file.buffer);
  const master = workbook.getWorksheet("Machinery_Master");
  if (!master) throw new Error("Workbook is missing the Machinery_Master sheet");
  if ([1, 2, 3].map((column) => master.getCell(4, column).value).join("|") !== "Machinery Name|Include in RH|_Machinery_ID") {
    throw new Error("Machinery_Master headers do not match the Running Hour Sheet template");
  }
  const machines: AnnualExtract["machines"] = [];
  const idSet = new Set<string>();
  const nameSet = new Set<string>();
  const masterNames = new Map<string, string>();
  const machinesById = new Map<string, AnnualExtract["machines"][number]>();
  master.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber < 5) return;
    const rawName = literal(row.getCell(1).value);
    const active = literal(row.getCell(2).value);
    const rawId = literal(row.getCell(3).value);
    if (rawName == null && active == null && rawId == null) return;
    if (typeof rawName !== "string" || !rawName.trim() || rawName.trim().length > 100) {
      throw new Error(`Invalid machinery name in Machinery_Master row ${rowNumber}`);
    }
    const name = rawName.trim().replace(/\s+/g, " ");
    const id = typeof rawId === "string" ? rawId.trim() : "";
    if (nameSet.has(canonical(name))) throw new Error(`Duplicate machinery name in Machinery_Master: ${name}`);
    if (active !== "Yes" && active !== "No") throw new Error(`Expected Yes or No in Machinery_Master row ${rowNumber}`);
    if (!id) throw new Error(`Missing machinery ID in Machinery_Master row ${rowNumber}; sync the workbook first`);
    if (idSet.has(id)) throw new Error(`Duplicate machinery ID in Machinery_Master row ${rowNumber}`);
    idSet.add(id);
    nameSet.add(canonical(name));
    const machine = { id, name, active: active === "Yes" };
    machines.push(machine);
    machinesById.set(id, machine);
    masterNames.set(canonical(name), id);
  });
  if (!machines.length) throw new Error("Machinery_Master must contain at least one machine");

  const years: AnnualExtract["years"] = {};
  for (const sheet of workbook.worksheets) {
    const match = /^RH_(\d{4})$/.exec(sheet.name);
    if (!match) continue;
    const year = match[1];
    if (Number(year) < 1900 || Number(year) > 2200) throw new Error(`Invalid reporting year in sheet ${sheet.name}`);
    const expected = [
      "Machinery Name", `Meter @ 31 Dec ${Number(year) - 1}`,
      ...["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((month) => `${month} meter`),
      ...["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((month) => `${month} RH`),
      "_Machinery_ID"
    ];
    if (expected.some((value, index) => sheet.getCell(4, index + 1).value !== value)) {
      throw new Error(`${sheet.name} headers do not match the Running Hour Sheet template`);
    }
    const valuesById: Record<string, Array<number | null>> = {};
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber < 5) return;
      const rawName = literal(row.getCell(1).value);
      const rawId = literal(row.getCell(27).value);
      const values = Array.from({ length: 13 }, (_, index) => {
        const value = row.getCell(index + 2).value;
        if (isFormula(value)) throw new Error(`Calculated cells are not imported in ${sheet.name} row ${rowNumber}`);
        return literal(value);
      });
      if (rawName == null && rawId == null && values.every((value) => value == null)) return;
      if (typeof rawName !== "string" || !rawName.trim() || rawName.trim().length > 100) {
        throw new Error(`Invalid machinery name in ${sheet.name} row ${rowNumber}`);
      }
      const name = rawName.trim().replace(/\s+/g, " ");
      const id = typeof rawId === "string" ? rawId.trim() : "";
      if (!id) throw new Error(`Missing machinery ID in ${sheet.name} row ${rowNumber}`);
      if (seenIds.has(id) || seenNames.has(canonical(name))) throw new Error(`Duplicate machinery ID or name in ${sheet.name}: ${name}`);
      const masterId = masterNames.get(canonical(name));
      if (!machinesById.has(id) && masterId) {
        throw new Error(`Machinery ID mismatch in ${sheet.name} row ${rowNumber}; sync the workbook before importing`);
      }
      if (!machinesById.has(id)) {
        const machine = { id, name, active: false };
        machines.push(machine);
        machinesById.set(id, machine);
      }
      seenIds.add(id);
      seenNames.add(canonical(name));
      values.forEach((value, index) => {
        if (!validMeter(value)) throw new Error(`Invalid meter in ${sheet.name}, row ${rowNumber}, column ${index + 2}`);
      });
      valuesById[id] = values as Array<number | null>;
    });
    if (!Object.keys(valuesById).length) throw new Error(`${sheet.name} contains no machinery records`);
    years[year] = valuesById;
  }
  if (!Object.keys(years).length) throw new Error("Workbook must contain at least one RH_YYYY annual sheet");
  return { filename: file.name.split(/[\\/]/).pop() ?? file.name, sha256: hash(file.buffer), machines, years };
}

function mergeAnnual(original: VesselState, extracted: AnnualExtract) {
  const data = structuredClone(original);
  const summary = {
    filename: extracted.filename,
    sha256: extracted.sha256,
    years: Object.keys(extracted.years).sort(),
    machines: extracted.machines.length,
    new_machines: [] as string[],
    new_values: 0,
    identical_values: 0,
    conflicts: [] as Array<{ year: string; machine: string; field: string; existing: number; uploaded: number }>,
    total_conflicts: 0
  };
  const byId = new Map(data.machines.map((machine) => [machine.id, machine]));
  const byName = new Map(data.machines.map((machine) => [canonical(machine.name), machine.id]));
  const identity = new Map<string, string>();
  extracted.machines.forEach((machine) => {
    let id = byId.has(machine.id) ? machine.id : byName.get(canonical(machine.name));
    if (!id) {
      id = machine.id;
      data.machines.push({ ...machine });
      byId.set(id, machine);
      byName.set(canonical(machine.name), id);
      summary.new_machines.push(machine.name);
    }
    identity.set(machine.id, id);
  });
  Object.entries(extracted.years).forEach(([year, imported]) => {
    data.years[year] ??= {};
    Object.entries(imported).forEach(([sourceId, values]) => {
      const id = identity.get(sourceId);
      if (!id) throw new Error(`Workbook contains an unregistered machinery ID: ${sourceId}`);
      data.years[year][id] ??= Array.from({ length: 13 }, () => null);
      values.forEach((value, index) => {
        if (value === null) return;
        const existing = data.years[year][id][index];
        if (existing === null) {
          data.years[year][id][index] = value;
          data.workbook_sources ??= {};
          data.workbook_sources[year] ??= {};
          data.workbook_sources[year][id] ??= Array.from({ length: 13 }, () => null);
          data.workbook_sources[year][id][index] = {
            file: extracted.filename,
            sha256: extracted.sha256,
            imported_at: new Date().toISOString()
          };
          summary.new_values += 1;
        } else if (existing === value) {
          summary.identical_values += 1;
        } else {
          summary.total_conflicts += 1;
          if (summary.conflicts.length < 100) {
            summary.conflicts.push({
              year,
              machine: byId.get(id)?.name ?? id,
              field: index === 0 ? "31 Dec baseline" : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][index - 1],
              existing,
              uploaded: value
            });
          }
        }
      });
    });
  });
  return { data: validateVesselState(data), summary };
}

export type UploadedWorkbook = { name: string; buffer: Buffer };

export async function previewAnnualWorkbook(original: VesselState, file: UploadedWorkbook) {
  const extracted = await extractAnnualWorkbook(file);
  return { ...mergeAnnual(original, extracted), fingerprint: extracted.sha256 };
}

export async function importAnnualWorkbook(original: VesselState, file: UploadedWorkbook, fingerprint: string) {
  const extracted = await extractAnnualWorkbook(file);
  if (fingerprint !== extracted.sha256) throw new Error("Workbook changed since preview; preview it again before importing");
  const merged = mergeAnnual(original, extracted);
  if (merged.summary.new_values || merged.summary.new_machines.length) {
    merged.data.revision = original.revision + 1;
    merged.data.workbook_import_batches ??= [];
    merged.data.workbook_import_batches.push({
      at: new Date().toISOString(),
      file: extracted.filename,
      sha256: extracted.sha256,
      years: merged.summary.years,
      new_machines: merged.summary.new_machines.length,
      new_values: merged.summary.new_values,
      conflicts: merged.summary.total_conflicts
    });
  } else {
    merged.data.revision = original.revision;
  }
  return { ...merged, data: validateVesselState(merged.data) };
}

type HistoricalRecord = {
  year: string;
  month: number;
  id: string;
  name: string;
  report: { begin: number | null; reported: number | null; end: number | null; file: string; sheet: string; row: number; sha256: string };
};
export type HistoricalFile = UploadedWorkbook & { relativePath: string };

function matchesPeriod(value: unknown, year: string, month: number): boolean {
  if (value instanceof Date) return value.getUTCFullYear() === Number(year) && value.getUTCMonth() + 1 === month;
  const text = String(value ?? "").toUpperCase();
  const monthName = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][month - 1];
  return new RegExp(`\\b${monthName}[A-Z]*\\b`).test(text)
    && new RegExp(`\\b(?:${year}|${year.slice(-2)})\\b`).test(text);
}

function readReportMeter(sheet: ExcelJS.Worksheet, row: number, column: number, file: string): number | null {
  const raw = cellValue(sheet, row, column);
  if (isFormula(raw) && (!("result" in raw) || raw.result == null)) {
    throw new Error(`Formula cache missing at ${sheet.name}!${sheet.getCell(row, column).address}; recalculate and save in Excel`);
  }
  const value = literal(raw);
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid meter/RH at ${sheet.name}!${sheet.getCell(row, column).address} in ${file}`);
  }
  return value;
}

async function extractHistoricalFile(file: HistoricalFile, vessel: string): Promise<HistoricalRecord[]> {
  if (/\.xls$/i.test(file.name)) throw new Error("Legacy .xls: save as .xlsx before importing");
  if (!/\.xlsx?m?$/i.test(file.name)) throw new Error("Unsupported workbook extension");
  const period = /(?:^|[\\/])(\d{4})-(\d{2})(?:[\\/]|$)/.exec(file.relativePath);
  if (!period) throw new Error("Place reports inside a YYYY-MM folder");
  const [, year, monthText] = period;
  const month = Number(monthText);
  if (Number(year) < 1900 || Number(year) > 2200 || month < 1 || month > 12) throw new Error("Invalid reporting period");
  const workbook = await loadWorkbook(file.buffer);
  const records: HistoricalRecord[] = [];
  const digest = hash(file.buffer);
  const add = (sheet: ExcelJS.Worksheet, row: number, nameValue: unknown, beginColumn: number, reportedColumn: number, endColumn: number) => {
    if (typeof nameValue !== "string" || !nameValue.trim()) throw new Error(`Missing machinery name at row ${row}`);
    const name = nameValue.trim().replace(/\s+/g, " ");
    const id = `history-${createHash("sha256").update(`${canonical(vessel)}/${canonical(name)}`).digest("hex").slice(0, 32)}`;
    records.push({
      year, month, id, name,
      report: {
        begin: readReportMeter(sheet, row, beginColumn, file.name),
        reported: readReportMeter(sheet, row, reportedColumn, file.name),
        end: readReportMeter(sheet, row, endColumn, file.name),
        file: file.relativePath, sheet: sheet.name, row, sha256: digest
      }
    });
  };
  const himsen = workbook.getWorksheet("HIMSEN");
  if (himsen) {
    [5, 64, 123].forEach((row, index) => {
      if (canonical(String(literal(cellValue(himsen, row - 2, 4)) ?? "")) !== canonical(vessel)) {
        throw new Error("Vessel identity does not match this repository");
      }
      if (!matchesPeriod(literal(cellValue(himsen, row - 1, 31)), year, month)) throw new Error("Report month differs from folder month");
      add(himsen, row, `Diesel Generator Set No. ${index + 1}`, 25, 31, 6);
    });
    return records;
  }
  const active = workbook.worksheets[0];
  if (!active) throw new Error("Workbook contains no worksheets");
  if (active.name === "14.02.031.01") {
    if (canonical(String(literal(cellValue(active, 6, 2)) ?? "")) !== canonical(vessel)) throw new Error("Vessel identity does not match this repository");
    if (!matchesPeriod(literal(cellValue(active, 6, 7)), year, month)) throw new Error("Report date differs from folder month");
    for (let row = 10; row <= 36; row += 1) add(active, row, literal(cellValue(active, row, 1)), 4, 5, 6);
    return records;
  }
  const heading = String(literal(cellValue(active, 2, 1)) ?? "").split(":").slice(1).join(":").trim();
  if (canonical(heading) !== canonical(vessel) || !String(literal(cellValue(active, 3, 1)) ?? "").toUpperCase().includes("DESCRIPTION")) {
    throw new Error("Unrecognised report format or different vessel");
  }
  if (!matchesPeriod(literal(cellValue(active, 2, 4)), year, month)) throw new Error("Report month differs from folder month");
  for (let row = 4; row <= active.rowCount; row += 1) {
    const name = literal(cellValue(active, row, 1));
    if (typeof name === "string" && name.trim()) add(active, row, name, 2, 3, 4);
  }
  return records;
}

export async function previewHistoricalReports(original: VesselState, files: HistoricalFile[]) {
  if (!files.length) throw new Error("Select a folder containing monthly report workbooks");
  const hashes = new Set<string>();
  const duplicateFiles: string[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  const records: HistoricalRecord[] = [];
  let uniqueFiles = 0;
  const manifest: string[] = [];
  for (const file of files) {
    const digest = hash(file.buffer);
    manifest.push(`${file.relativePath}:${digest}`);
    if (hashes.has(digest)) {
      duplicateFiles.push(file.relativePath);
      continue;
    }
    hashes.add(digest);
    uniqueFiles += 1;
    try {
      records.push(...await extractHistoricalFile(file, original.vessel));
    } catch (error) {
      errors.push({ file: file.relativePath, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const fingerprint = createHash("sha256").update(manifest.sort().join("\n")).digest("hex");
  const data = structuredClone(original);
  const names = new Map(data.machines.map((machine) => [canonical(machine.name), machine.id]));
  const byId = new Map(data.machines.map((machine) => [machine.id, machine]));
  const grouped = new Map<string, HistoricalRecord[]>();
  records.forEach((record) => {
    const id = names.get(canonical(record.name)) ?? record.id;
    const key = `${record.year}/${record.month}/${id}`;
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  });
  const conflicts: Array<{ year: string; month: number; machine: string; files: string[]; reason: string }> = [];
  let newRecords = 0;
  let existingRecords = 0;
  let newMachines = 0;
  for (const candidates of grouped.values()) {
    const first = candidates[0];
    const report = first.report;
    const details = {
      year: first.year, month: first.month, machine: first.name,
      files: candidates.map((candidate) => candidate.report.file)
    };
    const values = (item: { begin?: number | null; end?: number | null; reported?: number | null }) =>
      [item.begin, item.end, item.reported].join("/");
    if (candidates.some((candidate) => values(candidate.report) !== values(report))) {
      conflicts.push({ ...details, reason: "Different source files disagree; no record imported" });
      continue;
    }
    const id = names.get(canonical(first.name)) ?? first.id;
    const existing = data.source_reports?.[first.year]?.[id]?.[first.month - 1];
    const manual = data.manual_reports?.[first.year]?.[id]?.[first.month - 1];
    const readings = data.years[first.year]?.[id] ?? Array.from({ length: 13 }, () => null);
    if (existing) {
      if (values(existing) === values(report)) existingRecords += candidates.length;
      else conflicts.push({ ...details, reason: "Existing imported record differs; retained unchanged" });
      continue;
    }
    if (manual || readings[first.month] !== null) {
      conflicts.push({ ...details, reason: "Manual/existing meter record already exists; retained unchanged" });
      continue;
    }
    if (!byId.has(id)) {
      const machine = { id, name: first.name, active: true };
      data.machines.push(machine);
      byId.set(id, machine);
      names.set(canonical(first.name), id);
      newMachines += 1;
    }
    data.years[first.year] ??= {};
    data.years[first.year][id] ??= Array.from({ length: 13 }, () => null);
    data.source_reports ??= {};
    data.source_reports[first.year] ??= {};
    data.source_reports[first.year][id] ??= Array.from({ length: 12 }, () => null);
    data.source_reports[first.year][id][first.month - 1] = report;
    data.years[first.year][id][first.month] = report.end;
    if (first.month === 1 && data.years[first.year][id][0] === null) data.years[first.year][id][0] = report.begin;
    newRecords += 1;
    existingRecords += candidates.length - 1;
  }
  Object.entries(data.years).forEach(([year, annual]) => {
    Object.entries(annual).forEach(([id, meters]) => {
      const prior = data.years[String(Number(year) - 1)]?.[id];
      if (meters[0] === null && prior?.[12] != null) meters[0] = prior[12];
    });
  });
  return {
    data: validateVesselState(data),
    summary: {
      files: files.length, unique_files: uniqueFiles, duplicate_files: duplicateFiles, errors,
      conflicts, fingerprint, new_records: newRecords, existing_records: existingRecords, new_machines: newMachines
    }
  };
}

export async function importHistoricalReports(original: VesselState, files: HistoricalFile[], fingerprint: string) {
  const merged = await previewHistoricalReports(original, files);
  if (merged.summary.fingerprint !== fingerprint) throw new Error("Source files changed since preview; scan again before importing");
  if (merged.summary.new_records) {
    merged.data.revision = original.revision + 1;
    merged.data.import_batches ??= [];
    merged.data.import_batches.push({
      at: new Date().toISOString(),
      files: merged.summary.files,
      records: merged.summary.new_records,
      fingerprint
    });
    merged.data.import_info = {
      source: "Browser-uploaded YYYY-MM report folder",
      imported_at: new Date().toISOString(),
      records: merged.summary.new_records,
      files: merged.summary.files,
      note: "Historical Excel repository; imported monthly records are retained with source references."
    };
  } else {
    merged.data.revision = original.revision;
  }
  return { data: validateVesselState(merged.data), import_summary: merged.summary };
}
