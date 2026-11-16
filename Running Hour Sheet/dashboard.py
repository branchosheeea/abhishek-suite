"""Local-only machinery dashboard. Run: python dashboard.py"""
from copy import deepcopy
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import os
import socket
import threading
import uuid
import calendar
import argparse
from urllib.parse import urlparse
from urllib.parse import unquote
from urllib.request import urlopen
from urllib.error import URLError
import webbrowser

from generate_rh import DEFAULT_MACHINERY, monthly_hours, utilisation, valid_meter

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'dashboard_data.json'
STATIC = ROOT / 'dashboard'


def initial():
    machines = [dict(id=str(uuid.uuid4()), name=n, active=a == 'Yes') for n, a in DEFAULT_MACHINERY]
    return dict(schema=1, revision=0, vessel='Vessel machinery', machines=machines,
                years={'2026': {m['id']: [None] * 13 for m in machines if m['active']}})


def validate(data):
    if not isinstance(data, dict) or data.get('schema') != 1:
        raise ValueError('Unsupported backup format')
    if type(data.get('revision')) is not int or data['revision'] < 0:
        raise ValueError('Invalid data revision')
    if not isinstance(data.get('vessel'), str) or not 1 <= len(data['vessel'].strip()) <= 100:
        raise ValueError('Vessel name must have 1–100 characters')
    if not isinstance(data.get('machines'), list) or not isinstance(data.get('years'), dict) or not data['years']:
        raise ValueError('Invalid machinery or years')
    ids, names = set(), set()
    for m in data['machines']:
        if not isinstance(m, dict) or not isinstance(m.get('id'), str) or not m['id'] or m['id'] in ids:
            raise ValueError('Invalid or duplicate machinery ID')
        name = m.get('name')
        if not isinstance(name, str) or not name.strip() or len(name) > 100 or name.strip().casefold() in names:
            raise ValueError('Machinery names must be unique and contain 1–100 characters')
        if not isinstance(m.get('active'), bool):
            raise ValueError('Invalid active state')
        ids.add(m['id'])
        names.add(name.strip().casefold())
    for year, records in data['years'].items():
        if not year.isdigit() or not 1900 <= int(year) <= 2200 or not isinstance(records, dict):
            raise ValueError('Invalid reporting year')
        for ident, readings in records.items():
            if ident not in ids or not isinstance(readings, list) or len(readings) != 13:
                raise ValueError('Invalid machine record')
            if any(x is not None and not valid_meter(x) for x in readings):
                raise ValueError('Meters must be non-negative finite numbers or blank')
    for year, records in data.get('source_reports', {}).items():
        if year not in data['years'] or not isinstance(records, dict):
            raise ValueError('Invalid source report year')
        for ident, reports in records.items():
            if ident not in data['years'][year] or not isinstance(reports, list) or len(reports) != 12:
                raise ValueError('Invalid source report record')
            for report in reports:
                if report is None:
                    continue
                if not isinstance(report, dict):
                    raise ValueError('Invalid source report')
                for field in ('begin', 'end', 'reported'):
                    if report.get(field) is not None and not valid_meter(report[field]):
                        raise ValueError('Invalid source meter')
    for year, records in data.get('manual_reports', {}).items():
        if year not in data['years'] or not isinstance(records, dict):
            raise ValueError('Invalid manual record year')
        for ident, reports in records.items():
            if ident not in data['years'][year] or not isinstance(reports,list) or len(reports)!=12:
                raise ValueError('Invalid manual record')
            for m, report in enumerate(reports):
                if report is None:
                    continue
                if not isinstance(report,dict) or not isinstance(report.get('engineer'),str) or not report['engineer'].strip():
                    raise ValueError('Manual records need an engineer name')
                for field in ('begin','end'):
                    if report.get(field) is not None and not valid_meter(report[field]):
                        raise ValueError('Invalid manual meter')
                if data.get('source_reports',{}).get(year,{}).get(ident,[None]*12)[m] is not None:
                    raise ValueError('Manual and imported records cannot occupy the same machine/month')
                if data['years'][year][ident][m+1] != report.get('end'):
                    raise ValueError('Manual closing meter does not match the register')
    for year, records in data.get('workbook_sources', {}).items():
        if year not in data['years'] or not isinstance(records, dict):
            raise ValueError('Invalid annual workbook source year')
        for ident, source in records.items():
            if ident not in data['years'][year]:
                raise ValueError('Invalid annual workbook source record')
            if not isinstance(source, list) or len(source) != 13:
                raise ValueError('Invalid annual workbook source metadata')
            for entry in source:
                if entry is None:
                    continue
                if not isinstance(entry, dict):
                    raise ValueError('Invalid annual workbook source metadata')
                digest = entry.get('sha256')
                if (not isinstance(entry.get('file'), str) or not entry['file']
                        or not isinstance(entry.get('imported_at'), str)
                        or not isinstance(digest, str) or len(digest) != 64
                        or any(char not in '0123456789abcdef' for char in digest)):
                    raise ValueError('Invalid annual workbook source metadata')
    return data


