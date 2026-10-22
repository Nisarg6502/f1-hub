"""Track position and gap-to-leader per lap for a finished race, sourced from FastF1.

Powers the Pitwall "Lap Telemetry" chart. `session.laps` already carries a
`Position` column alongside the `Stint`/`Compound`/`TyreLife` data
`race_stints` reads from the same DataFrame, so this needs no new FastF1 API
surface -- just a different subset of columns off the same load. Served with
the same Mongo-first / self-heal pattern as `circuit_info` and `race_stints`.

Each row carries `position`, `gap_seconds` (seconds behind whoever led that
lap) and `lap_time_seconds` (that lap's own duration), plus `line_seconds`,
the instant the car crossed the line to complete the lap, in seconds on the
session's clock. **`gap_seconds` is derived from `line_seconds` and nothing
else**, for both sources, by `_attach_gaps`: the gap at lap N is this car's
crossing instant minus the leader's.

It used to be derived, on the FastF1 path only, as a running sum of each car's
own `LapTime`s, skipping any lap whose `LapTime` was missing. A missing
duration is routine (pit entries, red-flag laps, safety-car pickups), and
skipping it shortens that car's running total by the whole lap, so every gap
measured against it is off by that much for the rest of the race. When the
car that loses a lap is the leader, the entire field appears minutes behind:
2026 Japan showed P2 324 s behind on the last lap (officially 13.7 s), China
160 s (5.5 s), Britain 175 s (0.4 s), and a test in this repo asserted the
resulting negative gap as "the documented tradeoff". A crossing instant has no
such failure mode: one missing sample costs that one row's gap, nothing after
it. The OpenF1 path already worked this way; both now share one function.

**A stored document without `line_seconds` was built by the old derivation**
and is rebuilt rather than served (`has_line_times`): by the endpoint on the
next view (OpenF1, which works from Cloud Run) and by `data_sync`. If no
rebuild succeeds the old document is still served, as before, rather than
nothing.

`lap_time_seconds` is kept as its own field because a real-time replay clock
advances by each lap's actual length, which a gap cannot stand in for.

On a cache miss the rebuild is two-stage. **OpenF1** is tried first — its
`/laps` and `/position` feeds are joined on time by `positions_from_openf1` to
reconstruct both fields, and unlike FastF1 it is reachable from a datacenter
IP, which is what makes the self-heal actually fire in production. **FastF1**
sits behind it, for pre-2023 seasons (OpenF1 has no data before then) and any
round OpenF1 is missing; `livetiming.formula1.com` 403s datacenter IPs *and
fails soft*, so that stage only succeeds from a local machine.
`data_sync.sync_race_laps` also pre-populates the collection when run locally.
"""

import datetime

import fastf1
import httpx
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .f1_results import enable_cache

router = APIRouter(prefix="/api")

OPENF1_BASE = "https://api.openf1.org/v1"

# Columns of `session.laps` this endpoint reads. `Time` is the session time at
# which the lap was completed (the line crossing, see `_attach_gaps`); `LapTime`
# is the lap's own duration. Both are `pandas.Timedelta` or `NaT`.
LAP_COLUMNS = ("DriverNumber", "LapNumber", "Position", "LapTime", "Time")


def _as_int(value) -> int | None:
    """Coerce a pandas/NumPy scalar to a plain int, or None if it isn't one."""
    if value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    # NaN survives int() on some numpy types but never equals itself as a float.
    return None if number != number else number


def _lap_time_seconds(value) -> float | None:
    """Coerce a `LapTime` or `Time` cell (a `pandas.Timedelta`, `NaT`, or None) to seconds.

    `pandas.NaT` (a missing lap time -- an in-lap/out-lap edge case, or a lap
    picked up mid-red-flag with no recorded duration) supports `.total_seconds()`
    same as a real Timedelta, but returns `nan` rather than raising. Guard the
    same way `_as_int` guards NaN ints: NaN never equals itself.
    """
    if value is None:
        return None
    try:
        seconds = value.total_seconds()
    except AttributeError:
        return None
    return None if seconds != seconds else seconds


