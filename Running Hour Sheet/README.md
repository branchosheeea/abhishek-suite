# Machinery running hours

**The offline dashboard is the primary shipboard interface.** Double-click `Start_Dashboard.bat`; it checks setup, starts the local service, and opens the browser. At month-end, save readings and create a print-ready PMS attachment (then print/save it as PDF) for the corresponding job and office record. See [DASHBOARD_README.md](DASHBOARD_README.md) for vessel setup, monthly workflow, backups and review guidance. The Excel implementation below is retained separately.

An offline Excel 365 workbook for calendar-year meter readings and machinery utilisation screening. It does not replace PMS or establish SMS/changeover compliance.

## Start onboard

Open `Machinery_RH_Template.xlsx` in Excel 365. The supplied machinery list is a starting point: finalise vessel equipment before recording readings.

1. In `Machinery_Master`, edit machinery names and choose Yes/No. Add a new table row by pressing Tab from its last cell or using Excel's Insert Table Rows command. Do not reuse an existing row for a different machine. Names must be unique, ignoring case and surrounding spaces.
2. Save and close Excel, then run the **sync** command below to apply selections and alphabetical sorting. Open the new output file and verify the list before using it as the working copy.
3. In `RH_2026`, enter the previous 31 December meter in B and month-end meters in C:N. White cells accept readings; grey O:Z cells calculate RH. Genuine equal readings produce zero. Missing readings leave RH blank.
4. Save the working workbook regularly and keep backups. Do not type monthly RH into the calculated area.

Normal meter entry requires only Excel; no Python or internet is needed. Machinery-list updates and annual rollover require Python with openpyxl installed on an offline-capable office/onboard computer. Master edits do **not** automatically change the annual sheet.

## Commands

Install Python and the dependency once (package installation may require internet or locally supplied wheels):

```powershell
python -m pip install -r requirements.txt
python generate_rh.py create --year 2026 --output Machinery_RH_Template.xlsx
python generate_rh.py sync --year 2026 --input Machinery_RH_Template.xlsx --output Machinery_RH_2026_Updated.xlsx
python generate_rh.py rollover --year 2026 --input Machinery_RH_2026_Updated.xlsx --output Machinery_RH_2027.xlsx
python -m unittest -v
```

The supplied template has already been generated: the create example is for generating a fresh copy under a new filename. Every command refuses to overwrite an existing output. Keep the source file as a backup, and use the successful output as the next working copy. Run commands from this folder. Close Excel before processing files and allow OneDrive to finish syncing.

## Safe machinery changes

Hidden column C in the master and AA in annual sheets store permanent machine IDs. Never edit these IDs or sort only part of a record. Each annual row contains its own name, 13 meter values, 12 calculations and ID. There is no FILTER spill or positional mapping between sheets.

Use **No** to deactivate a machine, then sync. Its annual row is retained and hidden, including all readings. Choosing Yes and syncing restores it. If a master row is accidentally deleted, the corresponding annual record is still retained and hidden; restore the master row and its original ID from a backup to reactivate it. Do not recreate it under a new ID. Hidden retained rows can be inspected by unprotecting the annual sheet and unhiding rows; protect it again before normal use.

Sync updates only the named annual worksheet, moves complete records into alphabetical order, rebuilds formulas for their new row addresses, and preserves all meter values by ID. Names on prior annual sheets remain as recorded. New machines start with empty readings; do not invent January history for a midyear installation. Enter an actual prior month-end/start baseline where appropriate and review any partial-month coverage. Duplicate master names/IDs and missing annual IDs stop processing. The original file is never modified.

The master is deliberately unprotected so Excel can expand its table. The annual sheet is protected without a password against accidental editing of names, formulas and IDs. Sorting is performed through sync because Excel sorting of protected formula cells is unreliable. Sheet protection is an accident-prevention measure, not access security. Header/ID edits in the master cannot be prevented while retaining unrestricted table maintenance; keep backups. Sync rebuilds the current annual sheet's standard layout, so custom notes, comments, formatting and extra columns there are not supported.

## Alerts and interpretation

| Indication | Meaning |
| --- | --- |
| Amber | Prior valid monthly average ≥200 RH and the evaluated two-month total is <300 RH |
| Red | Prior valid monthly average <200 RH and both evaluated months are zero |
| Purple / ERR | Negative calculated RH, a negative meter, or a nonnumeric meter entry |
| No alert colour | No detected condition; grey calculation shading remains |

Only the second month of a qualifying two-month window is highlighted. Both months must be numeric and non-negative. Classification uses at least three valid months **before both evaluated months**; future readings and the evaluated pair never enter the baseline. Thus the earliest possible alert is May, using January–March to evaluate April–May. Missing, invalid and negative RH months are excluded; genuine zero RH is included. Inadequate history means no utilisation alert, not confirmation of satisfactory operation. The history resets each calendar year.

Review flagged machinery against port/sea operations, duty/standby arrangements and vessel records. A change in operating profile can legitimately trigger a screening alert. Constants `NORMAL_AVERAGE`, `LOW_TWO_MONTH_TOTAL` and `MIN_HISTORY` in `generate_rh.py` configure the logic; sync regenerates the selected year's rules after changes.

Excel validation rejects normal entry of negative/nonnumeric meters; pasted invalid values are highlighted. Negative differences remain visible for investigation. For a confirmed meter replacement/reset, retain the original record and record the replacement meter as a new, clearly named master item; do not alter historical readings to force positive RH. This template does not calculate reset-adjusted hours or certify physical plausibility of large positive readings.

## Year-end

Complete and check December readings, save, then run rollover with the **source** year. It adds the next annual sheet to a new workbook while retaining all earlier sheets. Selected machinery carries its December meter into next year's baseline; missing December remains blank, invalid December stops rollover. The new year has empty monthly inputs. An existing target year is never replaced. Review the master and run sync for the new year as needed. Missing earlier readings are not extrapolated.

## Developer validation

`generate_rh.py` separates creation, master validation, ID-based record reading, synchronisation, rollover, formula/format construction, and safe output handling into functions. `test_rh.py` checks realistic running-hour cases, monitoring thresholds, missing/invalid history, passage-to-port changes, renamed/sorted/deactivated/deleted/new machinery, reactivation, duplicate names and IDs, serialization, protected cells, and annual rollover.

openpyxl writes formulas but does not execute Excel formulas or conditional formatting. The workbook requests full automatic recalculation when Excel opens it. Automated tests verify reference calculations, generated formulas and workbook structure; they do not replace an Excel 365 acceptance check. Before vessel deployment, open a working copy in Excel: enter B:N values `0,720,1440,2160,2260,2360` and confirm May is amber; use `0,10,20,30,30,30` and confirm May is red. Clear a reading to confirm missing-month suppression, then enter a decreasing meter to confirm purple negative RH. Verify scrolling, printing and table expansion on the shipboard display.
