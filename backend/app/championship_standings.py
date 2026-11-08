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


async def _fetch_and_cache_standings(collection, year: int, path: str, key: str) -> tuple[list[dict], int | None]:
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
        return [], None

    round_number = lists[0].get("round")
    round_number = int(round_number) if str(round_number or "").isdigit() else None
    update = {"season": year, "standings": standings, "synced_at": _utcnow_iso()}
    if round_number is not None:
        update["round"] = round_number
    try:
        await collection.update_one({"season": year}, {"$set": update}, upsert=True)
    except Exception as error:
        print(f"Failed to cache {key} for {year}: {error}")

    return standings, round_number


def _points(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def round_of_table(standings: list[dict], race_docs: list[dict], sprint_docs: list[dict], kind: str) -> int | None:
    """The round after which cumulative results reproduce `standings` exactly.

    Points are summed round by round from the stored race and sprint results
    and compared with the table's top two. Only an exact match is returned:
    "the last round with a result" is not good enough, because results and
    standings are published separately and the former can run a round ahead,
    which would undercount the rounds left to score.
    """
    def key(row: dict) -> str | None:
        if kind == "constructor":
            return (row.get("Constructor") or {}).get("constructorId")
        return (row.get("Driver") or {}).get("driverId")

    top = [(key(row), _points(row.get("points"))) for row in standings[:2]]
    if len(top) < 2 or any(k is None for k, _ in top):
        return None
    by_round: dict[int, list[list[dict]]] = {}
    for doc in list(race_docs) + list(sprint_docs):
        if str(doc.get("round", "")).isdigit():
            by_round.setdefault(int(doc["round"]), []).append(doc.get("results") or [])
    totals: dict[str, float] = {}
    for round_number in sorted(by_round):
        for results in by_round[round_number]:
            for row in results:
                k = key(row)
                if k:
                    totals[k] = totals.get(k, 0.0) + _points(row.get("points"))
        if all(totals.get(k, 0.0) == pts for k, pts in top):
            return round_number
    return None


async def _standings_round(db, year: int, doc: dict | None, kind: str) -> int | None:
    """The round a stored table describes; see `round_of_table` for the fallback.

    Synced documents record it. The round matters: the frontend counts the
    rounds still to score from it, and a clock-based count paired with a stale
    table once called a live title fight decided.
    """
    stored = (doc or {}).get("round")
    if isinstance(stored, int):
        return stored
    standings = (doc or {}).get("standings") or []
    if not standings:
        return None
    projection = {"_id": 0, "round": 1, "results.points": 1,
                  "results.Driver.driverId": 1, "results.Constructor.constructorId": 1}
    race_docs, sprint_docs = await asyncio.gather(
        db.race_results.find({"season": year}, projection).to_list(length=100),
        db.sprint_results.find({"season": year}, projection).to_list(length=100),
    )
    return round_of_table(standings, race_docs, sprint_docs, kind)


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
    standings_round = await _standings_round(db, year, doc, "driver") if doc else None

    if not driver_standings:
        driver_standings, standings_round = await _fetch_and_cache_standings(
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
        # The round the table describes, when known (older documents lack it).
        result["round"] = standings_round

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
    standings_round = await _standings_round(db, year, doc, "constructor") if doc else None

    if not constructor_standings:
        constructor_standings, standings_round = await _fetch_and_cache_standings(
            db.constructor_standings, year, "constructorstandings", "ConstructorStandings"
        )

    constructors_list = [c.get('Constructor', {}).get('name', '') for c in constructor_standings]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "constructors_list" in requested:
        result["constructors_list"] = constructors_list
    if "standings" in requested:
        result["constructor_standings"] = constructor_standings
        result["round"] = standings_round

    return JSONResponse(content=result)