def analytics(data):
    result = {}
    for year, records in data['years'].items():
        result[year] = {}
        for ident, readings in records.items():
            hours = monthly_hours(readings)
            sources = data.get('source_reports', {}).get(year, {}).get(ident)
            manual = data.get('manual_reports', {}).get(year, {}).get(ident)
            reports = ([((sources or [None]*12)[m] or (manual or [None]*12)[m]) for m in range(12)]
                       if sources is not None or manual is not None else None)
            issues = [[] for _ in range(12)]
            if reports is not None:
                # Source months are independent observations: never manufacture a missing month.
                hours = [r['end'] - r['begin'] if r and valid_meter(r.get('begin'))
                         and valid_meter(r.get('end')) else None for r in reports]
                for m, report in enumerate(reports):
                    if report is None:
                        continue
                    h = hours[m]
                    opening = report.get('begin')
                    previous = readings[m]
                    if valid_meter(opening) and valid_meter(previous) and abs(opening-previous) > .01:
                        issues[m].append(f'Continuity gap: prior closing {previous:g}, reported opening {opening:g}; difference {opening-previous:+g} RH. Source monthly RH retained.')
                    if h is None and report.get('reported') is not None:
                        issues[m].append('Reported RH has no supporting opening/closing meter; treated as missing, not zero.')
                    if h is not None and valid_meter(report.get('reported')) and abs(h-report['reported']) > .01:
                        issues[m].append('Reported RH differs from closing minus opening meter.')
            for m, h in enumerate(hours):
                limit = calendar.monthrange(int(year), m+1)[1] * 24
                if h is not None and h > limit + .01:
                    issues[m].append(f'{h:g} RH exceeds {limit} calendar hours; verify reporting times. Reading retained.')
            result[year][ident] = dict(hours=hours, alerts=[utilisation(hours, m) for m in range(12)], issues=issues,
                                      review=equipment_review(hours, issues))
    # Repository history crosses calendar-year boundaries; absent calendar months stay absent.
    first, last = min(map(int,result)), max(map(int,result))
    periods = [(str(y),m) for y in range(first,last+1) for m in range(12)]
    for machine in data['machines']:
        ident = machine['id']
        timeline, flags = [], []
        for year,m in periods:
            row = result.get(year,{}).get(ident)
            timeline.append(row['hours'][m] if row else None)
            flags.append(row['issues'][m] if row else [])
        observations = equipment_review(timeline,flags)
        for index,(year,m) in enumerate(periods):
            if ident not in result.get(year,{}):
                continue
            observation = observations[index]
            label = lambda i: f'{calendar.month_abbr[periods[i][1]+1]} {periods[i][0]}'
            observation['baseline_labels'] = [label(i) for i in observation['baseline_months']]
            observation['last_run_label'] = label(observation['last_run']) if observation['last_run'] is not None else None
            observation['zero_since'] = label(index-observation['zero_months']+1) if observation['zero_months'] else None
            result[year][ident]['review'][m] = observation
            result[year][ident]['alerts'][m] = utilisation(timeline,index)
    return result


