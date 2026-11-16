"""Import only the approved DHT LEOPARD folder, retaining independent report meters."""
from pathlib import Path
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import uuid

from openpyxl import load_workbook
from dashboard import DATA, ROOT, analytics, save, validate

SOURCE = Path(r'C:\Users\agupta\Downloads\Vessel Report Manager Downloads\DHT LEOPARD')


def extract():
    files = sorted(SOURCE.rglob('*.xlsx'))
    hashes = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    seen, records, duplicates = {}, {}, []
    for path in files:
        # Refuse symlink/junction escapes outside the approved source tree.
        if not path.resolve().is_relative_to(SOURCE.resolve()):
            raise ValueError('Source path outside approved folder')
        digest = hashes[path]
        if digest in seen:
            duplicates.append(str(path.relative_to(SOURCE)))
            continue
        seen[digest] = path
        year, month = path.parent.name.split('-')
        month = int(month)
        wb = load_workbook(path, data_only=True, read_only=True)
        def add(sheet, row, name, begin, reported, end):
            name = ' '.join(name.split())
            ident = str(uuid.uuid5(uuid.NAMESPACE_URL, 'DHT LEOPARD/' + name.casefold()))
            key = (year, month, ident)
            if key in records:
                raise ValueError(f'Duplicate source record: {name} {year}-{month}')
            records[key] = dict(name=name, begin=sheet.cell(row, begin).value,
                end=sheet.cell(row, end).value, reported=sheet.cell(row, reported).value,
                file=str(path.relative_to(SOURCE)), sheet=sheet.title, row=row, sha256=digest)
        try:
            if 'HIMSEN' in wb.sheetnames:
                s = wb['HIMSEN']
                if s['D3'].value != 'DHT LEOPARD':
                    raise ValueError('Unexpected vessel')
                for i, row in enumerate((5, 64, 123), 1):
                    add(s, row, f'Diesel Generator Set No. {i}', 25, 31, 6)
            elif wb.active.title == '14.02.031.01':
                s = wb.active
                if s['B6'].value != 'DHT LEOPARD':
                    raise ValueError('Unexpected vessel')
                for row in range(10, 37):
                    add(s, row, s.cell(row, 1).value, 4, 5, 6)
            else:
                s = wb.active
                if 'DHT LEOPARD' not in str(s['A2'].value):
                    raise ValueError('Unexpected supplementary format')
                for row in range(4, s.max_row+1):
                    name = s.cell(row, 1).value
                    if isinstance(name, str) and name.strip():
                        add(s, row, name, 2, 3, 4)
        finally:
            wb.close()
    if not all(hashlib.sha256(p.read_bytes()).hexdigest() == digest for p, digest in hashes.items()):
        raise ValueError('Source changed during import; stopped')
    data = dict(schema=1, revision=0, vessel='DHT LEOPARD', machines=[], years={}, source_reports={})
    names = {ident: r['name'] for (_, _, ident), r in records.items()}
    data['machines'] = [dict(id=i, name=n, active=True) for i, n in sorted(names.items(), key=lambda item:item[1].casefold())]
    for (year, month, ident), report in records.items():
        readings = data['years'].setdefault(year, {}).setdefault(ident, [None]*13)
        readings[month] = report['end']
        if month == 1:
            readings[0] = report['begin']
        data['source_reports'].setdefault(year, {}).setdefault(ident, [None]*12)[month-1] = report
    # Use actual previous December closing as baseline when present, retaining January's opening separately.
    for year, annual in data['years'].items():
        for ident, readings in annual.items():
            previous = data['years'].get(str(int(year)-1), {}).get(ident)
            if previous and previous[12] is not None:
                readings[0] = previous[12]
    data['import_info'] = dict(source=str(SOURCE), imported_at=datetime.now(timezone.utc).isoformat(),
        files=len(files), unique_files=len(seen), duplicates=duplicates, records=len(records),
        note='As reported. March covers only three generators. Missing readings remain blank. Source records are read-only pending review.')
    return validate(data)


def main():
    data = extract()
    a = analytics(data)
    totals = {y: [round(sum(r['hours'][m] for r in machines.values()
                             if r['hours'][m] is not None and r['hours'][m]>=0), 2)
                   for m in range(12)] for y, machines in a.items()}
    expected = [7526.2,6737.9,1270,7675.8,7709.8,7305.7,4592.8,5993.8,6952.4,8158.0,0,0]
    if totals['2026'] != expected:
        raise ValueError(f'Benchmark mismatch: {totals}')
    if DATA.exists():
        previous = json.loads(DATA.read_text(encoding='utf-8'))
        data['revision'] = previous['revision'] + 1
    save(data)
    report = dict(machines=len(data['machines']), records=data['import_info']['records'],
                  source_files=data['import_info']['files'], duplicates=len(data['import_info']['duplicates']),
                  totals=totals, october_alerts=Counter(r['alerts'][9] for r in a['2026'].values() if r['alerts'][9]),
                  source_unchanged=True)
    (ROOT/'DHT_LEOPARD_Import_Report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
