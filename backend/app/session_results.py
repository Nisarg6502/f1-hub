from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
import json
import os
import fastf1

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
    results_for_race = doc.get("results", []) if doc else []
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
    data = _fetch_json(f"{ERGAST_BASE}/{year}/{round}/qualifying/")
    races = data.get("MRData", {}).get("RaceTable", {}).get("Races", []) if data else []

    if not races:
        return JSONResponse(content={"race": {}, "results": []})

    race_data = races[0]
    results = race_data.get("QualifyingResults", [])
    race = {k: v for k, v in race_data.items() if k != "QualifyingResults"}
    return JSONResponse(content={"race": race, "results": results})


@router.get("/sprint_results")
async def get_sprint_results(
    year: int = Query(..., description="Year for which to fetch sprint results"),
    round: int = Query(..., description="Round number"),
):
    data = _fetch_json(f"{ERGAST_BASE}/{year}/{round}/sprint/")
    races = data.get("MRData", {}).get("RaceTable", {}).get("Races", []) if data else []

    if not races:
        return JSONResponse(content={"race": {}, "results": []})

    race_data = races[0]
    results = race_data.get("SprintResults", [])
    race = {k: v for k, v in race_data.items() if k != "SprintResults"}
    return JSONResponse(content={"race": race, "results": results})


@router.get("/session_classification")
async def get_session_classification(
    year: int = Query(..., description="Year for session classification"),
    round: int = Query(..., description="Round number"),
    session: str = Query(..., description="Session code like FP1, FP2, FP3, SQ, Q, S"),
):
    session_code = session.upper()
    try:
        ff1_session = fastf1.get_session(year, round, session_code)
        ff1_session.load(laps=False, telemetry=False, weather=False, messages=False, livedata=False)
        results_df = ff1_session.results
    except Exception as e:
        return JSONResponse(
            status_code=502,
            content={"error": "Failed to load session classification", "message": str(e), "results": []},
        )

    normalized_results = []
    for _, row in results_df.iterrows():
        full_name = str(row.get("FullName") or "").strip()
        given_name, family_name = _split_driver_name(full_name)
        time_value = row.get("Time")
        if time_value is not None:
            try:
                time_text = str(time_value)
            except Exception:
                time_text = ""
        else:
            time_text = ""

        normalized_results.append(
            {
                "position": str(row.get("Position") or ""),
                "points": str(row.get("Points") or ""),
                "status": str(row.get("Status") or ""),
                "Driver": {
                    "givenName": given_name,
                    "familyName": family_name,
                    "code": str(row.get("Abbreviation") or ""),
                    "permanentNumber": str(row.get("DriverNumber") or ""),
                },
                "Constructor": {
                    "name": str(row.get("TeamName") or ""),
                },
                "Time": {
                    "time": time_text,
                },
                "Q1": str(row.get("Q1") or "") if row.get("Q1") is not None else "",
                "Q2": str(row.get("Q2") or "") if row.get("Q2") is not None else "",
                "Q3": str(row.get("Q3") or "") if row.get("Q3") is not None else "",
            }
        )

    return JSONResponse(
        content={
            "session": session_code,
            "event_name": getattr(ff1_session.event, "EventName", ""),
            "results": normalized_results,
        }
    )