def equipment_review(hours, issues):
    """Per-machine observations; no aggregation of hours across different equipment."""
    result = []
    for month, value in enumerate(hours):
        recorded = value is not None and value >= 0
        exception = value is not None and (value < 0 or bool(issues[month]))
        # Gaps and questioned values interrupt a verified zero-running sequence.
        zero_months = 0
        for i in range(month, -1, -1):
            if hours[i] != 0 or issues[i]:
                break
            zero_months += 1
        history = [i for i in range(month) if hours[i] is not None and hours[i] >= 0 and not issues[i]][-3:]
        baseline = sum(hours[i] for i in history)/3 if len(history) == 3 else None
        change_pct = ((value-baseline)/baseline*100 if recorded and not exception
                      and baseline is not None and baseline > 0 else None)
        last_run = next((i for i in range(month, -1, -1)
                         if hours[i] is not None and hours[i] > 0 and not issues[i]), None)
        result.append(dict(recorded=recorded, exception=exception, missing=value is None,
                           zero_months=zero_months, baseline=baseline, baseline_months=history,
                           change_pct=change_pct, last_run=last_run))
    return result


def change(original, action):
    data = deepcopy(original)
    kind = action.get('type')
    year = str(action.get('year', '2026'))
    if kind == 'vessel':
        data['vessel'] = action['name'].strip()
    elif kind == 'add':
        if year not in data['years']:
            raise ValueError('Unknown year')
        ident = str(uuid.uuid4())
        data['machines'].append(dict(id=ident, name=action['name'].strip(), active=True))
        data['years'][year][ident] = [None] * 13
    elif kind in ('rename', 'active'):
        machine = next((m for m in data['machines'] if m['id'] == action['id']), None)
        if machine is None:
            raise ValueError('Unknown machine')
        if kind == 'rename':
            machine['name'] = action['name'].strip()
        else:
            machine['active'] = action['active']
            if machine['active']:
                data['years'][year].setdefault(machine['id'], [None] * 13)
    elif kind == 'readings':
        if action['id'] not in data['years'][year]:
            raise ValueError('Unknown machine record')
        if action['id'] in data.get('source_reports', {}).get(year, {}):
            raise ValueError('Imported source records are read-only during review; no readings have been changed.')
        if action['id'] in data.get('workbook_sources', {}).get(year, {}):
            raise ValueError('Use monthly entry to update annual workbook readings; no readings have been changed.')
        if action['id'] in data.get('manual_reports', {}).get(year, {}):
            raise ValueError('Use monthly entry to update audited manual records')
        data['years'][year][action['id']] = action['readings']
    elif kind == 'monthly_entry':
        apply_monthly_entry(data, action, year)
    elif kind == 'rollover':
        target = str(int(year) + 1)
        if target in data['years']:
            raise ValueError('Next year already exists; history will not be overwritten')
        data['years'][target] = {m['id']: [data['years'][year].get(m['id'], [None]*13)[-1]] + [None]*12
                                 for m in data['machines'] if m['active']}
    elif kind == 'import':
        data = validate(action['data'])
    else:
        raise ValueError('Unknown action')
    data['revision'] = original['revision'] + 1
    return validate(data)


def apply_monthly_entry(data, action, year):
    month = action.get('month')
    engineer = action.get('engineer','').strip()
    entries = action.get('entries')
    if type(month) is not int or not 0 <= month < 12 or year not in data['years']:
        raise ValueError('Choose an existing reporting year and month')
    if not 1 <= len(engineer) <= 100:
        raise ValueError('Enter the recording engineer’s name (1–100 characters)')
    if not isinstance(entries,list) or not entries:
        raise ValueError('No changed readings to save')
    seen = set()
    for entry in entries:
        ident = entry['id']
        if ident in seen or ident not in data['years'][year]:
            raise ValueError('Duplicate or unknown machine')
        seen.add(ident)
        if data.get('source_reports',{}).get(year,{}).get(ident,[None]*12)[month] is not None:
            raise ValueError('Imported monthly records are read-only; nothing was saved')
        begin,end = entry.get('begin'),entry.get('end')
        if any(v is not None and not valid_meter(v) for v in (begin,end)):
            raise ValueError('Meters must be non-negative finite numbers or blank')
        note = entry.get('note','').strip()
        if len(note)>1000:
            raise ValueError('Notes must be at most 1000 characters')
        old = data.get('manual_reports',{}).get(year,{}).get(ident,[None]*12)[month]
        meters = data['years'][year][ident]
        workbook_meter = data.get('workbook_sources',{}).get(year,{}).get(
            ident, [None]*13
        )[month+1] is not None
        if not old and meters[month+1] is not None and not workbook_meter:
            raise ValueError('An existing legacy meter is present; review before replacing it')
        if workbook_meter and not old and meters[month+1] != end and not note:
            raise ValueError('A correction note is required when changing an imported workbook meter')
        if not old and begin is None and end is None:
            continue
        if old and (old.get('begin'),old.get('end')) != (begin,end) and not note:
            raise ValueError('A correction note is required when changing a saved meter')
        if meters[month] is not None and begin != meters[month] and not note:
            raise ValueError('Explain why the opening meter differs from the previous closing meter')
        report = dict(begin=begin,end=end,engineer=engineer,note=note,updated_at=datetime.now(timezone.utc).isoformat())
        data.setdefault('manual_reports',{}).setdefault(year,{}).setdefault(ident,[None]*12)[month] = report
        meters[month+1] = end
        if month==0 and meters[0] is None:
            meters[0]=begin
        data.setdefault('entry_audit',[]).append(dict(year=year,month=month+1,id=ident,before=old,after=deepcopy(report)))


