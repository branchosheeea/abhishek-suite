# Inspection Intelligence

A local-first prototype for batch Level 1 classification of vessel inspection photographs.
Original photographs are only read; image optimization is performed in memory and never
rewrites or moves the source files.

## Requirements

- Python 3.10 or later
- Ollama running locally with the configured vision model available

Install the Python dependencies:

```powershell
python -m pip install -r requirements.txt
```

Install Ollama separately if needed, start it, and pull the model configured in
`config/settings.json` (default: `gemma3`). The app reports an actionable error if Ollama
is unavailable or the model is missing.

## Run

```powershell
python app.py
```

Enter the vessel and inspection date, select the folder containing photographs, then
choose **Analyse inspection**. Supported formats are `.jpg`, `.jpeg`, and `.png`;
subfolders are searched as well. Each photo is recorded in
`data/inspection_intelligence.sqlite3`. Failed photographs remain in the results and do
not stop the batch.

Review a row to see its thumbnail and AI reason. **Approve AI** copies a specific
successful AI location to Final Classification; **Review Required** cannot be approved
as a location and must be manually classified. **Save classification** records the
chosen approved Level 1 value as both Abhishek Classification and Final Classification.
Excel export includes the full batch results and review fields, regardless of the current filter.

The redesigned desktop workspace includes:

- Inspection setup and progress at the top, with counts for photographs, processed images,
  pending reviews, and failures.
- Search by filename, AI classification, or final classification, alongside filters for
  pending reviews, reviewed photos, and failures.
- A dedicated photo details panel with orientation-correct previews, AI reasoning,
  approval, and reviewer classification controls.
- A separate **Activity log** tab for troubleshooting without crowding the review area.

**Reviewer classification** in the interface maps to the existing Abhishek Classification
field in storage and Excel exports. Failed photos can receive a manual classification.
The workspace opens at up to 1440 x 960, sized to fit the screen, and supports
resizing down to 640 x 480. Use the outer scrollbars or mouse wheel to reach
content in smaller windows; Shift + mouse wheel scrolls horizontally. The results
table and text panels keep their own scrolling when their content overflows.

Run the regression and desktop interaction checks with:

```powershell
python -m unittest discover -s tests -v
```

Desktop tests require a working Tk installation and use hidden windows, temporary
storage, and fixture results; they do not call Ollama.

## Optional fast local sorting experiment

The **Fast local sorting** mode uses a local CPU CLIP image/text similarity model. It
does not use Ollama and its similarity score is **not a calibrated confidence or a
condition assessment**. Treat its output as an experimental sorting suggestion, not as
a validated replacement for Gemma 3 or Abhishek Classification. The application marks
low-similarity or ambiguous predictions as **Review Required**.

The fast model needs the dependencies in `requirements-fast.txt` and weights fetched
with checksum verification:

```powershell
setup_fast_mode.cmd
```

Then start the app using `Start Inspection.cmd`; it selects the dedicated Python 3.13
runtime. If `.runtime-fast` is missing, the setup command creates it with the Windows
Python launcher (`py -3.13`) and installs the project and fast-mode dependencies.
Alternatively, run the setup commands manually:

```powershell
py -3.13 -m venv .runtime-fast
.\.runtime-fast\Scripts\python.exe -m pip install -r requirements.txt -r requirements-fast.txt
.\.runtime-fast\Scripts\python.exe setup_fast_model.py
```

To evaluate it against only photographs already assigned an Abhishek Classification
in the local database, run:

```powershell
.\.runtime-fast\python.exe benchmark_fast_local.py --against-abhishek --count 20
```

This benchmark opens the database read-only, does not update review records, and writes
`data/benchmark-fast-local-accuracy.json`. It excludes photos with conflicting reference
labels or missing source files and reports those counts separately.

To benchmark the configured Ollama vision model against the same Abhishek-labeled
photos, run:

```powershell
.\.runtime-fast\python.exe benchmark_processing.py --against-abhishek --count 20
```

This also reads inspection records without changing them and writes
`data/benchmark-gemma-accuracy.json`. By default, the labeled-image benchmark uses the
configured image dimension; pass `--size 768` to test a smaller working copy. Both
reports include each original photo path so the evaluated images can be checked.
Accuracy counts only exact Level 1 matches; `Review Required` is not counted as an
exact match against a specific Abhishek Classification. Small samples are not enough
to validate or calibrate a model.

If Abhishek labels are in an exported workbook rather than saved in the application
database, the Gemma benchmark can read the workbook's **Abhishek Classification**
column and match photo names in the supplied folder. For example:

```powershell
.\.runtime-fast\python.exe benchmark_processing.py --against-abhishek `
  --reference-excel "C:\path\to\inspection-results.xlsx" `
  --folder "C:\path\to\inspection-photos" --count 20
```

The workbook is opened read-only. Blank labels and workbook photos absent from the
folder are excluded; duplicate photo names or conflicting labels stop the benchmark
with an error rather than risking a mismatched comparison. The report records its
reference workbook path.

The app records its active Python executable in the Activity log. A provider/model
startup failure stops the batch before photos are marked failed; individual photo
failures still do not stop the remaining batch.

## Share a Windows pilot build

This prototype is a desktop application, not a shared web service. Build a Windows
package on a Windows machine with Python installed:

```powershell
python build_windows.py
```

The script installs build dependencies and creates
`release/InspectionIntelligence-Windows.zip`. Share that ZIP using an
organization-approved file-sharing method. A recipient extracts the ZIP and runs
`InspectionIntelligence.exe` from its folder. Keep the adjacent `config` folder with
the executable.

To build the app into a separate output folder without replacing an earlier package
(for example, when sharing an updated diagnostic build), use:

```powershell
python build_windows.py --output-directory release-with-logs
```

Each pilot member must install and run Ollama locally and pull the configured vision
model (`ollama pull gemma3` by default). The package does not include Ollama or the model.
Each Windows user gets a separate database under
`%LOCALAPPDATA%\Inspection Intelligence\data`; results are not shared between members.
Each user selects inspection photos from their own accessible folders.
The app shows live activity in its Activity Log and writes detailed logs to
`%LOCALAPPDATA%\Inspection Intelligence\data\inspection_intelligence.log`.

For a repeat build, move or rename the previous `release/InspectionIntelligence` folder
and ZIP first; the build script intentionally refuses to overwrite an existing release.
Windows may display a SmartScreen warning because the prototype is not code-signed.

This pilot packaging is not an installer and does not provide centralized storage,
shared results, authentication, or multi-user access. Those require a later web-app
deployment and a deliberate shared data/storage design.

## Configuration

- `config/level1_taxonomy.json`: approved Level 1 values.
- `config/level1_prompt.txt`: the Level 1 classification prompt.
- `config/settings.json`: Ollama URL, model, timeout, prompt version, and image size.

`max_image_dimension` defaults to 1800 and creates an in-memory JPEG working copy.
Set it to `null` to send original-resolution image bytes instead. The source photograph
is never modified in either mode.
