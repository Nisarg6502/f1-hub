from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
import fastf1

import os

router = APIRouter(prefix="/api")

# Use the same cache directory as other FastF1 integrations so repeated
# requests for the same event stay fast.
_cache_dir = os.path.join(os.path.dirname(__file__), "..", "..", "f1_cache")
os.makedirs(_cache_dir, exist_ok=True)
fastf1.Cache.enable_cache(_cache_dir)


@router.get("/circuit_info")
async def get_circuit_info(
    year: int = Query(..., description="Season year, e.g. 2026"),
    event_name: str = Query(
        ..., description="Grand Prix name as used by FastF1, e.g. 'Australian Grand Prix'"
    ),
):
    """
    Return rich circuit and race information for a given event using FastF1.
    The data is based on the race session ('R') for the specified event.
    """

    try:
        session = fastf1.get_session(year, event_name, "R")
        # Load only what we need: laps and circuit information.
        session.load(laps=True, telemetry=False, weather=False, messages=False, circuits=True)
    except Exception as e:
        return JSONResponse(
            status_code=502,
            content={
                "error": "Failed to load FastF1 session",
                "message": str(e),
            },
        )

    circuit_info = session.get_circuit_info()
    event_data = session.event

    # Basic circuit / race details
    circuit_name = getattr(event_data, "CircuitName", None)
    country = getattr(event_data, "Country", None)
    city = getattr(event_data, "Location", None)

    # Distances and laps
    track_length_m = getattr(event_data, "CircuitLength", None)
    race_distance_m = getattr(event_data, "RaceDistance", None)
    race_laps = getattr(event_data, "TotalLaps", None)

    track_length_km = float(track_length_m) / 1000 if track_length_m else None
    total_race_length_km = float(race_distance_m) / 1000 if race_distance_m else None

    # Corner and DRS information
    corners_df = getattr(circuit_info, "corners", None)
    drs_zones_df = getattr(circuit_info, "drs_zones", None)

    corners = []
    num_corners = 0
    if corners_df is not None:
        subset = corners_df[["Number", "Name", "Type", "Distance"]].copy()
        subset["Distance"] = subset["Distance"].astype(float)
        corners = subset.to_dict(orient="records")
        num_corners = len(corners)

    drs_zones = []
    num_drs_zones = 0
    if drs_zones_df is not None:
        subset = drs_zones_df[["Zone", "Start", "End"]].copy()
        subset["Start"] = subset["Start"].astype(float)
        subset["End"] = subset["End"].astype(float)
        drs_zones = subset.to_dict(orient="records")
        num_drs_zones = len(drs_zones)

    # Fastest lap / track record from this race
    track_record_time = None
    track_record_driver = None
    track_record_year = getattr(event_data, "Year", None)
    try:
        fastest_lap = session.laps.pick_fastest()
        track_record_time = str(fastest_lap["LapTime"]) if "LapTime" in fastest_lap else None
        track_record_driver = fastest_lap.get("Driver", None)
    except Exception:
        # If there is no lap data (e.g. cancelled race), leave record fields as None.
        pass

    payload = {
        "year": year,
        "event_name": event_name,
        "circuit_name": circuit_name,
        "country": country,
        "city": city,
        "track_length_km": track_length_km,
        "total_race_length_km": total_race_length_km,
        "total_laps": int(race_laps) if race_laps is not None else None,
        "num_corners": num_corners,
        "num_drs_zones": num_drs_zones,
        "corners": corners,
        "drs_zones": drs_zones,
        "track_record": {
            "time": track_record_time,
            "driver": track_record_driver,
            "year": int(track_record_year) if track_record_year is not None else None,
        },
    }

    return JSONResponse(content=payload)