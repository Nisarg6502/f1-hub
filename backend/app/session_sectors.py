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
