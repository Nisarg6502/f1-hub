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

* **Lap boundaries are exact — position, gap and interval alike.** Each driver
  gets a position sample *and* a timing sample at their own official crossing
  time for every lap. Those samples cannot drift, because they are not derived
  from anything — they are the classification. The archive states every
  driver's cumulative elapsed time at every lap, so the gap to the leader is
  that number minus the lap leader's, and the interval is the difference to the
  adjacent car in the same lap's crossing order. Both are arithmetic on the
  official record, and neither passes through OpenF1.
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
data. Measured on round 1: 4,471 of the 22,070 non-null `gap_to_leader`
readings OpenF1 serves.
Coercing them to numbers, or dropping rows that carry them, would silently
delete the entire back half of the field's gap readout for most of a race.
OpenF1's are passed through verbatim, and the official samples *produce* them
too — see `official_timing_samples` for why a lapped car's exact numeric gap is
deliberately not served.

Cached in `race_timing` for the same reason `race_replay` caches: a finished
race's timing is immutable, and the payload is ~490 KB raw, which is far too
much to rebuild from four fetches on every view. `TIMING_VERSION` is part of
the cache key so a change to the payload shape retires existing documents
instead of serving them to a frontend expecting the new one.
"""

import asyncio
import bisect
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
#
# 6 retires round 1's 84-second timeline shift (see `race_start_offset`). A v5
# round-1 document is structurally perfect and states the wrong thing on every
# row: no interval or gap reading exists for the opening lap, and every reading
# after it belongs to a lap later than the position beside it. The other ten
# rounds rebuild to a byte-identical payload, so the cost of the bump is one
# round's worth of refetching.
#
# 7 retires every payload whose gap and interval columns came from OpenF1 alone.
# The shape is byte-for-byte the same — three-element timing samples, same
# union of types — so nothing about a v6 document *looks* stale, which is again
# the harder half of this constant's rule. What changed is that the columns are
# now stamped from the official record at every crossing instead of being an
# OpenF1 sample carried forward. On round 1 a v6 document shows Alonso's gap
# frozen at `+63.90` for the seventeen minutes he spent in the garage on lap 13,
# where the archive states `+1030.86`; that document would otherwise be served
# forever, because its structure is perfect.
TIMING_VERSION = 7

# How far an individual lap's implied lights-out instant may sit from the
# median before it is discarded as a bad boundary. Measured across rounds 3 and
# 6, the true spread is 0.2s peak-to-peak over a full race; round 1 has a
# handful of laps 30s out, which is OpenF1's missing rows rather than any real
# drift. 5s is comfortably outside the noise and comfortably inside the fault.
OFFSET_TOLERANCE_SECONDS = 5.0

# How far the estimates may sit from OpenF1's *stated* start before they are
# judged to be describing a different lap. See `stated_race_start`.
#
# The two failure scales are far apart and nothing lives between them: a healthy
# round's estimates land 0.42-0.77s after the stated instant (measured on all
# eleven synced 2026 rounds), and a whole-lap misalignment is at least the
# shortest lap on the calendar — ~64s at the Red Bull Ring, and 73s on the
# fastest 2026 round actually synced. 30s is ~40x the observed residual and
# under half the smallest possible fault.
LAP_ALIGNMENT_TOLERANCE_SECONDS = 30.0


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

    It is no longer only a passthrough for OpenF1's strings: `official_timing_samples`
    hands this the same `"+N LAP(S)"` form for a car the archive says is laps
    down, deliberately and for the reasons set out there. Both sources therefore
    arrive in the same branch, which is the point — the column must not change
    convention depending on which source last spoke.
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


def _laps_down_label(laps_down: int) -> str:
    """`1 -> "+1 LAP"`, `11 -> "+11 LAPS"`. OpenF1's exact spelling.

    Not a formatting preference: these strings land in the same column as
    OpenF1's own, and the two must be indistinguishable or the readout changes
    wording every time the source alternates. All 59,242 string readings OpenF1
    served across the eleven synced 2026 rounds match `+N LAP` / `+N LAPS`
    exactly, with no other form and no other casing.
    """
    return f"+{laps_down} LAP" if laps_down == 1 else f"+{laps_down} LAPS"


def official_timing_samples(
    official_rows: list[dict],
    driver_numbers: dict[str, str],
    leader_cumulative: dict[int, int],
) -> dict[str, list[list]]:
    """The exact gap and interval at every line crossing.

    `{car number: [[elapsed_ms, interval, gap_to_leader], ...]}` — the timing
    counterpart of `official_samples`, stamped at the same instants and for the
    same reason. Positions have been exact at every crossing since CP80; these
    two columns came from OpenF1 alone until now and were never corrected
    against anything, which is the asymmetry this closes.

    The arithmetic is the archive's and nothing else's:

    * **gap to leader** = this driver's cumulative elapsed time at lap `k` minus
      the *lap leader's* cumulative at lap `k`.
    * **interval** = the difference to the adjacent car when lap `k`'s crossings
      are sorted by cumulative time. Sorted rather than read off the archive's
      stated `position` so the number and the ordering can never disagree;
      `verify_race_timing`'s `archive` check scores those two against each other
      at 100% across the season, so the choice is free.
    * The leader of a lap reads `0.0` on both, which is what OpenF1 emits for
      that car too (66 of 66 leader readings on round 1). The tower renders the
      leading row as `LEADER` regardless and `isClosing` skips it, so the value
      is never seen — but emitting `None` would blank a column that OpenF1 had
      just filled, and that *would* be seen.

    **A car a lap or more down is served `"+1 LAP"`, not its numeric gap, and
    this is the one genuinely contestable decision here.** The numeric value is
    real — Alonso's archive gap at his lap-13 crossing on round 1 is `+1030.86`,
    a true measurement of how much longer he took to complete thirteen laps —
    but three things decide against serving it:

    1. **It is not what the column means.** `+1030.86` reads as "the leader is
       seventeen minutes up the road". The leader is in fact a few hundred
       metres up the road, eleven laps ahead. The broadcast convention exists
       because the numeric answer actively misinforms once cars are on different
       laps.
    2. **The fill either side of it uses the other convention.** OpenF1 reports
       `"+N LAPS"` for exactly these cars — 4,471 of the 22,070 non-null
       `gap_to_leader` readings it served for round 1. A sample stating `+1030.86` between
       two OpenF1 samples stating `"+11 LAPS"` would make the column alternate
       between two conventions several times a lap, and correction-at-every-
       crossing would render as a flicker rather than a correction.
    3. **The frontend refuses to interpolate toward a string** (`blend` in
       `watch-timing.ts`), carrying the last reading forward instead. That is
       the right behaviour and it only holds if both sources agree on when a
       reading is a string. A numeric official sample followed by an OpenF1
       string would blend from a real number toward nothing and freeze on a
       number the viewer cannot interpret.

    **`interval` is served numerically in every case, including for lapped
    cars**, and that is not an inconsistency with the above. The two rows being
    compared completed the *same* lap, so the difference is a like-for-like
    reading at the same point on track, and it is the number that answers the
    column's question — how much the car ahead is worth. It is also OpenF1's own
    convention: 21,978 of the 21,984 non-null `interval` readings it served for
    round 1 are floats, including `912.59` for a car eleven laps down. Six are
    strings. Serving `"+1 LAP"` here would introduce the alternation that
    argument 2 above exists to avoid, in the column that does not need it.

    Cost, measured on the eleven synced 2026 rounds: 5,888 KB of raw payload
    becomes 6,152 KB, +4.5%. Round 1 gains exactly 1,003 timing samples, which
    is exactly its number of official crossings — no OpenF1 sample was displaced
    by a tie on that round.

    **How many laps down is measured against the lead lap, not guessed from the
    gap.** `laps_down` is the number of laps the leader had completed by the
    instant this driver crossed, minus the number this driver had. Dividing the
    gap by a nominal lap time was the obvious alternative and is wrong under a
    safety car, where a 90s gap is not a lap. Cross-checked against OpenF1's own
    strings over all eleven rounds: 2,794 of 2,809 readings agree on N, 14 of
    the 15 disagreements are off by one, and every one inspected is an OpenF1
    sample gone stale — the same defect this function exists to correct. Two
    sources that share no inputs agreeing to 99.5% is the evidence for the rule.

    Both counts are taken as *positions in the archive's own lap list* rather
    than as lap numbers, so a lap the archive omits for the whole field cannot
    silently shift a driver a lap down.
    """
    lap_numbers = sorted(leader_cumulative)
    lead_times = [leader_cumulative[lap] for lap in lap_numbers]
    samples: dict[str, list[list]] = {}

    for row in official_rows or []:
        lap = _as_int(row.get("lap"))
        leader = leader_cumulative.get(lap) if lap is not None else None
        if leader is None:
            continue

        # Drivers with no car number are dropped *before* the interval is
        # measured, so the interval is to the car ahead **that the payload
        # actually serves** — which is the row above in the tower, and therefore
        # the row the number is describing. `verify_race_timing` computes the
        # same quantity over every crossing in the archive, mapped or not, and
        # the two score 100% across the season; that agreement is what says no
        # 2026 driver is unmapped, rather than an assumption that none is.
        crossings: list[tuple[int, str]] = []
        for timing in row.get("timings") or []:
            number = driver_numbers.get(str(timing.get("driverId")))
            elapsed = _as_int(timing.get("cumulative_ms"))
            if number is None or elapsed is None:
                continue
            crossings.append((elapsed, number))
        crossings.sort(key=lambda crossing: crossing[0])

        # How many laps this driver has completed, counted the same way the
        # leader's are, so the subtraction below compares like with like.
        completed = bisect.bisect_right(lap_numbers, lap)

        previous: int | None = None
        for elapsed, number in crossings:
            interval = 0.0 if previous is None else (elapsed - previous) / 1000
            previous = elapsed
            laps_down = bisect.bisect_right(lead_times, elapsed) - completed
            gap = (
                _laps_down_label(laps_down)
                if laps_down >= 1
                else (elapsed - leader) / 1000
            )
            samples.setdefault(number, []).append(
                [elapsed, _round_value(interval), _round_value(gap)]
            )

    return samples


def stated_race_start(lap_rows: list[dict]) -> datetime.datetime | None:
    """Lights out as OpenF1 states it: the earliest lap-1 `date_start`.

    Every driver's lap-1 row carries the *same* timestamp, because it is the
    start signal rather than a per-car measurement. That claim is no longer
    inferred — on all eleven synced 2026 rounds this instant equals race
    control's `SESSION STARTED` message **to the millisecond**, and on each one
    `CHEQUERED FLAG` minus the official winner's race duration corroborates it
    to within 1.7s. Two OpenF1 endpoints and the Jolpica archive, agreeing.

    `min` rather than an equality check because round 6 emits two distinct
    values; the earlier is the start signal and the later a straggler's row.

    **This module twice reached the opposite conclusion, so the correction is
    worth stating.** The instant was first discarded because lap 1 carries
    `is_pit_out_lap: true` with a null `lap_duration` and sits 182.5s before the
    following crossing on round 1, against a 91.9s official lap — it read as a
    formation lap. It is not. Round 1 is a round where OpenF1's `/laps` has no
    boundary at the end of racing lap 1 at all, so its lap-1 row spans two
    official laps; the timestamp on it was right the whole time and the row's
    *duration* was the broken part. It was then discarded a second time on a
    measurement that scored it ~90s early — against a reference computed by
    `race_start_offset` below, which is itself 84s late on exactly that round.
    Comparing two derived numbers cannot say which one is wrong.
    """
    starts = [
        _parse_iso(row.get("date_start"))
        for row in lap_rows or []
        if _as_int(row.get("lap_number")) == 1
    ]
    starts = [start for start in starts if start is not None]
    return min(starts) if starts else None


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
    this robust against a scattered bad boundary: a lap whose estimate is 30s
    out is simply outvoted by the 44 that agree.

    **A median cannot survive a systematic fault, though, and round 1 has one.**
    OpenF1's `/laps` there has no crossing at the end of racing lap 1, so its
    lap-1 row spans two official laps and every subsequent lap N is the official
    lap N+1. Each estimate is then one lap duration too large — *and they all
    agree with each other*, so the median endorses a start 84s late and the
    tolerance filter above sees a textbook-tight cluster. Measured against race
    control, the served payload was 84s out for the whole race: every sample
    from the opening lap fell below t=0 and was dropped, and everything after it
    read the state of a lap later. This is the module's own warning about a feed
    agreeing with itself, reappearing one level up — the estimates are
    independent of each *other* but not of OpenF1's lap numbering.

    So `stated_race_start` supplies a coarse anchor and the estimates supply the
    precision. An estimate more than `LAP_ALIGNMENT_TOLERANCE_SECONDS` from the
    stated instant is describing a different lap and is dropped before the
    median is taken.

    **The anchor deliberately does not win outright**, even though it is exact.
    OpenF1 stamps its boundaries 0.42-0.77s after the official crossing on every
    healthy round, and it is OpenF1's own samples being placed on this timeline,
    so the estimates absorb that bias and the stated instant does not. Keeping
    both is worth the extra step: across rounds 2-11 this returns a value
    identical to the pre-fix one to the microsecond, and moves round 1 by
    -83.991s.

    Returns None when the two sources share no usable lap and OpenF1 states no
    start, which leaves the round with no way to place OpenF1's samples and
    degrades it to the official skeleton alone.
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

    stated = stated_race_start(lap_rows)
    if stated is not None:
        aligned = [
            estimate
            for estimate in estimates
            if abs(estimate - stated.timestamp()) <= LAP_ALIGNMENT_TOLERANCE_SECONDS
        ]
        # None survived: the lap numbering is systematically misaligned, which is
        # round 1's fault exactly — 0 of its 57 estimates land within a lap of
        # the stated start. The stated instant is then the only reading left
        # that is not built on the misalignment.
        if not aligned:
            return stated
        estimates = aligned

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
    the official skeletons (positions *and* timing), the measured start, the
    drop-don't-clamp rule, string and null gap passthrough, ordering, arity — is
    reachable from here with plain dicts, which is why the endpoint below is
    kept to nothing but fetching and caching.

    **A round with no usable OpenF1 feed still gets both columns.** The official
    timing skeleton does not depend on `race_start`, so a round that degrades to
    the lap-stepped fill now carries exact gaps and intervals at its crossings
    where it previously carried an empty `timing` array.

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

    # Both skeletons are seeded before the OpenF1 fill, and that ordering is
    # load-bearing rather than tidy: `_collapse_positions` and `_collapse_timing`
    # both resolve a timestamp tie in favour of whichever sample was inserted
    # first, so inserting the official ones here is what makes them win over an
    # OpenF1 event that happens to land on the exact millisecond of a crossing.
    timing: dict[str, list] = {
        number: list(samples)
        for number, samples in official_timing_samples(
            official_rows, driver_numbers, leader_cumulative
        ).items()
    }
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
        driver_timing = _collapse_timing(timing.get(number, []))
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


def _collapse_timing(samples: list[list]) -> list[list]:
    """Sort timing samples by time and let the official one win a tie.

    The same rule as `_collapse_positions`, and deliberately the same mechanism
    rather than a second one: sorting is stable, official samples are inserted
    first in `build_timing`, so ordering by time alone leaves the official
    sample ahead of any OpenF1 sample sharing its millisecond, and the first at
    each instant is kept. Without this the array carried both, and the
    frontend's "last sample at or before now" lookup would take whichever sorted
    last — which is OpenF1's, i.e. exactly the reading the crossing exists to
    correct.

    **`_collapse_positions`' second rule is not repeated here.** A repeated
    position is a non-event and is dropped; a repeated gap is not, because these
    values are continuous and the frontend interpolates *between adjacent
    samples*. Dropping a sample that restates the current reading would widen
    the bracket `blend` interpolates across and invent motion where the feed
    reported none.
    """
    ordered = sorted(samples, key=lambda sample: sample[0])

    collapsed: list[list] = []
    for sample in ordered:
        if collapsed and collapsed[-1][0] == sample[0]:
            continue
        collapsed.append(sample)
    return collapsed


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
