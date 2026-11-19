// Validation configuration. Every tolerance here is a SCREENING THRESHOLD chosen for investigation, not a DNV
// tolerance; DNV's own tolerances are not published in the material available. Values are decimal strings so the
// configuration hashes identically across runs.

import { parseDec } from "./decimal"
import { canonicalJson, fnv1a64 } from "./hash"

export type LogSourceKind = "LA" | "OVDLA"

export type ValidationConfig = Readonly<{
  configVersion: 1
  /** Log sources the record rules (B–G) run on. Reconciliation always compares LA with OVDLA when both exist. */
  logSources: readonly LogSourceKind[]
  /**
   * Order in which voyage, fuel, cargo, duration and distance rules read the records.
   * "timeline": records inside the reporting period ordered by UTC timestamp, a superseded same-minute row dropped —
   *   how OVD itself keys and processes event reports (Notes on GHG reporting, rows 6 and 20).
   * "submitted": the row order of the file. Rule B01 always checks the submitted order.
   */
  sequenceBasis: "timeline" | "submitted"
  /** Reporting period, inclusive UTC calendar dates (YYYY-MM-DD). */
  period: Readonly<{ from: string; to: string }> | null
  /** Vessel IMO number expected in the files, when known. */
  imo: string | null
  fuelToleranceMt: string
  cargoToleranceMt: string
  durationToleranceHours: string
  maxReportIntervalHours: string
  bunkerProximityHours: number
  distanceShortToleranceNm: string
  distanceExcessFactor: string
  distanceExcessMinNm: string
  maxPlausibleSpeedKn: string
  nearMatchMinutes: number
  /** D09: a voyage/port stay whose consumption per hour exceeds the median of its kind × this factor is reported. */
  consumptionDeviationFactor: string
  /** G06: a voyage whose reported distance exceeds the track of reported positions by more than this % is reported. */
  voyageDistanceDeviationPct: string
}>

export const DEFAULT_CONFIG: ValidationConfig = Object.freeze({
  configVersion: 1,
  logSources: ["LA"],
  sequenceBasis: "timeline",
  period: null,
  imo: null,
  fuelToleranceMt: "0.5",
  cargoToleranceMt: "1",
  durationToleranceHours: "0.1",
  maxReportIntervalHours: "30",
  bunkerProximityHours: 72,
  distanceShortToleranceNm: "1",
  distanceExcessFactor: "1.5",
  distanceExcessMinNm: "20",
  maxPlausibleSpeedKn: "30",
  nearMatchMinutes: 60,
  consumptionDeviationFactor: "1.5",
  voyageDistanceDeviationPct: "10",
} satisfies ValidationConfig)

export const CONFIG_HELP: Record<string, string> = {
  sequenceBasis: "Timeline: records in the period ordered by UTC time, as OVD processes them. Submitted: the file's row order.",
  fuelToleranceMt: "Fuel residual (mt) above which a step is reported. Screening threshold, not a DNV tolerance.",
  cargoToleranceMt: "Cargo change (mt) treated as a real change.",
  durationToleranceHours: "Allowed difference (hours) between reported duration and UTC elapsed time.",
  maxReportIntervalHours: "Interval (hours) between successive reports above which the gap is reported.",
  bunkerProximityHours: "Window (hours) around a fuel discontinuity searched for bunker deliveries.",
  distanceShortToleranceNm: "Reported distance may fall this far (nm) below the geodesic minimum before it is reported.",
  distanceExcessFactor: "Reported distance above geodesic × this factor is reported for review.",
  distanceExcessMinNm: "Minimum excess (nm) before a long distance is reported.",
  maxPlausibleSpeedKn: "Implied speed (geodesic ÷ elapsed time) above which positions/timestamps are questioned.",
  nearMatchMinutes: "Reconciliation: unmatched records this close in time with the same event are shown as possible matches.",
  consumptionDeviationFactor: "A voyage or port stay burning more than this × the median rate (mt/h) of the other voyages / port stays in the period is reported. Screening threshold, not a DNV value.",
  voyageDistanceDeviationPct: "A voyage whose reported distance exceeds the track of its reported positions by more than this percentage is reported. Screening threshold, not a DNV value.",
}

export class ConfigError extends Error {}

const DECIMAL_KEYS = [
  "fuelToleranceMt", "cargoToleranceMt", "durationToleranceHours", "maxReportIntervalHours",
  "distanceShortToleranceNm", "distanceExcessFactor", "distanceExcessMinNm", "maxPlausibleSpeedKn",
  "consumptionDeviationFactor", "voyageDistanceDeviationPct",
] as const

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Strict validation of a configuration received from the UI/API. Unknown keys are rejected. */
export function parseConfig(input: unknown): ValidationConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ConfigError("Configuration must be an object.")
  const value = { ...DEFAULT_CONFIG, ...(input as Record<string, unknown>) } as Record<string, unknown>
  const allowed = new Set(Object.keys(DEFAULT_CONFIG))
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new ConfigError(`Unknown configuration key "${key}".`)
  if (value.configVersion !== 1) throw new ConfigError("Unsupported configuration version.")
  for (const key of DECIMAL_KEYS) {
    const v = value[key]
    const parsed = typeof v === "string" ? parseDec(v) : null
    if (!parsed || parsed.m < 0n) throw new ConfigError(`${key} must be a non-negative decimal string.`)
  }
  for (const key of ["bunkerProximityHours", "nearMatchMinutes"] as const) {
    const v = value[key]
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 24 * 365) throw new ConfigError(`${key} must be a non-negative whole number.`)
  }
  if (value.sequenceBasis !== "timeline" && value.sequenceBasis !== "submitted") throw new ConfigError("sequenceBasis must be timeline or submitted.")
  const sources = value.logSources
  if (!Array.isArray(sources) || sources.length === 0 || sources.some((s) => s !== "LA" && s !== "OVDLA") || new Set(sources).size !== sources.length) {
    throw new ConfigError("logSources must list LA and/or OVDLA.")
  }
  const period = value.period
  if (period !== null) {
    const p = period as Record<string, unknown>
    if (!p || typeof p !== "object" || typeof p.from !== "string" || typeof p.to !== "string" || !DATE.test(p.from) || !DATE.test(p.to) || p.from > p.to) {
      throw new ConfigError("period must be { from: YYYY-MM-DD, to: YYYY-MM-DD } with from ≤ to.")
    }
    value.period = { from: p.from, to: p.to }
  }
  if (value.imo !== null && (typeof value.imo !== "string" || !/^\d{7}$/.test(value.imo))) throw new ConfigError("imo must be 7 digits or null.")
  return Object.freeze(value as ValidationConfig)
}

export function configHash(config: ValidationConfig): string {
  return fnv1a64(canonicalJson(config))
}

export function periodBounds(config: ValidationConfig): { fromMs: number; toMs: number } | null {
  if (!config.period) return null
  const fromMs = Date.parse(`${config.period.from}T00:00:00Z`)
  const toMs = Date.parse(`${config.period.to}T00:00:00Z`) + 86_400_000 - 1
  return { fromMs, toMs }
}
