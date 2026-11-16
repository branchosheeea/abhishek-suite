import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gc_manager.attention import calculate_attention
from gc_manager.outlook import GRAPH_SCOPES, GRAPH_FORBIDDEN_SCOPES, ReadOnlyGraphAdapter, import_fixture, import_msg_archive
from gc_manager.repository import Repository
from gc_manager.rules import extract_gc_numbers, identify_vessel
from gc_manager.ui import GCApp
from suite_services.database import connection, initialize


class GuaranteeClaimManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1]/"backups"/"source")
        self.repo=Repository(self.temp.name)
        vessels={v["name"].casefold():v["id"] for v in self.repo.vessels()}
        self.impala=vessels["dht impala"]; self.leopard=vessels["dht leopard"]

    def tearDown(self): self.temp.cleanup()

    def test_gc_extraction_and_normalization(self):
        cases={"GC001 Main Engine issue":["GC-001"],"RE: GC-001 maker reply":["GC-001"],"GC 001 spare dispatch":["GC-001"],"gc001 attendance":["GC-001"],"GC-027 and GC-031 combined update":["GC-027","GC-031"],"General technical update":[],"GC1 GC01 GC-0001 GC1234":["GC-001","GC-1234"]}
        for subject,expected in cases.items():
            with self.subTest(subject=subject):self.assertEqual(extract_gc_numbers(subject),expected)

    def test_vessel_exact_normalized_fuzzy_and_ambiguous(self):
        vessels=self.repo.vessels()
        for subject,kind in (("DHT Impala GC001","EXACT"),("DHT IMPALA GC-001","EXACT"),("dht impala GC 001","EXACT"),("DHTImpala GC001","NORMALISED_EXACT"),("DHT-Impala GC001","NORMALISED_EXACT"),("DHT_Impala GC001","NORMALISED_EXACT")):
            with self.subTest(subject=subject):self.assertEqual(identify_vessel(subject,vessels).match_type,kind)
        self.assertEqual(identify_vessel("DHT Impalaa GC001",vessels).match_type,"SAFE_FUZZY")
        self.assertEqual(identify_vessel("DHT Impalaaa GC001",vessels).match_type,"SAFE_FUZZY")
        self.assertEqual(identify_vessel("DHT Impala technical update",vessels).match_type,"EXACT")
        self.assertEqual(identify_vessel("DHT Impala DHT Leopard GC001",vessels).match_type,"AMBIGUOUS")
        self.assertEqual(identify_vessel("GC001 maker reply",vessels).match_type,"NO_MATCH")

    def test_vertical_slice_fixture_new_gc_registration_dedup_and_dashboard(self):
        fixture=Path(self.temp.name)/"mail.json"
        message={"id":"mock-1","mailbox_folder":"Inbox","subject":"DHT Impala GC014 maker comments","sender_address":"maker@example.test","message_datetime":"2026-11-13T08:00:00+08:00","body":"Repair evidence attached."}
        fixture.write_text(json.dumps([message]),encoding="utf-8")
        first=import_fixture(self.repo,fixture)[0]
        self.assertEqual(first["review_type"],"NEW_GC")
        self.assertIsNone(first["claim_id"])
        review=self.repo.reviews()[0]
        self.assertEqual(review["review_type"],"NEW_GC")
        self.repo.resolve_review(review["id"],"link","Registered after subject review",vessel_id=self.impala,register=True)
        claim=self.repo.claims()[0]
        self.assertEqual((claim["vessel_id"],claim["gc_number"]),(self.impala,"GC-014"))
        self.assertEqual(len(self.repo.emails(claim["id"])),1)
        self.assertEqual(len(self.repo.timeline(claim["id"])),2)
        self.assertIn("EMAIL",{event["event_type"] for event in self.repo.timeline(claim["id"])})
        self.assertEqual(self.repo.dashboard()["total"],1)
        self.assertEqual(import_fixture(self.repo,fixture)[0]["duplicate"],True)
        self.assertEqual(len(self.repo.emails(claim["id"])),1)

    def test_local_msg_archive_import_uses_outlook_read_only_metadata_and_deduplicates(self):
        archive=Path(self.temp.name)/"archive"
        archive.mkdir()
        (archive/"incoming.msg").write_bytes(b"incoming fixture")
        (archive/"outgoing.msg").write_bytes(b"outgoing fixture")
        claim=self.repo.create_claim(self.impala,"GC-014",title="Pilot claim")

        class ExchangeUser:
            PrimarySmtpAddress="user@example.test"
        class AddressEntry:
            def GetExchangeUser(self):return ExchangeUser()
        class Accessor:
            def __init__(self,message_id):self.message_id=message_id
            def GetProperty(self,_uri):return self.message_id
        class MailItem:
            Class=43; SenderEmailType="SMTP"; SenderName="Pilot sender"
            ReceivedTime="2026-11-14T10:00:00+08:00"; SentOn="2026-11-14T10:00:00+08:00"
            ConversationID="conversation-1"; To="recipient@example.test"; CC=""
            Subject="DHT Impala GC014 maker update"; Body="Evidence in message body."
            Attachments=type("Attachments",(),{"Count":1})()
            def __init__(self,sender,message_id):
                self.SenderEmailAddress=sender;self.PropertyAccessor=Accessor(message_id)
        class Namespace:
            CurrentUser=type("User",(),{"AddressEntry":AddressEntry()})()
            def OpenSharedItem(self,path):
                name=Path(path).name
                return MailItem("user@example.test" if name=="outgoing.msg" else "maker@example.test", "<"+name+"@example.test>")

        results=import_msg_archive(self.repo,archive,namespace_factory=Namespace)
        self.assertEqual(len(results),2)
        self.assertTrue(all(result.get("claim_id")==claim for result in results))
        emails=self.repo.emails(claim)
        self.assertEqual({email["direction"] for email in emails},{"INCOMING","OUTGOING"})
        self.assertTrue(all(email["has_attachments"] for email in emails))
        self.assertEqual(len(import_msg_archive(self.repo,archive,namespace_factory=Namespace)),2)
        self.assertEqual(len(self.repo.emails(claim)),2)

    def test_registering_new_gc_can_bulk_link_only_same_compound_key_reviews(self):
        self.repo.import_message({"id":"impala-1","subject":"DHT Impala GC014 maker update"})
        self.repo.import_message({"id":"impala-2","subject":"DHT IMPALA GC-014 dispatch reply"})
        self.repo.import_message({"id":"impala-other-gc","subject":"DHT Impala GC015 maker update"})
        self.repo.import_message({"id":"leopard-same-gc","subject":"DHT Leopard GC014 maker update"})
        first=next(review for review in self.repo.reviews() if review["subject"]=="DHT Impala GC014 maker update")
        self.assertEqual(self.repo.matching_new_gc_review_count(first["id"]),1)
        linked=self.repo.resolve_review(first["id"],"link","Confirmed by operator",vessel_id=self.impala,register=True,link_matching=True)
        claim=next(item for item in self.repo.claims() if item["vessel_id"]==self.impala and item["gc_number"]=="GC-014")
        self.assertEqual(linked,2)
        self.assertEqual(len(self.repo.emails(claim["id"])),2)
        self.assertEqual(len(self.repo.reviews()),2)
        with connection(self.temp.name) as db:
            self.assertEqual(db.execute("select count(*) from gc_audit_events where claim_id=? and action='review_linked_same_compound_key'",(claim["id"],)).fetchone()[0],1)

    def test_compound_key_prevents_cross_vessel_link(self):
        impala=self.repo.create_claim(self.impala,"GC-014",title="Impala defect")
        leopard=self.repo.create_claim(self.leopard,"GC-014",title="Leopard defect")
        one=self.repo.import_message({"id":"a","subject":"DHT Impala GC014 maker reply","mailbox_folder":"Inbox"})
        two=self.repo.import_message({"id":"b","subject":"DHT Leopard GC014 dispatch","mailbox_folder":"Sent Items"})
        no_vessel=self.repo.import_message({"id":"c","subject":"GC014 maker response","mailbox_folder":"Inbox"})
        no_gc=self.repo.import_message({"id":"no-gc","subject":"DHT Impala technical update","mailbox_folder":"Inbox"})
        uncertain=self.repo.import_message({"id":"d","subject":"DHT Impalaa GC014?","mailbox_folder":"Inbox"})
        self.assertEqual(one["claim_id"],impala); self.assertEqual(two["claim_id"],leopard)
        self.assertNotEqual(one["claim_id"],two["claim_id"])
        self.assertEqual(no_vessel["review_type"],"UNMATCHED_GC_EMAIL");self.assertIsNone(no_vessel["claim_id"])
        self.assertTrue(no_gc["ignored"])
        self.assertEqual(uncertain["claim_id"],impala)  # Independent safe fuzzy subject match; same-vessel claim only.
        self.assertEqual(self.repo.emails(leopard)[0]["direction"],"OUTGOING")
        with connection(self.temp.name) as db:
            with self.assertRaises(Exception):db.execute("INSERT INTO gc_claims(vessel_id,gc_number,created_at,updated_at) VALUES(?,?,?,?)",(self.impala,"GC-014","x","x"))
        self.repo.close_claim(impala,"2026-11-14","Resolved and closed")
        still_unmatched=self.repo.import_message({"id":"after-close","subject":"GC014 follow-up without vessel","mailbox_folder":"Inbox"})
        self.assertEqual(still_unmatched["review_type"],"UNMATCHED_GC_EMAIL")
        self.assertIsNone(still_unmatched["claim_id"])

    def test_review_never_uses_gc_alone_and_cross_vessel_reassignment_is_audited(self):
        impala=self.repo.create_claim(self.impala,"GC-027")
        leopard=self.repo.create_claim(self.leopard,"GC-027")
        item=self.repo.import_message({"id":"no-vessel","subject":"GC027 maker response"})
        self.assertEqual(item["review_type"],"UNMATCHED_GC_EMAIL")
        self.assertIsNone(item["claim_id"])
        review=self.repo.reviews()[0]
        self.repo.resolve_review(review["id"],"link","Operator confirmed vessel from subject evidence",vessel_id=self.leopard,claim_id=leopard)
        email=self.repo.emails(leopard)[0]
        self.assertEqual(email["claim_id"],leopard)
        with connection(self.temp.name) as db:
            audit=db.execute("SELECT action,details_json FROM gc_audit_events WHERE email_id=? ORDER BY id DESC LIMIT 1",(email["id"],)).fetchone()
            self.assertEqual(audit["action"],"review_linked")
        self.assertNotEqual(impala,leopard)

    def test_multiple_gc_review_can_link_one_email_to_multiple_claims_explicitly(self):
        one=self.repo.create_claim(self.impala,"GC-027")
        two=self.repo.create_claim(self.impala,"GC-031")
        result=self.repo.import_message({"id":"multi","subject":"DHT Impala GC-027 and GC-031 combined update"})
        self.assertEqual(result["review_type"],"MULTIPLE_GC_NUMBERS")
        review=self.repo.reviews()[0]
        self.repo.resolve_multiple_gc_review(review["id"],[one,two],"Maker response covers both defects.")
        self.assertEqual(len(self.repo.emails(one)),1)
        self.assertEqual(len(self.repo.emails(two)),1)
        with connection(self.temp.name) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM gc_email_claim_links").fetchone()[0],2)

    def test_mock_graph_pagination_and_delta_state_share_import_pipeline(self):
        self.repo.create_claim(self.impala,"GC-014")
        adapter=ReadOnlyGraphAdapter("client","tenant")
        adapter.acquire_token=lambda prompt=None:"test-token"
        calls=[]
        def request(url,token):
            calls.append(url)
            if "inbox" in url and "page=2" not in url:
                return {"value":[{"id":"page-one","subject":"DHT Impala GC014 evidence","receivedDateTime":"2026-11-13T08:00:00Z","from":{"emailAddress":{"address":"maker@example.test"}}}],"@odata.nextLink":"https://graph.microsoft.com/page=2"}
            if "page=2" in url:
                return {"value":[{"id":"page-two","subject":"DHT Impala GC014 follow-up","receivedDateTime":"2026-11-13T09:00:00Z"}],"@odata.deltaLink":"https://graph.microsoft.com/inbox-delta"}
            return {"value":[],"@odata.deltaLink":"https://graph.microsoft.com/sent-delta"}
        adapter._request=request
        result=adapter.sync(self.repo)
        self.assertEqual(result,{"inbox":2,"sentitems":0})
        self.assertEqual(self.repo.delta_state("inbox")["delta_link"],"https://graph.microsoft.com/inbox-delta")
        self.assertEqual(self.repo.delta_state("sentitems")["delta_link"],"https://graph.microsoft.com/sent-delta")
        self.assertEqual(len(self.repo.emails(1)),2)

    def test_suite_database_data_is_preserved_by_gc_additive_migration(self):
        legacy=Path(self.temp.name)/"legacy";legacy.mkdir();initialize(legacy)
        with connection(legacy) as db, db:
            db.execute("INSERT INTO audit_events(action,note,actor,created_at) VALUES('pre_gc','preserved','test','2026-01-01')")
        # GC takes a timestamped backup before additive schema changes.
        migrated=Repository(legacy)
        self.assertEqual(len(list((legacy/"backups").glob("suite-before-gc-*.sqlite3.bak"))),1)
        with connection(legacy) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM audit_events WHERE action='pre_gc'").fetchone()[0],1)

    def test_safe_reassignment_records_old_and_new_claim_audit(self):
        old=self.repo.create_claim(self.impala,"GC-014")
        new=self.repo.create_claim(self.leopard,"GC-014")
        imported=self.repo.import_message({"id":"reassign","subject":"DHT Impala GC014 vendor reply"})
        email=self.repo.emails(old)[0]
        with self.assertRaises(ValueError):self.repo.reassign_email(email["id"],new,"",old)
        self.repo.reassign_email(email["id"],new,"Corrected after manual vessel review",old)
        self.assertEqual(self.repo.emails(old),[])
        self.assertEqual(self.repo.emails(new)[0]["id"],email["id"])
        with connection(self.temp.name) as db:
            actions={row[0] for row in db.execute("SELECT action FROM gc_audit_events WHERE email_id=?",(email["id"],))}
        self.assertIn("email_reassigned_from",actions);self.assertIn("email_reassigned_to",actions)

    def test_audit_user_uses_configured_identity_and_allows_absence(self):
        with patch.dict(os.environ,{"GC_LOCAL_USER_NAME":"Configured Operator"}):
            claim=self.repo.create_claim(self.impala,"GC-046")
            self.assertEqual(self.repo.claim(claim)["created_by"],"Configured Operator")
        with patch.dict(os.environ,{"GC_LOCAL_USER_NAME":""}):
            other=self.repo.create_claim(self.leopard,"GC-046")
            self.assertIsNone(self.repo.claim(other)["created_by"])

    def test_customtkinter_workspace_starts_with_all_required_sections(self):
        app=GCApp(self.temp.name)
        try:
            app.update_idletasks()
            self.assertEqual(set(app.tabs._tab_dict),{"Dashboard","Daily Attention","GC Register","Review Queue","Vessels","Settings"})
            self.assertEqual(app.sync_label.cget("text").split(" · ")[0],"Outlook Not Configured")
        finally:app.destroy()

    def test_status_closure_reopen_undo_and_attention(self):
        claim_id=self.repo.create_claim(self.impala,"GC-031",next_follow_up_date="2026-11-13")
        self.repo.set_status(claim_id,"SUBMITTED","Submitted to maker")
        self.repo.undo_last_manual_status_change(claim_id,"Incorrect status selected")
        self.assertEqual(self.repo.claim(claim_id)["current_status"],"DRAFT")
        with self.assertRaises(ValueError):self.repo.set_status(claim_id,"CLOSED")
        with self.assertRaisesRegex(ValueError,"reason is required"):
            self.repo.set_status(claim_id,"CANCELLED","",override=True)
        self.repo.close_claim(claim_id,"2026-11-14","Rectified and verified")
        self.assertEqual(self.repo.claim(claim_id)["current_status"],"CLOSED")
        self.repo.reopen_claim(claim_id,"UNDER_REVIEW","Issue recurred")
        reopened=self.repo.claim(claim_id)
        self.assertEqual(reopened["reopened_count"],1);self.assertIsNone(reopened["closure_date"])
        self.assertIn("OVERDUE",calculate_attention({**reopened,"next_follow_up_date":"2026-11-13"},today="2026-11-14"))
        self.assertEqual(calculate_attention({**reopened,"current_status":"CANCELLED"},today="2026-11-14"),[])

    def test_attention_due_no_response_delivery_and_guarantee_expiry(self):
        claim={"current_status":"AWAITING_SUPPLY","next_follow_up_date":"2026-11-14","promised_dispatch_date":"2026-11-13","updated_at":"2026-11-01"}
        emails=[{"direction":"OUTGOING","message_datetime":"2026-10-31T08:00:00Z"}]
        flags=calculate_attention(claim,emails,{"guarantee_expiry_date":"2027-02-12"},{"no_response_days":14,"guarantee_alert_days":[90,60,30,14]},today="2026-11-14")
        self.assertIn("FOLLOW_UP_DUE",flags);self.assertIn("NO_RESPONSE",flags);self.assertIn("DELIVERY_OVERDUE",flags);self.assertIn("GUARANTEE_EXPIRY_RISK",flags)
        answered=[*emails,{"direction":"INCOMING","message_datetime":"2026-11-01T08:00:00Z"}]
        self.assertNotIn("NO_RESPONSE",calculate_attention(claim,answered,today="2026-11-14"))

    def test_mail_content_is_sanitized_and_graph_permissions_are_read_only(self):
        self.repo.create_claim(self.impala,"GC-001")
        result=self.repo.import_message({"id":"safe","subject":"DHT Impala GC001 report","body":"<p>Hello</p><script>steal()</script><img src='https://active.invalid/x'>"})
        email=self.repo.emails(result["claim_id"])[0]
        self.assertNotIn("steal()",email["sanitised_body"])
        self.assertNotIn("active.invalid",email["sanitised_body"])
        self.assertIn("Mail.Read",GRAPH_SCOPES)
        self.assertFalse(set(GRAPH_SCOPES)&set(GRAPH_FORBIDDEN_SCOPES))
        self.assertEqual(ReadOnlyGraphAdapter.api_scopes,("User.Read","Mail.Read"))


if __name__=="__main__":unittest.main()
