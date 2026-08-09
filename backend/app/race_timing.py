"""Per-second interval, gap and position samples for a finished race.

`race_laps` and `race_replay` are both lap-indexed: one answer per driver per
lap. That shape is what makes watch mode's timing tower change only when a lap
completes, and it is not a rendering bug — the intra-lap data is discarded at
ingest. This module is the un-discarding. It serves the official lap-by-lap
record as an exact skeleton and fills the space between line crossings with
OpenF1's `/position` and `/intervals` feeds at their native cadence.

**Nothing here is interpolated.** Every number served is a real measurement
someone reported at a real instant.

**The official record is the spine, and that is the whole design.** Earlier
versions of this module built the timeline out of OpenF1's `/laps` feed and
validated it against OpenF1's other feeds, which is not a check at all — a feed
always agrees with itself. Measured against the official classification, the
2026 Australian GP came out with laps 1 and 2 inverted. See `official_laps` for
the two independent faults behind that, both of them unreachable from inside
OpenF1's data.

So the shape of the derivation is now:

* **Lap boundaries are exact.** Each driver gets a position sample at their own
  official crossing time for every lap. Those samples cannot drift, because
  they are not derived from anything — they are the classification.
* **OpenF1 fills the gaps between them**, and is *corrected at every crossing*.
  A wrong intra-lap sample can now cost at most the remainder of one lap
  instead of propagating for the rest of the race.
* **There is no rescaling.** Cumulative official lap times are real elapsed
  race seconds, and the replay clock is driven by the same numbers (`lap_ms` in
  the payload), so a sample's timestamp and the clock's reading are the same
  quantity. The predecessor mapped wall-clock instants onto a *synthetic* clock
  built from summed lap minima, stretching each lap by the ratio between the
  two; that distortion is where every position bug lived. Round 1's lap 1
  spanned 182.5s of wall clock against a 91.9s clock lap, so its opening was
  compressed 2:1 — laps 1 and 2 landed on top of each other.

Aligning OpenF1's wall clock to that timeline needs exactly one number: the
instant of lights out. It is measured, not assumed — see `race_start_offset`.

**`interval` and `gap_to_leader` are `number | string | null` and strings are
load-bearing.** About 20% of `gap_to_leader` values in a real race are strings
like `"+1 LAP"` — that is broadcast semantics for a lapped car, not corrupt
data. Coercing them to numbers, or dropping rows that carry them, would silently
delete the entire back half of the field's gap readout for most of a race. They
are passed through verbatim; only genuine floats are rounded.

Cached in `race_timing` for the same reason `race_replay` caches: a finished
race's timing is immutable, and the payload is ~450 KB raw, which is far too
much to rebuild from four fetches on every view. `TIMING_VERSION` is part of
the cache key so a change to the payload shape retires existing documents
instead of serving them to a frontend expecting the new one.
"""

import asyncio
import datetime
import statistics

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .official_laps import official_laps_for
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
#
# 5 retires every payload built on the OpenF1-derived timeline. Those are not
# merely imprecise: on round 1 they invert laps 1 and 2 against the official
# classification, because the opening of the race was compressed 2:1 by the
# clock rescaling and because OpenF1's `/laps` feed is missing lap-2 rows for
# the leading three cars. Nothing about their *shape* is wrong, so without this
# bump a stale document would keep serving the inverted order indefinitely —
# which is the harder half of this constant's rule to remember.
TIMING_VERSION = 5

# How far an individual lap's implied lights-out instant may sit from the
# median before it is discarded as a bad boundary. Measured across rounds 3 and
# 6, the true spread is 0.2s peak-to-peak over a full race; round 1 has a
# handful of laps 30s out, which is OpenF1's missing rows rather than any real
# drift. 5s is comfortably outside the noise and comfortably inside the fault.
OFFSET_TOLERANCE_SECONDS = 5.0


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


def driver_numbers_from_results(results: list[dict]) -> dict[str, str]:
    """`{driverId: car number}` from a round's `race_results`.

    The official lap archive identifies drivers by `driverId` (`"leclerc"`) and
    every other feed in this app by car number, so one of these is needed to
    join them. `race_results` is the only place both appear on the same row.
    """
    mapping: dict[str, str] = {}
    for row in results or []:
        driver = row.get("Driver") or {}
        driver_id = driver.get("driverId")
        number = row.get("number") or driver.get("permanentNumber")
        if driver_id and number:
            mapping[str(driver_id)] = str(number)
    return mapping


