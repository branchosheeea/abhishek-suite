"""Deterministic claim attention conditions."""
from datetime import date, datetime

SEVERITY = ["OVERDUE", "NO_RESPONSE", "DELIVERY_OVERDUE", "FOLLOW_UP_DUE", "NEW_EMAIL", "GUARANTEE_EXPIRY_RISK", "CLOSURE_PENDING"]


def _day(value):
    if not value: return None
    try: return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError): return None


def calculate_attention(claim, emails=(), vessel=None, settings=None, today=None):
    today = _day(today) or date.today()
    settings = settings or {}
    if claim.get("current_status") in {"CLOSED", "CANCELLED"}: return []
    result=[]
    follow=_day(claim.get("next_follow_up_date"))
    if follow:
        if follow<today: result.append("OVERDUE")
        elif follow==today: result.append("FOLLOW_UP_DUE")
    incoming=max((_day(e.get("message_datetime")) for e in emails if e.get("direction")=="INCOMING"),default=None)
    outgoing=max((_day(e.get("message_datetime")) for e in emails if e.get("direction")=="OUTGOING"),default=None)
    if outgoing and (incoming is None or incoming<outgoing) and (today-outgoing).days>=int(settings.get("no_response_days",14)): result.append("NO_RESPONSE")
    dispatch=_day(claim.get("promised_dispatch_date")); delivery=_day(claim.get("expected_delivery_date"))
    if dispatch and dispatch<today and claim.get("current_status") not in {"IN_TRANSIT","AWAITING_VERIFICATION","MONITORING"}:
        result.append("DELIVERY_OVERDUE")
    elif delivery and delivery<today and claim.get("current_status") not in {"AWAITING_VERIFICATION","MONITORING"}:
        result.append("DELIVERY_OVERDUE")
    if any(not e.get("reviewed_at") for e in emails): result.append("NEW_EMAIL")
    expiry=_day((vessel or {}).get("guarantee_expiry_date"))
    if expiry and (expiry-today).days in settings.get("guarantee_alert_days",[90,60,30,14]): result.append("GUARANTEE_EXPIRY_RISK")
    if claim.get("current_status") in {"AWAITING_VERIFICATION","MONITORING","CLOSURE_PROPOSED"}:
        latest=max((_day(e.get("message_datetime")) for e in emails),default=None) or _day(claim.get("last_status_change")) or _day(claim.get("updated_at"))
        if latest and (today-latest).days>=int(settings.get("verification_days",5)): result.append("CLOSURE_PENDING")
    return sorted(set(result),key=lambda x:SEVERITY.index(x) if x in SEVERITY else 99)
