"""Tyre stints per driver for a finished race, sourced from FastF1.

This used to come from OpenF1's `/stints` endpoint. It was re-sourced to FastF1
because OpenF1's paid tier had expanded to cover the *entire* current season
rather than just the documented live window (`/sessions?year=2026` itself 401'd),
which left the Pitwall chart permanently empty — that is why the code is shaped
this way. **That paywall has since lifted** (verified 2026-07-29: `/sessions`,
`/stints`, `/laps` and `/race_control` all return 200 for 2026), so OpenF1 is a
viable source again. FastF1's `session.laps` carries
`Stint`/`Compound`/`TyreLife`/`LapNumber` — the same information — so the chart
is currently served from there with the Mongo-first / self-heal pattern used by
`circuit_info`.

One caveat inherited from every other FastF1-backed feature here:
`livetiming.formula1.com` 403s datacenter IPs, so the live rebuild below only
succeeds when it runs on a local machine. In production the collection is
expected to be pre-populated by `data_sync.sync_race_stints`; the endpoint
reports an empty stint list rather than an error when it isn't, so the frontend
can say "not synced yet" rather than surfacing an error.
"""

import fastf1
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .f1_results import enable_cache

router = APIRouter(prefix="/api")

# Columns of `session.laps` this endpoint reads. Anything else on the frame is
# lap timing detail the stint chart has no use for.
LAP_COLUMNS = ("DriverNumber", "Stint", "Compound", "TyreLife", "LapNumber")


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


def stints_from_laps(laps: list[dict]) -> list[dict]:
    """Collapse lap rows into one record per (driver, stint).

    Kept independent of pandas so it can be exercised directly: the endpoint
    and the sync job both hand it plain row dicts. Rows missing a driver
    number or a stint number are dropped — without both there is nothing to
    group on — and groups are returned ordered by driver, then stint.
    """
    groups: dict[tuple[int, int], dict] = {}

    for lap in laps:
        driver_number = _as_int(lap.get("DriverNumber"))
        stint_number = _as_int(lap.get("Stint"))
        lap_number = _as_int(lap.get("LapNumber"))
        if driver_number is None or stint_number is None or lap_number is None:
            continue

        key = (driver_number, stint_number)
        group = groups.get(key)
        if group is None:
            group = groups[key] = {
                "driver_number": driver_number,
                "stint_number": stint_number,
                "lap_start": lap_number,
                "lap_end": lap_number,
                "compound": "UNKNOWN",
                "tyre_age_at_start": 0,
                # TyreLife is per-lap; the stint's starting age is the value on
                # its earliest lap, which is not necessarily the first row seen.
                "_age_at_lap": None,
            }

        group["lap_start"] = min(group["lap_start"], lap_number)
        group["lap_end"] = max(group["lap_end"], lap_number)

        compound = lap.get("Compound")
        if compound and group["compound"] == "UNKNOWN":
            group["compound"] = str(compound).upper()

        tyre_life = _as_int(lap.get("TyreLife"))
        if tyre_life is not None and (
            group["_age_at_lap"] is None or lap_number <= group["_age_at_lap"]
        ):
            group["_age_at_lap"] = lap_number
            group["tyre_age_at_start"] = tyre_life

    ordered = sorted(groups.values(), key=lambda s: (s["driver_number"], s["stint_number"]))
    for stint in ordered:
        stint.pop("_age_at_lap", None)
    return ordered


def build_race_stints(year: int, round_number: int) -> list[dict] | None:
    """Load a race from FastF1 and derive its stints.

    Returns None when the session can't be loaded at all (so the caller can
    tell "no data yet" apart from "this race doesn't exist"), and an empty
    list when it loaded but carried no usable laps.
    """
    enable_cache()

    try:
        session = fastf1.get_session(year, round_number, "R")
        session.load(laps=True, telemetry=False, weather=False, messages=False)
    except Exception as error:
        print(f"race stints R{round_number} {year} unavailable: {error}")
        return None

    try:
        laps = session.laps
        available = [column for column in LAP_COLUMNS if column in laps.columns]
        rows = laps[available].to_dict("records")
    except Exception as error:
        print(f"race stints R{round_number} {year} has no usable laps: {error}")
        return []

    return stints_from_laps(rows)


@router.get("/race_stints")
async def get_race_stints(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round_number: int = Query(..., alias="round", description="Round number within the season"),
):
    """Tyre stints for a race, Mongo-first with a FastF1 rebuild on a miss.

    A miss that can't be rebuilt is not an error: on Cloud Run the rebuild is
    always blocked, and the honest answer is that the local sync hasn't run for
    this round yet. `synced` tells the frontend which case it's looking at.
    """
    db = get_db()

    doc = await db.race_stints.find_one(
        {"season": year, "round": str(round_number)}, {"_id": 0, "synced_at": 0}
    )
    if doc and doc.get("stints"):
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "stints": doc["stints"],
            "synced": True,
        })

    stints = build_race_stints(year, round_number)
    if not stints:
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "stints": [],
            "synced": False,
        })

    try:
        await db.race_stints.update_one(
            {"season": year, "round": str(round_number)},
            {"$set": {"season": year, "round": str(round_number), "stints": stints}},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to self-heal race_stints for {year} R{round_number}: {error}")

    return JSONResponse(content={
        "year": year,
        "round": round_number,
        "stints": stints,
        "synced": True,
    })
