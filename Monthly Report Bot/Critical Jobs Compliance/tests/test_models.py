import unittest
from datetime import datetime, timedelta, timezone

import _paths  # noqa: F401

from cjc.config import CRITICAL_JOB_FILTERS, ALL_SELECTS
from cjc.models import Extraction, JobPlan, parse_record_count, portal_date, reconcile

P = CRITICAL_JOB_FILTERS


def row(plan_id, total, **extra):
    data = dict(jobPlanId=plan_id, totalCount=total, vesselObjectId=1000000174, riskAnalysis="YES",
                criticalSafety="YES", equipmentCode="350.001.000", equipmentName="ESD", title=f"Job {plan_id}",
                lastDoneDate="2026-09-15 16:00:00+00:00", nextDueDate="2026-12-15 16:00:00+00:00")
    data.update(extra)
    return data


def payload(page=1, size=100, **extra):
    data = {"equipId": 99990000345436, "riskAnalysis": "Y", "chkCritical": "Y", "chkOverdue": "N",
            "chkSubEquips": "Y", "gridServerOperations": {"filters": None, "page": page, "pageSize": size}}
    data.update(extra)
    return data


def extraction(rows, label=None, total=None, dom=None, payloads=None, **overrides):
    count = len(rows)
    values = dict(
        vessel="DHT IMPALA", vessel_box_value="DHT IMPALA", tree_root="DHT IMPALA", selected_node="A - EQUIPMENT",
        count_label=label if label is not None else f"{count} records found",
        datasource_total=count if total is None else total, rows=rows,
        dom_row_count=count if dom is None else dom, read_payloads=payloads if payloads is not None else [payload()],
        filter_readback={label_: P.option_for(label_) for label_ in ALL_SELECTS},
        sublevel_checked=True, overdue_checked=False)
    values.update(overrides)
    return Extraction(**values)


class ParsingTests(unittest.TestCase):
    def test_record_count_label(self):
        self.assertEqual(parse_record_count("25 records found"), 25)
        self.assertEqual(parse_record_count("3,111 records found"), 3111)
        self.assertEqual(parse_record_count("1 record found"), 1)
        self.assertIsNone(parse_record_count("No data"))
        self.assertIsNone(parse_record_count(None))

    def test_portal_date_converts_utc_to_local_date_like_the_grid(self):
        # Matches what the browser's grid shows on this machine.
        moment = datetime(2026, 9, 15, 16, 0, tzinfo=timezone.utc)
        self.assertEqual(portal_date("2026-09-15 16:00:00+00:00"), moment.astimezone().date().isoformat())
        self.assertEqual(portal_date(moment), moment.astimezone().date().isoformat())

    def test_portal_date_handles_blank_and_far_future_sentinels(self):
        self.assertEqual(portal_date(None), "")
        self.assertEqual(portal_date(""), "")
        self.assertEqual(portal_date("not a date"), "")
        offset = datetime.now().astimezone().utcoffset()
        expected = (datetime(3121, 9, 10, 16, 0) + offset).date().isoformat()
        self.assertEqual(portal_date("3121-09-10 16:00:00+00:00"), expected)

    def test_job_plan_normalises_portal_row(self):
        plan = JobPlan.from_portal(row(99990000473119, 1, rank="CHIEF ENGINEER", remark="  Tested   ok "))
        self.assertEqual(plan.job_plan_id, "99990000473119")
        self.assertEqual(plan.discipline, "CHIEF ENGINEER")
        self.assertEqual(plan.remark, "Tested ok")
        self.assertIn('"jobPlanId": 99990000473119', plan.raw_json())


class ReconciliationTests(unittest.TestCase):
    def test_complete_population_passes_every_check(self):
        rows = [row(i, 25) for i in range(1, 26)]
        result = reconcile(extraction(rows), P)
        self.assertTrue(result.passed, [c for c in result.failures()])
        self.assertEqual((result.displayed_count, result.extracted_count), (25, 25))

    def test_zero_critical_jobs_is_a_valid_reconciled_result(self):
        result = reconcile(extraction([], label="0 records found"), P)
        self.assertTrue(result.passed, result.failures())

    def test_stale_grid_after_vessel_change_fails(self):
        # Seen live: label '0 records found' while the grid still held 100 old rows.
        rows = [row(i, 187, riskAnalysis="NO") for i in range(1, 101)]
        result = reconcile(extraction(rows, label="0 records found", total=0,
                                      payloads=[payload(page=2, riskAnalysis="")]), P)
        failed = {c.name for c in result.failures()}
        self.assertFalse(result.passed)
        self.assertIn("Extracted rows match displayed count", failed)
        self.assertIn("Portal received the filters", failed)
        self.assertIn("Population read without page boundaries", failed)
        self.assertIn("Every row has riskAnalysis = YES", failed)

    def test_duplicate_rows_from_unstable_paging_fail(self):
        # Seen live: page 2 repeated two page-1 rows; counts still matched 187.
        rows = [row(i, 187) for i in range(1, 186)] + [row(95, 187), row(96, 187)]
        result = reconcile(extraction(rows, payloads=[payload(1), payload(2)]), P)
        failed = {c.name for c in result.failures()}
        self.assertIn("Job Plan ids unique and present", failed)
        self.assertIn("Population read without page boundaries", failed)

    def test_single_large_read_passes(self):
        rows = [row(i, 187) for i in range(1, 188)]
        result = reconcile(extraction(rows, payloads=[payload(1, 100), payload(1, 187)]), P)
        self.assertTrue(result.passed, result.failures())

    def test_wrong_vessel_or_node_or_filters_fail(self):
        rows = [row(1, 1)]
        self.assertFalse(reconcile(extraction(rows, vessel_box_value="DHT AMAZON"), P).passed)
        self.assertFalse(reconcile(extraction(rows, tree_root="All Vessels"), P).passed)
        self.assertFalse(reconcile(extraction(rows, selected_node="DHT IMPALA"), P).passed)
        readback = {label: P.option_for(label) for label in ALL_SELECTS}
        readback["Critical to Safety"] = "ALL"
        self.assertFalse(reconcile(extraction(rows, filter_readback=readback), P).passed)
        self.assertFalse(reconcile(extraction(rows, overdue_checked=True), P).passed)
        # The vessel root sends equipId -1 and returns nothing.
        self.assertFalse(reconcile(extraction(rows, payloads=[payload(equipId=-1)]), P).passed)

    def test_rendered_and_server_counts_must_agree(self):
        rows = [row(i, 3) for i in range(1, 4)]
        self.assertTrue(reconcile(extraction(rows), P).passed)
        self.assertFalse(reconcile(extraction(rows, dom=2), P).passed)
        self.assertFalse(reconcile(extraction([row(i, 4) for i in range(1, 4)]), P).passed)
        self.assertFalse(reconcile(extraction(rows, total=4), P).passed)

    def test_rows_from_two_vessels_fail(self):
        rows = [row(1, 2), row(2, 2, vesselObjectId=999)]
        self.assertIn("All rows from one vessel", {c.name for c in reconcile(extraction(rows), P).failures()})


if __name__ == "__main__":
    unittest.main()
