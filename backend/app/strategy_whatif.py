"""EXPERIMENTAL — NOT ROUTED, AND IT FAILS ITS OWN ACCEPTANCE GATE.

Read "How well it works" below before trusting anything here. This module is
committed so the design is not lost and the defect is not rediscovered, not
because it is ready. It is deliberately absent from `main.py`.

Strategy "what-if": move one real pit stop to a different lap and estimate
where that driver would have come out, and how the finishing order changes.

**Everything this module produces is modelled, and none of it is a
measurement.** That distinction is the reason this file is as long as it is.
`race_timing.py`'s docstring states the house rule — *"Nothing here is
interpolated. Every number served is a real measurement someone reported at a
real instant"* — and CP76 recorded why a frozen lap duration was refused: it
would be "a fabricated measurement indistinguishable from a real one, handed
straight to a clock." A counterfactual cannot obey that rule; it is by
construction a number nobody measured. So it obeys the next-best one instead:

1. **Nothing here is served in the same shape as measured data.** The payload
   has no `position`, `gap_seconds` or `lap_time_seconds` field. Every derived
   quantity is named `estimated_*` and every positional answer is a *window*
   (`position_window`), never a bare integer that could be mistaken for the
   classification. The one exact integer in the estimate block,
   `real_finish_position`, is labelled as the thing that actually happened.
2. **Every parameter is measured from that race's own laps**, not chosen. The
   degradation slope, the compound offsets, the fuel-burn slope and the
   pit-lane cost are all fitted here from `race_laps.lap_time_seconds` and
   `pit_stops`, per round. The four numbers this file does choose are the
   caution-lap ratio, the outlier cut, the minimum support for a per-compound
   slope, and the band multiplier; each is justified against a measurement in
   the comment that defines it.
3. **Where the data does not support a claim, the claim is dropped**, not
   softened. See `_REFUSALS` — a stop moved into a safety-car window, onto a
   lap the driver never ran, or past their retirement returns `estimate: null`
   with a reason. Traffic on rejoin is refused outright (see below).

## The model

For an affected lap the counterfactual lap time is never predicted in absolute
terms. Only the *difference* from what really happened is modelled:

    delta(lap) = [base(c_cf)  + deg(c_cf)  * age_cf(lap)]
               - [base(c_real)+ deg(c_real)* age_real(lap)]

Driver skill, car pace, fuel load, track evolution, wind and traffic all cancel,
because it is the same driver on the same lap number of the same race. That is
what makes a three-parameter model usable at all. The pit-lane cost is then
removed from where the stop really happened and re-applied where it now happens
— with the *fitted* cost, not the stop's own measured one, because a stop on a
different lap is a hypothetical stop whose real cost nobody recorded.

Parameters, all fitted per round by `fit_pace_model` on green-flag laps only:

* `fuel_seconds_per_lap` — one global slope on lap number. It must be in the fit
  even though it cancels in `delta` (the lap number is unchanged by moving a
  stop): leaving it out loads the fuel effect onto the tyre-age slope, which
  does not cancel. Measured -0.005 to -0.068 s/lap across the eleven synced
  2026 rounds.
* `compound_offset` and `degradation_seconds_per_lap` per compound. A compound
  gets its own slope only with >= 40 green laps spanning >= 8 laps of tyre age;
  otherwise it shares the reference compound's slope. Both thresholds exist
  because the unrestricted fit produced -0.757 s/lap for a compound one driver
  ran for a handful of laps on 2026 R9 — a number with a plausible shape and no
  support underneath it.
* `pit_cost` — the in-lap and out-lap excess over the fitted green pace, median
  over every green-flag stop in the race. Measured 19.4 to 33.2 s total across
  the 2026 rounds. **The in/out split is measured per race and varies wildly**
  (R7: 3.7 in / 20.5 out; R1: 21.6 in / 6.4 out) because circuits differ in
  whether pit entry falls before or after the timing line, so the split is never
  assumed.

Driver intercepts are removed by within-driver demeaning rather than by fitting
twenty dummies — the fixed-effects transform, which is exact and keeps the
design matrix at seven columns instead of twenty-seven.

## What this refuses to claim

**Traffic on rejoin is not modelled, at all.** Nothing in this app caches track
position (`race_replay.py` says so outright), and whether a rejoining car is
held up depends on DRS, corner layout, the tyre delta to the car ahead and
whether that car's team reacts — none of which is in any cached collection. A
"loses N s/lap while within M s of the car ahead" term would be two invented
constants wearing a measurement's clothes, which is the exact defect class this
project keeps correcting. Instead the payload reports the *measured* gap to the
car the driver would rejoin behind, computed by arithmetic on the official
cumulative times, and states the consequence: being held up can only cost time,
so a clean-air estimate is an upper bound on the outcome, never a lower one.

**Nobody else reacts.** Every other car is assumed to run exactly the race it
ran. A team watching a rival stop eight laps early would very often cover it,
and the model has no way to say so.

**Lap count is assumed unchanged.** A large enough time swing could change
whether a driver is lapped; the model does not attempt that.

## How well it works

**It does not, yet. It fails the no-op gate this section used to claim it
passed.**

The gate: take a real stop, "move" it to the lap it already happened on, and
check the model reproduces that driver's real result. If it cannot reproduce
reality when asked to change nothing, nothing else it says is trustworthy.

Measured 2026-08-21 over 567 (race, driver, stop) no-op queries across 2026
R1-R11 and 2025 R1/R22/R24. 281 produced an estimate; the rest refused.

| population | n | exact | within 1 | inside reported window |
| --- | --- | --- | --- | --- |
| all answered | 281 | 59.4% | 73.7% | 77.9% |
| **clean finishers only** | 133 | **51.1%** | 68.4% | 79.7% |

Restricting to drivers who actually finished makes it *worse*, so this is not
a retirement artefact. Named cases, all asked to change nothing:

* 2026 R9 British, **Leclerc, the race winner**: real P1, model says **P13**.
* 2026 R9 British, Bottas: real P16, model says **P1**, window [1, 1].
* 2026 R6 Monaco, Alonso: real P10, model says **P1**, 47.9 s faster.
* 2025 R24 Abu Dhabi, a race with **zero caution laps**: 8 of 27 stops fall
  outside their own reported window.

**The defect is the fitted-for-measured pit-cost substitution**, at the
`shift` block in `estimate_stop_move`. When `new_lap == original_lap` the pace
terms cancel exactly and the whole delta collapses to
`fitted_total - measured_total_for_this_stop`. Bortoleto's Monaco stop
measured 75.8 s against a 22.2 s fitted median, so the no-op "gains" him
53.6 s and wins him the race.

The paragraph this section used to carry — *"a no-op that reused the stop's
own measured cost would be exact by construction and would prove nothing"* —
is half right and fatal in the other half. Substituting the fitted cost is
correct for a stop that genuinely moves. But `measured - fitted` is not
pit-lane noise; it is a real event (a triple-stack, an unsafe release, a
yellow on the in-lap). The model erases that event and hands the erasure back
as a strategic gain, with no signal that it did so.

Three further defects found by the same run:

* **The reported window is not a coverage band.** `spread_seconds` scales a
  MAD by 1.4826, which is a valid sigma only for a Gaussian; the pit-cost
  residual distribution is not remotely Gaussian. 47% of windows are
  zero-width — a bare point claim wearing an interval's clothes.
* **Caution detection under-detects, and the union of two detectors that miss
  the same window is still a miss.** Monaco's L59 field-median ratio is 1.113,
  under `_CAUTION_RATIO`; Silverstone emits `safety_car_deployed` and
  `safety_car_ending` on the same lap, so `caution_laps_from_race_control`
  marks one lap and the L41-L46 stops pass as green.
* **`finish` is not a finish.** It ranks the driver at *their own* last lap, so
  for anyone lapped, retired or disqualified it reports their running position
  when they stopped. It disagrees with the classified position on 28.3% of
  driver-races. The 12,700/12,700 ordering result below is about per-lap
  stated position and does not transfer to final classification.
* **`_driver_plan` requires `len(stints) == len(stops) + 1` exactly**, which
  any red-flag stint split breaks. That is the whole `stint_join_mismatch`
  refusal bucket, including all 82 stops of 2025 R1.

Coverage is also poor: only half of queries get an answer at all.

What survives, and is worth keeping: **the differencing formulation** above is
the hard idea and it is right — expressing the counterfactual as a difference
on the same driver, same lap, same race so skill, car, fuel and track
evolution cancel. The per-race fitted pace model, the within-driver demeaning,
the compound-support thresholds and the refusal taxonomy are all sound.

Making it honest is estimated at 3-5 days: refuse stops whose measured cost is
an outlier against the fitted distribution, calibrate the band empirically
instead of assuming Gaussianity, rank the finish at the race's final lap and
refuse for retired drivers, loosen `_driver_plan` for red-flag splits, and
write the gate in as a regression test. The end state refuses roughly
two-thirds of what a user would click on — defensible, but a much smaller
product than this docstring originally implied.

One check that DID hold, and is not in doubt:

* **The ordering rule is exact.** Deriving each driver's position from
  `official_laps` cumulative times — rank by laps completed, then elapsed time
  — reproduces the archive's own stated `position` on **12,700 of 12,700**
  crossings across the eleven synced 2026 rounds. Converting a counterfactual
  elapsed time into a position adds no error of its own. Note this is about
  per-lap position, not final classification; see the `finish` defect above.

Two smaller measurements this module depends on, recorded so they are not
re-derived on plausibility:

* `race_stints` stint boundaries and `pit_stops` stop laps agree **435/435**
  across the eleven rounds (`lap_start == stop_lap + 1`, no count mismatches).
  `_driver_plan` asserts that rather than assuming it, and refuses when it fails.
* The field-median caution detector and OpenF1 race control agree on **93.8%**
  of 662 laps. They are kept as a **union**, not a substitute for each other:
  race control names 33 laps the pace detector misses (a VSC or the lap a safety
  car peels in can run at near-green pace), and the pace detector flags 8 laps
  race control does not. A stop must be clear of both. As measured above, the
  union is still not sufficient.

Read-only against what is already cached, with the same posture as
`strategy_commentary`: no FastF1, no Ergast, no self-heal. A round whose
collections are not populated reports `synced: false` rather than triggering a
sync.
"""

