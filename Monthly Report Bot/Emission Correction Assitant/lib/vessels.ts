// Fleet list for the vessel picker. Mirrors VESSELS in the NeraVeda desktop app (Monthly Report Bot/report_catalog.py)
// and FLEET_VESSELS in the web shell (Superintendent inspection Report/lib/vessels.ts).
// Monthly Report Bot/tests/test_emissions_launcher.py fails if the lists drift apart.
export const FLEET_VESSELS = [
  "DHT ORYX", "DHT IMPALA", "DHT GAZELLE", "DHT ADDAX", "DHT ANTELOPE",
  "DHT APPALOOSA", "DHT MUSTANG", "DHT NOKOTA", "DHT BRONCO", "DHT COLT",
  "DHT STALLION", "DHT TIGER", "DHT HARRIER", "DHT PUMA", "DHT PANTHER",
  "DHT OSPREY", "DHT LION", "DHT LEOPARD", "DHT JAGUAR", "DHT TAIGA",
  "DHT OPAL", "DHT SUNDARBANS", "DHT REDWOOD", "DHT AMAZON",
] as const
