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


def _round_key(document: dict) -> int:
    """Sort key for a round.

    Ergast stores `round` as a string, so sorting in Mongo puts "10" before "2".
    """
    try:
        return int(document.get("round", 0))
    except (TypeError, ValueError):
        return 0


async def _fetch_and_cache_races(db, year: int) -> list[dict]:
    """Live Ergast fallback for a season the nightly sync hasn't covered yet.

    The batch job only syncs the current season by default, so an unsynced
    year (e.g. picked via the season selector) would otherwise return an
    empty calendar forever — breaking the schedule page and every race-detail
    page for that year, since both key off this list. Mirrors the shape
    `data_sync.sync_races` writes, so this self-heals: the next request for
    the same season is served straight from Mongo.
    """
    data = await asyncio.to_thread(_fetch_json, f"{ERGAST_BASE}/{year}/races/")
    races = (data or {}).get("MRData", {}).get("RaceTable", {}).get("Races", [])
    if not races:
        return []

    for race in races:
        race["season"] = year
        try:
            await db.races.update_one(
                {"season": year, "round": race.get("round")},
                {"$set": {**race, "synced_at": _utcnow_iso()}},
                upsert=True,
            )
        except Exception as error:
            print(f"Failed to cache race {year} round {race.get('round')}: {error}")

    return races


@router.get("/races")
async def get_races(
    year: int = Query(..., description="Season year"),
    fields: str | None = Query(None, description="comma-separated: total,races,races_list"),
):
    db = get_db()
    races = await db.races.find({"season": year}, {"_id": 0, "synced_at": 0}).to_list(length=100)

    if not races:
        races = await _fetch_and_cache_races(db, year)

    races.sort(key=_round_key)

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()}
    if not requested:
        requested = {"total", "races_list", "races"}

    result = {}
    if "total" in requested:
        result["total_races"] = len(races)
    if "races_list" in requested:
        result["races_list"] = [race.get("raceName", "") for race in races]
    if "races" in requested:
        result["races"] = races

    return JSONResponse(content=result)


@router.get("/circuit_details")
async def get_circuit_details(
    year: int | None = Query(None, description="Season year; defaults to all seasons"),
):
    """Track-DNA details per round, as rendered by the circuits page."""
    db = get_db()
    query = {"season": year} if year is not None else {}
    details = await db.circuit_details.find(query, {"_id": 0, "synced_at": 0}).to_list(length=100)
    details.sort(key=_round_key)

    return JSONResponse(content={"circuit_details": details})
