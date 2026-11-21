// Digital Docking · D4: Area / System — how work is grouped for the post-docking report's "Various works" narrative.
// DRAFT for the Superintendent's edit: taken from the section headings of the company post-docking report form
// (20 reports, 2020–2026). Change the list here; existing records keep the text they were saved with.

export const AREAS_DRAFT = true

export const AREAS: Readonly<Record<"deck" | "engine" | "both", readonly string[]>> = {
  deck: [
    "Hull cleaning and painting",
    "Cathodic protection (ICCP, anodes)",
    "Anchors and chain cables",
    "Chain lockers",
    "Rudder",
    "Propeller",
    "Sea chests and sea valves",
    "Windlass, mooring winches and chocks",
    "Cranes (hose handling, provision)",
    "Cargo lines, valves and manifold",
    "Cargo tanks",
    "Ballast tanks and ballast system",
    "Pumproom",
    "Inert gas, deck seal and PV valves",
    "Tank domes, vents and draft gauges",
    "LSA / FFA",
    "Bridge and navigation equipment",
    "Gangways and accommodation ladders",
    "Steel work (deck)",
  ],
  engine: [
    "Tail-end shaft and stern tube",
    "Main engine",
    "Turbochargers",
    "Auxiliary engines",
    "Boilers (auxiliary and composite)",
    "Fresh water generator and coolers",
    "Pumps and motors",
    "Engine room piping and valves",
    "EGCS (scrubber)",
    "Bunker lines and tanks",
    "Electrical and switchboards",
    "Automation and control",
    "Steering gear",
    "Engine room tanks",
    "Steel work (engine room)",
  ],
  both: ["Staging", "Class survey", "Service engineer attendance", "Other"],
}

export function areasFor(department: "deck" | "engine"): string[] {
  return [...AREAS[department], ...AREAS.both]
}