import math
import statistics
from collections import defaultdict

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db
from .driver_directory import _driver_directory, _number_by_driver_id

router = APIRouter(prefix="/api")

# Part of the served payload rather than a cache key — nothing here is cached,
# because a what-if is parameterised by the caller's chosen lap and the space of
# queries is the whole race. Bumped when the model changes, so a client can tell
# two estimates apart.
MODEL_VERSION = 1

# A lap counts as run under caution when the field's median lap time is more
# than this multiple of the race's green-flag baseline. Measured over the eleven
# synced 2026 rounds: green-flag laps have a median ratio of 1.005 and a 99th
# percentile of 1.168, while laps race control marks safety-car or red-flag have
# a median of 1.135. The two distributions overlap, which is why this detector is
# unioned with race control rather than trusted alone — but at 1.15 it flags only
# 8 of 600 green laps, so it costs almost nothing to keep.
_CAUTION_RATIO = 1.15

# The green-flag baseline itself is the median of the fastest 60% of laps. The
# race's overall median is not usable: a race with a long safety-car period drags
# it up and then nothing looks slow. 60% is chosen to survive a caution covering
# up to two-fifths of the race, which is more than any of the eleven rounds had.
_GREEN_QUANTILE = 0.6

# Laps whose residual exceeds this many fitted sigma are dropped and the model
# refitted once. Lock-ups, being stuck behind a lapped car and off-track moments
# all produce laps that are real measurements of something other than tyre pace.
_OUTLIER_SIGMA = 3.0

# A compound earns its own degradation slope only with this much support.
# Without them the fit produced -0.757 s/lap for a compound with a handful of
# laps on 2026 R9 — see the module docstring.
_MIN_COMPOUND_LAPS = 40
_MIN_AGE_SPAN = 8

# Fewest green-flag stops a race needs before its pit cost is treated as
# measured. Below this the median is one or two stops and its spread means
# nothing; the endpoint refuses rather than reporting a window it cannot size.
_MIN_GREEN_STOPS = 4

# Half-width of the reported window, in fitted sigma. Calibrated, not chosen for
# its symmetry: at 2 sigma the window contained the true rejoin position in
# 96.9% of 259 real stops (see the docstring). At 1 sigma it contained 84.9%.
_BAND_SIGMA = 2.0

# MAD -> sigma for a normal distribution. The median absolute deviation is used
# instead of the standard deviation because a single red-flag or unsafe-release
# stop otherwise sets the width of every window in the race.
_MAD_TO_SIGMA = 1.4826

# Refusal codes. Kept as a module constant so the frontend can branch on a
# stable string and the test suite can assert on one, rather than on prose.
_REFUSALS = {
    "no_data": "This round has not been processed yet.",
    "unknown_driver": "That driver did not take part in this race.",
    "unknown_stop": "That driver did not make that pit stop.",
    "lap_not_run": "The driver never ran that lap.",
    "same_lap_as_neighbour": "Moving the stop there would reorder this driver's own stops.",
    "past_stint_end": "That lap is at or beyond the end of the stint this stop starts.",
    "caution_at_new_lap": "A stop under a safety car costs a different amount of time, and this race provides no green-flag measurement of it.",
    "caution_at_original_lap": "The original stop happened under a safety car, so what it really cost cannot be measured against green-flag pace.",
    "pit_cost_unmeasurable": "This race has too few green-flag pit stops to measure what a stop costs.",
    "original_stop_unmeasurable": "What this particular stop cost cannot be measured from the surrounding laps, so there is nothing to move.",
    "pace_unmeasurable": "This race has too few usable green-flag laps to fit a tyre-pace model.",
    "stint_join_mismatch": "This driver's stint boundaries and pit-stop laps disagree, so the stop cannot be located in a stint.",
    "beyond_observed_stint": "The move needs a stint longer than anyone ran on that compound in this race, so there is no measured pace to extrapolate from.",
}

