import unittest
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import threading
from unittest.mock import patch
from urllib.request import urlopen, Request
from urllib.error import HTTPError
from http.server import HTTPServer
from dashboard import Handler
from dashboard import initial, validate, change, analytics, demo


class DashboardTests(unittest.TestCase):
    def test_http_save_backup_and_conflict(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / 'data.json'
            path.write_text(json.dumps(initial()), encoding='utf-8')
            with patch('dashboard.DATA', path), patch('dashboard.ROOT', root):
                server = HTTPServer(('127.0.0.1', 0), Handler)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                base = f'http://127.0.0.1:{server.server_port}'
                try:
                    with urlopen(base + '/') as response:
                        self.assertIn(b'Machinery review', response.read())
                    with urlopen(base + '/api/state') as response:
                        payload = json.load(response)
                    ident = payload['data']['machines'][0]['id']
                    body = json.dumps(dict(type='readings', year='2026', id=ident,
                                           readings=[100,110]+[None]*11, revision=0)).encode()
                    req = Request(base+'/api/action', data=body, headers={'Content-Type':'application/json'})
                    with urlopen(req) as response:
                        updated = json.load(response)
                    self.assertEqual(updated['analytics']['2026'][ident]['hours'][0], 10)
                    self.assertEqual(len(list((root/'dashboard_backups').glob('*.json'))), 1)
                    self.assertEqual(json.loads(path.read_text())['revision'], 1)
                    with self.assertRaises(HTTPError) as exc:
                        urlopen(req)
                    self.assertEqual(exc.exception.code, 409)
                    exc.exception.close()
                    with urlopen(base+'/api/demo') as response:
                        self.assertIn('demonstration', json.load(response)['data']['vessel'])
                    self.assertEqual(json.loads(path.read_text())['revision'], 1)
                finally:
                    server.shutdown()
                    server.server_close()
                    worker.join()

    def test_demo_analytics(self):
        d = demo()
        validate(d)
        a = analytics(d)['2026']
        self.assertTrue(any(r['alerts'][9] == 'red' for r in a.values()))
        self.assertTrue(any(r['hours'][9] is not None and r['hours'][9] < 0 for r in a.values()))
        self.assertTrue(any(r['alerts'][7] == 'amber' for r in a.values()))
        self.assertTrue(all(r['hours'][10] is None for r in a.values()))

    def test_history_survives_changes(self):
        d = demo()
        ident = d['machines'][0]['id']
        old = deepcopy(d['years'])
        for action in [dict(type='rename', id=ident, name='ZZ Renamed'),
                       dict(type='active', id=ident, active=False),
                       dict(type='add', name='New compressor')]:
            d = change(d, dict(year='2026', **action))
        for i, readings in old['2026'].items():
            self.assertEqual(d['years']['2026'][i], readings)
        d = change(d, dict(type='active', id=ident, active=True, year='2026'))
        self.assertEqual(d['years']['2026'][ident], old['2026'][ident])

    def test_rollover_and_duplicates(self):
        d = initial()
        ident = d['machines'][0]['id']
        d['years']['2026'][ident][-1] = 15000
        new = change(d, dict(type='rollover', year='2026'))
        self.assertEqual(new['years']['2027'][ident], [15000]+[None]*12)
        self.assertEqual(new['years']['2026'], d['years']['2026'])
        with self.assertRaises(ValueError):
            change(new, dict(type='rollover', year='2026'))
        with self.assertRaises(ValueError):
            change(d, dict(type='add', name=' main ENGINE ', year='2026'))

    def test_invalid_import_and_readings(self):
        d = initial()
        ident = d['machines'][0]['id']
        for invalid in [-1, 'bad', True, float('inf')]:
            with self.assertRaises(ValueError):
                change(d, dict(type='readings', year='2026', id=ident, readings=[invalid]+[None]*12))
        malformed = deepcopy(d)
        malformed['years']['2026']['unknown'] = [None]*13
        with self.assertRaises(ValueError):
            change(d, dict(type='import', data=malformed))

    def test_zero_missing_and_negative(self):
        d = initial()
        ident = d['machines'][0]['id']
        updated = change(d, dict(type='readings', year='2026', id=ident,
                                readings=[100,100,90,None]+[None]*9))
        self.assertEqual(analytics(updated)['2026'][ident]['hours'][:3], [0,-10,None])
        self.assertIsNone(d['years']['2026'][ident][0])


if __name__ == '__main__':
    unittest.main()
