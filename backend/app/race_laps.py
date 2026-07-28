"""Track position per lap for a finished race, sourced from FastF1.

Powers the Pitwall "Lap Telemetry" position chart. `session.laps` already
carries a `Position` column alongside the `Stint`/`Compound`/`TyreLife` data
`race_stints` reads from the same DataFrame, so this needs no new FastF1 API
surface -- just a different subset of columns off the same load. Served with
the same Mongo-first / self-heal pattern as `circuit_info` and `race_stints`.

Scoped to track position only, not gap-to-leader in seconds: a time-based gap
needs cumulative race-time reconstruction per driver (pit stops, retirements,
and lapped traffic all complicate it), which is a materially bigger endpoint
than this one. Position-per-lap is the standard "who overtook whom" chart and
is free from data FastF1 already provides.

Same FastF1-on-Cloud-Run caveat as every other FastF1-backed feature here:
`livetiming.formula1.com` 403s datacenter IPs, so the live rebuild below only
succeeds when it runs on a local machine. In production the collection is
expected to be pre-populated by `data_sync.sync_race_laps`.
"""

import fastf1
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .f1_results import enable_cache

router = APIRouter(prefix="/api")

# Columns of `session.laps` this endpoint reads. Anything else on the frame is
# lap timing detail the position chart has no use for.
LAP_COLUMNS = ("DriverNumber", "LapNumber", "Position")


def _as_int(value) -> int | None:
    """Coerce a pandas/NumPy scalar to a plain int, or None if it isn't one."""
    if value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    # NaN survives int() on some numpy types but never equals itself as a float.
    return None if number != number else number


def positions_from_laps(laps: list[dict]) -> list[dict]:
    """Flatten lap rows into one record per (driver, lap) with a position.

    Kept independent of pandas so it can be exercised directly: the endpoint
    and the sync job both hand it plain row dicts. Rows missing a driver
    number, lap number, or position are dropped -- a driver who retired mid-
    race simply has no rows past their last completed lap, which the chart
    reads as "line ends here" rather than a gap to fill in.
    """
    rows: list[dict] = []
    for lap in laps:
        driver_number = _as_int(lap.get("DriverNumber"))
        lap_number = _as_int(lap.get("LapNumber"))
        position = _as_int(lap.get("Position"))
        if driver_number is None or lap_number is None or position is None:
            continue
        rows.append({
            "driver_number": driver_number,
            "lap_number": lap_number,
            "position": position,
        })

    rows.sort(key=lambda r: (r["driver_number"], r["lap_number"]))
    return rows


def build_race_laps(year: int, round_number: int) -> list[dict] | None:
    """Load a race from FastF1 and derive its per-lap positions.

    Returns None when the session can't be loaded at all (so the caller can
    tell "no data yet" apart from "this race doesn't exist"), and an empty
    list when it loaded but carried no usable laps.
    """
    enable_cache()

    try:
        session = fastf1.get_session(year, round_number, "R")
        session.load(laps=True, telemetry=False, weather=False, messages=False)
    except Exception as error:
        print(f"race laps R{round_number} {year} unavailable: {error}")
        return None

    try:
        laps = session.laps
        available = [column for column in LAP_COLUMNS if column in laps.columns]
        rows = laps[available].to_dict("records")
    except Exception as error:
        print(f"race laps R{round_number} {year} has no usable laps: {error}")
        return []

    return positions_from_laps(rows)


@router.get("/race_laps")
async def get_race_laps(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round_number: int = Query(..., alias="round", description="Round number within the season"),
):
    """Per-lap track position for a race, Mongo-first with a FastF1 rebuild on a miss.

    A miss that can't be rebuilt is not an error: on Cloud Run the rebuild is
    always blocked, and the honest answer is that the local sync hasn't run for
    this round yet. `synced` tells the frontend which case it's looking at.
    """
    db = get_db()

    doc = await db.race_laps.find_one(
        {"season": year, "round": str(round_number)}, {"_id": 0, "synced_at": 0}
    )
    if doc and doc.get("laps"):
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "laps": doc["laps"],
            "synced": True,
        })

    laps = build_race_laps(year, round_number)
    if not laps:
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "laps": [],
            "synced": False,
        })

    try:
        await db.race_laps.update_one(
            {"season": year, "round": str(round_number)},
            {"$set": {"season": year, "round": str(round_number), "laps": laps}},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to self-heal race_laps for {year} R{round_number}: {error}")

    return JSONResponse(content={
        "year": year,
        "round": round_number,
        "laps": laps,
        "synced": True,
    })
