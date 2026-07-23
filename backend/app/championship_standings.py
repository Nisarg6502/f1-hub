import asyncio
import datetime
import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")

ERGAST_BASE = "https://api.jolpi.ca/ergast/f1"
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


async def _fetch_and_cache_standings(collection, year: int, path: str, key: str) -> list[dict]:
    """Live Ergast fallback for a season the nightly sync hasn't covered yet.

    The batch job in `data_sync.py` only syncs the current season by default
    (see `_years_to_sync`), so browsing an older year here would otherwise
    return an empty standings table forever. Mirrors the shape
    `data_sync._sync_standings` writes, so this self-heals: the next request
    for the same season is served straight from Mongo.
    """
    data = await asyncio.to_thread(_fetch_json, f"{ERGAST_BASE}/{year}/{path}/")
    lists = (data or {}).get("MRData", {}).get("StandingsTable", {}).get("StandingsLists", [])
    standings = lists[0].get(key, []) if lists else []
    if not standings:
        return []

    try:
        await collection.update_one(
            {"season": year},
            {"$set": {"season": year, "standings": standings, "synced_at": _utcnow_iso()}},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to cache {key} for {year}: {error}")

    return standings


@router.get("/driverstandings")
async def get_driver_standings(
    year: int = Query(..., description="Year for which to fetch the driver standings"),
    fields: str | None = Query(None, description="comma-separated fields: standings,standings_list"),
):
    db = get_db()
    doc = await db.driver_standings.find_one(
        {"season": year},
        {"_id": 0, "synced_at": 0},
    )

    driver_standings = doc.get("standings", []) if doc else []

    if not driver_standings:
        driver_standings = await _fetch_and_cache_standings(
            db.driver_standings, year, "driverstandings", "DriverStandings"
        )

    drivers_list = [
        (f"{d.get('Driver',{}).get('givenName','')} {d.get('Driver',{}).get('familyName','')}").strip()
        if d.get('Driver') else d.get('driverId', '')
        for d in driver_standings
    ]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "standings_list" in requested:
        result["standings_list"] = drivers_list
    if "standings" in requested:
        result["driver_standings"] = driver_standings

    return JSONResponse(content=result)


@router.get("/constructorstandings")
async def get_constructor_standings(
    year: int = Query(..., description="Year for which to fetch the constructor standings"),
    fields: str | None = Query(None, description="comma-separated fields: standings,constructors_list"),
):
    db = get_db()
    doc = await db.constructor_standings.find_one(
        {"season": year},
        {"_id": 0, "synced_at": 0},
    )

    constructor_standings = doc.get("standings", []) if doc else []

    if not constructor_standings:
        constructor_standings = await _fetch_and_cache_standings(
            db.constructor_standings, year, "constructorstandings", "ConstructorStandings"
        )

    constructors_list = [c.get('Constructor', {}).get('name', '') for c in constructor_standings]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "constructors_list" in requested:
        result["constructors_list"] = constructors_list
    if "standings" in requested:
        result["constructor_standings"] = constructor_standings

    return JSONResponse(content=result)
