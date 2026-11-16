"""Validated import and additive merge for annual running-hours workbooks."""
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from io import BytesIO
import calendar
import re
from zipfile import BadZipFile

from openpyxl import load_workbook
from openpyxl.utils.exceptions import InvalidFileException
from openpyxl.utils import get_column_letter

from generate_rh import valid_meter
from repository import canonical


MAX_WORKBOOK_BYTES = 15_000_000
FIRST_DATA_ROW = 5


def _cell(row, index):
    return row[index].value if index < len(row) else None


def extract_workbook(content, filename):
    if not isinstance(filename, str) or not filename.lower().endswith('.xlsx'):
        raise ValueError('Choose an annual .xlsx workbook')
    if not isinstance(content, bytes) or not content or len(content) > MAX_WORKBOOK_BYTES:
        raise ValueError('Workbook must be between 1 byte and 15 MB')

    try:
        workbook = load_workbook(BytesIO(content), data_only=False, read_only=True)
    except (BadZipFile, InvalidFileException, OSError, ValueError) as exc:
        raise ValueError('The uploaded file is not a readable Excel workbook') from exc

    try:
        if 'Machinery_Master' not in workbook.sheetnames:
            raise ValueError('Workbook is missing the Machinery_Master sheet')
        master_sheet = workbook['Machinery_Master']
        expected_master = ('Machinery Name', 'Include in RH', '_Machinery_ID')
        if tuple(master_sheet.cell(4, col).value for col in range(1, 4)) != expected_master:
            raise ValueError('Machinery_Master headers do not match the Running Hour Sheet template')

        machines, master_ids, master_names = {}, {}, {}
        for row_number, row in enumerate(
            master_sheet.iter_rows(min_row=FIRST_DATA_ROW, max_col=3), FIRST_DATA_ROW
        ):
            name, active, ident = (_cell(row, i) for i in range(3))
            if name is None and active is None and ident is None:
                continue
            if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
                raise ValueError(f'Invalid machinery name in Machinery_Master row {row_number}')
            name = ' '.join(name.split())
            key = canonical(name)
            if key in master_names:
                raise ValueError(f'Duplicate machinery name in Machinery_Master: {name}')
            if active not in ('Yes', 'No'):
                raise ValueError(f'Expected Yes or No in Machinery_Master row {row_number}')
            if not isinstance(ident, str) or not ident.strip():
                raise ValueError(f'Missing machinery ID in Machinery_Master row {row_number}; sync the workbook first')
            ident = ident.strip()
            if ident in master_ids:
                raise ValueError(f'Duplicate machinery ID in Machinery_Master row {row_number}')
            machine = dict(id=ident, name=name, active=active == 'Yes')
            machines[ident] = machine
            master_ids[ident] = key
            master_names[key] = ident
        if not machines:
            raise ValueError('Machinery_Master must contain at least one machine')

        years = {}
        for title in workbook.sheetnames:
            match = re.fullmatch(r'RH_(\d{4})', title)
            if not match:
                continue
            year = match.group(1)
            if not 1900 <= int(year) <= 2200:
                raise ValueError(f'Invalid reporting year in sheet {title}')
            sheet = workbook[title]
            expected_headers = (
                ['Machinery Name', f'Meter @ 31 Dec {int(year) - 1}']
                + [f'{calendar.month_abbr[m]} meter' for m in range(1, 13)]
                + [f'{calendar.month_abbr[m]} RH' for m in range(1, 13)]
                + ['_Machinery_ID']
            )
            headers = [sheet.cell(4, col).value for col in range(1, 28)]
            if headers != expected_headers:
                raise ValueError(f'{title} headers do not match the Running Hour Sheet template')

            readings_by_id, seen_ids, seen_names = {}, set(), set()
            for row_number, row in enumerate(
                sheet.iter_rows(min_row=FIRST_DATA_ROW, max_col=27), FIRST_DATA_ROW
            ):
                name = _cell(row, 0)
                values = [_cell(row, col) for col in range(1, 14)]
                ident = _cell(row, 26)
                if name is None and ident is None and all(value is None for value in values):
                    continue
                if not isinstance(name, str) or not name.strip() or len(name.strip()) > 100:
                    raise ValueError(f'Invalid machinery name in {title} row {row_number}')
                name = ' '.join(name.split())
                if not isinstance(ident, str) or not ident.strip():
                    raise ValueError(f'Missing machinery ID in {title} row {row_number}')
                ident = ident.strip()
                if ident in seen_ids:
                    raise ValueError(f'Duplicate machinery ID in {title}: {ident}')
                seen_ids.add(ident)
                key = canonical(name)
                if key in seen_names:
                    raise ValueError(f'Duplicate machinery name in {title}: {name}')
                seen_names.add(key)

                master_id = master_names.get(key)
                if ident not in machines and master_id is not None:
                    raise ValueError(
                        f'Machinery ID mismatch in {title} row {row_number}; sync the workbook before importing'
                    )
                machine = machines.get(ident)
                if machine is None:
                    machine = dict(id=ident, name=name, active=False)
                    machines[ident] = machine
                for column, value in enumerate(values, start=2):
                    if value is not None and not valid_meter(value):
                        address = f'{get_column_letter(column)}{row_number}'
                        raise ValueError(
                            f'Invalid meter in {title}!{address}; enter a literal non-negative number or leave it blank'
                        )
                readings_by_id[ident] = list(values)
            if not readings_by_id:
                raise ValueError(f'{title} contains no machinery records')
            years[year] = readings_by_id

        if not years:
            raise ValueError('Workbook must contain at least one RH_YYYY annual sheet')
        return dict(
            filename=filename.rsplit('\\', 1)[-1].rsplit('/', 1)[-1],
            sha256=sha256(content).hexdigest(),
            machines=list(machines.values()),
            years=years,
        )
    finally:
        workbook.close()


