from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")


@router.get("/races")
async def get_races(
    year: int = Query(..., description="Year for which to fetch the races"),
    fields: str | None = Query(None, description="comma-separated fields: total,races,races_list"),
):
    db = get_db()
    races_cursor = db.races.find(
        {"season": year},
        {"_id": 0, "synced_at": 0},
    ).sort("round", 1)

    races_full_data = await races_cursor.to_list(length=100)

    # Convert round to int for sorting if stored as string
    races_count = len(races_full_data)
    races_list = [r.get("raceName", "") for r in races_full_data]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}

    # If no fields are requested, act as if all were requested
    if not requested:
        requested = {"total", "races_list", "races"}

    if "total" in requested:
        result["total_races"] = races_count
    if "races_list" in requested:
        result["races_list"] = races_list
    if "races" in requested:
        result["races"] = races_full_data

    return JSONResponse(content=result)


@router.get("/circuit_details")
async def get_circuit_details():
    """Return detailed circuit information for all rounds from the database."""
    db = get_db()
    cursor = db.circuit_details.find(
        {},
        {"_id": 0},
    ).sort("round", 1)

    details = await cursor.to_list(length=100)
    return JSONResponse(content={"circuit_details": details})