import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

const equipmentGroups = [
  { id: "power-generation", label: "Power Generation System" },
  { id: "boilers", label: "Boiler System" },
  { id: "fo-purification", label: "FO Purification System" },
  { id: "lo-purification", label: "LO Purification System" },
  { id: "purifiers", label: "Oil Purification (Unspecified)" },
  { id: "compressed-air", label: "Compressed Air System" },
  { id: "refrigeration", label: "HVAC & Refrigeration System" },
  { id: "egcs", label: "Exhaust Gas Cleaning System (EGCS)" },
  { id: "inert-gas", label: "Inert Gas System" },
  { id: "auxiliaries", label: "Other Auxiliary Systems" }
] as const;
type EquipmentGroup = typeof equipmentGroups[number]["id"];
type GroupFilter = EquipmentGroup | "all";
type Machine = { id: string; name: string; active: boolean; group?: EquipmentGroup };
type MonthlyInput = { begin: string; end: string; note: string };
type ReviewFilter = "all" | "utilisation" | "idle" | "exceptions" | "missing";
type MeterReport = {
  begin?: number | null;
  end?: number | null;
  reported?: number | null;
  file?: string;
  sheet?: string;
  row?: number;
  engineer?: string;
  updated_at?: string;
  note?: string;
};
type State = {
  vessel: string;
  revision: number;
  machines: Machine[];
  years: Record<string, Record<string, Array<number | null>>>;
  source_reports?: Record<string, Record<string, Array<MeterReport | null>>>;
  workbook_sources?: Record<string, Record<string, unknown[]>>;
  manual_reports?: Record<string, Record<string, Array<MeterReport | null>>>;
  entry_audit?: Array<Record<string, unknown>>;
  import_info?: { note?: string; imported_at?: string; records?: number; files?: number };
};
type MachineReview = {
  recorded: boolean; exception: boolean; missing: boolean; zero_months: number;
  baseline: number | null; baseline_months: number[]; change_pct: number | null;
  last_run: number | null; baseline_labels: string[]; last_run_label: string | null;
  zero_since: string | null;
};
type MachineAnalytics = { hours: Array<number | null>; alerts: Array<string | null>; issues: string[][]; review: MachineReview[] };
type ApiResponse = { data: State; analytics: Record<string, Record<string, MachineAnalytics>> };
type AnnualImportSummary = {
  filename: string; years: string[]; machines: number; new_machines: string[];
  new_values: number; identical_values: number;
  conflicts: Array<{ year: string; machine: string; field: string; existing: number; uploaded: number }>;
  total_conflicts: number;
};
type HistoricalImportSummary = {
  files: number; unique_files: number; duplicate_files: string[];
  errors: Array<{ file: string; error: string }>;
  conflicts: Array<{ year: string; month: number; machine: string; files: string[]; reason: string }>;
  fingerprint: string; new_records: number; existing_records: number; new_machines: number;
};
type Page = "overview" | "readings" | "machinery" | "history";
type Action =
  | { type: "vessel"; name: string }
  | { type: "add"; year: string; name: string; group: EquipmentGroup }
  | { type: "rename"; id: string; name: string; group?: EquipmentGroup }
  | { type: "group"; id: string; group: EquipmentGroup }
  | { type: "active"; year: string; id: string; active: boolean }
  | { type: "readings"; year: string; id: string; readings: Array<number | null> }
  | { type: "rollover"; year: string }
  | { type: "monthly_entry"; year: string; month: number; engineer: string; entries: Array<{ id: string; begin: number | null; end: number | null; note: string }> }
  | { type: "import"; data: unknown };

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pages: Array<{ id: Page; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "◫" },
  { id: "readings", label: "Meter readings", icon: "▦" },
  { id: "machinery", label: "Machinery register", icon: "⚙" },
  { id: "history", label: "Historical imports", icon: "↥" }
];
const pageTitles: Record<Page, string> = {
  overview: "Machinery review",
  readings: "Monthly entry",
  machinery: "Machinery register",
  history: "Historical imports"
};

function machineGroup(machine: Machine): EquipmentGroup {
  const name = machine.name.toLocaleLowerCase();
  if (machine.group && machine.group !== "purifiers") return machine.group;
  if (name.includes("boiler")) return "boilers";
  if (name.includes("egcs") || name.includes("exhaust gas cleaning") || name.includes("scrubber")) return "egcs";
  if (name.includes("inert gas") || name.includes("ig blower") || name.includes("ig system")) return "inert-gas";
  if (name.includes("purifier") || name.includes("separator")) {
    if (name.includes("lube oil") || name.includes("lubricating oil") || name.includes("lo purifier")) return "lo-purification";
    if (name.includes("fuel oil") || name.includes("diesel oil") || name.includes("fo purifier") || name.includes("hfo purifier")) return "fo-purification";
    return "purifiers";
  }
  if (machine.group) return machine.group;
  if (name.includes("emergency diesel") || name.includes("emergency generator")
    || name.includes("diesel generator") || name.includes("generator set")) return "power-generation";
  if (name.includes("fresh water generator")) return "auxiliaries";
  if (name.includes("air con") || name.includes("air conditioning") || name.includes("hvac")
    || name.includes("fridge") || name.includes("refrigerat") || name.includes("chiller")) return "refrigeration";
  if (name.includes("compressor")) return "compressed-air";
  return "auxiliaries";
}

function groupLabel(group: EquipmentGroup): string {
  return equipmentGroups.find((item) => item.id === group)?.label ?? "Other Auxiliary Systems";
}

function display(value: number | null | undefined): string {
  return value == null ? "—" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function htmlEscape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  })[character] ?? character);
}

function downloadFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fetchState(endpoint = "/api/state"): Promise<ApiResponse> {
  const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) {
    throw new Error(`API returned ${response.status} without JSON. Check that the MERN API is running.`);
  }
  const body = await response.json() as ApiResponse | { error?: string };
  if (!response.ok) {
    throw new Error("error" in body ? body.error ?? "Unable to load records." : "Unable to load records.");
  }
  return body as ApiResponse;
}

function reportLabel(report: MeterReport | null | undefined): string {
  if (!report) return "Missing source report";
  if (report.file) {
    return [report.file, report.sheet, report.row ? `row ${report.row}` : undefined].filter(Boolean).join(" · ");
  }
  return "Imported monthly report";
}

function axisMaximum(values: Array<number | null>): number {
  const maximum = Math.max(0, ...values.filter((value): value is number => value !== null && value > 0));
  if (maximum === 0) return 1;
  const roughStep = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  return Math.ceil(maximum / step) * step;
}

