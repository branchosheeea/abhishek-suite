// Fleet list for vessel pickers. Mirrors VESSELS in the NeraVeda desktop app (Monthly Report Bot/report_catalog.py);
// Monthly Report Bot/tests/test_inspection_vessels.py fails if the two lists drift apart.
export const FLEET_VESSELS = [
  "DHT ORYX", "DHT IMPALA", "DHT GAZELLE", "DHT ADDAX", "DHT ANTELOPE",
  "DHT APPALOOSA", "DHT MUSTANG", "DHT NOKOTA", "DHT BRONCO", "DHT COLT",
  "DHT STALLION", "DHT TIGER", "DHT HARRIER", "DHT PUMA", "DHT PANTHER",
  "DHT OSPREY", "DHT LION", "DHT LEOPARD", "DHT JAGUAR", "DHT TAIGA",
  "DHT OPAL", "DHT SUNDARBANS", "DHT REDWOOD", "DHT AMAZON",
] as const

export const OTHER_VESSEL_ID = "OTHER"

/** Stable id for a vessel name: "DHT_LEOPARD" for a fleet vessel, "OTHER" for any other name, "" when empty. */
export function vesselIdFor(name: string) {
  const clean = name.trim()
  if (!clean) return ""
  const match = FLEET_VESSELS.find((vessel) => vessel.toLowerCase() === clean.toLowerCase())
  return match ? match.replace(/\s+/g, "_") : OTHER_VESSEL_ID
}
