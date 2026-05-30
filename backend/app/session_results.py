from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
import json
import os
import fastf1
import datetime

from .db import get_db

router = APIRouter(prefix="/api")
ERGAST_BASE = "https://api.jolpi.ca/ergast/f1"
USER_AGENT = "f1-scratch-api/1.0"
_cache_dir = os.path.join(os.path.dirname(__file__), "..", "..", "f1_cache")
os.makedirs(_cache_dir, exist_ok=True)
fastf1.Cache.enable_cache(_cache_dir)


def _fetch_json(url: str) -> dict | None:
    try:
        req = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(req, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, Exception):
        return None


def _split_driver_name(full_name: str) -> tuple[str, str]:
    parts = (full_name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return " ".join(parts[:-1]), parts[-1]


def _safe_str(value, fallback: str = "") -> str:
    """Safely convert a pandas/python value to string, handling NaN, NaT, None."""
    import pandas as pd
    if value is None:
        return fallback
    try:
        if pd.api.types.is_scalar(value) and pd.isna(value):
            return fallback
    except Exception:
        pass
    # Convert Timedelta to a readable string
    if isinstance(value, pd.Timedelta):
        total_seconds = value.total_seconds()
        if total_seconds <= 0:
            return fallback
        minutes, remainder = divmod(total_seconds, 60)
        seconds = remainder
        if minutes > 0:
            return f"{int(minutes)}:{seconds:06.3f}"
        return f"{seconds:.3f}"
    s = str(value).strip()
    if s.lower() in ("nan", "nat", "none", "", "<na>", "null"):
        return fallback
    return s


def _sanitize_result(result: dict) -> dict:
    """Clean one session result row before returning or caching it."""
    cleaned = dict(result or {})

    for key in ("number", "position", "positionText", "grid", "laps", "status", "Q1", "Q2", "Q3"):
        if key in cleaned:
            cleaned[key] = _safe_str(cleaned.get(key))

    if "points" in cleaned:
        cleaned["points"] = _safe_str(cleaned.get("points"), "0")

    driver = dict(cleaned.get("Driver") or {})
    if driver:
        cleaned["Driver"] = {
            **driver,
            "givenName": _safe_str(driver.get("givenName")),
            "familyName": _safe_str(driver.get("familyName")),
            "code": _safe_str(driver.get("code")),
            "permanentNumber": _safe_str(driver.get("permanentNumber")),
        }

    constructor = dict(cleaned.get("Constructor") or {})
    if constructor:
        cleaned["Constructor"] = {
            **constructor,
            "name": _safe_str(constructor.get("name")),
        }

    time_info = dict(cleaned.get("Time") or {})
    if time_info or "Time" in cleaned:
        cleaned["Time"] = {
            **time_info,
            "time": _safe_str(time_info.get("time")),
        }
        if "millis" in time_info:
            cleaned["Time"]["millis"] = _safe_str(time_info.get("millis"))

    fastest_lap = dict(cleaned.get("FastestLap") or {})
    if fastest_lap:
        fastest_time = dict(fastest_lap.get("Time") or {})
        cleaned["FastestLap"] = {
            **fastest_lap,
            "rank": _safe_str(fastest_lap.get("rank")),
            "lap": _safe_str(fastest_lap.get("lap")),
            "Time": {
                **fastest_time,
                "time": _safe_str(fastest_time.get("time")),
            },
        }

    return cleaned


def _sanitize_results(results: list[dict]) -> list[dict]:
    return [_sanitize_result(result) for result in (results or [])]


def _fastf1_results_to_api(results_df) -> list[dict]:
    normalized_results = []
    for _, row in results_df.iterrows():
        full_name = _safe_str(row.get("FullName"))
        given_name, family_name = _split_driver_name(full_name)
        normalized_results.append(
            _sanitize_result({
                "position": _safe_str(row.get("Position")),
                "points": _safe_str(row.get("Points"), "0"),
                "status": _safe_str(row.get("Status")),
                "Driver": {
                    "givenName": given_name,
                    "familyName": family_name,
                    "code": _safe_str(row.get("Abbreviation")),
                    "permanentNumber": _safe_str(row.get("DriverNumber")),
                },
                "Constructor": {
                    "name": _safe_str(row.get("TeamName")),
                },
                "Time": {
                    "time": _safe_str(row.get("Time")),
                },
                "Q1": _safe_str(row.get("Q1")),
                "Q2": _safe_str(row.get("Q2")),
                "Q3": _safe_str(row.get("Q3")),
            })
        )
    return normalized_results


def _normalize_ergast_result(res: dict, session_type: str) -> dict:
    """Normalize Ergast result format to match FastF1-like format used in session_classification."""
    driver = res.get("Driver", {})
    constructor = res.get("Constructor", {})
    time_info = res.get("Time", {})
    fastest_lap = res.get("FastestLap", {})
    
    normalized = {
        "position": str(res.get("position") or ""),
        "points": str(res.get("points") or "0"),
        "status": str(res.get("status") or ""),
        "Driver": {
            "givenName": driver.get("givenName", ""),
            "familyName": driver.get("familyName", ""),
            "code": driver.get("code", ""),
            "permanentNumber": driver.get("permanentNumber", ""),
        },
        "Constructor": {
            "name": constructor.get("name", ""),
        },
        "Time": {
            "time": time_info.get("time", ""),
        }
    }
    
    if session_type == "Q":
        normalized.update({
            "Q1": res.get("Q1", ""),
            "Q2": res.get("Q2", ""),
            "Q3": res.get("Q3", ""),
        })
    elif session_type == "R":
        # Add lap time info if available
        if fastest_lap:
            normalized["Time"]["time"] = fastest_lap.get("Time", {}).get("time", normalized["Time"]["time"])

    return _sanitize_result(normalized)


@router.get("/race_results")
async def get_results(
    year: int = Query(..., description="Year for which to fetch results"),
    round: int | None = Query(None, description="round number to fetch a single race results"),
    fields: str | None = Query(None, description="comma-separated fields: results,results_list,race"),
):
    db = get_db()

    query = {"season": year}
    if round is not None:
        query["round"] = str(round)

    doc = await db.race_results.find_one(
        query,
        {"_id": 0, "synced_at": 0},
    )

    selected_race = doc.get("race", {}) if doc else {}
    results_for_race = _sanitize_results(doc.get("results", [])) if doc else []

    if not results_for_race and round is not None:
        data = _fetch_json(f"{ERGAST_BASE}/{year}/{round}/results/")
        races = data.get("MRData", {}).get("RaceTable", {}).get("Races", []) if data else []
        if races:
            race_data = races[0]
            selected_race = {k: v for k, v in race_data.items() if k != "Results"}
            results_for_race = _sanitize_results(race_data.get("Results", []))
            if results_for_race:
                try:
                    await db.race_results.update_one(
                        {"season": year, "round": str(round)},
                        {"$set": {
                            "season": year,
                            "round": str(round),
                            "race": selected_race,
                            "results": results_for_race,
                            "synced_at": datetime.datetime.utcnow().isoformat(),
                        }},
                        upsert=True,
                    )
                except Exception as db_err:
                    print(f"Failed to cache race results fallback in DB: {db_err}")

    if not results_for_race and round is not None:
        try:
            ff1_session = fastf1.get_session(year, round, "R")
            ff1_session.load(laps=False, telemetry=False, weather=False, messages=False, livedata=False)
            results_df = ff1_session.results
            if not results_df.empty:
                results_for_race = _fastf1_results_to_api(results_df)
                if not selected_race:
                    selected_race = {"raceName": getattr(ff1_session.event, "EventName", "Race")}
                try:
                    await db.race_results.update_one(
                        {"season": year, "round": str(round)},
                        {"$set": {
                            "season": year,
                            "round": str(round),
                            "race": selected_race,
                            "results": results_for_race,
                            "synced_at": datetime.datetime.utcnow().isoformat(),
                        }},
                        upsert=True,
                    )
                except Exception as db_err:
                    print(f"Failed to cache race results FastF1 fallback in DB: {db_err}")
        except Exception:
            pass

    drivers_list = [
        (f"{res.get('Driver', {}).get('givenName', '')} {res.get('Driver', {}).get('familyName', '')}").strip()
        if res.get('Driver') else res.get('driverId', '')
        for res in results_for_race
    ]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "results" in requested and round is not None:
        result["results"] = results_for_race
    if "results_list" in requested and round is not None:
        result["results_list"] = drivers_list
    if "race" in requested and round is not None:
        result["race"] = selected_race

    # if nothing requested, provide a minimal default
    if not requested:
        result = {"race": selected_race, "results": results_for_race}

    return JSONResponse(content=result)


@router.get("/qualifying_results")
async def get_qualifying_results(
    year: int = Query(..., description="Year for which to fetch qualifying results"),
    round: int = Query(..., description="Round number"),
):
    db = get_db()
    doc = await db.qualifying_results.find_one(
        {"season": year, "round": str(round)},
        {"_id": 0, "synced_at": 0},
    )
    if doc:
        return JSONResponse(content={"race": doc.get("race", {}), "results": _sanitize_results(doc.get("results", []))})

    # Fallback to live fetch
    data = _fetch_json(f"{ERGAST_BASE}/{year}/{round}/qualifying/")
    races = data.get("MRData", {}).get("RaceTable", {}).get("Races", []) if data else []

    if not races:
        return JSONResponse(content={"race": {}, "results": []})

    race_data = races[0]
    results = _sanitize_results(race_data.get("QualifyingResults", []))
    race = {k: v for k, v in race_data.items() if k != "QualifyingResults"}

    # Cache in MongoDB so subsequent requests are instant
    if results:
        import datetime
        try:
            await db.qualifying_results.update_one(
                {"season": year, "round": str(round)},
                {"$set": {
                    "season": year,
                    "round": str(round),
                    "race": race,
                    "results": results,
                    "synced_at": datetime.datetime.utcnow().isoformat(),
                }},
                upsert=True,
            )
        except Exception as db_err:
            print(f"Failed to cache qualifying results fallback in DB: {db_err}")

    return JSONResponse(content={"race": race, "results": results})


@router.get("/sprint_results")
async def get_sprint_results(
    year: int = Query(..., description="Year for which to fetch sprint results"),
    round: int = Query(..., description="Round number"),
):
    db = get_db()
    doc = await db.sprint_results.find_one(
        {"season": year, "round": str(round)},
        {"_id": 0, "synced_at": 0},
    )
    if doc:
        return JSONResponse(content={"race": doc.get("race", {}), "results": _sanitize_results(doc.get("results", []))})

    # Fallback to live fetch
    data = _fetch_json(f"{ERGAST_BASE}/{year}/{round}/sprint/")
    races = data.get("MRData", {}).get("RaceTable", {}).get("Races", []) if data else []

    if not races:
        return JSONResponse(content={"race": {}, "results": []})

    race_data = races[0] if races else {}
    results = _sanitize_results(race_data.get("SprintResults", []))
    race = {k: v for k, v in race_data.items() if k != "SprintResults"}

    if not results:
        try:
            ff1_session = fastf1.get_session(year, round, "S")
            ff1_session.load(laps=False, telemetry=False, weather=False, messages=False, livedata=False)
            results_df = ff1_session.results
            if not results_df.empty:
                results = _fastf1_results_to_api(results_df)
                if not race:
                    race = {"raceName": getattr(ff1_session.event, "EventName", "Sprint")}
        except Exception:
            pass

    if not results:
        return JSONResponse(content={"race": {}, "results": []})

    # Cache in MongoDB so subsequent requests are instant
    if results:
        import datetime
        try:
            await db.sprint_results.update_one(
                {"season": year, "round": str(round)},
                {"$set": {
                    "season": year,
                    "round": str(round),
                    "race": race,
                    "results": results,
                    "synced_at": datetime.datetime.utcnow().isoformat(),
                }},
                upsert=True,
            )
        except Exception as db_err:
            print(f"Failed to cache sprint results fallback in DB: {db_err}")

    return JSONResponse(content={"race": race, "results": results})


@router.get("/session_classification")
async def get_session_classification(
    year: int = Query(..., description="Year for session classification"),
    round: int = Query(..., description="Round number"),
    session: str = Query(..., description="Session code like FP1, FP2, FP3, SQ, Q, S"),
):
    session_code = session.upper()
    db = get_db()

    # 1. Try fetching from MongoDB first
    if session_code in ["FP1", "FP2", "FP3", "SQ"]:
        doc = await db.practice_results.find_one({"season": year, "round": str(round), "session": session_code})
        if doc:
            return JSONResponse(content={
                "session": session_code,
                "event_name": doc.get("event_name", ""),
                "results": _sanitize_results(doc.get("results", []))
            })
    elif session_code == "Q":
        doc = await db.qualifying_results.find_one({"season": year, "round": str(round)})
        if doc:
            results = [_normalize_ergast_result(r, "Q") for r in doc.get("results", [])]
            return JSONResponse(content={
                "session": session_code,
                "event_name": doc.get("race", {}).get("raceName", ""),
                "results": results
            })
    elif session_code == "S":
        doc = await db.sprint_results.find_one({"season": year, "round": str(round)})
        if doc:
            results = [_normalize_ergast_result(r, "S") for r in doc.get("results", [])]
            return JSONResponse(content={
                "session": session_code,
                "event_name": doc.get("race", {}).get("raceName", ""),
                "results": results
            })
    elif session_code == "R":
        doc = await db.race_results.find_one({"season": year, "round": str(round)})
        if doc:
            results = [_normalize_ergast_result(r, "R") for r in doc.get("results", [])]
            return JSONResponse(content={
                "session": session_code,
                "event_name": doc.get("race", {}).get("raceName", ""),
                "results": results
            })

    # 2. Fallback to live FastF1 if not in DB
    try:
        ff1_session = fastf1.get_session(year, round, session_code)
        ff1_session.load(laps=False, telemetry=False, weather=False, messages=False, livedata=False)
        results_df = ff1_session.results
    except Exception as e:
        print(f"FastF1 session load failed for {year} R{round} {session_code}: {e}")
        return JSONResponse(
            content={"session": session_code, "event_name": "", "results": [], "error": str(e)},
        )

    normalized_results = _fastf1_results_to_api(results_df)

    # Save to MongoDB so subsequent requests are instant
    if normalized_results:
        import datetime
        try:
            if session_code in ["FP1", "FP2", "FP3", "SQ"]:
                await db.practice_results.update_one(
                    {"season": year, "round": str(round), "session": session_code},
                    {"$set": {
                        "season": year,
                        "round": str(round),
                        "session": session_code,
                        "event_name": getattr(ff1_session.event, "EventName", ""),
                        "results": normalized_results,
                        "synced_at": datetime.datetime.utcnow().isoformat(),
                    }},
                    upsert=True,
                )
            elif session_code == "Q":
                await db.qualifying_results.update_one(
                    {"season": year, "round": str(round)},
                    {"$set": {
                        "season": year,
                        "round": str(round),
                        "race": {"raceName": getattr(ff1_session.event, "EventName", "Qualifying")},
                        "results": normalized_results,
                        "synced_at": datetime.datetime.utcnow().isoformat(),
                    }},
                    upsert=True,
                )
            elif session_code == "S":
                await db.sprint_results.update_one(
                    {"season": year, "round": str(round)},
                    {"$set": {
                        "season": year,
                        "round": str(round),
                        "race": {"raceName": getattr(ff1_session.event, "EventName", "Sprint")},
                        "results": normalized_results,
                        "synced_at": datetime.datetime.utcnow().isoformat(),
                    }},
                    upsert=True,
                )
            elif session_code == "R":
                await db.race_results.update_one(
                    {"season": year, "round": str(round)},
                    {"$set": {
                        "season": year,
                        "round": str(round),
                        "race": {"raceName": getattr(ff1_session.event, "EventName", "Race")},
                        "results": normalized_results,
                        "synced_at": datetime.datetime.utcnow().isoformat(),
                    }},
                    upsert=True,
                )
        except Exception as db_err:
            print(f"Failed to cache session results in DB: {db_err}")

    return JSONResponse(
        content={
            "session": session_code,
            "event_name": getattr(ff1_session.event, "EventName", ""),
            "results": normalized_results,
        }
    )


@router.get("/race_weather")
async def get_race_weather(
    year: int = Query(..., description="Season year"),
    round: int = Query(..., description="Round number"),
):
    """Return cached weather data for a race, with OpenF1 fallback."""
    db = get_db()

    # 1. Try from MongoDB cache first
    doc = await db.weather_cache.find_one(
        {"season": year, "round": str(round)},
        {"_id": 0, "synced_at": 0},
    )
    if doc:
        return JSONResponse(content={"weather": doc})

    # 2. Fallback: try fetching from the races collection for the date
    race_doc = await db.races.find_one(
        {"season": year, "round": str(round)},
        {"date": 1, "_id": 0},
    )
    if not race_doc or not race_doc.get("date"):
        return JSONResponse(content={"weather": None})

    race_date = race_doc["date"]

    # 3. Try OpenF1 live
    try:
        sessions_url = f"https://api.openf1.org/v1/sessions?year={year}&session_type=Race"
        req = Request(sessions_url, headers={"User-Agent": USER_AGENT})
        with urlopen(req, timeout=10) as resp:
            sessions_data = json.loads(resp.read().decode("utf-8"))

        session = None
        for s in sessions_data:
            if s.get("date_start", "").startswith(race_date):
                session = s
                break

        if not session or not session.get("session_key"):
            return JSONResponse(content={"weather": None})

        weather_url = f"https://api.openf1.org/v1/weather?session_key={session['session_key']}"
        req2 = Request(weather_url, headers={"User-Agent": USER_AGENT})
        with urlopen(req2, timeout=10) as resp2:
            weather_data = json.loads(resp2.read().decode("utf-8"))

        if not weather_data or len(weather_data) == 0:
            return JSONResponse(content={"weather": None})

        mid_idx = len(weather_data) // 2
        weather = weather_data[mid_idx]

        # Cache for future use
        import datetime
        weather_doc = {
            "season": year,
            "round": str(round),
            "date": race_date,
            "air_temperature": weather.get("air_temperature"),
            "track_temperature": weather.get("track_temperature"),
            "wind_speed": weather.get("wind_speed"),
            "wind_direction": weather.get("wind_direction"),
            "rainfall": weather.get("rainfall", 0),
            "humidity": weather.get("humidity"),
            "pressure": weather.get("pressure"),
            "synced_at": datetime.datetime.utcnow().isoformat(),
        }
        try:
            await db.weather_cache.update_one(
                {"season": year, "round": str(round)},
                {"$set": weather_doc},
                upsert=True,
            )
        except Exception:
            pass

        return JSONResponse(content={"weather": weather_doc})

    except Exception as e:
        print(f"Failed to fetch weather from OpenF1 for {year} R{round}: {e}")
        return JSONResponse(content={"weather": None})
