import datetime
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .f1_results import (
    has_classification,
    load_session,
    sanitize_result,
    sanitize_results,
)

router = APIRouter(prefix="/api")

ERGAST_BASE = "https://api.jolpi.ca/ergast/f1"
OPENF1_BASE = "https://api.openf1.org/v1"
USER_AGENT = "f1-scratch-api/1.0"


def _fetch_json(url: str, timeout: int = 15):
    try:
        request = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, json.JSONDecodeError, OSError):
        return None


def _utcnow_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _normalize_ergast_result(result: dict, session_type: str) -> dict:
    """Reshape an Ergast result into the flatter shape `/session_classification` returns."""
    driver = result.get("Driver", {})
    constructor = result.get("Constructor", {})
    time_info = result.get("Time", {})
    fastest_lap = result.get("FastestLap", {})

    normalized = {
        "position": result.get("position") or "",
        "points": result.get("points") or "0",
        "status": result.get("status") or "",
        "Driver": {
            "givenName": driver.get("givenName", ""),
            "familyName": driver.get("familyName", ""),
            "code": driver.get("code", ""),
            "permanentNumber": driver.get("permanentNumber", ""),
        },
        "Constructor": {"name": constructor.get("name", "")},
        "Time": {"time": time_info.get("time", "")},
    }

    if session_type == "Q":
        normalized.update({
            "Q1": result.get("Q1", ""),
            "Q2": result.get("Q2", ""),
            "Q3": result.get("Q3", ""),
        })
    elif session_type == "R" and fastest_lap:
        normalized["Time"]["time"] = (
            fastest_lap.get("Time", {}).get("time") or normalized["Time"]["time"]
        )

    return sanitize_result(normalized)


async def _cache_results(
    collection, key: dict, race: dict, results: list[dict], source: str
) -> None:
    """Upsert freshly fetched results so the next request is served from Mongo.

    `source` records which upstream the rows came from. Ergast carries fields
    the FastF1 fallback cannot (grid, laps, status, positionText, FastestLap,
    nationalities), so the sync uses this marker to replace a FastF1 stopgap
    once Ergast catches up, rather than treating any non-empty document as done.
    """
    if not results:
        return
    try:
        await collection.update_one(
            key,
            {"$set": {
                **key,
                "race": race,
                "results": results,
                "source": source,
                "synced_at": _utcnow_iso(),
            }},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to cache results for {key}: {error}")


def _fetch_ergast_session(year: int, round_number: int, path: str, results_key: str):
    """Fetch one session from Ergast, returning `(race, results)`."""
    data = _fetch_json(f"{ERGAST_BASE}/{year}/{round_number}/{path}/")
    races = data.get("MRData", {}).get("RaceTable", {}).get("Races", []) if data else []
    if not races:
        return {}, []

    race_data = races[0]
    race = {k: v for k, v in race_data.items() if k != results_key}
    return race, sanitize_results(race_data.get(results_key, []))


@router.get("/race_results")
async def get_race_results(
    year: int = Query(..., description="Season year"),
    round: int | None = Query(None, description="Round number"),
    fields: str | None = Query(None, description="comma-separated: race,results,results_list"),
):
    db = get_db()

    query: dict = {"season": year}
    if round is not None:
        query["round"] = str(round)

    doc = await db.race_results.find_one(query, {"_id": 0, "synced_at": 0})
    race = doc.get("race", {}) if doc else {}
    results = sanitize_results(doc.get("results", [])) if doc else []

    if not results and round is not None:
        race, results = _fetch_ergast_session(year, round, "results", "Results")
        await _cache_results(
            db.race_results, {"season": year, "round": str(round)}, race, results, "ergast"
        )

    if not results and round is not None:
        # Ergast lags the chequered flag by a few hours; FastF1 usually has it
        # sooner. This shape is thinner than Ergast's, so it is marked as such
        # and the sync replaces it once Ergast has the round.
        try:
            event_name, results = load_session(year, round, "R")
            if results and not race:
                race = {"raceName": event_name}
            await _cache_results(
                db.race_results, {"season": year, "round": str(round)}, race, results, "fastf1"
            )
        except Exception as error:
            print(f"FastF1 race fallback failed for {year} R{round}: {error}")

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()}

    if round is None:
        return JSONResponse(content={})

    if not requested:
        return JSONResponse(content={"race": race, "results": results})

    payload: dict = {}
    if "race" in requested:
        payload["race"] = race
    if "results" in requested:
        payload["results"] = results
    if "results_list" in requested:
        payload["results_list"] = [
            f"{r.get('Driver', {}).get('givenName', '')} "
            f"{r.get('Driver', {}).get('familyName', '')}".strip()
            for r in results
        ]
    return JSONResponse(content=payload)


