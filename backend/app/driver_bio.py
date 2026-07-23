"""Driver bio + career stats, sourced from Ergast (via the Jolpica mirror).

Mongo-first against `driver_bios`, keyed by `driverId` (the same id already
returned on every driver-standings row, so the frontend never has to derive
it). A cache miss — or a doc older than `STALE_AFTER` — triggers a live
rebuild: one call for bio fields, three for win/P2/P3 totals (Jolpica reports
these as `MRData.total` on the position-filtered results endpoint, so no need
to page through the actual race list), one for pole totals, and one per
season the driver has raced for career championships — Jolpica's
`driverStandings` endpoint requires a season and has no driver-scoped
"all seasons" query, so there is no cheaper way to get an accurate count.
Everything fires concurrently via asyncio.gather/to_thread; it only runs on a
genuine cache miss, not on the hot path.
"""

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

# Career totals only change race-to-race, so a day-old cache is still good —
# this just keeps an active driver's stats from going stale for a whole season.
STALE_AFTER = datetime.timedelta(hours=24)


def _fetch_json(url: str, timeout: int = 15):
    try:
        request = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, json.JSONDecodeError, OSError):
        return None


async def _fetch(url: str):
    return await asyncio.to_thread(_fetch_json, url)


def _mrdata_total(data: dict | None) -> int:
    if not data:
        return 0
    try:
        return int(data.get("MRData", {}).get("total", 0))
    except (TypeError, ValueError):
        return 0


async def _fetch_bio_fields(driver_id: str) -> dict:
    data = await _fetch(f"{ERGAST_BASE}/drivers/{driver_id}.json")
    drivers = (data or {}).get("MRData", {}).get("DriverTable", {}).get("Drivers", [])
    driver = drivers[0] if drivers else {}
    return {
        "givenName": driver.get("givenName"),
        "familyName": driver.get("familyName"),
        "code": driver.get("code"),
        "permanentNumber": driver.get("permanentNumber"),
        "dateOfBirth": driver.get("dateOfBirth"),
        "nationality": driver.get("nationality"),
        "wikiUrl": driver.get("url"),
    }


async def _fetch_championships(driver_id: str) -> int:
    seasons_data = await _fetch(f"{ERGAST_BASE}/drivers/{driver_id}/seasons.json?limit=100")
    seasons = [
        s.get("season")
        for s in (seasons_data or {}).get("MRData", {}).get("SeasonTable", {}).get("Seasons", [])
        if s.get("season")
    ]
    if not seasons:
        return 0

    async def _is_champion(season: str) -> bool:
        data = await _fetch(f"{ERGAST_BASE}/{season}/drivers/{driver_id}/driverstandings.json")
        lists = (data or {}).get("MRData", {}).get("StandingsTable", {}).get("StandingsLists", [])
        standings = lists[0].get("DriverStandings", []) if lists else []
        return bool(standings) and standings[0].get("position") == "1"

    results = await asyncio.gather(*(_is_champion(season) for season in seasons))
    return sum(1 for won in results if won)


async def _build_driver_bio(driver_id: str) -> dict:
    bio, wins_data, p2_data, p3_data, poles_data, championships = await asyncio.gather(
        _fetch_bio_fields(driver_id),
        _fetch(f"{ERGAST_BASE}/drivers/{driver_id}/results/1.json?limit=1"),
        _fetch(f"{ERGAST_BASE}/drivers/{driver_id}/results/2.json?limit=1"),
        _fetch(f"{ERGAST_BASE}/drivers/{driver_id}/results/3.json?limit=1"),
        _fetch(f"{ERGAST_BASE}/drivers/{driver_id}/qualifying/1.json?limit=1"),
        _fetch_championships(driver_id),
    )

    wins = _mrdata_total(wins_data)
    second = _mrdata_total(p2_data)
    third = _mrdata_total(p3_data)

    return {
        **bio,
        "wins": wins,
        "podiums": wins + second + third,
        "poles": _mrdata_total(poles_data),
        "championships": championships,
    }


def _is_stale(doc: dict) -> bool:
    synced_at = doc.get("synced_at")
    if not synced_at:
        return True
    try:
        synced = datetime.datetime.fromisoformat(synced_at)
    except ValueError:
        return True
    return datetime.datetime.now(datetime.timezone.utc) - synced > STALE_AFTER


@router.get("/driver_bio")
async def get_driver_bio(
    driver_id: str = Query(..., description="Ergast driver id, e.g. 'max_verstappen' or 'albon'"),
):
    db = get_db()
    doc = await db.driver_bios.find_one({"driverId": driver_id}, {"_id": 0})

    if doc and not _is_stale(doc):
        doc.pop("synced_at", None)
        return JSONResponse(content=doc)

    bio = await _build_driver_bio(driver_id)

    if not bio.get("givenName"):
        # Ergast has nothing for this id on this attempt — prefer a stale
        # cache over a hard failure, and only fall back to a near-empty shape
        # if there's truly nothing stored yet.
        if doc:
            doc.pop("synced_at", None)
            return JSONResponse(content=doc)
        return JSONResponse(content={"driverId": driver_id, **bio})

    result = {"driverId": driver_id, **bio}
    record = {**result, "synced_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        await db.driver_bios.update_one({"driverId": driver_id}, {"$set": record}, upsert=True)
    except Exception as error:
        print(f"Failed to cache driver bio for {driver_id}: {error}")

    return JSONResponse(content=result)
