"""Per-second interval, gap and position samples for a finished race.

`race_laps` and `race_replay` are both lap-indexed: one answer per driver per
lap. That shape is what makes watch mode's timing tower change only when a lap
completes, and it is not a rendering bug — the intra-lap data is discarded at
ingest. This module is the un-discarding. It reads OpenF1's `/intervals` feed
(never called anywhere else in this app) and its `/position` feed at their
native cadence and serves them as raw samples on a race-elapsed clock.

**Nothing here is interpolated.** Every number served is a real measurement
OpenF1 reported at a real instant. The rejected alternative — deriving
intra-lap gaps by interpolating between lap boundaries — would have invented
every number it produced, in a mode whose stated premise is refusing to
fabricate pacing. A round OpenF1 cannot cover reports `synced: false` and
degrades to the existing lap-stepped tower rather than smoothing over the hole.

**The anchoring is the whole difficulty.** OpenF1 stamps every sample with
wall-clock time. The frontend's `RealTimeLapClock` runs a *synthetic* timeline
built by summing measured lap durations, and the two drift — a red flag, a
formation-lap delay, or simply accumulated rounding puts them minutes apart by
the end of a race. Subtracting a race-start timestamp from each sample would
therefore place late-race samples at visibly wrong points on the clock the
frontend actually runs. So samples are instead resolved against the *leader's*
lap boundaries into `(lap, fraction through that lap)` and re-expressed as
elapsed time on the same summed-duration timeline the clock uses. See
`_lap_spans` and `_anchor`.

**A sample that lands outside every lap span is dropped, never clamped.**
OpenF1's feeds start well before lights out — grid formation, the reconnaissance
laps — and clamping those to `t=0` would pile dozens of position events onto the
first instant of the race, which renders as a phantom position shuffle the
moment the lights go out. Dropping them costs nothing real: there is no race
happening yet.

**`interval` and `gap_to_leader` are `number | string | null` and strings are
load-bearing.** About 20% of `gap_to_leader` values in a real race are strings
like `"+1 LAP"` — that is broadcast semantics for a lapped car, not corrupt
data. Coercing them to numbers, or dropping rows that carry them, would silently
delete the entire back half of the field's gap readout for most of a race. They
are passed through verbatim; only genuine floats are rounded.

Cached in `race_timing` for the same reason `race_replay` caches: a finished
race's timing is immutable, and the payload is ~450 KB raw, which is far too
much to rebuild from three OpenF1 fetches on every view. `TIMING_VERSION` is
part of the cache key so a change to the payload shape retires existing
documents instead of serving them to a frontend expecting the new one.
"""

import asyncio
import datetime

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .race_laps import (
    OPENF1_BASE,
    _as_int,
    _fetch_json,
    _lap_end_times,
    _parse_iso,
)

router = APIRouter(prefix="/api")

# Bump when the payload shape *or* how it's derived changes. Existing cached
# documents stop matching and rebuild on next view.
TIMING_VERSION = 1


