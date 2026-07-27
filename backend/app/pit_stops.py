"""Pit stops per driver for a finished race, sourced from Ergast (Jolpica).

Deliberately *not* FastF1 or OpenF1. FastF1 reads `livetiming.formula1.com`,
which 403s datacenter IPs and fails soft (empty frame, no exception), so
anything built on it only ever populates when the sync job runs from a local
machine — see `race_stints`. OpenF1 now paywalls the whole current season.
Ergast answers from Cloud Run, so this endpoint can genuinely rebuild a cache
miss in production and the hourly job keeps itself up to date unattended.

Durations come back as strings and are *pit lane* time, not stationary time.
Two consequences the parsing below has to handle: a normal stop reads
"21.789", but a car sitting in the pits through a red flag reads "16:12.356",
so the format is not always plain seconds.
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

# Jolpica caps `limit` at 100 and defaults to 30; a race produces ~30-60 stops,
# so the default alone silently truncates. Paging is still needed because a
# chaotic wet race can exceed 100.
PAGE_SIZE = 100
MAX_PAGES = 5


def _fetch_json(url: str, timeout: int = 15):
    try:
        request = Request(url, headers={"User-Agent": USER_AGENT})
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, json.JSONDecodeError, OSError):
        return None


def _utcnow_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _as_int(value) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def parse_duration(value) -> float | None:
    """Ergast's `duration` string as seconds.

    Handles both "21.789" and the "M:SS.mmm" form a red-flagged stop produces.
    Returns None for anything unparseable so a single malformed row can't
    poison the aggregates the frontend computes.
    """
    if value is None:
        return None

    parts = str(value).strip().split(":")
    if not parts or len(parts) > 3:
        return None

    seconds = 0.0
    for part in parts:
        try:
            seconds = seconds * 60 + float(part)
        except ValueError:
            return None
    return round(seconds, 3)


def normalise_pit_stops(raw: list[dict]) -> list[dict]:
    """Reshape Ergast `PitStops` rows into the stored/served document shape.

    Ergast sends every numeric field as a string; the frontend sorts and
    averages these, so they are coerced once here rather than at each use.
    `duration_seconds` is kept alongside the original string because the raw
    value is what the UI displays for a red-flag stop. Rows without a driver,
    a lap or a usable duration are dropped — there is nothing to plot.
    """
    stops = []
    for row in raw or []:
        driver_id = (row.get("driverId") or "").strip()
        lap = _as_int(row.get("lap"))
        duration_seconds = parse_duration(row.get("duration"))
        if not driver_id or lap is None or duration_seconds is None:
            continue

        stops.append({
            "driver_id": driver_id,
            "lap": lap,
            "stop": _as_int(row.get("stop")) or 1,
            "duration": str(row.get("duration")),
            "duration_seconds": duration_seconds,
            "time": row.get("time") or None,
        })

    return sorted(stops, key=lambda s: (s["lap"], s["stop"], s["driver_id"]))


def fetch_pit_stops(year: int, round_number: int) -> list[dict] | None:
    """All pit stops for a race, paging until Ergast's `total` is satisfied.

    Returns None when the request fails outright, so the caller can tell a
    transport problem from a race that genuinely has no stops recorded.
    """
    collected: list[dict] = []
    total = None

    for page in range(MAX_PAGES):
        offset = page * PAGE_SIZE
        data = _fetch_json(
            f"{ERGAST_BASE}/{year}/{round_number}/pitstops.json"
            f"?limit={PAGE_SIZE}&offset={offset}"
        )
        if data is None:
            return None if not collected else normalise_pit_stops(collected)

        mrdata = data.get("MRData", {})
        if total is None:
            total = _as_int(mrdata.get("total")) or 0

        races = mrdata.get("RaceTable", {}).get("Races", [])
        rows = races[0].get("PitStops", []) if races else []
        if not rows:
            break

        collected.extend(rows)
        if len(collected) >= total:
            break

    return normalise_pit_stops(collected)


@router.get("/pit_stops")
async def get_pit_stops(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round_number: int = Query(..., alias="round", description="Round number within the season"),
):
    """Pit stops for a race, Mongo-first with an Ergast rebuild on a miss.

    A miss that returns nothing is not an error: pit-stop data is only
    published once a race has run, and the honest answer for a future round is
    "not available yet". `synced` tells the frontend which case it has. Unlike
    `race_stints` the rebuild here also works in production, so a cold round
    self-heals on first view rather than waiting for the local sync job.
    """
    db = get_db()

    doc = await db.pit_stops.find_one(
        {"season": year, "round": str(round_number)}, {"_id": 0, "synced_at": 0}
    )
    if doc and doc.get("stops"):
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "stops": doc["stops"],
            "synced": True,
        })

    stops = await asyncio.to_thread(fetch_pit_stops, year, round_number)
    if not stops:
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "stops": [],
            "synced": False,
        })

    try:
        await db.pit_stops.update_one(
            {"season": year, "round": str(round_number)},
            {"$set": {
                "season": year,
                "round": str(round_number),
                "stops": stops,
                "synced_at": _utcnow_iso(),
            }},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to self-heal pit_stops for {year} R{round_number}: {error}")

    return JSONResponse(content={
        "year": year,
        "round": round_number,
        "stops": stops,
        "synced": True,
    })
