"""Per-sector purple/green/yellow classification for a practice or qualifying
session, sourced from OpenF1.

Powers the "sector battle" board on FP1-3, Qualifying and Sprint Qualifying:
one row per driver, their fastest complete lap of the session, with each of
its three sector times classified against the session's own best (purple)
and that driver's personal best in that sector (green) -- everything else is
yellow. Race and Sprint already have dedicated Pitwall analysis (lap
telemetry, position/gap, tyre stints), so this endpoint only serves the five
non-race session types.

Unlike `race_stints`/`race_laps`, there is no FastF1 fallback: OpenF1 is
reachable from Cloud Run (unlike FastF1's livetiming source, which 403s
datacenter IPs) and this data only matters for seasons OpenF1 actually
covers (2023 onward) -- older seasons report `available: false` rather than
silently trying and failing an upstream that has nothing for them.
"""

import datetime

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")

OPENF1_BASE = "https://api.openf1.org/v1"

SESSION_NAMES = {
    "FP1": "Practice 1",
    "FP2": "Practice 2",
    "FP3": "Practice 3",
    "Q": "Qualifying",
    "SQ": "Sprint Qualifying",
}

SECTOR_COUNT = 3


def _as_number(value) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return None if number != number else number


def classify_lap_sectors(rows: list[dict]) -> list[dict]:
    """Reduce OpenF1 `/laps` rows to one classified row per driver.

    A lap only counts if it is not an in/out lap and has a duration for the
    whole lap plus all three sectors -- a partial lap (red flag, off-track
    excursion) would otherwise masquerade as a fast one. Each driver is
    represented by their single fastest valid lap; each of that lap's three
    sector times is then classified against the session-wide best for that
    sector (purple) and the driver's own best across all their valid laps
    this session (green), with anything else falling to yellow.
    """
    valid: list[dict] = []
    for row in rows:
        if row.get("is_pit_out_lap"):
            continue
        driver_number = row.get("driver_number")
        lap_number = row.get("lap_number")
        duration = _as_number(row.get("lap_duration"))
        sectors = [_as_number(row.get(f"duration_sector_{n}")) for n in range(1, SECTOR_COUNT + 1)]
        if driver_number is None or lap_number is None or duration is None:
            continue
        if any(s is None for s in sectors):
            continue
        valid.append({
            "driver_number": driver_number,
            "lap_number": lap_number,
            "lap_duration_seconds": duration,
            "sectors": sectors,
        })

    if not valid:
        return []

    session_best = [
        min(row["sectors"][idx] for row in valid) for idx in range(SECTOR_COUNT)
    ]

    personal_best: dict[int, list[float]] = {}
    for row in valid:
        driver = row["driver_number"]
        current = personal_best.get(driver)
        if current is None:
            personal_best[driver] = list(row["sectors"])
        else:
            personal_best[driver] = [min(current[i], row["sectors"][i]) for i in range(SECTOR_COUNT)]

    fastest_by_driver: dict[int, dict] = {}
    for row in valid:
        driver = row["driver_number"]
        current = fastest_by_driver.get(driver)
        if current is None or row["lap_duration_seconds"] < current["lap_duration_seconds"]:
            fastest_by_driver[driver] = row

    board = []
    for driver, row in fastest_by_driver.items():
        sectors = {}
        for idx in range(SECTOR_COUNT):
            value = row["sectors"][idx]
            if value == session_best[idx]:
                classification = "purple"
            elif value == personal_best[driver][idx]:
                classification = "green"
            else:
                classification = "yellow"
            sectors[str(idx + 1)] = {"seconds": value, "classification": classification}

        board.append({
            "driver_number": driver,
            "lap_number": row["lap_number"],
            "lap_duration_seconds": row["lap_duration_seconds"],
            "sectors": sectors,
        })

    board.sort(key=lambda r: r["lap_duration_seconds"])
    return board


