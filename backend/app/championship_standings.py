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
    """The last round whose Grand Prix the table includes, by exact points match.

    Points are summed session by session (each round's sprint, then its race)
    from the stored results and compared with the table's top two. Only an
    exact match is returned: "the last round with a result" is not good
    enough, because results and standings are published separately and the
    former can run a round ahead, which would undercount the rounds left.

    A table that matches after a round's sprint but before its race describes
    a weekend half run. That round's Grand Prix is still to score, so the round
    before is returned: counting the whole round as run dropped its race from
    the points left and could call a live title decided on Saturday night.
    Counting its sprint as still to come overstates what is left by one
    sprint, which only ever delays a call.
    """
    def key(row: dict) -> str | None:
        if kind == "constructor":
            return (row.get("Constructor") or {}).get("constructorId")
        return (row.get("Driver") or {}).get("driverId")

    top = [(key(row), _points(row.get("points"))) for row in standings[:2]]
    if len(top) < 2 or any(k is None for k, _ in top):
        return None
    def by_round(docs: list[dict]) -> dict[int, list[dict]]:
        return {
            int(doc["round"]): doc.get("results") or []
            for doc in docs
            if str(doc.get("round", "")).isdigit()
        }

    races, sprints = by_round(race_docs), by_round(sprint_docs)
    totals: dict[str, float] = {}

    def add(results: list[dict]) -> bool:
        for row in results:
            k = key(row)
            if k:
                totals[k] = totals.get(k, 0.0) + _points(row.get("points"))
        return all(totals.get(k, 0.0) == pts for k, pts in top)

    for round_number in sorted(set(races) | set(sprints)):
        if round_number in sprints and add(sprints[round_number]):
            return round_number - 1
        if round_number in races and add(races[round_number]):
            return round_number
    return None


async def _standings_round(db, year: int, doc: dict | None, kind: str) -> int | None:
    """The last round whose Grand Prix a standings table includes.

    The round matters: the frontend and the assistant count the rounds still
    to score from it, and a clock-based count paired with a stale table once
    called a live title fight decided.

    The points match (`round_of_table`) is preferred because it is evidence
    about this exact table. When it finds nothing (a result document missing,
    as with 2025's sprints), the round recorded at sync is used, less one if
    that round's Grand Prix has no result yet: Ergast numbers a table published
    after a sprint with the weekend's round.
    """
    standings = (doc or {}).get("standings") or []
    if not standings:
        return None
    projection = {"_id": 0, "round": 1, "results.points": 1,
                  "results.Driver.driverId": 1, "results.Constructor.constructorId": 1}
    race_docs, sprint_docs = await asyncio.gather(
        db.race_results.find({"season": year}, projection).to_list(length=100),
        db.sprint_results.find({"season": year}, projection).to_list(length=100),
    )
    derived = round_of_table(standings, race_docs, sprint_docs, kind)
    if derived is not None:
        return derived
    stored = (doc or {}).get("round")
    if not isinstance(stored, int) or isinstance(stored, bool):
        return None
    race_rounds = {
        int(d["round"]) for d in race_docs if str(d.get("round", "")).isdigit()
    }
    return stored if stored in race_rounds else stored - 1


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
        driver_standings, fetched_round = await _fetch_and_cache_standings(
            db.driver_standings, year, "driverstandings", "DriverStandings"
        )
        standings_round = await _standings_round(
            db, year, {"standings": driver_standings, "round": fetched_round}, "driver"
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
        constructor_standings, fetched_round = await _fetch_and_cache_standings(
            db.constructor_standings, year, "constructorstandings", "ConstructorStandings"
        )
        standings_round = await _standings_round(
            db,
            year,
            {"standings": constructor_standings, "round": fetched_round},
            "constructor",
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
