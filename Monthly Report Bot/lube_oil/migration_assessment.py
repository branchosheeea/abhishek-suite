"""Read-only migration inventory. Never constructs Repository or changes eligibility."""
import hashlib
import json
import sqlite3
from pathlib import Path
from .import_policy import blockers, legacy_state
from .analytics import monthly_consumption, PRIMARY_GROUPS, period_rate

def assess(root):
    path = Path(root) / 'suite.sqlite3'
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        rows = [dict(r) for r in db.execute('SELECT r.*,v.name AS vessel FROM monthly_reports r LEFT JOIN vessels v ON v.id=r.vessel_id')]
        audits = [dict(r) for r in db.execute('SELECT * FROM audit_events ORDER BY id')]
        indexes = [dict(r) for r in db.execute("SELECT name,sql FROM sqlite_master WHERE type='index' AND name='active_month'")]
        basis = [dict(r) for r in db.execute('SELECT * FROM vessel_budget_consumption_basis')] if db.execute("SELECT 1 FROM sqlite_master WHERE name='vessel_budget_consumption_basis'").fetchone() else []
        prices = [dict(r) for r in db.execute('SELECT * FROM oil_consumption_reference_price')] if db.execute("SELECT 1 FROM sqlite_master WHERE name='oil_consumption_reference_price'").fetchone() else []
    fingerprint = hashlib.sha256(json.dumps([rows, audits, basis, prices], sort_keys=True).encode()).hexdigest()
    replaced = {r['supersedes_report_id'] for r in rows if r['supersedes_report_id']}
    report_rows, before, after, slots = [], [], [], {}
    for row in rows:
        row['data'] = json.loads(row['payload'])
        problems = blockers(row['data'], row['vessel_id'], row['month'])
        try:
            state = legacy_state(row, audits, replaced)
        except ValueError:
            state = 'AMBIGUOUS'
        proposed = 'NEEDS_REVIEW' if state == 'IN_USE' and problems else state
        report_rows.append(dict(report_id=row['id'], vessel=row['vessel'], original_period=row['month'],
            proposed_period=row['month'], current_state=state, proposed_state=proposed,
            supersedes_report_id=row['supersedes_report_id'], reasons=problems,
            eligibility_changes=proposed != state, quantities={g: monthly_consumption(row,g) for g in PRIMARY_GROUPS}))
        before.append(dict(row, lifecycle_state=state))
        after.append(dict(row, lifecycle_state=proposed, is_active=int(proposed == 'IN_USE')))
        if row['is_active']:
            slots.setdefault((row['vessel_id'], row['report_type'], row['month']), []).append(row['id'])
    impacts = []
    from .budget import budget_performance
    for vessel in sorted({r['vessel'] for r in rows if r['vessel']}):
        vid = next(r['vessel_id'] for r in rows if r['vessel'] == vessel)
        for year in sorted({r['month'][:4] for r in rows if r['vessel'] == vessel and r['month']}):
            for label, start, end in [(f'{year}-{m:02}',m,m) for m in range(1,13)] + [(f'{year}-Q{q}',3*q-2,3*q) for q in range(1,5)] + [(year,1,12)]:
                def values(reports):
                    selected = [r for r in reports if r['vessel']==vessel and r['is_active'] and r['month'] and f'{year}-{start:02}' <= r['month'] <= f'{year}-{end:02}']
                    return dict(report_ids=[r['id'] for r in selected], coverage=len(selected),
                        quantities={g: sum(v for r in selected if (v:=monthly_consumption(r,g)) is not None) if any(monthly_consumption(r,g) is not None for r in selected) else None for g in PRIMARY_GROUPS},
                        rates={g: period_rate(reports,vessel,f'{year}-{end:02}',end-start+1,g) for g in PRIMARY_GROUPS},
                        budget=budget_performance(reports,vessel,int(year),f'{year}-{end:02}',[b for b in basis if b['vessel_id']==vid and b['budget_year']==int(year)],[p for p in prices if p['vessel_id'] in (None,vid) and p['budget_year']==int(year)],first_month=start))
                old, new = values(before), values(after)
                if old != new:
                    impacts.append(dict(vessel=vessel, period=label, before=old, proposed=new))
    return dict(fingerprint=fingerprint, reports=report_rows, analytics_impacts=impacts,
        duplicate_active=[dict(slot=k,report_ids=v) for k,v in slots.items() if len(v)>1], active_index=indexes,
        requires_eligibility_approval=any(r['eligibility_changes'] for r in report_rows),
        home_impact='Home and detailed views will exclude only explicitly approved withdrawals; latest eligible month may change.',
        unexplained_changes=[], applied=False)

def markdown(result):
    lines = ['# Lub Oil migration assessment', '', 'Read-only proposal. No reporting periods or eligibility changed.', '',
             f"Database evidence fingerprint: `{result['fingerprint']}`", '',
             '| ID | Vessel | Period | Current | Proposed | Reasons |', '|---|---|---|---|---|---|']
    for r in result['reports']:
        lines.append(f"| {r['report_id']} | {r['vessel']} | {r['original_period']} | {r['current_state']} | {r['proposed_state']} | {', '.join(r['reasons'])} |")
    lines += ['', '## Analytical changes requiring approval', '']
    for i in result['analytics_impacts']:
        lines.append(f"- {i['vessel']} {i['period']}: reports {i['before']['report_ids']} → {i['proposed']['report_ids']}; quantities {i['before']['quantities']} → {i['proposed']['quantities']}.")
    lines += ['', 'Full rate, coverage and budget comparisons are in the accompanying JSON. No proposed change has been applied.']
    return '\n'.join(lines)
