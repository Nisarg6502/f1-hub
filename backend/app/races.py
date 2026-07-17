from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")


def _round_key(document: dict) -> int:
    """Sort key for a round.

    Ergast stores `round` as a string, so sorting in Mongo puts "10" before "2".
    """
    try:
        return int(document.get("round", 0))
    except (TypeError, ValueError):
        return 0


@router.get("/races")
async def get_races(
    year: int = Query(..., description="Season year"),
    fields: str | None = Query(None, description="comma-separated: total,races,races_list"),
):
    db = get_db()
    races = await db.races.find({"season": year}, {"_id": 0, "synced_at": 0}).to_list(length=100)
    races.sort(key=_round_key)

    requested = {p.strip() for p in (fields or "").split(",") if p.strip()}
    if not requested:
        requested = {"total", "races_list", "races"}

    result = {}
    if "total" in requested:
        result["total_races"] = len(races)
    if "races_list" in requested:
        result["races_list"] = [race.get("raceName", "") for race in races]
    if "races" in requested:
        result["races"] = races

    return JSONResponse(content=result)


@router.get("/circuit_details")
async def get_circuit_details(
    year: int | None = Query(None, description="Season year; defaults to all seasons"),
):
    """Track-DNA details per round, as rendered by the circuits page."""
    db = get_db()
    query = {"season": year} if year is not None else {}
    details = await db.circuit_details.find(query, {"_id": 0, "synced_at": 0}).to_list(length=100)
    details.sort(key=_round_key)

    return JSONResponse(content={"circuit_details": details})