def _attach_gaps(rows: list[dict]) -> None:
    """Set each row's `gap_seconds` from its `line_seconds`, in place.

    The gap at lap N is this car's line-crossing instant minus the crossing
    instant of whichever car held P1 at lap N; 0 for the leader. Lap number,
    not wall clock, is the x-axis unit, so for a lapped car this is the gap to
    the leader's crossing of the same lap number (the convention every "gap
    by lap" chart uses).

    None when either instant is unknown. Nothing is carried forward or
    estimated: a missing crossing costs exactly that row's gap.
    """
    leader_line_by_lap: dict[int, float] = {}
    for row in rows:
        if row["position"] == 1 and row.get("line_seconds") is not None:
            leader_line_by_lap[row["lap_number"]] = row["line_seconds"]

    for row in rows:
        own = row.get("line_seconds")
        leader = leader_line_by_lap.get(row["lap_number"])
        row["gap_seconds"] = None if own is None or leader is None else round(own - leader, 3)


def has_line_times(laps: list[dict]) -> bool:
    """True if stored lap rows were built with crossing instants.

    Rows without `line_seconds` were written by the summed-`LapTime`
    derivation (see the module docstring) and their gaps cannot be trusted.
    """
    return any("line_seconds" in row for row in laps or [])


def positions_from_laps(laps: list[dict]) -> list[dict]:
    """Flatten lap rows into one record per (driver, lap) with position, gap and duration.

    Kept independent of pandas so it can be exercised directly: the endpoint
    and the sync job both hand it plain row dicts. Rows missing a driver
    number, lap number, or position are dropped -- a driver who retired mid-
    race simply has no rows past their last completed lap, which the chart
    reads as "line ends here" rather than a gap to fill in. A missing `Time`
    or `LapTime` does NOT drop the row (position data is still valid); it only
    nulls that row's `gap_seconds` or `lap_time_seconds` -- see `_attach_gaps`.

    `lap_time_seconds` -- how long *this one lap* took -- is persisted
    alongside the derived `gap_seconds` rather than being used and thrown
    away. The two are not substitutes and the distinction matters: a gap is
    *relative* (own cumulative minus the leader's) and goes null whenever
    either side lacks timing, so a clock built on it would stall wherever
    data is sparse. A duration is absolute and per-row: one driver's missing
    sample costs exactly that one lap.

    A null `lap_time_seconds` is a first-class case, not an error -- see
    `_lap_time_seconds` for the in-lap/red-flag reasons a real lap legitimately
    has no usable `LapTime`. Nothing here invents a stand-in value; a consumer
    that needs the clock to keep moving decides its own fallback, with the
    honest null in front of it.
    """
    rows: list[dict] = []
    for lap in laps:
        driver_number = _as_int(lap.get("DriverNumber"))
        lap_number = _as_int(lap.get("LapNumber"))
        position = _as_int(lap.get("Position"))
        if driver_number is None or lap_number is None or position is None:
            continue
        rows.append({
            "driver_number": driver_number,
            "lap_number": lap_number,
            "position": position,
            "lap_time_seconds": _lap_time_seconds(lap.get("LapTime")),
            "line_seconds": _lap_time_seconds(lap.get("Time")),
        })

    rows.sort(key=lambda r: (r["driver_number"], r["lap_number"]))
    _attach_gaps(rows)
    return rows


def _fetch_json(url: str, params: dict | None = None, timeout: float = 20.0):
    """GET `url` and decode JSON, or None on any failure.

    Mirrors `session_recap._fetch_json` — same upstream, same "never a hard
    dependency" posture: a failure here falls through to the FastF1 path.
    """
    try:
        response = httpx.get(url, params=params, timeout=timeout)
        if response.status_code != 200:
            return None
        return response.json()
    except (httpx.HTTPError, ValueError):
        return None


def _parse_iso(value) -> datetime.datetime | None:
    """Parse one of OpenF1's ISO-8601 timestamps, or None if it isn't one."""
    if not isinstance(value, str):
        return None
    try:
        return datetime.datetime.fromisoformat(value)
    except ValueError:
        return None


def _lap_end_times(driver_laps: list[dict]) -> dict[int, datetime.datetime | None]:
    """Map each of one driver's lap numbers to the instant they completed it.

    `driver_laps` must be sorted by lap number. The preferred answer is the
    *next* lap's `date_start`, which is the same crossing of the line and so
    needs no arithmetic. Falling back to `date_start + lap_duration` covers the
    final lap (there is no next one) and any gap in the sequence; a lap with
    neither — OpenF1 leaves `lap_duration` null on a handful of laps per race,
    typically red-flag or pit-lane-entry edge cases — maps to None, which
    propagates to a null `gap_seconds` for that row rather than a wrong number.
    """
    ends: dict[int, datetime.datetime | None] = {}

    for index, row in enumerate(driver_laps):
        lap_number = _as_int(row.get("lap_number"))
        if lap_number is None:
            continue

        end = None
        following = driver_laps[index + 1] if index + 1 < len(driver_laps) else None
        if following is not None and _as_int(following.get("lap_number")) == lap_number + 1:
            end = _parse_iso(following.get("date_start"))
        if end is None:
            start = _parse_iso(row.get("date_start"))
            duration = row.get("lap_duration")
            if start is not None and isinstance(duration, (int, float)):
                end = start + datetime.timedelta(seconds=float(duration))
        ends[lap_number] = end

    return ends


