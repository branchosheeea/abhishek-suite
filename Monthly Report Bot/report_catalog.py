"""Shared vessel and report catalog."""
VESSELS = [
    "DHT ORYX", "DHT IMPALA", "DHT GAZELLE", "DHT ADDAX", "DHT ANTELOPE",
    "DHT APPALOOSA", "DHT MUSTANG", "DHT NOKOTA", "DHT BRONCO", "DHT COLT",
    "DHT STALLION", "DHT TIGER", "DHT HARRIER", "DHT PUMA", "DHT PANTHER",
    "DHT OSPREY", "DHT LION", "DHT LEOPARD", "DHT JAGUAR", "DHT TAIGA",
    "DHT OPAL", "DHT SUNDARBANS", "DHT REDWOOD", "DHT AMAZON",
]

REPORTS_BY_FREQUENCY = {
    "Monthly": [
        "05.05.00.001- KPI - Ship Report",
        "12.02.04.001 - Record Sheet for Ozone Depleting Substances (ODS)",
        "Unmanned Engine Room Alarms Report",
        "15.01.01.001 - Drill Schedule",
        "M/E & A/E Cooling Water Test Log",
        "MGPS Monthly Log",
        "ICCP Monthly Log",
        "12.02.10.001.01 - Waste Generation and Emission Statistics",
        "14.36.00.001 - Stock of Paint Record",
        "12.04.07.021 - LO Stock and consumption report",
        "12.04.07.022 - LO analysis summary",
        "14.38.00.003 - Chief engineer's monthly report",
        "14.38.00.004 - Deck Monthly Maintenance report",
        "15.01.01.002 - Evaluation reports for Drills & Training Exercises",
        "Main Fire Alarm System Check",
        "Main Engine Running Hours",
        "Auxiliary Machinery Running Hours",
        "Life Buoy Inspection",
        "Master and Chief engineer's Monthly verification",
        "Auxiliary Engine Running Hours",
        "CRITICAL TEST AND CHECKS",
        "CRITICAL EQUIPMENT PERFORMANCE",
        "Boiler Feed Water test Log",
        "12.04.09.051 - Tail Shaft Monitoring Log",
        "12.06.02.001 - Monthly HSQE Meeting",
        "14.01.01.011 - Master's Monthly Report",
        "14.33.00.001 - Calibration of Portable Gas Meters and Measuring Equipment",
        "Condition of Pressure & Temperature Gauges",
        "14.05.04.001 - Report of Refrigerant, Chemical and Gases",
        "024.01 Certificate Status",
        "12.04.07.024 - On board Lubricating Oil Analysis",
        "12.02.05.201 - Environmental Seal Log",
        "Monthly Oil Record Book Report",
        "1M BWTS Operation Log Report",
        "062.00 SEEMP III - Appendix D Minutes of CII Implementation Plan Review Committee Meeting",
        "Monthly verification of onboard tests",
    ],
    "Quarterly": [
        "Immersion Suits Inspection",
        "Lub Oil Consumption Trend",
        "12.04.07.023 - Inventory of Lubricants",
        "12.07.03.001 - Mooring Matrix",
        "14.02.05.001 - Greasing Schedule",
        "14.14.05.001 - Battery Condition & load test",
        "14.32.04.001 - Summary of wire ropes on board",
        "14.34.00.001 - Inventory of Precision Measuring",
        "14.38.00.001 - Thermal Mapping",
        "Fuel Equipment Identification Record",
        "Testing Records Of Alarms-Trips Of Machineries",
        "Back Up Battery Record",
        "Electrical Insulation Report",
    ],
    "Six Monthly": [
        "Vent Heads Inspections And Overhauling Report",
        "12.02.03.021 - SEEMP Evaluation Comments",
        "14.14.05.002 - GMDSS Battery Load Test",
    ],
    "Yearly": [
        "Record Of Lifting Gear",
    ],
}

FREQUENCY_DISPLAY = {
    "Monthly": "Monthly (M1)",
    "Quarterly": "Quarterly (M3)",
    "Six Monthly": "Six Monthly (M6)",
    "Yearly": "Yearly (M12)",
}
DISPLAY_TO_FREQUENCY = {value: key for key, value in FREQUENCY_DISPLAY.items()}

DATE_PRESETS = [
    "Previous Month",
    "Current Month",
    "Last 3 Months",
    "Last 6 Months",
    "Last 12 Months",
    "Year to Date",
    "Previous Year",
    "Custom Range",
]


