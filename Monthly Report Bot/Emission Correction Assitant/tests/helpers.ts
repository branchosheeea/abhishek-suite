// Synthetic fixtures only. No vessel reporting data is used in the tests.
import { createHash } from "node:crypto"
import { parseCsv } from "../lib/parsers/csv"
import { parseXlsx } from "../lib/parsers/xlsx"
import { writeXlsx, type XlsxCell } from "../lib/export/xlsx-writer"
import type { SourceKind, SourceTable } from "../lib/engine/types"

export const IMO = "9074729" // a valid IMO number by check digit (classic textbook example)

export const LA_HEADERS = [
  "IMO", "Date_UTC", "Time_UTC", "Event", "Voyage_From", "Voyage_To", "Time_Since_Previous_Report", "Distance",
  "Cargo_Mt", "ME_Consumption_LFO", "AE_Consumption_LFO", "LFO_ROB", "ME_Consumption_HFO", "HFO_ROB",
  "Latitude_Degree", "Latitude_Minutes", "Latitude_North_South", "Longitude_Degree", "Longitude_Minutes", "Longitude_East_West",
]

export type Row = Record<string, string>

/** A consistent passage SGSIN → NLRTM: every LFO/HFO balance closes exactly. */
export function baseRows(): Row[] {
  return [
    { IMO, Date_UTC: "2025-03-01", Time_UTC: "06:00", Event: "Departure", Voyage_From: "SGSIN", Voyage_To: "NLRTM", Time_Since_Previous_Report: "", Distance: "0", Cargo_Mt: "100000", ME_Consumption_LFO: "", AE_Consumption_LFO: "", LFO_ROB: "500.000", ME_Consumption_HFO: "", HFO_ROB: "1000", Latitude_Degree: "1", Latitude_Minutes: "16.0", Latitude_North_South: "N", Longitude_Degree: "103", Longitude_Minutes: "50.0", Longitude_East_West: "E" },
    { IMO, Date_UTC: "2025-03-02", Time_UTC: "06:00", Event: "Noon", Voyage_From: "SGSIN", Voyage_To: "NLRTM", Time_Since_Previous_Report: "24", Distance: "300", Cargo_Mt: "100000", ME_Consumption_LFO: "20.5", AE_Consumption_LFO: "2.25", LFO_ROB: "477.25", ME_Consumption_HFO: "0", HFO_ROB: "1000", Latitude_Degree: "3", Latitude_Minutes: "0.0", Latitude_North_South: "N", Longitude_Degree: "99", Longitude_Minutes: "30.0", Longitude_East_West: "E" },
    { IMO, Date_UTC: "2025-03-03", Time_UTC: "06:00", Event: "Noon", Voyage_From: "SGSIN", Voyage_To: "NLRTM", Time_Since_Previous_Report: "24", Distance: "310", Cargo_Mt: "100000", ME_Consumption_LFO: "21", AE_Consumption_LFO: "2.25", LFO_ROB: "454.0", ME_Consumption_HFO: "0", HFO_ROB: "1000", Latitude_Degree: "5", Latitude_Minutes: "0.0", Latitude_North_South: "N", Longitude_Degree: "95", Longitude_Minutes: "0.0", Longitude_East_West: "E" },
    { IMO, Date_UTC: "2025-03-04", Time_UTC: "06:00", Event: "Arrival", Voyage_From: "SGSIN", Voyage_To: "NLRTM", Time_Since_Previous_Report: "24", Distance: "305", Cargo_Mt: "100000", ME_Consumption_LFO: "20", AE_Consumption_LFO: "2", LFO_ROB: "432", ME_Consumption_HFO: "0", HFO_ROB: "1000", Latitude_Degree: "6", Latitude_Minutes: "30.0", Latitude_North_South: "N", Longitude_Degree: "90", Longitude_Minutes: "30.0", Longitude_East_West: "E" },
  ]
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function toCsv(rows: Row[], headers = LA_HEADERS, eol = "\r\n"): string {
  return [headers.join(","), ...rows.map((r) => headers.map((h) => csvField(r[h] ?? "")).join(","))].join(eol) + eol
}

export function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function csvTable(text: string, kind: SourceKind = "LA", filename = "la.csv"): SourceTable {
  const bytes = new TextEncoder().encode(text)
  return parseCsv(bytes, kind, sha(bytes), filename)
}

export function laTable(rows: Row[] = baseRows()): SourceTable {
  return csvTable(toCsv(rows))
}

/** OVDLA-style workbook: same columns plus Source_System / Last_Updated; dates as text unless asSerial. */
export function ovdlaBytes(rows: Row[], extraHeaders: string[] = ["Source_System", "Last_Updated"]): Buffer {
  const headers = [...LA_HEADERS, ...extraHeaders]
  const data: XlsxCell[][] = [headers, ...rows.map((r) => headers.map((h) => {
    const v = r[h] ?? (h === "Source_System" ? "OVD" : h === "Last_Updated" ? "2025-04-01T00:00:00Z" : "")
    return v === "" ? null : v
  }))]
  return writeXlsx([{ name: "Log Abstract", rows: data }])
}

export function ovdlaTable(rows: Row[] = baseRows()): SourceTable {
  const bytes = ovdlaBytes(rows)
  return parseXlsx(bytes, "OVDLA", sha(bytes), "ovdla.xlsx")
}

/** Bunker Report fields as documented in the OVD 3.13 Interface Description, sheet "Bunker report". */
export const BR_HEADERS = ["IMO", "BDN_Number", "Bunker_Delivery_Date", "Bunker_Delivery_Time", "Fuel_Type", "Mass", "Bunker_Port"]

/** A Bunker Report row in the documented layout. */
export function brRow(date: string, time: string, fuel: string, mass: string, bdn = "B-1", port = "MYPKG"): Row {
  return { IMO, BDN_Number: bdn, Bunker_Delivery_Date: date, Bunker_Delivery_Time: time, Fuel_Type: fuel, Mass: mass, Bunker_Port: port }
}

export function brTable(rows: Row[]): SourceTable {
  return csvTable(toCsv(rows, BR_HEADERS), "BR", "br.csv")
}
