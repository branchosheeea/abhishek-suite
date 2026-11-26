"""Suggestions from a claim's emails, for the guided register set-up (Master Specification v2, sections 5 D, 11, 24).

NeraVeda identifies, NeraVeda prepares, the user decides. Everything here is a SUGGESTION with the email sentence
it rests on; nothing here changes a claim. The rules are fixed text rules (no AI, no scores):

- Only the newest part of each email is read (the quoted earlier thread, warning banners and the signature are cut).
- An acknowledgement ("Noted, we are checking") is not substantive, so it never moves the pending-since date.
- Who wrote it comes from the sender's domain (Settings: party_domains); an unknown outside domain is a maker.
- OWNER / PENDING_SINCE / NEXT_ACTION: from the newest substantive email. If an outside party wrote it, the reply is
  with your office; if your office wrote it, the reply is with the party it was sent to.
- STAGE: spares shipped (AWB, shipping documents) or received on board; otherwise "sent to the yard/maker".
- CLOSURE: the email says the claim can be (considered) closed. Counted apart from controlled closure candidates.
- LINK: an email linked to another claim also names this claim (one shipment email often covers several claims).
- TITLE: when the claim has no title, the words after the GC number in the subject of its first email.
- CONFLICT: an email on this claim names a GC number that is not a claim of the vessel but has the same digits
  (for example GC-102 written for GC-012).
"""
from __future__ import annotations

from datetime import date
import json
import re

from .command import NO_OWNER, OFFICE, OWNER_NAMES, gc_sort_key, local_day
from .rules import STATUS

BANNERS = re.compile(
    r"CAUTION: This email originated from outside of the .{0,40}? organi[sz]ation\. Do not click links or open attachments unless you recognize the sender and know the content is safe\."
    r"|\[외부 발신 메일\][^\[]{0,200}|\[EXTERNAL EMAIL\][^.]{0,200}\.(?: [^.]{0,200}\.)?", re.I)
THREAD_CUT = re.compile(r"\s(?:From:\s.{1,300}?\sSent:|-{2,}\s*Original Message|On [^.]{5,80} wrote:)", re.I)
SIGN_CUT = re.compile(r"\b(?:Thank\s+you\s+(?:and|&)\s+(?:Best\s+)?Regards|Thanks?\s*(?:&|and)\s*(?:Best\s+)?Regards|Best\s+Regards|Kind\s+Regards"
                      r"|Warm\s+Regards|With\s+Regards|Regards\s*,|Brgds)", re.I)
GREETINGS = (re.compile(r"^Dear\s+.{1,40}?(?=\s+Good\s*(?:day|morning|afternoon|evening)\b)", re.I),
             re.compile(r"^Dear\s+[^,]{1,60},\s*", re.I),
             re.compile(r"^Good\s*(?:day|morning|afternoon|evening)\s+[A-Z][^,.?!]{0,40},\s*"),
             re.compile(r"^Good\s*(?:day|morning|afternoon|evening)\s*[,.!]?\s*", re.I),
             re.compile(r"^(?:Hi|Hello)\b[^,]{0,40},\s*", re.I))
CLOSURE = re.compile(r"can be (?:considered )?closed|consider(?:ed)? .{0,60}?(?:as )?closed|proceed to close|close (?:this|the) (?:claim|gc|case|issue)|may be closed", re.I)
RECEIVED = re.compile(r"spares? (?:has|have) been received|received (?:the )?spares?|vessel received|received on ?board|(?:has been|been) installed|installed on ?board", re.I)
SHIPMENT = re.compile(r"\bAWB\b|air ?way ?bill|shipping documents|shipment advi[cs]e|dispatched|has been shipped|courier|tracking (?:no|number)", re.I)
ACK = re.compile(r"\b(?:noted|well received|received with thanks|thank(?:s| you)|will (?:revert|check|update|advise)|we are checking|checking (?:with|internally)|acknowledg)", re.I)
REQUEST = re.compile(r"\b(?:please|kindly|request|advise|provide|share|confirm|let us know|appreciate)\b", re.I)
GC_MENTION = re.compile(r"\bGC[\s\-#:]*0*(\d{1,4})\b((?:\s*(?:,|&|and)\s*\d{3}\b)*)", re.I)
NOT_DONE = re.compile(r"\b(?:once|when|if|will be|would|shall|send us|ready to|ready for|to be dispatched|before dispatch"
                      r"|(?:please|kindly)\s+(?:share|send|provide|forward|advise|arrange))\b", re.I)
SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9“\"‘'(])")
QUOTE_LIMIT = 240
STAGES = (("RECEIVED", RECEIVED, "AWAITING_VERIFICATION", "Spare received on board"), ("SHIPPED", SHIPMENT, "IN_TRANSIT", "Spare shipped"))


# ---- reading one email ----------------------------------------------------------------------------------------------

def latest_text(body):
    """The newest message only: banners, the quoted earlier thread, greetings and the signature removed."""
    text = BANNERS.sub(" ", body or "")
    text = re.sub(r"\s+", " ", text).strip()
    cut = THREAD_CUT.search(" " + text)
    if cut:
        text = text[:max(0, cut.start() - 1)]
    sign = SIGN_CUT.search(text)
    if sign:
        text = text[:sign.start()]
    for _ in range(3):
        for greeting in GREETINGS:
            text = greeting.sub("", text, count=1).strip()
    return text.strip(" ,;")


def is_acknowledgement(text):
    """Short courtesy replies ("Noted. We are checking.") hold no new position and do not reset ageing (spec 13)."""
    if not text:
        return True
    if CLOSURE.search(text) or RECEIVED.search(text) or SHIPMENT.search(text):
        return False
    return len(text.split()) <= 35 and bool(ACK.search(text)) and "?" not in text


def quote(text, pattern=None):
    """The sentence a suggestion rests on, word for word (shortened with … when long)."""
    parts = sentences(text)
    chosen = next((s for s in parts if pattern and pattern.search(s)), None) \
        or next((s for s in parts if REQUEST.search(s) or "?" in s), None) or (parts[0] if parts else "")
    return chosen if len(chosen) <= QUOTE_LIMIT else chosen[:QUOTE_LIMIT - 1].rstrip() + "…"


def sentences(text):
    return [s.strip() for s in SENTENCE.split(text or "") if s.strip()]


def stage_sentence(text, pattern):
    """A sentence that states the step as done (not a request, a condition or a question)."""
    return next((s for s in sentences(text) if pattern.search(s) and "?" not in s and not NOT_DONE.search(s)), None)


def gc_mentions(text):
    """GC numbers named in text, including lists such as "GC 006, 016, 020"; canonical form GC-006."""
    found = []
    for match in GC_MENTION.finditer(text or ""):
        for number in [match.group(1), *re.findall(r"\d{3}", match.group(2) or "")]:
            value = f"GC-{str(int(number)).zfill(3)}"
            if value not in found:
                found.append(value)
    return found


def party_of(address, settings):
    """SUPERINTENDENT / VESSEL / SHIPYARD from Settings party_domains; any other outside domain counts as a maker."""
    address = (address or "").strip().lower()
    if "@" not in address:
        return None
    domain = address.rsplit("@", 1)[1]
    for known, party in ((settings or {}).get("party_domains") or {}).items():
        if domain == known.lower() or domain.endswith("." + known.lower()):
            return party
    return "VENDOR_MAKER"


def _recipients(email):
    try:
        values = json.loads(email.get("recipients_json") or "[]")
    except ValueError:
        return []
    return [(v.get("address") if isinstance(v, dict) else v) or "" for v in values]


def _fmt(d):
    return f"{d.day} {d.strftime('%b %Y')}"


# ---- suggestions for one vessel -------------------------------------------------------------------------------------

class _Mail:
    def __init__(self, email, settings):
        self.email = email
        self.id = email["id"]
        self.when = local_day(email.get("message_datetime"))
        self.author = OFFICE if email.get("direction") == "OUTGOING" else party_of(email.get("sender_address"), settings)
        self.text = latest_text(email.get("sanitised_body") or email.get("body_preview") or "")
        self.ack = is_acknowledgement(self.text)
        parties = [party_of(a, settings) for a in _recipients(email)]
        self.addressee = next((p for p in parties if p and p != OFFICE), None)