def official_samples(
    official_rows: list[dict], driver_numbers: dict[str, str]
) -> tuple[dict[str, list[list[int]]], list[int], dict[int, int]]:
    """The exact skeleton: `(boundary samples, lap_ms, leader cumulative ms)`.

    `boundary samples` is `{car number: [[elapsed_ms, position], ...]}` — one
    entry per driver per lap they completed, stamped with *their own* crossing
    time rather than the leader's. That distinction is the point: a car 20s down
    the road genuinely takes the position it is classified in 20s after the
    leader does, and stamping the whole field at the leader's instant would make
    the tower snap the entire order at once, once a lap, which is the very
    behaviour this module exists to remove.

    `lap_ms` is the leader's duration for each lap, index-aligned to laps 1..N,
    and is what the replay clock runs on. Deriving it here rather than letting
    the frontend sum `race_laps` is what keeps the clock and these timestamps on
    one timeline.

    A driver the results have no car number for is skipped rather than keyed by
    `driverId` — a mixed-key map would silently fail to join against every other
    feed, which is much harder to notice than an absent driver.
    """
    samples: dict[str, list[list[int]]] = {}
    leader_cumulative: dict[int, int] = {}

    for row in official_rows or []:
        lap = _as_int(row.get("lap"))
        if lap is None:
            continue
        for timing in row.get("timings") or []:
            number = driver_numbers.get(str(timing.get("driverId")))
            position = _as_int(timing.get("position"))
            elapsed = _as_int(timing.get("cumulative_ms"))
            if number is None or position is None or elapsed is None:
                continue
            samples.setdefault(number, []).append([elapsed, position])
            if lap not in leader_cumulative or elapsed < leader_cumulative[lap]:
                leader_cumulative[lap] = elapsed

    lap_ms: list[int] = []
    previous = 0
    for lap in sorted(leader_cumulative):
        current = leader_cumulative[lap]
        # A non-positive duration cannot be consumed by the clock's frame loop
        # and means the archive's cumulative times went backwards — bad data,
        # not a short lap. The lap is held at the previous boundary instead.
        if current > previous:
            lap_ms.append(current - previous)
            previous = current

    return samples, lap_ms, leader_cumulative


def race_start_offset(
    lap_rows: list[dict], leader_cumulative: dict[int, int]
) -> datetime.datetime | None:
    """The wall-clock instant of lights out, measured against the official record.

    For every lap that both sources describe, `OpenF1's leader crossing minus
    the official leader's elapsed time at that lap` is an independent estimate
    of when the race started. Because the official timeline is real elapsed
    seconds and OpenF1 stamps real wall-clock instants, these estimates are all
    the same number up to measurement noise — confirmed at 0.2s peak-to-peak
    across a full race on rounds 3 and 6.

    **The median is taken rather than any single lap**, and that is what makes
    this robust where the previous approach was not. Round 1 has laps whose
    estimate is 30s out, because OpenF1 is missing crossings for the leading
    cars there; 44 of its 57 laps still agree within a second, so the median
    lands on the truth and the bad laps are simply outvoted. Reading the start
    off any one lap — or off the uniform lap-1 `date_start`, which is the
    formation-lap departure and lands ~90s early — puts the whole opening of the
    race in the wrong place.

    Returns None when the two sources share no lap, which leaves the round with
    no way to place OpenF1's samples and degrades it to the official skeleton
    alone.
    """
    by_driver: dict[int, list[dict]] = {}
    for row in lap_rows or []:
        driver_number = _as_int(row.get("driver_number"))
        if driver_number is None:
            continue
        by_driver.setdefault(driver_number, []).append(row)

    crossings: dict[int, datetime.datetime] = {}
    for driver_laps in by_driver.values():
        driver_laps.sort(key=lambda row: _as_int(row.get("lap_number")) or 0)
        for lap, end in _lap_end_times(driver_laps).items():
            if end is None:
                continue
            if lap not in crossings or end < crossings[lap]:
                crossings[lap] = end

    estimates: list[float] = []
    for lap, elapsed_ms in leader_cumulative.items():
        crossing = crossings.get(lap)
        if crossing is None:
            continue
        estimates.append(crossing.timestamp() - elapsed_ms / 1000)

    if not estimates:
        return None

    median = statistics.median(estimates)
    # Re-centre on just the agreeing estimates. The median already ignores the
    # outliers' magnitude, but averaging the survivors shaves the residual
    # quantisation noise off a value everything else is measured against.
    agreeing = [e for e in estimates if abs(e - median) <= OFFSET_TOLERANCE_SECONDS]
    best = statistics.fmean(agreeing) if agreeing else median
    return datetime.datetime.fromtimestamp(best, datetime.timezone.utc)