def positions_from_openf1(lap_rows: list[dict], position_rows: list[dict]) -> list[dict]:
    """Build this app's per-lap rows from OpenF1's `/laps` and `/position` feeds.

    OpenF1's `/laps` has no position column and its `/position` feed is a
    stream of timestamped position *changes* rather than a per-lap snapshot, so
    the two have to be joined on time: a driver's position at lap N is whatever
    their most recent position event at or before their lap-N line crossing
    said. Before their first event (which is emitted well before lights out)
    that earliest event stands in, so lap 1 reads as the grid slot.

    Each crossing instant is stored as `line_seconds`, measured from the
    earliest lap start in the session, and `gap_seconds` comes from
    `_attach_gaps`, the same function the FastF1 path uses. Only differences
    between crossings are ever used, so the choice of zero does not matter.

    `lap_time_seconds` comes straight off OpenF1's own `lap_duration`, not from
    differencing the crossing instants this function already computes. Those
    instants are *reconstructed* (a next lap's `date_start`, or a start plus a
    duration), so differencing them would in the common case just recover
    `lap_duration` by a longer route, and in the fallback case would be
    circular. `lap_duration` is null on a handful of laps per race for the same
    red-flag/pit-entry reasons FastF1 leaves `LapTime` as `NaT`; that null is
    carried through rather than filled in, matching the FastF1 path exactly.

    Filling this field on *both* paths is not optional politeness. OpenF1 is
    tried first and is the only source reachable from Cloud Run, so it fills
    most production rows; a duration on the FastF1 path alone would leave the
    field null across nearly every synced round, and would break the key
    parity the two paths are tested for.
    """
    by_driver: dict[int, list[dict]] = {}
    for row in lap_rows:
        driver_number = _as_int(row.get("driver_number"))
        if driver_number is None or _as_int(row.get("lap_number")) is None:
            continue
        by_driver.setdefault(driver_number, []).append(row)

    events: dict[int, list[tuple[datetime.datetime, int]]] = {}
    for event in position_rows:
        driver_number = _as_int(event.get("driver_number"))
        position = _as_int(event.get("position"))
        moment = _parse_iso(event.get("date"))
        if driver_number is None or position is None or moment is None:
            continue
        events.setdefault(driver_number, []).append((moment, position))
    for series in events.values():
        series.sort(key=lambda pair: pair[0])

    rows: list[dict] = []
    for driver_number, driver_laps in by_driver.items():
        driver_laps.sort(key=lambda r: _as_int(r.get("lap_number")))
        ends = _lap_end_times(driver_laps)
        series = events.get(driver_number)
        if not series:
            # No position stream for this driver: every row would be position-less,
            # and a position-less row is dropped anyway (see `positions_from_laps`).
            continue

        for row in driver_laps:
            lap_number = _as_int(row.get("lap_number"))
            end = ends.get(lap_number)
            position = series[0][1]
            if end is not None:
                for moment, value in series:
                    if moment > end:
                        break
                    position = value
            duration = row.get("lap_duration")
            rows.append({
                "driver_number": driver_number,
                "lap_number": lap_number,
                "position": position,
                "lap_time_seconds": (
                    float(duration) if isinstance(duration, (int, float)) else None
                ),
                "_end": end,
            })

    starts = [
        moment
        for row in lap_rows
        if (moment := _parse_iso(row.get("date_start"))) is not None
    ]
    origin = min(starts) if starts else None
    for row in rows:
        end = row.pop("_end")
        row["line_seconds"] = (
            round((end - origin).total_seconds(), 3)
            if end is not None and origin is not None
            else None
        )

    rows.sort(key=lambda r: (r["driver_number"], r["lap_number"]))
    _attach_gaps(rows)
    return rows


