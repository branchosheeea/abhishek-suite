// Analytical representation of source rows. This is a separate, read-only view built FROM the frozen source
// table; it never replaces it. Every value keeps its original column and raw text so it can be traced back.

import { classifyEvent, type EventClass } from "./events"
import { deepFreeze } from "./hash"
import { BUNKER_FUEL_CATEGORY, type ColumnMap, type MappedColumn, type Role, columnFor, columnsFor } from "./schema"
import type { SourceRef, SourceRow, SourceTable } from "./types"
import { type CellMeta, type NumState, type PositionState, readDateTime, readNumber, readPosition, readTimestamp, type TimeState } from "./values"

export type Exclusion = Readonly<{ sha256: string; line: number; reason: string }>

export type ValueCell = Readonly<{ column: string; value: NumState }>
export type ConsumptionCell = Readonly<{ column: string; consumer: string; value: NumState }>
export type AllocationCell = Readonly<{ column: string; purpose: string; value: NumState }>

export type LogRecord = Readonly<{
  ref: SourceRef
  /** Reason given by the user, or null. Excluded records stay visible and are skipped by calculations. */
  excluded: string | null
  blank: boolean
  imoRaw: string | null
  time: TimeState
  timeColumns: readonly string[]
  eventRaw: string | null
  eventClass: EventClass
  voyageFrom: string | null
  voyageTo: string | null
  duration: ValueCell | null
  /** Time_Elapsed_Maneuvering (hours), when the column exists. */
  maneuvering: ValueCell | null
  distance: ValueCell | null
  cargo: ValueCell | null
  rob: Readonly<Record<string, ValueCell>>
  consumption: Readonly<Record<string, readonly ConsumptionCell[]>>
  /** "Portion of total consumption" columns (cargo heating, DP, DPP cargo pumps). Never added to consumption. */
  allocations: Readonly<Record<string, readonly AllocationCell[]>>
  /** BDN-scheme consumption columns (ME_Consumption, AE_Consumption_BDN_2, …). */
  bdnConsumption: readonly ValueCell[]
  position: PositionState | null
  positionColumns: readonly string[]
}>

export type BunkerDelivery = Readonly<{
  ref: SourceRef
  excluded: string | null
  /** Log Abstract fuel category the delivered grade belongs to (documented mapping), or null if unmapped. */
  fuel: string | null
  /** Fuel_Type as written in the Bunker Report. */
  fuelRaw: string | null
  fuelColumn: string | null
  mass: ValueCell
  time: TimeState
  bdn: string | null
  port: string | null
}>

export function refOf(table: SourceTable, row: SourceRow): SourceRef {
  return { sha256: table.sha256, kind: table.kind, line: row.line, index: row.index }
}

function cell(row: SourceRow, column: MappedColumn | undefined): string | null {
  if (!column) return null
  return row.cells[column.index] ?? ""
}

function meta(row: SourceRow, column: MappedColumn | undefined): CellMeta {
  if (!column) return {}
  return { type: row.types?.[column.index], dateFormatted: row.dateFormatted?.[column.index] }
}

function trimmedOrNull(raw: string | null): string | null {
  if (raw === null) return null
  const text = raw.trim()
  return text === "" ? null : text
}

function timeOf(table: SourceTable, map: ColumnMap, row: SourceRow): { time: TimeState; columns: string[] } {
  const datetime = columnFor(map, (r) => r.kind === "datetime")
  if (datetime) {
    return { time: readDateTime(cell(row, datetime) ?? "", meta(row, datetime), table.meta.date1904), columns: [datetime.header] }
  }
  const date = columnFor(map, (r) => r.kind === "date")
  const time = columnFor(map, (r) => r.kind === "time")
  if (!date) return { time: { state: "invalid", reason: "no date column was identified" }, columns: [] }
  return {
    time: readTimestamp(cell(row, date), cell(row, time), meta(row, date), meta(row, time), table.meta.date1904),
    columns: [date.header, ...(time ? [time.header] : [])],
  }
}

function valueCell(row: SourceRow, column: MappedColumn | undefined): ValueCell | null {
  if (!column) return null
  return { column: column.header, value: readNumber(cell(row, column) ?? "") }
}

export function exclusionReason(exclusions: readonly Exclusion[], ref: SourceRef): string | null {
  const hit = exclusions.find((e) => e.sha256 === ref.sha256 && e.line === ref.line)
  return hit ? hit.reason : null
}

