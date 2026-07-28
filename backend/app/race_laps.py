"""Track position and gap-to-leader per lap for a finished race, sourced from FastF1.

Powers the Pitwall "Lap Telemetry" chart. `session.laps` already carries a
`Position` column alongside the `Stint`/`Compound`/`TyreLife` data
`race_stints` reads from the same DataFrame, so this needs no new FastF1 API
surface -- just a different subset of columns off the same load. Served with
the same Mongo-first / self-heal pattern as `circuit_info` and `race_stints`.

Originally this endpoint was track-position-only ("who overtook whom"), with
its docstring noting that a time-based gap needs cumulative race-time
reconstruction per driver -- a materially bigger endpoint. This is that
endpoint: alongside `position`, each row now also carries `gap_seconds`, the
driver's cumulative race time (running sum of their own `LapTime`s) minus the
lap's leader's cumulative time. See `_attach_gap_seconds` for the null-LapTime
and lapped-traffic caveats baked into that computation.

Because `gap_seconds` is just an additional key on each row dict, this is
naturally backward compatible with documents cached before this change: an
old cached doc's rows simply don't have the key, `.get("gap_seconds")` reads
as `None` for them, and the frontend already treats a missing/null gap as "no
gap data for this round" rather than a crash. No cache-doc version bump or
forced rebuild is needed -- and forcing one would be actively harmful, since
re-deriving from FastF1 only works from a local sync; forcing a rebuild on
Cloud Run would turn an already-working position chart into "not synced yet"
until the next local sync runs.

Same FastF1-on-Cloud-Run caveat as every other FastF1-backed feature here:
`livetiming.formula1.com` 403s datacenter IPs, so the live rebuild below only
succeeds when it runs on a local machine. In production the collection is
expected to be pre-populated by `data_sync.sync_race_laps`.
"""

import fastf1
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .f1_results import enable_cache

router = APIRouter(prefix="/api")

# Columns of `session.laps` this endpoint reads. Anything else on the frame is
# lap timing detail the position/gap chart has no use for. `LapTime` is a
# `pandas.Timedelta` (or `NaT`) per lap, used to reconstruct cumulative race
# time -- see `_lap_time_seconds` and `_attach_gap_seconds`.
LAP_COLUMNS = ("DriverNumber", "LapNumber", "Position", "LapTime")


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
    """Coerce a `LapTime` cell (a `pandas.Timedelta`, `NaT`, or None) to seconds.

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


def _attach_gap_seconds(rows: list[dict]) -> None:
    """Mutate `rows` in place, adding a `gap_seconds` key to each.

    `rows` must already be sorted by `(driver_number, lap_number)` (as
    `positions_from_laps` sorts them) and each row must carry a scratch
    `_lap_time_seconds` key, which this function consumes and removes.

    Per driver, this walks their laps in order and keeps a running total --
    their cumulative race time as of that lap. `gap_seconds` for a row is then
    that driver's cumulative total minus the cumulative total of whichever
    driver held `position == 1` at that *same lap number* -- 0 for the leader
    themselves. Comparing by lap number rather than by wall-clock time is a
    deliberate simplification: it matches how the chart already treats "lap N"
    as its x-axis unit (same as the position chart), and needs no clock
    alignment across drivers who may be on different laps due to retirements
    or being lapped. It is not a perfectly live gap for lapped traffic, but
    it's the same approximation every "gap chart by lap" makes.

    Null LapTimes (see `_lap_time_seconds`) get a "skip and carry forward"
    treatment: the running total for that driver is left unchanged for that
    one lap rather than treated as a zero-duration lap (which would silently
    shrink their cumulative time and produce a bogus gap swing on the next
    lap) or aborting their cumulative total outright (which would blank out
    gap data for the rest of that driver's race over one missing sample).
    The tradeoff is that a driver's cumulative time -- and every gap derived
    from it from that point on -- is understated by the true duration of
    whatever lap(s) got skipped. That's an acceptable approximation for a
    chart annotation, not an accounting system.

    A row's `gap_seconds` is `None` when either side of the subtraction is
    unknown: the driver has no valid cumulative total yet (their race-so-far
    has no usable LapTime at all), or the lap's leader doesn't (same reason).
    That in turn means a round with no usable `LapTime` data at all (e.g. an
    old FastF1 session missing the column) ends up with every row's
    `gap_seconds` at `None` -- which the frontend already treats as "no gap
    data for this round," not a crash.
    """
    running_total: dict[int, float | None] = {}
    leader_cumulative_by_lap: dict[int, float | None] = {}

    for row in rows:
        driver = row["driver_number"]
        seconds = row.pop("_lap_time_seconds", None)
        total = running_total.get(driver)
        if seconds is not None:
            total = (total or 0.0) + seconds
        running_total[driver] = total
        row["_cumulative_seconds"] = total
        if row["position"] == 1:
            leader_cumulative_by_lap[row["lap_number"]] = total

    for row in rows:
        own_total = row.pop("_cumulative_seconds", None)
        leader_total = leader_cumulative_by_lap.get(row["lap_number"])
        if own_total is None or leader_total is None:
            row["gap_seconds"] = None
        else:
            row["gap_seconds"] = round(own_total - leader_total, 3)


def positions_from_laps(laps: list[dict]) -> list[dict]:
    """Flatten lap rows into one record per (driver, lap) with position and gap.

    Kept independent of pandas so it can be exercised directly: the endpoint
    and the sync job both hand it plain row dicts. Rows missing a driver
    number, lap number, or position are dropped -- a driver who retired mid-
    race simply has no rows past their last completed lap, which the chart
    reads as "line ends here" rather than a gap to fill in. A missing/null
    `LapTime` does NOT drop the row (position data is still valid); it only
    affects that row's `gap_seconds` -- see `_attach_gap_seconds`.
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
            "_lap_time_seconds": _lap_time_seconds(lap.get("LapTime")),
        })

    rows.sort(key=lambda r: (r["driver_number"], r["lap_number"]))
    _attach_gap_seconds(rows)
    return rows


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


@router.get("/race_laps")
async def get_race_laps(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round_number: int = Query(..., alias="round", description="Round number within the season"),
):
    """Per-lap track position and gap-to-leader for a race, Mongo-first with a FastF1 rebuild on a miss.

    A miss that can't be rebuilt is not an error: on Cloud Run the rebuild is
    always blocked, and the honest answer is that the local sync hasn't run for
    this round yet. `synced` tells the frontend which case it's looking at.

    A cached doc from before `gap_seconds` existed is served as-is: its rows
    just won't have that key, which reads as "no gap data" on the frontend
    rather than an error -- see the module docstring for why that's fine and
    no cache version bump is warranted.
    """
    db = get_db()

    doc = await db.race_laps.find_one(
        {"season": year, "round": str(round_number)}, {"_id": 0, "synced_at": 0}
    )
    if doc and doc.get("laps"):
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "laps": doc["laps"],
            "synced": True,
        })

    laps = build_race_laps(year, round_number)
    if not laps:
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "laps": [],
            "synced": False,
        })

    try:
        await db.race_laps.update_one(
            {"season": year, "round": str(round_number)},
            {"$set": {"season": year, "round": str(round_number), "laps": laps}},
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
