"""Phase 3 tests: the shared claim rules (gc_manager.command), the email suggestions (gc_manager.suggest), the
additive schema v3 and the rule-driven web views. Numbers in the test names are the Master Specification v2
section 38 test numbers."""
import json
import re
import sqlite3
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from gc_manager import command, suggest, views
from gc_manager.repository import SCHEMA_VERSION, Repository

TODAY = date(2026, 11, 26)
SETTINGS = {"standard_followup_days": 7, "verification_days": 5, "guarantee_alert_days": [90, 60, 30, 14], "guarantee_critical_days": 30,
            "party_domains": {"office.example": "SUPERINTENDENT", "fleet.example": "VESSEL", "yard.example": "SHIPYARD"}}


def claim(**fields):
    base = {"id": 1, "gc_number": "GC-001", "current_status": "SUBMITTED", "waiting_on": "SHIPYARD", "next_action": "Await yard reply",
            "action_since": "2026-11-10", "next_follow_up_date": None, "promised_dispatch_date": None, "expected_delivery_date": None,
            "service_attendance_date": None, "priority": "NORMAL", "last_status_change": "2026-11-10T02:00:00+00:00"}
    base.update(fields)
    return base


def assess(c, **kw):
    return command.assess(c, settings=SETTINGS, today=TODAY, **kw)


def codes(a):
    return [r.code for r in a.reasons]


class FollowUpRuleTests(unittest.TestCase):
    def test_01_explicit_follow_up_date_overrides_the_default(self):
        a = assess(claim(next_follow_up_date="2026-12-20", action_since="2026-11-01"))
        self.assertEqual((a.due["date"], a.due["source"]), ("2026-12-20", "FOLLOW_UP_DATE"))
        self.assertEqual(a.overdue_days, 0)

    def test_02_commitment_date_is_used_when_no_follow_up_date(self):
        a = assess(claim(status="SUBMITTED", expected_delivery_date="2026-11-24"))
        self.assertEqual((a.due["date"], a.due["source"]), ("2026-11-24", "COMMITMENT"))
        self.assertIn("COMMITMENT_MISSED", codes(a))
        fulfilled = assess(claim(current_status="AWAITING_VERIFICATION", expected_delivery_date="2026-11-24"))
        self.assertNotEqual((fulfilled.due or {}).get("source"), "COMMITMENT")  # delivery already happened

    def test_03_default_threshold_only_when_nothing_else(self):
        a = assess(claim(action_since="2026-11-10"))
        self.assertEqual((a.due["date"], a.due["source"]), ("2026-11-17", "DEFAULT"))
        self.assertIsNone(assess(claim(action_since=None)).due)  # nothing recorded: not established, no guess

    def test_04_due_today_is_not_overdue(self):
        a = assess(claim(next_follow_up_date="2026-11-26"))
        self.assertEqual((a.due_state, a.overdue_days), ("DUE_TODAY", 0))
        self.assertIn("FOLLOW_UP_DUE", codes(a))
        self.assertNotIn("FOLLOW_UP_OVERDUE", codes(a))

    def test_05_overdue_days_start_at_one_the_next_day(self):
        a = assess(claim(next_follow_up_date="2026-11-25"))
        self.assertEqual((a.due_state, a.overdue_days), ("OVERDUE", 1))
        self.assertEqual(a.klass, 3)

    def test_date_only_values_do_not_shift_by_timezone(self):
        self.assertEqual(command.day("2026-11-25"), date(2026, 11, 25))
        self.assertEqual(command.day("2026-11-25T23:30:00-10:00"), date(2026, 11, 25))


