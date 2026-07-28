"""Cross-season circuit history: first year raced, most wins, closest finish.

Sourced from Ergast/Jolpica's circuit-scoped endpoints
(`/circuits/{circuitId}/results/1` and `/results/2`), which carry the sport's
full result history back to 1950 — not from this app's own `races`/
`race_results` collections, which the nightly sync job only ever populates
for a handful of recent seasons (see `data_sync.py`'s `SYNC_YEARS`). An
earlier version of this endpoint aggregated purely over that local cache,
which silently reported whatever the *earliest locally-synced* season
happened to be as a circuit's "first year raced" — e.g. "2024" for
Silverstone, which has actually hosted a round since 1950, with the correct
year sitting right there in `circuit_details.track_information.first_grand_prix`
on the same circuit modal. Circuit-scoped Ergast history rarely changes (at
most once a season), so it's cached in `circuit_history_cache` (keyed by
`circuit_id`, with a day-long staleness check) rather than re-fetched from
Jolpica on every circuit-modal open.
"""

import asyncio
import datetime
import json
import re
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")

ERGAST_BASE = "https://api.jolpi.ca/ergast/f1"
USER_AGENT = "f1-scratch-api/1.0"
CACHE_MAX_AGE = datetime.timedelta(hours=24)

# Ergast gap strings look like "+1.234" or "+1:02.345"; a lapped/retired
# finisher gets "+1 Lap", "+2 Laps", or an empty string. Only a genuine
# seconds-based gap is a valid "closest finish" candidate.
_GAP_RE = re.compile(r"^\+?(?:(\d+):)?(\d+(?:\.\d+)?)$")


def parse_gap_seconds(time_str: str | None) -> float | None:
    """Parse an Ergast P2+ `Time.time` gap string into seconds, or None.

    Handles "+12.345" and "+1:02.345"; rejects "+1 Lap"/"+2 Laps", empty
    strings (retirements/DNFs), and anything else non-numeric.
    """
    if not time_str:
        return None
    text = time_str.strip()
    if not text:
        return None
    match = _GAP_RE.match(text)
    if not match:
        return None
    minutes, seconds = match.groups()
    total = float(seconds)
    if minutes:
        total += int(minutes) * 60
    return total


def _fetch_json(url: str, timeout: int = 15):
    try:
        request = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, json.JSONDecodeError, OSError):
        return None


def _utcnow_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _races_from(payload) -> list[dict]:
    return ((payload or {}).get("MRData") or {}).get("RaceTable", {}).get("Races", [])


def _pagination_from(payload) -> tuple[int, int]:
    """(limit, total) from an Ergast MRData envelope, defaulting to (0, 0) on a bad payload."""
    data = (payload or {}).get("MRData") or {}
    try:
        return int(data.get("limit", 0)), int(data.get("total", 0))
    except (TypeError, ValueError):
        return 0, 0


async def _fetch_all_races(path: str, page_size: int = 100, max_pages: int = 5) -> list[dict]:
    """Fetch every race for a circuit-scoped Ergast endpoint, paginating if needed.

    A circuit essentially never needs more than one page — F1 has run since
    1950, so ~75 seasons is the practical ceiling for even Monza — `max_pages`
    is a defensive cap against a runaway loop, not a real-world limit.
    """
    races: list[dict] = []
    offset = 0

    for _ in range(max_pages):
        payload = await asyncio.to_thread(
            _fetch_json, f"{ERGAST_BASE}{path}?limit={page_size}&offset={offset}"
        )
        page = _races_from(payload)
        if not page:
            break
        races.extend(page)

        _, total = _pagination_from(payload)
        offset += page_size
        if offset >= total:
            break

    return races


def first_year_raced(races: list[dict]) -> int | None:
    """Earliest `season` among a circuit's full race history."""
    seasons: list[int] = []
    for race in races:
        try:
            seasons.append(int(race.get("season")))
        except (TypeError, ValueError):
            continue
    return min(seasons) if seasons else None


def _winner(results: list[dict]) -> dict | None:
    return next((r for r in results if str(r.get("position")) == "1"), None)


