import os
import pandas as pd

folder = r"C:\TempBunker"

file_name = os.listdir(folder)[0]

file_path = os.path.join(folder, file_name)

df = pd.read_excel(
    file_path,
    sheet_name="2026",
    header=None,
    engine="xlrd"
)

print("\n")
print("=" * 50)
print("BUNKER REVIEW")
print("=" * 50)

fuel_map = {
    "ACTUAL VLSFO": "VLSFO",
    "ACTUAL HSFO": "HSFO",
    "ACTUAL LSMGO": "LSMGO"
}

for row in range(len(df)):

    label = str(df.iloc[row, 0]).strip()

    if label in fuel_map:

        fuel = fuel_map[label]

        variance = round(float(df.iloc[row + 2, 9]), 1)

        variance_abs = abs(variance)

        if variance_abs > 10:

            status = "RED"
            action = "COMMENT REQUIRED"

        elif variance_abs >= 7.5:

            status = "AMBER"
            action = "REVIEW RECOMMENDED"

        else:

            status = "GREEN"
            action = "ACCEPTABLE"

        print()
        print(f"{fuel}")
        print(f"Variance = {variance} MT")
        print(f"Status   = {status}")
        print(f"Action   = {action}")