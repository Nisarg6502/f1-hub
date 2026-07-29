"""Lap-indexed race replay: one payload the frontend can scrub through.

Composes four already-cached sources — `race_laps` (position and gap per lap),
`race_stints` (tyre compound per stint), `pit_stops` (which lap each stop
happened on) and OpenF1 race control (flags, penalties, safety cars) — into a
single structure keyed by lap number.

**The join is the whole point of doing this server-side.** `race_laps` and
`race_stints` identify a driver by `driver_number` (an int, `23`), while
`pit_stops` identifies them by `driver_id` (an Ergast slug, `"albon"`). Those
two namespaces have no overlap, so a client-side join written without noticing
would silently produce zero pit markers — no exception, no empty state, just a
replay that quietly never shows a pit stop. `race_results` carries both fields
and is the only bridge between them, so the mapping is resolved once here
rather than left for each caller to rediscover. This is the same reasoning as
`session_recap.py`'s fact pre-computation: a derivation with a silent failure
mode belongs in one place, in code.

Note there is deliberately **no track-position data** here. Nothing in this app
caches GPS or coordinates — `track-map.tsx` is a static circuit outline — so a
replay built on this is a timing tower scrubbed by lap, not cars animating
around a circuit. Don't add a `x`/`y` field expecting to fill it later without
first sourcing that data.

Cached in `race_replay` because a finished race's replay is immutable, the same
argument `session_recap` makes for caching recaps forever. `REPLAY_VERSION` is
part of the cache key so a change to the payload shape retires existing
documents instead of serving them to a frontend that expects the new one.
"""

import asyncio
import json

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .race_control_facts import summarize_race_control
from .session_recap import fetch_race_control
from .race_laps import get_race_laps
from .race_stints import get_race_stints
from .pit_stops import get_pit_stops

router = APIRouter(prefix="/api")

# Bump when the payload shape changes. Existing cached replays stop matching
# and rebuild on next view, rather than feeding a stale shape to a frontend
# built against the new one.
REPLAY_VERSION = 1


async def _endpoint_payload(coroutine) -> dict:
    """Read an existing endpoint's JSONResponse body as a dict.

    The replay reuses `get_race_laps`/`get_race_stints`/`get_pit_stops` rather
    than re-reading their collections directly, so it inherits their Mongo-first
    lookup *and* their self-heal on a miss for free. Duplicating that logic here
    would mean a cold round self-heals when viewed through one endpoint but not
    the other.
    """
    try:
        response = await coroutine
        return json.loads(bytes(response.body))
    except Exception as error:
        print(f"race_replay: source fetch failed: {error}")
        return {}


def _driver_directory(results: list[dict]) -> dict[str, dict]:
    """Static per-driver identity, keyed by car number as a string.

    Keyed by number because that is what the per-lap rows carry; `driver_id` is
    kept on each entry so pit stops can be mapped onto the same key. Emitted
    once per driver rather than repeated on all ~50 of their lap rows.
    """
    directory: dict[str, dict] = {}
    for row in results:
        number = str(row.get("number") or "").strip()
        driver = row.get("Driver") or {}
        if not number:
            continue
        directory[number] = {
            "number": number,
            "driver_id": driver.get("driverId"),
            "code": driver.get("code"),
            "name": f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip(),
            "team": (row.get("Constructor") or {}).get("name"),
            "grid": row.get("grid"),
            "finish_position": row.get("position"),
            "finish_status": row.get("status"),
        }
    return directory


def _number_by_driver_id(directory: dict[str, dict]) -> dict[str, str]:
    """The `driver_id` -> car-number bridge that makes pit stops joinable."""
    return {
        entry["driver_id"]: number
        for number, entry in directory.items()
        if entry.get("driver_id")
    }


def _compound_by_lap(stints: list[dict]) -> dict[tuple[str, int], dict]:
    """(car number, lap) -> tyre state on that lap.

    Stints are stored as ranges (`lap_start`..`lap_end`); the replay needs a
    per-lap answer, so the range is expanded once here. `tyre_age` counts up
    from `tyre_age_at_start`, which is why a stint starting on a used set
    reports a non-zero age on its first lap.
    """
    by_lap: dict[tuple[str, int], dict] = {}
    for stint in stints:
        number = str(stint.get("driver_number") or "").strip()
        start, end = stint.get("lap_start"), stint.get("lap_end")
        if not number or start is None or end is None:
            continue
        age_at_start = stint.get("tyre_age_at_start") or 0
        for lap in range(int(start), int(end) + 1):
            by_lap[(number, lap)] = {
                "compound": stint.get("compound"),
                "tyre_age": age_at_start + (lap - int(start)),
                "stint_number": stint.get("stint_number"),
            }
    return by_lap


def _stops_by_lap(
    stops: list[dict], number_by_id: dict[str, str]
) -> dict[tuple[str, int], dict]:
    """(car number, lap) -> the pit stop made on that lap, if any.

    This is where `driver_id` is translated to a car number. A stop whose
    `driver_id` has no match is dropped rather than guessed at — but that is a
    real signal something is wrong with the join, so it is logged rather than
    passed over silently.
    """
    by_lap: dict[tuple[str, int], dict] = {}
    unmatched: set[str] = set()
    for stop in stops:
        driver_id = stop.get("driver_id")
        lap = stop.get("lap")
        number = number_by_id.get(driver_id)
        if not number:
            if driver_id:
                unmatched.add(driver_id)
            continue
        if lap is None:
            continue
        by_lap[(number, int(lap))] = {
            "stop_number": stop.get("stop"),
            "duration_seconds": stop.get("duration_seconds"),
        }
    if unmatched:
        print(
            f"race_replay: {len(unmatched)} pit-stop driver_id(s) had no car "
            f"number in race_results: {sorted(unmatched)}"
        )
    return by_lap