def merge_workbook(original, extracted):
    data = deepcopy(original)
    summary = dict(
        filename=extracted['filename'],
        sha256=extracted['sha256'],
        years=sorted(extracted['years']),
        machines=len(extracted['machines']),
        new_machines=[],
        new_values=0,
        identical_values=0,
        conflicts=[],
        total_conflicts=0,
    )
    machine_by_id = {machine['id']: machine for machine in data['machines']}
    machine_by_name = {canonical(machine['name']): machine['id'] for machine in data['machines']}
    identity_map = {}

    for imported in extracted['machines']:
        existing_id = imported['id'] if imported['id'] in machine_by_id else machine_by_name.get(
            canonical(imported['name'])
        )
        if existing_id is None:
            existing_id = imported['id']
            machine = dict(id=existing_id, name=imported['name'], active=imported['active'])
            data['machines'].append(machine)
            machine_by_id[existing_id] = machine
            machine_by_name[canonical(machine['name'])] = existing_id
            summary['new_machines'].append(machine['name'])
        identity_map[imported['id']] = existing_id

    for year, imported_records in extracted['years'].items():
        annual = data['years'].setdefault(year, {})
        for imported_id, imported_readings in imported_records.items():
            ident = identity_map[imported_id]
            readings = annual.setdefault(ident, [None] * 13)
            for index, value in enumerate(imported_readings):
                if value is None:
                    continue
                if readings[index] is None:
                    readings[index] = value
                    sources = data.setdefault('workbook_sources', {}).setdefault(year, {}).setdefault(
                        ident, [None] * 13
                    )
                    sources[index] = dict(
                        file=extracted['filename'],
                        sha256=extracted['sha256'],
                        imported_at=datetime.now(timezone.utc).isoformat(),
                    )
                    summary['new_values'] += 1
                elif readings[index] == value:
                    summary['identical_values'] += 1
                else:
                    month = '31 Dec baseline' if index == 0 else calendar.month_name[index]
                    summary['total_conflicts'] += 1
                    if len(summary['conflicts']) < 100:
                        summary['conflicts'].append(dict(
                            year=year,
                            machine=machine_by_id[ident]['name'],
                            field=month,
                            existing=readings[index],
                            uploaded=value,
                        ))
    return data, summary