# How far past the longest observed stint on a compound the model will
# extrapolate before refusing. Ten laps is roughly a sixth of a race distance;
# past that the degradation slope is being asked to describe a tyre state nobody
# in the race ever reached. Inside it, the window is widened rather than closed
# — see `_extrapolation_sigma`.
_MAX_EXTRAPOLATION_LAPS = 10


# --------------------------------------------------------------------------
# Small numeric helpers. Deliberately dependency-free: this module is pure
# arithmetic over plain dicts, matching `race_control_facts.py`, so it can be
# exercised directly by the test suite without pandas, numpy or a database.
# --------------------------------------------------------------------------


def _as_int(value) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return None if number != number else number


def _solve(matrix: list[list[float]], rhs: list[float]) -> list[float] | None:
    """Gauss-Jordan with partial pivoting. None when the system is singular.

    A singular normal-equation matrix is not an edge case here, it is a
    design error caught at runtime: it means two model columns are collinear
    (a compound dummy for every compound alongside a pooled age column, for
    instance). Returning None makes the caller refuse instead of serving
    coefficients solved from a near-zero pivot.
    """
    size = len(rhs)
    work = [row[:] + [rhs[i]] for i, row in enumerate(matrix)]
    for col in range(size):
        pivot = max(range(col, size), key=lambda r: abs(work[r][col]))
        if abs(work[pivot][col]) < 1e-10:
            return None
        work[col], work[pivot] = work[pivot], work[col]
        for row in range(size):
            if row == col:
                continue
            factor = work[row][col] / work[col][col]
            if factor:
                for k in range(col, size + 1):
                    work[row][k] -= factor * work[col][k]
    return [work[i][size] / work[i][i] for i in range(size)]


def _ols(rows: list[tuple[list[float], float]], columns: int):
    """Least squares on `rows`, returning `(beta, sigma, standard_errors)`.

    Standard errors matter as much as the coefficients here: the reported
    window's width is driven by the uncertainty on the degradation slope, so a
    slope fitted from thin data has to produce a wide window rather than a
    confident wrong one. They come from the diagonal of `(X'X)^-1`, recovered by
    solving against unit vectors — cheap at seven columns and it avoids a numpy
    dependency this backend does not otherwise need in a pure-arithmetic module.
    """
    xtx = [[0.0] * columns for _ in range(columns)]
    xty = [0.0] * columns
    for xs, y in rows:
        for i in range(columns):
            if xs[i]:
                xty[i] += xs[i] * y
                for j in range(columns):
                    if xs[j]:
                        xtx[i][j] += xs[i] * xs[j]

    beta = _solve(xtx, xty)
    if beta is None:
        return None, None, None

    residuals = [y - sum(b * x for b, x in zip(beta, xs)) for xs, y in rows]
    dof = len(rows) - columns
    if dof <= 0:
        return None, None, None
    sigma = math.sqrt(sum(r * r for r in residuals) / dof)

    errors: list[float] = []
    for j in range(columns):
        unit = [1.0 if i == j else 0.0 for i in range(columns)]
        column = _solve(xtx, unit)
        if column is None or column[j] < 0:
            return None, None, None
        errors.append(sigma * math.sqrt(column[j]))

    return beta, sigma, errors


# --------------------------------------------------------------------------
# Indexing the cached collections
# --------------------------------------------------------------------------


def _lap_time_index(laps: list[dict]) -> dict[tuple[str, int], float]:
    """(car number, lap) -> that lap's own duration in seconds.

    Null durations are dropped rather than filled. `race_laps.py` is explicit
    that a null is a first-class case (an in-lap, a red-flag lap, a row cached
    before Batch 21), and the whole point of this module is that a lap nobody
    timed contributes nothing to a fit rather than contributing a guess.
    """
    index: dict[tuple[str, int], float] = {}
    for row in laps:
        number = str(row.get("driver_number") or "").strip()
        lap = _as_int(row.get("lap_number"))
        seconds = row.get("lap_time_seconds")
        if number and lap is not None and isinstance(seconds, (int, float)):
            index[(number, lap)] = float(seconds)
    return index


def _tyre_index(stints: list[dict]) -> dict[tuple[str, int], tuple[str, int]]:
    """(car number, lap) -> (compound, tyre age on that lap).

    Same range expansion `race_replay._compound_by_lap` does, kept separate
    only because that module cannot be imported here without pulling in FastF1
    (see `driver_directory.py`'s docstring for why that matters).
    """
    index: dict[tuple[str, int], tuple[str, int]] = {}
    for stint in stints:
        number = str(stint.get("driver_number") or "").strip()
        start, end = _as_int(stint.get("lap_start")), _as_int(stint.get("lap_end"))
        if not number or start is None or end is None:
            continue
        age_at_start = _as_int(stint.get("tyre_age_at_start")) or 0
        compound = str(stint.get("compound") or "UNKNOWN").upper()
        for lap in range(start, end + 1):
            index[(number, lap)] = (compound, age_at_start + lap - start)
    return index


def _stints_by_number(stints: list[dict]) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for stint in stints:
        number = str(stint.get("driver_number") or "").strip()
        if number:
            grouped[number].append(stint)
    for group in grouped.values():
        group.sort(key=lambda s: _as_int(s.get("stint_number")) or 0)
    return dict(grouped)


def _stops_by_number(stops: list[dict], number_by_id: dict[str, str]) -> dict[str, list[dict]]:
    """Pit stops keyed by car number and sorted by lap.

    The `driver_id` -> number translation is the join `race_replay.py` documents
    as having a silent failure mode. An unmatched stop is dropped and logged for
    the same reason it is there: silently losing a stop would make a driver's
    stop 2 look like their stop 1 and quietly move the wrong one.
    """
    grouped: dict[str, list[dict]] = defaultdict(list)
    unmatched: set[str] = set()
    for stop in stops:
        driver_id = stop.get("driver_id")
        number = number_by_id.get(driver_id)
        lap = _as_int(stop.get("lap"))
        if not number:
            if driver_id:
                unmatched.add(driver_id)
            continue
        if lap is None:
            continue
        grouped[number].append({
            "lap": lap,
            "stop": _as_int(stop.get("stop")) or 0,
            "duration_seconds": stop.get("duration_seconds"),
        })
    if unmatched:
        print(
            f"strategy_whatif: {len(unmatched)} pit-stop driver_id(s) had no car "
            f"number in race_results: {sorted(unmatched)}"
        )
    for group in grouped.values():
        group.sort(key=lambda s: s["lap"])
    return dict(grouped)