def _events_by_lap(race_control: dict) -> dict[int, list[dict]]:
    """Race-control events grouped by the lap they happened on.

    Reuses `summarize_race_control`'s distillation rather than the raw message
    log: the raw feed is mostly blue flags and sector yellow/clear churn, which
    would put a marker on nearly every lap of the scrubber and make the genuinely
    story-shaping events impossible to pick out. Events with no lap number are
    dropped here — they have nowhere to sit on a lap-indexed timeline.
    """
    by_lap: dict[int, list[dict]] = {}
    for event in race_control.get("events") or []:
        lap = event.get("lap")
        if lap is None:
            continue
        by_lap.setdefault(int(lap), []).append({
            "kind": event.get("kind"),
            "drivers": event.get("drivers") or [],
            "message": event.get("message"),
        })
    return by_lap


def build_replay(
    race: dict,
    results: list[dict],
    laps: list[dict],
    stints: list[dict],
    stops: list[dict],
    race_control: dict,
) -> dict:
    """Assemble the lap-indexed payload from the four already-fetched sources."""
    directory = _driver_directory(results)
    number_by_id = _number_by_driver_id(directory)
    tyre = _compound_by_lap(stints)
    pits = _stops_by_lap(stops, number_by_id)
    events = _events_by_lap(race_control)

    by_lap: dict[int, list[dict]] = {}
    for row in laps:
        number = str(row.get("driver_number") or "").strip()
        lap = row.get("lap_number")
        if not number or lap is None:
            continue
        lap = int(lap)
        state = tyre.get((number, lap)) or {}
        stop = pits.get((number, lap))
        by_lap.setdefault(lap, []).append({
            "number": number,
            "position": row.get("position"),
            "gap_seconds": row.get("gap_seconds"),
            "compound": state.get("compound"),
            "tyre_age": state.get("tyre_age"),
            "stint_number": state.get("stint_number"),
            # Present-but-null rather than omitted, so the frontend can treat
            # "no stop this lap" and "no pit data at all" the same way.
            "pit": stop,
        })

    ordered_laps = [
        {
            # Runners are sorted here so every consumer sees the same order and
            # none of them has to re-sort 52 times while scrubbing. A row with
            # no position sorts last rather than crashing the comparison.
            "lap": lap,
            "runners": sorted(
                by_lap[lap],
                key=lambda r: (
                    r["position"] is None,
                    int(r["position"]) if str(r["position"] or "").isdigit() else 0,
                ),
            ),
            "events": events.get(lap, []),
        }
        for lap in sorted(by_lap)
    ]

    return {
        "race_name": race.get("raceName"),
        "circuit": (race.get("Circuit") or {}).get("circuitName"),
        "date": race.get("date"),
        "total_laps": len(ordered_laps),
        "drivers": directory,
        "laps": ordered_laps,
    }


@router.get("/race_replay")
async def get_race_replay(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round_number: int = Query(..., alias="round", description="Round number within the season"),
):
    """Lap-indexed replay for a race, composed from the per-lap caches.

    An unraced or unsynced round is not an error — `synced: false` with an empty
    `laps` list is the honest answer, matching how `race_laps`/`race_stints`
    report the same case.
    """
    db = get_db()
    cache_key = {"season": year, "round": str(round_number), "version": REPLAY_VERSION}

    cached = await db.race_replay.find_one(cache_key, {"_id": 0})
    if cached and cached.get("replay"):
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            **cached["replay"],
            "synced": True,
        })

    results_doc = await db.race_results.find_one(
        {"season": year, "round": str(round_number)}, {"_id": 0}
    )
    results = (results_doc or {}).get("results") or []
    race = (results_doc or {}).get("race", {})

    laps_payload = await _endpoint_payload(get_race_laps(year=year, round_number=round_number))
    laps = laps_payload.get("laps") or []

    # Without lap rows there is no timeline to hang anything on, so bail before
    # paying for the stint/pit/race-control fetches.
    if not results or not laps:
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "total_laps": 0,
            "drivers": {},
            "laps": [],
            "synced": False,
        })

    stints_payload, stops_payload = await asyncio.gather(
        _endpoint_payload(get_race_stints(year=year, round_number=round_number)),
        _endpoint_payload(get_pit_stops(year=year, round_number=round_number)),
    )

    # Race control is enrichment: a replay without flag markers is still a
    # usable replay, so a failure here must not fail the request.
    messages = await asyncio.to_thread(fetch_race_control, race.get("date", ""), "Race")
    race_control = summarize_race_control(messages, results)

    replay = build_replay(
        race,
        results,
        laps,
        stints_payload.get("stints") or [],
        stops_payload.get("stops") or [],
        race_control,
    )

    try:
        await db.race_replay.update_one(
            cache_key, {"$set": {**cache_key, "replay": replay}}, upsert=True
        )
    except Exception as error:
        print(f"Failed to cache race_replay for {year} R{round_number}: {error}")

    return JSONResponse(content={
        "year": year,
        "round": round_number,
        **replay,
        "synced": True,
    })