class AgeingTests(unittest.TestCase):
    def test_06_acknowledgement_does_not_reset_pending_since(self):
        mails = {1: [email(1, "OUTGOING", "a@office.example", "2026-11-02T03:00:00Z", "Please provide the test report for the pump.",
                           to=["b@yard.example"]),
                     email(2, "INCOMING", "b@yard.example", "2026-11-06T03:00:00Z", "Noted. We are checking.")]}
        found = suggest.for_vessel([claim(waiting_on="NONE", action_since=None, next_action="")], mails, SETTINGS, TODAY)[1]
        since = next(s for s in found if s["kind"] == "PENDING_SINCE")
        self.assertEqual(since["proposed"], {"action_since": "2026-11-02"})
        owner = next(s for s in found if s["kind"] == "OWNER")
        self.assertEqual(owner["proposed"], {"waiting_on": "SHIPYARD"})  # the acknowledgement left the ball with the yard
        # The verified age itself comes only from the confirmed date; emails never move it.
        self.assertEqual(assess(claim(action_since="2026-11-02")).age_days, 24)

    def test_07_substantive_transfer_starts_a_new_period(self):
        mails = {1: [email(1, "OUTGOING", "a@office.example", "2026-11-02T03:00:00Z", "Please provide the test report.", to=["b@yard.example"]),
                     email(2, "INCOMING", "b@yard.example", "2026-11-20T03:00:00Z", "Please find attached the test report for your review and comments.")]}
        found = suggest.for_vessel([claim(waiting_on="SHIPYARD", action_since="2026-11-02", next_action="x")], mails, SETTINGS, TODAY)[1]
        self.assertIn({"waiting_on": "SUPERINTENDENT"}, [s["proposed"] for s in found if s["kind"] == "OWNER"])
        self.assertIn({"action_since": "2026-11-20"}, [s["proposed"] for s in found if s["kind"] == "PENDING_SINCE"])

    def test_08_missing_pending_since_gives_unavailable_age(self):
        a = assess(claim(action_since=None))
        self.assertIsNone(a.age_days)
        self.assertIn("pending-since date", next(r.text for r in a.reasons if r.code == "RECORD_INCOMPLETE"))


class OwnershipAndReviewTests(unittest.TestCase):
    def test_09_suggested_owner_does_not_change_verified_totals(self):
        suggestion = {"key": "OWNER:1:9:SUPERINTENDENT", "kind": "OWNER", "proposed": {"waiting_on": "SUPERINTENDENT"}, "reason": "", "evidence_date": "2026-11-25"}
        a = assess(claim(waiting_on="SHIPYARD"), suggestions=[suggestion])
        summary = command.ownership_summary([a])
        self.assertEqual({g["owner"]: g["open"] for g in summary["groups"]}["Shipyard"], 1)
        self.assertEqual({g["owner"]: g["open"] for g in summary["groups"]}["Office"], 0)
        self.assertEqual(command.headline([a])["with_office"], 0)

    def test_10_suggested_office_transfer_creates_review_required(self):
        suggestion = {"key": "k", "kind": "OWNER", "proposed": {"waiting_on": "SUPERINTENDENT"}, "reason": "", "evidence_date": "2026-11-25"}
        a = assess(claim(next_follow_up_date="2026-12-30"), suggestions=[suggestion])
        self.assertIn("REVIEW_OFFICE_TRANSFER", codes(a))
        self.assertTrue(a.review)
        self.assertEqual(a.klass, 4)

    def test_11_closed_claims_are_not_in_open_ownership(self):
        rows = [assess(claim(id=1, current_status="CLOSED")), assess(claim(id=2, gc_number="GC-002"))]
        summary = command.ownership_summary(rows)
        self.assertEqual(sum(g["open"] for g in summary["groups"]) + summary["not_established"], 1)
        self.assertEqual(rows[0].reasons, [])

    def test_owner_groups_follow_the_agreed_mapping(self):
        self.assertEqual({k: command.owner_group(k) for k in ("SUPERINTENDENT", "VENDOR_MAKER", "SUPPLIER", "SERVICE_COMPANY", "NONE")},
                         {"SUPERINTENDENT": "Office", "VENDOR_MAKER": "Makers", "SUPPLIER": "Makers", "SERVICE_COMPANY": "Makers", "NONE": None})


class ClosureTests(unittest.TestCase):
    def test_12_closure_candidate_does_not_change_status(self):
        c = claim(current_status="MONITORING", last_status_change="2026-11-10T00:00:00+00:00")
        a = assess(c)
        self.assertEqual(a.closure["kind"], "MONITORING_COMPLETE")
        self.assertEqual(c["current_status"], "MONITORING")
        self.assertIsNone(assess(claim(current_status="MONITORING", last_status_change="2026-11-24T00:00:00+00:00")).closure)

    def test_13_email_closure_suggestions_are_counted_separately(self):
        closing = {"key": "c", "kind": "CLOSURE", "proposed": {"close": True}, "reason": "", "evidence_date": "2026-11-25"}
        rows = [assess(claim(id=1, current_status="CLOSURE_PROPOSED")),
                assess(claim(id=2, gc_number="GC-002"), suggestions=[closing])]
        control = command.closure_control(rows)
        self.assertEqual((control["candidates"], control["suggestions"]), (1, 1))
        self.assertEqual((control["candidate_claims"], control["suggestion_claims"]), ([1], [2]))

    def test_15_reopened_claim_returns_to_the_open_population(self):
        a = assess(claim(current_status="RECTIFICATION_IN_PROGRESS", next_follow_up_date="2026-11-20"))
        self.assertTrue(a.open)
        self.assertIsNone(a.closure)
        self.assertIn("FOLLOW_UP_OVERDUE", codes(a))
        self.assertEqual(command.ownership_summary([a])["groups"][2]["open"], 1)