def official_index(official: list[dict]) -> dict:
    """Cumulative elapsed time and stated position per driver per lap.

    `cumulative` is what every positional answer in this module is ultimately
    ranked on, and `stated_position` is kept alongside it purely so
    `derive_positions` can be scored against it — the check that says the
    ordering rule adds no error of its own.
    """
    cumulative: dict[str, dict[int, int]] = defaultdict(dict)
    stated: dict[str, dict[int, int]] = defaultdict(dict)
    for lap_row in official:
        lap = _as_int(lap_row.get("lap"))
        if lap is None:
            continue
        for timing in lap_row.get("timings") or []:
            driver_id = timing.get("driverId")
            cum = _as_int(timing.get("cumulative_ms"))
            pos = _as_int(timing.get("position"))
            if not driver_id or cum is None:
                continue
            cumulative[driver_id][lap] = cum
            if pos is not None:
                stated[driver_id][lap] = pos
    return {"cumulative": dict(cumulative), "stated_position": dict(stated)}


def derive_positions(cumulative: dict[str, dict[int, int]], lap: int) -> list[tuple[str, int, int]]:
    """The running order as at `lap`, from elapsed time alone.

    Sorted by laps completed (descending) then elapsed time (ascending) — a car
    a lap down is behind every car on the lead lap however fast its own race
    has been. Returns `(driver_id, laps_completed, cumulative_ms)` in order.

    **This rule is exact, and that was measured rather than assumed**: applied
    at every crossing of all eleven synced 2026 rounds it reproduces the
    archive's own stated position on 12,700 of 12,700. It is the only step of
    this module that contributes no modelling error, which is why the
    counterfactual is expressed as an elapsed time and converted to a position
    here rather than being reasoned about positionally.
    """
    latest: dict[str, tuple[int, int]] = {}
    for driver_id, per_lap in cumulative.items():
        completed = [l for l in per_lap if l <= lap]
        if completed:
            best = max(completed)
            latest[driver_id] = (best, per_lap[best])
    ordered = sorted(latest.items(), key=lambda kv: (-kv[1][0], kv[1][1]))
    return [(driver_id, laps, cum) for driver_id, (laps, cum) in ordered]


def _order_with(
    cumulative: dict[str, dict[int, int]], lap: int, driver_id: str, cumulative_ms: float
) -> list[tuple[str, int, int]]:
    """The running order at `lap` with `driver_id` moved to `cumulative_ms`.

    Every other driver keeps their real time, which is the "nobody reacts"
    assumption made concrete in one line.
    """
    order = [
        row for row in derive_positions(cumulative, lap) if row[0] != driver_id
    ]
    order.append((driver_id, lap, int(round(cumulative_ms))))
    order.sort(key=lambda row: (-row[1], row[2]))
    return order


def _rank_with(
    cumulative: dict[str, dict[int, int]], lap: int, driver_id: str, cumulative_ms: float
) -> int:
    """Where `driver_id` sits at `lap` if their elapsed time were `cumulative_ms`."""
    order = _order_with(cumulative, lap, driver_id, cumulative_ms)
    return [row[0] for row in order].index(driver_id) + 1


# --------------------------------------------------------------------------
# Caution laps
# --------------------------------------------------------------------------


def field_median_laps(
    lap_times: dict[tuple[str, int], float], excluded: dict[str, set[int]]
) -> dict[int, float]:
    """Lap number -> the field's median lap time, pit laps excluded.

    Excluding each driver's own in-lap and out-lap matters more than it looks:
    with twenty cars and a pit window five laps wide, a third of the field can be
    pitting on the same lap, which drags the median up and makes an ordinary lap
    read as a caution.
    """
    grouped: dict[int, list[float]] = defaultdict(list)
    for (number, lap), seconds in lap_times.items():
        if lap in excluded.get(number, ()):
            continue
        grouped[lap].append(seconds)
    return {lap: statistics.median(values) for lap, values in grouped.items() if len(values) >= 5}


def caution_laps_from_pace(field_median: dict[int, float]) -> tuple[set[int], float]:
    """Laps the field ran materially slower than its own green-flag baseline.

    Returns `(laps, baseline_seconds)`. This is deliberately *not* a safety-car
    detector — it detects a slow track, which is the property that actually
    invalidates both the pace fit and a pit-cost measurement. A wet restart, a
    red-flag lap and a VSC all qualify without needing to be named.
    """
    if not field_median:
        return set(), 0.0
    values = sorted(field_median.values())
    cut = max(3, int(len(values) * _GREEN_QUANTILE))
    baseline = statistics.median(values[:cut])
    if baseline <= 0:
        return set(), 0.0
    return {lap for lap, value in field_median.items() if value / baseline > _CAUTION_RATIO}, baseline


def caution_laps_from_race_control(
    replay_laps: list[dict], final_lap: int, slow_laps: set[int] | None = None
) -> set[int]:
    """Safety-car, VSC and red-flag laps as race control reported them.

    Read from an already-cached `race_replay` document rather than fetched:
    `race_replay._events_by_lap` has already distilled OpenF1's ~80 messages
    down to the narratable ones, and this module makes no outbound calls (same
    posture as `strategy_commentary`). A round with no cached replay simply
    contributes nothing here and the pace detector stands alone.

    **A `safety_car_deployed` with no matching `safety_car_ending` is closed by
    the pace detector, not by assuming it ran to the flag.** Running it to the
    flag was the first version and it was measurably wrong: 2026 R6 has a
    deployment on lap 60 and no ending in the distilled events, which marked
    laps 60-78 as caution and refused every stop in the last quarter of the
    race — while the field's own lap times were back to green pace from lap 63.
    Extending only while the track is still measurably slow marks 60-62 there,
    which the pace detector and race control agree on. A safety car that really
    does run to the flag still extends correctly, because those laps are slow.
    """
    slow = slow_laps or set()
    laps: set[int] = set()
    open_at: int | None = None
    for lap_row in replay_laps or []:
        lap = _as_int(lap_row.get("lap"))
        if lap is None:
            continue
        for event in lap_row.get("events") or []:
            kind = str(event.get("kind") or "")
            if kind == "red_flag":
                laps.add(lap)
            elif kind == "safety_car_deployed" and open_at is None:
                open_at = lap
            elif kind == "safety_car_ending" and open_at is not None:
                laps.update(range(open_at, lap + 1))
                open_at = None
    if open_at is not None:
        laps.add(open_at)
        lap = open_at + 1
        while lap <= final_lap and lap in slow:
            laps.add(lap)
            lap += 1
    return laps


# --------------------------------------------------------------------------
# The pace model
# --------------------------------------------------------------------------


