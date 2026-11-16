import unittest
from dashboard import equipment_review


class OperationalReviewTests(unittest.TestCase):
    def review(self, hours, issues=None):
        return equipment_review(hours, issues or [[] for _ in hours])

    def test_zero_streak_stops_at_missing_or_error(self):
        result = self.review([50,0,0,None,0,0,-1,0])
        self.assertEqual([x['zero_months'] for x in result], [0,1,2,0,1,2,0,1])
        self.assertTrue(result[3]['missing'])
        self.assertFalse(result[3]['exception'])
        self.assertTrue(result[6]['exception'])

    def test_baseline_has_no_future_or_current_data(self):
        result = self.review([600,600,600,100,9000])
        self.assertEqual(result[3]['baseline'],600)
        self.assertAlmostEqual(result[3]['change_pct'],-100*5/6)
        self.assertEqual(result[3]['baseline_months'],[0,1,2])
        self.assertIsNone(result[2]['baseline'])

    def test_questioned_hours_excluded_from_comparison(self):
        result = self.review([600,900,600,600,100], [[],['calendar'],[],[],['gap']])
        self.assertEqual(result[4]['baseline_months'],[0,2,3])
        self.assertEqual(result[4]['baseline'],600)
        self.assertIsNone(result[4]['change_pct'])
        self.assertTrue(result[4]['exception'])

    def test_zero_baseline_not_divided_and_missing_not_zero(self):
        result = self.review([0,0,0,None,10])
        self.assertEqual(result[4]['baseline'],0)
        self.assertIsNone(result[4]['change_pct'])
        self.assertEqual(result[3]['zero_months'],0)
        self.assertIsNone(result[3]['last_run'])
        self.assertEqual(result[4]['last_run'],4)

    def test_numeric_issues_count_once_missing_separate(self):
        result = self.review([716,None,747],[['gap','other'],['unsupported'],['calendar']])
        self.assertEqual(sum(r['exception'] for r in result),2)
        self.assertEqual(sum(r['missing'] for r in result),1)


if __name__ == '__main__':
    unittest.main()