def _suggestion(kind, claim, mail, proposed, reason, text, today):
    value = next(iter(proposed.values()), "")
    return {"key": f"{kind}:{claim['id']}:{mail.id}:{value}", "kind": kind, "claim_id": claim["id"], "proposed": proposed,
            "reason": reason, "quote": text, "evidence_email_id": mail.id, "evidence_date": mail.when.isoformat() if mail.when else None,
            "evidence_subject": mail.email.get("subject") or "", "evidence_direction": mail.email.get("direction"),
            "evidence_author": OWNER_NAMES.get(mail.author, "an unknown sender") if mail.author else "an unknown sender",
            "age_days": (today - mail.when).days if mail.when else 0}


def subject_title(subject, gc_number):
    """The words after the claim's GC number in an email subject ("... / GC-010 - ECDIS Radar Overlay Issue")."""
    number = int(re.sub(r"\D", "", gc_number) or 0)
    match = re.search(rf"\bGC[\s\-#:]*0*{number}\b[\s\-–:/.]*(.+)$", subject or "", re.I)
    if not match:
        return None
    text = re.sub(r"\s*\[[^\]]*\]\s*", " ", match.group(1))
    text = re.sub(r"\s+", " ", text).strip(" -–:/.,")
    return text if 4 <= len(text) <= 120 and re.search(r"[A-Za-z]{3}", text) else None


def _for_claim(claim, mails, settings, today):
    out = []
    if not (claim.get("title") or "").strip():
        # The earliest original email (not a reply or forward) names the claim best; replies are the fallback.
        reply = lambda m: bool(re.match(r"\s*(?:re|fw|fwd|aw|wg)\s*:", m.email.get("subject") or "", re.I))
        ordered = sorted((m for m in mails if m.when), key=lambda m: (reply(m), m.email.get("message_datetime") or ""))
        first = next(((m, t) for m in ordered for t in [subject_title(m.email.get("subject"), claim["gc_number"])] if t), None)
        if first:
            mail, title = first
            out.append(_suggestion("TITLE", claim, mail, {"title": title},
                                   f"From the subject of the first email about this claim ({_fmt(mail.when)}).", mail.email.get("subject") or "", today))
    owner_now = claim.get("waiting_on") or NO_OWNER
    substantive = [m for m in mails if m.text and not m.ack and m.when]
    if substantive:
        last = substantive[-1]
        if last.author == OFFICE:
            earlier = [m.author for m in mails if m.when and m.when <= last.when and m.author not in (OFFICE, None)]
            owner = last.addressee or (earlier[-1] if earlier else None)
        else:
            owner = OFFICE if last.author else None
        text = quote(last.text)
        if owner and owner != owner_now:
            reason = (f"The newest substantive email is from {OWNER_NAMES.get(last.author, 'an outside sender')} ({_fmt(last.when)}); the reply is with your office."
                      if owner == OFFICE else f"Your office wrote to {OWNER_NAMES.get(owner)} on {_fmt(last.when)}; the reply is with them.")
            out.append(_suggestion("OWNER", claim, last, {"waiting_on": owner}, reason, text, today))
        if owner and last.when.isoformat() != (claim.get("action_since") or ""):
            out.append(_suggestion("PENDING_SINCE", claim, last, {"action_since": last.when.isoformat()},
                                   f"Pending since the substantive email of {_fmt(last.when)}; later acknowledgements do not reset it.", text, today))
        if owner and not (claim.get("next_action") or "").strip():
            action = (f"Review the email from {OWNER_NAMES.get(last.author, 'the sender')} of {_fmt(last.when)} and reply or record the next step."
                      if owner == OFFICE else f"Await the reply from {OWNER_NAMES.get(owner)} to your email of {_fmt(last.when)}; follow up if none arrives.")
            out.append(_suggestion("NEXT_ACTION", claim, last, {"next_action": action}, "Proposed from the newest substantive email.", text, today))
    stage = None
    for mail in reversed(mails):
        hit = next(((stage_sentence(mail.text, p), status, label) for _s, p, status, label in STAGES if stage_sentence(mail.text, p)), None)
        if hit:
            stage = (mail, hit[1], hit[2], hit[0])
            break
    if stage is None:
        sent = next((m for m in mails if m.author == OFFICE and m.addressee and m.addressee not in (OFFICE, "VESSEL")), None)
        if sent:
            stage = (sent, "SUBMITTED", f"Claim sent to {OWNER_NAMES.get(sent.addressee)}", sent.email.get("subject") or "")
    current = claim.get("current_status") or "DRAFT"
    if stage and current in STATUS and STATUS.index(stage[1]) > STATUS.index(current):
        mail, status, label, text = stage
        out.append(_suggestion("STAGE", claim, mail, {"current_status": status}, f"{label} ({_fmt(mail.when)})." if mail.when else label + ".", text, today))
    if current != "CLOSURE_PROPOSED":
        closing = next((m for m in reversed(mails) if m.text and CLOSURE.search(m.text) and m.when), None)
        if closing:
            out.append(_suggestion("CLOSURE", claim, closing, {"close": True},
                                   f"{OWNER_NAMES.get(closing.author, 'A sender').capitalize()} wrote on {_fmt(closing.when)} that the claim can be closed.",
                                   quote(closing.text, CLOSURE), today))
    return out


