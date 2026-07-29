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

_INVESTIGATION_RE = re.compile(
    r"UNDER INVESTIGATION|WILL BE INVESTIGATED|INCIDENT .*\bNOTED\b", re.I
)
_NO_ACTION_RE = re.compile(r"NO FURTHER (?:ACTION|INVESTIGATION)", re.I)

# "SAFETY CAR" appears in two unrelated kinds of message: the deployment/ending
# status calls, and stewards' lines about a *safety-car infringement* by one
# driver. Lumping them together produced a confidently wrong sprint recap
# ("safety-car periods were deployed on laps 13, 16, 17 and 19" — there was
# one). Deployment and ending are also split so the model never has to work out
# which a given call was.
_SAFETY_CAR_DEPLOYED_RE = re.compile(
    r"\b(?:SAFETY CAR|VSC|VIRTUAL SAFETY CAR)\b.*\b(?:DEPLOYED)\b", re.I
)
_SAFETY_CAR_ENDING_RE = re.compile(
    r"\b(?:SAFETY CAR|VSC|VIRTUAL SAFETY CAR)\b.*\b(?:IN THIS LAP|ENDING)\b", re.I
)
_RED_FLAG_RE = re.compile(r"\bRED FLAG\b", re.I)
_LAP_DELETED_RE = re.compile(r"(?:LAP|TIME .*?) DELETED", re.I)
# A car is named as `<number> (<CODE>)`. Anchoring on a literal "CAR " prefix
# missed every multi-car incident — "CARS 44 (HAM) AND 81 (PIA)" resolved to no
# drivers at all, handing the model bare car numbers it could not map to people
# and inviting it to guess. Matching the number/code pair itself catches the
# "CAR", "CARS … AND …" and bare-continuation forms alike.
_CAR_RE = re.compile(r"\b(\d{1,3})\s*\(([A-Z]{3})\)")

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
    # Stewards' outcomes are checked before the safety-car status calls: a line
    # like "INCIDENT INVOLVING CAR 11 (PER) NOTED - SAFETY CAR INFRINGEMENT" is
    # a stewards' decision, not a safety-car period.
    if _NO_ACTION_RE.search(text):
        return "no_further_action"
    if _INVESTIGATION_RE.search(text):
        return "investigation"
    if _SAFETY_CAR_DEPLOYED_RE.search(text):
        return "safety_car_deployed"
    if _SAFETY_CAR_ENDING_RE.search(text):
        return "safety_car_ending"
    return None


# The reason an incident was logged, e.g. "IMPEDING" from
# "TURN 1 INCIDENT INVOLVING CARS 44 (HAM) AND 81 (PIA) NOTED - IMPEDING
# (16:59:46)". The trailing wall-clock stamp is dropped so the same incident
# reads the same across the messages that report it.
_TIMESTAMP_RE = re.compile(r"\(\s*\d{1,2}:\d{2}:\d{2}\s*\)\s*$")


def _incident_key(event: dict) -> tuple:
    _, _, reason = (event.get("message") or "").partition(" - ")
    reason = _TIMESTAMP_RE.sub("", reason).strip().upper()
    return (tuple(event.get("drivers") or ()), reason)


def _collapse_investigations(events: list[dict]) -> list[dict]:
    """One entry per incident, not one per race-control message about it.

    The FIA logs the same incident repeatedly as it progresses: first
    "… NOTED - IMPEDING", then "… WILL BE INVESTIGATED AFTER THE SESSION -
    IMPEDING", and sometimes a "NO FURTHER ACTION" outcome. Left as three
    events they read like three separate incidents, and a recap will happily
    narrate them as such. Only the latest investigation line for an incident
    survives, and a resolved incident drops its investigation entirely.

    Penalties are untouched: "PENALTY" and "PENALTY SERVED" are genuinely two
    moments in the session and both are worth narrating.
    """
    resolved = {
        _incident_key(e) for e in events if e.get("kind") == "no_further_action"
    }
    latest: dict[tuple, int] = {}
    for index, event in enumerate(events):
        if event.get("kind") == "investigation":
            latest[_incident_key(event)] = index

    kept = []
    for index, event in enumerate(events):
        if event.get("kind") != "investigation":
            kept.append(event)
            continue
        key = _incident_key(event)
        if key in resolved or latest.get(key) != index:
            continue
        kept.append(event)
    return kept


def summarize_race_control(
    messages: list[dict], results: list[dict], min_deletions: int = 2
) -> dict:
    """Reduce raw race-control rows to `{events, track_limit_deletions}`.

    `events` are the narratable ones (penalties, stewards' decisions, safety
    cars, red flags), each already resolved to driver names and tagged with a
    `kind` so the prompt can reason about them without parsing prose.
    `track_limit_deletions` is a per-driver count, since the individual
    deletions are too granular to narrate but the tally can be a real story
    ("three of Albon's laps were deleted").

    `min_deletions` is the tally a driver needs before they are reported. Two
    is right for a race, where a single scrubbed lap among 60+ is noise; the
    qualifying recap passes 1, because there a driver only sets a handful of
    laps and losing one of them is the story.
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

    events = _collapse_investigations(events)
    events.sort(key=lambda e: (e.get("lap") is None, e.get("lap") or 0))

    return {
        "events": events,
        "track_limit_deletions": [
            {"driver": name, "count": count}
            for name, count in sorted(deletions.items(), key=lambda kv: -kv[1])
            if count >= min_deletions
        ],
    }
