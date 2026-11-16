import unittest
from dashboard import analytics, change, initial, validate


class SourceReportTests(unittest.TestCase):
    def fixture(self):
        data = initial()
        ident = data['machines'][0]['id']
        data['years']['2026'][ident][8:10] = [27956,29417]
        reports = [None]*12
        reports[7] = dict(begin=27956,end=27956,reported=0)
        reports[8] = dict(begin=28701,end=29417,reported=716)
        data['source_reports'] = {'2026':{ident:reports}}
        return data, ident

    def test_reported_pair_and_continuity_warning(self):
        data, ident = self.fixture()
        result = analytics(validate(data))['2026'][ident]
        self.assertEqual(result['hours'][8], 716)
        self.assertIn('+745 RH', result['issues'][8][0])
        self.assertEqual(result['hours'][7], 0)
        self.assertIsNone(result['hours'][6])

    def test_missing_does_not_become_zero(self):
        data, ident = self.fixture()
        data['source_reports']['2026'][ident][0] = dict(begin=None,end=None,reported=0)
        result = analytics(data)['2026'][ident]
        self.assertIsNone(result['hours'][0])
        self.assertTrue(result['issues'][0])

    def test_source_records_protected(self):
        data, ident = self.fixture()
        with self.assertRaisesRegex(ValueError,'read-only'):
            change(data,dict(type='readings',year='2026',id=ident,readings=[0]*13))

    def test_source_validation(self):
        data, ident = self.fixture()
        data['source_reports']['2026'][ident][0] = dict(begin=-1,end=10,reported=11)
        with self.assertRaises(ValueError):
            validate(data)


if __name__ == '__main__':
    unittest.main()
