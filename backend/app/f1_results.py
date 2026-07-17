"""Shared helpers for turning FastF1 session data into the API's result shape.

Both the live API (`session_results`) and the batch sync job (`data_sync`) need
to read sessions out of FastF1 and normalize them identically, so the logic
lives here rather than being duplicated in each.

The important quirk this module exists to paper over: FastF1 only populates
`Position`/`Time` in `session.results` for Qualifying and the Race. Practice and
sprint qualifying come back with the full driver list but every timing field
empty, so their classification has to be derived from the laps each driver
actually set. See `classification_from_laps`.
"""

import os
import tempfile

import fastf1
import pandas as pd

# Sessions FastF1 does not classify for us; their order comes from lap times.
LAP_TIMED_SESSIONS = frozenset({"FP1", "FP2", "FP3", "SQ"})

_cache_enabled = False


def enable_cache() -> None:
    """Point FastF1 at a writable cache directory (idempotent)."""
    global _cache_enabled
    if _cache_enabled:
        return
    cache_dir = os.getenv("FASTF1_CACHE_DIR") or os.path.join(
        tempfile.gettempdir(), "f1_cache"
    )
    os.makedirs(cache_dir, exist_ok=True)
    fastf1.Cache.enable_cache(cache_dir)
    _cache_enabled = True


def safe_str(value, fallback: str = "") -> str:
    """Convert a pandas/python value to a string, flattening NaN, NaT and None."""
    if value is None:
        return fallback
    try:
        if pd.api.types.is_scalar(value) and pd.isna(value):
            return fallback
    except Exception:
        pass

    if isinstance(value, pd.Timedelta):
        total_seconds = value.total_seconds()
        if total_seconds <= 0:
            return fallback
        # A race winner's total time runs past an hour, so hours must be split
        # out rather than rolled into the minutes field as "87:11.335".
        hours, remainder = divmod(total_seconds, 3600)
        minutes, seconds = divmod(remainder, 60)
        if hours > 0:
            return f"{int(hours)}:{int(minutes):02d}:{seconds:06.3f}"
        if minutes > 0:
            return f"{int(minutes)}:{seconds:06.3f}"
        return f"{seconds:.3f}"

    text = str(value).strip()
    if text.lower() in ("nan", "nat", "none", "", "<na>", "null"):
        return fallback
    return text


def safe_number(value, fallback: str = "") -> str:
    """Format a numeric value without a trailing `.0`.

    FastF1 stores positions and points as floats, so a raw string conversion
    yields "1.0" where the rest of the API (and Ergast) uses "1". Genuinely
    fractional values such as half points are preserved.
    """
    text = safe_str(value, fallback)
    if not text:
        return fallback
    try:
        number = float(text)
    except (TypeError, ValueError):
        return text
    return str(int(number)) if number.is_integer() else str(number)