def _elapsed_ms(moment: datetime.datetime, race_start: datetime.datetime) -> int:
    """Race-elapsed milliseconds for a wall-clock instant. May be negative."""
    return round((moment - race_start).total_seconds() * 1000)


def build_timing(
    official_rows: list[dict],
    driver_numbers: dict[str, str],
    lap_rows: list[dict] | None = None,
    interval_rows: list[dict] | None = None,
    position_rows: list[dict] | None = None,
    grid_positions: dict[str, int] | None = None,
) -> dict:
    """The `{drivers, lap_ms}` payload, from the official record plus OpenF1.

    Pure: no Mongo, no network, no clock. Every behaviour worth testing —
    the official skeleton, the measured start, the drop-don't-clamp rule, string
    and null gap passthrough, ordering, arity — is reachable from here with
    plain dicts, which is why the endpoint below is kept to nothing but fetching
    and caching.

    **Without the official record this returns `{}`**, even when OpenF1 has
    plenty to say. That is deliberate and it is a change in policy: a timeline
    with no exact skeleton is precisely the thing that shipped laps 1 and 2
    inverted, and `synced: false` degrades to the lap-stepped tower, which is
    honest rather than wrong.
    """
    boundary, lap_ms, leader_cumulative = official_samples(official_rows, driver_numbers)
    if not boundary or not lap_ms:
        return {}

    race_end = max(leader_cumulative.values())
    race_start = race_start_offset(lap_rows or [], leader_cumulative)

    timing: dict[str, list] = {}
    positions: dict[str, list[list[int]]] = {
        number: list(samples) for number, samples in boundary.items()
    }

    # The starting grid at t=0, read from `race_results` — the official
    # classification, not a reconstruction.
    #
    # **Two feed-derived reconstructions were tried before this and both looked
    # plausible.** The first dropped every pre-race position event, which left
    # the earliest surviving sample well into lap 1; the lookup then clamped
    # backwards to it and rendered a mid-lap-1 order as the grid. The second
    # collapsed the pre-race events to their final state — which appeared to
    # reproduce the official grid exactly, but only because the probe that
    # "confirmed" it used the formation lap's start as the race start. Measured
    # against the true lights-out instant, that state is the order at the *end*
    # of the formation lap, where cars have already shuffled: 1 of 22 correct on
    # the 2026 Australian GP. `/position` has no instant that reliably means "on
    # the grid", so no amount of care with it recovers the starting order.
    #
    # Seeded before the OpenF1 fill, not after. `_collapse_positions` resolves a
    # timestamp tie in favour of whichever sample was inserted first, so this
    # ordering is what makes the official grid win over any OpenF1 event that
    # happens to land exactly on t=0.
    #
    # Seeded rather than appended for a second reason: a driver whose in-race
    # samples start late is still placed on the grid for the opening stint,
    # instead of having a later position clamped backwards over it.
    #
    # **Only cars that actually took part are seeded.** A "did not start" is
    # still given a grid slot by the classification, and seeding it produced the
    # worst-looking defect of this rewrite: Piastri and Hulkenberg sat on P5 and
    # P11 for the entire 2026 Australian GP, because a car with no lap samples
    # never moves off its seed. Every position behind them was consequently a
    # duplicate, and the tower rendered two P18s and no P16 at all.
    #
    # Presence in the official lap archive is the test rather than the `status`
    # string: it is the same fact without the string matching, and it covers
    # "did not start", "did not qualify" and a withdrawal identically.
    for number, position in (grid_positions or {}).items():
        if number not in boundary:
            continue
        positions.setdefault(number, []).append([0, position])

    if race_start is not None:
        for row in interval_rows or []:
            driver_number = _as_int(row.get("driver_number"))
            moment = _parse_iso(row.get("date"))
            if driver_number is None or moment is None:
                continue
            t_ms = _elapsed_ms(moment, race_start)
            # Outside the race is dropped, never clamped. OpenF1's feeds start
            # well before lights out — grid formation, the reconnaissance laps —
            # and clamping those to t=0 piles dozens of samples onto the first
            # instant, which renders as a phantom shuffle the moment the lights
            # go out.
            if t_ms < 0 or t_ms > race_end:
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
            t_ms = _elapsed_ms(moment, race_start)
            if t_ms < 0 or t_ms > race_end:
                continue
            positions.setdefault(str(driver_number), []).append([t_ms, position])

    # When each car stops being part of the race.
    #
    # A retired car's samples simply stop, and a consumer that carries the last
    # one forward — which is what the tower does, correctly, between crossings —
    # will hold it in the running order for the rest of the afternoon. That is
    # both wrong on its own and corrupting: with the order rendered as a rank, a
    # ghost occupying P4 pushes every car behind it down one for an hour.
    #
    # The test is **when** the car last crossed, not how many laps it did. A
    # lapped car is classified two laps down but still takes the flag, so its
    # final crossing sits within the last lap of the race; a retirement's sits
    # much earlier. `status` is deliberately not consulted: it is free text with
    # a dozen spellings ("Accident", "Engine", "+1 Lap"), and the timing already
    # states the fact plainly.
    final_lap_ms = lap_ms[-1] if lap_ms else 0
    still_running = race_end - 1.5 * final_lap_ms
    out_ms: dict[str, int] = {}
    for number, samples in boundary.items():
        last = max(sample[0] for sample in samples)
        if last < still_running:
            out_ms[number] = last

    drivers: dict[str, dict] = {}
    # **Only cars the official record says took part are served at all.**
    #
    # Restricting the grid seed alone was not enough and the difference is
    # instructive: OpenF1 emits interval and position rows for cars that never
    # started, so Piastri and Hulkenberg re-entered the field through the fill
    # even after the seed excluded them. They then sat in the running order
    # while no tower row existed to draw them — the order had 22 entries, the
    # tower had 20, and the rendered ranks came out 1,2,3,4,6,7,8,9,11,...
    # with holes exactly where the two ghosts were.
    #
    # The official archive is the definition of who is in the race, which is the
    # same principle the rest of this module runs on.
    for number in (set(timing) | set(positions)) & set(boundary):
        driver_timing = sorted(timing.get(number, []), key=lambda sample: sample[0])
        driver_positions = _collapse_positions(positions.get(number, []))
        # Present-with-one-feed is a real and useful state (the design's
        # "timing only" degradation row), so a driver is kept as long as at
        # least one array has something in it — but the empty one is still
        # emitted as an empty list so the two keys always exist.
        if not driver_timing and not driver_positions:
            continue
        entry: dict = {"timing": driver_timing, "positions": driver_positions}
        if number in out_ms:
            entry["out_ms"] = out_ms[number]
        drivers[number] = entry

    return {"drivers": drivers, "lap_ms": lap_ms}


