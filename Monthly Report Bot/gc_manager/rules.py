"""Deterministic subject identity, lifecycle, and attention rules."""
from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher
import os
import re
import unicodedata

GC_RE = re.compile(r"\bGC[\s-]?(\d+)\b", re.IGNORECASE)
STATUS = (
    "DRAFT", "SUBMITTED", "INFO_REQUIRED", "UNDER_REVIEW", "ACCEPTED", "DISPUTED",
    "REMEDY_AGREED", "AWAITING_SUPPLY", "IN_TRANSIT", "AWAITING_ATTENDANCE",
    "RECTIFICATION_IN_PROGRESS", "AWAITING_VERIFICATION", "MONITORING",
    "CLOSURE_PROPOSED", "CLOSED", "CANCELLED",
)
WAITING_ON = ("VESSEL", "SHIPYARD", "VENDOR_MAKER", "SUPPLIER", "SERVICE_COMPANY",
              "SUPERINTENDENT", "CLASS", "MULTIPLE_PARTIES", "NONE")
LABELS = {
    "DRAFT": "Draft / Under Review", "SUBMITTED": "Submitted", "INFO_REQUIRED": "Additional Information Required",
    "UNDER_REVIEW": "Under Yard/Vendor Review", "ACCEPTED": "Claim Accepted", "DISPUTED": "Disputed / Rejected",
    "REMEDY_AGREED": "Remedy Agreed", "AWAITING_SUPPLY": "Awaiting Spare Supply", "IN_TRANSIT": "Spare in Transit",
    "AWAITING_ATTENDANCE": "Awaiting Service Attendance", "RECTIFICATION_IN_PROGRESS": "Rectification in Progress",
    "AWAITING_VERIFICATION": "Awaiting Vessel Verification", "MONITORING": "Under Performance Monitoring",
    "CLOSURE_PROPOSED": "Closure Proposed", "CLOSED": "Closed", "CANCELLED": "Cancelled / Duplicate",
}
TRANSITIONS = {
    "DRAFT": {"SUBMITTED", "CANCELLED"}, "SUBMITTED": {"INFO_REQUIRED", "UNDER_REVIEW", "ACCEPTED", "DISPUTED", "CANCELLED"},
    "INFO_REQUIRED": {"UNDER_REVIEW", "CANCELLED"}, "UNDER_REVIEW": {"INFO_REQUIRED", "ACCEPTED", "DISPUTED", "CANCELLED"},
    "ACCEPTED": {"REMEDY_AGREED", "AWAITING_SUPPLY", "AWAITING_ATTENDANCE", "CANCELLED"},
    "DISPUTED": {"UNDER_REVIEW", "ACCEPTED", "CANCELLED"}, "REMEDY_AGREED": {"AWAITING_SUPPLY", "AWAITING_ATTENDANCE", "RECTIFICATION_IN_PROGRESS"},
    "AWAITING_SUPPLY": {"IN_TRANSIT", "AWAITING_ATTENDANCE"}, "IN_TRANSIT": {"AWAITING_ATTENDANCE", "RECTIFICATION_IN_PROGRESS"},
    "AWAITING_ATTENDANCE": {"RECTIFICATION_IN_PROGRESS"}, "RECTIFICATION_IN_PROGRESS": {"AWAITING_VERIFICATION"},
    "AWAITING_VERIFICATION": {"MONITORING", "CLOSURE_PROPOSED", "RECTIFICATION_IN_PROGRESS"},
    "MONITORING": {"CLOSURE_PROPOSED", "RECTIFICATION_IN_PROGRESS"}, "CLOSURE_PROPOSED": {"CLOSED", "MONITORING"},
    "CLOSED": set(), "CANCELLED": set(),
}


def extract_gc_numbers(subject: str) -> list[str]:
    """Extract unique GC identifiers in subject order; normalize to at least 3 digits."""
    values = []
    for match in GC_RE.finditer(subject or ""):
        number = str(int(match.group(1)))
        value = f"GC-{number.zfill(3)}"
        if value not in values:
            values.append(value)
    return values


def normalise_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(char for char in value if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]", "", value.casefold())


@dataclass(frozen=True)
class VesselMatch:
    vessel_id: int | None
    canonical_vessel_name: str | None
    detected_text: str | None
    match_type: str
    similarity_score: float | None
    review_required: bool
    reason: str


def identify_vessel(subject: str, vessels: list[dict], *, auto_threshold=None, review_threshold=None, margin=None) -> VesselMatch:
    """Resolve vessel from subject text alone. Existing claim data is never consulted."""
    auto = float(auto_threshold if auto_threshold is not None else os.getenv("GC_VESSEL_AUTO_MATCH_THRESHOLD", 90))
    review = float(review_threshold if review_threshold is not None else os.getenv("GC_VESSEL_REVIEW_THRESHOLD", 80))
    gap = float(margin if margin is not None else os.getenv("GC_VESSEL_MATCH_MARGIN", 8))
    names = [(int(v["id"]), str(v["name"])) for v in vessels]
    exact = [(i, n) for i, n in names if re.search(rf"(?<!\w){re.escape(n)}(?!\w)", subject or "", re.I)]
    if len(exact) == 1:
        i, n = exact[0]
        return VesselMatch(i, n, n, "EXACT", 100.0, False, "Canonical vessel name appears in subject.")
    if len(exact) > 1:
        return VesselMatch(None, None, "; ".join(n for _, n in exact), "AMBIGUOUS", None, True, "More than one registered vessel appears in subject.")

    tokens = re.findall(r"[A-Za-z0-9]+", subject or "")
    spans = [" ".join(tokens[start:end]) for start in range(len(tokens)) for end in range(start + 1, min(len(tokens), start + 7) + 1)]
    normalised_spans = {normalise_name(span) for span in spans}
    normalised = [(i, n) for i, n in names if normalise_name(n) and normalise_name(n) in normalised_spans]
    if len(normalised) == 1:
        i, n = normalised[0]
        return VesselMatch(i, n, n, "NORMALISED_EXACT", 100.0, False, "Unique normalised vessel name appears in subject.")
    if len(normalised) > 1:
        return VesselMatch(None, None, "; ".join(n for _, n in normalised), "AMBIGUOUS", None, True, "More than one registered vessel appears in subject.")

    # Candidate is only a subject token/span. Similarity compares names; it does not inspect claims.
    scored = []
    for vessel_id, name in names:
        target = normalise_name(name)
        score = max((SequenceMatcher(None, normalise_name(span), target).ratio() * 100 for span in spans), default=0)
        scored.append((score, vessel_id, name))
    scored.sort(reverse=True)
    best = scored[0] if scored else (0, None, None)
    second = scored[1][0] if len(scored) > 1 else 0
    # A DHT-prefixed canonical name requires its prefix in the subject; short partials are not safe.
    has_prefix = "dht" not in normalise_name(best[2] or "") or "dht" in normalise_name(subject or "")
    if best[0] >= auto and best[0] - second >= gap and has_prefix:
        return VesselMatch(best[1], best[2], best[2], "SAFE_FUZZY", round(best[0], 1), False, "Unique high-confidence clerical match from subject text.")
    if best[0] >= review:
        return VesselMatch(None, None, best[2], "AMBIGUOUS", round(best[0], 1), True, "Vessel similarity requires manual review.")
    return VesselMatch(None, None, None, "NO_MATCH", round(best[0], 1) if names else None, True, "No registered vessel independently matches the subject.")


class NoOpClaimIntelligenceProvider:
    """V1's inert extension point. No claim behavior depends on intelligence."""
    def suggest(self, *_args, **_kwargs):
        return None
