"""The web shell's Guarantee Claim helper (gc_manager.service): fixed commands, checked arguments, no email bodies,
safe errors, and a clean message stream over a real child process. Synthetic data only."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gc_manager import service
from gc_manager.repository import Repository
from gc_manager.rules import STATUS

PROJECT = Path(__file__).resolve().parents[1]


class HelperCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=PROJECT / "backups" / "source")
        with patch.dict(os.environ, {"GC_LOCAL_USER_NAME": "Tester"}):
            self.repo = Repository(self.temp.name)
            self.impala = next(v["id"] for v in self.repo.vessels() if v["name"] == "DHT IMPALA")
            self.claim = self.repo.create_claim(self.impala, "GC-014", title="Purifier vibration")
            self.repo.import_message({"id": "m1", "subject": "DHT Impala GC-014 maker reply", "body": "SECRET BODY TEXT " * 20,
                                      "sender_address": "maker@example.com", "recipients": [{"address": "me@example.com"}]})

    def tearDown(self):
        self.temp.cleanup()

    def ask(self, cmd, args=None, request_id=1):
        message = {"id": request_id, "cmd": cmd}
        if args is not None:
            message["args"] = args
        return service.handle(self.repo, message)

    def test_reads_return_the_repository_data(self):
        self.assertEqual(self.ask("ping")["result"]["read_only"], False)  # controlled changes since Phase 4
        claims = self.ask("claims.list")["result"]
        self.assertEqual([(c["id"], c["gc_number"], c["vessel_name"]) for c in claims], [(self.claim, "GC-014", "DHT IMPALA")])
        self.assertEqual(self.ask("claims.list", {"search": "purifier", "status": "DRAFT"})["result"][0]["id"], self.claim)
        self.assertEqual(self.ask("claims.list", {"status": "All"})["result"][0]["id"], self.claim)
        self.assertEqual(self.ask("claim.get", {"claim_id": self.claim})["result"]["title"], "Purifier vibration")
        self.assertEqual([h["new_status"] for h in self.ask("claim.history", {"claim_id": self.claim})["result"]], ["DRAFT"])
        self.assertEqual([t["event_type"] for t in self.ask("claim.timeline", {"claim_id": self.claim})["result"]], ["CLAIM_CREATED", "EMAIL"])
        self.assertEqual(self.ask("emails.summary")["result"]["linked"], 1)
        self.assertIn("tracked_vessels", self.ask("settings.get")["result"])
        self.assertIsInstance(self.ask("sync.status")["result"], list)
        self.assertIsInstance(self.ask("reviews.list", {"open_only": False})["result"], list)

    def test_status_vocabulary_comes_from_the_rules(self):
        vocab = self.ask("vocabulary")["result"]
        self.assertEqual(vocab["statuses"], list(STATUS))
        self.assertIn("SUBMITTED", vocab["transitions"]["DRAFT"])
        self.assertEqual(vocab["transitions"]["CLOSED"], [])

    def test_emails_are_sent_without_bodies_or_raw_metadata(self):
        emails = self.ask("claim.emails", {"claim_id": self.claim})["result"]
        self.assertEqual(len(emails), 1)
        self.assertEqual(set(emails[0]), set(service.EMAIL_FIELDS) | {"recipients", "gc_numbers"})
        self.assertNotIn("sanitised_body", emails[0])
        self.assertNotIn("raw_metadata_json", emails[0])
        self.assertLessEqual(len(emails[0]["body_preview"]), 500)
        self.assertEqual(emails[0]["gc_numbers"], ["GC-014"])

    def test_unknown_commands_and_arguments_are_refused(self):
        for message, pattern in (({"id": 1, "cmd": "claims.delete"}, "Unknown command"),
                                 ({"id": 1, "cmd": "__import__"}, "Unknown command"),
                                 ({"id": 1, "cmd": "claims.list", "args": {"sql": "DROP TABLE gc_claims"}}, "Unknown argument"),
                                 ({"id": 1, "cmd": "claims.list", "args": []}, "args must be an object"),
                                 ({"id": 1, "cmd": "claim.get"}, "claim_id is required"),
                                 ({"id": 1, "cmd": "claim.get", "args": {"claim_id": "1"}}, "positive whole number"),
                                 ({"id": 1, "cmd": "claim.get", "args": {"claim_id": True}}, "positive whole number"),
                                 ({"id": 1, "cmd": "claim.get", "args": {"claim_id": -3}}, "positive whole number"),
                                 ({"id": 1, "cmd": "claims.list", "args": {"search": "x" * 201}}, "at most 200"),
                                 ({"id": 1, "cmd": "claims.list", "args": {"status": "DELETED"}}, "not a known claim status"),
                                 ({"id": 1, "cmd": "reviews.list", "args": {"open_only": "yes"}}, "true or false"),
                                 ({"cmd": "ping"}, "needs an id"),
                                 (["ping"], "needs an id")):
            with self.subTest(message=message):
                reply = service.handle(self.repo, message)
                self.assertFalse(reply["ok"])
                self.assertEqual(reply["error"]["kind"], "bad_request")
                self.assertIn(pattern, reply["error"]["message"])
        self.assertEqual(len(self.repo.claims()), 1)

    def test_missing_claims_are_not_found(self):
        for cmd in ("claim.get", "claim.emails", "claim.timeline", "claim.history"):
            with self.subTest(cmd=cmd):
                self.assertEqual(self.ask(cmd, {"claim_id": 999})["error"]["kind"], "not_found")

    def test_unexpected_failures_are_internal_and_hide_details(self):
        with patch.object(Repository, "claims", side_effect=RuntimeError("C:\\secret\\path detail")), patch("sys.stderr"):
            reply = self.ask("claims.list", request_id="abc")
        self.assertEqual(reply, {"id": "abc", "ok": False, "error": {"kind": "internal", "message": "Internal error. Details are in the server log."}})

    def test_an_unopened_database_answers_unavailable(self):
        reply = service.handle(None, {"id": 2, "cmd": "ping"}, "This GC database requires a newer application version.")
        self.assertEqual(reply["error"], {"kind": "unavailable", "message": "This GC database requires a newer application version."})


class HelperProcessTests(unittest.TestCase):
    """The real child process: one JSON line per reply, nothing else on stdout, exit when stdin closes."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=PROJECT / "backups" / "source")

    def tearDown(self):
        self.temp.cleanup()

    def run_helper(self, stdin_bytes):
        return subprocess.run([sys.executable, "-m", "gc_manager.service", "--data-root", self.temp.name], cwd=PROJECT,
                              input=stdin_bytes, capture_output=True, timeout=60,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def test_round_trip_bad_lines_and_clean_exit(self):
        lines = [json.dumps({"id": 1, "cmd": "ping"}), "not json", "", json.dumps({"id": "two", "cmd": "claims.list"}),
                 "x" * (service.MAX_LINE + 10), json.dumps({"id": 3, "cmd": "vocabulary"})]
        result = self.run_helper(("\n".join(lines) + "\n").encode("utf-8"))
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        replies = [json.loads(line) for line in result.stdout.decode("utf-8").splitlines()]
        self.assertEqual(replies[0], {"event": "ready", "version": 1, "available": True})
        self.assertEqual([(r["id"], r["ok"]) for r in replies[1:]], [(1, True), (None, False), ("two", True), (None, False), (3, True)])
        self.assertEqual(replies[2]["error"]["message"], "Request is not valid JSON.")
        self.assertEqual(replies[4]["error"]["message"], "Request is too large.")

    def test_stray_output_goes_to_stderr_not_the_message_stream(self):
        code = ("import sys; sys.argv=['x','--data-root',sys.argv[1]]; import gc_manager.service as s; "
                "orig=s.handle; s.handle=lambda *a: (print('STRAY PRINT'), orig(*a))[1]; sys.exit(s.main(sys.argv[1:]))")
        result = subprocess.run([sys.executable, "-c", code, self.temp.name], cwd=PROJECT, input=b'{"id":1,"cmd":"ping"}\n',
                                capture_output=True, timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertNotIn(b"STRAY PRINT", result.stdout)
        self.assertIn(b"STRAY PRINT", result.stderr)
        self.assertEqual([json.loads(l)["ok"] if "ok" in l else "ready" for l in result.stdout.decode().splitlines()], ["ready", True])


class WebViewTests(unittest.TestCase):
    """The read-only web views: one vessel at a time, facts only, None where nothing is recorded, no email bodies."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=PROJECT / "backups" / "source")
        self.env = patch.dict(os.environ, {"GC_LOCAL_USER_NAME": "Tester"})
        self.env.start()
        self.repo = Repository(self.temp.name)
        ids = {v["name"]: v["id"] for v in self.repo.vessels()}
        self.impala, self.leopard = ids["DHT IMPALA"], ids["DHT LEOPARD"]
        self.c14 = self.repo.create_claim(self.impala, "GC-014", title="Purifier vibration", equipment_system="FO purifier")
        self.c2 = self.repo.create_claim(self.impala, "GC-002")
        self.repo.update_claim(self.c14, waiting_on="VENDOR_MAKER", next_follow_up_date="2026-12-01")
        self.repo.create_claim(self.leopard, "GC-001", title="Leopard claim")
        self.repo.import_message({"id": "a", "subject": "DHT Impala GC-014 maker reply", "body": "The bearing kit is ready for dispatch.",
                                  "sender_address": "maker@example.com", "message_datetime": "2026-11-20T08:00:00Z"})
        self.repo.import_message({"id": "b", "mailbox_folder": "Sent Items", "subject": "RE: DHT Impala GC014 maker reply",
                                  "body": "Please confirm the AWB.", "message_datetime": "2026-11-21T08:00:00Z"})
        self.repo.import_message({"id": "c", "subject": "DHT Impala GC-037 new defect", "body": "New claim text", "message_datetime": "2026-11-22T08:00:00Z"})
        self.repo.import_message({"id": "d", "subject": "DHT Leopard GC-009 other ship", "message_datetime": "2026-11-23T08:00:00Z"})
        self.repo.import_message({"id": "e", "subject": "GC-050 no vessel named", "message_datetime": "2026-11-24T08:00:00Z"})
        self.repo.save_settings({"tracked_vessels": ["DHT IMPALA"]})

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def ask(self, cmd, **args):
        reply = service.handle(self.repo, {"id": 1, "cmd": cmd, "args": args})
        self.assertTrue(reply["ok"], reply)
        return reply["result"]

    def test_scope_is_the_tracked_vessels_with_claims(self):
        overview = self.ask("web.overview")
        self.assertEqual([v["name"] for v in overview["scope"]["vessels"]], ["DHT IMPALA"])
        self.assertEqual(overview["vessel"]["id"], self.impala)
        refused = service.handle(self.repo, {"id": 1, "cmd": "web.register", "args": {"vessel_id": self.leopard}})
        self.assertEqual(refused["error"]["kind"], "not_found")
        self.repo.save_settings({"tracked_vessels": []})
        self.assertEqual({v["name"] for v in self.ask("web.overview")["scope"]["vessels"]}, {"DHT IMPALA", "DHT LEOPARD"})
        self.assertEqual([c["gc_number"] for c in self.ask("web.register", vessel_id=self.leopard)["claims"]], ["GC-001"])

    def test_register_shows_recorded_facts_and_none_for_the_rest(self):
        claims = {c["gc_number"]: c for c in self.ask("web.register")["claims"]}
        self.assertEqual(list(claims), ["GC-002", "GC-014"])
        self.assertEqual((claims["GC-014"]["owner"], claims["GC-014"]["waiting_on"], claims["GC-014"]["emails"]), ("Makers", "VENDOR_MAKER", 2))
        self.assertEqual(claims["GC-014"]["next_follow_up_date"], "2026-12-01")
        self.assertEqual((claims["GC-002"]["title"], claims["GC-002"]["owner"], claims["GC-002"]["next_follow_up_date"]), (None, None, None))
        self.assertEqual(claims["GC-002"]["status_label"], "Draft / Under Review")

    def test_gc_numbers_are_matched_in_any_written_form_for_search_only(self):
        for text in ("GC014", "gc 14", "GC-0014"):
            with self.subTest(text=text):
                self.assertEqual([c["gc_number"] for c in self.ask("web.register", search=text)["claims"]], ["GC-014"])
        self.assertEqual([c["gc_number"] for c in self.ask("web.register", search="purifier")["claims"]], ["GC-014"])
        self.assertEqual(self.repo.claim(self.c14)["gc_number"], "GC-014")

    def test_overview_counts_facts_only(self):
        o = self.ask("web.overview")
        self.assertEqual((o["claims"]["total"], o["claims"]["open"], o["claims"]["closed"]), (2, 2, 0))
        self.assertEqual(o["ownership"]["not_established"], 1)
        self.assertEqual(next(g for g in o["ownership"]["groups"] if g["owner"] == "Makers")["open"], 1)
        self.assertEqual(o["recorded"], {"open": 2, "owner": 1, "title": 1, "equipment": 1, "follow_up_date": 1, "commitment_date": 0,
                                          "next_action": 0, "action_since": 1})  # setting the owner started the action period
        self.assertEqual(o["guarantee"], {"start_date": None, "expiry_date": None})
        self.assertEqual(o["correspondence"]["linked_emails"], 2)
        self.assertIsNone(o["sync"]["last_attempt_at"])
        self.repo.close_claim(self.c2, "2026-11-25", "Rectified and accepted")
        o = self.ask("web.overview")
        self.assertEqual((o["claims"]["open"], o["claims"]["closed"], o["recorded"]["open"]), (1, 1, 1))

    def test_correspondence_searches_the_text_but_never_returns_it(self):
        found = self.ask("web.correspondence", search="bearing kit")
        self.assertEqual([e["subject"] for e in found["emails"]], ["DHT Impala GC-014 maker reply"])
        self.assertEqual(found["emails"][0]["claim"], {"id": self.c14, "gc_number": "GC-014"})
        self.assertNotIn("sanitised_body", found["emails"][0])
        everything = self.ask("web.correspondence")
        self.assertEqual(everything["total"], 3)  # Impala's two linked emails and its unregistered GC-037; not Leopard's, not the unnamed one
        self.assertEqual([e["direction"] for e in self.ask("web.correspondence", direction="OUTGOING")["emails"]], ["OUTGOING"])
        self.assertEqual(self.ask("web.correspondence", search="GC14")["total"], 2)
        self.assertEqual(self.ask("web.correspondence", search="100%_")["total"], 0)
        self.assertEqual(self.ask("web.correspondence", offset=2)["emails"][0]["subject"], "DHT Impala GC-014 maker reply")

    def test_reviews_for_the_vessel_and_those_without_a_vessel(self):
        items = self.ask("web.reviews")["items"]
        self.assertEqual([(i["type"], i["vessel_known"]) for i in items], [("UNMATCHED_GC_EMAIL", False), ("NEW_GC", True)])
        self.assertEqual(items[1]["gc_numbers"], ["GC-037"])
        self.assertNotIn("sanitised_body", items[1])

    def test_claim_detail_keeps_story_history_and_evidence_apart(self):
        detail = self.ask("web.claim", claim_id=self.c14)
        self.assertEqual(detail["claim"]["gc_number"], "GC-014")
        self.assertEqual([e["event_type"] for e in detail["story"]], ["CLAIM_CREATED"])
        self.assertEqual([h["new_waiting_on"] for h in detail["history"]], ["NONE", "VENDOR_MAKER"])
        self.assertEqual(len(detail["emails"]), 2)
        self.assertTrue(all("sanitised_body" not in e for e in detail["emails"]))
        self.assertEqual(service.handle(self.repo, {"id": 1, "cmd": "web.claim", "args": {"claim_id": 9999}})["error"]["kind"], "not_found")

    def test_web_view_arguments_are_checked(self):
        for args, pattern in (({"vessel_id": "1"}, "positive whole number"), ({"direction": "SIDEWAYS"}, "must be one of"),
                              ({"offset": -1}, "from 0 to"), ({"offset": 10**7}, "from 0 to")):
            with self.subTest(args=args):
                reply = service.handle(self.repo, {"id": 1, "cmd": "web.correspondence", "args": args})
                self.assertEqual(reply["error"]["kind"], "bad_request")
                self.assertIn(pattern, reply["error"]["message"])


if __name__ == "__main__":
    unittest.main()