export function buildLogRecords(table: SourceTable, map: ColumnMap, exclusions: readonly Exclusion[] = []): LogRecord[] {
  const imo = columnFor(map, (r) => r.kind === "imo")
  const event = columnFor(map, (r) => r.kind === "event")
  const from = columnFor(map, (r) => r.kind === "voyageFrom")
  const to = columnFor(map, (r) => r.kind === "voyageTo")
  const duration = columnFor(map, (r) => r.kind === "durationHours")
  const maneuvering = columnFor(map, (r) => r.kind === "maneuveringHours")
  const distance = columnFor(map, (r) => r.kind === "distanceNm")
  const cargo = columnFor(map, (r) => r.kind === "cargoMt")
  const robColumns = columnsFor(map, (r) => r.kind === "rob")
  const consumptionColumns = columnsFor(map, (r) => r.kind === "consumption")
  const allocationColumns = columnsFor(map, (r) => r.kind === "allocation")
  const bdnColumns = columnsFor(map, (r) => r.kind === "bdnConsumption")
  const pos = (kind: Role["kind"]) => columnFor(map, (r) => r.kind === kind)
  const positionCols = (["latDeg", "latMin", "latHem", "lonDeg", "lonMin", "lonHem", "latDecimal", "lonDecimal"] as const).map((k) => [k, pos(k)] as const)

  const records = table.rows.map((row): LogRecord => {
    const ref = refOf(table, row)
    const { time, columns: timeColumns } = timeOf(table, map, row)
    const rob: Record<string, ValueCell> = {}
    for (const c of robColumns) {
      const fuel = (c.role as Extract<Role, { kind: "rob" }>).fuel
      rob[fuel] = { column: c.header, value: readNumber(cell(row, c) ?? "") }
    }
    const consumption: Record<string, ConsumptionCell[]> = {}
    for (const c of consumptionColumns) {
      const role = c.role as Extract<Role, { kind: "consumption" }>
      ;(consumption[role.fuel] ??= []).push({ column: c.header, consumer: role.consumer, value: readNumber(cell(row, c) ?? "") })
    }
    const allocations: Record<string, AllocationCell[]> = {}
    for (const c of allocationColumns) {
      const role = c.role as Extract<Role, { kind: "allocation" }>
      ;(allocations[role.fuel] ??= []).push({ column: c.header, purpose: role.purpose, value: readNumber(cell(row, c) ?? "") })
    }
    const bdnConsumption = bdnColumns.map((c) => ({ column: c.header, value: readNumber(cell(row, c) ?? "") }))
    const positionInput: Record<string, string | null> = {}
    const positionColumns: string[] = []
    for (const [key, column] of positionCols) {
      if (column) {
        positionInput[key] = cell(row, column)
        positionColumns.push(column.header)
      }
    }
    const eventRaw = cell(row, event)
    return {
      ref,
      excluded: exclusionReason(exclusions, ref),
      blank: row.blankLine === true || row.cells.every((c) => c.trim() === ""),
      imoRaw: cell(row, imo),
      time,
      timeColumns,
      eventRaw,
      eventClass: classifyEvent(eventRaw),
      voyageFrom: trimmedOrNull(cell(row, from)),
      voyageTo: trimmedOrNull(cell(row, to)),
      duration: valueCell(row, duration),
      maneuvering: valueCell(row, maneuvering),
      distance: valueCell(row, distance),
      cargo: valueCell(row, cargo),
      rob,
      consumption,
      allocations,
      bdnConsumption,
      position: positionColumns.length ? readPosition(positionInput) : null,
      positionColumns,
    }
  })
  return deepFreeze(records)
}

export function buildBunkerDeliveries(table: SourceTable, map: ColumnMap, exclusions: readonly Exclusion[] = []): BunkerDelivery[] {
  const fuelColumn = columnFor(map, (r) => r.kind === "bunkerFuel")
  const massColumn = columnFor(map, (r) => r.kind === "bunkerMass")
  const byFuel = columnsFor(map, (r) => r.kind === "bunkerByFuel")
  const bdn = columnFor(map, (r) => r.kind === "bdn")
  const port = columnFor(map, (r) => r.kind === "port")
  const deliveries: BunkerDelivery[] = []
  for (const row of table.rows) {
    if (row.blankLine) continue
    const ref = refOf(table, row)
    const { time } = timeOf(table, map, row)
    const common = { ref, excluded: exclusionReason(exclusions, ref), time, bdn: trimmedOrNull(cell(row, bdn)), port: trimmedOrNull(cell(row, port)) }
    if (fuelColumn && massColumn) {
      const fuelRaw = trimmedOrNull(cell(row, fuelColumn))
      const fuel = fuelRaw ? BUNKER_FUEL_CATEGORY[fuelRaw.toUpperCase()] ?? null : null
      deliveries.push({ ...common, fuel, fuelRaw, fuelColumn: fuelColumn.header, mass: valueCell(row, massColumn)! })
    }
    for (const c of byFuel) {
      const mass = valueCell(row, c)!
      if (mass.value.state === "blank") continue
      const fuel = (c.role as Extract<Role, { kind: "bunkerByFuel" }>).fuel
      deliveries.push({ ...common, fuel, fuelRaw: fuel, fuelColumn: c.header, mass })
    }
  }
  return deepFreeze(deliveries)
}

/** Fuels present in a log source (any ROB or consumption column). */
export function fuelsOf(records: readonly LogRecord[]): string[] {
  const fuels = new Set<string>()
  for (const r of records) {
    for (const f of Object.keys(r.rob)) fuels.add(f)
    for (const f of Object.keys(r.consumption)) fuels.add(f)
  }
  return [...fuels].sort()
}
