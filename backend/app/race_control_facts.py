"""Distil OpenF1 race-control messages into the handful of events worth
narrating in a race recap.

A race produces ~80 race-control messages, the large majority of which are
noise for recap purposes: per-driver blue flags (a lapped car being shown
past), and sector yellow/clear pairs that resolve within seconds. Feeding all
of them to an LLM buries the two or three genuinely story-shaping events
(a penalty, a safety car) in chatter and invites the model to over-narrate
trivia. This module keeps penalties, stewards' decisions, safety-car/VSC
periods, red flags and session-level status changes, and collapses
track-limit lap deletions into a per-driver count rather than one line each.

Driver numbers are resolved to names via the race's own classification, so
the model never has to map "CAR 44" to a person itself.
"""

import re

# Ordered most-specific first: a "PENALTY SERVED" line also contains
# "PENALTY", and should be classified as the more specific kind.
_PENALTY_PATTERNS = [
    ("penalty_served", re.compile(r"PENALTY SERVED", re.I)),
    ("penalty", re.compile(r"\b(?:\d+\s*SECOND\s*)?TIME PENALTY\b", re.I)),
    ("penalty", re.compile(r"\b(?:DRIVE THROUGH|STOP AND GO|GRID PENALTY)\b", re.I)),
]

_INVESTIGATION_RE = re.compile(r"UNDER INVESTIGATION|WILL BE INVESTIGATED", re.I)
_NO_ACTION_RE = re.compile(r"NO FURTHER (?:ACTION|INVESTIGATION)", re.I)
_SAFETY_CAR_RE = re.compile(r"\b(?:SAFETY CAR|VSC|VIRTUAL SAFETY CAR)\b", re.I)
_RED_FLAG_RE = re.compile(r"\bRED FLAG\b", re.I)
_LAP_DELETED_RE = re.compile(r"(?:LAP|TIME .*?) DELETED", re.I)
_CAR_RE = re.compile(r"CAR (\d+)\s*\(([A-Z]{3})\)", re.I)

# Blue flags and sector yellow/clear churn are the bulk of the message log and
# carry no recap value on their own.
_NOISE_FLAGS = {"BLUE", "CLEAR"}


def _driver_lookup(results: list[dict]) -> dict[str, str]:
    """Map car number -> driver full name, from the race's classification."""
    lookup: dict[str, str] = {}
    for r in results:
        number = str(r.get("number") or "").strip()
        driver = r.get("Driver") or {}
        name = f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip()
        if number and name:
            lookup[number] = name
    return lookup


def _resolve_drivers(message: str, lookup: dict[str, str]) -> list[str]:
    """Every driver named in a race-control message, as full names."""
    names = []
    for number, _code in _CAR_RE.findall(message or ""):
        name = lookup.get(str(number))
        if name and name not in names:
            names.append(name)
    return names


def _classify(message: str) -> str | None:
    """The recap-relevant kind of a race-control message, or None to drop it."""
    text = message or ""
    for kind, pattern in _PENALTY_PATTERNS:
        if pattern.search(text):
            return kind
    if _RED_FLAG_RE.search(text):
        return "red_flag"
    if _SAFETY_CAR_RE.search(text):
        return "safety_car"
    if _NO_ACTION_RE.search(text):
        return "no_further_action"
    if _INVESTIGATION_RE.search(text):
        return "investigation"
    return None


def summarize_race_control(
    messages: list[dict], results: list[dict]
) -> dict:
    """Reduce raw race-control rows to `{events, track_limit_deletions}`.

    `events` are the narratable ones (penalties, stewards' decisions, safety
    cars, red flags), each already resolved to driver names and tagged with a
    `kind` so the prompt can reason about them without parsing prose.
    `track_limit_deletions` is a per-driver count, since the individual
    deletions are too granular to narrate but the tally can be a real story
    ("three of Albon's laps were deleted").
    """
    lookup = _driver_lookup(results)
    events: list[dict] = []
    deletions: dict[str, int] = {}

    for row in messages or []:
        message = (row.get("message") or "").strip()
        if not message:
            continue

        if _LAP_DELETED_RE.search(message):
            for name in _resolve_drivers(message, lookup):
                deletions[name] = deletions.get(name, 0) + 1
            continue

        if (row.get("flag") or "").upper() in _NOISE_FLAGS:
            continue

        kind = _classify(message)
        if not kind:
            continue

        events.append({
            "kind": kind,
            "lap": row.get("lap_number"),
            "drivers": _resolve_drivers(message, lookup),
            "message": message,
        })

    events.sort(key=lambda e: (e.get("lap") is None, e.get("lap") or 0))

    return {
        "events": events,
        "track_limit_deletions": [
            {"driver": name, "count": count}
            for name, count in sorted(deletions.items(), key=lambda kv: -kv[1])
            if count > 1
        ],
    }