def _collapse_positions(samples: list[list[int]], _unused=None) -> list[list[int]]:
    """Sort by time and drop samples that restate the position already showing.

    Two things are resolved here, both of which matter for correctness rather
    than only for size.

    **Ties go to the official sample.** An OpenF1 event landing on the exact
    millisecond of a line crossing would otherwise make the array's order
    ambiguous, and the frontend's "last sample at or before now" lookup would
    pick whichever happened to sort last. Sorting by `(time, is_openf1)` puts
    the official value second, so it wins — which is the correction-at-every-
    crossing rule the module's docstring describes, expressed in the sort.

    **A repeated position is not a change.** OpenF1 restates a driver's position
    on its own cadence whether or not it moved, and those runs are roughly two
    thirds of the raw feed. Emitting them costs payload and makes the frontend's
    change-detection fire on non-events.
    """
    # Provenance is recoverable without threading a flag through: an official
    # boundary sample and an OpenF1 sample never need to be told apart *except*
    # when they share a timestamp, and there the official one is the one to keep.
    # Sorting is stable, so ordering by time alone preserves insertion order,
    # and official samples are inserted first.
    ordered = sorted(samples, key=lambda sample: sample[0])

    collapsed: list[list[int]] = []
    for sample in ordered:
        if collapsed and collapsed[-1][0] == sample[0]:
            # Same instant: the first one inserted wins, which is the official
            # boundary sample wherever one exists.
            continue
        if collapsed and collapsed[-1][1] == sample[1]:
            continue
        collapsed.append(sample)
    return collapsed


