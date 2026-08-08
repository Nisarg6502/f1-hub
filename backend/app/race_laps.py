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

Each row also carries `lap_time_seconds`, that single lap's own duration.
It was long computed here and discarded; it is kept because a real-time
replay clock has to advance by each lap's actual length, and `gap_seconds`
cannot stand in for it (a gap is relative and goes null wherever either side
lacks timing, so a clock built on it stalls instead of merely approximating).
The same "additional key" argument below applies to it: a doc cached before
this change simply lacks the key and reads as `None`, so no forced rebuild is
warranted here either — but note that means the field is null until a local
re-sync backfills it.

Because `gap_seconds` is just an additional key on each row dict, this is
naturally backward compatible with documents cached before this change: an
old cached doc's rows simply don't have the key, `.get("gap_seconds")` reads
as `None` for them, and the frontend already treats a missing/null gap as "no
gap data for this round" rather than a crash. No cache-doc version bump or
forced rebuild is needed -- and forcing one would be actively harmful, since
re-deriving from FastF1 only works from a local sync; forcing a rebuild on
Cloud Run would turn an already-working position chart into "not synced yet"
until the next local sync runs.

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
    `positions_from_laps` sorts them) and each row must carry a
    `lap_time_seconds` key, which this function reads but -- unlike the
    scratch key it used to consume -- leaves in place. That duration is now a
    persisted field in its own right (it is what the watch-party mode's
    real-time clock advances on), so throwing it away here would mean every
    sync recomputing a number and discarding it, which is exactly the gap
    Batch 21 exists to close. Nothing about the gap math below changed with
    it: the key is read at the same point, with the same meaning.

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
        seconds = row.get("lap_time_seconds")
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
    """Flatten lap rows into one record per (driver, lap) with position, gap and duration.

    Kept independent of pandas so it can be exercised directly: the endpoint
    and the sync job both hand it plain row dicts. Rows missing a driver
    number, lap number, or position are dropped -- a driver who retired mid-
    race simply has no rows past their last completed lap, which the chart
    reads as "line ends here" rather than a gap to fill in. A missing/null
    `LapTime` does NOT drop the row (position data is still valid); it only
    affects that row's `gap_seconds` -- see `_attach_gap_seconds`.

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
        })

    rows.sort(key=lambda r: (r["driver_number"], r["lap_number"]))
    _attach_gap_seconds(rows)
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

    `gap_seconds` is the difference between two line-crossing instants — this
    driver's, and that of whoever was leading at that same lap number — so it
    is a true elapsed-time gap rather than the FastF1 path's running sum of
    lap times. It agrees with that path to within ~0.05s median on a clean
    round, and is *more* accurate where FastF1 has to skip a null lap time.
    Same contract as `_attach_gap_seconds`: 0 for the leader, None when either
    side's crossing instant is unknown — which the frontend already reads as
    "no gap data" rather than a crash.

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

    leader_end_by_lap: dict[int, datetime.datetime] = {}
    for row in rows:
        if row["position"] == 1 and row["_end"] is not None:
            leader_end_by_lap[row["lap_number"]] = row["_end"]

    for row in rows:
        end = row.pop("_end")
        leader_end = leader_end_by_lap.get(row["lap_number"])
        if end is None or leader_end is None:
            row["gap_seconds"] = None
        else:
            row["gap_seconds"] = round((end - leader_end).total_seconds(), 3)

    rows.sort(key=lambda r: (r["driver_number"], r["lap_number"]))
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


@router.get("/race_laps")
async def get_race_laps(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round_number: int = Query(..., alias="round", description="Round number within the season"),
):
    """Per-lap track position and gap-to-leader for a race, Mongo-first with an OpenF1-then-FastF1 rebuild on a miss.

    A miss neither source can fill is not an error — the honest answer is that
    this round hasn't been processed yet. `synced` tells the frontend which case
    it's looking at.

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

    laps = None
    source = "openf1"
    race_date = await _race_date(db, year, round_number)
    if race_date:
        laps = build_race_laps_openf1(race_date)

    if not laps:
        source = "fastf1"
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
