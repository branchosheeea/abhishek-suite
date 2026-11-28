"""Targeted, auditable repair of the user-confirmed November 2026 date typo."""
from pathlib import Path
import hashlib
import json
import os
import re
import sqlite3
import sys
from zipfile import ZipFile

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))
from lube_oil.parser import parse_workbook
from lube_oil.repository import Repository
from suite_services.database import connection

LIVE = Path(os.environ['LOCALAPPDATA']) / 'AbhishekAutomationSuite'
WORK = PROJECT / 'diagnostics' / 'leopard_november_repair'
SHA = '6ed77285f81e3690f345feb99e865ebc551f0b2c13cdc2c37cee6355cc60fdf3'
SOURCE = LIVE / 'originals' / SHA[:2] / (SHA + '.xlsx')
CORRECTED = WORK / 'DHT LEOPARD LUB OIL STOCK AND CONSUMPTION REPORT NOVEMBER 2026.xlsx'
NOTE = 'User confirmed November 2026; T5 incorrectly stated 25 NOVEMBER 2025. Corrected source copy changes only T5. Original retained; misdated report excluded from analytics.'

def prepare():
    WORK.mkdir(parents=True, exist_ok=True)
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == SHA
    with ZipFile(SOURCE) as source, ZipFile(CORRECTED, 'w') as target:
        for item in source.infolist():
            data = source.read(item.filename)
            if item.filename == 'xl/worksheets/sheet1.xml':
                data, count = re.subn(
                    rb'<c r="T5" s="122" t="s"><v>76</v></c>',
                    b'<c r="T5" s="122" t="inlineStr"><is><t>25 NOVEMBER 2026</t></is></c>', data)
                assert count == 1
            target.writestr(item, data)
    with ZipFile(SOURCE) as before, ZipFile(CORRECTED) as after:
        assert [n for n in before.namelist() if before.read(n) != after.read(n)] == ['xl/worksheets/sheet1.xml']
    parsed = parse_workbook(CORRECTED)
    assert parsed['month'] == '2026-11'
    assert not any(i['code'] == 'filename_period_mismatch' for i in parsed['issues'])
    print('Corrected copy:', CORRECTED)

def backup(destination):
    with sqlite3.connect((LIVE / 'suite.sqlite3').as_uri() + '?mode=ro', uri=True) as source:
        with sqlite3.connect(destination) as target:
            source.backup(target)

def repair(root):
    repo = Repository(root)
    original = next(r for r in repo.reports() if r['id'] == 57)
    assert original['sha256'] == SHA and original['month'] == '2025-11'
    result = repo.import_file(CORRECTED)
    assert result['status'] in ('Imported', 'Duplicate'), result
    corrected = next(r for r in repo.reports() if r['id'] == result['report_id'])
    assert corrected['month'] == '2026-11' and corrected['is_active']
    assert corrected['vessel_id'] == original['vessel_id']
    with connection(root) as db:
        db.execute('BEGIN IMMEDIATE')
        db.execute('UPDATE monthly_reports SET is_active=0,review_note=? WHERE id=57', (NOTE,))
        db.execute('UPDATE monthly_reports SET supersedes_report_id=57 WHERE id=?', (corrected['id'],))
        repo._audit(db, 57, 'superseded', NOTE + f" Replacement report: {corrected['id']}.")
        repo._audit(db, corrected['id'], 'reporting_date_corrected', NOTE)
        db.commit()
    repo.activate_imported()
    assert not next(r for r in repo.reports() if r['id'] == 57)['is_active']
    print(json.dumps(result))
    return repo

if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'prepare':
        prepare()
        snapshot = WORK / 'test_runtime'
        snapshot.mkdir(exist_ok=True)
        backup(snapshot / 'suite.sqlite3')
        repair(snapshot)
    elif mode == 'apply':
        backup_path = WORK / 'before_live_repair.sqlite3'
        if backup_path.exists():
            raise RuntimeError('Live backup already exists; inspect before retrying.')
        backup(backup_path)
        repair(LIVE)
    elif mode == 'smoke':
        from lube_oil.ui import ReviewApp
        app = ReviewApp(WORK / 'test_runtime')
        errors = []
        app.report_callback_exception = lambda *args: errors.append(str(args))
        app.vessel.set('DHT LEOPARD')
        app.report_id = 24
        app.change_vessel('DHT LEOPARD')
        app.after(1000, lambda: app.start_import([str(CORRECTED)]))
        def check():
            if app.busy:
                app.after(1500, check)
                return
            try:
                assert not errors, errors
                assert app.current['month'] == '2026-11', app.current['month']
                app.show('Overview')
                app.update_idletasks()
                assert app.dashboard_end() == '2026-11'
                print('PASS: import worker, event polling, report selection and Overview render for November 2026', flush=True)
            except Exception as error:
                errors.append(str(error))
            finally:
                app.close_app()
        app.after(1500, check)
        app.after(20000, app.destroy)
        app.mainloop()
        if errors:
            raise RuntimeError(errors)

    elif mode == 'live_ui':
        from suite_services.access.guard import require_module
        require_module('oil')
        from lube_oil.ui import ReviewApp
        app = ReviewApp(LIVE)
        app.vessel.set('DHT LEOPARD')
        app.report_id = 58
        app.change_vessel('DHT LEOPARD')
        app.mainloop()
