import fastf1
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .f1_results import enable_cache, safe_str, session_total_laps

router = APIRouter(prefix="/api")


@router.get("/circuit_info")
async def get_circuit_info(
    year: int = Query(..., description="Season year, e.g. 2026"),
    event_name: str = Query(
        ..., description="Grand Prix name as used by FastF1, e.g. 'Australian Grand Prix'"
    ),
):
    """Circuit geometry and the race's fastest lap, from FastF1."""
    enable_cache()

    try:
        session = fastf1.get_session(year, event_name, "R")
        session.load(laps=True, telemetry=False, weather=False, messages=False)
    except Exception as error:
        return JSONResponse(
            status_code=502,
            content={"error": "Failed to load FastF1 session", "message": str(error)},
        )

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

    # Circuit length, race distance and DRS zones are intentionally absent:
    # FastF1's Event carries none of them, and deriving them needs telemetry
    # the F1 archives do not publish for every session.
    return JSONResponse(content={
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
    })