def fit_pace_model(
    lap_times: dict[tuple[str, int], float],
    tyre: dict[tuple[str, int], tuple[str, int]],
    green_laps: set[int],
    pit_laps: dict[str, set[int]],
) -> dict | None:
    """Fit `lap_time ~ driver + fuel*lap + compound + degradation*tyre_age`.

    Driver intercepts are removed by within-driver demeaning (the fixed-effects
    transform) rather than fitted as dummies: it is algebraically identical for
    the coefficients that matter, and it keeps the system at seven columns
    rather than twenty-seven, which is what makes a pure-Python solve sane.

    **The reference compound is the most-used one and it has no dummy of its
    own.** A dummy for every compound sums to a constant column, and a pooled
    age slope plus a deviation for every compound is likewise rank deficient;
    both were tried and both made `_solve` return None on every round. The
    reference compound's intercept is absorbed into the driver intercept and its
    age slope *is* the pooled slope, which is exactly the fallback a compound
    without enough support needs.

    Lap 1 is excluded throughout: it is a standing start, it is not a
    representative measurement of anything, and CP79 records how much trouble
    treating it as an ordinary lap has already caused elsewhere in this app.

    Returns None when the fit is not identifiable, which the caller turns into a
    `pace_unmeasurable` refusal rather than a wide guess.
    """
    ages_by_compound: dict[str, list[int]] = defaultdict(list)
    for (number, lap), (compound, age) in tyre.items():
        if compound == "UNKNOWN" or lap == 1 or lap not in green_laps:
            continue
        if lap in pit_laps.get(number, ()) or (number, lap) not in lap_times:
            continue
        ages_by_compound[compound].append(age)

    compounds = sorted(ages_by_compound)
    if not compounds:
        return None

    reference = max(compounds, key=lambda c: len(ages_by_compound[c]))
    others = [c for c in compounds if c != reference]
    own_slope = [
        c for c in others
        if len(ages_by_compound[c]) >= _MIN_COMPOUND_LAPS
        and (max(ages_by_compound[c]) - min(ages_by_compound[c])) >= _MIN_AGE_SPAN
    ]
    offset_at = {c: 1 + i for i, c in enumerate(others)}
    slope_at = {c: 2 + len(others) + i for i, c in enumerate(own_slope)}
    age_column = 1 + len(others)
    columns = 2 + len(others) + len(own_slope)

    observations: dict[str, list[tuple[list[float], float]]] = defaultdict(list)
    for (number, lap), seconds in lap_times.items():
        if lap == 1 or lap not in green_laps or lap in pit_laps.get(number, ()):
            continue
        state = tyre.get((number, lap))
        if not state or state[0] not in ages_by_compound:
            continue
        compound, age = state
        row = [0.0] * columns
        row[0] = float(lap)
        if compound in offset_at:
            row[offset_at[compound]] = 1.0
        row[age_column] = float(age)
        if compound in slope_at:
            row[slope_at[compound]] = float(age)
        observations[number].append((row, seconds))

    def demeaned(source):
        rows = []
        for group in source.values():
            if len(group) < 5:
                continue
            means = [sum(o[0][i] for o in group) / len(group) for i in range(columns)]
            mean_y = sum(o[1] for o in group) / len(group)
            for xs, y in group:
                rows.append(([xs[i] - means[i] for i in range(columns)], y - mean_y))
        return rows

    beta, sigma, errors = _ols(demeaned(observations), columns)
    if beta is None:
        return None

    # One robust pass. Refitting after dropping outliers matters because a
    # single 20s-slow lap behind a struggling car pulls the age slope more than
    # the whole rest of that stint pushes it back.
    kept: dict[str, list[tuple[list[float], float]]] = defaultdict(list)
    for number, group in observations.items():
        if len(group) < 5:
            continue
        means = [sum(o[0][i] for o in group) / len(group) for i in range(columns)]
        mean_y = sum(o[1] for o in group) / len(group)
        for xs, y in group:
            centred = [xs[i] - means[i] for i in range(columns)]
            residual = (y - mean_y) - sum(b * x for b, x in zip(beta, centred))
            if abs(residual) <= _OUTLIER_SIGMA * sigma:
                kept[number].append((xs, y))
    refit, refit_sigma, refit_errors = _ols(demeaned(kept), columns)
    if refit is not None:
        beta, sigma, errors, observations = refit, refit_sigma, refit_errors, kept

    intercepts: dict[str, float] = {}
    for number, group in observations.items():
        if len(group) < 5:
            continue
        intercepts[number] = sum(
            y - sum(b * x for b, x in zip(beta, xs)) for xs, y in group
        ) / len(group)

    degradation = {
        c: beta[age_column] + (beta[slope_at[c]] if c in slope_at else 0.0)
        for c in compounds
    }
    degradation_error = {
        c: math.sqrt(errors[age_column] ** 2 + (errors[slope_at[c]] ** 2 if c in slope_at else 0.0))
        for c in compounds
    }
    return {
        "compounds": compounds,
        "reference_compound": reference,
        "own_slope_compounds": own_slope,
        "fuel_seconds_per_lap": beta[0],
        "compound_offset": {c: (beta[offset_at[c]] if c in offset_at else 0.0) for c in compounds},
        "degradation_seconds_per_lap": degradation,
        "degradation_standard_error": degradation_error,
        "residual_sigma_seconds": sigma,
        "driver_intercept": intercepts,
        "laps_fitted": sum(len(g) for g in observations.values()),
        "max_observed_tyre_age": {c: max(ages_by_compound[c]) for c in compounds},
    }


def _predicted_green_lap(model: dict, number: str, lap: int, state: tuple[str, int] | None) -> float | None:
    """What the fit says this driver's lap would take in clean air on green flags."""
    if state is None or number not in model["driver_intercept"]:
        return None
    compound, age = state
    if compound not in model["compound_offset"]:
        return None
    return (
        model["driver_intercept"][number]
        + model["fuel_seconds_per_lap"] * lap
        + model["compound_offset"][compound]
        + model["degradation_seconds_per_lap"][compound] * age
    )


