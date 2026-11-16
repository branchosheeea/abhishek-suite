"""Offline, ID-based machinery running-hours workbook management."""
from __future__ import annotations

import argparse
import calendar
import math
import os
from pathlib import Path
import tempfile
import uuid

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill, Protection
from openpyxl.formatting.rule import FormulaRule
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo
from openpyxl.workbook.properties import CalcProperties
from openpyxl.utils import get_column_letter as col

NORMAL_AVERAGE = 200
LOW_TWO_MONTH_TOTAL = 300
MIN_HISTORY = 3
DEFAULT_MACHINERY = [
    ('Main Engine', 'Yes'), ('Auxiliary Engine No.1', 'Yes'),
    ('Auxiliary Engine No.2', 'Yes'), ('Auxiliary Engine No.3', 'Yes'),
    ('Main LO Pump No.1', 'Yes'), ('Main LO Pump No.2', 'Yes'),
    ('Air Compressor No.1', 'Yes'), ('Air Compressor No.2', 'No'),
]
NAVY = '243B53'
AMBER = 'FFE3A3'
RED = 'FFC7CE'
ERROR = 'DCC6F0'
FIRST = 5


def valid_meter(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def monthly_hours(readings):
    """Reference calculation: None means absent or invalid, negatives remain errors."""
    return [b - a if valid_meter(a) and valid_meter(b) else None
            for a, b in zip(readings, readings[1:])]


def utilisation(hours, month):
    """Zero-based month; baseline excludes BOTH months being evaluated."""
    if month < 1:
        return None
    pair = hours[month - 1:month + 1]
    if any(x is None or x < 0 for x in pair):
        return None
    history = [x for x in hours[:month - 1] if x is not None and x >= 0]
    if len(history) < MIN_HISTORY:
        return None
    if sum(history) / len(history) >= NORMAL_AVERAGE:
        return 'amber' if sum(pair) < LOW_TWO_MONTH_TOTAL else None
    return 'red' if pair == [0, 0] else None


def base_style(ws):
    ws.sheet_view.showGridLines = False
    for row in ws:
        for cell in row:
            cell.font = Font(name='Verdana', size=11)
    for cell in ws[4]:
        cell.fill = PatternFill('solid', fgColor=NAVY)
        cell.font = Font(name='Verdana', size=11, color='FFFFFF', bold=True)
        cell.alignment = Alignment(wrap_text=True, vertical='center')
    ws.row_dimensions[4].height = 48
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_setup.orientation = 'landscape'
    ws.page_setup.paperSize = ws.PAPERSIZE_A3
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.print_title_rows = '1:4'


def make_master(wb, machines):
    ws = wb.create_sheet('Machinery_Master')
    ws.append(['Machinery register — edit names and Yes/No; run sync to apply'])
    ws.append(['Add inside the table using Tab; do not delete records. Use No to deactivate.'])
    ws.append(['Hidden IDs belong to the system. Master remains editable for table expansion.'])
    ws.append(['Machinery Name', 'Include in RH', '_Machinery_ID'])
    for name, include in machines:
        ws.append([name, include, str(uuid.uuid4())])
    table = Table(displayName='tblMachinery', ref=f'A4:C{ws.max_row}')
    table.tableStyleInfo = TableStyleInfo(name='TableStyleMedium2', showRowStripes=False)
    ws.add_table(table)
    dv = DataValidation(type='list', formula1='"Yes,No"')
    dv.errorTitle = 'Choose Yes or No'
    dv.error = 'Use the dropdown.'
    dv.showErrorMessage = True
    dv.errorStyle = 'stop'
    ws.add_data_validation(dv)
    dv.add('B5:B1048576')
    ws.conditional_formatting.add('A5:A1048576', FormulaRule(
        formula=['AND(A5<>"",COUNTIF($A$5:$A$1048576,A5)>1)'],
        fill=PatternFill('solid', fgColor=ERROR)))
    base_style(ws)
    ws.column_dimensions['A'].width = 46
    ws.column_dimensions['B'].width = 20
    ws.column_dimensions['C'].hidden = True
    ws.freeze_panes = 'B5'
    return ws


def read_master(ws):
    records, names, ids = [], set(), set()
    # Include typed entries immediately below the table; sync expands its bounds.
    for r in range(FIRST, ws.max_row + 1):
        name, include, ident = [ws.cell(r, c).value for c in range(1, 4)]
        if name is None and include is None and ident is None:
            continue
        if not isinstance(name, str) or not name.strip() or name.startswith('='):
            raise ValueError(f'Invalid machinery name at master row {r}')
        name = name.strip()
        if name.casefold() in names:
            raise ValueError(f'Duplicate machinery name: {name}')
        if include not in ('Yes', 'No'):
            raise ValueError(f'Expected Yes/No at master row {r}')
        ident = ident or str(uuid.uuid4())
        if not isinstance(ident, str) or ident in ids:
            raise ValueError(f'Duplicate or invalid ID at master row {r}')
        names.add(name.casefold())
        ids.add(ident)
        ws.cell(r, 1, name)
        ws.cell(r, 3, ident)
        records.append((ident, name, include))
    if not records:
        raise ValueError('Master must contain at least one machine')
    ws.tables['tblMachinery'].ref = f'A4:C{ws.max_row}'
    return records


def read_records(ws):
    records = {}
    for row in ws.iter_rows(min_row=FIRST, max_col=27, values_only=True):
        if not any(x is not None for x in row):
            continue
        ident = row[26]
        if not ident or ident in records:
            raise ValueError(f'Missing or duplicate ID in {ws.title}; restore a known-good backup')
        readings = list(row[1:14])
        if any(isinstance(x, str) and x.startswith('=') for x in readings):
            raise ValueError('Meter inputs must be literal readings, not formulas')
        records[ident] = (row[0], readings)
    return records


def make_annual(wb, year, records, active_ids):
    title = f'RH_{year}'
    ws = wb.create_sheet(title)
    ws.append([f'Machinery running hours — {year}'])
    ws.append(['White B:N = meter input | Grey O:Z = calculated RH | Hidden rows = inactive retained records'])
    ws.append(['Amber: low use | Red: two zero months | Purple / ERR: invalid meter or negative RH. Screening only; review vessel records.'])
    ws.append(['Machinery Name', f'Meter @ 31 Dec {year-1}'] +
              [f'{calendar.month_abbr[m]} meter' for m in range(1, 13)] +
              [f'{calendar.month_abbr[m]} RH' for m in range(1, 13)] + ['_Machinery_ID'])
    for ident, (name, readings) in sorted(records.items(), key=lambda item: (item[1][0].casefold(), item[0])):
        ws.append([name] + readings + [None] * 12 + [ident])
        r = ws.max_row
        ws.row_dimensions[r].hidden = ident not in active_ids
        for c in range(2, 15):
            ws.cell(r, c).protection = Protection(locked=False)
            ws.cell(r, c).number_format = '0.0;-0.0;0.0'
        for month in range(12):
            a, b, target = f'{col(month+2)}{r}', f'{col(month+3)}{r}', ws.cell(r, month+15)
            target.value = (f'=IF(OR({a}="",{b}=""),"",IF(AND(ISNUMBER({a}),ISNUMBER({b})),'
                            f'IF(AND({a}>=0,{b}>=0),{b}-{a},"ERR"),"ERR"))')
            target.number_format = '0.0;-0.0;0.0'
            target.fill = PatternFill('solid', fgColor='F2F4F6')
    end = max(FIRST, ws.max_row)
    validation = DataValidation(type='decimal', operator='greaterThanOrEqual', formula1=0, allow_blank=True)
    validation.showErrorMessage = True
    validation.errorStyle = 'stop'
    validation.error = 'Enter a non-negative numeric hour-meter reading or leave blank.'
    ws.add_data_validation(validation)
    validation.add(f'B5:N{end}')
    purple = PatternFill('solid', fgColor=ERROR)
    ws.conditional_formatting.add(f'B5:N{end}', FormulaRule(
        formula=['AND(B5<>"",IF(ISNUMBER(B5),B5<0,TRUE))'], fill=purple, stopIfTrue=True))
    ws.conditional_formatting.add(f'O5:Z{end}', FormulaRule(
        formula=['OR(O5="ERR",AND(ISNUMBER(O5),O5<0))'], fill=purple, stopIfTrue=True))
    for month in range(MIN_HISTORY + 1, 12):
        cur, prev, hist_end = col(15 + month), col(14 + month), col(13 + month)
        hist = f'$O5:{hist_end}5'
        count = f'(COUNT({hist})-COUNTIF({hist},"<0"))'
        avg = f'SUMIF({hist},">=0",{hist})/MAX(1,{count})'
        guard = f'ISNUMBER({prev}5),ISNUMBER({cur}5),{prev}5>=0,{cur}5>=0,{count}>={MIN_HISTORY}'
        for formula, color in [
            (f'IFERROR(AND({guard},{avg}>={NORMAL_AVERAGE},SUM({prev}5:{cur}5)<{LOW_TWO_MONTH_TOTAL}),FALSE)', AMBER),
            (f'IFERROR(AND({guard},{avg}<{NORMAL_AVERAGE},{prev}5=0,{cur}5=0),FALSE)', RED),
        ]:
            ws.conditional_formatting.add(f'{cur}5:{cur}{end}', FormulaRule(formula=[formula], fill=PatternFill('solid', fgColor=color)))
    base_style(ws)
    ws.column_dimensions['A'].width = 36
    for c in range(2, 27):
        ws.column_dimensions[col(c)].width = 13
    ws.column_dimensions['B'].width = 19
    ws.column_dimensions['AA'].hidden = True
    ws.freeze_panes = 'B5'
    ws.auto_filter.ref = f'A4:AA{end}'
    # Excel cannot safely sort locked formula cells: controlled sorting is via sync.
    ws.protection.sheet = True
    ws.protection.autoFilter = False
    ws.protection.sort = True
    ws.print_options.horizontalCentered = True
    ws.print_area = f'A1:Z{end}'
    return ws


def create(year=2026):
    wb = Workbook()
    wb.remove(wb.active)
    master = make_master(wb, DEFAULT_MACHINERY)
    machines = read_master(master)
    selected = {i: (n, [None] * 13) for i, n, yes in machines if yes == 'Yes'}
    make_annual(wb, year, selected, set(selected))
    wb.calculation = CalcProperties(calcId=0, fullCalcOnLoad=True, forceFullCalc=True, calcMode='auto')
    return wb


def sync(wb, year):
    machines = read_master(wb['Machinery_Master'])
    ws = wb[f'RH_{year}']
    records = read_records(ws)
    active = set()
    for ident, name, include in machines:
        if ident in records:
            records[ident] = (name, records[ident][1])
        if include == 'Yes':
            active.add(ident)
            records.setdefault(ident, (name, [None] * 13))
    # Missing/deleted master records are retained, hidden, with their last known name.
    wb.remove(ws)
    make_annual(wb, year, records, active)


def rollover(wb, year):
    target = f'RH_{year+1}'
    if target in wb.sheetnames:
        raise ValueError(f'{target} already exists; refusing to overwrite')
    machines = read_master(wb['Machinery_Master'])
    previous = read_records(wb[f'RH_{year}'])
    records = {}
    for ident, name, include in machines:
        if include == 'Yes':
            baseline = previous.get(ident, (name, [None] * 13))[1][-1]
            if baseline is not None and not valid_meter(baseline):
                raise ValueError(f'Invalid December meter for {name}')
            records[ident] = (name, [baseline] + [None] * 12)
    make_annual(wb, year+1, records, set(records))


def save_new(wb, path):
    """Never replace the source or any existing output file."""
    path = Path(path)
    if path.exists():
        raise FileExistsError(f'Output already exists: {path}')
    wb.calculation = CalcProperties(calcId=0, fullCalcOnLoad=True, forceFullCalc=True, calcMode='auto')
    fd, tmp = tempfile.mkstemp(suffix='.xlsx', dir=path.parent)
    os.close(fd)
    try:
        wb.save(tmp)
        # Exclusive creation also prevents a concurrent output overwrite.
        with open(tmp, 'rb') as source, open(path, 'xb') as dest:
            import shutil
            shutil.copyfileobj(source, dest)
    finally:
        os.unlink(tmp)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['create', 'sync', 'rollover'], nargs='?', default='create')
    parser.add_argument('--year', type=int, default=2026, help='Reporting year (source year for rollover)')
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path, default=Path('Machinery_RH_Template.xlsx'))
    args = parser.parse_args()
    try:
        if args.command == 'create':
            wb = create(args.year)
        else:
            if args.input is None:
                parser.error('--input is required for sync and rollover')
            wb = load_workbook(args.input)
            (sync if args.command == 'sync' else rollover)(wb, args.year)
        save_new(wb, args.output)
    except (ValueError, OSError, KeyError) as exc:
        parser.exit(1, f'Error: {exc}\n')
    print(f'Saved {args.output}')


if __name__ == '__main__':
    main()