function axisStep(range: number): number {
  const roughStep = range / 4;
  if (roughStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
}

function MonthlyColumnChart({ name, hours, alerts }: { name: string; hours: Array<number | null>; alerts: Array<string | null> }) {
  const width = 760;
  const height = 290;
  const left = 54;
  const right = 18;
  const top = 22;
  const bottom = 40;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const validHours = hours.filter((value): value is number => value !== null);
  const rawMin = Math.min(0, ...validHours);
  const rawMax = axisMaximum(hours);
  const step = axisStep(rawMax - rawMin);
  const min = rawMin < 0 ? Math.floor(rawMin / step) * step : 0;
  const max = Math.ceil(rawMax / step) * step;
  const range = max - min;
  const zeroY = top + plotHeight * (max / range);
  const slotWidth = plotWidth / monthNames.length;
  const columnWidth = slotWidth * 0.56;
  return <div className="chart-frame">
    <div className="chart-legend"><span><i className="legend-dot"></i> Monthly RH</span><span><i className="legend-dash"></i> Blank month = no reading</span></div>
    <svg className="monthly-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${name} monthly running hours columns`}>
      <title>{name} monthly running hours in the selected year</title>
      <desc>Column chart showing each month's running hours independently. Missing readings are left blank; negative meter changes extend below zero and are flagged for review.</desc>
      {Array.from({ length: 5 }, (_, index) => {
        const value = max - index * range / 4;
        const y = top + index * plotHeight / 4;
        return <g key={index}>
          <line x1={left} x2={width - right} y1={y} y2={y} className={Math.abs(value) < range / 1000 ? "chart-zero-line" : "chart-gridline"} />
          <text x={left - 10} y={y + 4} textAnchor="end" className="chart-axis-label">{display(value)}</text>
        </g>;
      })}
      {monthNames.map((month, index) => {
        const x = left + slotWidth * (index + 0.5);
        return <text key={month} x={x} y={height - 12} textAnchor="middle" className="chart-axis-label">{month}</text>;
      })}
      {monthNames.map((month, index) => {
        const value = hours[index] ?? null;
        if (value === null) return null;
        const y = top + plotHeight * (1 - (value - min) / range);
        const barY = value < 0 ? zeroY : y;
        const barHeight = Math.max(2, Math.abs(zeroY - y));
        const alert = alerts[index];
        return <g key={month} className="monthly-column">
          <rect
            x={left + slotWidth * (index + 0.5) - columnWidth / 2}
            y={barY}
            width={columnWidth}
            height={barHeight}
            rx={4}
            className={`monthly-column-fill ${alert ?? ""} ${value < 0 ? "error" : ""} ${value === 0 ? "zero" : ""}`}
          />
          <title>{`${month}: ${display(value)} RH${value < 0 ? " · negative meter change, review" : ""}${alert ? ` · ${alert} utilisation screening` : ""}`}</title>
        </g>;
      })}
    </svg>
    <div className="chart-summary">
      <span>{monthNames.filter((_, index) => hours[index] !== null && hours[index] !== undefined).length} months with readings</span>
      <span>{monthNames.filter((_, index) => hours[index] === null || hours[index] === undefined).length} missing months</span>
      {hours.some((value) => value !== null && value < 0) && <span className="summary-warning">Meter decrease flagged for review</span>}
    </div>
  </div>;
}

function MachineBarChart({
  values,
  month,
  onSelectMachine
}: {
  values: Array<{ id: string; name: string; hours: number; alert: string | null }>;
  month: string;
  onSelectMachine: (id: string) => void;
}) {
  const rows = [...values].sort((a, b) => b.hours - a.hours).slice(0, 10);
  const width = 820;
  const left = 242;
  const right = 60;
  const top = 12;
  const rowHeight = 38;
  const height = top + rows.length * rowHeight + 28;
  const barWidth = width - left - right;
  const minRaw = Math.min(0, ...rows.map((item) => item.hours));
  const maxRaw = axisMaximum(rows.map((item) => item.hours));
  const step = axisStep(maxRaw - minRaw);
  const min = minRaw < 0 ? Math.floor(minRaw / step) * step : 0;
  const max = Math.ceil(maxRaw / step) * step;
  const range = max - min;
  const zeroX = left + (barWidth * -min) / range;
  if (!rows.length) return <div className="chart-empty">No machine has a running-hour value for {month}.</div>;

  return <div className="chart-frame bar-chart-scroll">
    <svg className="bar-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Top individual machinery running hours for ${month}`}>
      <title>Individual machinery running hours for {month}</title>
      <desc>Top ten machines ranked by recorded running hours. Values are not summed across machinery.</desc>
      {Array.from({ length: 5 }, (_, index) => {
        const value = min + range * index / 4;
        const x = left + (barWidth * index) / 4;
        return <g key={index}>
          <line x1={x} x2={x} y1={top - 4} y2={height - 22} className={Math.abs(value) < range / 1000 ? "chart-zero-line" : "chart-gridline"} />
          <text x={x} y={height - 5} textAnchor="middle" className="chart-axis-label">{display(value)}</text>
        </g>;
      })}
      {rows.map((item, index) => {
        const y = top + index * rowHeight;
        const itemWidth = Math.max(2, (Math.abs(item.hours) / range) * barWidth);
        const itemX = item.hours < 0 ? zeroX - itemWidth : zeroX;
        const shortened = item.name.length > 31 ? `${item.name.slice(0, 29)}…` : item.name;
        return <g key={item.id} className="bar-row" tabIndex={0} role="button" aria-label={`${item.name}: ${display(item.hours)} hours; inspect trend`} onClick={() => onSelectMachine(item.id)} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelectMachine(item.id);
          }
        }}>
          <title>{`${item.name}: ${display(item.hours)} RH. Select to view its trend.`}</title>
          <text x={left - 12} y={y + 17} textAnchor="end" className="bar-label">{shortened}</text>
          <rect x={left} y={y + 3} width={barWidth} height={19} rx={7} className="bar-track" />
          <rect x={itemX} y={y + 3} width={itemWidth} height={19} rx={7} className={`bar-fill ${item.alert ?? ""} ${item.hours < 0 ? "error" : ""}`} />
          <text x={item.hours < 0 ? Math.max(itemX - 8, left + 3) : Math.min(itemX + itemWidth + 8, width - right + 8)} y={y + 17} textAnchor={item.hours < 0 && itemX > left + 35 ? "end" : "start"} className="bar-value">{display(item.hours)}</text>
        </g>;
      })}
    </svg>
    <p className="chart-hint">Scroll to view all machines. Select a bar to inspect its trend; values are never combined.</p>
  </div>;
}