def most_wins(winner_races: list[dict]) -> dict | None:
    """Tally P1 finishes by driver across a circuit's full race history.

    Each race is expected to carry its P1 `Results` entry (as returned by
    Ergast's `/circuits/{id}/results/1` endpoint). Ties report whichever
    driver was tallied first — not over-engineered per the roadmap note.
    """
    tally: dict[str, int] = {}
    order: list[str] = []

    for race in winner_races:
        winner = _winner(race.get("Results") or [])
        if not winner:
            continue
        driver = winner.get("Driver") or {}
        family_name = driver.get("familyName")
        if not family_name:
            continue
        given_name = driver.get("givenName") or ""
        name = f"{given_name} {family_name}".strip()

        if name not in tally:
            tally[name] = 0
            order.append(name)
        tally[name] += 1

    if not tally:
        return None

    top = max(order, key=lambda name: tally[name])
    return {"driver": top, "wins": tally[top]}


def closest_finish(runner_up_races: list[dict]) -> dict | None:
    """Smallest valid P1->P2 gap across a circuit's full race history.

    Each race is expected to carry its P2 `Results` entry (as returned by
    Ergast's `/circuits/{id}/results/2` endpoint), whose `Time.time` is
    already the gap behind the winner.
    """
    best = None

    for race in runner_up_races:
        results = race.get("Results") or []
        p2 = results[0] if results else None
        if not p2 or str(p2.get("position")) != "2":
            continue

        gap_seconds = parse_gap_seconds((p2.get("Time") or {}).get("time"))
        if gap_seconds is None:
            continue

        if best is None or gap_seconds < best["gap_seconds"]:
            try:
                season = int(race.get("season"))
            except (TypeError, ValueError):
                season = race.get("season")
            best = {
                "gap_seconds": gap_seconds,
                "season": season,
                "round": race.get("round"),
            }

    return best


async def _resolve_circuit_id(db, circuit_name: str) -> str | None:
    """Look up the Ergast `circuitId` for a circuit name from whatever's cached.

    Only needs one matching `races` document from any season — `circuitId` is
    stable across a circuit's whole history, so any cached round for this
    circuit resolves it.
    """
    race = await db.races.find_one(
        {"Circuit.circuitName": circuit_name}, {"_id": 0, "Circuit.circuitId": 1}
    )
    return ((race or {}).get("Circuit") or {}).get("circuitId") or None


async def _build_history(circuit_id: str) -> dict:
    winner_races = await _fetch_all_races(f"/circuits/{circuit_id}/results/1/")
    runner_up_races = await _fetch_all_races(f"/circuits/{circuit_id}/results/2/")

    response: dict = {}

    year = first_year_raced(winner_races)
    if year is not None:
        response["first_year"] = year

    wins = most_wins(winner_races)
    if wins is not None:
        response["most_wins"] = wins

    finish = closest_finish(runner_up_races)
    if finish is not None:
        response["closest_finish"] = finish

    return response


def _cache_is_fresh(cached: dict) -> bool:
    synced_at = cached.get("synced_at")
    try:
        age = datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(synced_at)
    except (TypeError, ValueError):
        return False
    return age < CACHE_MAX_AGE


@router.get("/circuit_history")
async def get_circuit_history(
    circuit_name: str = Query(
        ..., description="Circuit name as stored on races/circuit_details, e.g. 'Silverstone Circuit'"
    ),
):
    """Cross-season stats for one physical circuit: first year raced, most
    wins, closest finish — sourced from Ergast/Jolpica's full historical
    record, cached in `circuit_history_cache` for up to a day so repeat
    modal opens don't re-hit Jolpica. A circuit this app has never synced at
    all (no `races` document to resolve a `circuitId` from) omits every
    field rather than erroring; likewise for whichever individual field
    Ergast itself has nothing for.
    """
    db = get_db()

    cached = await db.circuit_history_cache.find_one({"circuit_name": circuit_name}, {"_id": 0})
    if cached and _cache_is_fresh(cached):
        cached.pop("synced_at", None)
        return JSONResponse(content=cached)

    circuit_id = await _resolve_circuit_id(db, circuit_name)
    if not circuit_id:
        return JSONResponse(content={"circuit_name": circuit_name})

    fields = await _build_history(circuit_id)
    response = {"circuit_name": circuit_name, **fields}

    try:
        await db.circuit_history_cache.update_one(
            {"circuit_name": circuit_name},
            {"$set": {**fields, "circuit_name": circuit_name, "synced_at": _utcnow_iso()}},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to cache circuit_history for {circuit_name}: {error}")

    return JSONResponse(content=response)
