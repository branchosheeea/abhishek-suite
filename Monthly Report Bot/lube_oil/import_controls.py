"""Durable import attempts and reviewed lifecycle transitions, using the Suite database."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import uuid
from .import_policy import blockers, legacy_state, valid_month
from .parser import VERSION, parse_workbook, apply_effective_period
from suite_services.actor import current_actor
from suite_services.database import connection
from suite_services.storage import archive_file

def stamp():
    return datetime.now(timezone.utc).isoformat()

@contextmanager
def import_lock(root):
    """Kernel releases this lock after a crash; never mistake another live importer for abandoned work."""
    path = Path(root) / 'lube-import.lock'
    with path.open('a+b') as handle:
        handle.seek(0,2)
        if handle.tell() == 0:
            handle.write(b'0'); handle.flush()
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)

def migrate(db):
    rows = [dict(r) for r in db.execute('SELECT * FROM monthly_reports')]
    audits = [dict(r) for r in db.execute('SELECT * FROM audit_events ORDER BY id')]
    replaced = {r['supersedes_report_id'] for r in rows if r['supersedes_report_id']}
    states = {r['id']: legacy_state(r,audits,replaced) for r in rows}
    db.execute("ALTER TABLE monthly_reports ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'NEEDS_REVIEW' CHECK(lifecycle_state IN ('NEEDS_REVIEW','IN_USE','SUPERSEDED','REJECTED'))")
    db.execute('ALTER TABLE monthly_reports ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
    db.execute('ALTER TABLE audit_events ADD COLUMN details_json TEXT')
    for rid,state in states.items():
        db.execute('UPDATE monthly_reports SET lifecycle_state=? WHERE id=?',(state,rid))
    for action in ('INSERT','UPDATE'):
        db.execute(f"""CREATE TRIGGER lube_lifecycle_{action.lower()} BEFORE {action} ON monthly_reports
            WHEN NEW.is_active != CASE WHEN NEW.lifecycle_state='IN_USE' THEN 1 ELSE 0 END
            OR (NEW.lifecycle_state='IN_USE' AND (NEW.vessel_id IS NULL OR NEW.month IS NULL))
            BEGIN SELECT RAISE(ABORT,'Report lifecycle and analytics eligibility disagree'); END""")
    db.execute('ALTER TABLE source_occurrences RENAME TO source_occurrences_legacy')
    db.execute("""CREATE TABLE source_occurrences(
        id INTEGER PRIMARY KEY, file_id INTEGER REFERENCES report_files(id), source_path TEXT NOT NULL,
        seen_at TEXT NOT NULL, outcome TEXT CHECK(outcome IS NULL OR outcome IN ('IMPORTED','UNCHANGED_DUPLICATE','FAILED','INTERRUPTED')),
        submitted_filename TEXT, channel TEXT, batch_id TEXT, report_id INTEGER REFERENCES monthly_reports(id),
        source_hash TEXT, completed_at TEXT, error TEXT, retry_of INTEGER REFERENCES source_occurrences(id),
        lifecycle_at_completion TEXT, detail TEXT, legacy_outcome TEXT)""")
    db.execute("""INSERT INTO source_occurrences(id,file_id,source_path,seen_at,outcome,submitted_filename,channel,report_id,source_hash,completed_at,legacy_outcome)
        SELECT s.id,s.file_id,s.source_path,s.seen_at,
        CASE lower(s.outcome) WHEN 'duplicate' THEN 'UNCHANGED_DUPLICATE' WHEN 'failed' THEN 'FAILED'
        WHEN 'imported' THEN 'IMPORTED' WHEN 'not usable' THEN 'IMPORTED' ELSE 'INTERRUPTED' END,
        f.filename,'legacy',r.id,f.sha256,s.seen_at,s.outcome
        FROM source_occurrences_legacy s JOIN report_files f ON f.id=s.file_id LEFT JOIN monthly_reports r ON r.file_id=f.id""")
    db.execute('DROP TABLE source_occurrences_legacy')
    db.execute('''CREATE TABLE lube_parse_snapshots(id INTEGER PRIMARY KEY,
        report_id INTEGER NOT NULL REFERENCES monthly_reports(id), file_id INTEGER NOT NULL REFERENCES report_files(id),
        parser_version TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)''')
    db.execute('''CREATE TABLE lube_review_exceptions(id INTEGER PRIMARY KEY, report_id INTEGER NOT NULL REFERENCES monthly_reports(id),
        snapshot_id INTEGER REFERENCES lube_parse_snapshots(id), reason TEXT NOT NULL, created_at TEXT NOT NULL,
        resolved_at TEXT)''')
    for r in rows:
        data=json.loads(r['payload'])
        db.execute('INSERT INTO lube_parse_snapshots(report_id,file_id,parser_version,created_at,payload) VALUES(?,?,?,?,?)',
            (r['id'],r['file_id'],data.get('parser_version','legacy'),stamp(),r['payload']))
        if r['is_active'] and blockers(data,r['vessel_id'],r['month']):
            db.execute('INSERT INTO lube_review_exceptions(report_id,reason,created_at) VALUES(?,?,?)',
                (r['id'],'Historical validation conflict; eligibility preserved pending explicit approval',stamp()))
    for action in ('UPDATE','DELETE'):
        db.execute(f"CREATE TRIGGER lube_snapshot_{action.lower()} BEFORE {action} ON lube_parse_snapshots BEGIN SELECT RAISE(ABORT,'Parse snapshots are immutable'); END")

class ImportControls:
    def recover_interrupted(self):
        with import_lock(self.root), connection(self.root) as db, db:
            return db.execute("UPDATE source_occurrences SET outcome='INTERRUPTED',completed_at=?,error='Import owner stopped before a final commit' WHERE outcome IS NULL",(stamp(),)).rowcount

    def import_file(self,path,*,channel='file',batch_id=None,source_name=None):
        with import_lock(self.root):
            return self._import_locked(path,channel,batch_id,source_name)

    def _import_locked(self,path,channel,batch_id,source_name=None):
        path=Path(path); filename=source_name or path.name
        with connection(self.root) as db, db:
            db.execute("UPDATE source_occurrences SET outcome='INTERRUPTED',completed_at=?,error='Import owner stopped before a final commit' WHERE outcome IS NULL",(stamp(),))
            previous=db.execute("SELECT id FROM source_occurrences WHERE source_path=? AND outcome IN ('FAILED','INTERRUPTED') ORDER BY id DESC LIMIT 1",(str(path),)).fetchone()
            attempt=db.execute('INSERT INTO source_occurrences(source_path,seen_at,submitted_filename,channel,batch_id,retry_of) VALUES(?,?,?,?,?,?)',
                (str(path),stamp(),filename,channel,batch_id,previous[0] if previous else None)).lastrowid
        try:
            sha,archived=archive_file(path,self.root)
            with connection(self.root) as db:
                db.execute('BEGIN IMMEDIATE')
                existing=db.execute('SELECT id FROM report_files WHERE sha256=?',(sha,)).fetchone()
                fid=existing[0] if existing else db.execute('INSERT INTO report_files(sha256,filename,archive_path,imported_at) VALUES(?,?,?,?)',(sha,filename,str(archived.relative_to(self.root)),stamp())).lastrowid
                prior=db.execute('SELECT id FROM source_occurrences WHERE source_hash=? AND outcome IN (\'FAILED\',\'INTERRUPTED\') AND id<>? ORDER BY id DESC LIMIT 1',(sha,attempt)).fetchone()
                db.execute('UPDATE source_occurrences SET file_id=?,source_hash=?,retry_of=COALESCE(retry_of,?) WHERE id=?',(fid,sha,prior[0] if prior else None,attempt))
                report=db.execute('SELECT * FROM monthly_reports WHERE file_id=?',(fid,)).fetchone()
                if report:
                    outcome='UNCHANGED_DUPLICATE'; detail='Unchanged duplicate — no saved workbook changes detected.'
                else:
                    status,detail=self._process(db,fid,archived,filename)
                    outcome='FAILED' if status=='Failed' else 'IMPORTED'
                    if existing: detail += ' · read again after an earlier failed import'
                    db.execute('INSERT INTO processing_runs(file_id,parser_version,state,error,processed_at) VALUES(?,?,?,?,?)',(fid,VERSION,status,detail if outcome=='FAILED' else None,stamp()))
                    report=db.execute('SELECT * FROM monthly_reports WHERE file_id=?',(fid,)).fetchone()
                lifecycle=report['lifecycle_state'] if report else None
                rid=report['id'] if report else None
                db.execute('UPDATE source_occurrences SET outcome=?,report_id=?,completed_at=?,error=?,lifecycle_at_completion=?,detail=? WHERE id=?',
                    (outcome,rid,stamp(),detail if outcome=='FAILED' else None,lifecycle,detail,attempt))
                db.commit()
            return self._receipt_result(attempt)
        except Exception as error:
            try:
                with connection(self.root) as db,db:
                    db.execute("UPDATE source_occurrences SET outcome='FAILED',completed_at=?,error=?,detail=? WHERE id=? AND outcome IS NULL",(stamp(),str(error),str(error),attempt))
            except Exception:
                with (self.root/'lube-import-errors.log').open('a',encoding='utf-8') as log:
                    log.write(f'{stamp()} attempt {attempt}: {error}\n')
                raise
            return self._receipt_result(attempt)

    def _receipt_result(self,attempt):
        with connection(self.root) as db:
            row=dict(db.execute('''SELECT s.*,r.month,r.lifecycle_state,v.name AS vessel FROM source_occurrences s
                LEFT JOIN monthly_reports r ON r.id=s.report_id LEFT JOIN vessels v ON v.id=r.vessel_id WHERE s.id=?''',(attempt,)).fetchone())
        row.update(filename=row['submitted_filename'],status={'IMPORTED':'Imported','UNCHANGED_DUPLICATE':'Duplicate','FAILED':'Failed','INTERRUPTED':'Interrupted'}.get(row['outcome'],'Processing'),attempt_id=row['id'])
        return row

    def receipts(self,limit=200):
        with connection(self.root) as db:
            ids=[r[0] for r in db.execute('SELECT id FROM source_occurrences ORDER BY id DESC LIMIT ?',(limit,))]
        return [self._receipt_result(i) for i in ids]

    def import_paths(self,paths,emit=lambda result:None,stop=None,*,channel='file',progress=None):
        paths=sorted(set(map(Path,paths))); results=[]; batch=uuid.uuid4().hex
        with import_lock(self.root):
            for n,path in enumerate(paths,1):
                if stop and stop.is_set(): break
                if progress: progress(dict(filename=path.name,index=n,total=len(paths),stage='Archiving and validating'))
                result=self._import_locked(path,channel,batch)
                results.append(result); emit(result)
        return results

    def retry_failed_imports(self):
        with connection(self.root) as db:
            rows=db.execute("""SELECT f.* FROM report_files f JOIN processing_runs p ON p.id=(SELECT MAX(q.id) FROM processing_runs q WHERE q.file_id=f.id)
                WHERE p.state='Failed' AND p.parser_version<>? AND NOT EXISTS(SELECT 1 FROM monthly_reports r WHERE r.file_id=f.id)""",(VERSION,)).fetchall()
        return [self.import_file(self.root/r['archive_path'],channel='retry',source_name=r['filename']) for r in rows]

    def activate_imported(self):
        # All automatic acceptance occurs in the import transaction. Never activate historical held records on startup.
        return 0

    def _activate(self,db,report_id,vessel_id,month):
        db.execute("UPDATE monthly_reports SET lifecycle_state='IN_USE',is_active=1,confirmed_at=?,revision=revision+1 WHERE id=?",(stamp(),report_id))
        self._audit(db,report_id,'activated','Validated submission in use for analysis.')

    def failures(self):
        with connection(self.root) as db:
            return [dict(r) for r in db.execute("""SELECT submitted_filename AS filename,error,seen_at AS processed_at FROM source_occurrences s
                WHERE outcome IN ('FAILED','INTERRUPTED') AND id=(SELECT MAX(t.id) FROM source_occurrences t WHERE t.source_path=s.source_path)
                AND NOT EXISTS(SELECT 1 FROM monthly_reports r WHERE r.file_id=s.file_id) ORDER BY id DESC""")]

    def review_exceptions(self):
        with connection(self.root) as db:
            return [dict(r) for r in db.execute('SELECT * FROM lube_review_exceptions WHERE resolved_at IS NULL ORDER BY id')]

    def reprocess_stale_reports(self,report_ids=()):
        count=0
        for report in self.reports():
            with connection(self.root) as db:
                last=db.execute('SELECT parser_version FROM lube_parse_snapshots WHERE report_id=? ORDER BY id DESC LIMIT 1',(report['id'],)).fetchone()
            if last and last[0]==VERSION and report['id'] not in report_ids: continue
            try:
                parsed=parse_workbook(self.root/report['archive_path'],report['filename'])
            except Exception as error:
                with connection(self.root) as db,db:
                    db.execute('INSERT INTO lube_review_exceptions(report_id,reason,created_at) VALUES(?,?,?)',(report['id'],f'Parser failed; accepted data preserved: {error}',stamp()))
                continue
            with connection(self.root) as db,db:
                sid=db.execute('INSERT INTO lube_parse_snapshots(report_id,file_id,parser_version,created_at,payload) VALUES(?,?,?,?,?)',(report['id'],report['file_id'],VERSION,stamp(),json.dumps(parsed))).lastrowid
                if parsed != report['data']:
                    db.execute('INSERT INTO lube_review_exceptions(report_id,snapshot_id,reason,created_at) VALUES(?,?,?,?)',(report['id'],sid,'New parser interpretation requires review; existing state and effective data preserved',stamp()))
                self._audit(db,report['id'],'parser_candidate','New parse retained without changing approved data or lifecycle.')
            count+=1
        return count

    def review_report(self,report_id,*,expected_revision,reason,action='accept',effective_month=None,effective_date=None,
                      vessel_id=None,replacements=None,snapshot_id=None,evidence=''):
        if not reason.strip(): raise ValueError('A review reason is required.')
        actor=current_actor()
        if not actor or actor=='unknown': raise ValueError('A signed-in or identified local reviewer is required.')
        replacements=replacements or {}
        with connection(self.root) as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT * FROM monthly_reports WHERE id=?',(report_id,)).fetchone()
            if not row or row['revision']!=expected_revision: raise ValueError('Report changed; refresh and review again.')
            old=dict(row); data=json.loads(row['payload'])
            if action not in ('accept','reject'): raise ValueError('Unknown review action')
            if action=='reject' and row['lifecycle_state']=='IN_USE': raise ValueError('An active report requires an approved replacement/correction, not rejection.')
            if snapshot_id is not None:
                snap=db.execute('SELECT payload FROM lube_parse_snapshots WHERE id=? AND report_id=?',(snapshot_id,report_id)).fetchone()
                if not snap: raise ValueError('Snapshot does not belong to this report')
                data=json.loads(snap[0])
            month=effective_month or row['month']; vid=vessel_id or row['vessel_id']
            if not valid_month(month): raise ValueError('Effective month must be YYYY-MM.')
            if vid is not None and not db.execute('SELECT 1 FROM vessels WHERE id=?',(vid,)).fetchone(): raise ValueError('Unknown vessel')
            if effective_date and (effective_date[:7]!=month or not __import__('datetime').date.fromisoformat(effective_date)): raise ValueError('Date must belong to effective month')
            report_date=effective_date if effective_month is not None else row['reporting_date']
            data=apply_effective_period(data,month,report_date)
            # Only explicit identity/period decisions resolve their corresponding blockers; structural failures remain blocking.
            resolved={'filename_period_mismatch','period_ambiguous','metadata:reporting_date','identity'} if effective_month else set()
            if vessel_id: resolved |= {'vessel_unknown','metadata:vessel','identity'}
            data['issues']=[i for i in data['issues'] if i['code'] not in resolved]
            data['validation_status']='FAIL' if any(i.get('severity')=='FAIL' for i in data['issues']) else 'WARNING' if data['issues'] else 'PASS'
            if action=='accept' and blockers(data,vid,month): raise ValueError('Blocking conditions remain: '+', '.join(blockers(data,vid,month)))
            affected=[]
            if action=='accept':
                occupied=db.execute('SELECT id FROM monthly_reports WHERE vessel_id=? AND report_type=? AND month=? AND is_active=1 AND id<>?',(vid,row['report_type'],month,report_id)).fetchone()
                if occupied and occupied[0] not in replacements: raise ValueError(f'Destination occupied by report {occupied[0]}; explicit replacement approval required.')
                for rid,revision in replacements.items():
                    original=db.execute('SELECT * FROM monthly_reports WHERE id=?',(rid,)).fetchone()
                    if rid==report_id or not original or original['revision']!=revision or original['lifecycle_state']!='IN_USE': raise ValueError('Replacement changed; refresh and review again.')
                    if original['vessel_id']!=vid or original['report_type']!=row['report_type']: raise ValueError('Replacement must belong to the same vessel and report type.')
                    affected.append(dict(original))
                    db.execute("UPDATE monthly_reports SET lifecycle_state='SUPERSEDED',is_active=0,revision=revision+1 WHERE id=?",(rid,))
                    self._audit(db,rid,'superseded',reason)
            state='IN_USE' if action=='accept' else 'REJECTED'
            version=row['report_version']
            if (vid,month)!=(row['vessel_id'],row['month']):
                version=db.execute('SELECT COALESCE(MAX(report_version),0)+1 FROM monthly_reports WHERE vessel_id IS ? AND report_type=? AND month=?',(vid,row['report_type'],month)).fetchone()[0]
            db.execute('''UPDATE monthly_reports SET lifecycle_state=?,is_active=?,vessel_id=?,month=?,reporting_date=?,report_version=?,
                payload=?,validation_status=?,confirmed_at=?,review_note=?,supersedes_report_id=?,revision=revision+1 WHERE id=?''',
                (state,int(state=='IN_USE'),vid,month,report_date,version,json.dumps(data),data['validation_status'],stamp() if state=='IN_USE' else row['confirmed_at'],reason,next(iter(replacements),row['supersedes_report_id']),report_id))
            details=dict(before={k:old[k] for k in ('month','vessel_id','lifecycle_state','revision')},after=dict(month=month,vessel_id=vid,lifecycle_state=state),
                affected_reports=[r['id'] for r in affected],evidence=evidence,snapshot_id=snapshot_id,
                affected_periods=sorted({p for p in [old['month'],month]+[r['month'] for r in affected] if p}))
            db.execute('INSERT INTO audit_events(report_id,action,note,actor,created_at,details_json) VALUES(?,?,?,?,?,?)',(report_id,'review_approved' if action=='accept' else 'rejected',reason,actor,stamp(),json.dumps(details)))
            db.execute('UPDATE lube_review_exceptions SET resolved_at=? WHERE report_id=? AND resolved_at IS NULL',(stamp(),report_id))
            db.commit()
        return details