def demo():
    data = initial()
    data['vessel'] = 'MT Meridian · demonstration'
    profiles = [[720,680,730,710,740,680,720,730,700,720],
                [650,620,640,600,650,620,90,100,590,610],
                [80,90,70,85,80,90,0,0,60,0],
                [30,40,20,50,40,30,0,0,0,0],
                [720,700,710,720,730,700,710,720,700,720],
                [20,15,30,20,25,10,0,0,0,0],
                [40,35,45,30,40,35,30,35,40,30]]
    for i, readings in enumerate(data['years']['2026'].values()):
        readings[0] = 12000 + i * 3000
        for m, hours in enumerate(profiles[i], 1):
            readings[m] = readings[m-1] + hours
    last = list(data['years']['2026'].values())[-1]
    last[10] = last[9] - 10
    return data


def save(data):
    if DATA.exists():
        backup = ROOT / 'dashboard_backups'
        backup.mkdir(exist_ok=True)
        (backup / f'{datetime.now():%Y%m%d_%H%M%S_%f}.json').write_bytes(DATA.read_bytes())
    temporary = DATA.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, indent=2, allow_nan=False), encoding='utf-8')
    os.replace(temporary, DATA)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def reply(self, body, status=200):
        encoded = json.dumps(body, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        if urlparse(self.path).path in ('/api/state', '/api/demo'):
            try:
                data = demo() if self.path.startswith('/api/demo') else validate(json.loads(DATA.read_text(encoding='utf-8')))
                self.reply(dict(data=data, analytics=analytics(data)))
            except (OSError, ValueError) as exc:
                self.reply(dict(error=str(exc)), 500)
        else:
            super().do_GET()

    def do_POST(self):
        state_lock = getattr(self.server, 'state_lock', None)
        if state_lock is None:
            self.handle_post()
        else:
            with state_lock:
                self.handle_post()

    def handle_post(self):
        if self.path in ('/api/workbook-preview', '/api/workbook-import'):
            self.handle_workbook_upload()
            return
        # JSON-only, same-origin writes to this loopback application.
        if self.path != '/api/action' or self.headers.get('Content-Type') != 'application/json':
            self.reply(dict(error='Unsupported request'), 400)
            return
        origin = self.headers.get('Origin')
        if origin and origin != f'http://{self.headers.get("Host")}':
            self.reply(dict(error='Cross-origin request rejected'), 403)
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 5_000_000:
                raise ValueError('Invalid request size (maximum 5 MB)')
            action = json.loads(self.rfile.read(length))
            original = validate(json.loads(DATA.read_text(encoding='utf-8')))
            if action.get('revision') != original['revision']:
                self.reply(dict(error='Another window changed the data. Refresh before editing.'), 409)
                return
            if action.get('type') in ('preview_import','bulk_import'):
                from repository import SOURCE, scan, merge, stamp
                extracted = scan(SOURCE,original['vessel'])
                updated, summary = merge(original,extracted)
                if action['type']=='preview_import':
                    self.reply(dict(preview=summary))
                    return
                if action.get('fingerprint') != extracted['fingerprint']:
                    raise ValueError('Source files changed since preview; scan again before importing')
                if summary['new_records']:
                    updated['revision'] = original['revision']+1
                    updated.setdefault('import_batches',[]).append(dict(at=stamp(),**summary))
                    updated['import_info'] = dict(source=str(SOURCE),imported_at=stamp(),note='Historical Excel repository; imported monthly records are retained with source references.')
                    save(validate(updated))
                else:
                    updated = original
                self.reply(dict(data=updated,analytics=analytics(updated),import_summary=summary))
                return
            updated = change(original, action)
            save(updated)
            self.reply(dict(data=updated, analytics=analytics(updated)))
        except (ValueError, KeyError, TypeError, OSError, StopIteration) as exc:
            self.reply(dict(error=str(exc)), 400)

    def handle_workbook_upload(self):
        origin = self.headers.get('Origin')
        if origin and origin != f'http://{self.headers.get("Host")}':
            self.reply(dict(error='Cross-origin request rejected'), 403)
            return
        if self.headers.get('Content-Type') != 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
            self.reply(dict(error='Upload an .xlsx annual Running Hour Sheet workbook'), 400)
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            if not 0 < length <= 15_000_000:
                raise ValueError('Workbook must be between 1 byte and 15 MB')
            revision = int(self.headers.get('X-Data-Revision', ''))
            filename = unquote(self.headers.get('X-Workbook-Name', ''))
            content = self.rfile.read(length)
            if len(content) != length:
                raise ValueError('Workbook upload was incomplete; try again')
            from workbook_import import extract_workbook, merge_workbook
            extracted = extract_workbook(content, filename)
            original = validate(json.loads(DATA.read_text(encoding='utf-8')))
            if revision != original['revision']:
                self.reply(dict(error='The dashboard changed while you selected the workbook. Refresh and preview again.'), 409)
                return
            updated, summary = merge_workbook(original, extracted)
            if self.path == '/api/workbook-preview':
                self.reply(dict(preview=summary, fingerprint=extracted['sha256'], revision=revision))
                return
            if self.headers.get('X-Workbook-Fingerprint') != extracted['sha256']:
                raise ValueError('Workbook changed since preview; preview it again before importing')
            if summary['new_values'] or summary['new_machines']:
                updated['revision'] = original['revision'] + 1
                updated.setdefault('workbook_import_batches', []).append(dict(
                    at=datetime.now(timezone.utc).isoformat(),
                    file=extracted['filename'],
                    sha256=extracted['sha256'],
                    years=summary['years'],
                    new_machines=len(summary['new_machines']),
                    new_values=summary['new_values'],
                    conflicts=summary['total_conflicts'],
                ))
                save(validate(updated))
            else:
                updated = original
            self.reply(dict(data=updated, analytics=analytics(updated), import_summary=summary))
        except (ValueError, KeyError, TypeError, OSError, StopIteration) as exc:
            self.reply(dict(error=str(exc)), 400)


class DashboardHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True
    state_lock = threading.RLock()

    def server_bind(self):
        if os.name == 'nt':
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def is_running_dashboard(port):
    try:
        with urlopen(f'http://127.0.0.1:{port}/api/state', timeout=1) as response:
            payload = json.load(response)
        return response.status == 200 and isinstance(payload.get('data'), dict) and 'analytics' in payload
    except (OSError, URLError, ValueError, json.JSONDecodeError):
        return False


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-browser', action='store_true', help='Do not open a browser window')
    args = parser.parse_args()
    if not DATA.exists():
        save(initial())
    address = f'http://127.0.0.1:{args.port}'
    if is_running_dashboard(args.port):
        print(f'Machinery dashboard is already running at {address}', flush=True)
        if not args.no_browser:
            webbrowser.open(address)
        raise SystemExit(0)
    try:
        server = DashboardHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError as exc:
        if is_running_dashboard(args.port):
            print(f'Machinery dashboard is already running at {address}', flush=True)
            if not args.no_browser:
                webbrowser.open(address)
            raise SystemExit(0)
        raise SystemExit(f'Cannot start the dashboard at {address}: {exc}. '
                         f'Close the other application using port {args.port}, or choose another port with --port.') from exc
    print(f'Machinery dashboard: {address}', flush=True)
    print('Local data: dashboard_data.json | Ctrl+C stops the server', flush=True)
    if not args.no_browser:
        webbrowser.open(address)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