class PriorityTests(unittest.TestCase):
    def test_14_snooze_does_not_alter_overdue_truth(self):
        plain = assess(claim(next_follow_up_date="2026-11-20"))
        snoozed = assess(claim(next_follow_up_date="2026-11-20"), snoozed_until="2026-11-30")
        self.assertEqual((snoozed.overdue_days, snoozed.due, snoozed.age_days, snoozed.klass, codes(snoozed)),
                         (plain.overdue_days, plain.due, plain.age_days, plain.klass, codes(plain)))
        self.assertEqual(command.ownership_summary([snoozed]), command.ownership_summary([plain]))
        # It gives way in Next Best Action only to an unsnoozed claim of equal or higher priority.
        other_p3 = assess(claim(id=2, gc_number="GC-002", next_follow_up_date="2026-11-25"))
        self.assertEqual(command.next_best([snoozed, other_p3]).claim_id, 2)
        lower = assess(claim(id=3, gc_number="GC-003", waiting_on="NONE", next_action=""))
        self.assertEqual(command.next_best([snoozed, lower]).claim_id, 1)

    def test_17_priority_order_is_deterministic(self):
        rows = [assess(claim(id=i, gc_number=f"GC-{i:03d}", next_follow_up_date=d, action_since=None if d is None else "2026-11-10"))
                for i, d in ((3, "2026-11-20"), (1, "2026-11-20"), (2, "2026-11-10"), (4, None))]
        expected = ["GC-002", "GC-001", "GC-003", "GC-004"]  # P3 most overdue, then GC number; P4 (record incomplete) last
        self.assertEqual([a.gc_number for a in command.ranked(rows)], expected)
        self.assertEqual([a.gc_number for a in command.ranked(list(reversed(rows)))], expected)

    def test_unset_claim_asks_for_set_up_before_any_email_suggestion(self):
        closing = {"key": "c", "kind": "CLOSURE", "proposed": {"close": True}, "reason": "", "evidence_date": "2026-11-25"}
        a = assess(claim(waiting_on="NONE", next_action="", action_since=None), suggestions=[closing])
        self.assertEqual((a.primary_action, a.primary_target), ("Set up this claim", "SETUP"))
        overdue = assess(claim(waiting_on="NONE", next_action="", next_follow_up_date="2026-11-20"), suggestions=[closing])
        self.assertEqual((overdue.primary_action, overdue.primary_target), ("Prepare follow-up", "INSPECT"))  # verified first

    def test_reply_waiting_on_the_office_comes_first_within_the_same_class(self):
        def owner(age):
            return {"key": f"o{age}", "kind": "OWNER", "proposed": {"waiting_on": "SUPERINTENDENT"}, "reason": "", "evidence_date": "2026-11-01", "age_days": age}
        old_other = {"key": "s", "kind": "STAGE", "proposed": {"current_status": "SUBMITTED"}, "reason": "", "evidence_date": "2026-09-01", "age_days": 86}
        unset = dict(waiting_on="NONE", next_action="", action_since=None)
        rows = [assess(claim(id=1, gc_number="GC-001", **unset), suggestions=[old_other]),
                assess(claim(id=2, gc_number="GC-002", **unset), suggestions=[owner(1)]),
                assess(claim(id=3, gc_number="GC-003", **unset), suggestions=[owner(20)])]
        self.assertEqual([a.gc_number for a in command.ranked(rows)], ["GC-003", "GC-002", "GC-001"])
        verified = assess(claim(id=4, gc_number="GC-004", next_follow_up_date="2026-11-20"))
        self.assertEqual(command.ranked(rows + [verified])[0].gc_number, "GC-004")  # never above a verified class

    def test_developments_are_one_entry_per_claim(self):
        owner = {"key": "o", "kind": "OWNER", "proposed": {"waiting_on": "SUPERINTENDENT"}, "reason": "Reply from the vessel", "evidence_date": "2026-11-25"}
        closing = {"key": "c", "kind": "CLOSURE", "proposed": {"close": True}, "reason": "Can be closed", "evidence_date": "2026-11-25"}
        a = assess(claim(), suggestions=[owner, closing])
        history = [{"claim_id": 1, "changed_at": "2026-11-20T00:00:00+00:00", "previous_status": None, "new_status": "DRAFT"}]
        result = command.developments(history, [a], date(2026, 11, 12))
        [item] = result["items"]
        self.assertEqual((item["category"], item["title"], item["verified"]), ("REVIEW REQUIRED", "Action may have transferred to your office", False))
        self.assertEqual([p["title"] for p in item["points"]], ["Closure may be possible"])  # registration is not repeated underneath

    def test_38_critical_claim_with_a_suggestion_keeps_its_class(self):
        suggestion = {"key": "k", "kind": "OWNER", "proposed": {"waiting_on": "SUPERINTENDENT"}, "reason": "", "evidence_date": "2026-11-25"}
        a = command.assess(claim(), settings=SETTINGS, today=TODAY, vessel={"guarantee_expiry_date": "2026-12-10"}, suggestions=[suggestion])
        self.assertEqual(a.klass, 1)
        self.assertTrue(a.review)
        self.assertEqual(a.class_label if hasattr(a, "class_label") else a.to_dict()["class_label"], "Urgent")

    def test_37_next_action_labels_cannot_be_confused(self):
        self.assertEqual(assess(claim(next_action="Send pump test report")).next_action["kind"], command.CONTROLLED)
        self.assertEqual(assess(claim(next_action="", next_follow_up_date="2026-11-20")).next_action["kind"], command.REMINDER)
        proposal = {"key": "n", "kind": "NEXT_ACTION", "proposed": {"next_action": "Await the reply"}, "reason": "", "evidence_date": "2026-11-25"}
        suggested = assess(claim(next_action="", action_since=None), suggestions=[proposal])
        self.assertEqual((suggested.next_action["kind"], suggested.next_action["label"]), (command.SUGGESTED, "Suggested by email (not confirmed)"))
        unknown = assess(claim(next_action="", action_since=None, waiting_on="NONE"))
        self.assertEqual((unknown.next_action["kind"], unknown.next_action["label"]), (command.NOT_ESTABLISHED, "No next step recorded"))
        labels = {assess(claim(next_action="x")).next_action["label"], assess(claim(next_action="", next_follow_up_date="2026-11-20")).next_action["label"],
                  suggested.next_action["label"], unknown.next_action["label"]}
        self.assertEqual(len(labels), 4)


