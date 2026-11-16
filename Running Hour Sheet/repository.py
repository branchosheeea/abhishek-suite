"""Read-only Excel extraction and additive historical repository merging."""
from pathlib import Path
from copy import deepcopy
from datetime import datetime, timezone
import calendar
import hashlib
import re
import uuid

from openpyxl import load_workbook

SOURCE = Path(r'C:\Users\agupta\Downloads\Vessel Report Manager Downloads\DHT LEOPARD')


def stamp():
    return datetime.now(timezone.utc).isoformat()


def canonical(name):
    return ' '.join(name.split()).casefold()


def matches_period(value, year, month):
    if isinstance(value, datetime):
        return value.year == int(year) and value.month == month
    text = str(value).upper()
    return (re.search(r'\b'+calendar.month_abbr[month].upper()+r'[A-Z]*\b', text) is not None
            and re.search(r'\b(?:'+year+'|'+year[-2:]+r')\b', text) is not None)


def scan(folder, vessel):
    folder = Path(folder).resolve()
    if not folder.is_dir():
        raise ValueError('Historical source folder is unavailable')
    result = dict(folder=str(folder), files=0, unique_files=0, duplicate_files=[],
                  errors=[], records=[], fingerprint='')
    seen, manifest = {}, []
    # Do not follow directory junctions or symlinks outside the selected root.
    def walk(directory):
        for path in sorted(directory.iterdir()):
            if path.is_symlink() or path.is_junction():
                continue
            if path.is_dir():
                yield from walk(path)
            elif path.suffix.lower() in ('.xlsx', '.xlsm', '.xls') and not path.name.startswith('~$'):
                yield path
    for path in walk(folder):
        relative = str(path.relative_to(folder))
        content = path.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        manifest.append(relative + ':' + digest)
        result['files'] += 1
        if digest in seen:
            result['duplicate_files'].append(relative)
            continue
        seen[digest] = relative
        result['unique_files'] += 1
        wb = raw = None
        try:
            if path.suffix.lower() == '.xls':
                raise ValueError('Legacy .xls: save as .xlsx before importing')
            period = next((p.name for p in path.parents if p != folder and re.fullmatch(r'\d{4}-\d{2}', p.name)), None)
            if period is None:
                raise ValueError('Place reports inside a YYYY-MM folder')
            year, number = period.split('-')
            month = int(number)
            if not 1900 <= int(year) <= 2200 or not 1 <= month <= 12:
                raise ValueError('Invalid reporting period')
            wb = load_workbook(path, data_only=True, read_only=True)
            raw = load_workbook(path, data_only=False, read_only=True)
            rows = []
            def add(sheet, row, name, bc, hc, ec):
                if not isinstance(name, str) or not name.strip():
                    raise ValueError(f'Missing machinery name at row {row}')
                name = ' '.join(name.split())
                values = [sheet.cell(row, c).value for c in (bc,hc,ec)]
                for c, value in zip((bc,hc,ec), values):
                    if value is None and raw[sheet.title].cell(row,c).data_type == 'f':
                        raise ValueError(f'Formula cache missing at {sheet.title}!{sheet.cell(row,c).coordinate}; recalculate and save in Excel')
                    if value is not None and (type(value) not in (int,float) or value < 0):
                        raise ValueError(f'Invalid meter/RH at row {row}')
                ident = str(uuid.uuid5(uuid.NAMESPACE_URL, vessel + '/' + canonical(name)))
                rows.append(dict(year=year,month=month,id=ident,name=name,
                    report=dict(name=name,begin=values[0],reported=values[1],end=values[2],
                                file=relative,sheet=sheet.title,row=row,sha256=digest)))
            if 'HIMSEN' in wb.sheetnames:
                sheet = wb['HIMSEN']
                for i,row in enumerate((5,64,123),1):
                    if canonical(str(sheet.cell(row-2,4).value)) != canonical(vessel):
                        raise ValueError('Vessel identity does not match this repository')
                    if not matches_period(sheet.cell(row-1,31).value,year,month):
                        raise ValueError('Report month differs from folder month')
                    add(sheet,row,f'Diesel Generator Set No. {i}',25,31,6)
            elif wb.active.title == '14.02.031.01':
                sheet = wb.active
                if canonical(str(sheet['B6'].value)) != canonical(vessel):
                    raise ValueError('Vessel identity does not match this repository')
                if not matches_period(sheet['G6'].value,year,month):
                    raise ValueError('Report date differs from folder month')
                for row in range(10,37):
                    add(sheet,row,sheet.cell(row,1).value,4,5,6)
            else:
                sheet = wb.active
                heading = str(sheet['A2'].value).split(':',1)[-1]
                if canonical(heading) != canonical(vessel) or 'DESCRIPTION' not in str(sheet['A3'].value).upper():
                    raise ValueError('Unrecognised report format or different vessel')
                if not matches_period(sheet['D2'].value,year,month):
                    raise ValueError('Report month differs from folder month')
                for row in range(4,sheet.max_row+1):
                    name = sheet.cell(row,1).value
                    if isinstance(name,str) and name.strip():
                        add(sheet,row,name,2,3,4)
            if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                raise ValueError('Source file changed during scan')
            result['records'].extend(rows)
        except (ValueError, OSError, KeyError, TypeError) as exc:
            result['errors'].append(dict(file=relative,error=str(exc)))
        finally:
            if wb: wb.close()
            if raw: raw.close()
    result['fingerprint'] = hashlib.sha256('\n'.join(manifest).encode()).hexdigest()
    return result