def build_race_laps_openf1(race_date: str) -> list[dict] | None:
    """Per-lap positions and gaps for the race on `race_date` via OpenF1, or None.

    Unlike the FastF1 path this works from a datacenter IP, which is what makes
    the endpoint's self-heal reachable in production at all. Coverage starts at
    2023 — `/sessions?year=2022` 404s — so older seasons still need FastF1.
    """
    from .race_stints import fetch_openf1_session_key

    session_key = fetch_openf1_session_key(race_date)
    if session_key is None:
        return None

    lap_rows = _fetch_json(f"{OPENF1_BASE}/laps", {"session_key": session_key})
    if not isinstance(lap_rows, list) or not lap_rows:
        return None

    position_rows = _fetch_json(f"{OPENF1_BASE}/position", {"session_key": session_key})
    if not isinstance(position_rows, list) or not position_rows:
        return None

    return positions_from_openf1(lap_rows, position_rows) or None


async def _race_date(db, year: int, round_number: int) -> str | None:
    """The `YYYY-MM-DD` date of a round, from the already-synced `races` collection.

    OpenF1 has no notion of a championship round number, so its session lookup
    has to go through the date.
    """
    try:
        race = await db.races.find_one(
            {"season": year, "round": str(round_number)}, {"_id": 0, "date": 1}
        )
    except Exception as error:
        print(f"Failed to read race date for {year} R{round_number}: {error}")
        return None
    return (race or {}).get("date")


def build_race_laps(year: int, round_number: int) -> list[dict] | None:
    """Load a race from FastF1 and derive its per-lap positions and gaps.

    Returns None when the session can't be loaded at all (so the caller can
    tell "no data yet" apart from "this race doesn't exist"), and an empty
    list when it loaded but carried no usable laps.
    """
    enable_cache()

    try:
        session = fastf1.get_session(year, round_number, "R")
        session.load(laps=True, telemetry=False, weather=False, messages=False)
    except Exception as error:
        print(f"race laps R{round_number} {year} unavailable: {error}")
        return None

    try:
        laps = session.laps
        available = [column for column in LAP_COLUMNS if column in laps.columns]
        rows = laps[available].to_dict("records")
    except Exception as error:
        print(f"race laps R{round_number} {year} has no usable laps: {error}")
        return []

    return positions_from_laps(rows)


def build_race_laps_any(year: int, round_number: int, race_date: str | None) -> tuple[list[dict] | None, str]:
    """`(rows, source)` from OpenF1 if it has the round, else FastF1.

    The one rebuild order for both the endpoint and `data_sync`. OpenF1 first
    because it is reachable from Cloud Run; FastF1 for pre-2023 seasons and
    any round OpenF1 lacks. The sync used to go straight to FastF1, which
    fails soft from Cloud Run (and, as of 2026-10-23, returns 401 for the
    whole static archive from a home connection too), so it could not rebuild
    anything on its own.
    """
    if race_date:
        laps = build_race_laps_openf1(race_date)
        if laps:
            return laps, "openf1"
    return build_race_laps(year, round_number), "fastf1"


@router.get("/race_laps")
async def get_race_laps(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round_number: int = Query(..., alias="round", description="Round number within the season"),
):
    """Per-lap track position and gap-to-leader for a race, Mongo-first with an OpenF1-then-FastF1 rebuild on a miss.

    A miss neither source can fill is not an error — the honest answer is that
    this round hasn't been processed yet. `synced` tells the frontend which case
    it's looking at.

    A stored doc without `line_seconds` was built by the old summed-lap-time
    derivation, whose gaps are wrong wherever a lap time was missing. It is
    rebuilt like a miss; if neither source can rebuild it, it is still served
    rather than reporting the round as unsynced.
    """
    db = get_db()

    doc = await db.race_laps.find_one(
        {"season": year, "round": str(round_number)}, {"_id": 0, "synced_at": 0}
    )
    if doc and doc.get("laps") and has_line_times(doc["laps"]):
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "laps": doc["laps"],
            "synced": True,
        })

    race_date = await _race_date(db, year, round_number)
    laps, source = build_race_laps_any(year, round_number, race_date)

    if not laps:
        if doc and doc.get("laps"):
            return JSONResponse(content={
                "year": year,
                "round": round_number,
                "laps": doc["laps"],
                "synced": True,
            })
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "laps": [],
            "synced": False,
        })

    try:
        await db.race_laps.update_one(
            {"season": year, "round": str(round_number)},
            {"$set": {
                "season": year,
                "round": str(round_number),
                "laps": laps,
                "source": source,
            }},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to self-heal race_laps for {year} R{round_number}: {error}")

    return JSONResponse(content={
        "year": year,
        "round": round_number,
        "laps": laps,
        "synced": True,
    })
