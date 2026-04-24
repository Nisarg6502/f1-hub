from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")


@router.get("/driverstandings")
async def get_driver_standings(
    year: int = Query(..., description="Year for which to fetch the driver standings"),
    fields: str | None = Query(None, description="comma-separated fields: standings,standings_list"),
):
    db = get_db()
    doc = await db.driver_standings.find_one(
        {"season": year},
        {"_id": 0, "synced_at": 0},
    )

    driver_standings = doc.get("standings", []) if doc else []

    drivers_list = [
        (f"{d.get('Driver',{}).get('givenName','')} {d.get('Driver',{}).get('familyName','')}").strip()
        if d.get('Driver') else d.get('driverId', '')
        for d in driver_standings
    ]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "standings_list" in requested:
        result["standings_list"] = drivers_list
    if "standings" in requested:
        result["driver_standings"] = driver_standings

    return JSONResponse(content=result)


@router.get("/constructorstandings")
async def get_constructor_standings(
    year: int = Query(..., description="Year for which to fetch the constructor standings"),
    fields: str | None = Query(None, description="comma-separated fields: standings,constructors_list"),
):
    db = get_db()
    doc = await db.constructor_standings.find_one(
        {"season": year},
        {"_id": 0, "synced_at": 0},
    )

    constructor_standings = doc.get("standings", []) if doc else []

    constructors_list = [c.get('Constructor', {}).get('name', '') for c in constructor_standings]

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()} if fields else set()

    result = {}
    if "constructors_list" in requested:
        result["constructors_list"] = constructors_list
    if "standings" in requested:
        result["constructor_standings"] = constructor_standings

    return JSONResponse(content=result)