class PlainGroupTests(unittest.TestCase):
    """The Command Centre's four groups (user's choice, 26 Nov 2026)."""

    def test_each_open_claim_lands_in_one_group(self):
        closing = {"key": "c", "kind": "CLOSURE", "proposed": {"close": True}, "reason": "", "evidence_date": "2026-11-25", "evidence_author": "the vessel"}
        cases = {
            "not set up": (assess(claim(waiting_on="NONE", next_action="", action_since=None)), command.NOT_SET_UP),
            "your turn": (assess(claim(waiting_on="SUPERINTENDENT")), command.YOUR_TURN),
            "waiting": (assess(claim(waiting_on="SHIPYARD")), command.WAITING),
            "candidate": (assess(claim(current_status="CLOSURE_PROPOSED")), command.READY_TO_CLOSE),
            "email says closed": (assess(claim(waiting_on="SHIPYARD"), suggestions=[closing]), command.READY_TO_CLOSE),
            "not set up beats closure": (assess(claim(waiting_on="NONE", next_action=""), suggestions=[closing]), command.NOT_SET_UP),
            "closed": (assess(claim(current_status="CLOSED")), None),
        }
        for name, (a, group) in cases.items():
            self.assertEqual(a.group, group, name)

    def test_unconfirmed_claims_are_placed_by_their_emails_and_marked(self):
        reply = {"key": "o", "kind": "OWNER", "proposed": {"waiting_on": "SUPERINTENDENT"}, "reason": "", "evidence_date": "2026-11-25"}
        sent = {"key": "s", "kind": "OWNER", "proposed": {"waiting_on": "SHIPYARD"}, "reason": "", "evidence_date": "2026-11-25"}
        closing = {"key": "c", "kind": "CLOSURE", "proposed": {"close": True}, "reason": "", "evidence_date": "2026-11-25"}
        unset = dict(waiting_on="NONE", next_action="", action_since=None)
        self.assertEqual(command.display_group(assess(claim(**unset), suggestions=[reply])), (command.YOUR_TURN, False))
        self.assertEqual(command.display_group(assess(claim(**unset), suggestions=[sent])), (command.WAITING, False))
        self.assertEqual(command.display_group(assess(claim(**unset), suggestions=[sent, closing])), (command.READY_TO_CLOSE, False))
        self.assertEqual(command.display_group(assess(claim(**unset))), (command.NOT_SET_UP, False))
        self.assertEqual(command.display_group(assess(claim(waiting_on="SHIPYARD"), suggestions=[reply])), (command.WAITING, True))  # the record wins
        unset_a = assess(claim(**unset), suggestions=[reply])
        self.assertEqual(command.ownership_summary([unset_a])["not_established"], 1)  # verified totals do not move

    def test_plain_chips_and_note(self):
        a = assess(claim(next_follow_up_date="2026-11-10"))
        self.assertEqual(a.chips, [{"text": "Overdue 16 days", "tone": "danger"}])
        self.assertEqual(assess(claim(next_follow_up_date="2026-11-26")).chips, [{"text": "Due today", "tone": "warn"}])
        self.assertEqual(assess(claim(next_follow_up_date="2026-12-02")).chips, [{"text": "Due 2 Dec", "tone": "muted"}])
        reply = {"key": "o", "kind": "OWNER", "proposed": {"waiting_on": "SUPERINTENDENT"}, "reason": "", "evidence_date": "2026-11-25", "evidence_author": "the vessel"}
        self.assertEqual(assess(claim(waiting_on="SHIPYARD"), suggestions=[reply]).note, "The vessel replied 25 Nov: may be your turn (check)")
        self.assertIsNone(assess(claim()).note)