def for_vessel(claims, emails_by_claim, settings, today=None, decided=()):
    """claim id -> suggestions, for the vessel's open claims. `decided` holds keys a person already accepted or
    rejected (gc_suggestions), so they are not shown again."""
    today = today or date.today()
    decided = set(decided)
    numbers = {c["gc_number"]: c for c in claims}
    numbers_by_id = {c["id"]: c["gc_number"] for c in claims}
    mails, linked = {}, {}
    for claim in claims:
        for email in emails_by_claim.get(claim["id"], []):
            mails.setdefault(email["id"], _Mail(email, settings))
            linked.setdefault(email["id"], set()).add(claim["id"])
    result = {}
    for claim in claims:
        if claim.get("current_status") in {"CLOSED", "CANCELLED"}:
            result[claim["id"]] = []
            continue
        own = sorted((mails[e["id"]] for e in emails_by_claim.get(claim["id"], [])), key=lambda m: (m.email.get("message_datetime") or "", m.id))
        found = _for_claim(claim, own, settings, today)
        digits = sorted(re.sub(r"\D", "", claim["gc_number"]).zfill(3))
        for mail in own:  # CONFLICT: a GC number with this claim's digits that is not a claim of the vessel
            for number in gc_mentions(mail.text):
                if number not in numbers and sorted(re.sub(r"\D", "", number).zfill(3)) == digits and mail.when:
                    found.append(_suggestion("CONFLICT", claim, mail, {"mentioned": number},
                                             f"The email of {_fmt(mail.when)} names {number}, which is not a claim of this vessel; it may mean {claim['gc_number']}.",
                                             quote(mail.text, re.compile(r"GC[\s\-#:]*0*" + str(int(number[3:])) + r"\b", re.I)), today))
        result[claim["id"]] = found
    for mail in mails.values():  # LINK: an email on another claim also names this one
        for number in gc_mentions(mail.text):
            claim = numbers.get(number)
            if claim and claim["id"] not in linked[mail.id] and claim["id"] in result and mail.when:
                others = ", ".join(sorted((c["gc_number"] for c in claims if c["id"] in linked[mail.id]), key=gc_sort_key))
                result[claim["id"]].append(_suggestion("LINK", claim, mail, {"email_id": mail.id},
                                                       f"The email of {_fmt(mail.when)} (linked to {others}) also names {number}.",
                                                       next((t for t in sentences(mail.text) if number in gc_mentions(t)), quote(mail.text)), today))
    titles = {}  # the same suggested title on two claims usually means one email named the wrong claim
    for cid, items in result.items():
        for item in items:
            if item["kind"] == "TITLE":
                titles.setdefault(item["proposed"]["title"].casefold(), []).append(item)
    for same in (group for group in titles.values() if len(group) > 1):
        for item in same:
            others = sorted((numbers_by_id[o["claim_id"]] for o in same if o is not item), key=gc_sort_key)
            item["reason"] += f" The same title is suggested for {', '.join(others)}; check which claim it belongs to."
    return {cid: [s for s in items if s["key"] not in decided] for cid, items in result.items()}
