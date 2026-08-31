"""Tyre stints per driver for a finished race, sourced from OpenF1 or FastF1.

This originally came from OpenF1's `/stints`, was re-sourced to FastF1 when
OpenF1's paid tier expanded to cover the *entire* current season rather than
just the documented live window (`/sessions?year=2026` itself 401'd), leaving
the Pitwall chart permanently empty — that history is why the FastF1 path
exists. **That paywall has since lifted** (verified 2026-07-29: `/sessions`,
`/stints`, `/laps` and `/race_control` all return 200 for 2026), so OpenF1 is
the primary source again.

Served Mongo-first, with a two-stage rebuild on a cache miss:

1. **OpenF1 `/stints`** — one row per (driver, stint) with exactly the fields
   this app stores, and reachable from a datacenter IP. This is what makes the
   self-heal work in production. It only covers 2023 onwards.
2. **FastF1** — `session.laps` carries `Stint`/`Compound`/`TyreLife`/`LapNumber`,
   which `stints_from_laps` collapses into the same shape. Reads
   `livetiming.formula1.com`, which 403s datacenter IPs *and fails soft* (empty
   frames, no exception), so in practice this only succeeds from a local
   machine — which is why it sits behind OpenF1 rather than in front of it.
   It remains the only option for pre-2023 seasons.

The whole rebuild failing is still not an error: the endpoint reports an empty
stint list so the frontend can say "not synced yet". `data_sync.sync_race_stints`
also pre-populates the collection when run locally.
"""

import fastf1
import httpx
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .f1_results import enable_cache

router = APIRouter(prefix="/api")

# Re-exported: these live in their own module so the team-radio transcription
# job can reach the session lookup without importing this one (and therefore
# fastf1, and therefore NumPy's OpenMP runtime, which segfaults CTranslate2 on
# Windows — see `openf1_sessions.py`'s docstring). Callers of
# `race_stints.fetch_openf1_session_key` are unaffected.
from .openf1_sessions import (  # noqa: F401
    OPENF1_BASE,
    fetch_openf1_session_key,
    fetch_openf1_sprint_key,
)

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


def _fetch_json(url: str, params: dict | None = None, timeout: float = 20.0):
    """GET `url` and decode JSON, or None on any failure.

    Mirrors `session_recap._fetch_json` — same upstream (OpenF1), same
    "enrichment, never a hard dependency" posture: a failure here just falls
    through to the FastF1 path rather than surfacing as an error.
    """
    try:
        response = httpx.get(url, params=params, timeout=timeout)
        if response.status_code != 200:
            return None
        return response.json()
    except (httpx.HTTPError, ValueError):
        return None




def stints_from_openf1(rows: list[dict]) -> list[dict]:
    """Reshape OpenF1 `/stints` rows into this app's stint documents.

    OpenF1 already publishes one row per (driver, stint) with exactly the
    fields the chart needs, so unlike `stints_from_laps` there is no grouping
    to do — only coercion, defaulting, and ordering, so that a document built
    here is indistinguishable in shape from one built from FastF1 laps.

    One convention difference worth knowing: OpenF1's `tyre_age_at_start` is
    0 for a fresh set, whereas FastF1's `TyreLife` counts the stint's opening
    lap as 1, so the same stint reads one lower here. The value is carried
    through verbatim rather than shifted — the field is named after OpenF1's
    and this shape originated there — and the chart does not render it.
    """
    stints: list[dict] = []

    for row in rows:
        driver_number = _as_int(row.get("driver_number"))
        stint_number = _as_int(row.get("stint_number"))
        lap_start = _as_int(row.get("lap_start"))
        lap_end = _as_int(row.get("lap_end"))
        if driver_number is None or stint_number is None:
            continue
        if lap_start is None or lap_end is None:
            continue

        compound = row.get("compound")
        tyre_age = _as_int(row.get("tyre_age_at_start"))
        stints.append({
            "driver_number": driver_number,
            "stint_number": stint_number,
            "lap_start": lap_start,
            "lap_end": max(lap_start, lap_end),
            "compound": str(compound).upper() if compound else "UNKNOWN",
            "tyre_age_at_start": tyre_age if tyre_age is not None else 0,
        })

    stints.sort(key=lambda s: (s["driver_number"], s["stint_number"]))
    return stints


def build_race_stints_openf1(race_date: str) -> list[dict] | None:
    """Stints for the race on `race_date` via OpenF1, or None if it has none.

    Unlike the FastF1 path this works from a datacenter IP, which is what makes
    the endpoint's self-heal reachable in production at all. Coverage starts at
    2023 — `/sessions?year=2022` 404s — so older seasons still need FastF1.
    """
    session_key = fetch_openf1_session_key(race_date)
    if session_key is None:
        return None

    rows = _fetch_json(f"{OPENF1_BASE}/stints", {"session_key": session_key})
    if not isinstance(rows, list) or not rows:
        return None

    return stints_from_openf1(rows) or None


async def _race_date(db, year: int, round_number: int) -> str | None:
    """The `YYYY-MM-DD` date of a round, from the already-synced `races` collection.

    OpenF1 has no notion of a championship round number, so its session lookup
    has to go through the date. `races` is populated for every season the app
    serves, so this is a local read rather than another upstream call.
    """
    try:
        race = await db.races.find_one(
            {"season": year, "round": str(round_number)}, {"_id": 0, "date": 1}
        )
    except Exception as error:
        print(f"Failed to read race date for {year} R{round_number}: {error}")
        return None
    return (race or {}).get("date")


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
    """Tyre stints for a race, Mongo-first with an OpenF1-then-FastF1 rebuild on a miss.

    Order matters. OpenF1 is tried first because it is reachable from Cloud Run,
    which makes the self-heal actually able to fire in production; FastF1 stays
    behind it for seasons OpenF1 doesn't cover (pre-2023) and for any round it
    happens to be missing. A miss neither source can fill is still not an error:
    `synced` tells the frontend it's looking at "not synced yet", not a failure.
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

    stints = None
    source = "openf1"
    race_date = await _race_date(db, year, round_number)
    if race_date:
        stints = build_race_stints_openf1(race_date)

    if not stints:
        source = "fastf1"
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
            {"$set": {
                "season": year,
                "round": str(round_number),
                "stints": stints,
                "source": source,
            }},
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