@router.get("/qualifying_results")
async def get_qualifying_results(
    year: int = Query(..., description="Season year"),
    round: int = Query(..., description="Round number"),
):
    db = get_db()
    doc = await db.qualifying_results.find_one(
        {"season": year, "round": str(round)}, {"_id": 0, "synced_at": 0}
    )
    if doc:
        return JSONResponse(
            content={
                "race": doc.get("race", {}),
                "results": sanitize_results(doc.get("results", [])),
            }
        )

    race, results = _fetch_ergast_session(year, round, "qualifying", "QualifyingResults")
    source = "ergast"

    if not results:
        try:
            event_name, results = load_session(year, round, "Q")
            if results and not race:
                race = {"raceName": event_name}
            source = "fastf1"
        except Exception as error:
            print(f"FastF1 qualifying fallback failed for {year} R{round}: {error}")

    await _cache_results(
        db.qualifying_results, {"season": year, "round": str(round)}, race, results, source
    )
    return JSONResponse(content={"race": race, "results": results})


@router.get("/sprint_results")
async def get_sprint_results(
    year: int = Query(..., description="Season year"),
    round: int = Query(..., description="Round number"),
):
    db = get_db()
    doc = await db.sprint_results.find_one(
        {"season": year, "round": str(round)}, {"_id": 0, "synced_at": 0}
    )
    if doc:
        return JSONResponse(
            content={
                "race": doc.get("race", {}),
                "results": sanitize_results(doc.get("results", [])),
            }
        )

    race, results = _fetch_ergast_session(year, round, "sprint", "SprintResults")
    source = "ergast"

    if not results:
        try:
            event_name, results = load_session(year, round, "S")
            if results and not race:
                race = {"raceName": event_name}
            source = "fastf1"
        except Exception as error:
            print(f"FastF1 sprint fallback failed for {year} R{round}: {error}")

    if not results:
        return JSONResponse(content={"race": {}, "results": []})

    await _cache_results(
        db.sprint_results, {"season": year, "round": str(round)}, race, results, source
    )
    return JSONResponse(content={"race": race, "results": results})


@router.get("/session_classification")
async def get_session_classification(
    year: int = Query(..., description="Season year"),
    round: int = Query(..., description="Round number"),
    session: str = Query(..., description="Session code: FP1, FP2, FP3, SQ, Q, S or R"),
):
    session_code = session.upper()
    db = get_db()

    ergast_backed = {
        "Q": (db.qualifying_results, "raceName"),
        "S": (db.sprint_results, "raceName"),
        "R": (db.race_results, "raceName"),
    }

    if session_code in ("FP1", "FP2", "FP3", "SQ"):
        doc = await db.practice_results.find_one(
            {"season": year, "round": str(round), "session": session_code}
        )
        # Reject cache entries written before practice was classified from laps.
        if doc and has_classification(doc.get("results")):
            return JSONResponse(
                content={
                    "session": session_code,
                    "event_name": doc.get("event_name", ""),
                    "results": sanitize_results(doc.get("results", [])),
                }
            )
    elif session_code in ergast_backed:
        collection, _ = ergast_backed[session_code]
        doc = await collection.find_one({"season": year, "round": str(round)})
        # Same guard as practice: an unclassified document is refetched rather
        # than served forever.
        if doc and has_classification(doc.get("results")):
            return JSONResponse(
                content={
                    "session": session_code,
                    "event_name": doc.get("race", {}).get("raceName", ""),
                    "results": [
                        _normalize_ergast_result(r, session_code)
                        for r in doc.get("results", [])
                    ],
                }
            )

    try:
        event_name, results = load_session(year, round, session_code)
    except Exception as error:
        # Most often this is a session the event never had, e.g. FP2 on a
        # sprint weekend. The caller renders tabs from the schedule, so an
        # empty list is the right answer rather than a 500.
        print(f"FastF1 load failed for {year} R{round} {session_code}: {error}")
        return JSONResponse(
            content={"session": session_code, "event_name": "", "results": []}
        )

    if results:
        if session_code in ("FP1", "FP2", "FP3", "SQ"):
            try:
                await db.practice_results.update_one(
                    {"season": year, "round": str(round), "session": session_code},
                    {"$set": {
                        "season": year,
                        "round": str(round),
                        "session": session_code,
                        "event_name": event_name,
                        "results": results,
                        "synced_at": _utcnow_iso(),
                    }},
                    upsert=True,
                )
            except Exception as error:
                print(f"Failed to cache {session_code} for {year} R{round}: {error}")
        elif session_code in ergast_backed:
            collection, _ = ergast_backed[session_code]
            await _cache_results(
                collection,
                {"season": year, "round": str(round)},
                {"raceName": event_name},
                results,
                "fastf1",
            )

    return JSONResponse(
        content={
            "session": session_code,
            "event_name": event_name,
            "results": results,
        }
    )


