import re

import fastf1
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .f1_results import enable_cache, safe_str, session_total_laps

router = APIRouter(prefix="/api")

_LAP_RECORD_RE = re.compile(r"^(.*?)(?:\s\(([^)]+)\))?$")


def _split_lap_record(lap_record: str | None) -> tuple[str | None, str | None]:
    """Reverse `_build_circuit_detail`'s "1:32.740 (VER)" formatting."""
    if not lap_record:
        return None, None
    match = _LAP_RECORD_RE.match(lap_record)
    if not match:
        return lap_record, None
    time_part, driver_part = match.groups()
    return (time_part or None), driver_part


def _from_circuit_detail(year: int, event_name: str, doc: dict) -> dict:
    """Reshape a `circuit_details` sync document into this endpoint's response shape."""
    track = doc.get("track_information") or {}
    lap_time, lap_driver = _split_lap_record(track.get("lap_record"))
    return {
        "year": year,
        "event_name": event_name,
        "country": doc.get("country") or None,
        "city": None,
        "total_laps": track.get("number_of_laps"),
        "num_corners": track.get("number_of_corners") or 0,
        "fastest_lap": {
            "time": lap_time,
            "driver": lap_driver,
            "year": year if lap_time else None,
        },
    }


async def _self_heal_circuit_details(
    db, year: int, event_name: str, total_laps, num_corners, record_time, record_driver
) -> None:
    """Write a freshly-loaded live session into `circuit_details`.

    Matches the shape `data_sync._build_circuit_detail` writes, so the next
    request for this race is served from Mongo instead of hitting FastF1
    again. Silently skipped if the race isn't in `races` yet — best effort,
    not required for the response itself.
    """
    race_doc = await db.races.find_one({"season": year, "raceName": event_name})
    if not race_doc:
        return

    try:
        round_number = int(race_doc.get("round", 0))
    except (TypeError, ValueError):
        return

    circuit = race_doc.get("Circuit", {}) or {}
    location = circuit.get("Location", {}) or {}
    lap_record = (
        f"{record_time} ({record_driver})" if record_time and record_driver else record_time
    )

    detail = {
        "round": round_number,
        "season": year,
        "country": location.get("country", ""),
        "circuit_name": circuit.get("circuitName", ""),
        "grand_prix": race_doc.get("raceName", event_name),
        "date": race_doc.get("date", ""),
        "track_information": {
            "first_grand_prix": None,
            "number_of_laps": total_laps,
            "number_of_corners": num_corners or None,
            "lap_record": lap_record,
        },
    }

    try:
        await db.circuit_details.update_one(
            {"season": year, "round": round_number},
            {"$set": detail},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to self-heal circuit_details for {year} {event_name}: {error}")


async def _load_live_and_cache(db, year: int, event_name: str) -> dict | None:
    """Live FastF1 fallback for a `circuit_details` cache miss.

    This is the call that made every race-detail page load slow before this
    endpoint started reusing `circuit_details` (already built by the nightly
    sync job for the /circuits page) as its primary source — keep it as the
    exception path, not the hot path.
    """
    enable_cache()

    try:
        session = fastf1.get_session(year, event_name, "R")
        session.load(laps=True, telemetry=False, weather=False, messages=False)
    except Exception as error:
        print(f"circuit_info live load failed for {year} {event_name}: {error}")
        return None

    event = session.event
    total_laps = session_total_laps(session)

    # Only the corner count is exposed. FastF1's corners frame carries X/Y,
    # number, letter and angle — no names or types — and its Distance column
    # stays empty without position telemetry, so there is nothing else worth
    # publishing here.
    num_corners = 0
    try:
        num_corners = len(session.get_circuit_info().corners)
    except Exception as error:
        print(f"Circuit geometry unavailable for {year} {event_name}: {error}")

    record_time = record_driver = None
    try:
        fastest_lap = session.laps.pick_fastest()
        if fastest_lap is not None:
            record_time = safe_str(fastest_lap.get("LapTime")) or None
            record_driver = safe_str(fastest_lap.get("Driver")) or None
    except Exception:
        # A cancelled or lapless session has no record to report.
        pass

    record_year = getattr(event, "Year", None)

    result = {
        "year": year,
        "event_name": event_name,
        "country": getattr(event, "Country", None),
        "city": getattr(event, "Location", None),
        "total_laps": total_laps,
        "num_corners": num_corners,
        "fastest_lap": {
            "time": record_time,
            "driver": record_driver,
            "year": int(record_year) if record_year is not None else None,
        },
    }

    await _self_heal_circuit_details(
        db, year, event_name, total_laps, num_corners, record_time, record_driver
    )
    return result


@router.get("/circuit_info")
async def get_circuit_info(
    year: int = Query(..., description="Season year, e.g. 2026"),
    event_name: str = Query(
        ..., description="Grand Prix name as used by FastF1, e.g. 'Australian Grand Prix'"
    ),
):
    """Circuit geometry and the race's fastest lap.

    Mongo-first against `circuit_details` — already built by the nightly sync
    job for the /circuits page, and keyed by the same `grand_prix` name the
    frontend already passes here as `event_name`. A live FastF1 session load
    only happens on a genuine cache miss, and self-heals the cache so it
    doesn't happen again for the same race. Circuit length, race distance and
    DRS zones are intentionally absent: FastF1's Event carries none of them.
    """
    db = get_db()

    doc = await db.circuit_details.find_one(
        {"season": year, "grand_prix": event_name}, {"_id": 0, "synced_at": 0}
    )
    if doc:
        return JSONResponse(content=_from_circuit_detail(year, event_name, doc))

    live = await _load_live_and_cache(db, year, event_name)
    if live is None:
        return JSONResponse(
            status_code=502,
            content={
                "error": "Failed to load FastF1 session",
                "message": f"Could not load {event_name} {year}",
            },
        )
    return JSONResponse(content=live)
