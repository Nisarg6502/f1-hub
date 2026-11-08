"""Practice and sprint-qualifying classifications from OpenF1.

**Why this exists.** Practice used to come from FastF1, which reads
`livetiming.formula1.com`. That host 403s Cloud Run and, since 2026-10-23,
401s an ordinary home connection too, so `session.load()` fails soft (22
drivers, no timing) wherever it runs. The last practice document written was
round 16's, from a local run on 2026-10-06; rounds 17 onwards had none, and the
site said "classified timing hasn't been published yet" for sessions that had
finished days earlier.

OpenF1 publishes the official classification itself at `/session_result`:
position, best lap (`duration`, in seconds) and, for sprint qualifying, the
three segment times. That is preferred over ranking laps ourselves, for the same
reason FastF1's own order was preferred: it already encodes deleted laps,
segment eliminations and drivers who never set a time.

When `/session_result` is empty (it lags the flag, and older seasons are
patchier) the classification is derived from `/laps`, with laps the stewards
deleted removed using `/race_control` — a lap deleted for track limits keeps its
`lap_duration`, and ranking on it is the exact bug FastF1's `Deleted` flag was
loaded to avoid.

**Rate limits and the live lock.** OpenF1 allows a few requests a second, and
during any live session it 401s *every* unauthenticated request, past sessions
included. Both surface here as `None` from `fetch_json`, and every builder
returns `None` for "nothing usable" — callers treat that as "try again later",
never as a result to cache.

Kept free of pandas/FastF1 for the reason `openf1_sessions.py` documents.
"""

from __future__ import annotations

import re
import time

from .openf1_sessions import OPENF1_BASE, as_int, fetch_json

# OpenF1 `session_name` values, oldest naming last. 2023 called sprint
# qualifying the "Sprint Shootout".
SESSION_NAMES: dict[str, tuple[str, ...]] = {
    "FP1": ("Practice 1",),
    "FP2": ("Practice 2",),
    "FP3": ("Practice 3",),
    "SQ": ("Sprint Qualifying", "Sprint Shootout"),
}

# Pause between OpenF1 calls. Three calls a second is the documented free
# allowance; a 429 would fail soft into "try again next run" anyway.
REQUEST_GAP_SECONDS = 0.4


def format_lap(seconds) -> str:
    """`83.456` -> `"1:23.456"`, `59.1` -> `"59.100"`, anything else -> `""`."""
    try:
        value = float(seconds)
    except (TypeError, ValueError):
        return ""
    if value != value or value <= 0:
        return ""
    millis = int(round(value * 1000))
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1000)
    return f"{minutes}:{secs:02d}.{millis:03d}" if minutes else f"{secs}.{millis:03d}"


def find_session(sessions: list[dict], race_date: str, session_code: str) -> dict | None:
    """The OpenF1 session for `session_code` at the meeting racing on `race_date`.

    The meeting is identified by its *race* (the one session whose date Ergast
    and OpenF1 agree on), then the session by name within that meeting — never
    by date arithmetic, which a Saturday race or a calendar change would break.
    """
    names = SESSION_NAMES.get(session_code.upper())
    if not names or not race_date or not isinstance(sessions, list):
        return None
    race = next(
        (
            s for s in sessions
            if s.get("session_name") == "Race"
            and str(s.get("date_start", "")).startswith(race_date)
        ),
        None,
    )
    if race is None:
        return None
    meeting = race.get("meeting_key")
    return next(
        (
            s for s in sessions
            if s.get("meeting_key") == meeting and s.get("session_name") in names
        ),
        None,
    )


def _driver_fields(driver: dict | None, number) -> tuple[dict, dict]:
    driver = driver or {}
    given = (driver.get("first_name") or "").strip()
    family = (driver.get("last_name") or "").strip()
    if not (given or family):
        # `full_name` is "Lewis HAMILTON"; title-case only the shouted surname.
        parts = (driver.get("full_name") or "").split()
        if parts:
            given, family = " ".join(parts[:-1]), parts[-1].title()
    return (
        {
            "givenName": given,
            "familyName": family or (driver.get("name_acronym") or ""),
            "code": driver.get("name_acronym") or "",
            "permanentNumber": str(number) if number is not None else "",
        },
        {"name": driver.get("team_name") or ""},
    )


def _status(row: dict) -> str:
    for flag, label in (("dsq", "DSQ"), ("dns", "DNS"), ("dnf", "DNF")):
        if row.get(flag):
            return label
    return ""


def _segments(duration) -> list:
    """Sprint-qualifying `duration` is `[SQ1, SQ2, SQ3]`; practice is a scalar."""
    if isinstance(duration, list):
        return (duration + [None, None, None])[:3]
    return [duration, None, None]