def _round_value(value):
    """Round a float to 2dp; leave strings, None and ints exactly as they are.

    2dp is the resolution the tower renders at, and rounding here rather than in
    the frontend is worth ~40% of the payload: an unrounded OpenF1 float
    serialises as `1.2340000000000002`, seventeen characters where four will do,
    across ~45,000 values.

    The string branch is the important one and it is not defensive padding.
    `"+1 LAP"` is what OpenF1 reports for a lapped car — a fifth of all
    `gap_to_leader` values in a real race — and the contract requires it reach
    the client verbatim. Anything that tried to be clever here (parsing the
    leading `+1`, or discarding the value as unparseable) would blank the gap
    column for most of the field for most of the race.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        # bool is an int subclass; a boolean in a gap field is nonsense data, so
        # it is dropped to None rather than silently emitted as 1.
        return None
    if isinstance(value, (int, float)):
        return round(value, 2)
    return None


def _leader_boundaries(
    lap_rows: list[dict],
) -> tuple[dict[int, datetime.datetime], float | None]:
    """The leader's lap-completion instants, plus the leader's lap-1 duration.

    Returns `({lap_number: instant lap N ended}, lap_1_duration_seconds)`.

    Position is never consulted. The earliest line crossing for a given lap
    number *is* the leader's crossing of it, by the definition of leading — so
    taking the minimum across drivers gets the same answer as
    `race_laps.positions_from_openf1`'s time-joined position lookup without
    depending on the `/position` feed at all. That independence matters here:
    positions are one of the two things this endpoint is trying to serve, so
    deriving the timeline from them would make the timeline fail exactly on the
    rounds where the position feed is the thing that's missing.

    Per-driver crossing instants come from `race_laps._lap_end_times`, which
    already handles OpenF1's two ways of expressing them (the next lap's
    `date_start`, falling back to this lap's start plus its duration) and
    returns None where neither is available.

    The second return value exists because lap 1 has no preceding boundary to
    start from. It is read off whichever driver actually made that earliest
    lap-1 crossing, so it is the leader's own measured lap, not an average.
    """
    by_driver: dict[int, list[dict]] = {}
    for row in lap_rows:
        driver_number = _as_int(row.get("driver_number"))
        if driver_number is None or _as_int(row.get("lap_number")) is None:
            continue
        by_driver.setdefault(driver_number, []).append(row)

    boundaries: dict[int, datetime.datetime] = {}
    # Kept alongside the boundary so lap 1's duration can be read off the driver
    # who set it, rather than re-searching the rows afterwards.
    lap_one_duration: float | None = None

    for driver_laps in by_driver.values():
        driver_laps.sort(key=lambda r: _as_int(r.get("lap_number")))
        ends = _lap_end_times(driver_laps)
        for row in driver_laps:
            lap_number = _as_int(row.get("lap_number"))
            end = ends.get(lap_number)
            if end is None:
                continue
            known = boundaries.get(lap_number)
            if known is None or end < known:
                boundaries[lap_number] = end
                if lap_number == 1:
                    duration = row.get("lap_duration")
                    lap_one_duration = (
                        float(duration) if isinstance(duration, (int, float)) else None
                    )

    return boundaries, lap_one_duration


def _lap_spans(
    boundaries: dict[int, datetime.datetime], lap_one_duration: float | None
) -> list[tuple[datetime.datetime, datetime.datetime, float, float]]:
    """Turn lap-boundary instants into `(start, end, lap_seconds, cumulative)` spans.

    Lap N spans `boundaries[N-1] .. boundaries[N]`. Lap 1 has no `boundaries[0]`,
    so its start is derived as `boundaries[1] - lap_one_duration`. When that
    duration is unavailable the span is simply not built: lap-1 samples are
    dropped rather than hung off a guessed race start, because a guess here
    would shift *every* sample in the race by however far the guess was wrong,
    and would do it invisibly.

    `cumulative` is the running sum of preceding `lap_seconds`, so
    `cumulative + fraction * lap_seconds` reads as elapsed race time. With every
    duration coming from these same boundaries that expression collapses to
    `sample_instant - race_start`, and computing it that way would be both
    shorter and, today, identical. It is written out in the explicit two-term
    form anyway because the durations are the seam most likely to move — the
    moment they come from anywhere else (`race_laps.lap_time_seconds`, say, so
    the payload agrees with the frontend clock exactly), the collapsed form
    silently stops being correct while continuing to produce plausible numbers.

    A missing intermediate boundary (OpenF1 does drop the occasional lap) leaves
    the following lap's span stretching across both laps rather than splitting
    the sequence. The fractions inside that stretch are then coarse, but elapsed
    time stays monotonic and every sample in the region still lands in the right
    minute — much better than dropping two laps of the race outright.
    """
    spans: list[tuple[datetime.datetime, datetime.datetime, float, float]] = []
    previous: datetime.datetime | None = None
    cumulative = 0.0

    for lap in sorted(boundaries):
        end = boundaries[lap]
        start = previous
        if lap == 1:
            start = (
                end - datetime.timedelta(seconds=lap_one_duration)
                if lap_one_duration is not None
                else None
            )
        previous = end

        if start is None:
            continue
        lap_seconds = (end - start).total_seconds()
        # A non-positive span is unusable as a denominator and means the two
        # boundaries are out of order — bad data, not a short lap.
        if lap_seconds <= 0:
            continue
        spans.append((start, end, lap_seconds, cumulative))
        cumulative += lap_seconds

    return spans


def _anchor(
    moment: datetime.datetime,
    spans: list[tuple[datetime.datetime, datetime.datetime, float, float]],
) -> int | None:
    """Elapsed race time in integer milliseconds for a wall-clock instant, or None.

    None means the instant sits outside every lap — before the leader started
    lap 1, or after they crossed the line for the last time — and per the design
    such a sample is dropped by the caller rather than clamped to an endpoint.

    A linear scan is deliberate over a bisect: the span list is one entry per lap
    (~60), and it is walked ~23,000 times per race, once at build time, once
    ever, behind a cache. Bisect would buy nothing and would have to get the
    half-open/closed boundary handling right in a less obvious way.
    """
    last = len(spans) - 1
    for index, (start, end, lap_seconds, cumulative) in enumerate(spans):
        # Half-open at the top so an instant exactly on a boundary belongs to the
        # lap it starts, not the one it ends — except at the very last boundary,
        # where there is no following lap to claim it and closing the interval is
        # what keeps the chequered-flag sample.
        inside = start <= moment < end or (index == last and moment == end)
        if inside:
            fraction = (moment - start).total_seconds() / lap_seconds
            return round(1000 * (cumulative + fraction * lap_seconds))
    return None


def build_timing(
    lap_rows: list[dict], interval_rows: list[dict], position_rows: list[dict]
) -> dict:
    """The `drivers` map of the contract, from three raw OpenF1 feeds.

    Pure: no Mongo, no network, no clock. Every behaviour worth testing —
    anchoring, the drop-don't-clamp rule, string and null gap passthrough,
    ordering, arity — is reachable from here with plain dicts, which is why the
    endpoint below is kept to nothing but fetching and caching.

    A driver who ends up with no anchorable samples at all is omitted from the
    result entirely rather than emitted with two empty arrays, so a driver's
    presence in `drivers` always means there is something to draw for them.
    The one exception is deliberate: a driver with samples in one feed and not
    the other is kept, with the missing side as `[]`. That is the design's
    "timing only" degradation row, and dropping those drivers would turn a
    round with no `/position` coverage into a round with no data whatsoever.

    Empty or unusable input yields `{}`, never an exception. Every caller of
    this module treats "no data" as a normal state of the world (`synced:
    false`), so there is nothing for a raise to communicate that the empty dict
    does not.
    """
    boundaries, lap_one_duration = _leader_boundaries(lap_rows or [])
    spans = _lap_spans(boundaries, lap_one_duration)
    if not spans:
        return {}

    timing: dict[str, list] = {}
    positions: dict[str, list] = {}

    for row in interval_rows or []:
        driver_number = _as_int(row.get("driver_number"))
        moment = _parse_iso(row.get("date"))
        if driver_number is None or moment is None:
            continue
        t_ms = _anchor(moment, spans)
        if t_ms is None:
            continue
        timing.setdefault(str(driver_number), []).append([
            t_ms,
            _round_value(row.get("interval")),
            _round_value(row.get("gap_to_leader")),
        ])

    for row in position_rows or []:
        driver_number = _as_int(row.get("driver_number"))
        position = _as_int(row.get("position"))
        moment = _parse_iso(row.get("date"))
        if driver_number is None or position is None or moment is None:
            continue
        t_ms = _anchor(moment, spans)
        if t_ms is None:
            continue
        positions.setdefault(str(driver_number), []).append([t_ms, position])

    drivers: dict[str, dict] = {}
    for number in set(timing) | set(positions):
        driver_timing = sorted(timing.get(number, []), key=lambda sample: sample[0])
        driver_positions = sorted(positions.get(number, []), key=lambda sample: sample[0])
        # Present-with-one-feed is a real and useful state (the design's
        # "timing only" degradation row), so a driver is kept as long as at
        # least one array has something in it — but the empty one is still
        # emitted as an empty list so the two keys always exist.
        if not driver_timing and not driver_positions:
            continue
        drivers[number] = {"timing": driver_timing, "positions": driver_positions}

    return drivers


def fetch_timing_openf1(race_date: str) -> dict:
    """Build the `drivers` map for the race on `race_date` straight from OpenF1.

    Returns `{}` for every failure mode — no session for that date, a feed that
    404s or times out, a season before OpenF1's 2023 coverage starts. The caller
    turns that into `synced: false`, which is the honest answer and not an
    error. Unlike the FastF1 path `race_laps` falls back to, this works from a
    datacenter IP, so the self-heal below actually fires in production.

    `/laps` is fetched even though this module serves no per-lap data: it is the
    only source of the lap boundaries the whole anchoring rests on. Without it
    there is nothing to place a sample against, so the two large feeds are not
    paid for at all.
    """
    from .race_stints import fetch_openf1_session_key

    session_key = fetch_openf1_session_key(race_date)
    if session_key is None:
        return {}

    lap_rows = _fetch_json(f"{OPENF1_BASE}/laps", {"session_key": session_key})
    if not isinstance(lap_rows, list) or not lap_rows:
        return {}

    # The intervals feed is ~22,000 rows for one race, comfortably past the
    # default timeout on a slow link, so it gets a longer one of its own.
    interval_rows = _fetch_json(
        f"{OPENF1_BASE}/intervals", {"session_key": session_key}, timeout=60.0
    )
    position_rows = _fetch_json(f"{OPENF1_BASE}/position", {"session_key": session_key})

    return build_timing(
        lap_rows,
        interval_rows if isinstance(interval_rows, list) else [],
        position_rows if isinstance(position_rows, list) else [],
    )


async def _race_date(db, year: int, round_number: int) -> str | None:
    """The `YYYY-MM-DD` date of a round, from the already-synced `races` collection.

    Same lookup `race_laps` makes and for the same reason: OpenF1 has no notion
    of a championship round number, so its session lookup goes through the date.
    """
    try:
        race = await db.races.find_one(
            {"season": year, "round": str(round_number)}, {"_id": 0, "date": 1}
        )
    except Exception as error:
        print(f"race_timing: failed to read race date for {year} R{round_number}: {error}")
        return None
    return (race or {}).get("date")


@router.get("/race_timing")
async def get_race_timing(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round_number: int = Query(..., alias="round", description="Round number within the season"),
):
    """Per-second timing and position samples for a race, Mongo-first with an OpenF1 rebuild.

    A round with no per-second track is not an error — `synced: false` with an
    empty `drivers` map is the honest answer, and the frontend degrades to the
    existing lap-stepped tower on it. That covers pre-2023 seasons entirely
    (OpenF1 has no data before then) and any later round its feeds missed.

    Nothing in here raises. A rebuild that fails for any reason answers exactly
    like a round that has no data, because from a consumer's point of view those
    are the same situation and the tower has the same fallback for both.
    """
    db = get_db()
    cache_key = {"season": year, "round": str(round_number), "version": TIMING_VERSION}

    try:
        cached = await db.race_timing.find_one(cache_key, {"_id": 0})
    except Exception as error:
        print(f"race_timing: cache read failed for {year} R{round_number}: {error}")
        cached = None

    if cached and cached.get("drivers"):
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "drivers": cached["drivers"],
            "synced": True,
        })

    drivers: dict = {}
    try:
        race_date = await _race_date(db, year, round_number)
        if race_date:
            # `fetch_timing_openf1` is blocking httpx over ~25,000 rows; running
            # it inline would stall the event loop for the length of three
            # sequential HTTP fetches and block every other request served by
            # this process meanwhile.
            drivers = await asyncio.to_thread(fetch_timing_openf1, race_date)
    except Exception as error:
        print(f"race_timing: rebuild failed for {year} R{round_number}: {error}")
        drivers = {}

    if not drivers:
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "drivers": {},
            "synced": False,
        })

    try:
        await db.race_timing.update_one(
            cache_key, {"$set": {**cache_key, "drivers": drivers}}, upsert=True
        )
    except Exception as error:
        print(f"Failed to cache race_timing for {year} R{round_number}: {error}")

    return JSONResponse(content={
        "year": year,
        "round": round_number,
        "drivers": drivers,
        "synced": True,
    })
