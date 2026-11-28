"""Phase 4 tests: controlled changes from the web through the helper (spec 38 #29 audit through the Python path,
#32 no silent overwrite), the guided set-up, suggestion decisions, snooze and review marks."""
import json
import sqlite3
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

from gc_manager import service, views
from gc_manager.repository import Repository

ME = "superintendent@example.com"


class WebActionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        patcher = patch.dict("os.environ", {"GC_LOCAL_USER_NAME": "desktop"})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.repo = Repository(self.root)
        self.vessel = next(v["id"] for v in self.repo.vessels() if v["name"] == "DHT IMPALA")
        self.claim = self.repo.create_claim(self.vessel, "GC-014")
        self.repo.import_message({"id": "m1", "subject": "DHT Impala - X / GC-014 - Fuel pump seal leak", "mailbox_folder": "Sent Items",
                                  "body": "Please provide the seal test report.", "recipients": [{"name": "Yard", "address": "yard@yard.example"}], "message_datetime": "2026-11-10T03:00:00Z"})
        self.repo.import_message({"id": "m2", "subject": "RE: DHT Impala - X / GC-014 - Fuel pump seal leak", "sender_address": "yard@yard.example",
                                  "body": "Please find attached the seal test report for your review.", "message_datetime": "2026-11-20T03:00:00Z"})

    def tearDown(self):
        self.temp.cleanup()

    def ask(self, cmd, **args):
        return service.handle(self.repo, {"id": 1, "cmd": cmd, "args": args})

    def stamp(self):
        return self.repo.claim(self.claim)["updated_at"]

    def db(self, sql, *args):
        db = sqlite3.connect(self.root / "suite.sqlite3")
        try:
            return db.execute(sql, args).fetchall()
        finally:
            db.close()

    def suggestions(self):
        return {s["kind"]: s for s in views.claim_detail(self.repo, self.claim)["suggestions"]}

    def test_29_edit_goes_through_the_repository_with_history_and_audit(self):
        reply = self.ask("claim.update", actor=ME, claim_id=self.claim, fields={"waiting_on": "SHIPYARD", "next_action": "Await test report"},
                         reason="Agreed on the phone", expected_updated_at=self.stamp())
        self.assertTrue(reply["ok"], reply)
        claim = self.repo.claim(self.claim)
        self.assertEqual((claim["waiting_on"], claim["next_action"], claim["action_since"]), ("SHIPYARD", "Await test report", date.today().isoformat()))
        self.assertEqual(claim["updated_by"], ME)  # the signed-in web user, not the desktop name
        [(prev, new, reason, by)] = self.db("SELECT previous_waiting_on,new_waiting_on,reason,changed_by FROM gc_status_history WHERE claim_id=? AND previous_status IS NOT NULL", self.claim)
        self.assertEqual((prev, new, reason, by), ("NONE", "SHIPYARD", "Agreed on the phone", ME))
        [(details,)] = self.db("SELECT details_json FROM gc_audit_events WHERE claim_id=? AND action='claim_updated'", self.claim)
        changes = json.loads(details)["changes"]
        self.assertEqual(changes["waiting_on"], {"from": "NONE", "to": "SHIPYARD"})
        self.assertEqual(self.repo.actor, "desktop")  # the web person is not left behind for the next request

    def test_32_a_stale_change_is_refused_not_overwritten(self):
        seen = self.stamp()
        self.repo.update_claim(self.claim, title="Changed in the desktop window")  # someone else saves first
        reply = self.ask("claim.update", actor=ME, claim_id=self.claim, fields={"title": "From the web"}, expected_updated_at=seen)
        self.assertEqual(reply["error"]["kind"], "conflict")
        self.assertEqual(self.repo.claim(self.claim)["title"], "Changed in the desktop window")

    def test_guided_set_up_records_accepted_and_changed_suggestions(self):
        s = self.suggestions()
        self.assertEqual(s["OWNER"]["proposed"], {"waiting_on": "SUPERINTENDENT"})
        fields = {"title": s["TITLE"]["proposed"]["title"], "waiting_on": "SUPERINTENDENT", "action_since": "2026-11-21",  # changed date
                  "next_action": s["NEXT_ACTION"]["proposed"]["next_action"]}
        reply = self.ask("claim.setup", actor=ME, claim_id=self.claim, fields=fields, status="SUBMITTED",
                         used=[s[k]["key"] for k in ("TITLE", "OWNER", "PENDING_SINCE", "NEXT_ACTION")], rejected=[], expected_updated_at=self.stamp())
        self.assertTrue(reply["ok"], reply)
        claim = self.repo.claim(self.claim)
        self.assertEqual((claim["title"], claim["waiting_on"], claim["action_since"], claim["current_status"]),
                         ("Fuel pump seal leak", "SUPERINTENDENT", "2026-11-21", "SUBMITTED"))  # stage did not reset the date
        decided = dict(self.db("SELECT kind,status FROM gc_suggestions WHERE claim_id=?", self.claim))
        self.assertEqual(decided, {"TITLE": "ACCEPTED", "OWNER": "ACCEPTED", "PENDING_SINCE": "CHANGED", "NEXT_ACTION": "ACCEPTED"})
        self.assertEqual(self.db("SELECT changed_by FROM gc_status_history WHERE claim_id=? AND new_status='SUBMITTED'", self.claim), [(ME,)])
        self.assertEqual(self.db("SELECT COUNT(*) FROM gc_timeline_events WHERE claim_id=? AND event_type='STATUS_CHANGED'", self.claim), [(1,)])
        remaining = {x["kind"] for x in reply["result"]["suggestions"]}
        self.assertFalse(remaining & {"TITLE", "OWNER", "PENDING_SINCE", "NEXT_ACTION"})  # decided ones do not come back
        self.assertEqual(reply["result"]["claim"]["assessment"]["age_days"], (date.today() - date(2026, 11, 21)).days)

    def test_a_repeated_or_stale_set_up_is_a_conflict(self):
        s = self.suggestions()
        body = dict(actor=ME, claim_id=self.claim, fields={"waiting_on": "SUPERINTENDENT", "action_since": "2026-11-20"},
                    used=[s["OWNER"]["key"]], expected_updated_at=self.stamp())
        self.assertTrue(self.ask("claim.setup", **body)["ok"])
        self.assertEqual(self.ask("claim.setup", **body)["error"]["kind"], "conflict")

    def test_set_up_refuses_invented_suggestions_and_missing_dates(self):
        reply = self.ask("claim.setup", actor=ME, claim_id=self.claim, fields={"waiting_on": "SHIPYARD", "action_since": "2026-11-01"},
                         used=["OWNER:1:999:FAKE"], expected_updated_at=self.stamp())
        self.assertEqual(reply["error"]["kind"], "validation")
        reply = self.ask("claim.setup", actor=ME, claim_id=self.claim, fields={"waiting_on": "SHIPYARD"}, expected_updated_at=self.stamp())
        self.assertIn("became pending", reply["error"]["message"])
        future = (date.today() + timedelta(days=3)).isoformat()
        reply = self.ask("claim.setup", actor=ME, claim_id=self.claim, fields={"waiting_on": "SHIPYARD", "action_since": future}, expected_updated_at=self.stamp())
        self.assertIn("future", reply["error"]["message"])
        self.assertEqual(self.repo.claim(self.claim)["waiting_on"], "NONE")

    def test_dismissing_and_linking_suggestions(self):
        key = self.suggestions()["STAGE"]["key"] if "STAGE" in self.suggestions() else self.suggestions()["OWNER"]["key"]
        reply = self.ask("suggestion.decide", actor=ME, claim_id=self.claim, key=key, decision="REJECTED", reason="Not right")
        self.assertTrue(reply["ok"], reply)
        self.assertNotIn(key, [x["key"] for x in reply["result"]["suggestions"]])
        owner = self.suggestions()["OWNER"]["key"]
        refused = self.ask("suggestion.decide", actor=ME, claim_id=self.claim, key=owner, decision="ACCEPTED")
        self.assertEqual(refused["error"]["kind"], "validation")  # owner is confirmed in the record form, with a date

    def test_link_suggestion_adds_a_link_without_moving_the_email(self):
        other = self.repo.create_claim(self.vessel, "GC-016")
        self.repo.import_message({"id": "m3", "subject": "DHT Impala GC-014 shipment", "sender_address": "p@office.example",
                                  "body": "Kindly add AWB 1805 to the stock list. GC 014, 016.", "message_datetime": "2026-11-22T03:00:00Z"})
        link = next(s for s in views.claim_detail(self.repo, other)["suggestions"] if s["kind"] == "LINK")
        reply = self.ask("suggestion.decide", actor=ME, claim_id=other, key=link["key"], decision="ACCEPTED")
        self.assertTrue(reply["ok"], reply)
        email = link["proposed"]["email_id"]
        self.assertEqual(self.db("SELECT claim_id FROM gc_emails WHERE id=?", email), [(self.claim,)])  # original link kept
        self.assertEqual(self.db("SELECT claim_id, linked_by FROM gc_email_claim_links WHERE email_id=?", email), [(other, ME)])

    def test_status_close_reopen_keep_their_rules(self):
        bad = self.ask("claim.status", actor=ME, claim_id=self.claim, status="CLOSED", expected_updated_at=self.stamp())
        self.assertEqual(bad["error"]["kind"], "validation")
        skip = self.ask("claim.status", actor=ME, claim_id=self.claim, status="MONITORING", expected_updated_at=self.stamp())
        self.assertIn("not allowed", skip["error"]["message"])
        ok = self.ask("claim.close", actor=ME, claim_id=self.claim, closure_date="2026-11-25", reason="Vessel confirmed", expected_updated_at=self.stamp())
        self.assertTrue(ok["ok"], ok)
        again = self.ask("claim.reopen", actor=ME, claim_id=self.claim, status="RECTIFICATION_IN_PROGRESS", reason="Leak returned", expected_updated_at=self.stamp())
        self.assertTrue(again["ok"], again)
        self.assertEqual(self.repo.claim(self.claim)["reopened_count"], 1)

    def test_snooze_and_review_mark(self):
        until = (date.today() + timedelta(days=5)).isoformat()
        reply = self.ask("claim.snooze", actor=ME, claim_id=self.claim, until=until, reason="Maker on holiday")
        self.assertEqual(reply["result"]["claim"]["assessment"]["snoozed_until"], until)
        self.assertEqual(self.ask("claim.snooze", actor=ME, claim_id=self.claim, until=date.today().isoformat(), reason="x")["error"]["kind"], "validation")
        self.assertIsNone(self.ask("claim.unsnooze", actor=ME, claim_id=self.claim)["result"]["claim"]["assessment"]["snoozed_until"])
        self.assertTrue(self.ask("review.mark", actor=ME)["ok"])
        overview = views.overview(self.repo, user=ME)
        self.assertIsNotNone(overview["review_state"]["last_dashboard_review_at"])
        self.assertTrue(overview["developments"]["since_review"])

    def test_review_queue_register_and_link_with_the_same_gc_emails(self):
        for n in ("r1", "r2"):
            self.repo.import_message({"id": n, "subject": "DHT Impala - X / GC-040 - Cooling pump", "sender_address": "yard@yard.example",
                                      "body": "New defect.", "message_datetime": "2026-11-2%sT03:00:00Z" % n[-1]})
        items = views.reviews(self.repo)["items"]
        first = next(i for i in items if i["gc_numbers"] == ["GC-040"])
        self.assertEqual((first["proposal"]["action"], first["proposal"]["same_gc_emails"]), ("REGISTER", 1))
        reply = self.ask("review.resolve", actor=ME, review_id=first["id"], action="link", register=True, vessel_id=self.vessel, link_matching=True)
        self.assertEqual(reply["result"], {"resolved": True, "linked_emails": 2})
        claim = next(c for c in self.repo.claims() if c["gc_number"] == "GC-040")
        self.assertEqual((claim["created_by"], len(self.repo.emails(claim["id"]))), (ME, 2))
        self.assertFalse([i for i in views.reviews(self.repo)["items"] if i["gc_numbers"] == ["GC-040"]])
        again = self.ask("review.resolve", actor=ME, review_id=first["id"], action="irrelevant")
        self.assertEqual(again["error"]["kind"], "conflict")  # already resolved: said plainly, nothing changes

    def test_review_queue_not_relevant_keeps_the_email(self):
        self.repo.import_message({"id": "g", "subject": "Info sharing GC-102 for main engine", "body": "x", "message_datetime": "2026-11-24T03:00:00Z"})
        item = next(i for i in views.reviews(self.repo)["items"] if i["gc_numbers"] == ["GC-102"])
        self.assertTrue(self.ask("review.resolve", actor=ME, review_id=item["id"], action="irrelevant", notes="Another vessel's claim")["ok"])
        self.assertEqual(self.db("SELECT status, reviewed_by FROM gc_review_queue WHERE id=?", item["id"]), [("IRRELEVANT", ME)])
        self.assertEqual(self.db("SELECT COUNT(*) FROM gc_emails WHERE id=?", item["email_id"]), [(1,)])

    def test_changes_need_a_person_and_a_freshness_stamp(self):
        self.assertIn("actor", self.ask("claim.update", claim_id=self.claim, fields={"title": "x"}, expected_updated_at="x")["error"]["message"])
        self.assertIn("expected_updated_at", self.ask("claim.update", actor=ME, claim_id=self.claim, fields={"title": "x"})["error"]["message"])
        self.assertIn("cannot be edited", self.ask("claim.update", actor=ME, claim_id=self.claim, fields={"current_status": "CLOSED"},
                                                   expected_updated_at=self.stamp())["error"]["message"])


if __name__ == "__main__":
    unittest.main()