def classification_from_results(
    results: list[dict], drivers: list[dict], session_code: str
) -> list[dict]:
    """Map `/session_result` rows to the API's result shape, in classified order.

    Rows without a position (no time set) keep OpenF1's order after the
    classified ones, matching how FastF1's order placed them.
    """
    by_number = {as_int(d.get("driver_number")): d for d in drivers or []}
    ranked = sorted(
        (r for r in results or [] if isinstance(r, dict)),
        key=lambda r: (as_int(r.get("position")) is None, as_int(r.get("position")) or 0),
    )
    is_sq = session_code.upper() == "SQ"
    rows = []
    for row in ranked:
        number = as_int(row.get("driver_number"))
        driver, constructor = _driver_fields(by_number.get(number), number)
        raw = _segments(row.get("duration"))
        segments = [format_lap(s) for s in raw]
        timed = [float(s) for s in raw if format_lap(s)]
        best = format_lap(min(timed)) if timed else ""
        position = as_int(row.get("position"))
        entry = {
            "position": str(position) if position is not None else "",
            "points": "0",
            "status": _status(row),
            "Driver": driver,
            "Constructor": constructor,
            "Time": {"time": best},
        }
        if is_sq:
            entry.update({"Q1": segments[0], "Q2": segments[1], "Q3": segments[2]})
        laps = as_int(row.get("number_of_laps"))
        if laps is not None:
            entry["laps"] = str(laps)
        rows.append(entry)
    return rows


# "CAR 81 (PIA) TIME 1:29.468 DELETED - TRACK LIMITS AT TURN 4 LAP 12 14:05:38"
_CAR = re.compile(r"\bCAR\s+(\d+)", re.IGNORECASE)
_TIME = re.compile(r"\bTIME\s+(\d+:\d{2}\.\d{3}|\d{1,2}\.\d{3})", re.IGNORECASE)


def deleted_laps(messages: list[dict]) -> set[tuple[int, str]]:
    """`(driver_number, lap time)` pairs race control deleted and did not reinstate.

    Keyed on the lap's TIME, not the "LAP n" in the message: race control
    counts laps differently from OpenF1's `/laps`. Measured on 2026 Brazil
    FP2: Albon's deletion says "LAP 15" with time 1:26.203, while OpenF1's lap
    15 for him is a legal 1:12.953 that the official classification counts.
    """
    deleted: set[tuple[int, str]] = set()
    for message in messages or []:
        text = str(message.get("message") or "")
        car, lap_time = _CAR.search(text), _TIME.search(text)
        if not car or not lap_time:
            continue
        key = (int(car.group(1)), lap_time.group(1))
        if re.search(r"\bREINSTATED\b", text, re.IGNORECASE):
            deleted.discard(key)
        elif re.search(r"\bDELETED\b", text, re.IGNORECASE):
            deleted.add(key)
    return deleted


def classification_from_laps(
    laps: list[dict], drivers: list[dict], messages: list[dict]
) -> list[dict]:
    """Rank drivers by their fastest legal lap. The fallback, not the source of truth."""
    void = deleted_laps(messages)
    best: dict[int, tuple[float, str]] = {}
    for lap in laps or []:
        number = as_int(lap.get("driver_number"))
        duration = lap.get("lap_duration")
        if number is None or not isinstance(duration, (int, float)) or duration <= 0:
            continue
        if lap.get("is_pit_out_lap") or (number, format_lap(duration)) in void:
            continue
        started = str(lap.get("date_start") or "")
        # Ties go to whoever set the time first, as on the official timing screen.
        if number not in best or (duration, started) < best[number]:
            best[number] = (duration, started)

    by_number = {as_int(d.get("driver_number")): d for d in drivers or []}
    rows = []
    for position, (number, (duration, _)) in enumerate(
        sorted(best.items(), key=lambda item: item[1]), start=1
    ):
        driver, constructor = _driver_fields(by_number.get(number), number)
        rows.append({
            "position": str(position),
            "points": "0",
            "status": "",
            "Driver": driver,
            "Constructor": constructor,
            "Time": {"time": format_lap(duration)},
        })
    return rows


def fetch_year_sessions(year: int) -> list[dict] | None:
    sessions = fetch_json(f"{OPENF1_BASE}/sessions", {"year": year})
    return sessions if isinstance(sessions, list) else None


def build_practice_openf1(
    year: int,
    race_date: str | None,
    session_code: str,
    *,
    sessions: list[dict] | None = None,
) -> list[dict] | None:
    """One practice/SQ classification from OpenF1, or None if there isn't one yet.

    `sessions` lets a caller syncing many sessions fetch the season's session
    list once instead of once per session.
    """
    if not race_date or session_code.upper() not in SESSION_NAMES:
        return None
    if sessions is None:
        sessions = fetch_year_sessions(year)
        time.sleep(REQUEST_GAP_SECONDS)
    session = find_session(sessions or [], race_date, session_code)
    if session is None:
        return None
    key = as_int(session.get("session_key"))
    if key is None:
        return None

    params = {"session_key": key}
    drivers = fetch_json(f"{OPENF1_BASE}/drivers", params)
    time.sleep(REQUEST_GAP_SECONDS)
    results = fetch_json(f"{OPENF1_BASE}/session_result", params)
    if isinstance(results, list) and results:
        rows = classification_from_results(results, drivers or [], session_code)
        if any(row["position"] for row in rows):
            return rows

    # Sprint qualifying's order encodes segment eliminations a fastest-lap
    # ranking cannot reproduce, so it waits for the official result instead.
    if session_code.upper() == "SQ":
        return None

    time.sleep(REQUEST_GAP_SECONDS)
    laps = fetch_json(f"{OPENF1_BASE}/laps", params)
    if not isinstance(laps, list) or not laps:
        return None
    time.sleep(REQUEST_GAP_SECONDS)
    messages = fetch_json(f"{OPENF1_BASE}/race_control", params)
    if messages is None:
        # Without race control there is no way to tell a deleted lap from a
        # legal one; a wrong order is worse than "not published yet".
        return None
    return classification_from_laps(laps, drivers or [], messages) or None