export default function App() {
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [year, setYear] = useState("");
  const [page, setPage] = useState<Page>("overview");
  const [busy, setBusy] = useState(false);
  const [month, setMonth] = useState(0);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [isDemo, setIsDemo] = useState(false);
  const [pmsReference, setPmsReference] = useState("");
  const [recordingEngineer, setRecordingEngineer] = useState("");
  const [monthlyInputs, setMonthlyInputs] = useState<Record<string, MonthlyInput>>({});
  const [monthlyDraftDirty, setMonthlyDraftDirty] = useState(false);
  const backupInput = useRef<HTMLInputElement>(null);
  const annualWorkbookInput = useRef<HTMLInputElement>(null);
  const historicalFolderInput = useRef<HTMLInputElement | null>(null);
  const inspectionDialog = useRef<HTMLDialogElement | null>(null);
  const monthlyDrafts = useRef(new Map<string, { inputs: Record<string, MonthlyInput>; engineer: string }>());
  const [annualFile, setAnnualFile] = useState<File | null>(null);
  const [annualPreview, setAnnualPreview] = useState<{ preview: AnnualImportSummary; fingerprint: string; revision: number } | null>(null);
  const [historicalFiles, setHistoricalFiles] = useState<File[]>([]);
  const [historicalPreview, setHistoricalPreview] = useState<{ preview: HistoricalImportSummary; fingerprint: string; revision: number } | null>(null);
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [meterInputs, setMeterInputs] = useState<string[]>(Array.from({ length: 13 }, () => ""));
  const [newMachineName, setNewMachineName] = useState("");
  const [newMachineGroup, setNewMachineGroup] = useState<EquipmentGroup>("auxiliaries");
  const [overviewGroup, setOverviewGroup] = useState<GroupFilter>("all");
  const [readingsGroup, setReadingsGroup] = useState<GroupFilter>("all");
  const [vesselName, setVesselName] = useState("");
  const [historyMachineId, setHistoryMachineId] = useState("");
  const [chartMachineId, setChartMachineId] = useState("");
  const [chartMonth, setChartMonth] = useState(0);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");

  useEffect(() => {
    let active = true;
    fetchState(isDemo ? "/api/demo" : "/api/state")
      .then((body) => {
        if (!active) return;
        setResult(body);
        const latestYear = Object.keys(body.data.years).sort().at(-1) ?? "";
        setYear(latestYear);
        setVesselName(body.data.vessel);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Unable to load records.");
      });
    return () => { active = false; };
  }, [isDemo]);

  useEffect(() => {
    document.title = vesselName
      ? `Machinery Running Hours | ${vesselName}`
      : "Machinery Running Hours";
  }, [vesselName]);

  const availableYears = useMemo(() => Object.keys(result?.data.years ?? {}).sort(), [result]);
  const yearMachines = useMemo(() => {
    if (!result || !year) return [];
    const annual = result.data.years[year] ?? {};
    return result.data.machines
      .filter((machine) => annual[machine.id])
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [result, year]);
  const readingMachines = useMemo(
    () => yearMachines.filter((machine) => readingsGroup === "all" || machineGroup(machine) === readingsGroup),
    [yearMachines, readingsGroup]
  );
  const records = useMemo(() => {
    if (!result || !year) return [];
    const annual = result.data.years[year] ?? {};
    return result.data.machines
      .filter((machine) => (includeInactive || machine.active) && annual[machine.id] && (overviewGroup === "all" || machineGroup(machine) === overviewGroup))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((machine) => ({ machine, analytics: result.analytics[year]?.[machine.id] }));
  }, [result, year, overviewGroup, includeInactive]);
  const chartMachine = records.find(({ machine }) => machine.id === chartMachineId) ?? records[0];
  const chartMonthValues = records.flatMap(({ machine, analytics }) => {
    const hours = analytics?.hours[chartMonth];
    return hours === null || hours === undefined ? [] : [{
      id: machine.id,
      name: machine.name,
      hours,
      alert: analytics?.alerts[chartMonth] ?? null
    }];
  });
  const sourceReportCount = Object.values(result?.data.source_reports ?? {})
    .flatMap((byMachine) => Object.values(byMachine).flat())
    .filter((report) => report !== null).length;
  const selectedMachine = result?.data.machines.find((machine) => machine.id === selectedMachineId);
  const selectedReadings = result?.data.years[year]?.[selectedMachineId] ?? [];
  const selectedSourceReports = result?.data.source_reports?.[year]?.[selectedMachineId];
  const selectedWorkbookSources = result?.data.workbook_sources?.[year]?.[selectedMachineId];
  const selectedManualReports = result?.data.manual_reports?.[year]?.[selectedMachineId];
  const selectedIsReadOnly = Boolean(selectedSourceReports || selectedWorkbookSources || selectedManualReports);
  const historyMachine = result?.data.machines.find((machine) => machine.id === historyMachineId);
  const historyYears = useMemo(
    () => Object.keys(result?.data.source_reports ?? {}).sort(),
    [result]
  );
  const [historyYear, setHistoryYear] = useState("");
  const historyReports = result?.data.source_reports?.[historyYear] ?? {};
  const historyCount = Object.values(historyReports)
    .flatMap((months) => months)
    .filter((report) => report !== null).length;

  useEffect(() => {
    if (!result) return;
    if (!result.data.years[year]) setYear(availableYears.at(-1) ?? "");
    if (!readingMachines.some((machine) => machine.id === selectedMachineId)) {
      const next = readingMachines[0]?.id ?? "";
      setSelectedMachineId(next);
      setMeterInputs((result.data.years[year]?.[next] ?? []).map((value) => value == null ? "" : String(value)));
    }
    if (!result.data.years[year]?.[historyMachineId]) {
      setHistoryMachineId(Object.keys(result.data.years[year] ?? {})[0] ?? "");
    }
    if (!result.data.source_reports?.[historyYear]) setHistoryYear(historyYears.at(-1) ?? "");
  }, [result, year, availableYears, readingMachines, selectedMachineId, historyMachineId, historyYear, historyYears]);

  useEffect(() => {
    if (!records.length) {
      setChartMachineId("");
      return;
    }
    if (!records.some(({ machine }) => machine.id === chartMachineId)) {
      setChartMachineId(records[0].machine.id);
    }
    const latestMonthWithData = monthNames.map((_, month) =>
      records.some(({ analytics }) => analytics?.hours[month] !== null && analytics?.hours[month] !== undefined)
    ).lastIndexOf(true);
    if (latestMonthWithData >= 0) setChartMonth(latestMonthWithData);
  }, [records, chartMachineId]);

  useEffect(() => {
    if (!result || !year) return;
    const savedDraft = monthlyDrafts.current.get(`${year}-${month}`);
    if (savedDraft) {
      setMonthlyInputs(savedDraft.inputs);
      setRecordingEngineer(savedDraft.engineer);
      setMonthlyDraftDirty(true);
      return;
    }
    const annual = result.data.years[year] ?? {};
    const initial = Object.fromEntries(readingMachines.map((machine) => {
      const meters = annual[machine.id] ?? [];
      const manual = result.data.manual_reports?.[year]?.[machine.id]?.[month];
      const source = result.data.source_reports?.[year]?.[machine.id]?.[month];
      const workbookMeter = Boolean(result.data.workbook_sources?.[year]?.[machine.id]?.[month + 1]);
      const begin = manual?.begin ?? source?.begin ?? meters[month];
      const end = manual?.end ?? source?.end ?? (workbookMeter || meters[month + 1] !== null ? meters[month + 1] : null);
      return [machine.id, {
        begin: begin == null ? "" : String(begin),
        end: end == null ? "" : String(end),
        note: manual?.note ?? ""
      }];
    }));
    setMonthlyInputs(initial);
    setMonthlyDraftDirty(false);
  }, [result, year, month, readingMachines]);

  useEffect(() => {
    if (!monthlyDraftDirty) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [monthlyDraftDirty]);

  async function saveAction(action: Action, successMessage: string) {
    if (isDemo) {
      setNotice("Demo is read-only. Return to vessel records to make changes.");
      return false;
    }
    if (!result || busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ ...action, revision: result.data.revision })
      });
      const type = response.headers.get("content-type") ?? "";
      if (!type.includes("application/json")) {
        throw new Error(`API returned ${response.status} without JSON. No confirmation was received.`);
      }
      const body = await response.json() as ApiResponse | { error?: string };
      if (!response.ok) {
        if (response.status === 409) {
          const latest = await fetchState();
          setResult(latest);
          setYear(latest.data.years[year] ? year : Object.keys(latest.data.years).sort().at(-1) ?? "");
          setVesselName(latest.data.vessel);
          setNotice("The records changed after this page was opened. Latest data loaded; review the current status and try again.");
          return false;
        }
        throw new Error("error" in body ? body.error ?? "The change was rejected." : "The change was rejected.");
      }
      setResult(body as ApiResponse);
      setYear((body as ApiResponse).data.years[year] ? year : Object.keys((body as ApiResponse).data.years).sort().at(-1) ?? "");
      setNotice(successMessage);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the change.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openMachineInspection(id?: string) {
    const target = id ?? selectedMachineId ?? readingMachines[0]?.id ?? "";
    if (!target) {
      setError("Add machinery to this year before inspecting readings.");
      return;
    }
    setSelectedMachineId(target);
    requestAnimationFrame(() => inspectionDialog.current?.showModal());
  }

  function downloadBackup() {
    if (!result) return;
    downloadFile(
      `machinery-${isDemo ? "DEMO-" : ""}${year}-backup.json`,
      JSON.stringify(result.data, null, 2),
      "application/json"
    );
  }

  async function restoreBackup(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 5_000_000) throw new Error("Backup exceeds 5 MB.");
      const backup: unknown = JSON.parse(await file.text());
      if (!window.confirm("Restore this backup as the working dataset? Current data will be retained in the database backup history.")) return;
      await saveAction({ type: "import", data: backup }, "Backup restored. Review the restored vessel records.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to read the selected backup.");
    } finally {
      if (backupInput.current) backupInput.current.value = "";
    }
  }

  function exportCsv() {
    if (!result) return;
    const recordsForMonth = records;
    const csvCell = (value: unknown) => {
      let text = String(value ?? "");
      if (/^[=+@-]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const lines: unknown[][] = [[
      "Machinery", "Year", "Month", "Opening meter", "Closing meter",
      "Monthly RH", "Screening", "Data review", "Source"
    ]];
    recordsForMonth.forEach(({ machine, analytics: machineAnalytics }) => {
      const meters = result.data.years[year]?.[machine.id] ?? [];
      const imported = result.data.source_reports?.[year]?.[machine.id]?.[month];
      const manual = result.data.manual_reports?.[year]?.[machine.id]?.[month];
      const entry = imported ?? manual;
      const hours = machineAnalytics?.hours[month] ?? null;
      const alert = machineAnalytics?.alerts[month] ?? null;
      const status = machineAnalytics?.issues[month]?.length
        ? "Review meter"
        : hours === null ? "Missing readings"
          : alert ? `${alert} utilisation` : "No alert";
      lines.push([
        machine.name, year, monthNames[month],
        entry?.begin ?? meters[month], entry?.end ?? meters[month + 1], hours,
        status, machineAnalytics?.issues[month]?.join(" | ") ?? "",
        imported ? reportLabel(imported) : manual ? `Manual / ${manual.engineer ?? ""} / ${manual.updated_at ?? ""}` : ""
      ]);
    });
    downloadFile(
      `machinery-${isDemo ? "DEMO-" : ""}${year}-${monthNames[month]}.csv`,
      `\ufeff${lines.map((row) => row.map(csvCell).join(",")).join("\r\n")}`,
      "text/csv;charset=utf-8"
    );
  }

  function createPmsAttachment() {
    if (!result) return;
    if (monthlyDraftDirty) {
      setError("Save or discard the unsaved monthly entry before creating a PMS attachment.");
      return;
    }
    if (busy) {
      setError("Wait for the current save to finish before creating a PMS attachment.");
      return;
    }
    const reportWindow = window.open("", "_blank");
    if (!reportWindow) {
      setError("Allow pop-ups for this dashboard to create the PMS attachment.");
      return;
    }
    const rows = result.data.machines.slice().sort((left, right) => left.name.localeCompare(right.name)).map((machine) => {
      const meters = result.data.years[year]?.[machine.id] ?? [];
      const report = result.data.source_reports?.[year]?.[machine.id]?.[month]
        ?? result.data.manual_reports?.[year]?.[machine.id]?.[month];
      const machineAnalytics = result.analytics[year]?.[machine.id];
      const hours = machineAnalytics?.hours[month] ?? null;
      const issues = machineAnalytics?.issues[month] ?? [];
      const alert = machineAnalytics?.alerts[month];
      const status = issues.length ? "Review meter" : hours === null ? "Missing RH" : alert ? `${alert} · review` : "Recorded";
      const source = report?.file
        ? `${report.file} · ${report.sheet ?? ""}${report.row ? ` · row ${report.row}` : ""}`
        : report?.engineer ? `Manual · ${report.engineer} · ${report.updated_at ?? ""}`
          : hours === null ? "Not recorded" : "Register";
      const notes = [...issues];
      if (alert) notes.push(`Utilisation screening: ${alert}. Review operational context.`);
      if (!machine.active) notes.push("Inactive machinery.");
      return `<tr><td>${htmlEscape(machine.name)}${machine.active ? "" : " <span>Inactive</span>"}</td><td>${display(report?.begin ?? meters[month])}</td><td>${display(report?.end ?? meters[month + 1])}</td><td>${display(hours)}</td><td>${htmlEscape(status)}</td><td>${htmlEscape(source)}</td><td>${notes.length ? notes.map(htmlEscape).join("<br>") : "—"}</td></tr>`;
    }).join("");
    const enteredBy = [...new Set(result.data.machines
      .map((machine) => result.data.manual_reports?.[year]?.[machine.id]?.[month]?.engineer)
      .filter((name): name is string => Boolean(name)))].join(", ") || "Not recorded";
    const title = `${result.data.vessel} - Monthly RH - ${year}-${String(month + 1).padStart(2, "0")}`;
    reportWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${htmlEscape(title)}</title><style>body{font:12px/1.45 Arial,sans-serif;color:#18323f;padding:24px}header{border-bottom:2px solid #183f4d;margin-bottom:16px}h1{font-size:21px}table{width:100%;border-collapse:collapse;font-size:10px}th{background:#183f4d;color:white;text-align:left;padding:8px}td{padding:7px;border-bottom:1px solid #dfe7ea;vertical-align:top}.meta{margin:12px 0}.note{padding:9px;background:#fff8e9}button{padding:8px 14px;background:#087f82;color:white;border:0}@page{size:A4 landscape;margin:12mm}@media print{.actions{display:none}body{padding:0}}</style></head><body><div class="actions"><button onclick="window.print()">Print / Save as PDF</button></div><header><small>MONTH-END PMS ATTACHMENT</small><h1>${htmlEscape(result.data.vessel)}</h1><p>Machinery running-hours record · ${monthNames[month]} ${year} · Generated ${new Date().toLocaleString()}</p></header><p class="meta">PMS job reference: ${htmlEscape(pmsReference.trim() || "Not provided")} · Recorded by: ${htmlEscape(enteredBy)} · Machinery listed: ${result.data.machines.length}</p><p class="note">Attach this month-specific record to the corresponding PMS job for office review and retention. Missing values are not treated as zero. Screening notes require engineering review and are not a fault diagnosis or compliance certification.</p><table><thead><tr><th>Machinery</th><th>Opening meter</th><th>Closing meter</th><th>Monthly RH</th><th>Record status</th><th>Record source</th><th>Review notes</th></tr></thead><tbody>${rows}</tbody></table><p>Prepared by / Engine-room engineer · signature / date ____________________</p><p>Checked by / Chief Engineer · signature / date ____________________</p><p>Office review · name / date / remarks ____________________</p></body></html>`);
    reportWindow.document.close();
    reportWindow.focus();
  }

  async function sendImportRequest(endpoint: string, form: FormData) {
    const response = await fetch(endpoint, { method: "POST", body: form });
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(`Import API returned ${response.status} without JSON.`);
    }
    const body = await response.json() as {
      error?: string; data?: State; analytics?: ApiResponse["analytics"];
      preview?: AnnualImportSummary | HistoricalImportSummary;
      fingerprint?: string; revision?: number;
      import_summary?: AnnualImportSummary | HistoricalImportSummary;
    };
    if (!response.ok) {
      if (response.status === 409) {
        const latest = await fetchState();
        setResult(latest);
        setYear(latest.data.years[year] ? year : Object.keys(latest.data.years).sort().at(-1) ?? "");
        setNotice("The records changed after this page was opened. Latest data loaded; review the current status and try again.");
      }
      throw new Error(body.error ?? "Import request was rejected.");
    }
    return body;
  }

  async function previewAnnualWorkbook() {
    if (!result || !annualFile) {
      setError("Choose an annual .xlsx workbook first.");
      return;
    }
    if (annualFile.size > 15_000_000) {
      setError("Workbook exceeds the 15 MB upload limit.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("workbook", annualFile, annualFile.name);
      form.append("revision", String(result.data.revision));
      const body = await sendImportRequest("/api/workbook-preview", form);
      if (!body.preview || !("new_values" in body.preview) || !body.fingerprint || body.revision == null) {
        throw new Error("Workbook preview response was incomplete.");
      }
      setAnnualPreview({ preview: body.preview, fingerprint: body.fingerprint, revision: body.revision });
      setNotice("Workbook preview ready. No records have been changed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to preview workbook.");
    } finally {
      setBusy(false);
    }
  }

  async function applyAnnualWorkbook() {
    if (!result || !annualFile || !annualPreview) return;
    if (monthlyDraftDirty) {
      setError("Save or discard monthly-entry drafts before importing.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      form.append("workbook", annualFile, annualFile.name);
      form.append("revision", String(annualPreview.revision));
      form.append("fingerprint", annualPreview.fingerprint);
      const body = await sendImportRequest("/api/workbook-import", form);
      if (!body.data || !body.analytics || !body.import_summary || !("new_values" in body.import_summary)) {
        throw new Error("Workbook import response was incomplete.");
      }
      const summary = body.import_summary;
      setResult({ data: body.data, analytics: body.analytics });
      setAnnualPreview(null);
      setAnnualFile(null);
      if (annualWorkbookInput.current) annualWorkbookInput.current.value = "";
      setNotice(`Imported ${summary.new_values} new meter value(s). ${summary.total_conflicts} existing value(s) were retained as conflicts.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to import workbook.");
    } finally {
      setBusy(false);
    }
  }

  async function scanHistoricalFolder() {
    if (!result || !historicalFiles.length) {
      setError("Choose a YYYY-MM report folder first.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("Scanning the selected report folder. Source workbooks will not be changed.");
    try {
      const form = new FormData();
      const accepted = historicalFiles.filter((file) => /\.(xlsx|xlsm|xls)$/i.test(file.name));
      if (!accepted.length) throw new Error("The selected folder contains no supported Excel report files.");
      if (accepted.length > 50) throw new Error("Select no more than 50 report workbooks at a time.");
      if (accepted.some((file) => file.size > 5_000_000)) throw new Error("Each historical report workbook must be 5 MB or smaller.");
      if (accepted.reduce((total, file) => total + file.size, 0) > 100_000_000) {
        throw new Error("The selected report folder exceeds the 100 MB upload limit.");
      }
      accepted.forEach((file) => form.append("files", file, file.name));
      form.append("paths", JSON.stringify(accepted.map((file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)));
      form.append("revision", String(result.data.revision));
      const body = await sendImportRequest("/api/history-preview", form);
      if (!body.preview || !("new_records" in body.preview) || !body.fingerprint || body.revision == null) {
        throw new Error("Historical import preview response was incomplete.");
      }
      setHistoricalPreview({ preview: body.preview, fingerprint: body.fingerprint, revision: body.revision });
      setNotice("Import preview ready. Conflicting records will be retained unchanged.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to scan historical reports.");
    } finally {
      setBusy(false);
    }
  }

  async function applyHistoricalFolder() {
    if (!result || !historicalPreview || !historicalFiles.length) return;
    if (monthlyDraftDirty) {
      setError("Save or discard monthly-entry drafts before applying an import.");
      return;
    }
    const accepted = historicalFiles.filter((file) => /\.(xlsx|xlsm|xls)$/i.test(file.name));
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData();
      accepted.forEach((file) => form.append("files", file, file.name));
      form.append("paths", JSON.stringify(accepted.map((file) => (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)));
      form.append("revision", String(historicalPreview.revision));
      form.append("fingerprint", historicalPreview.fingerprint);
      const body = await sendImportRequest("/api/history-import", form);
      if (!body.data || !body.analytics || !body.import_summary || !("new_records" in body.import_summary)) {
        throw new Error("Historical import response was incomplete.");
      }
      const summary = body.import_summary;
      setResult({ data: body.data, analytics: body.analytics });
      setHistoricalPreview(null);
      setHistoricalFiles([]);
      if (historicalFolderInput.current) historicalFolderInput.current.value = "";
      setNotice(`Imported ${summary.new_records} new record(s); ${summary.existing_records} already-present record(s) skipped. Conflicts and unsupported files remain for review.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to import historical reports.");
    } finally {
      setBusy(false);
    }
  }

  function chooseMachine(id: string) {
    setSelectedMachineId(id);
    setMeterInputs((result?.data.years[year]?.[id] ?? []).map((value) => value == null ? "" : String(value)));
    setError("");
  }

  async function submitReadings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedMachine || selectedIsReadOnly) return;
    let readings: Array<number | null>;
    try {
      readings = meterInputs.map((value) => {
        if (!value.trim()) return null;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Meters must be non-negative finite numbers or blank.");
        return parsed;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Enter valid meter readings.");
      return;
    }
    if (readings.length !== 13) {
      setError("The annual register must contain a previous December baseline and 12 month-end readings.");
      return;
    }
    await saveAction(
      { type: "readings", id: selectedMachine.id, year, readings },
      `${selectedMachine.name} readings saved.`
    );
  }

  function renderOverview() {
    const filterLabels: Record<ReviewFilter, string> = {
      all: "All review items",
      utilisation: "Utilisation alerts",
      idle: "No operation · 2+ months",
      exceptions: "Meter exceptions",
      missing: "Missing readings"
    };
    const needsReview = (item: typeof records[number], filter: ReviewFilter) => {
      const observation = item.analytics?.review[month];
      if (!observation) return false;
      if (filter === "utilisation") return Boolean(item.analytics?.alerts[month]);
      if (filter === "idle") return observation.zero_months >= 2;
      if (filter === "exceptions") return observation.exception;
      if (filter === "missing") return observation.missing;
      return Boolean(item.analytics?.alerts[month]) || observation.zero_months >= 2
        || observation.exception || observation.missing;
    };
    const reviewCounts = Object.fromEntries(
      (Object.keys(filterLabels) as ReviewFilter[]).map((filter) => [filter, records.filter((item) => needsReview(item, filter)).length])
    ) as Record<ReviewFilter, number>;
    const reviewItems = records.filter((item) => needsReview(item, reviewFilter)).sort((left, right) => {
      const leftReview = left.analytics?.review[month];
      const rightReview = right.analytics?.review[month];
      const priority = (item: typeof left, observation: MachineReview | undefined) =>
        observation?.exception ? 0 : (observation?.zero_months ?? 0) >= 2 ? 1
          : item.analytics?.alerts[month] ? 2 : 3;
      return priority(left, leftReview) - priority(right, rightReview)
        || (rightReview?.zero_months ?? 0) - (leftReview?.zero_months ?? 0)
        || left.machine.name.localeCompare(right.machine.name);
    });
    const systemGroups = equipmentGroups.map((group) => ({
      group,
      machines: records.filter(({ machine }) => machineGroup(machine) === group.id)
    })).filter(({ machines }) => machines.length > 0);
    const reviewGroups = equipmentGroups.map((group) => ({
      group,
      items: reviewItems.filter(({ machine }) => machineGroup(machine) === group.id)
    })).filter(({ items }) => items.length > 0);
    const reductions = records
      .filter(({ analytics: item }) => {
        const change = item?.review[month]?.change_pct;
        return change != null && change < 0 && !item?.review[month]?.exception;
      })
      .sort((left, right) => (left.analytics?.review[month]?.change_pct ?? 0) - (right.analytics?.review[month]?.change_pct ?? 0))
      .slice(0, 6);
    return <>
      <div className="overview-summary">
        <div><p className="eyebrow">MONTHLY SNAPSHOT</p><p><strong>{monthNames[month]} {year}</strong><span> · {records.length} machinery items in scope</span></p></div>
        <label className="overview-system-filter">Equipment system<select aria-label="Filter overview by equipment system" value={overviewGroup} onChange={(event) => setOverviewGroup(event.target.value as GroupFilter)}>
          <option value="all">All systems</option>
          {equipmentGroups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
        </select></label>
        <span className={`review-total ${reviewCounts.all ? "needs-review" : "all-clear"}`}>
          <i aria-hidden="true"></i>{reviewCounts.all ? `${reviewCounts.all} ${reviewCounts.all === 1 ? "machine needs" : "machines need"} review` : "No machines need review"}
        </span>
      </div>
      <section className="metrics">
        {(["utilisation", "idle", "exceptions", "missing"] as ReviewFilter[]).map((filter) => <button
          type="button" aria-label={`Review ${filterLabels[filter]}`} className={`metric metric-action ${reviewFilter === filter ? "chosen" : ""}`}
          key={filter} onClick={() => {
            setReviewFilter(filter);
            document.getElementById("engineeringPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}>
          <span>{filterLabels[filter]}</span><strong>{reviewCounts[filter]}<small> machine{reviewCounts[filter] === 1 ? "" : "s"}</small></strong>
          <p>{filter === "utilisation" ? "Low or zero use against historical behaviour."
            : filter === "idle" ? "At least two consecutive recorded zero months."
              : filter === "exceptions" ? "Possible meter continuity or calendar-hour issues."
                : "Missing or incomplete meter readings for this month."}</p>
        </button>)}
      </section>
      <p className="review-context">Select a category to inspect matching machinery. A machine may appear in more than one category.</p>
      <div className="chart-grid">
      <section className="panel chart-panel history-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">MACHINE HISTORY</p><h2>Monthly running hours</h2><p>Monthly totals for one machine · each column is a separate month</p></div>
          <label>Machinery<select aria-label="Machine trend" value={chartMachine?.machine.id ?? ""} onChange={(event) => setChartMachineId(event.target.value)}>
            {records.map(({ machine }) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
          </select></label>
        </div>
        {chartMachine
          ? <div className="machine-history-figure"><MonthlyColumnChart name={chartMachine.machine.name} hours={chartMachine.analytics?.hours ?? []} alerts={chartMachine.analytics?.alerts ?? []} /></div>
          : <div className="chart-empty">No machinery has readings for {year}.</div>}
      </section>
      <section className="panel chart-panel">
        <div className="panel-heading">
          <div><p className="eyebrow">FLEET COMPARISON</p><h2>Running hours by machine</h2><p>Highest recorded values for one month · machinery values are not combined</p></div>
          <label>Review month<select aria-label="Chart review month" value={chartMonth} onChange={(event) => setChartMonth(Number(event.target.value))}>
            {monthNames.map((month, index) => <option key={month} value={index}>{month} {year}</option>)}
          </select></label>
        </div>
        <div className="comparison-meta"><span>Top {Math.min(10, chartMonthValues.length)} of {chartMonthValues.length} machines</span><span>{monthNames[chartMonth]} {year}</span></div>
        <MachineBarChart
          values={chartMonthValues}
          month={`${monthNames[chartMonth]} ${year}`}
          onSelectMachine={(id) => setChartMachineId(id)}
        />
      </section>
      </div>
      <div className="insights-grid">
        {reductions.length > 0 && <section className="panel insight-panel">
          <div className="panel-heading"><div><p className="eyebrow">TREND WATCH</p><h2>Largest reductions</h2><p>{monthNames[month]} {year} · versus each machine’s previous three usable months</p></div></div>
          <div className="reduction-list">{reductions.map(({ machine, analytics: item }) => {
            const observation = item?.review[month];
            return <button type="button" className="reduction-row" key={machine.id} onClick={() => {
              setChartMachineId(machine.id);
              setOverviewGroup("all");
            }}><span><strong>{machine.name}</strong><small>{display(item?.hours[month])} RH this month · {display(observation?.baseline)} RH average · {(observation?.baseline_labels ?? []).join(", ")}</small></span><b>{display(Math.abs(observation?.change_pct ?? 0))}%<small>reduction</small></b></button>;
          })}</div>
          <p className="footer-note">A reduction can reflect port/sea duty or standby allocation. It is not a fault diagnosis. Missing or questioned readings are excluded.</p>
        </section>}
        <section className="panel insight-panel" id="engineeringPanel">
          <div className="panel-heading"><div><p className="eyebrow">FOLLOW-UP</p><h2>Engineering review queue</h2><p>Meter exceptions, prolonged inactivity and missing records</p></div><span className="chip">{reviewItems.length} MACHINES</span></div>
          <div className="review-filters">{(Object.keys(filterLabels) as ReviewFilter[]).map((filter) => <button type="button" key={filter} aria-pressed={reviewFilter === filter} className={reviewFilter === filter ? "selected" : ""} onClick={() => setReviewFilter(filter)}>{filterLabels[filter]} <b>{reviewCounts[filter]}</b></button>)}</div>
          {reviewGroups.length ? <div className="review-groups">{reviewGroups.map(({ group, items }) => <section className="review-group" key={group.id}>
            <div className="review-group-heading"><h3>{group.label}</h3><span>{items.length}</span></div>
            {items.map(({ machine, analytics: item }) => {
              const observation = item?.review[month];
              const tags: string[] = [];
              const notes: string[] = [];
              if (observation?.exception) {
                tags.push("Verify meter");
                notes.push(...(item?.issues[month] ?? []));
                if ((item?.hours[month] ?? 0) < 0) notes.push("Negative RH: verify the entry or document a meter reset.");
              }
              if ((observation?.zero_months ?? 0) >= 2) {
                tags.push(`${observation?.zero_months} zero months`);
                notes.push(`No recorded operation from ${observation?.zero_since ?? monthNames[month]} through ${monthNames[month]} ${year}. Check duty/standby arrangements and operation records.`);
              }
              const alert = item?.alerts[month];
              if (alert) {
                tags.push(alert === "amber" ? "Low utilisation" : "No utilisation");
                notes.push("Adaptive historical screening triggered; review operational context.");
              }
              if (observation?.missing) {
                tags.push("Missing RH");
                notes.push("Obtain the missing opening/closing readings, or confirm whether this equipment should be monitored.");
              }
              return <div className="review" key={machine.id}>
                <div><strong>{machine.name}</strong><p>{tags.join(" · ")}</p>{notes.map((note, index) => <p key={index}>{note}</p>)}</div>
                <div>{display(item?.hours[month])}<small>{monthNames[month]} RH</small></div>
                <button type="button" onClick={() => { setReadingsGroup(machineGroup(machine)); setSelectedMachineId(machine.id); setPage("readings"); }}>Inspect →</button>
              </div>;
            })}
          </section>)}</div> : <p>No machines in “{filterLabels[reviewFilter]}” for {monthNames[month]}.</p>}
          <p className="footer-note">Screening indicators only. Review duty/standby arrangements and vessel records; running hours do not establish SMS compliance.</p>
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading"><div><p className="eyebrow">MONTHLY REGISTER</p><h2>Utilisation at a glance</h2><p>Exact monthly RH by machine · missing readings remain blank</p></div><span className="chip">{records.length} machines · {year}</span></div>
        <div className="table-scroll"><table>
          <thead><tr><th>Machinery</th>{monthNames.map((month) => <th key={month}>{month}</th>)}</tr></thead>
          <tbody>{systemGroups.map(({ group, machines }) => <Fragment key={group.id}>
            <tr className="system-divider"><th scope="rowgroup" colSpan={13}><span>{group.label}</span><small>{machines.length} {machines.length === 1 ? "machine" : "machines"}</small></th></tr>
            {machines.map(({ machine, analytics }) => <tr key={machine.id}>
              <th scope="row">{machine.name}</th>
              {monthNames.map((month, index) => {
                const hours = analytics?.hours[index] ?? null;
                const alert = analytics?.alerts[index] ?? "";
                return <td key={month}><button
                  type="button"
                  className="reading-button"
                  aria-label={`View ${month} ${year} running-hour details for ${machine.name}: ${display(hours)} RH`}
                  onClick={() => openMachineInspection(machine.id)}
                ><span className={`reading ${alert}`}>{display(hours)}</span></button></td>;
              })}
            </tr>)}
          </Fragment>)}</tbody>
        </table></div>
      </section>
      <p className="footer-note">Source records are read-only. Blank meter readings are not treated as zero.</p>
    </>;
  }

  function renderReadings() {
    const activeMachines = readingMachines.filter((machine) => machine.active);
    const resetMonthlyEntryDraft = () => {
      if (!result) return;
      const annual = result.data.years[year] ?? {};
      setMonthlyInputs(Object.fromEntries(activeMachines.map((machine) => {
        const meters = annual[machine.id] ?? [];
        const manual = result.data.manual_reports?.[year]?.[machine.id]?.[month];
        const source = result.data.source_reports?.[year]?.[machine.id]?.[month];
        const workbook = Boolean(result.data.workbook_sources?.[year]?.[machine.id]?.[month + 1]);
        const begin = manual?.begin ?? source?.begin ?? meters[month];
        const end = manual?.end ?? source?.end ?? (workbook || meters[month + 1] !== null ? meters[month + 1] : null);
        return [machine.id, {
          begin: begin == null ? "" : String(begin),
          end: end == null ? "" : String(end),
          note: manual?.note ?? ""
        }];
      })));
      monthlyDrafts.current.delete(`${year}-${month}`);
      setRecordingEngineer("");
      setMonthlyDraftDirty(false);
    };
    const updateMonthlyInput = (machineId: string, input: MonthlyInput) => {
      setMonthlyInputs((current) => {
        const next = { ...current, [machineId]: input };
        monthlyDrafts.current.set(`${year}-${month}`, { inputs: next, engineer: recordingEngineer });
        return next;
      });
      setMonthlyDraftDirty(true);
    };
    const submitMonthlyEntry = async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!result) return;
      const entries: Array<{ id: string; begin: number | null; end: number | null; note: string }> = [];
      try {
        activeMachines.forEach((machine) => {
          const input = monthlyInputs[machine.id] ?? { begin: "", end: "", note: "" };
          const source = result.data.source_reports?.[year]?.[machine.id]?.[month];
          const meters = result.data.years[year]?.[machine.id] ?? [];
          const manual = result.data.manual_reports?.[year]?.[machine.id]?.[month];
          const workbook = result.data.workbook_sources?.[year]?.[machine.id]?.[month + 1];
          const legacyLocked = !source && !manual && !workbook && meters[month + 1] !== null;
          if (source || legacyLocked) return;
          const parseMeter = (value: string) => {
            if (!value.trim()) return null;
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Meters must be non-negative finite numbers or blank.");
            return parsed;
          };
          const begin = parseMeter(input.begin);
          const end = parseMeter(input.end);
          const oldBegin = manual?.begin ?? meters[month] ?? null;
          const oldEnd = manual?.end ?? (workbook ? meters[month + 1] : null) ?? null;
          const oldNote = manual?.note ?? "";
          if (begin !== oldBegin || end !== oldEnd || input.note !== oldNote) {
            entries.push({ id: machine.id, begin, end, note: input.note });
          }
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Enter valid meter readings.");
        return;
      }
      if (!entries.length) {
        setNotice("No changed readings to save.");
        return;
      }
      if (!recordingEngineer.trim()) {
        setError("Enter the recording engineer’s name (1–100 characters).");
        return;
      }
      const saved = await saveAction(
        { type: "monthly_entry", year, month, engineer: recordingEngineer, entries },
        `Saved ${entries.length} machinery record(s) for ${monthNames[month]} ${year}. History retained; analytics updated.`
      );
      if (saved) {
        monthlyDrafts.current.delete(`${year}-${month}`);
        setRecordingEngineer("");
        setMonthlyDraftDirty(false);
      }
    };

    return <section className="panel">
      <div className="panel-heading"><div><h2>Monthly meter entry</h2><p>Carry forward the opening meter, enter month-end readings, and save completed rows.</p></div><button type="button" onClick={() => openMachineInspection()}>Inspect a machine</button></div>
      <div className="entry-controls filter-row">
        <label>Entry month<select aria-label="Entry month" value={month} onChange={(event) => setMonth(Number(event.target.value))}>
          {monthNames.map((name, index) => <option key={name} value={index}>{name} {year}</option>)}
        </select></label>
        <label>Recording engineer<input maxLength={100} required placeholder="Engineer name" value={recordingEngineer} onChange={(event) => {
          setRecordingEngineer(event.target.value);
          monthlyDrafts.current.set(`${year}-${month}`, { inputs: monthlyInputs, engineer: event.target.value });
          setMonthlyDraftDirty(true);
        }} disabled={isDemo} /></label>
        <label>Equipment group<select aria-label="Meter readings equipment group" value={readingsGroup} onChange={(event) => setReadingsGroup(event.target.value as GroupFilter)}>
          <option value="all">All equipment</option>
          {equipmentGroups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
        </select></label>
      </div>
      {!activeMachines.length ? <p>No active machinery records exist for this selection.</p> : <form onSubmit={(event) => void submitMonthlyEntry(event)}>
        <p className="footer-note">Imported months are locked. Save completed readings; unknown meters may remain blank.</p>
        <div className="table-scroll"><table className="monthly-entry">
          <thead><tr><th>Machinery</th><th>Record</th><th>Opening meter</th><th>Closing meter</th><th>Monthly RH</th><th>Note / correction reason</th></tr></thead>
          <tbody>{activeMachines.map((machine) => {
            const meters = result?.data.years[year]?.[machine.id] ?? [];
            const source = result?.data.source_reports?.[year]?.[machine.id]?.[month];
            const manual = result?.data.manual_reports?.[year]?.[machine.id]?.[month];
            const workbook = result?.data.workbook_sources?.[year]?.[machine.id]?.[month + 1];
            const legacyLocked = !source && !manual && !workbook && meters[month + 1] !== null;
            const locked = Boolean(source || legacyLocked || isDemo);
            const input = monthlyInputs[machine.id] ?? { begin: "", end: "", note: "" };
            const hours = input.begin === "" || input.end === "" ? null : Number(input.end) - Number(input.begin);
            const record = source ? "Excel · locked" : legacyLocked ? "Existing · locked" : manual ? "Manual" : workbook ? "Workbook import" : "New entry";
            return <tr key={machine.id}>
              <td>{machine.name}</td><td><span className="badge">{record}</span></td>
              <td><input aria-label={`${machine.name} opening meter`} type="number" min="0" step="any" value={input.begin} disabled={locked || busy} onChange={(event) => updateMonthlyInput(machine.id, { ...input, begin: event.target.value })} /></td>
              <td><input aria-label={`${machine.name} closing meter`} type="number" min="0" step="any" value={input.end} disabled={locked || busy} onChange={(event) => updateMonthlyInput(machine.id, { ...input, end: event.target.value })} /></td>
              <td>{display(hours)}</td>
              <td><input aria-label={`${machine.name} note or correction reason`} maxLength={1000} value={input.note} disabled={locked || busy} onChange={(event) => updateMonthlyInput(machine.id, { ...input, note: event.target.value })} /></td>
            </tr>;
          })}</tbody>
        </table></div>
        <div className="dialog-actions">
          <button type="button" disabled={isDemo || busy || !monthlyDraftDirty} onClick={resetMonthlyEntryDraft}>Discard draft</button>
          <button type="submit" className="primary" disabled={isDemo || busy || !monthlyDraftDirty}>{busy ? "Saving…" : "Save monthly readings"}</button>
        </div>
      </form>}
      <details className="annual-register"><summary>View annual closing-meter register</summary>
        <div className="table-scroll"><table><thead><tr><th>Machinery</th><th>Previous Dec</th>{monthNames.map((name) => <th key={name}>{name}</th>)}</tr></thead>
          <tbody>{yearMachines.map((machine) => <tr key={machine.id}><th>{machine.name}</th>{(result?.data.years[year]?.[machine.id] ?? []).map((value, index) => <td key={index}>{display(value)}</td>)}</tr>)}</tbody>
        </table></div>
      </details>
    </section>;
  }

  function renderMachinery() {
    const systemGroups = equipmentGroups.map((group) => ({
      group,
      machines: [...(result?.data.machines ?? [])]
        .filter((machine) => machineGroup(machine) === group.id)
        .sort((left, right) => left.name.localeCompare(right.name))
    })).filter(({ machines }) => machines.length > 0);
    return <>
      <section className="panel system-directory">
        <div className="panel-heading"><div><p className="eyebrow">MACHINERY REGISTER</p><h2>Equipment by system</h2><p>Select a machine to jump to its register entry. Categories follow the vessel equipment register.</p></div><span className="chip">{result?.data.machines.length ?? 0} MACHINES · {systemGroups.length} SYSTEMS</span></div>
        {systemGroups.length ? <div className="system-directory-grid">{systemGroups.map(({ group, machines }) => <section className="system-card" key={group.id}>
          <div className="system-card-heading"><h3>{group.label}</h3><span>{machines.length}</span></div>
          <div className="system-machine-list">{machines.map((machine) => <button type="button" key={machine.id} onClick={() => {
            const groupDetails = document.getElementById(`equipment-group-${group.id}`);
            if (groupDetails instanceof HTMLDetailsElement) groupDetails.open = true;
            document.getElementById(`registered-machine-${machine.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
          }}>{machine.name}<span aria-hidden="true">↗</span></button>)}</div>
        </section>)}</div> : <p>No machinery has been added to the register.</p>}
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Vessel and equipment register</h2><p>Deactivating equipment retains its historical readings.</p></div></div>
        <form className="inline-form" onSubmit={(event) => {
          event.preventDefault();
          void saveAction({ type: "vessel", name: vesselName }, "Vessel name updated.");
        }}>
          <label>Vessel name<input maxLength={100} required value={vesselName} onChange={(event) => setVesselName(event.target.value)} /></label>
          <button type="submit" disabled={busy || vesselName.trim() === result?.data.vessel}>Save vessel name</button>
        </form>
        <form className="inline-form" onSubmit={(event) => {
          event.preventDefault();
          if (!newMachineName.trim()) return;
          void saveAction({ type: "add", year, name: newMachineName, group: newMachineGroup }, "Machinery added to the selected reporting year.").then((saved) => {
            if (saved) setNewMachineName("");
          });
        }}>
          <label>Add machinery to {year}<input maxLength={100} required value={newMachineName} onChange={(event) => setNewMachineName(event.target.value)} placeholder="Machinery name" /></label>
          <label>Equipment group<select aria-label="New machinery equipment group" value={newMachineGroup} onChange={(event) => setNewMachineGroup(event.target.value as EquipmentGroup)}>
            {equipmentGroups.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
          </select></label>
          <button className="primary" type="submit" disabled={busy}>Add machinery</button>
        </form>
        <div className="register-list equipment-groups">
          {equipmentGroups.map((group, index) => {
            const groupedMachines = [...(result?.data.machines ?? [])]
              .filter((machine) => machineGroup(machine) === group.id)
              .sort((left, right) => left.name.localeCompare(right.name));
            if (!groupedMachines.length) return null;
            return <details className="equipment-group" id={`equipment-group-${group.id}`} key={group.id} open={index === 0}>
              <summary><span>{group.label}</span><span className="group-count">{groupedMachines.length}</span></summary>
              <div className="group-machines">{groupedMachines.map((machine) => (
                <div className="register-row" id={`registered-machine-${machine.id}`} key={machine.id}>
                  <div className="machine-summary"><strong>{machine.name}</strong><span className={`badge ${machine.active ? "active" : ""}`}>{machine.active ? "Active" : "Inactive"}</span></div>
                  <div className="row-actions">
                    <label className="machine-group-select">Group<select aria-label={`${machine.name} equipment group`} value={machineGroup(machine)} disabled={busy} onChange={(event) => {
                      const groupId = event.target.value as EquipmentGroup;
                      void saveAction({ type: "group", id: machine.id, group: groupId }, `${machine.name} moved to ${groupLabel(groupId)}.`);
                    }}>
                      {equipmentGroups.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                    </select></label>
                    <button type="button" disabled={busy} onClick={() => {
                      const name = window.prompt("Machinery name", machine.name);
                      if (name?.trim()) void saveAction({ type: "rename", id: machine.id, name, group: machineGroup(machine) }, "Machinery name updated.");
                    }}>Rename</button>
                    <button type="button" disabled={busy} onClick={() => void saveAction(
                      { type: "active", year, id: machine.id, active: !machine.active },
                      machine.active ? "Machinery deactivated; its history is retained." : "Machinery activated."
                    )}>{machine.active ? "Deactivate" : "Activate"}</button>
                  </div>
                </div>
              ))}</div>
            </details>;
          })}
        </div>
        <div className="register-footer">
          <button type="button" disabled={busy || !year || result?.data.years[String(Number(year) + 1)] !== undefined} onClick={() => {
            const nextYear = Number(year) + 1;
            if (window.confirm(`Create ${nextYear}? December meters will be carried forward as opening baselines. Existing years will not be overwritten.`)) {
              void saveAction({ type: "rollover", year }, `${nextYear} reporting year created.`);
            }
          }}>Create next reporting year</button>
        </div>
      </section>
    </>;
  }

  function renderHistory() {
    const machineOptions = Object.keys(historyReports)
      .map((id) => result?.data.machines.find((machine) => machine.id === id))
      .filter((machine): machine is Machine => Boolean(machine))
      .sort((left, right) => left.name.localeCompare(right.name));
    const reports = historyReports[historyMachineId] ?? [];
    return <>
      <section className="panel">
        <div className="panel-heading"><div><h2>Imported monthly reports</h2><p>Historical source observations migrated from the Python dashboard.</p></div></div>
        {result?.data.import_info?.note && <div className="callout">{result.data.import_info.note}</div>}
        <div className="filter-row">
          <label>Source year<select value={historyYear} onChange={(event) => setHistoryYear(event.target.value)}>
            {historyYears.map((item) => <option key={item}>{item}</option>)}
          </select></label>
          <label>Machinery<select value={historyMachineId} onChange={(event) => setHistoryMachineId(event.target.value)}>
            {machineOptions.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
          </select></label>
          <span className="chip">{historyCount} reports in {historyYear}</span>
        </div>
        {!historyYears.length ? <p>No monthly source reports were migrated.</p> : <div className="table-scroll">
          <table><thead><tr><th>Month</th><th>Opening meter</th><th>Closing meter</th><th>Reported RH</th><th>Calculated RH</th><th>Source</th></tr></thead><tbody>
            {monthNames.map((month, index) => {
              const report = reports[index];
              const monthHours = typeof report?.begin === "number" && typeof report?.end === "number" ? report.end - report.begin : null;
              return <tr key={month}>
                <th scope="row">{month}</th>
                <td>{display(report?.begin)}</td><td>{display(report?.end)}</td>
                <td>{display(report?.reported)}</td><td>{display(monthHours)}</td>
                <td>{report ? reportLabel(report) : "No imported report"}</td>
              </tr>;
            })}
          </tbody></table>
        </div>}
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Import an annual Running Hour Sheet</h2><p>Upload the completed annual workbook to add its meter readings to this dashboard.</p></div></div>
        <p className="footer-note">Choose the annual .xlsx workbook, preview the years and conflicts, then confirm. Blank dashboard values are filled; existing values are preserved. Calculated RH cells are not imported.</p>
        <div className="entry-controls filter-row">
          <label>Annual workbook<input ref={annualWorkbookInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={isDemo || busy} onChange={(event) => {
            setAnnualFile(event.target.files?.[0] ?? null);
            setAnnualPreview(null);
          }} /></label>
          <button type="button" disabled={isDemo || busy || !annualFile} onClick={() => void previewAnnualWorkbook()}>Preview workbook</button>
        </div>
        {annualPreview ? <div className="import-preview">
          <div className="import-summary">
            <span><b>{annualPreview.preview.years.join(", ")}</b> reporting years</span>
            <span><b>{annualPreview.preview.machines}</b> machines</span>
            <span><b>{annualPreview.preview.new_values}</b> new meter values</span>
            <span><b>{annualPreview.preview.identical_values}</b> identical values</span>
            <span><b>{annualPreview.preview.total_conflicts}</b> conflicts retained</span>
          </div>
          <p>{annualPreview.preview.filename} · {annualPreview.preview.new_machines.length} new machinery items. Existing readings are never overwritten.</p>
          {annualPreview.preview.conflicts.map((conflict, index) => <p className="footer-note" key={index}>{conflict.machine} · {conflict.year} · {conflict.field}: app has {display(conflict.existing)}; workbook has {display(conflict.uploaded)}</p>)}
          {annualPreview.preview.new_machines.length > 0 && <p className="footer-note">New machinery: {annualPreview.preview.new_machines.join(", ")}</p>}
        </div> : <p>Choose an annual Running Hour Sheet .xlsx workbook, then preview it. No readings are changed until you confirm the import.</p>}
        <div className="dialog-actions">        <button type="button" className="primary" disabled={isDemo || busy || monthlyDraftDirty || !annualPreview || (!annualPreview.preview.new_values && !annualPreview.preview.new_machines.length)} onClick={() => void applyAnnualWorkbook()}>{busy ? "Importing…" : "Import non-conflicting values"}</button></div>
      </section>
      <section className="panel">
        <div className="panel-heading"><div><h2>Historical monthly-report repository</h2><p>Scan supported monthly report workbooks in the selected YYYY-MM folders.</p></div></div>
        <p className="footer-note">Supported: auxiliary machinery summary, supplementary machinery report, and HIMSEN engine report. Other layouts are listed for review. Select the folder containing YYYY-MM report folders.</p>
        <div className="entry-controls filter-row">
          <label>Report folder<input ref={(element) => {
            historicalFolderInput.current = element;
            element?.setAttribute("webkitdirectory", "");
          }} type="file" multiple disabled={isDemo || busy} onChange={(event) => {
            setHistoricalFiles(Array.from(event.target.files ?? []));
            setHistoricalPreview(null);
          }} /></label>
          <button type="button" className="primary" disabled={isDemo || busy || !historicalFiles.length} onClick={() => void scanHistoricalFolder()}>Scan source folder</button>
        </div>
        {historicalFiles.length > 0 && <p>{historicalFiles.length} files selected · Source workbooks will not be changed.</p>}
        {historicalPreview && <div className="import-preview">
          <div className="import-summary">
            <span><b>{historicalPreview.preview.new_records}</b> new records</span>
            <span><b>{historicalPreview.preview.existing_records}</b> already present</span>
            <span><b>{historicalPreview.preview.conflicts.length}</b> conflicts</span>
            <span><b>{historicalPreview.preview.duplicate_files.length}</b> duplicate files</span>
            <span><b>{historicalPreview.preview.errors.length}</b> files need review</span>
          </div>
          <p>{historicalPreview.preview.files} files scanned · {historicalPreview.preview.new_machines} new machinery names. Only new records will be added; existing readings remain unchanged.</p>
          {historicalPreview.preview.conflicts.map((conflict, index) => <p className="footer-note" key={index}>{conflict.machine} · {conflict.year}-{String(conflict.month).padStart(2, "0")}: {conflict.reason} · {conflict.files.join(", ")}</p>)}
          {historicalPreview.preview.errors.map((item, index) => <p className="footer-note" key={index}>{item.file}: {item.error}</p>)}
          {historicalPreview.preview.duplicate_files.map((file) => <p className="footer-note" key={file}>Duplicate file: {file}</p>)}
        </div>}
        <div className="dialog-actions"><button type="button" className="primary" disabled={isDemo || busy || monthlyDraftDirty || !historicalPreview || !historicalPreview.preview.new_records} onClick={() => void applyHistoricalFolder()}>{busy ? "Importing…" : "Import new records"}</button></div>
      </section>
    </>;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span>≋</span><div>ENGINE ROOM<small>VESSEL PERFORMANCE</small></div></div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Workspace">
          {pages.map((item) => <button
            type="button"
            className={`nav-item ${page === item.id ? "active" : ""}`}
            aria-current={page === item.id ? "page" : undefined}
            key={item.id}
            onClick={() => { setPage(item.id); setError(""); setNotice(""); }}
          >{item.icon} &nbsp; {item.label}</button>)}
        </nav>
        <div className="connection">● &nbsp; {isDemo ? "Demonstration data" : "Shared database"}<small>{isDemo ? "Read-only sample records" : "Connected to vessel records"}</small></div>
      </aside>
      <main>
        <header>
          <div><p className="eyebrow">MACHINERY RUNNING HOURS</p><h1>{pageTitles[page]}</h1><p className="vessel">{result?.data.vessel ?? "Loading vessel…"}</p></div>
          <div className="header-actions">
            <button type="button" onClick={() => { setIsDemo((current) => !current); setError(""); setNotice(""); }}>
              {isDemo ? "Return to vessel records" : "Explore demo"}
            </button>
            <label>Reporting year<select value={year} onChange={(event) => {
              setYear(event.target.value);
              setSelectedMachineId("");
              setMonth(Math.min(month, 11));
            }} disabled={!result}>
              {availableYears.map((item) => <option key={item}>{item}</option>)}
            </select></label>
            <button type="button" className="primary" onClick={() => { setPage("readings"); setNotice(""); setError(""); }} disabled={isDemo}>+ Enter readings</button>
          </div>
        </header>
        {error && <div className="error" role="alert">{error}</div>}
        {notice && <div className="notice" role="status">{notice}</div>}
        {!result && !error && <p role="status">Loading vessel data…</p>}
        {isDemo && <div className="callout" role="status"><strong>DEMONSTRATION DATA</strong> Sample readings only. Your vessel records are unchanged.</div>}
        {result && <div className="toolbar">
          <div className="toolbar-controls">
            <label>Review month<select aria-label="Review month" value={month} onChange={(event) => setMonth(Number(event.target.value))}>
              {monthNames.map((name, index) => <option key={name} value={index}>{name} {year}</option>)}
            </select></label>
            <label className="check"><input type="checkbox" checked={includeInactive} onChange={(event) => setIncludeInactive(event.target.checked)} /> Include inactive machinery</label>
          </div>
          <details className="data-tools">
            <summary>Data tools</summary>
            <div className="data-tool-actions">
              <label className="pms-reference">PMS job ref.<input maxLength={60} placeholder="Optional reference" value={pmsReference} onChange={(event) => setPmsReference(event.target.value)} /></label>
              <button type="button" onClick={exportCsv}>↓ Export CSV</button>
              <button type="button" className="primary" onClick={createPmsAttachment}>Create PMS attachment</button>
              <button type="button" onClick={downloadBackup}>↓ Download backup</button>
              <button type="button" onClick={() => backupInput.current?.click()} disabled={isDemo}>↑ Restore backup</button>
            </div>
          </details>
          <input ref={backupInput} type="file" accept=".json,application/json" hidden onChange={(event) => void restoreBackup(event.target.files?.[0])} />
        </div>}
        {result && page === "overview" && renderOverview()}
        {result && page === "readings" && renderReadings()}
        {result && page === "machinery" && renderMachinery()}
        {result && page === "history" && renderHistory()}
        <p className="footer-note">{isDemo ? "DEMO · not saved to vessel records" : `Stored in shared database · Revision ${result?.data.revision ?? "—"}`}</p>
        <dialog ref={inspectionDialog} className="inspection-dialog" onClick={(event) => {
          if (event.target === inspectionDialog.current) inspectionDialog.current.close();
        }}>
          <div className="panel-heading"><div><span className="eyebrow">METER ENTRY</span><h2>Machinery record</h2></div><button type="button" aria-label="Close" onClick={() => inspectionDialog.current?.close()}>×</button></div>
          <label>Machinery<select value={selectedMachineId} onChange={(event) => setSelectedMachineId(event.target.value)}>
            {yearMachines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
          </select></label>
          <p>Reporting year {year}{isDemo ? " · read-only demo" : ""}</p>
          {selectedMachine && <div className="table-scroll">
            <p className="footer-note">Excel history is retained unchanged. Add or correct manual readings through Monthly entry.</p>
            <table><thead><tr><th>Month</th><th>Origin</th><th>Opening</th><th>Closing</th><th>Monthly RH</th></tr></thead><tbody>
              {monthNames.map((name, index) => {
                const imported = result?.data.source_reports?.[year]?.[selectedMachine.id]?.[index];
                const manual = result?.data.manual_reports?.[year]?.[selectedMachine.id]?.[index];
                const workbook = result?.data.workbook_sources?.[year]?.[selectedMachine.id]?.[index + 1];
                const meters = result?.data.years[year]?.[selectedMachine.id] ?? [];
                const item = result?.analytics[year]?.[selectedMachine.id];
                return <tr key={name}>
                  <th scope="row">{name}</th>
                  <td>{imported ? "Excel" : manual ? "Manual" : workbook ? "Workbook" : "—"}</td>
                  <td>{display(imported?.begin ?? manual?.begin ?? meters[index])}</td>
                  <td>{display(imported?.end ?? manual?.end ?? meters[index + 1])}</td>
                  <td>{display(item?.hours[index])}</td>
                </tr>;
              })}
            </tbody></table>
            {monthNames.map((name, index) => {
              const imported = result?.data.source_reports?.[year]?.[selectedMachine.id]?.[index];
              const manual = result?.data.manual_reports?.[year]?.[selectedMachine.id]?.[index];
              const issues = result?.analytics[year]?.[selectedMachine.id]?.issues[index] ?? [];
              if (!imported && !manual && !issues.length) return null;
              return <p className="footer-note" key={name}><strong>{name}:</strong> {imported ? reportLabel(imported) : manual ? `Entered by ${manual.engineer ?? "unknown"} · ${manual.updated_at ?? ""}${manual.note ? ` · ${manual.note}` : ""}` : ""}{issues.map((issue) => ` · ${issue}`).join("")}</p>;
            })}
          </div>}
          <div className="dialog-actions"><button type="button" onClick={() => inspectionDialog.current?.close()}>Close</button></div>
        </dialog>
      </main>
    </div>
  );
}
