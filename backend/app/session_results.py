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


async def _cache_results(collection, key: dict, race: dict, results: list[dict]) -> None:
    """Upsert freshly fetched results so the next request is served from Mongo."""
    if not results:
        return
    try:
        await collection.update_one(
            key,
            {"$set": {**key, "race": race, "results": results, "synced_at": _utcnow_iso()}},
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
            db.race_results, {"season": year, "round": str(round)}, race, results
        )

    if not results and round is not None:
        # Ergast lags the chequered flag by a few hours; FastF1 usually has it sooner.
        try:
            event_name, results = load_session(year, round, "R")
            if results and not race:
                race = {"raceName": event_name}
            await _cache_results(
                db.race_results, {"season": year, "round": str(round)}, race, results
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

    if not results:
        try:
            event_name, results = load_session(year, round, "Q")
            if results and not race:
                race = {"raceName": event_name}
        except Exception as error:
            print(f"FastF1 qualifying fallback failed for {year} R{round}: {error}")

    await _cache_results(
        db.qualifying_results, {"season": year, "round": str(round)}, race, results
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

    if not results:
        try:
            event_name, results = load_session(year, round, "S")
            if results and not race:
                race = {"raceName": event_name}
        except Exception as error:
            print(f"FastF1 sprint fallback failed for {year} R{round}: {error}")

    if not results:
        return JSONResponse(content={"race": {}, "results": []})

    await _cache_results(
        db.sprint_results, {"season": year, "round": str(round)}, race, results
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
        if doc:
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
        return JSONResponse(content={"weather": doc})

    race_doc = await db.races.find_one({"season": year, "round": str(round)}, {"date": 1, "_id": 0})
    if not race_doc or not race_doc.get("date"):
        return JSONResponse(content={"weather": None})

    weather = fetch_openf1_weather(year, race_doc["date"])
    if not weather:
        return JSONResponse(content={"weather": None})

    weather_doc = {"season": year, "round": str(round), "date": race_doc["date"], **weather}
    try:
        await db.weather_cache.update_one(
            {"season": year, "round": str(round)},
            {"$set": {**weather_doc, "synced_at": _utcnow_iso()}},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to cache weather for {year} R{round}: {error}")

    return JSONResponse(content={"weather": weather_doc})


def fetch_openf1_weather(year: int, race_date: str) -> dict | None:
    """Mid-session weather for the race on `race_date`, or None if OpenF1 has none.

    Shared with the sync job so both read OpenF1 the same way.
    """
    sessions = _fetch_json(f"{OPENF1_BASE}/sessions?year={year}&session_type=Race", timeout=10)
    if not sessions:
        return None

    session = next(
        (s for s in sessions if (s.get("date_start") or "").startswith(race_date)), None
    )
    if not session or not session.get("session_key"):
        return None

    samples = _fetch_json(
        f"{OPENF1_BASE}/weather?session_key={session['session_key']}", timeout=10
    )
    if not samples:
        return None

    sample = samples[len(samples) // 2]
    return {
        "air_temperature": sample.get("air_temperature"),
        "track_temperature": sample.get("track_temperature"),
        "wind_speed": sample.get("wind_speed"),
        "wind_direction": sample.get("wind_direction"),
        "rainfall": sample.get("rainfall", 0),
        "humidity": sample.get("humidity"),
        "pressure": sample.get("pressure"),
    }
