import os
import pandas as pd

folder = r"C:\TempBunker"

files = os.listdir(folder)

file_path = os.path.join(folder, files[0])

df = pd.read_excel(
    file_path,
    sheet_name="2026",
    header=None,
    engine="xlrd"
)

print(df.iloc[:40, :10])