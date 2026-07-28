"""Cross-season circuit history: first year raced, most wins, closest finish.

Unlike `circuit_info.py` this is pure aggregation over collections the sync job
(and the other endpoints' self-heal paths) already populate — `races` and
`race_results` — so there is no live-upstream fallback here. A circuit with
too little cached data simply omits whichever field it cannot compute; the
frontend treats a missing field as "not enough data yet", not an error.

Matching is by `Circuit.circuitName` as stored on the `races` collection,
which is also the same string `circuit_details.circuit_name` is built from
(see `circuit_info.py::_self_heal_circuit_details` and
`data_sync.py::_build_circuit_detail`) — so a round whose `circuit_details`
hasn't synced yet still contributes to "first year raced" as long as its
`races` document exists.
"""

import re

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")

# Ergast gap strings look like "+1.234" or "+1:02.345"; a lapped/retired
# finisher gets "+1 Lap", "+2 Laps", or an empty string. Only a genuine
# seconds-based gap is a valid "closest finish" candidate.
_GAP_RE = re.compile(r"^\+?(?:(\d+):)?(\d+(?:\.\d+)?)$")


def parse_gap_seconds(time_str: str | None) -> float | None:
    """Parse an Ergast P2+ `Time.time` gap string into seconds, or None.

    Handles "+12.345" and "+1:02.345"; rejects "+1 Lap"/"+2 Laps", empty
    strings (retirements/DNFs), and anything else non-numeric.
    """
    if not time_str:
        return None
    text = time_str.strip()
    if not text:
        return None
    match = _GAP_RE.match(text)
    if not match:
        return None
    minutes, seconds = match.groups()
    total = float(seconds)
    if minutes:
        total += int(minutes) * 60
    return total


def first_year_raced(races: list[dict]) -> int | None:
    """Earliest `season` among the races cached for this circuit."""
    seasons = [r.get("season") for r in races if isinstance(r.get("season"), int)]
    return min(seasons) if seasons else None


def _winner(results: list[dict]) -> dict | None:
    return next((r for r in results if str(r.get("position")) == "1"), None)


def most_wins(result_docs: list[dict]) -> dict | None:
    """Tally P1 finishes by driver across `race_results` docs for this circuit.

    Returns the top driver and their count, or None if no doc has a usable
    winner. Ties report whichever driver was tallied first — not over-engineered
    per the roadmap note.
    """
    tally: dict[str, int] = {}
    order: list[str] = []

    for doc in result_docs:
        winner = _winner(doc.get("results") or [])
        if not winner:
            continue
        driver = winner.get("Driver") or {}
        family_name = driver.get("familyName")
        if not family_name:
            continue
        given_name = driver.get("givenName") or ""
        name = f"{given_name} {family_name}".strip()

        if name not in tally:
            tally[name] = 0
            order.append(name)
        tally[name] += 1

    if not tally:
        return None

    top = max(order, key=lambda name: tally[name])
    return {"driver": top, "wins": tally[top]}


def closest_finish(result_docs: list[dict]) -> dict | None:
    """Smallest valid P1->P2 gap across `race_results` docs for this circuit."""
    best = None

    for doc in result_docs:
        results = doc.get("results") or []
        p1 = _winner(results)
        p2 = next((r for r in results if str(r.get("position")) == "2"), None)
        if not p1 or not p2:
            continue

        gap_seconds = parse_gap_seconds((p2.get("Time") or {}).get("time"))
        if gap_seconds is None:
            continue

        if best is None or gap_seconds < best["gap_seconds"]:
            best = {
                "gap_seconds": gap_seconds,
                "season": doc.get("season"),
                "round": doc.get("round"),
            }

    return best


@router.get("/circuit_history")
async def get_circuit_history(
    circuit_name: str = Query(
        ..., description="Circuit name as stored on races/circuit_details, e.g. 'Silverstone Circuit'"
    ),
):
    """Cross-season stats for one physical circuit: first year raced, most
    wins, closest finish. Aggregates whatever is already cached in `races`
    and `race_results` — never fetches live, and omits any field it can't
    compute rather than erroring.
    """
    db = get_db()

    races = await db.races.find(
        {"Circuit.circuitName": circuit_name},
        {"_id": 0, "season": 1, "round": 1},
    ).to_list(length=200)

    result_docs: list[dict] = []
    or_clauses = [
        {"season": race.get("season"), "round": race.get("round")}
        for race in races
        if race.get("season") is not None and race.get("round") is not None
    ]
    if or_clauses:
        result_docs = await db.race_results.find(
            {"$or": or_clauses},
            {"_id": 0, "season": 1, "round": 1, "results": 1},
        ).to_list(length=200)

    response: dict = {"circuit_name": circuit_name}

    year = first_year_raced(races)
    if year is not None:
        response["first_year"] = year

    wins = most_wins(result_docs)
    if wins is not None:
        response["most_wins"] = wins

    finish = closest_finish(result_docs)
    if finish is not None:
        response["closest_finish"] = finish

    return JSONResponse(content=response)