def measure_pit_cost(
    model: dict,
    lap_times: dict[tuple[str, int], float],
    tyre: dict[tuple[str, int], tuple[str, int]],
    stops_by_number: dict[str, list[dict]],
    green_laps: set[int],
) -> dict | None:
    """What a green-flag pit stop cost in this race, in seconds, as measured.

    For each stop whose in-lap *and* out-lap ran under green flags, the cost is
    how much longer those two laps took than the fitted model says they should
    have. Nothing about pit-lane length, speed limits or stationary time is
    assumed — the number falls out of the race's own laps, which is why it lands
    between 19.4s and 33.2s across the 2026 rounds rather than on one constant.

    The in-lap and out-lap excesses are reported separately because the split is
    a property of the circuit's timing line, not of pit stops: 2026 R7 measured
    3.7s in / 20.5s out and R1 measured 21.6s in / 6.4s out. Only the split says
    where the cost lands on the timeline, and the rejoin position depends on it.

    The spread is a median absolute deviation, not a standard deviation: one
    unsafe release or one stop taken at the moment a safety car is called would
    otherwise set the width of every window in the race. It is what sizes the
    reported window, so a race whose stops scattered (R1 measured a 5.8s MAD)
    honestly produces wider windows than one whose stops did not (R4, 0.5s).
    """
    in_lap: list[float] = []
    out_lap: list[float] = []
    totals: list[float] = []
    per_stop: dict[tuple[str, int], tuple[float, float]] = {}

    for number, stops in stops_by_number.items():
        for stop in stops:
            lap = stop["lap"]
            if lap not in green_laps or (lap + 1) not in green_laps:
                continue
            actual_in = lap_times.get((number, lap))
            actual_out = lap_times.get((number, lap + 1))
            expected_in = _predicted_green_lap(model, number, lap, tyre.get((number, lap)))
            expected_out = _predicted_green_lap(model, number, lap + 1, tyre.get((number, lap + 1)))
            if None in (actual_in, actual_out, expected_in, expected_out):
                continue
            excess_in = actual_in - expected_in
            excess_out = actual_out - expected_out
            in_lap.append(excess_in)
            out_lap.append(excess_out)
            totals.append(excess_in + excess_out)
            per_stop[(number, lap)] = (excess_in, excess_out)

    if len(totals) < _MIN_GREEN_STOPS:
        return None

    median_total = statistics.median(totals)
    return {
        "in_lap_seconds": statistics.median(in_lap),
        "out_lap_seconds": statistics.median(out_lap),
        "total_seconds": statistics.median(in_lap) + statistics.median(out_lap),
        "spread_seconds": _MAD_TO_SIGMA * statistics.median([abs(t - median_total) for t in totals]),
        "green_stops_measured": len(totals),
        "measured_per_stop": per_stop,
    }


# --------------------------------------------------------------------------
# The counterfactual
# --------------------------------------------------------------------------


def _driver_plan(stints: list[dict], stops: list[dict]) -> list[dict] | None:
    """One driver's stints paired with the stop that opened each of them.

    Returns None when the two sources disagree, and that check is the point of
    the function. `race_stints` and `pit_stops` come from different upstreams
    (OpenF1/FastF1 and Ergast), and they agreed on 435 of 435 boundaries across
    the eleven synced 2026 rounds — `lap_start == stop_lap + 1`, with matching
    counts. Because they agree everywhere it is tempting to just index one by
    the other; because they *could* disagree on a round nobody has looked at,
    a mismatch here would silently move a driver's second stop when the caller
    asked for their first. Refusing is the only safe answer.
    """
    ordered = sorted(stints, key=lambda s: _as_int(s.get("lap_start")) or 0)
    if not ordered:
        return None
    if len(ordered) != len(stops) + 1:
        return None
    for stop, stint in zip(stops, ordered[1:]):
        if _as_int(stint.get("lap_start")) != stop["lap"] + 1:
            return None

    plan = []
    for index, stint in enumerate(ordered):
        plan.append({
            "stint_number": index + 1,
            "compound": str(stint.get("compound") or "UNKNOWN").upper(),
            "lap_start": _as_int(stint.get("lap_start")),
            "lap_end": _as_int(stint.get("lap_end")),
            "tyre_age_at_start": _as_int(stint.get("tyre_age_at_start")) or 0,
            "opened_by_stop": stops[index - 1] if index else None,
        })
    return plan


def _extrapolation_sigma(model: dict, compound: str, ages: list[int]) -> tuple[float, int]:
    """Extra uncertainty for asking the fit about a tyre age nobody reached.

    Returns `(seconds, laps_beyond)`. Inside the observed age range this is
    zero — the slope is being interpolated, and its own standard error already
    covers that. Beyond it, each extrapolated lap contributes the full
    degradation rate as uncertainty, i.e. the model admits the curve could be
    twice as steep or completely flat out there.

    **This is a chosen widening, not a measurement**, and it is stated as one in
    the payload. There is no data in a race about a stint length the race never
    contained; the honest options were to widen or to refuse, and the endpoint
    does both — widen inside `_MAX_EXTRAPOLATION_LAPS`, refuse beyond it.
    """
    observed = model["max_observed_tyre_age"].get(compound)
    if observed is None or not ages:
        return 0.0, 0
    beyond = [a - observed for a in ages if a > observed]
    if not beyond:
        return 0.0, 0
    rate = abs(model["degradation_seconds_per_lap"].get(compound, 0.0))
    return rate * sum(beyond), max(beyond)


