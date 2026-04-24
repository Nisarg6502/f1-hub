from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")


@router.get("/race_results")
async def get_results(
    year: int = Query(..., description="Year for which to fetch results"),
    round: int | None = Query(None, description="round number to fetch a single race results"),
    fields: str | None = Query(None, description="comma-separated fields: results,results_list,race"),
):
    db = get_db()

    query = {"season": year}
    if round is not None:
        query["round"] = str(round)

    doc = await db.race_results.find_one(
        query,
        {"_id": 0, "synced_at": 0},
    )

    selected_race = doc.get("race", {}) if doc else {}
    results_for_race = doc.get("results", []) if doc else []
    drivers_list = [
        (f"{res.get('Driver', {}).get('givenName', '')} {res.get('Driver', {}).get('familyName', '')}").strip()
        if res.get('Driver') else res.get('driverId', '')
        for res in results_for_race
    ]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "results" in requested and round is not None:
        result["results"] = results_for_race
    if "results_list" in requested and round is not None:
        result["results_list"] = drivers_list
    if "race" in requested and round is not None:
        result["race"] = selected_race

    # if nothing requested, provide a minimal default
    if not requested:
        result = {"race": selected_race, "results": results_for_race}

    return JSONResponse(content=result)