def _fetch_json(url: str, params: dict | None = None, timeout: float = 20.0):
    try:
        response = httpx.get(url, params=params, timeout=timeout)
        if response.status_code != 200:
            return None
        return response.json()
    except (httpx.HTTPError, ValueError):
        return None


def fetch_openf1_session_key_for(race_date: str, session_name: str) -> int | None:
    """OpenF1's `session_key` for the named session within the race weekend
    containing `race_date`.

    Unlike a Race or Sprint, a practice/qualifying session's own date can land
    up to three days before the Sunday race date this app indexes rounds by,
    so sessions are matched by name within a trailing window rather than by
    exact date. The closest match to the race date wins, in case OpenF1 ever
    returns a same-named session from an adjacent round.
    """
    if not race_date:
        return None

    sessions = _fetch_json(
        f"{OPENF1_BASE}/sessions", {"year": race_date[:4], "session_name": session_name}
    )
    if not isinstance(sessions, list):
        return None

    race_day = datetime.date.fromisoformat(race_date)
    window_start = race_day - datetime.timedelta(days=4)

    candidates = [
        s
        for s in sessions
        if window_start.isoformat() <= str(s.get("date_start", ""))[:10] <= race_date
    ]
    if not candidates:
        return None

    candidates.sort(key=lambda s: str(s.get("date_start", "")), reverse=True)
    return int(candidates[0]["session_key"]) if candidates[0].get("session_key") is not None else None


def build_session_sectors_openf1(race_date: str, session_code: str) -> list[dict] | None:
    """Sector board for one session via OpenF1, or None if it has nothing.

    Returns None (rather than raising) whenever the session code is unknown,
    the session can't be found, or it has no usable laps -- the caller treats
    all three the same way: report `available: false` rather than erroring.
    """
    session_name = SESSION_NAMES.get(session_code)
    if session_name is None:
        return None

    session_key = fetch_openf1_session_key_for(race_date, session_name)
    if session_key is None:
        return None

    rows = _fetch_json(f"{OPENF1_BASE}/laps", {"session_key": session_key})
    if not isinstance(rows, list) or not rows:
        return None

    return classify_lap_sectors(rows) or None


async def _race_date(db, year: int, round_number: int) -> str | None:
    try:
        race = await db.races.find_one(
            {"season": year, "round": str(round_number)}, {"_id": 0, "date": 1}
        )
    except Exception as error:
        print(f"Failed to read race date for {year} R{round_number}: {error}")
        return None
    return (race or {}).get("date")


@router.get("/session_sectors")
async def get_session_sectors(
    year: int = Query(..., description="Season year"),
    round_number: int = Query(..., alias="round", description="Round number"),
    session: str = Query(..., description="FP1, FP2, FP3, Q or SQ"),
):
    """Sector purple/green/yellow board for a practice or qualifying session.

    Mongo-first, same self-heal shape as `race_stints`/`race_laps`, but with a
    single source (OpenF1) rather than an OpenF1-then-FastF1 chain -- see the
    module docstring for why FastF1 is not worth adding here.
    """
    session_code = session.upper()
    if session_code not in SESSION_NAMES:
        return JSONResponse(content={"available": False, "rows": []}, status_code=400)

    db = get_db()

    doc = await db.session_sectors.find_one(
        {"season": year, "round": str(round_number), "session": session_code},
        {"_id": 0, "synced_at": 0},
    )
    if doc and doc.get("rows"):
        return JSONResponse(content={"available": True, "rows": doc["rows"]})

    race_date = await _race_date(db, year, round_number)
    rows = build_session_sectors_openf1(race_date, session_code) if race_date else None

    if not rows:
        return JSONResponse(content={"available": False, "rows": []})

    try:
        await db.session_sectors.update_one(
            {"season": year, "round": str(round_number), "session": session_code},
            {"$set": {
                "season": year,
                "round": str(round_number),
                "session": session_code,
                "rows": rows,
            }},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to cache session_sectors for {year} R{round_number} {session_code}: {error}")

    return JSONResponse(content={"available": True, "rows": rows})