def email(id_, direction, sender, when, body, to=()):
    return {"id": id_, "direction": direction, "sender_address": sender, "message_datetime": when, "sanitised_body": body,
            "subject": f"GC-001 email {id_}", "recipients_json": json.dumps([{"name": t, "address": t} for t in to]), "reviewed_at": None}


class SuggestionRuleTests(unittest.TestCase):
    def test_reads_only_the_newest_message(self):
        body = ("CAUTION: This email originated from outside of the \"Goodwoodship\" organization. Do not click links or open attachments "
                "unless you recognize the sender and know the content is safe. Dear sir, Good day. If there is no further issue, may we kindly "
                "proceed to close this claim? Thank you. Thanks & Best regards, Theo From: Someone Sent: Monday To: x Subject: old Please send the AWB.")
        self.assertEqual(suggest.latest_text(body), "If there is no further issue, may we kindly proceed to close this claim? Thank you.")

    def test_request_for_an_awb_is_not_a_shipment(self):
        self.assertIsNone(suggest.stage_sentence("Send us the AWB once the spare has been dispatched.", suggest.SHIPMENT))
        self.assertIsNone(suggest.stage_sentence("Please share the AWB for our follow up.", suggest.SHIPMENT))
        self.assertTrue(suggest.stage_sentence("Please kindly find the attached shipping documents.", suggest.SHIPMENT))

    def test_list_of_gc_numbers_and_link_suggestion(self):
        self.assertEqual(suggest.gc_mentions("kindly add AWB into your list. GC 006, 016, 020, 021,026."),
                         ["GC-006", "GC-016", "GC-020", "GC-021", "GC-026"])
        claims = [claim(id=1, gc_number="GC-006"), claim(id=2, gc_number="GC-016")]
        mail = email(7, "INCOMING", "p@office.example", "2026-11-10T04:00:00Z", "Kindly add AWB 1805 to the stock list. GC 006, 016.")
        found = suggest.for_vessel(claims, {1: [mail], 2: []}, SETTINGS, TODAY)
        self.assertEqual([s["proposed"] for s in found[2] if s["kind"] == "LINK"], [{"email_id": 7}])
        self.assertFalse([s for s in found[1] if s["kind"] == "LINK"])  # already linked there

    def test_mistyped_gc_number_is_a_possible_conflict(self):
        mail = email(5, "OUTGOING", "a@office.example", "2026-10-15T02:55:00Z",
                     "Dear Yun Good day Please note that the spare has been received and installed onboard. You can consider GC-102 as closed in your system.",
                     to=["y@yard.example"])
        found = suggest.for_vessel([claim(id=12, gc_number="GC-012")], {12: [mail]}, SETTINGS, TODAY)[12]
        conflict = next(s for s in found if s["kind"] == "CONFLICT")
        self.assertEqual(conflict["proposed"], {"mentioned": "GC-102"})
        self.assertIn("GC-102", conflict["quote"])
        self.assertIn("CLOSURE", {s["kind"] for s in found})

    def test_decided_suggestions_are_not_shown_again(self):
        mail = email(1, "INCOMING", "b@yard.example", "2026-11-20T03:00:00Z", "Please find attached the test report for review.")
        first = suggest.for_vessel([claim(waiting_on="NONE")], {1: [mail]}, SETTINGS, TODAY)[1]
        key = next(s["key"] for s in first if s["kind"] == "OWNER")
        again = suggest.for_vessel([claim(waiting_on="NONE")], {1: [mail]}, SETTINGS, TODAY, decided={key})[1]
        self.assertNotIn(key, [s["key"] for s in again])

    def test_title_comes_from_the_first_original_subject(self):
        self.assertEqual(suggest.subject_title("DHT X - HSHI 8275 / GC-010 - ECDIS Radar Overlay Issue", "GC-010"), "ECDIS Radar Overlay Issue")
        self.assertEqual(suggest.subject_title("RE: X / GC 011 Steering gear room [EXTERNAL]", "GC-011"), "Steering gear room")
        self.assertIsNone(suggest.subject_title("GC-0101 other", "GC-010"))
        self.assertIsNone(suggest.subject_title("RE: GC-010", "GC-010"))
        mails = {1: [dict(email(1, "INCOMING", "b@yard.example", "2026-09-01T00:00:00Z", "x"), subject="RE: Ship / GC-001 Long reply subject text"),
                     dict(email(2, "OUTGOING", "a@office.example", "2026-09-02T00:00:00Z", "y"), subject="Ship / GC-001 Pump seal leak")]}
        found = suggest.for_vessel([claim(title="")], mails, SETTINGS, TODAY)[1]
        self.assertEqual([s["proposed"] for s in found if s["kind"] == "TITLE"], [{"title": "Pump seal leak"}])
        recorded = suggest.for_vessel([claim(title="Recorded title")], mails, SETTINGS, TODAY)[1]
        self.assertFalse([s for s in recorded if s["kind"] == "TITLE"])  # a recorded title is never re-suggested

    def test_same_suggested_title_on_two_claims_is_flagged(self):
        subject = lambda n: f"Ship / GC-00{n} Valve leaking"
        mails = {1: [dict(email(1, "OUTGOING", "a@office.example", "2026-09-01T00:00:00Z", "x"), subject=subject(1))],
                 2: [dict(email(2, "OUTGOING", "a@office.example", "2026-09-02T00:00:00Z", "y"), subject=subject(1).replace("001", "002"))]}
        found = suggest.for_vessel([claim(id=1, title=""), claim(id=2, gc_number="GC-002", title="")], mails, SETTINGS, TODAY)
        self.assertIn("same title is suggested for GC-002", next(s["reason"] for s in found[1] if s["kind"] == "TITLE"))

    def test_19_rule_modules_hold_no_vessel_specific_data(self):
        root = Path(__file__).resolve().parents[1] / "gc_manager"
        for name in ("command.py", "suggest.py", "views.py"):
            text = (root / name).read_text(encoding="utf-8")
            for word in ("IMPALA", "LEOPARD", "HSHI", "hd.com", "goodwood"):
                self.assertNotRegex(text, re.compile(re.escape(word), re.I), f"{word} in {name}")


class SchemaAndViewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        patcher = patch.dict("os.environ", {"GC_LOCAL_USER_NAME": "tester"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repo = Repository(self.root)
        vessel = next(v["id"] for v in self.repo.vessels() if v["name"] == "DHT IMPALA")
        self.claim_id = self.repo.create_claim(vessel, "GC-014", title="ME fuel pump")
        self.repo.update_claim(self.claim_id, next_follow_up_date="2026-11-01")

    def tearDown(self):
        self.temp.cleanup()

    def test_schema_v3_is_additive_with_a_backup(self):
        db = sqlite3.connect(self.root / "suite.sqlite3")
        db.execute("DELETE FROM gc_schema_migrations WHERE version = 3")
        db.commit()
        db.close()
        Repository(self.root)  # opening at v2 takes a backup, then adds what is missing
        self.assertTrue(list((self.root / "backups").glob("suite-before-gc-*.sqlite3.bak")))
        db = sqlite3.connect(self.root / "suite.sqlite3")
        columns = {r[1] for r in db.execute("PRAGMA table_info(gc_claims)")}
        self.assertTrue({"next_action", "action_since"} <= columns)
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertTrue({"gc_suggestions", "gc_snoozes", "gc_review_marks"} <= tables)
        self.assertEqual(db.execute("SELECT gc_number, next_follow_up_date FROM gc_claims").fetchall(), [("GC-014", "2026-11-01")])
        self.assertEqual(db.execute("SELECT MAX(version) FROM gc_schema_migrations").fetchone()[0], SCHEMA_VERSION)
        db.close()

    def test_18_command_centre_register_and_inspector_share_the_rules(self):
        calls = []
        real = command.assess
        def spy(c, **kw):
            result = real(c, **kw)
            calls.append(c["id"])
            return result
        with patch.object(command, "assess", spy):
            overview = views.overview(self.repo)
            row = views.register(self.repo)["claims"][0]
            detail = views.claim_detail(self.repo, self.claim_id)
        self.assertGreaterEqual(calls.count(self.claim_id), 3)
        nba = overview["next_best"]["assessment"]
        for other in (row["assessment"], detail["claim"]["assessment"]):
            self.assertEqual((other["klass"], other["overdue_days"], other["due"], [r["code"] for r in other["reasons"]]),
                             (nba["klass"], nba["overdue_days"], nba["due"], [r["code"] for r in nba["reasons"]]))

    def test_16_last_sync_and_last_review_are_separate(self):
        self.repo.sync_attempt()
        overview = views.overview(self.repo)
        self.assertIsNotNone(overview["sync"]["last_attempt_at"])
        self.assertIsNone(overview["review_state"]["last_dashboard_review_at"])  # a sync is not a review
        self.assertFalse(overview["developments"]["since_review"])

    def test_overview_groups_cover_every_open_claim(self):
        other = self.repo.create_claim(next(v["id"] for v in self.repo.vessels() if v["name"] == "DHT IMPALA"), "GC-015")
        self.repo.update_claim(other, waiting_on="SHIPYARD", next_action="Await report")
        groups = views.overview(self.repo)["groups"]
        self.assertEqual(sum(groups["counts"].values()), views.overview(self.repo)["claims"]["open"])
        self.assertEqual([r["gc_number"] for r in groups["rows"]["WAITING"]], ["GC-015"])
        self.assertEqual([r["gc_number"] for r in groups["rows"]["NOT_SET_UP"]], ["GC-014"])
        self.assertEqual(groups["waiting_by"], [{"with": "Shipyard", "count": 1}])
        self.assertEqual([c["gc_number"] for c in views.register(self.repo, focus="waiting")["claims"]], ["GC-015"])

    def test_register_focus_and_priority_sort(self):
        overdue = views.register(self.repo, focus="overdue")["claims"]
        self.assertEqual([c["gc_number"] for c in overdue], ["GC-014"])
        self.assertEqual(views.register(self.repo, focus="office")["claims"], [])
        self.assertEqual(views.register(self.repo, owner="Not established")["claims"][0]["gc_number"], "GC-014")
        self.assertEqual(views.register(self.repo, sort="priority")["sort"], "priority")

    def test_setup_and_search_views(self):
        setup = views.setup(self.repo)
        self.assertEqual([i["claim"]["gc_number"] for i in setup["claims"]], ["GC-014"])
        found = views.search(self.repo, text="gc14")
        self.assertEqual([c["gc_number"] for c in found["claims"]], ["GC-014"])
        self.assertEqual(views.search(self.repo, text="")["claims"], [])


if __name__ == "__main__":
    unittest.main()