@router.get("/race_weather")
async def get_race_weather(
    year: int = Query(..., description="Season year"),
    round: int = Query(..., description="Round number"),
):
    """Representative mid-race weather, cached in Mongo with an OpenF1 fallback."""
    db = get_db()

    doc = await db.weather_cache.find_one(
        {"season": year, "round": str(round)}, {"_id": 0, "synced_at": 0}
    )
    if doc:
        # Served as-is even when `weather_schema` is behind the current version.
        # `sync_weather` re-fetches stale rounds on its next hourly run, and the
        # frontend degrades to race-only conditions when `sessions` is absent —
        # both cheaper than making every request pay the seven OpenF1 calls a
        # full weekend re-read costs.
        return JSONResponse(content={"weather": doc})

    # `time` is projected as well as `date` — without it the settle gate below
    # cannot tell a race that finished an hour ago from one still running.
    race_doc = await db.races.find_one(
        {"season": year, "round": str(round)}, {"date": 1, "time": 1, "_id": 0}
    )
    if not race_doc or not race_doc.get("date"):
        return JSONResponse(content={"weather": None})

    weather = fetch_openf1_weather(year, race_doc["date"])
    if not weather:
        return JSONResponse(content={"weather": None})

    weather_doc = {"season": year, "round": str(round), "date": race_doc["date"], **weather}

    # Answer from a running race, but do NOT persist it.
    #
    # `sync_weather` is fed `_completed_rounds(..., settled=True)` — it waits
    # `RACE_DURATION_HOURS` precisely because weather is computed from the whole
    # session and "must not be derived from a half-run session"
    # (`SESSION_SETTLE_HOURS["Race"]`). This path had no equivalent gate, and
    # `sync_weather` skips any round already in `weather_cache`. The two
    # combined meant a single pageview during a live race wrote an early-race
    # sample that the hourly sync could then never correct: the round kept
    # whatever the weather was fifteen minutes in, permanently.
    #
    # Declining to cache costs one OpenF1 call per request for the ~4h a race
    # is unsettled, and the sync writes the real value afterwards.
    if not _race_has_settled(race_doc):
        return JSONResponse(content={"weather": weather_doc})

    try:
        await db.weather_cache.update_one(
            {"season": year, "round": str(round)},
            {"$set": {**weather_doc, "synced_at": _utcnow_iso()}},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to cache weather for {year} R{round}: {error}")

    return JSONResponse(content={"weather": weather_doc})


def _race_has_settled(race_doc: dict) -> bool:
    """True once the race is far enough past its start to summarise as a whole.

    Imported lazily, and from `data_sync`, so the gate here and the one the
    sync applies are the same number rather than two constants that can drift.
    `data_sync` already imports this module inside a function body, so the
    dependency stays one-directional at import time.
    """
    from .data_sync import RACE_DURATION_HOURS, _session_start

    start = _session_start(race_doc.get("date"), race_doc.get("time"))
    if start is None:
        # No usable start time: treat as settled rather than refusing to cache
        # forever. Historical rounds are the only way to get here.
        return True
    return start + datetime.timedelta(hours=RACE_DURATION_HOURS) < datetime.datetime.now(
        datetime.timezone.utc
    )


# Bumped whenever the shape of a `weather_cache` document changes.
#
# `sync_weather` is a write-once cache — it skips any round it already has —
# so without a version marker an improvement to this module would only ever
# reach rounds synced after the deploy, and every existing round would keep
# its old shape forever. The alternative was `FORCE_RESYNC=1`, which re-fetches
# every collection in the database to fix one of them.
#
# 2: per-session weather (`sessions`), and `rainfall` computed over the whole
#    session rather than read from a single midpoint sample.
WEATHER_SCHEMA_VERSION = 2

# Ergast/Jolpica schedule field -> OpenF1 `session_name`.
#
# Keys are the field names the race document and the frontend's `SessionKey`
# already use, so a caller never has to translate. Verified against OpenF1 for
# 2023-2026: these seven names are stable across all four seasons. Pre-season
# testing appears there as "Day 1/2/3" and is excluded by construction, since
# sessions are looked up by the race weekend's `meeting_key`.
OPENF1_SESSION_NAMES: dict[str, str] = {
    "FirstPractice": "Practice 1",
    "SecondPractice": "Practice 2",
    "ThirdPractice": "Practice 3",
    "SprintQualifying": "Sprint Qualifying",
    "Sprint": "Sprint",
    "Qualifying": "Qualifying",
    "Race": "Race",
}


def _summarise_weather(samples: list) -> dict | None:
    """Reduce a session's weather samples to the figures the UI shows."""
    if not samples:
        return None

    # Temperatures, wind, humidity and pressure are a MIDPOINT sample — a
    # single representative instant, which is what the tile presents them as.
    # The sample window brackets the session (checked against OpenF1: Interlagos
    # 2024's race samples run 14:38-17:58 around a 15:30 start), so the middle
    # of the list really is the middle of the session.
    sample = samples[len(samples) // 2]

    # Rainfall is the one field a midpoint cannot honestly answer. OpenF1's
    # `rainfall` is a 0/1 indicator per sample and the tile renders it as
    # "Rain: Yes/No" — a claim about the session, not about one minute of it.
    # Read from the midpoint alone, any session whose rain fell outside that
    # minute was reported bone dry. Interlagos 2024 had 117 of 201 race samples
    # wet: the midpoint happened to be one of them, so the old value was right
    # by luck rather than by method.
    wet = sum(1 for s in samples if s.get("rainfall"))

    # `rainfall` stays a 0/1 indicator so every existing consumer and every
    # cached document keeps working. `rainfall_share` is the honest companion:
    # a bare "Yes" from `any()` cannot tell a 21%-wet sprint from one stray
    # sample, and picking a cutoff between them would be inventing a threshold
    # the data does not carry. Reporting the proportion lets the UI say how wet
    # without either of us guessing. (Interlagos 2024, measured: sprint 16/76
    # samples wet, race 117/201, qualifying 0/62.)
    return {
        "air_temperature": sample.get("air_temperature"),
        "track_temperature": sample.get("track_temperature"),
        "wind_speed": sample.get("wind_speed"),
        "wind_direction": sample.get("wind_direction"),
        "rainfall": 1 if wet else 0,
        "rainfall_share": round(wet / len(samples), 3),
        "humidity": sample.get("humidity"),
        "pressure": sample.get("pressure"),
    }


def _find_race_session(year: int, race_date: str) -> dict | None:
    """The OpenF1 Race session for `race_date`, or None.

    `session_type=Race` also returns sprints — verified against OpenF1, where a
    sprint carries `session_type: "Race"` with `session_name: "Sprint"` — so the
    name is checked as well as the date. No 2024-2026 weekend runs both on one
    calendar day, which is why matching on date alone worked; it is one calendar
    change away from silently returning sprint weather for a grand prix.
    """
    sessions = _fetch_json(f"{OPENF1_BASE}/sessions?year={year}&session_type=Race", timeout=10)
    if not sessions:
        return None
    return next(
        (
            s
            for s in sessions
            if (s.get("date_start") or "").startswith(race_date)
            and s.get("session_name") == "Race"
        ),
        None,
    )


def fetch_openf1_weekend_weather(year: int, race_date: str) -> dict | None:
    """Weather for every session of the weekend whose race falls on `race_date`.

    Returns the race's own figures at the top level — the shape every existing
    `weather_cache` document and API consumer already expects — plus a
    `sessions` map keyed by Ergast schedule field.

    The per-session data exists because the conditions tile sits above a tab
    strip covering practice, qualifying and the sprint, and showed race weather
    for all of them. Interlagos 2024 is the clearest case: the sprint ran at
    48.0C track and dry, while the race it was borrowing from was 24.9C and
    wet.

    Costs one `sessions` call plus one `weather` call per session (about seven
    per round) against OpenF1's free, unauthenticated API, and only for rounds
    not already cached at the current schema version.
    """
    race_session = _find_race_session(year, race_date)
    if not race_session or not race_session.get("meeting_key"):
        return None

    weekend = _fetch_json(
        f"{OPENF1_BASE}/sessions?meeting_key={race_session['meeting_key']}", timeout=10
    )
    if not weekend:
        return None

    by_name = {s.get("session_name"): s for s in weekend if s.get("session_key")}

    sessions: dict[str, dict] = {}
    for field, openf1_name in OPENF1_SESSION_NAMES.items():
        session = by_name.get(openf1_name)
        if not session:
            continue
        summary = _summarise_weather(
            _fetch_json(f"{OPENF1_BASE}/weather?session_key={session['session_key']}", timeout=10)
            or []
        )
        if summary:
            sessions[field] = summary

    race = sessions.get("Race")
    if not race:
        return None

    return {**race, "sessions": sessions, "weather_schema": WEATHER_SCHEMA_VERSION}


def fetch_openf1_weather(year: int, race_date: str) -> dict | None:
    """Back-compatible alias: weekend weather, race figures at the top level.

    Kept because `data_sync.sync_weather` imports this name.
    """
    return fetch_openf1_weekend_weather(year, race_date)
