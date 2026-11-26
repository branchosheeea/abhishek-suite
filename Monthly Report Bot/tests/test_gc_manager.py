import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from gc_manager.attention import calculate_attention
from gc_manager.outlook import GRAPH_SCOPES, GRAPH_FORBIDDEN_SCOPES, GraphError, ReadOnlyGraphAdapter, import_fixture, import_msg_archive
from gc_manager.repository import Repository
from gc_manager.rules import extract_gc_numbers, identify_vessel
from gc_manager.ui import GCApp, local_time, sync_summary
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
        self.repo.save_settings({"tracked_vessels":[]})
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
            if "/delta" not in url and "page=2" not in url:return {}
            if "inbox" in url and "page=2" not in url:
                return {"value":[{"id":"page-one","subject":"DHT Impala GC014 evidence","receivedDateTime":"2026-11-13T08:00:00Z","from":{"emailAddress":{"address":"maker@example.test"}}}],"@odata.nextLink":"https://graph.microsoft.com/page=2"}
            if "page=2" in url:
                return {"value":[{"id":"page-two","subject":"DHT Impala GC014 follow-up","receivedDateTime":"2026-11-13T09:00:00Z"}],"@odata.deltaLink":"https://graph.microsoft.com/inbox-delta"}
            return {"value":[],"@odata.deltaLink":"https://graph.microsoft.com/sent-delta"}
        adapter._request=request
        result=adapter.sync(self.repo)
        self.assertEqual(result,{"inbox":2,"sentitems":0,"folders":{},"added":2})
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
        with patch.dict(os.environ,{"AZURE_CLIENT_ID":"","AZURE_TENANT_ID":"","GC_GRAPH_ENABLED":"false"}):app=GCApp(self.temp.name)
        try:
            app.update_idletasks()
            self.assertEqual(set(app.tabs._tab_dict),{"Dashboard","Daily Attention","GC Register","Review Queue","Vessels","Settings"})
            self.assertEqual(app.sync_label.cget("text").split(" · ")[0],"Outlook Not Configured")
        finally:app.destroy()

    def test_graph_does_not_duplicate_emails_imported_from_msg_files(self):
        claim=self.repo.create_claim(self.impala,"GC-014")
        mail={"internet_message_id":"<Mail-1@example.test>","subject":"DHT Impala GC014 maker update","mailbox_folder":"Sent Items","source":"local_msg_archive"}
        first=self.repo.import_message(mail)
        again=self.repo.import_message({**mail,"id":"graph-1","graph_immutable_id":"graph-1","internet_message_id":" <mail-1@EXAMPLE.test> ","source":"graph"})
        self.assertEqual((again.get("duplicate"),again["email_id"],again["claim_id"]),(True,first["email_id"],claim))
        self.repo.import_message({**mail,"id":"graph-2","internet_message_id":"<mail-2@example.test>"})
        for number in (3,4):self.repo.import_message({"id":f"graph-{number}","internet_message_id":"","subject":"DHT Impala GC014 no id"})
        self.assertEqual(len(self.repo.emails(claim)),4)
        self.assertEqual(len([e for e in self.repo.timeline(claim) if e["event_type"]=="EMAIL"]),4)

    def test_email_copied_to_oneself_is_kept_once_as_outgoing(self):
        claim=self.repo.create_claim(self.impala,"GC-014")
        adapter=ReadOnlyGraphAdapter("client","tenant");adapter.acquire_token=lambda prompt=None:"token"
        adapter._request=lambda url,token:{} if "/delta" not in url else {"value":[{"id":"inbox-copy" if "/inbox/" in url else "sent-copy","internetMessageId":"<self@example.test>","subject":"DHT Impala GC014","receivedDateTime":"2026-11-13T08:00:00Z","from":{}}],"@odata.deltaLink":"d"}
        adapter.sync(self.repo)
        self.assertEqual([e["direction"] for e in self.repo.emails(claim)],["OUTGOING"])

    def _fake_mailbox(self, messages, folders):
        """Graph stand-in. messages: folder id -> items; folders: parent id ('' = top) -> [(id, name)]."""
        adapter=ReadOnlyGraphAdapter("client","tenant");adapter.acquire_token=lambda prompt=None,interactive=True,renew=False:"token";calls=[]
        def request(url,token):
            calls.append(url);path=url.split("/v1.0/me",1)[1].split("?")[0]
            if path=="":return {"mail":"Me@Example.test","userPrincipalName":"me@example.test"}
            if path.startswith("/messages/"):return {"body":{"content":"<p>Body of "+path.rsplit("/",1)[1]+"</p>"}}
            if path.endswith("/messages/delta"):
                folder=path.split("/")[2]
                return {"value":messages.get(folder,[]),"@odata.deltaLink":"https://graph.microsoft.com/v1.0/me/mailFolders/"+folder+"/messages/delta?token=1"}
            parent=path.split("/")[2] if path.endswith("/childFolders") else ("" if path=="/mailFolders" else None)
            if parent is None:return {"id":path.rsplit("/",1)[1]}
            return {"value":[{"id":i,"displayName":n,"childFolderCount":len(folders.get(i,[]))} for i,n in folders.get(parent,[])]}
        adapter._request=request
        return adapter,calls

    def test_sync_renews_an_expired_token_once_and_continues_in_the_same_folder(self):
        self.repo.create_claim(self.impala,"GC-014")
        def mail(i):return {"id":i,"internetMessageId":f"<{i}@x>","subject":"DHT Impala GC014","receivedDateTime":"2026-03-01T00:00:00Z"}
        adapter,calls=self._fake_mailbox({"inbox":[mail("a"),mail("b"),mail("c")]},{});plain=adapter._request;asked=[];valid={"token"}
        def acquire(prompt=None,interactive=True,renew=False):
            asked.append((interactive,renew))
            if renew:valid.add("new")
            return "new" if renew else "token"
        def request(url,token):
            if "/messages/b?" in url:valid.discard("token")  # the hour is up while reading the second email
            if token not in valid:raise GraphError("Microsoft Graph returned HTTP 401: Invalid token lifetime",401)
            return plain(url,token)
        adapter.acquire_token=acquire;adapter._request=request
        self.assertEqual(adapter.sync(self.repo)["added"],3)
        self.assertEqual(asked,[(True,False),(False,True)])  # renewed once, without a sign-in
        self.assertEqual(len([c for c in calls if "/mailFolders/inbox/messages/delta" in c]),1)  # folder not started over

    def test_a_token_that_stays_rejected_or_cannot_be_renewed_stops_the_sync(self):
        adapter,_=self._fake_mailbox({},{});renewals=[]
        def acquire(prompt=None,interactive=True,renew=False):
            renewals.append(renew);return "token"
        def rejected(url,token):raise GraphError("rejected",401)
        adapter.acquire_token=acquire;adapter._request=rejected
        with self.assertRaises(GraphError):adapter.sync(self.repo)
        self.assertEqual(renewals,[False,True])  # one renewal, no endless loop
        class App:
            def get_accounts(self):return ["me"]
            def acquire_token_silent(self,scopes,account,force_refresh):self.forced=force_refresh;return None
        real=ReadOnlyGraphAdapter("client","tenant");real._app=App()
        with self.assertRaisesRegex(RuntimeError,"sign-in needed"):real.acquire_token(interactive=False,renew=True)
        self.assertTrue(real._app.forced)

    def test_only_tracked_vessels_are_read_shown_and_counted_until_the_list_is_widened(self):
        self.repo.create_claim(self.impala,"GC-014")
        def mail(i,subject):return {"id":i,"internetMessageId":f"<{i}@x>","subject":subject,"receivedDateTime":"2026-03-01T00:00:00Z"}
        folders={"":[("inbox","Inbox"),("f-opal","DHT Opal")],"inbox":[("f-imp","DHT Impala"),("f-leo","DHT Leopard"),("f-lion","Lion"),("f-any","Makers")],"f-leo":[("f-sub","Old claims")]}
        messages={"inbox":[mail("imp","DHT Impala GC014"),mail("leo","DHT Leopard GC014"),mail("both","DHT Impala and DHT Leopard GC014"),mail("none","GC014 maker reply")],
                  "f-imp":[mail("imp2","DHT Impala GC014 b")],"f-leo":[mail("leo2","DHT Leopard GC014 b")],"f-sub":[mail("leo3","GC015")],"f-any":[mail("leo4","DHT Leopard GC014 c"),mail("imp3","DHT Impala GC014 c")]}
        self.assertEqual(self.repo.settings()["tracked_vessels"],["DHT IMPALA"])
        adapter,calls=self._fake_mailbox(messages,folders);result=adapter.sync(self.repo)
        self.assertEqual(set(result["folders"]),{"Inbox/DHT Impala","Inbox/Makers"})
        self.assertEqual(result["added"],5)  # imp, both, none, imp2, imp3
        self.assertFalse([c for c in calls if "/messages/leo" in c])
        # An email of another vessel that is already stored stays stored, but is not shown or counted.
        self.repo.import_message({"id":"stored","subject":"DHT Leopard GC099"})
        self.assertEqual({r["subject"] for r in self.repo.reviews()},{"DHT Impala and DHT Leopard GC014","GC014 maker reply"})
        self.assertEqual({k:self.repo.email_summary()[k] for k in ("stored","linked","to_review")},{"stored":5,"linked":3,"to_review":2})
        self.assertEqual(len(self.repo.reviews(open_only=False)),3)
        with self.assertRaisesRegex(ValueError,"DHT WRONG"):self.repo.save_settings({"tracked_vessels":["DHT WRONG"]})
        self.repo.save_settings({"tracked_vessels":["dht impala"]})
        self.assertIn("token=1",self.repo.delta_state("inbox")["delta_link"])  # same list: positions kept
        self.repo.save_settings({"tracked_vessels":["DHT Impala","DHT LEOPARD"]})
        self.assertIsNone(self.repo.delta_state("inbox")["delta_link"])
        self.assertEqual(adapter.sync(self.repo)["added"],4)  # leo, leo2, leo3, leo4; nothing twice
        self.assertIn("DHT Leopard GC099",{r["subject"] for r in self.repo.reviews()})

    def test_widening_the_list_during_a_sync_does_not_keep_old_positions(self):
        adapter,_=self._fake_mailbox({"inbox":[{"id":"a","subject":"DHT Impala GC014","receivedDateTime":"2026-03-01T00:00:00Z"}]},{});plain=adapter._request
        def request(url,token):
            if "/mailFolders/inbox/messages/delta" in url:self.repo.save_settings({"tracked_vessels":[]})
            return plain(url,token)
        adapter._request=request;adapter.sync(self.repo)
        self.assertIsNone(self.repo.delta_state("inbox")["delta_link"])

    def test_sync_reads_vessel_folders_from_the_start_date_and_fetches_only_gc_bodies(self):
        self.repo.save_settings({"tracked_vessels":[]})
        claim=self.repo.create_claim(self.impala,"GC-014")
        def mail(i,subject,when="2026-03-01T00:00:00Z",sender="maker@example.test"):
            return {"id":i,"internetMessageId":f"<{i}@x>","subject":subject,"receivedDateTime":when,"from":{"emailAddress":{"address":sender}}}
        folders={"":[("inbox","Inbox"),("sentitems","Sent Items"),("deleteditems","Deleted Items"),("f-imp","DHT Impala"),("f-pers","Holiday"),("f-lion","Lion")],
                 "inbox":[("f-any","Makers")],"f-any":[("f-deep","Deep")],"f-imp":[("f-sub","Old claims")],"deleteditems":[("f-del","DHT Impala")],"f-pers":[("f-pers-v","DHT OPAL")]}
        messages={"inbox":[mail("in","DHT Impala GC014 a"),mail("old","DHT Impala GC014 old","2025-12-31T23:59:59Z"),mail("edge","DHT Impala GC014 edge","2026-01-01T00:00:00Z"),mail("nogc","DHT Impala noon report")],
                  "f-imp":[mail("rule","DHT Impala GC014 b"),mail("mine","DHT Impala GC014 c",sender="ME@example.test"),mail("in","DHT Impala GC014 a")],
                  "f-sub":[mail("sub","DHT Impala GC014 d")],"f-deep":[mail("deep","DHT Impala GC014 e")],"f-del":[mail("deleted","DHT Impala GC014 x")],"f-pers":[mail("private","DHT Impala GC014 y")]}
        adapter,calls=self._fake_mailbox(messages,folders)
        result=adapter.sync(self.repo)
        self.assertEqual(set(result["folders"]),{"Inbox/Makers","Inbox/Makers/Deep","DHT Impala","DHT Impala/Old claims","Lion","Holiday/DHT OPAL"})
        self.assertEqual(result["added"],6)
        stored={e["graph_immutable_id"]:e for e in self.repo.emails(claim)}
        self.assertEqual(set(stored),{"in","edge","rule","mine","sub","deep"})
        self.assertEqual((stored["mine"]["direction"],stored["rule"]["direction"]),("OUTGOING","INCOMING"))
        self.assertEqual(stored["rule"]["mailbox_folder"],"DHT Impala")
        self.assertEqual(stored["rule"]["sanitised_body"],"Body of rule")
        self.assertEqual(len([c for c in calls if "/me/messages/" in c]),6)
        self.assertTrue(all("body" not in c for c in calls if "/delta" in c))
        calls.clear();self.assertEqual(adapter.sync(self.repo)["added"],0)
        self.assertEqual([c for c in calls if "/me/messages/" in c],[])
        self.assertTrue(all("token=1" in c for c in calls if "/delta" in c))

    def test_expired_sync_position_reads_the_folder_again_without_duplicates(self):
        claim=self.repo.create_claim(self.impala,"GC-014")
        item={"id":"a","internetMessageId":"<a@x>","subject":"DHT Impala GC014","receivedDateTime":"2026-03-01T00:00:00Z"}
        adapter,_=self._fake_mailbox({"inbox":[item]},{});adapter.sync(self.repo);plain=adapter._request
        def expired(url,token):
            if "token=1" in url:raise GraphError("gone",410)
            return plain(url,token)
        adapter._request=expired
        self.assertEqual(adapter.sync(self.repo)["inbox"],1)
        self.assertEqual(len(self.repo.emails(claim)),1)

    def test_sync_summary_lists_folders_that_had_messages(self):
        text=sync_summary({"added":3,"inbox":10,"sentitems":4,"folders":{"DHT Impala":7,"Empty":0}})
        self.assertIn("New GC emails added: 3",text);self.assertIn("DHT Impala: 7",text);self.assertNotIn("Empty",text)

    def test_email_summary_counts_links_open_reviews_and_local_day(self):
        self.assertEqual(self.repo.email_summary(),{"stored":0,"linked":0,"added_today":0,"to_review":0})
        one=self.repo.create_claim(self.impala,"GC-027");two=self.repo.create_claim(self.impala,"GC-031")
        self.repo.import_message({"id":"linked","subject":"DHT Impala GC027"})
        multi=self.repo.import_message({"id":"multi","subject":"DHT Impala GC-027 and GC-031"})
        self.repo.import_message({"id":"open","subject":"GC099 no vessel"})
        self.assertEqual(self.repo.email_summary(),{"stored":3,"linked":1,"added_today":3,"to_review":2})
        self.repo.resolve_multiple_gc_review(next(r["id"] for r in self.repo.reviews() if r["email_id"]==multi["email_id"]),[one,two],"both")
        self.assertEqual(self.repo.email_summary(),{"stored":3,"linked":2,"added_today":3,"to_review":1})
        local=datetime(2026,3,10,0,30).astimezone()  # just after local midnight is still the previous day in UTC east of Greenwich
        with connection(self.temp.name) as db,db:db.execute("UPDATE gc_emails SET imported_at=? WHERE graph_immutable_id='open'",(local.astimezone(timezone.utc).isoformat(timespec="microseconds"),))
        self.assertEqual(self.repo.email_summary("2026-03-10")["added_today"],1)
        self.assertEqual(self.repo.email_summary("2026-03-09")["added_today"],0)

    def test_dashboard_shows_email_numbers_live_and_drops_an_old_error(self):
        self.repo.create_claim(self.impala,"GC-014");self.repo.sync_attempt("old failure")
        self.repo.import_message({"id":"before","subject":"DHT Impala GC014","message_datetime":"2026-11-13T08:00:00Z"})
        with patch.dict(os.environ,{"AZURE_CLIENT_ID":"c","AZURE_TENANT_ID":"t","GC_GRAPH_ENABLED":"true"}),patch("gc_manager.ui.messagebox"),patch("gc_manager.ui.threading.Thread"):
            app=GCApp(self.temp.name)
            try:
                self.assertIn("old failure",app.sync_label.cget("text"))
                app.sync_now()
                self.assertEqual(app.sync_label.cget("text"),"Syncing with Outlook · 0 new emails so far")
                self.repo.import_message({"id":"during","subject":"DHT Impala GC014 again","message_datetime":"2026-11-14T08:00:00Z"})
                app.after_cancel(app._poll_after);app._poll_events()
                self.assertEqual(app.metric_labels["stored"].cget("text"),"1")  # not yet 5 seconds
                app._live_at-=6
                with patch.object(app,"_fill_attention",side_effect=AssertionError("tables must not be rebuilt")):
                    app.after_cancel(app._poll_after);app._poll_events()
                self.assertEqual({k:app.metric_labels[k].cget("text") for k in ("stored","linked","to_review","added_today")},{"stored":"2","linked":"2","to_review":"0","added_today":"2"})
                self.assertIn("1 new emails so far",app.sync_label.cget("text"))
                self.repo.save_delta_state("inbox","d",1)
                app.events.put(("auto_sync",{}));app.after_cancel(app._poll_after);app._poll_events()
                self.assertTrue(app.sync_label.cget("text").startswith("Outlook Connected · Last sync "))
                self.assertEqual(app.metric_labels["total"].cget("text"),"1")
            finally:app.destroy()

    def test_local_time_text(self):
        self.assertEqual(local_time(datetime(2026,11,25,22,2).astimezone().astimezone(timezone.utc).isoformat()),"25 Nov 2026, 10:02 pm")
        self.assertEqual(local_time(datetime(2026,1,5,0,7).astimezone().isoformat()),"5 Jan 2026, 12:07 am")
        self.assertEqual(local_time(None),"")

    def test_automatic_sync_never_starts_sign_in_or_shows_a_popup(self):
        class App:
            def get_accounts(self):return []
            def initiate_device_flow(self,scopes):raise AssertionError("sign-in started")
        adapter=ReadOnlyGraphAdapter("client","tenant");adapter._app=App()
        with self.assertRaisesRegex(RuntimeError,"sign-in needed"):adapter.sync(self.repo,interactive=False)
        with patch.dict(os.environ,{"AZURE_CLIENT_ID":"c","AZURE_TENANT_ID":"t","GC_GRAPH_ENABLED":"true"}),patch("gc_manager.ui.messagebox") as popup,patch("gc_manager.ui.threading.Thread") as thread:
            app=GCApp(self.temp.name)
            try:
                for outcome in ({"inbox":1,"sentitems":0},RuntimeError("sign-in needed")):
                    with patch("gc_manager.ui.ReadOnlyGraphAdapter") as fake:
                        fake.return_value.sync.side_effect=[outcome]
                        app.sync_now(automatic=True);thread.call_args.kwargs["target"]()
                        self.assertFalse(fake.return_value.sync.call_args.kwargs["interactive"])
                    app.after_cancel(app._poll_after);app._poll_events()
                    self.assertFalse(app.syncing)
                self.assertEqual(popup.mock_calls,[])
                self.assertIn("sign-in needed",app.sync_label.cget("text"))
                with patch("gc_manager.ui.ReadOnlyGraphAdapter") as fake:
                    fake.return_value.sync.return_value={"inbox":1,"sentitems":0}
                    app.sync_now();thread.call_args.kwargs["target"]()
                    self.assertTrue(fake.return_value.sync.call_args.kwargs["interactive"])
                app.after_cancel(app._poll_after);app._poll_events()
                popup.showinfo.assert_called_once()
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

    def test_guarantee_expiry_alert_shows_every_day_until_expiry(self):
        # Audit P1-5: it used to fire only on the exact days 90, 60, 30 and 14 before expiry.
        claim={"current_status":"AWAITING_SUPPLY"}
        vessel={"guarantee_expiry_date":"2027-01-01"}
        settings={"guarantee_alert_days":[90,60,30,14]}
        flagged=lambda today:"GUARANTEE_EXPIRY_RISK" in calculate_attention(claim,(),vessel,settings,today=today)
        self.assertFalse(flagged("2026-10-02"))  # 91 days before
        self.assertTrue(flagged("2026-10-03"))   # 90 days before
        self.assertTrue(flagged("2026-11-17"))   # 45 days before: missed before the fix
        self.assertTrue(flagged("2027-01-01"))   # expiry day
        self.assertFalse(flagged("2027-01-02"))  # after expiry: no longer "approaching"
        self.assertTrue("GUARANTEE_EXPIRY_RISK" in calculate_attention(claim,(),vessel,{},today="2026-12-01"),"default window is 90 days")

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
