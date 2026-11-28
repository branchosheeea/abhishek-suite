"""Import eligibility is distinct from technical metric validity."""
import re

STATES = ('NEEDS_REVIEW', 'IN_USE', 'SUPERSEDED', 'REJECTED')
OUTCOMES = ('IMPORTED', 'UNCHANGED_DUPLICATE', 'FAILED', 'INTERRUPTED')

def eligible(report):
    # Legacy read-only consumers and old exported/test payloads remain readable.
    return report.get('lifecycle_state') == 'IN_USE' if 'lifecycle_state' in report else bool(report.get('is_active'))

def valid_month(value):
    return bool(isinstance(value, str) and re.fullmatch(r'[1-9]\d{3}-(0[1-9]|1[0-2])', value))

def blockers(payload, vessel_id, month=None):
    result = []
    if not vessel_id:
        result.append('vessel_unknown')
    if not valid_month(month if month is not None else payload.get('month')):
        result.append('reporting_period')
    result.extend(i['code'] for i in payload.get('issues', [])
                  if i.get('severity') == 'FAIL' or i['code'] in ('filename_period_mismatch', 'period_ambiguous'))
    return sorted(set(result))

def legacy_state(report, audits=(), replaced_ids=()):
    if report.get('lifecycle_state'):
        return report['lifecycle_state']
    if report.get('is_active'):
        return 'IN_USE'
    actions = [a['action'] for a in audits if a.get('report_id') == report['id']]
    if 'rejected' in actions:
        return 'REJECTED'
    if report['id'] in replaced_ids or 'superseded' in actions:
        return 'SUPERSEDED'
    if not report.get('confirmed_at'):
        return 'NEEDS_REVIEW'
    raise ValueError(f"Ambiguous inactive history for report {report['id']}; migration approval required")