def estimate_stop_move(
    number: str,
    plan: list[dict],
    stop_index: int,
    new_lap: int,
    model: dict,
    pit_cost: dict,
    official: dict,
    driver_id: str,
    caution: set[int],
    last_lap_run: int,
) -> dict:
    """The whole counterfactual, as `{refusal}` or `{estimate, assumptions}`.

    `stop_index` is zero-based into the stops that opened stints 2..N, so
    `stop_index=0` is the driver's first stop.

    The arithmetic is described in the module docstring; what is worth reading
    here is the order of the guards. Every refusal is checked *before* any
    modelling, so a refused query never computes a number that could leak into
    a log or a partially-rendered UI as if it were an answer.
    """
    stint_before = plan[stop_index]
    stint_after = plan[stop_index + 1]
    original_lap = stint_before["lap_end"]

    def refuse(code: str, **detail):
        return {"refusal": {"code": code, "reason": _REFUSALS[code], **detail}, "estimate": None}

    if new_lap < 1 or new_lap >= last_lap_run:
        return refuse("lap_not_run", last_lap_run=last_lap_run)
    if new_lap < stint_before["lap_start"]:
        return refuse("same_lap_as_neighbour", earliest_lap=stint_before["lap_start"])
    if new_lap >= stint_after["lap_end"]:
        return refuse("past_stint_end", latest_lap=stint_after["lap_end"] - 1)
    if new_lap in caution or (new_lap + 1) in caution:
        return refuse("caution_at_new_lap", caution_laps=sorted(caution))
    if original_lap in caution or (original_lap + 1) in caution:
        return refuse("caution_at_original_lap", caution_laps=sorted(caution))

    measured = pit_cost["measured_per_stop"].get((number, original_lap))
    if measured is None:
        return refuse("original_stop_unmeasurable", original_lap=original_lap)

    compound_old = stint_before["compound"]
    compound_new = stint_after["compound"]
    degradation = model["degradation_seconds_per_lap"]
    offsets = model["compound_offset"]
    if compound_old not in degradation or compound_new not in degradation:
        return refuse("pace_unmeasurable")

    age_old_at_start = stint_before["tyre_age_at_start"]
    age_new_at_start = stint_after["tyre_age_at_start"]
    final_lap = stint_after["lap_end"]

    def real_state(lap: int) -> tuple[str, int]:
        if lap <= original_lap:
            return compound_old, age_old_at_start + lap - stint_before["lap_start"]
        return compound_new, age_new_at_start + lap - (original_lap + 1)

    def counterfactual_state(lap: int) -> tuple[str, int]:
        if lap <= new_lap:
            return compound_old, age_old_at_start + lap - stint_before["lap_start"]
        return compound_new, age_new_at_start + lap - (new_lap + 1)

    def pace(state: tuple[str, int]) -> float:
        compound, age = state
        return offsets[compound] + degradation[compound] * age

    first_affected = min(original_lap, new_lap) + 1

    # Moving a stop *later* asks the old tyre to survive laps it never ran, so
    # both compounds can be extrapolated and both have to be checked. Only
    # checking the new one was the first version of this and it silently let a
    # stop be delayed twenty laps onto a set nobody kept past ten.
    ages_by_compound: dict[str, list[int]] = defaultdict(list)
    for lap in range(first_affected, final_lap + 1):
        compound, age = counterfactual_state(lap)
        ages_by_compound[compound].append(age)
    extra_sigma = 0.0
    laps_beyond = 0
    beyond_compound = None
    for compound, ages in ages_by_compound.items():
        sigma_part, beyond = _extrapolation_sigma(model, compound, ages)
        extra_sigma += sigma_part
        if beyond > laps_beyond:
            laps_beyond, beyond_compound = beyond, compound
    if laps_beyond > _MAX_EXTRAPOLATION_LAPS:
        return refuse(
            "beyond_observed_stint",
            compound=beyond_compound,
            laps_beyond_observed=laps_beyond,
            longest_observed_stint=model["max_observed_tyre_age"].get(beyond_compound),
        )

    # Cumulative modelled delta, lap by lap. Built as a running total because
    # every reported instant (the rejoin, the flag) reads it at a different lap.
    delta_by_lap: dict[int, float] = {}
    running = 0.0
    age_shift_total = 0
    for lap in range(first_affected, final_lap + 1):
        running += pace(counterfactual_state(lap)) - pace(real_state(lap))
        age_shift_total += abs(counterfactual_state(lap)[1] - real_state(lap)[1])
        # The stop's cost is removed from the laps it really fell on and applied
        # to the laps it would now fall on. The counterfactual side uses the
        # race's *fitted* cost, never this stop's own measured one: a stop on a
        # different lap is a stop nobody timed.
        shift = 0.0
        if lap >= new_lap:
            shift += pit_cost["in_lap_seconds"]
        if lap >= new_lap + 1:
            shift += pit_cost["out_lap_seconds"]
        if lap >= original_lap:
            shift -= measured[0]
        if lap >= original_lap + 1:
            shift -= measured[1]
        delta_by_lap[lap] = running + shift

    def delta_at(lap: int) -> float:
        """The modelled time delta as at `lap`, clamped outside the affected range.

        Before the first affected lap nothing has happened yet. **After the last
        one the delta persists** — it does not decay to zero. A later stop stays
        on its own lap, so every stint after this one is untouched and simply
        inherits the offset. Reading `delta_by_lap.get(lap, 0.0)` instead was a
        real bug: moving a driver's *first* stop then reported their finishing
        position as unchanged, because the flag falls outside the second stint.
        """
        if lap < first_affected:
            return 0.0
        return delta_by_lap[min(lap, final_lap)]

    cumulative = official["cumulative"]
    own = cumulative.get(driver_id) or {}

    slope_error = model["degradation_standard_error"].get(compound_new, 0.0)
    sigma = math.sqrt(
        pit_cost["spread_seconds"] ** 2
        + (slope_error * age_shift_total) ** 2
        + extra_sigma ** 2
    )
    half_width_ms = _BAND_SIGMA * sigma * 1000.0

    def window_at(lap: int) -> dict | None:
        real_cumulative = own.get(lap)
        if real_cumulative is None:
            return None
        centre = real_cumulative + delta_at(lap) * 1000.0
        best = _rank_with(cumulative, lap, driver_id, centre - half_width_ms)
        worst = _rank_with(cumulative, lap, driver_id, centre + half_width_ms)
        midpoint = _rank_with(cumulative, lap, driver_id, centre)
        return {
            "lap": lap,
            "position_window": [min(best, worst), max(best, worst)],
            "midpoint_position": midpoint,
            "real_position": (official["stated_position"].get(driver_id) or {}).get(lap),
            "estimated_time_delta_seconds": round(delta_at(lap), 3),
        }

    rejoin = window_at(new_lap + 1)
    finish = window_at(last_lap_run)
    if rejoin is None or finish is None:
        return refuse("lap_not_run", last_lap_run=last_lap_run)

    # Who they would come out behind, and by how much. This is the one number in
    # the rejoin block that is not modelled — it is arithmetic on the official
    # cumulative times — and it is here *instead of* a traffic term, not
    # alongside one. `gap_seconds` is null when the car ahead is on a different
    # lap: a time difference between two cars a lap apart is a real number that
    # misinforms, the same trap CP84 recorded for the timing tower's gap column.
    rejoin_lap = new_lap + 1
    rejoin_centre = own[rejoin_lap] + delta_at(rejoin_lap) * 1000.0
    order = _order_with(cumulative, rejoin_lap, driver_id, rejoin_centre)
    position = [row[0] for row in order].index(driver_id)
    ahead = None
    if position > 0:
        other_id, other_laps, other_cum = order[position - 1]
        ahead = {
            "driver_id": other_id,
            "gap_seconds": (
                round((rejoin_centre - other_cum) / 1000.0, 3)
                if other_laps == rejoin_lap else None
            ),
            "laps_ahead": other_laps - rejoin_lap,
        }
    return {
        "refusal": None,
        "estimate": {
            "original_lap": original_lap,
            "new_lap": new_lap,
            "laps_moved": original_lap - new_lap,
            "compound_fitted": compound_new,
            "rejoin": {**rejoin, "car_ahead": ahead},
            "finish": finish,
            "uncertainty_seconds": round(sigma, 3),
            "window_sigma": _BAND_SIGMA,
            "extrapolated_laps_beyond_observed": laps_beyond,
        },
    }


# --------------------------------------------------------------------------
# Endpoint
# --------------------------------------------------------------------------