def split_driver_name(full_name: str) -> tuple[str, str]:
    """Split a full name into given and family names."""
    parts = (full_name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return " ".join(parts[:-1]), parts[-1]


def sanitize_result(result: dict) -> dict:
    """Clean one session result row before returning or caching it."""
    cleaned = dict(result or {})

    for key in ("number", "grid", "laps", "status", "Q1", "Q2", "Q3"):
        if key in cleaned:
            cleaned[key] = safe_str(cleaned.get(key))

    for key in ("position", "positionText"):
        if key in cleaned:
            cleaned[key] = safe_number(cleaned.get(key))

    if "points" in cleaned:
        cleaned["points"] = safe_number(cleaned.get("points"), "0")

    driver = dict(cleaned.get("Driver") or {})
    if driver:
        cleaned["Driver"] = {
            **driver,
            "givenName": safe_str(driver.get("givenName")),
            "familyName": safe_str(driver.get("familyName")),
            "code": safe_str(driver.get("code")),
            "permanentNumber": safe_str(driver.get("permanentNumber")),
        }

    constructor = dict(cleaned.get("Constructor") or {})
    if constructor:
        cleaned["Constructor"] = {
            **constructor,
            "name": safe_str(constructor.get("name")),
        }

    time_info = dict(cleaned.get("Time") or {})
    if time_info or "Time" in cleaned:
        cleaned["Time"] = {**time_info, "time": safe_str(time_info.get("time"))}
        if "millis" in time_info:
            cleaned["Time"]["millis"] = safe_str(time_info.get("millis"))

    fastest_lap = dict(cleaned.get("FastestLap") or {})
    if fastest_lap:
        fastest_time = dict(fastest_lap.get("Time") or {})
        cleaned["FastestLap"] = {
            **fastest_lap,
            "rank": safe_number(fastest_lap.get("rank")),
            "lap": safe_number(fastest_lap.get("lap")),
            "Time": {**fastest_time, "time": safe_str(fastest_time.get("time"))},
        }

    return cleaned


def sanitize_results(results: list[dict]) -> list[dict]:
    return [sanitize_result(result) for result in (results or [])]


def has_classification(results: list[dict] | None) -> bool:
    """True if at least one row carries a position.

    Used to reject cached documents written before practice classification was
    derived from laps, so a bad cache entry heals itself on the next request
    instead of being served forever.
    """
    return any(safe_str(row.get("position")) for row in (results or []))


def results_to_api(results_df) -> list[dict]:
    """Normalize a FastF1 `session.results` frame into the API's result shape."""
    if results_df is None or results_df.empty:
        return []

    normalized = []
    for _, row in results_df.iterrows():
        given_name, family_name = split_driver_name(safe_str(row.get("FullName")))
        normalized.append(
            sanitize_result({
                "position": safe_number(row.get("Position")),
                "points": safe_number(row.get("Points"), "0"),
                "status": safe_str(row.get("Status")),
                "Driver": {
                    "givenName": given_name,
                    "familyName": family_name,
                    "code": safe_str(row.get("Abbreviation")),
                    "permanentNumber": safe_str(row.get("DriverNumber")),
                },
                "Constructor": {"name": safe_str(row.get("TeamName"))},
                "Time": {"time": safe_str(row.get("Time"))},
                "Q1": safe_str(row.get("Q1")),
                "Q2": safe_str(row.get("Q2")),
                "Q3": safe_str(row.get("Q3")),
            })
        )
    return normalized


def _loaded(session, attribute: str):
    """Read a FastF1 session property, or None if that data was never loaded.

    These are properties that raise `DataNotLoadedError` when their stream is
    absent rather than returning None, so `getattr(..., None)` does not guard
    them.
    """
    try:
        return getattr(session, attribute)
    except Exception:
        return None


def session_total_laps(session) -> int | None:
    """Scheduled lap count for a session, or None if FastF1 has no lap-count data."""
    total = _loaded(session, "total_laps")
    return int(total) if total else None


def _legal_timed_laps(session):
    """Laps with a time that still counts, or None if there are none.

    A lap deleted for track limits keeps its `LapTime`, so it has to be excluded
    explicitly or a driver gets credited with a lap that never counted. The
    `Deleted` flag is only populated when the session was loaded with
    `messages=True` — see `load_session`.
    """
    laps = _loaded(session, "laps")
    if laps is None or laps.empty or "LapTime" not in laps.columns:
        return None

    timed = laps.dropna(subset=["LapTime"])
    if "Deleted" in timed.columns:
        timed = timed[~timed["Deleted"].fillna(False).astype(bool)]

    return None if timed.empty else timed


def best_lap_by_driver(session) -> dict[str, str]:
    """Each driver's fastest legal lap, keyed by tla and already formatted.

    FastF1 leaves `Time` empty for practice and sprint qualifying even when it
    knows the classification, so the times have to come from the laps.
    """
    timed = _legal_timed_laps(session)
    if timed is None:
        return {}

    fastest = timed.groupby("Driver")["LapTime"].min()
    return {safe_str(code): safe_str(lap_time) for code, lap_time in fastest.items()}


def classification_from_laps(session) -> list[dict]:
    """Rank drivers by their fastest legal lap of the session.

    The fallback for when FastF1 reports no classification at all: order is
    inferred from the laps themselves. Where FastF1 does report positions they
    are preferred, because they encode elimination rules this cannot — see
    `load_session`.
    """
    timed_laps = _legal_timed_laps(session)
    if timed_laps is None:
        return []

    # Stable sort so that when two drivers set identical times, whoever set it
    # first keeps the place — the laps frame is already in chronological order.
    fastest_per_driver = timed_laps.loc[
        timed_laps.groupby("Driver")["LapTime"].idxmin()
    ].sort_values("LapTime", kind="stable")

    driver_meta = {}
    results_df = _loaded(session, "results")
    if results_df is not None and not results_df.empty:
        for _, row in results_df.iterrows():
            code = safe_str(row.get("Abbreviation"))
            if code:
                driver_meta[code] = row

    classification = []
    for position, (_, lap) in enumerate(fastest_per_driver.iterrows(), start=1):
        code = safe_str(lap.get("Driver"))
        meta = driver_meta.get(code)

        # Fall back to the lap row's own columns when the driver is missing
        # from the results frame.
        given_name, family_name = "", code
        team_name = safe_str(lap.get("Team"))
        driver_number = safe_str(lap.get("DriverNumber"))

        if meta is not None:
            full_name = safe_str(meta.get("FullName"))
            if full_name:
                given_name, family_name = split_driver_name(full_name)
            team_name = safe_str(meta.get("TeamName"), team_name)
            driver_number = safe_str(meta.get("DriverNumber"), driver_number)

        classification.append(
            sanitize_result({
                "position": str(position),
                "points": "0",
                "status": "",
                "Driver": {
                    "givenName": given_name,
                    "familyName": family_name,
                    "code": code,
                    "permanentNumber": driver_number,
                },
                "Constructor": {"name": team_name},
                "Time": {"time": safe_str(lap.get("LapTime"))},
            })
        )

    return classification


def load_session(year: int, round_number: int, session_code: str):
    """Load one session from FastF1 and return `(event_name, results)`.

    Raises whatever FastF1 raises when the session does not exist for the event
    — sprint weekends have no FP2/FP3, for instance — so callers can tell "no
    such session" apart from "session with no data".
    """
    enable_cache()
    session_code = session_code.upper()
    needs_laps = session_code in LAP_TIMED_SESSIONS

    session = fastf1.get_session(year, round_number, session_code)
    session.load(
        laps=needs_laps,
        telemetry=False,
        weather=False,
        # Race control messages are what mark laps as deleted. Without them the
        # Deleted flag is silently False everywhere and a lap chopped for track
        # limits would be ranked as if it counted.
        messages=needs_laps,
    )

    results = results_to_api(_loaded(session, "results"))

    if needs_laps:
        if has_classification(results):
            # FastF1 knows the order for these sessions once race control
            # messages are loaded, and that order is authoritative: it encodes
            # rules a fastest-lap ranking cannot, such as sprint-qualifying
            # segment eliminations, and it keeps drivers who set no legal lap.
            # Only `Time` is missing, so fill it from the laps.
            best_laps = best_lap_by_driver(session)
            for row in results:
                if not row["Time"]["time"]:
                    row["Time"]["time"] = best_laps.get(row["Driver"]["code"], "")
        else:
            results = classification_from_laps(session)

    return safe_str(getattr(session.event, "EventName", "")), results