def fetch_openf1_feeds(race_date: str) -> tuple[list, list, list]:
    """`(/laps, /intervals, /position)` for the race on `race_date`.

    Returns three empty lists for every failure mode — no session for that date,
    a feed that 404s or times out, a season before OpenF1's 2023 coverage
    starts. The caller still has the official skeleton in that case and serves a
    lap-boundary-accurate tower without intra-lap fill.

    `/laps` is fetched even though this module serves no per-lap data: it is the
    only source of wall-clock line crossings, which is what `race_start_offset`
    measures the start against. Without it the other two feeds cannot be placed
    on the timeline at all.
    """
    from .race_stints import fetch_openf1_session_key

    try:
        session_key = fetch_openf1_session_key(race_date)
    except Exception as error:
        print(f"race_timing: OpenF1 session lookup failed for {race_date}: {error}")
        return [], [], []
    if session_key is None:
        return [], [], []

    def rows(value):
        return value if isinstance(value, list) else []

    lap_rows = rows(_fetch_json(f"{OPENF1_BASE}/laps", {"session_key": session_key}))
    if not lap_rows:
        return [], [], []

    # The intervals feed is ~22,000 rows for one race, comfortably past the
    # default timeout on a slow link, so it gets a longer one of its own.
    interval_rows = rows(
        _fetch_json(f"{OPENF1_BASE}/intervals", {"session_key": session_key}, timeout=60.0)
    )
    position_rows = rows(
        _fetch_json(f"{OPENF1_BASE}/position", {"session_key": session_key})
    )
    return lap_rows, interval_rows, position_rows


def grid_from_race_results(results: list[dict]) -> dict[str, int]:
    """`{car number: grid slot}` from a round's `race_results`.

    The official starting order, which is the only trustworthy source of it —
    see the note in `build_timing` for the two feed-derived reconstructions that
    were tried and measured wrong first.

    A `grid` of 0 is a pit-lane start, not pole. It is skipped rather than
    mapped to a slot: inventing a back-of-grid number would state a position the
    car never occupied, and such a driver simply has no t=0 sample, which the
    frontend already handles by falling back to lap-boundary order for them.
    """
    grid: dict[str, int] = {}
    for row in results or []:
        driver = row.get("Driver") or {}
        number = row.get("number") or driver.get("permanentNumber")
        slot = _as_int(row.get("grid"))
        if number is None or slot is None or slot <= 0:
            continue
        grid[str(number)] = slot
    return grid


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
    """Per-second timing and position samples for a race, Mongo-first with a rebuild.

    A round with no per-second track is not an error — `synced: false` with an
    empty `drivers` map is the honest answer, and the frontend degrades to the
    existing lap-stepped tower on it.

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
            "lap_ms": cached.get("lap_ms") or [],
            "synced": True,
        })

    payload: dict = {}
    try:
        official_rows = await official_laps_for(year, round_number)
        if official_rows:
            results_doc = await db.race_results.find_one(
                {"season": year, "round": str(round_number)}, {"_id": 0, "results": 1}
            )
            results = (results_doc or {}).get("results") or []
            numbers = driver_numbers_from_results(results)
            grid = grid_from_race_results(results)

            race_date = await _race_date(db, year, round_number)
            lap_rows, interval_rows, position_rows = [], [], []
            if race_date:
                # Blocking httpx over ~25,000 rows; running it inline would
                # stall the event loop for the length of three sequential HTTP
                # fetches and block every other request served by this process.
                lap_rows, interval_rows, position_rows = await asyncio.to_thread(
                    fetch_openf1_feeds, race_date
                )

            payload = build_timing(
                official_rows, numbers, lap_rows, interval_rows, position_rows, grid
            )
    except Exception as error:
        print(f"race_timing: rebuild failed for {year} R{round_number}: {error}")
        payload = {}

    drivers = payload.get("drivers") or {}
    if not drivers:
        return JSONResponse(content={
            "year": year,
            "round": round_number,
            "drivers": {},
            "lap_ms": [],
            "synced": False,
        })

    lap_ms = payload.get("lap_ms") or []
    try:
        await db.race_timing.update_one(
            cache_key,
            {"$set": {**cache_key, "drivers": drivers, "lap_ms": lap_ms}},
            upsert=True,
        )
    except Exception as error:
        print(f"Failed to cache race_timing for {year} R{round_number}: {error}")

    return JSONResponse(content={
        "year": year,
        "round": round_number,
        "drivers": drivers,
        "lap_ms": lap_ms,
        "synced": True,
    })