def build_whatif(
    results: list[dict],
    laps: list[dict],
    stints: list[dict],
    stops: list[dict],
    official: list[dict],
    replay_laps: list[dict],
    driver: str,
    stop_number: int,
    new_lap: int,
) -> dict:
    """The whole endpoint as one pure function over already-fetched documents.

    Pure so the test suite can drive every refusal and the happy path without a
    database, the way `strategy_commentary.build_facts` and
    `race_replay.build_replay` already are in this codebase.
    """
    directory = _driver_directory(results)
    number_by_id = _number_by_driver_id(directory)

    lap_times = _lap_time_index(laps)
    tyre = _tyre_index(stints)
    stints_by_number = _stints_by_number(stints)
    stops_by_number = _stops_by_number(stops, number_by_id)
    index = official_index(official)

    pit_laps = {
        number: {s["lap"] for s in group} | {s["lap"] + 1 for s in group}
        for number, group in stops_by_number.items()
    }
    field_median = field_median_laps(lap_times, pit_laps)
    slow_laps, green_baseline = caution_laps_from_pace(field_median)
    final_lap = max(field_median) if field_median else 0
    caution = slow_laps | caution_laps_from_race_control(replay_laps, final_lap, slow_laps)
    green_laps = {lap for lap in field_median if lap not in caution}

    # Resolve the driver from either namespace. The UI sends an Ergast
    # `driver_id` because that is what `pit_stops` carries, but a car number is
    # what every other collection here keys on, so both are accepted rather than
    # making the caller know which side of the join it is on.
    key = str(driver or "").strip()
    number = number_by_id.get(key) or (key if key in directory else None)
    entry = directory.get(number or "") or {}
    driver_id = entry.get("driver_id")

    assumptions = {
        "model_version": MODEL_VERSION,
        "green_baseline_lap_seconds": round(green_baseline, 3) if green_baseline else None,
        "caution_laps": sorted(caution),
        "green_laps_used": len(green_laps),
        "traffic": (
            "Not modelled. This app caches no track-position data, so whether a "
            "rejoining car is held up cannot be derived from anything here. Being "
            "held up only ever costs time, so a clean-air estimate is a best case."
        ),
        "rivals": "Every other car is assumed to run exactly the race it ran; no team reacts.",
        "lap_count": "The driver is assumed to complete the same number of laps.",
    }

    def refusal(code: str, **detail):
        return {
            "estimate": None,
            "refusal": {"code": code, "reason": _REFUSALS[code], **detail},
            "assumptions": assumptions,
        }

    if not results or not laps or not stints or not stops or not official:
        return refusal("no_data")
    if not number or not driver_id:
        return refusal("unknown_driver")

    driver_stops = stops_by_number.get(number) or []
    plan = _driver_plan(stints_by_number.get(number) or [], driver_stops)
    if plan is None:
        return refusal("stint_join_mismatch")

    stop_index = next(
        (i for i, s in enumerate(driver_stops) if s["stop"] == stop_number), None
    )
    if stop_index is None:
        return refusal("unknown_stop", stops_made=[s["stop"] for s in driver_stops])

    model = fit_pace_model(lap_times, tyre, green_laps, pit_laps)
    if model is None:
        return refusal("pace_unmeasurable")
    pit_cost = measure_pit_cost(model, lap_times, tyre, stops_by_number, green_laps)
    if pit_cost is None:
        return refusal("pit_cost_unmeasurable")

    laps_run = [lap for lap in (index["cumulative"].get(driver_id) or {})]
    if not laps_run:
        return refusal("lap_not_run", last_lap_run=0)
    last_lap_run = max(laps_run)

    outcome = estimate_stop_move(
        number, plan, stop_index, new_lap, model, pit_cost, index,
        driver_id, caution, last_lap_run,
    )

    # The fitted parameters ship with every answer, refused or not: an estimate
    # whose assumptions are a click away in a separate call is an estimate whose
    # assumptions nobody reads. `measured_per_stop` is dropped — it is a working
    # index, not a served fact.
    assumptions = {
        **assumptions,
        "pace_model": {
            "fuel_seconds_per_lap": round(model["fuel_seconds_per_lap"], 5),
            "degradation_seconds_per_lap": {
                c: round(v, 5) for c, v in model["degradation_seconds_per_lap"].items()
            },
            "degradation_standard_error": {
                c: round(v, 5) for c, v in model["degradation_standard_error"].items()
            },
            "compound_offset_seconds": {
                c: round(v, 4) for c, v in model["compound_offset"].items()
            },
            "reference_compound": model["reference_compound"],
            "compounds_with_own_slope": model["own_slope_compounds"],
            "residual_sigma_seconds": round(model["residual_sigma_seconds"], 4),
            "laps_fitted": model["laps_fitted"],
            "max_observed_tyre_age": model["max_observed_tyre_age"],
        },
        "pit_cost": {
            "in_lap_seconds": round(pit_cost["in_lap_seconds"], 3),
            "out_lap_seconds": round(pit_cost["out_lap_seconds"], 3),
            "total_seconds": round(pit_cost["total_seconds"], 3),
            "spread_seconds": round(pit_cost["spread_seconds"], 3),
            "green_stops_measured": pit_cost["green_stops_measured"],
        },
    }

    return {
        "driver": {
            "number": number,
            "driver_id": driver_id,
            "name": entry.get("name"),
            "team": entry.get("team"),
            "real_finish_position": entry.get("finish_position"),
            "last_lap_run": last_lap_run,
            "stops": [{"stop": s["stop"], "lap": s["lap"]} for s in driver_stops],
        },
        "assumptions": assumptions,
        **outcome,
    }


@router.get("/strategy_whatif")
async def get_strategy_whatif(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round_number: int = Query(..., alias="round", description="Round number within the season"),
    driver: str = Query(..., description="Ergast driverId or car number"),
    stop: int = Query(..., description="Which of that driver's real stops to move (1-based)"),
    lap: int = Query(..., description="The lap to move the stop to"),
):
    """Estimate the effect of moving one real pit stop to a different lap.

    Read-only against `race_results`, `race_laps`, `race_stints`, `pit_stops`,
    `official_laps` and a cached `race_replay` — no outbound calls and no
    self-heal, matching `strategy_commentary`'s posture exactly. An unsynced
    round reports `synced: false` with a `no_data` refusal rather than an error.

    Nothing is cached: the answer is parameterised by the caller's chosen lap,
    so the query space is the whole race per stop, and the work is a fit over a
    thousand lap rows — cheap enough to do per request and not worth a cache
    document per lap the user drags past.
    """
    db = get_db()
    key = {"season": year, "round": str(round_number)}

    results_doc = await db.race_results.find_one(key, {"_id": 0})
    laps_doc = await db.race_laps.find_one(key, {"_id": 0})
    stints_doc = await db.race_stints.find_one(key, {"_id": 0})
    stops_doc = await db.pit_stops.find_one(key, {"_id": 0})
    official_doc = await db.official_laps.find_one(key, {"_id": 0}, sort=[("version", -1)])
    replay_doc = await db.race_replay.find_one(key, {"_id": 0}, sort=[("version", -1)])

    payload = build_whatif(
        (results_doc or {}).get("results") or [],
        (laps_doc or {}).get("laps") or [],
        (stints_doc or {}).get("stints") or [],
        (stops_doc or {}).get("stops") or [],
        (official_doc or {}).get("laps") or [],
        ((replay_doc or {}).get("replay") or {}).get("laps") or [],
        driver,
        stop,
        lap,
    )

    # `synced: false` means "this round has not been processed", the same
    # convention every other module here uses. A refusal for any *other* reason
    # is a synced round answering honestly, not a missing one.
    synced = (payload.get("refusal") or {}).get("code") != "no_data"
    return JSONResponse(content={
        "year": year,
        "round": round_number,
        "synced": synced,
        **payload,
    })
