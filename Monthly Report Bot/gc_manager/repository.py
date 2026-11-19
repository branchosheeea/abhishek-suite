"""SQLite repository and transactional GC business operations."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import shutil
import re
import sqlite3
from suite_services.database import connection, initialize
from suite_services.storage import runtime_root
from .rules import STATUS, WAITING_ON, LABELS, TRANSITIONS, extract_gc_numbers, identify_vessel

SCHEMA = """
CREATE TABLE IF NOT EXISTS gc_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gc_vessel_details(vessel_id INTEGER PRIMARY KEY REFERENCES vessels(id), code TEXT, guarantee_start_date TEXT, guarantee_expiry_date TEXT, closeout_end_date TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT);
CREATE TABLE IF NOT EXISTS gc_claims(id INTEGER PRIMARY KEY, vessel_id INTEGER NOT NULL REFERENCES vessels(id), gc_number TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', equipment_system TEXT NOT NULL DEFAULT '', defect_description TEXT NOT NULL DEFAULT '', date_reported TEXT, date_submitted TEXT, current_status TEXT NOT NULL DEFAULT 'DRAFT', waiting_on TEXT NOT NULL DEFAULT 'NONE', responsible_party_name TEXT NOT NULL DEFAULT '', next_follow_up_date TEXT, promised_dispatch_date TEXT, expected_delivery_date TEXT, service_attendance_date TEXT, rectification_date TEXT, closure_date TEXT, priority TEXT NOT NULL DEFAULT 'NORMAL', notes TEXT NOT NULL DEFAULT '', reopened_count INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT, updated_by TEXT, UNIQUE(vessel_id,gc_number));
CREATE TABLE IF NOT EXISTS gc_emails(id INTEGER PRIMARY KEY, claim_id INTEGER REFERENCES gc_claims(id), graph_immutable_id TEXT UNIQUE, graph_message_id TEXT, internet_message_id TEXT, conversation_id TEXT, mailbox_folder TEXT NOT NULL, direction TEXT NOT NULL, subject TEXT NOT NULL, detected_gc_numbers_json TEXT NOT NULL, detected_vessel_text TEXT, matched_vessel_id INTEGER REFERENCES vessels(id), vessel_match_type TEXT NOT NULL, vessel_match_score REAL, sender_name TEXT, sender_address TEXT, recipients_json TEXT NOT NULL DEFAULT '[]', message_datetime TEXT, body_preview TEXT NOT NULL DEFAULT '', sanitised_body TEXT NOT NULL DEFAULT '', has_attachments INTEGER NOT NULL DEFAULT 0, imported_at TEXT NOT NULL, reviewed_at TEXT, raw_metadata_json TEXT NOT NULL DEFAULT '{}', dedupe_key TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS gc_email_claim_links(email_id INTEGER NOT NULL REFERENCES gc_emails(id), claim_id INTEGER NOT NULL REFERENCES gc_claims(id), linked_at TEXT NOT NULL, linked_by TEXT, PRIMARY KEY(email_id,claim_id));
CREATE TABLE IF NOT EXISTS gc_status_history(id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES gc_claims(id), previous_status TEXT, new_status TEXT NOT NULL, previous_waiting_on TEXT, new_waiting_on TEXT NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL, source_email_id INTEGER REFERENCES gc_emails(id), changed_at TEXT NOT NULL, changed_by TEXT);
CREATE TABLE IF NOT EXISTS gc_timeline_events(id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES gc_claims(id), event_type TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', event_date TEXT NOT NULL, email_id INTEGER REFERENCES gc_emails(id), created_at TEXT NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS gc_outlook_sync_state(id INTEGER PRIMARY KEY, folder_name TEXT NOT NULL UNIQUE, delta_link TEXT, last_attempt_at TEXT, last_success_at TEXT, last_error TEXT, items_processed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gc_review_queue(id INTEGER PRIMARY KEY, email_id INTEGER NOT NULL REFERENCES gc_emails(id), review_type TEXT NOT NULL, suggested_vessel_id INTEGER REFERENCES vessels(id), suggested_claim_id INTEGER REFERENCES gc_claims(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', resolution_notes TEXT, reviewed_at TEXT, reviewed_by TEXT, created_at TEXT NOT NULL, UNIQUE(email_id,review_type));
CREATE TABLE IF NOT EXISTS gc_audit_events(id INTEGER PRIMARY KEY, claim_id INTEGER REFERENCES gc_claims(id), email_id INTEGER REFERENCES gc_emails(id), action TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, created_by TEXT);
CREATE TABLE IF NOT EXISTS gc_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS gc_claim_status_idx ON gc_claims(current_status);
CREATE INDEX IF NOT EXISTS gc_claim_followup_idx ON gc_claims(next_follow_up_date);
CREATE INDEX IF NOT EXISTS gc_email_datetime_idx ON gc_emails(message_datetime);
CREATE INDEX IF NOT EXISTS gc_review_status_idx ON gc_review_queue(status);
"""
SCHEMA_VERSION = 2
DEFAULTS = {
    "standard_followup_days": 7, "no_response_days": 14, "verification_days": 5,
    "dispatch_followup_days": 1, "delivery_followup_days": 1, "graph_sync_interval_minutes": 5,
    "guarantee_alert_days": [90, 60, 30, 14], "local_user_name": os.getenv("GC_LOCAL_USER_NAME") or None,
    "vessel_auto_match_threshold": int(os.getenv("GC_VESSEL_AUTO_MATCH_THRESHOLD",90)),
    "vessel_review_threshold": int(os.getenv("GC_VESSEL_REVIEW_THRESHOLD",80)),
    "vessel_match_margin": int(os.getenv("GC_VESSEL_MATCH_MARGIN",8)),
    "graph_enabled": os.getenv("GC_GRAPH_ENABLED", "false").lower() == "true",
    "graph_configured": bool(os.getenv("AZURE_CLIENT_ID") and os.getenv("AZURE_TENANT_ID")),
}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def _validate_dates(values):
    for key, value in values.items():
        if value and (key.endswith("_date") or key in {"date_reported", "date_submitted"}):
            try:
                date.fromisoformat(str(value))
            except ValueError as error:
                raise ValueError(f"{key.replace('_', ' ').title()} must use YYYY-MM-DD.") from error


class _TextOnly(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts = []; self.block = 0
    def handle_starttag(self, tag, attrs):
        if tag.lower() in {"script", "style", "iframe", "object", "svg"}: self.block += 1
    def handle_endtag(self, tag):
        if tag.lower() in {"script", "style", "iframe", "object", "svg"} and self.block: self.block -= 1
        elif tag.lower() in {"p", "br", "div", "li"}: self.parts.append("\n")
    def handle_data(self, data):
        if not self.block: self.parts.append(data)


def safe_body(value):
    parser = _TextOnly()
    parser.feed(value or "")
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()[:20000]


class Repository:
    def __init__(self, root=None):
        self.root = Path(root) if root else runtime_root()
        # Preserve the shared database before either Suite or GC initializers can alter it.
        database = self.root / "suite.sqlite3"
        version = 0
        if database.exists() and database.stat().st_size:
            try:
                reader=sqlite3.connect(f"file:{database.as_posix()}?mode=ro",uri=True)
                has_migrations=reader.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gc_schema_migrations'").fetchone() is not None
                if has_migrations:version=reader.execute("SELECT COALESCE(MAX(version),0) FROM gc_schema_migrations").fetchone()[0]
                reader.close()
            except sqlite3.Error:
                version=0
        if version>SCHEMA_VERSION:raise RuntimeError("This GC database requires a newer application version.")
        if database.exists() and database.stat().st_size and version<SCHEMA_VERSION:
            backup_dir = self.root / "backups"
            backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
            shutil.copy2(database, backup_dir / f"suite-before-gc-{stamp}.sqlite3.bak")
        # Existing Suite initialization is additive and preserves all module records.
        initialize(self.root)
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for statement in SCHEMA.split(";"):
                    if statement.strip(): db.execute(statement)
                for migration_version in range(1,SCHEMA_VERSION+1):db.execute("INSERT OR IGNORE INTO gc_schema_migrations VALUES(?,?)",(migration_version,now()))
                for key, value in DEFAULTS.items(): db.execute("INSERT OR IGNORE INTO gc_settings VALUES(?,?,?)", (key, json.dumps(value), now()))
                db.commit()
            except Exception:
                db.rollback()
                raise

    @property
    def actor(self):
        """GC_LOCAL_USER_NAME when set (tests, one-off), else the person signed in to NeraVeda, else the stored name."""
        if "GC_LOCAL_USER_NAME" in os.environ:
            return os.getenv("GC_LOCAL_USER_NAME", "").strip() or None
        from suite_services import actor as suite_actor
        if suite_actor.signed_in():
            return suite_actor.current_actor()
        return self.settings().get("local_user_name") or None

    def vessels(self, active_only=True):
        with connection(self.root) as db:
            where = "WHERE COALESCE(d.active,1)=1" if active_only else ""
            rows = db.execute(f"SELECT v.id,v.name,COALESCE(d.code,'') code,d.guarantee_start_date,d.guarantee_expiry_date,d.closeout_end_date,COALESCE(d.active,1) active FROM vessels v LEFT JOIN gc_vessel_details d ON d.vessel_id=v.id {where} ORDER BY v.name")
            return [dict(r) for r in rows]

    def save_vessel(self, name, code="", guarantee_start_date=None, guarantee_expiry_date=None, closeout_end_date=None, vessel_id=None, active=True):
        name = (name or "").strip()
        if not name: raise ValueError("Vessel name is required.")
        _validate_dates({"guarantee_start_date": guarantee_start_date, "guarantee_expiry_date": guarantee_expiry_date, "closeout_end_date": closeout_end_date})
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                if vessel_id:
                    exists = db.execute("SELECT id FROM vessels WHERE id=?", (vessel_id,)).fetchone()
                    if not exists: raise ValueError("Vessel does not exist.")
                    current = db.execute("SELECT name FROM vessels WHERE id=?", (vessel_id,)).fetchone()[0]
                    if current.casefold() != name.casefold(): raise ValueError("The canonical Suite vessel name cannot be renamed from GC Manager.")
                else:
                    row = db.execute("SELECT id FROM vessels WHERE name=? COLLATE NOCASE", (name,)).fetchone()
                    if row: vessel_id = row[0]
                    else: vessel_id = db.execute("INSERT INTO vessels(name) VALUES(?)", (name,)).lastrowid
                    db.execute("INSERT OR IGNORE INTO vessel_aliases(alias,vessel_id) VALUES(?,?)", (name, vessel_id))
                db.execute("INSERT INTO gc_vessel_details(vessel_id,code,guarantee_start_date,guarantee_expiry_date,closeout_end_date,active,created_at,updated_at,created_by,updated_by) VALUES(?,?,?,?,?,?,?, ?,?,?) ON CONFLICT(vessel_id) DO UPDATE SET code=excluded.code,guarantee_start_date=excluded.guarantee_start_date,guarantee_expiry_date=excluded.guarantee_expiry_date,closeout_end_date=excluded.closeout_end_date,active=excluded.active,updated_at=excluded.updated_at,updated_by=excluded.updated_by", (vessel_id,code,guarantee_start_date,guarantee_expiry_date,closeout_end_date,int(active),now(),now(),self.actor,self.actor))
                db.commit(); return vessel_id
            except Exception: db.rollback(); raise

    def claims(self, search="", status=None):
        sql = "SELECT c.*,v.name vessel_name,(SELECT h.changed_at FROM gc_status_history h WHERE h.claim_id=c.id ORDER BY h.id DESC LIMIT 1) last_status_change,(SELECT MAX(e.message_datetime) FROM gc_emails e LEFT JOIN gc_email_claim_links l ON l.email_id=e.id WHERE (e.claim_id=c.id OR l.claim_id=c.id) AND e.direction='INCOMING') last_incoming_email,(SELECT MAX(e.message_datetime) FROM gc_emails e LEFT JOIN gc_email_claim_links l ON l.email_id=e.id WHERE (e.claim_id=c.id OR l.claim_id=c.id) AND e.direction='OUTGOING') last_outgoing_email,COALESCE(c.expected_delivery_date,c.promised_dispatch_date) promised_or_expected_date FROM gc_claims c JOIN vessels v ON v.id=c.vessel_id WHERE 1=1"
        args = []
        if search: sql += " AND (c.gc_number LIKE ? OR v.name LIKE ? OR c.title LIKE ? OR c.equipment_system LIKE ?)"; args += [f"%{search}%"]*4
        if status and status != "All": sql += " AND c.current_status=?"; args.append(status)
        sql += " ORDER BY c.next_follow_up_date IS NULL,c.next_follow_up_date,c.updated_at DESC"
        with connection(self.root) as db: return [dict(r) for r in db.execute(sql,args)]

    def claim(self, claim_id):
        with connection(self.root) as db:
            row = db.execute("SELECT c.*,v.name vessel_name FROM gc_claims c JOIN vessels v ON v.id=c.vessel_id WHERE c.id=?",(claim_id,)).fetchone()
            if not row: raise ValueError("Claim was not found.")
            return dict(row)

    def create_claim(self, vessel_id, gc_number, **fields):
        gc = extract_gc_numbers(gc_number)
        if len(gc) != 1: raise ValueError("Enter exactly one valid GC number, such as GC-014.")
        status = fields.get("current_status", "DRAFT"); waiting = fields.get("waiting_on", "NONE")
        if status not in STATUS or waiting not in WAITING_ON: raise ValueError("Invalid status or Waiting On value.")
        if status=="CLOSED": raise ValueError("Register the claim first, then use the close action with a date and reason.")
        stamp = now()
        allowed = ("title","equipment_system","defect_description","date_reported","date_submitted","current_status","waiting_on","responsible_party_name","next_follow_up_date","promised_dispatch_date","expected_delivery_date","service_attendance_date","rectification_date","closure_date","priority","notes","assigned_to")
        values = {key: fields.get(key, "") if fields.get(key) is not None else "" for key in allowed}
        values["current_status"] = status; values["waiting_on"] = waiting
        _validate_dates(values)
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                cid = db.execute("INSERT INTO gc_claims(vessel_id,gc_number,title,equipment_system,defect_description,date_reported,date_submitted,current_status,waiting_on,responsible_party_name,next_follow_up_date,promised_dispatch_date,expected_delivery_date,service_attendance_date,rectification_date,closure_date,priority,notes,assigned_to,created_at,updated_at,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (vessel_id,gc[0],*(values[k] for k in allowed),stamp,stamp,self.actor,self.actor)).lastrowid
                db.execute("INSERT INTO gc_status_history(claim_id,new_status,new_waiting_on,reason,source,changed_at,changed_by) VALUES(?,?,?,?,?,?,?)",(cid,status,waiting,"Claim registered","MANUAL",stamp,self.actor))
                db.execute("INSERT INTO gc_timeline_events(claim_id,event_type,title,description,event_date,created_at,created_by) VALUES(?,?,?,?,?,?,?)",(cid,"CLAIM_CREATED","Claim registered",f"{gc[0]} registered.",stamp,stamp,self.actor))
                db.execute("INSERT INTO gc_audit_events(claim_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?)",(cid,"claim_created",json.dumps({"vessel_id":vessel_id,"gc_number":gc[0]}),stamp,self.actor))
                db.commit(); return cid
            except Exception: db.rollback(); raise

    def update_claim(self, claim_id, **fields):
        allowed = {"title","equipment_system","defect_description","date_reported","date_submitted","waiting_on","responsible_party_name","next_follow_up_date","promised_dispatch_date","expected_delivery_date","service_attendance_date","rectification_date","priority","notes","assigned_to"}
        updates = {k:v for k,v in fields.items() if k in allowed}
        if not updates: return
        _validate_dates(updates)
        if "waiting_on" in updates and updates["waiting_on"] not in WAITING_ON: raise ValueError("Invalid Waiting On value.")
        stamp=now()
        with connection(self.root) as db, db:
            old = db.execute("SELECT * FROM gc_claims WHERE id=?",(claim_id,)).fetchone()
            if not old: raise ValueError("Claim was not found.")
            sql=", ".join(f"{k}=?" for k in updates)
            db.execute(f"UPDATE gc_claims SET {sql},updated_at=?,updated_by=? WHERE id=?",(*updates.values(),stamp,self.actor,claim_id))
            if "waiting_on" in updates and updates["waiting_on"] != old["waiting_on"]:
                db.execute("INSERT INTO gc_status_history(claim_id,previous_status,new_status,previous_waiting_on,new_waiting_on,reason,source,changed_at,changed_by) VALUES(?,?,?,?,?,?,?,?,?)",(claim_id,old["current_status"],old["current_status"],old["waiting_on"],updates["waiting_on"],"Waiting On updated","MANUAL",stamp,self.actor))
            db.execute("INSERT INTO gc_audit_events(claim_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?)",(claim_id,"claim_updated",json.dumps(updates),stamp,self.actor))

    def set_status(self, claim_id, new_status, reason="", override=False, waiting_on=None):
        if new_status not in STATUS: raise ValueError("Unknown lifecycle status.")
        if new_status=="CLOSED": raise ValueError("Use the close action, which requires a closure date and reason.")
        stamp=now()
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                old=db.execute("SELECT * FROM gc_claims WHERE id=?",(claim_id,)).fetchone()
                if not old: raise ValueError("Claim was not found.")
                if old["current_status"] in {"CLOSED","CANCELLED"}: raise ValueError("Reopen a closed claim explicitly before changing its status.")
                if new_status not in TRANSITIONS[old["current_status"]] and not (override and reason.strip()): raise ValueError("This status transition is not allowed; provide a reason for a manual override.")
                if override and not reason.strip(): raise ValueError("A reason is required for a manual override.")
                waiting=waiting_on or old["waiting_on"]
                if waiting not in WAITING_ON: raise ValueError("Unknown Waiting On value.")
                db.execute("UPDATE gc_claims SET current_status=?,waiting_on=?,updated_at=?,updated_by=? WHERE id=?",(new_status,waiting,stamp,self.actor,claim_id))
                db.execute("INSERT INTO gc_status_history(claim_id,previous_status,new_status,previous_waiting_on,new_waiting_on,reason,source,changed_at,changed_by) VALUES(?,?,?,?,?,?,?,?,?)",(claim_id,old["current_status"],new_status,old["waiting_on"],waiting,reason or "Status updated","MANUAL",stamp,self.actor))
                db.execute("INSERT INTO gc_timeline_events(claim_id,event_type,title,description,event_date,created_at,created_by) VALUES(?,?,?,?,?,?,?)",(claim_id,"STATUS_CHANGED",f"Status: {LABELS[new_status]}",reason,stamp,stamp,self.actor))
                db.execute("INSERT INTO gc_audit_events(claim_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?)",(claim_id,"status_changed",json.dumps({"from":old["current_status"],"to":new_status,"reason":reason}),stamp,self.actor))
                db.commit()
            except Exception: db.rollback(); raise

    def close_claim(self, claim_id, closure_date, reason):
        if not closure_date or not reason.strip(): raise ValueError("Closure date and closure reason are required.")
        _validate_dates({"closure_date":closure_date})
        stamp=now()
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                old=db.execute("SELECT * FROM gc_claims WHERE id=?",(claim_id,)).fetchone()
                if not old:raise ValueError("Claim was not found.")
                if old["current_status"] in {"CLOSED","CANCELLED"}:raise ValueError("Closed or cancelled claims cannot be closed again.")
                db.execute("UPDATE gc_claims SET current_status='CLOSED',closure_date=?,updated_at=?,updated_by=? WHERE id=?",(closure_date,stamp,self.actor,claim_id))
                db.execute("INSERT INTO gc_status_history(claim_id,previous_status,new_status,previous_waiting_on,new_waiting_on,reason,source,changed_at,changed_by) VALUES(?,?,?,?,?,?,?,?,?)",(claim_id,old["current_status"],"CLOSED",old["waiting_on"],old["waiting_on"],reason,"MANUAL",stamp,self.actor))
                db.execute("INSERT INTO gc_timeline_events(claim_id,event_type,title,description,event_date,created_at,created_by) VALUES(?,?,?,?,?,?,?)",(claim_id,"CLAIM_CLOSED","Claim closed",reason,closure_date,stamp,self.actor))
                db.execute("INSERT INTO gc_audit_events(claim_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?)",(claim_id,"claim_closed",json.dumps({"closure_date":closure_date,"reason":reason}),stamp,self.actor));db.commit()
            except Exception:db.rollback();raise

    def reopen_claim(self, claim_id, status, reason):
        if not reason.strip(): raise ValueError("A reopening reason is required.")
        if status not in STATUS or status in {"CLOSED","CANCELLED"}: raise ValueError("Choose an active status to reopen into.")
        stamp=now()
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                old=db.execute("SELECT * FROM gc_claims WHERE id=?",(claim_id,)).fetchone()
                if not old or old["current_status"]!="CLOSED": raise ValueError("Only a closed claim can be reopened.")
                db.execute("UPDATE gc_claims SET current_status=?,closure_date=NULL,reopened_count=reopened_count+1,updated_at=?,updated_by=? WHERE id=?",(status,stamp,self.actor,claim_id))
                db.execute("INSERT INTO gc_status_history(claim_id,previous_status,new_status,previous_waiting_on,new_waiting_on,reason,source,changed_at,changed_by) VALUES(?,?,?,?,?,?,?,?,?)",(claim_id,"CLOSED",status,old["waiting_on"],old["waiting_on"],reason,"REOPENED",stamp,self.actor))
                db.execute("INSERT INTO gc_timeline_events(claim_id,event_type,title,description,event_date,created_at,created_by) VALUES(?,?,?,?,?,?,?)",(claim_id,"REOPENED","Claim reopened",reason,stamp,stamp,self.actor))
                db.execute("INSERT INTO gc_audit_events(claim_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?)",(claim_id,"claim_reopened",json.dumps({"status":status,"reason":reason}),stamp,self.actor));db.commit()
            except Exception: db.rollback(); raise

    def undo_last_manual_status_change(self, claim_id, reason):
        if not reason.strip(): raise ValueError("An undo reason is required.")
        stamp=now()
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                claim=db.execute("SELECT * FROM gc_claims WHERE id=?",(claim_id,)).fetchone()
                latest=db.execute("SELECT * FROM gc_status_history WHERE claim_id=? ORDER BY changed_at DESC,id DESC LIMIT 1",(claim_id,)).fetchone()
                if not claim or not latest: raise ValueError("No status change is available to undo.")
                if latest["source"]!="MANUAL" or not latest["previous_status"]: raise ValueError("The latest status change is not an undoable manual change.")
                if latest["new_status"]=="CLOSED": raise ValueError("Use Reopen for a closed claim; its closure date and reopening history must be preserved.")
                if claim["current_status"]!=latest["new_status"] or claim["waiting_on"]!=latest["new_waiting_on"]: raise ValueError("A later dependent update exists; the status change cannot be safely undone.")
                if claim["updated_at"]>latest["changed_at"]: raise ValueError("The claim was updated after this status change; undo is no longer safe.")
                db.execute("UPDATE gc_claims SET current_status=?,waiting_on=?,updated_at=?,updated_by=? WHERE id=?",(latest["previous_status"],latest["previous_waiting_on"],stamp,self.actor,claim_id))
                db.execute("INSERT INTO gc_status_history(claim_id,previous_status,new_status,previous_waiting_on,new_waiting_on,reason,source,changed_at,changed_by) VALUES(?,?,?,?,?,?,?,?,?)",(claim_id,latest["new_status"],latest["previous_status"],latest["new_waiting_on"],latest["previous_waiting_on"],reason,"MANUAL",stamp,self.actor))
                db.execute("INSERT INTO gc_timeline_events(claim_id,event_type,title,description,event_date,created_at,created_by) VALUES(?,?,?,?,?,?,?)",(claim_id,"STATUS_UNDONE","Status change undone",reason,stamp,stamp,self.actor))
                db.execute("INSERT INTO gc_audit_events(claim_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?)",(claim_id,"status_undone",json.dumps({"restored_status":latest["previous_status"],"reason":reason}),stamp,self.actor));db.commit()
            except Exception:db.rollback();raise

    def import_message(self, message):
        """Idempotently import Outlook/fixture evidence, always matching from subject alone."""
        subject=str(message.get("subject") or "").strip()
        numbers=extract_gc_numbers(subject)
        if not numbers: return {"ignored":True,"reason":"No GC number in subject."}
        immutable=message.get("graph_immutable_id") or message.get("id")
        internet=message.get("internet_message_id")
        stable=immutable or internet or message.get("graph_message_id") or ""
        folder=str(message.get("mailbox_folder") or message.get("folder") or "Inbox")
        direction="OUTGOING" if folder.casefold() in {"sent items","sent","outbox"} else str(message.get("direction") or "INCOMING").upper()
        dedupe="id:"+str(stable) if stable else "sha:"+__import__("hashlib").sha256((folder+"\0"+subject+"\0"+str(message.get("message_datetime") or "")+"\0"+str(message.get("sender_address") or "")).encode()).hexdigest()
        stamp=now()
        with connection(self.root) as db:
            prior=db.execute("SELECT id,claim_id FROM gc_emails WHERE dedupe_key=?",(dedupe,)).fetchone()
            if prior: return {"duplicate":True,"email_id":prior["id"],"claim_id":prior["claim_id"]}
            settings={r["key"]:json.loads(r["value"]) for r in db.execute("SELECT key,value FROM gc_settings")}
            match=identify_vessel(subject,[dict(r) for r in db.execute("SELECT v.id,v.name FROM vessels v LEFT JOIN gc_vessel_details d ON d.vessel_id=v.id WHERE COALESCE(d.active,1)=1 ORDER BY v.name")],auto_threshold=settings.get("vessel_auto_match_threshold"),review_threshold=settings.get("vessel_review_threshold"),margin=settings.get("vessel_match_margin"))
            review_type=None; claim_id=None; suggested=None
            if match.match_type in {"EXACT","NORMALISED_EXACT","SAFE_FUZZY"}: suggested=match.vessel_id
            if len(numbers)>1: review_type="MULTIPLE_GC_NUMBERS"; reason="Subject contains multiple GC numbers; choose the applicable claim(s)."
            elif match.match_type=="AMBIGUOUS": review_type="AMBIGUOUS_VESSEL"; reason=match.reason
            elif match.match_type=="NO_MATCH": review_type="UNMATCHED_GC_EMAIL"; reason=match.reason
            else:
                claim=db.execute("SELECT id FROM gc_claims WHERE vessel_id=? AND gc_number=?",(match.vessel_id,numbers[0])).fetchone()
                if claim: claim_id=claim[0]
                else: review_type="NEW_GC"; reason=f"New claim candidate: {match.canonical_vessel_name} / {numbers[0]}. Register after review."
            body=safe_body(message.get("body") or message.get("body_preview") or "")
            values=(claim_id,immutable,message.get("graph_message_id"),internet,message.get("conversation_id"),folder,direction,subject,json.dumps(numbers),match.detected_text,suggested,match.match_type,match.similarity_score,str(message.get("sender_name") or ""),str(message.get("sender_address") or ""),json.dumps(message.get("recipients") or []),str(message.get("message_datetime") or ""),body[:500],body,int(bool(message.get("has_attachments"))),stamp,json.dumps({"source":message.get("source","fixture")},ensure_ascii=False),dedupe)
            db.execute("BEGIN IMMEDIATE")
            try:
                eid=db.execute("INSERT INTO gc_emails(claim_id,graph_immutable_id,graph_message_id,internet_message_id,conversation_id,mailbox_folder,direction,subject,detected_gc_numbers_json,detected_vessel_text,matched_vessel_id,vessel_match_type,vessel_match_score,sender_name,sender_address,recipients_json,message_datetime,body_preview,sanitised_body,has_attachments,imported_at,raw_metadata_json,dedupe_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",values).lastrowid
                if claim_id:
                    email_title={"INCOMING":"Incoming email","OUTGOING":"Outgoing email"}.get(direction,"Email")
                    db.execute("INSERT INTO gc_timeline_events(claim_id,event_type,title,description,event_date,email_id,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)",(claim_id,"EMAIL",email_title,subject,str(message.get("message_datetime") or stamp),eid,stamp,self.actor))
                    db.execute("INSERT INTO gc_audit_events(claim_id,email_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?,?)",(claim_id,eid,"email_linked",json.dumps({"vessel_match":match.match_type}),stamp,self.actor))
                if review_type:
                    db.execute("INSERT INTO gc_review_queue(email_id,review_type,suggested_vessel_id,reason,created_at) VALUES(?,?,?,?,?)",(eid,review_type,suggested,reason,stamp))
                db.commit()
            except Exception: db.rollback(); raise
        return {"email_id":eid,"claim_id":claim_id,"review_type":review_type,"vessel_match":match.match_type,"gc_numbers":numbers}

    def reviews(self, open_only=True):
        sql="SELECT q.*,e.subject,e.direction,e.body_preview,e.detected_gc_numbers_json,e.matched_vessel_id,v.name suggested_vessel FROM gc_review_queue q JOIN gc_emails e ON e.id=q.email_id LEFT JOIN vessels v ON v.id=q.suggested_vessel_id"
        if open_only: sql+=" WHERE q.status='OPEN'"
        sql+=" ORDER BY q.created_at"
        with connection(self.root) as db:return [dict(r) for r in db.execute(sql)]

    def matching_new_gc_review_count(self, review_id):
        """Count sibling NEW_GC reviews independently matched to the same vessel + GC."""
        safe_matches={"EXACT","NORMALISED_EXACT","SAFE_FUZZY"}
        with connection(self.root) as db:
            row=db.execute("SELECT q.status,q.review_type,q.suggested_vessel_id,e.detected_gc_numbers_json FROM gc_review_queue q JOIN gc_emails e ON e.id=q.email_id WHERE q.id=?",(review_id,)).fetchone()
            if not row or row["status"]!="OPEN" or row["review_type"]!="NEW_GC" or not row["suggested_vessel_id"]: return 0
            numbers=json.loads(row["detected_gc_numbers_json"])
            if len(numbers)!=1: return 0
            siblings=db.execute("SELECT q.id,e.detected_gc_numbers_json,e.vessel_match_type FROM gc_review_queue q JOIN gc_emails e ON e.id=q.email_id WHERE q.status='OPEN' AND q.review_type='NEW_GC' AND q.suggested_vessel_id=? AND q.id<>?",(row["suggested_vessel_id"],review_id)).fetchall()
            return sum(1 for sibling in siblings if sibling["vessel_match_type"] in safe_matches and json.loads(sibling["detected_gc_numbers_json"])==numbers)

    def resolve_review(self, review_id, action, notes="", vessel_id=None, claim_id=None, register=False, link_matching=False):
        if action not in {"link","irrelevant","resolve"}: raise ValueError("Choose link, irrelevant, or resolve.")
        stamp=now()
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row=db.execute("SELECT q.*,e.* FROM gc_review_queue q JOIN gc_emails e ON e.id=q.email_id WHERE q.id=?",(review_id,)).fetchone()
                if not row: raise ValueError("Review item was not found.")
                if row["status"]!="OPEN": db.commit(); return False
                linked=claim_id
                linked_count=0
                if action=="link":
                    if register:
                        if vessel_id is None: raise ValueError("Choose a vessel before registering the claim.")
                        nums=json.loads(row["detected_gc_numbers_json"])
                        if len(nums)!=1: raise ValueError("Resolve multiple GC numbers one at a time.")
                        linked=db.execute("SELECT id FROM gc_claims WHERE vessel_id=? AND gc_number=?",(vessel_id,nums[0])).fetchone()
                        if linked: linked=linked[0]
                        else:
                            linked=db.execute("INSERT INTO gc_claims(vessel_id,gc_number,title,current_status,waiting_on,created_at,updated_at,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?)",(vessel_id,nums[0],"","DRAFT","NONE",stamp,stamp,self.actor,self.actor)).lastrowid
                            db.execute("INSERT INTO gc_status_history(claim_id,new_status,new_waiting_on,reason,source,changed_at,changed_by) VALUES(?,?,?,?,?,?,?)",(linked,"DRAFT","NONE","Registered from Outlook review","MANUAL",stamp,self.actor))
                            db.execute("INSERT INTO gc_timeline_events(claim_id,event_type,title,description,event_date,created_at,created_by) VALUES(?,?,?,?,?,?,?)",(linked,"CLAIM_CREATED","Claim registered","Registered after Outlook review.",stamp,stamp,self.actor))
                            db.execute("INSERT INTO gc_audit_events(claim_id,email_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?,?)",(linked,row["email_id"],"claim_created_from_review",json.dumps({"review_id":review_id,"vessel_id":vessel_id,"gc_number":nums[0]}),stamp,self.actor))
                    if not linked: raise ValueError("Choose a claim or register a new one.")
                    claim=db.execute("SELECT vessel_id,gc_number FROM gc_claims WHERE id=?",(linked,)).fetchone()
                    if not claim: raise ValueError("Selected claim was not found.")
                    if vessel_id and int(vessel_id)!=claim["vessel_id"]: raise ValueError("Selected claim belongs to a different vessel.")
                    numbers=json.loads(row["detected_gc_numbers_json"])
                    if len(numbers)==1 and claim["gc_number"]!=numbers[0] and not notes.strip(): raise ValueError("A resolution reason is required to link this email to a different GC number.")
                    db.execute("UPDATE gc_emails SET claim_id=?,matched_vessel_id=?,reviewed_at=? WHERE id=?",(linked,claim["vessel_id"],stamp,row["email_id"]))
                    db.execute("INSERT OR IGNORE INTO gc_timeline_events(claim_id,event_type,title,description,event_date,email_id,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)",(linked,"EMAIL",row["subject"],row["subject"],row["message_datetime"] or stamp,row["email_id"],stamp,self.actor))
                    db.execute("INSERT INTO gc_audit_events(claim_id,email_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?,?)",(linked,row["email_id"],"review_linked",json.dumps({"review_id":review_id,"reason":notes}),stamp,self.actor))
                    linked_count=1
                    numbers=json.loads(row["detected_gc_numbers_json"])
                    if (link_matching and row["review_type"]=="NEW_GC" and len(numbers)==1
                            and claim["vessel_id"]==row["suggested_vessel_id"] and claim["gc_number"]==numbers[0]
                            and row["vessel_match_type"] in {"EXACT","NORMALISED_EXACT","SAFE_FUZZY"}):
                        siblings=db.execute("SELECT q.id review_id,q.email_id,e.subject,e.message_datetime,e.detected_gc_numbers_json,e.vessel_match_type FROM gc_review_queue q JOIN gc_emails e ON e.id=q.email_id WHERE q.status='OPEN' AND q.review_type='NEW_GC' AND q.suggested_vessel_id=? AND q.id<>?",(claim["vessel_id"],review_id)).fetchall()
                        for sibling in siblings:
                            if (sibling["vessel_match_type"] not in {"EXACT","NORMALISED_EXACT","SAFE_FUZZY"}
                                    or json.loads(sibling["detected_gc_numbers_json"])!=numbers): continue
                            db.execute("UPDATE gc_emails SET claim_id=?,matched_vessel_id=?,reviewed_at=? WHERE id=?",(linked,claim["vessel_id"],stamp,sibling["email_id"]))
                            db.execute("INSERT OR IGNORE INTO gc_timeline_events(claim_id,event_type,title,description,event_date,email_id,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)",(linked,"EMAIL",sibling["subject"],sibling["subject"],sibling["message_datetime"] or stamp,sibling["email_id"],stamp,self.actor))
                            db.execute("INSERT INTO gc_audit_events(claim_id,email_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?,?)",(linked,sibling["email_id"],"review_linked_same_compound_key",json.dumps({"review_id":sibling["review_id"],"registered_from_review_id":review_id,"reason":"Independently matched subject has the same canonical vessel and GC number."}),stamp,self.actor))
                            db.execute("UPDATE gc_review_queue SET status='RESOLVED',resolution_notes=?,reviewed_at=?,reviewed_by=?,suggested_claim_id=? WHERE id=?",("Linked after confirmation of matching vessel + GC claim.",stamp,self.actor,linked,sibling["review_id"]))
                            linked_count+=1
                else:
                    db.execute("INSERT INTO gc_audit_events(email_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?)",(row["email_id"],"review_irrelevant" if action=="irrelevant" else "review_resolved",json.dumps({"review_id":review_id,"reason":notes}),stamp,self.actor))
                db.execute("UPDATE gc_review_queue SET status=?,resolution_notes=?,reviewed_at=?,reviewed_by=?,suggested_claim_id=? WHERE id=?",("IRRELEVANT" if action=="irrelevant" else "RESOLVED",notes,stamp,self.actor,linked,review_id)); db.commit(); return linked_count or True
            except Exception: db.rollback(); raise

    def resolve_multiple_gc_review(self, review_id, claim_ids, notes):
        """Explicitly associate one multiple-GC message with several independently chosen claims."""
        claim_ids=list(dict.fromkeys(int(cid) for cid in claim_ids))
        if len(claim_ids)<2: raise ValueError("Select at least two claims for a multiple-GC email.")
        if not notes.strip(): raise ValueError("Explain why this email applies to multiple claims.")
        stamp=now()
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                row=db.execute("SELECT q.id review_id,q.email_id,q.review_type,q.status,e.subject,e.detected_gc_numbers_json,e.message_datetime,e.claim_id FROM gc_review_queue q JOIN gc_emails e ON e.id=q.email_id WHERE q.id=?",(review_id,)).fetchone()
                if not row or row["review_type"]!="MULTIPLE_GC_NUMBERS": raise ValueError("This is not a multiple-GC review item.")
                if row["status"]!="OPEN": db.commit(); return False
                numbers=json.loads(row["detected_gc_numbers_json"])
                selected=db.execute("SELECT id,vessel_id,gc_number FROM gc_claims WHERE id IN (%s)" % ",".join("?"*len(claim_ids)),claim_ids).fetchall()
                if len(selected)!=len(claim_ids): raise ValueError("One or more selected claims do not exist.")
                if not all(c["gc_number"] in numbers for c in selected): raise ValueError("Each selected claim's GC number must appear in the original subject.")
                for claim in selected:
                    db.execute("INSERT OR IGNORE INTO gc_email_claim_links(email_id,claim_id,linked_at,linked_by) VALUES(?,?,?,?)",(row["email_id"],claim["id"],stamp,self.actor))
                    db.execute("INSERT INTO gc_timeline_events(claim_id,event_type,title,description,event_date,email_id,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)",(claim["id"],"EMAIL",row["subject"],notes,row["message_datetime"] or stamp,row["email_id"],stamp,self.actor))
                    db.execute("INSERT INTO gc_audit_events(claim_id,email_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?,?)",(claim["id"],row["email_id"],"multiple_gc_email_linked",json.dumps({"review_id":review_id,"reason":notes,"claims":claim_ids}),stamp,self.actor))
                db.execute("UPDATE gc_emails SET claim_id=?,reviewed_at=? WHERE id=?",(claim_ids[0],stamp,row["email_id"]))
                db.execute("UPDATE gc_review_queue SET status='RESOLVED',resolution_notes=?,reviewed_at=?,reviewed_by=? WHERE id=?",(notes,stamp,self.actor,review_id)); db.commit(); return True
            except Exception:db.rollback();raise

    def reassign_email(self, email_id, new_claim_id, reason, expected_old_claim_id):
        """Explicit manual correction for an already linked email; creates a full audit trail."""
        if not reason.strip(): raise ValueError("A reassignment reason is required.")
        stamp=now()
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                email=db.execute("SELECT * FROM gc_emails WHERE id=?",(email_id,)).fetchone()
                target=db.execute("SELECT * FROM gc_claims WHERE id=?",(new_claim_id,)).fetchone()
                if not email or not target: raise ValueError("Email or target claim was not found.")
                if email["claim_id"]!=expected_old_claim_id: raise ValueError("The email's current claim changed; refresh and review before reassignment.")
                if email_id and db.execute("SELECT 1 FROM gc_email_claim_links WHERE email_id=?",(email_id,)).fetchone(): raise ValueError("A multi-claim email cannot be reassigned as a single claim.")
                old=expected_old_claim_id
                db.execute("UPDATE gc_emails SET claim_id=?,matched_vessel_id=?,reviewed_at=? WHERE id=?",(new_claim_id,target["vessel_id"],stamp,email_id))
                if old:
                    db.execute("INSERT INTO gc_timeline_events(claim_id,event_type,title,description,event_date,email_id,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)",(old,"EMAIL_REASSIGNED","Email reassigned away",f"Moved to claim {target['gc_number']} / vessel {target['vessel_id']}. Reason: {reason}",stamp,email_id,stamp,self.actor))
                    db.execute("INSERT INTO gc_audit_events(claim_id,email_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?,?)",(old,email_id,"email_reassigned_from",json.dumps({"old_claim_id":old,"new_claim_id":new_claim_id,"reason":reason}),stamp,self.actor))
                db.execute("INSERT INTO gc_timeline_events(claim_id,event_type,title,description,event_date,email_id,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)",(new_claim_id,"EMAIL_REASSIGNED","Email reassigned here",f"Moved from claim {old}. Reason: {reason}",stamp,email_id,stamp,self.actor))
                db.execute("INSERT INTO gc_audit_events(claim_id,email_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?,?)",(new_claim_id,email_id,"email_reassigned_to",json.dumps({"old_claim_id":old,"new_claim_id":new_claim_id,"reason":reason}),stamp,self.actor))
                db.commit();return True
            except Exception:db.rollback();raise

    def emails(self, claim_id):
        with connection(self.root) as db:return [dict(r) for r in db.execute("SELECT DISTINCT e.* FROM gc_emails e LEFT JOIN gc_email_claim_links l ON l.email_id=e.id WHERE e.claim_id=? OR l.claim_id=? ORDER BY e.message_datetime,e.id",(claim_id,claim_id))]
    def timeline(self, claim_id):
        with connection(self.root) as db:return [dict(r) for r in db.execute("SELECT * FROM gc_timeline_events WHERE claim_id=? ORDER BY event_date,id",(claim_id,))]
    def history(self, claim_id):
        with connection(self.root) as db:return [dict(r) for r in db.execute("SELECT * FROM gc_status_history WHERE claim_id=? ORDER BY changed_at,id",(claim_id,))]
    def mark_reviewed(self, email_id):
        stamp=now()
        with connection(self.root) as db:
            db.execute("BEGIN IMMEDIATE")
            row=db.execute("SELECT claim_id FROM gc_emails WHERE id=?",(email_id,)).fetchone()
            if not row: raise ValueError("Email was not found.")
            db.execute("UPDATE gc_emails SET reviewed_at=? WHERE id=?",(stamp,email_id))
            db.execute("INSERT INTO gc_audit_events(claim_id,email_id,action,details_json,created_at,created_by) VALUES(?,?,?,?,?,?)",(row["claim_id"],email_id,"email_reviewed","{}",stamp,self.actor));db.commit()
    def settings(self):
        with connection(self.root) as db: values={r["key"]:json.loads(r["value"]) for r in db.execute("SELECT key,value FROM gc_settings")}
        values["graph_enabled"]=os.getenv("GC_GRAPH_ENABLED",str(values.get("graph_enabled",False))).lower()=="true"
        values["graph_configured"]=bool(os.getenv("AZURE_CLIENT_ID") and os.getenv("AZURE_TENANT_ID"))
        if "GC_LOCAL_USER_NAME" in os.environ:
            values["local_user_name"]=os.getenv("GC_LOCAL_USER_NAME","").strip() or None
        values["vessel_auto_match_threshold"]=int(os.getenv("GC_VESSEL_AUTO_MATCH_THRESHOLD",values.get("vessel_auto_match_threshold",90)))
        values["vessel_review_threshold"]=int(os.getenv("GC_VESSEL_REVIEW_THRESHOLD",values.get("vessel_review_threshold",80)))
        values["vessel_match_margin"]=int(os.getenv("GC_VESSEL_MATCH_MARGIN",values.get("vessel_match_margin",8)))
        values["graph_sync_interval_minutes"]=int(os.getenv("GC_GRAPH_SYNC_INTERVAL_MINUTES",values.get("graph_sync_interval_minutes",5)))
        return values
    def save_settings(self, values):
        allowed=set(DEFAULTS)
        for k,v in values.items():
            if k not in allowed: continue
            with connection(self.root) as db, db: db.execute("INSERT INTO gc_settings VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",(k,json.dumps(v),now()))
    def sync_status(self):
        with connection(self.root) as db:return [dict(r) for r in db.execute("SELECT folder_name,last_attempt_at,last_success_at,last_error,items_processed FROM gc_outlook_sync_state ORDER BY folder_name")]
    def delta_state(self, folder):
        with connection(self.root) as db:
            row=db.execute("SELECT * FROM gc_outlook_sync_state WHERE folder_name=?",(folder,)).fetchone()
            return dict(row) if row else {"folder_name":folder,"delta_link":None}
    def save_delta_state(self, folder, delta_link, count=0, error=None, attempted=True):
        stamp=now()
        with connection(self.root) as db, db:
            db.execute("INSERT INTO gc_outlook_sync_state(folder_name,delta_link,last_attempt_at,last_success_at,last_error,items_processed,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(folder_name) DO UPDATE SET delta_link=COALESCE(excluded.delta_link,gc_outlook_sync_state.delta_link),last_attempt_at=excluded.last_attempt_at,last_success_at=CASE WHEN excluded.last_error IS NULL THEN excluded.last_success_at ELSE gc_outlook_sync_state.last_success_at END,last_error=excluded.last_error,items_processed=gc_outlook_sync_state.items_processed+excluded.items_processed,updated_at=excluded.updated_at",(folder,delta_link,stamp,stamp if error is None else None,error,count,stamp))
    def sync_attempt(self, error=None):
        stamp=now()
        with connection(self.root) as db, db:
            db.execute("INSERT INTO gc_outlook_sync_state(folder_name,last_attempt_at,last_error,updated_at) VALUES('sync',?,?,?) ON CONFLICT(folder_name) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_error=excluded.last_error,updated_at=excluded.updated_at",(stamp,error,stamp))
    def dashboard(self, today=None):
        from .attention import calculate_attention
        claims=self.claims(); today=today or date.today().isoformat(); result={"total":len(claims),"open":0,"follow_up_due":0,"overdue":0,"no_response":0,"awaiting_supply":0,"in_transit":0,"awaiting_verification":0,"closure_pending":0,"closed":0,"guarantee_expiry_risks":0}
        for c in claims:
            flags=calculate_attention(c,self.emails(c["id"]),self.vessel(c["vessel_id"]),self.settings(),today)
            c["attention"]=flags
            if c["current_status"]=="CLOSED": result["closed"]+=1
            elif c["current_status"]!="CANCELLED": result["open"]+=1
            if "FOLLOW_UP_DUE" in flags: result["follow_up_due"]+=1
            if "OVERDUE" in flags: result["overdue"]+=1
            if "NO_RESPONSE" in flags: result["no_response"]+=1
            if c["current_status"]=="AWAITING_SUPPLY": result["awaiting_supply"]+=1
            if c["current_status"]=="IN_TRANSIT": result["in_transit"]+=1
            if c["current_status"]=="AWAITING_VERIFICATION": result["awaiting_verification"]+=1
            if "CLOSURE_PENDING" in flags: result["closure_pending"]+=1
            if "GUARANTEE_EXPIRY_RISK" in flags: result["guarantee_expiry_risks"]+=1
        return result
    def vessel(self,vessel_id):
        return next((v for v in self.vessels(False) if v["id"]==vessel_id),{})
    def attention(self):
        from .attention import calculate_attention
        today=date.today().isoformat(); result=[]
        for c in self.claims():
            flags=calculate_attention(c,self.emails(c["id"]),self.vessel(c["vessel_id"]),self.settings(),today)
            if flags: c["attention"]=flags; result.append(c)
        return sorted(result,key=lambda x:("OVERDUE" not in x["attention"], x.get("next_follow_up_date") or "9999",x["gc_number"]))

