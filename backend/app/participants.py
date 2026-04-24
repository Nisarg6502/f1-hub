from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")


@router.get("/constructors")
async def get_constructors(
    year: int = Query(..., description="Year for which to fetch the constructors"),
    fields: str | None = Query(None, description="comma-separated fields: total,constructors,constructors_list"),
):
    db = get_db()
    doc = await db.constructors.find_one(
        {"season": year},
        {"_id": 0, "synced_at": 0},
    )

    constructors_full = doc.get("constructors", []) if doc else []
    constructors_count = len(constructors_full)
    constructors_list = [c.get("name", "") for c in constructors_full]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "total" in requested:
        result["total_constructors"] = constructors_count
    if "constructors_list" in requested:
        result["constructors_list"] = constructors_list
    if "constructors" in requested:
        result["constructors"] = constructors_full

    return JSONResponse(content=result)


@router.get("/drivers")
async def get_drivers(
    year: int = Query(..., description="Year for which to fetch the drivers"),
    fields: str | None = Query(None, description="comma-separated fields: total,drivers,drivers_list"),
):
    db = get_db()
    doc = await db.drivers.find_one(
        {"season": year},
        {"_id": 0, "synced_at": 0},
    )

    drivers_full = doc.get("drivers", []) if doc else []
    drivers_count = len(drivers_full)
    drivers_list = [
        (f"{d.get('givenName', '')} {d.get('familyName', '')}").strip()
        if (d.get('givenName') or d.get('familyName'))
        else d.get('driverId', '')
        for d in drivers_full
    ]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "total" in requested:
        result["total_drivers"] = drivers_count
    if "drivers_list" in requested:
        result["drivers_list"] = drivers_list
    if "drivers" in requested:
        result["drivers"] = drivers_full

    return JSONResponse(content=result)