def merge(original, extracted):
    """Add new observations only; conflicting Excel/manual records are never overwritten."""
    data = deepcopy(original)
    summary = {k: deepcopy(extracted[k]) for k in ('folder','files','unique_files','duplicate_files','errors','fingerprint')}
    summary.update(new_records=0,existing_records=0,new_machines=0,conflicts=[])
    ids = {m['id']:m for m in data['machines']}
    names = {canonical(m['name']):m['id'] for m in data['machines']}
    grouped = {}
    for entry in extracted['records']:
        ident = entry['id'] if entry['id'] in ids else names.get(canonical(entry['name']),entry['id'])
        grouped.setdefault((entry['year'],entry['month'],ident),[]).append(entry)
    def values(report):
        return tuple(report.get(k) for k in ('begin','end','reported'))
    for (year,month,ident), candidates in grouped.items():
        first = candidates[0]
        report = first['report']
        conflict = dict(year=year,month=month,machine=first['name'],files=[r['report']['file'] for r in candidates])
        if any(values(r['report']) != values(report) for r in candidates):
            summary['conflicts'].append(dict(**conflict,reason='Different source files disagree; no record imported'))
            continue
        existing = data.get('source_reports',{}).get(year,{}).get(ident,[None]*12)[month-1]
        manual = data.get('manual_reports',{}).get(year,{}).get(ident,[None]*12)[month-1]
        readings = data.get('years',{}).get(year,{}).get(ident,[None]*13)
        if existing is not None:
            if values(existing) == values(report):
                summary['existing_records'] += len(candidates)
            else:
                summary['conflicts'].append(dict(**conflict,reason='Existing imported record differs; retained unchanged'))
            continue
        if manual is not None or readings[month] is not None:
            summary['conflicts'].append(dict(**conflict,reason='Manual/existing meter record already exists; retained unchanged'))
            continue
        if ident not in ids:
            machine = dict(id=ident,name=first['name'],active=True)
            data['machines'].append(machine)
            ids[ident] = machine
            names[canonical(first['name'])] = ident
            summary['new_machines'] += 1
        meters = data['years'].setdefault(year,{}).setdefault(ident,[None]*13)
        data.setdefault('source_reports',{}).setdefault(year,{}).setdefault(ident,[None]*12)[month-1] = report
        meters[month] = report['end']
        if month == 1 and meters[0] is None:
            meters[0] = report['begin']
        summary['new_records'] += 1
        summary['existing_records'] += len(candidates)-1
    # Fill absent baselines only; never rewrite an established baseline.
    for year,annual in data['years'].items():
        for ident,meters in annual.items():
            prior = data['years'].get(str(int(year)-1),{}).get(ident)
            if meters[0] is None and prior and prior[12] is not None:
                meters[0] = prior[12]
    return data, summary
