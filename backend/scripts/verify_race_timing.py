"""Validate the per-second timing track against the official record.

**Why this exists.** Seven defects shipped in a row that every existing check
passed: the unit suite, a real browser, and "we observe intra-lap movement" were
all satisfied by payloads that were, variously, shifted a whole lap, missing the
opening 90 seconds of every race, and — the one a user found by watching it —
serving laps 1 and 2 of the Australian GP in the wrong order. The common cause
is that all of those checks compared the OpenF1 feed against itself. A feed
always agrees with itself.

Each check below states what it is independent of, because that is the only
property that makes a check worth running:

- `grid`        vs `race_results.grid` — the official starting order. Fully
                independent: the payload's t=0 seeding reads the same field, so
                this is a plumbing check, but it catches a payload that never
                seeded at all.
- `flag-order`  vs `race_results.position` — the official *classification*.
                Independent of the lap archive, and reported without a
                threshold: the two genuinely disagree wherever a post-race
                penalty applied, and the tower is right to show the order as the
                flag fell.
- `archive`     official cumulative lap times vs official positions. Validates
                the spine itself, using nothing this app wrote: if summing the
                lap times does not reproduce the stated order, the archive is
                unusable for that round and everything downstream is suspect.
- `boundaries`  the served payload's order at each lap crossing vs the official
                order. **Not independent** — the payload is built from that
                record — so it proves the pipeline (parse, merge, collapse,
                cache, serve) rather than the data. Run with `--deployed` it is
                the check that would have caught the inverted opening.
- `gaps`        the payload's `gap_to_leader` at each driver's own crossing vs
                the gap the official cumulative times state there.
- `intervals`   the same for `interval`, against the difference to the adjacent
                car in that lap's crossing order.
- `fill-gap`    **the independent one.** The last *OpenF1* reading before each
                crossing, scored against the archive's gap at that crossing —
                i.e. what the tower shows on the approach to the line, which is
                still OpenF1's alone. Informational, with no threshold: it
                measures the feed's cadence and staleness, not this code.
- `fill`        how many intra-lap position samples exist at all. Purely
                informational: a payload with none of them is the lap-stepped
                tower this module exists to replace, and it would pass every
                other check here.

**`gaps` was independent and is not any more, and pretending otherwise would be
the exact mistake this file exists to prevent.** It was written when the gap
column came from OpenF1 alone, so scoring it against the archive compared two
sources that share no inputs — and it read 47% on the deployed payload whose
timeline sat 84 seconds late. As of `TIMING_VERSION` 7 the payload *is* that
arithmetic at every crossing, so `gaps` and `intervals` are plumbing checks in
the same category as `boundaries`: they prove parse, merge, tie-break, collapse,
cache and serve, and they would still catch a timeline shift, a lost tie or a
dropped column. They are not evidence that the numbers are right, because the
numbers and the check now come from the same place. `fill-gap` is what is left
that is genuinely independent, and it is deliberately not asserted on — the
residual there is OpenF1's sampling cadence, which no change to this repo fixes.

The history is worth keeping: everything above `gaps` passed a round-1 payload
whose whole timeline sat 84 seconds late. Positions survived the shift — they
are stamped from the official record at every crossing, so `boundaries` and
`grid` scored 100% while the interval and gap columns beside them showed a lap
later's race and the opening lap had no readings at all. A check that only
scores the spine cannot see a fault in the flesh.

Run it after any change to `race_timing.py`:

    python -m scripts.verify_race_timing            # all synced 2026 rounds
    python -m scripts.verify_race_timing --round 1  # one round
    python -m scripts.verify_race_timing --deployed # check the live service

Exits non-zero if any hard check fails, so it can gate a deploy.
"""

import argparse
import os
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if "motor.motor_asyncio" not in sys.modules:  # race_timing imports it via db.py
    _motor = types.ModuleType("motor")
    _asyncio_mod = types.ModuleType("motor.motor_asyncio")

    class _Client:  # pragma: no cover - stub
        pass

    _asyncio_mod.AsyncIOMotorClient = _Client
    sys.modules["motor"] = _motor
    sys.modules["motor.motor_asyncio"] = _asyncio_mod

import httpx
import pymongo

from app import official_laps, race_timing

DEPLOYED = "https://f1-backend-1076575666662.asia-south1.run.app"

# Thresholds. Each is set below the *measured* value on a healthy season, not at
# a round number, so that tightening them later is a deliberate act.
MIN_ARCHIVE = 0.99      # the official record must be self-consistent
MIN_BOUNDARY = 0.99     # the pipeline must reproduce what it was built from
MIN_GRID = 1.00         # the grid is copied, so anything less is a bug
# The gap and interval columns are stamped from the archive at every crossing as
# of v7, so these are copies too and the threshold moved from 0.90 to match
# `boundaries`. Under v6 they came from OpenF1's fill and measured 94-99%; the
# equivalent measurement now lives in `fill-gap`, unasserted.
MIN_GAPS = 0.99
MIN_INTERVALS = 0.99

# What counts as agreement at a crossing, in seconds. Tight, because the payload
# should *be* this number: `_round_value` costs at most 0.005s and the archive's
# cumulative times are whole milliseconds. Anything larger than this is a real
# fault — a lost tie-break, a sample dropped, a column from the wrong lap.
CROSSING_TOLERANCE = 0.05

# What counts as agreement for the OpenF1 fill on the approach to a crossing.
# Loose on purpose: that reading is a sample carried forward, it can be several
# seconds old, and a real gap genuinely moves in that time. The fault this
# tolerance was originally sized for is a whole lap — ~85s.
FILL_TOLERANCE = 1.0


def _mongo():
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        env = Path(__file__).resolve().parents[2] / ".env"
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.lower().startswith("mongodburi="):
                uri = line.split("=", 1)[1].strip()
                break
    if not uri:
        raise SystemExit("No MONGODB_URI and no mongodburi= in .env")
    return pymongo.MongoClient(uri)["f1_scratch"]


def order_at(drivers: dict, ms: int) -> dict[str, int]:
    """`{car number: position}` as the tower would render it at `ms`.

    Deliberately reimplements the frontend's "last sample at or before now"
    lookup rather than importing anything: a shared helper would hide a bug that
    lives in the lookup itself, which is the class of bug this file exists for.
    """
    out: dict[str, int] = {}
    for number, entry in drivers.items():
        position = None
        for sample in entry.get("positions") or []:
            if sample[0] <= ms:
                position = sample[1]
            else:
                break
        if position is not None:
            out[number] = position
    return out


def check_archive(official_rows: list[dict]) -> tuple[int, int, list[str]]:
    """Does summing the official lap times reproduce the official positions?"""
    hit = total = 0
    notes = []
    for row in official_rows:
        timings = row.get("timings") or []
        by_time = sorted(timings, key=lambda t: t["cumulative_ms"])
        for rank, timing in enumerate(by_time, start=1):
            total += 1
            if timing["position"] == rank:
                hit += 1
            elif len(notes) < 3:
                notes.append(f"L{row['lap']} {timing['driverId']} says P{timing['position']}, times say P{rank}")
    return hit, total, notes


def check_boundaries(drivers, official_rows, numbers) -> tuple[int, int, list[str]]:
    """Order at each driver's own crossing vs their official position there."""
    hit = total = 0
    notes = []
    for row in official_rows:
        for timing in row.get("timings") or []:
            number = numbers.get(timing["driverId"])
            if number is None:
                continue
            # Read at the crossing itself. Reading earlier lands inside the
            # window where a car ahead has crossed and this one has not, where
            # two cars legitimately share a position.
            shown = order_at(drivers, timing["cumulative_ms"]).get(number)
            total += 1
            if shown == timing["position"]:
                hit += 1
            elif len(notes) < 3:
                notes.append(
                    f"L{row['lap']} #{number} shown P{shown}, official P{timing['position']}"
                )
    return hit, total, notes


def _truth_at_crossings(official_rows, numbers):
    """`[(lap, number, at_ms, true gap, true interval), ...]` from the archive alone.

    The true gap is the driver's cumulative minus the lap leader's; the true
    interval is the difference to the adjacent car when that lap's crossings are
    sorted by cumulative time. Both in seconds.

    Recomputed here rather than imported from `race_timing`, for the same reason
    `order_at` reimplements the frontend's lookup: sharing the derivation with
    the thing under test turns a check into a tautology, and this file exists
    because that class of mistake shipped seven defects.
    """
    out = []
    for row in official_rows:
        crossings = sorted(
            (
                (timing["cumulative_ms"], numbers.get(timing["driverId"]))
                for timing in row.get("timings") or []
            ),
            key=lambda crossing: crossing[0],
        )
        if not crossings:
            continue
        leader = crossings[0][0]
        previous = None
        for at, number in crossings:
            interval = 0.0 if previous is None else (at - previous) / 1000
            previous = at
            if number is not None:
                out.append((row["lap"], number, at, (at - leader) / 1000, interval))
    return out


def _shown(entry, at: int, column: int, before: bool = False, skip: set | None = None):
    """The payload's reading in `column` (1 interval, 2 gap) as of `at`.

    Reimplements the frontend's "last sample at or before now" lookup. `before`
    plus `skip` narrows it to the last sample that is *not* one of this driver's
    line crossings, which is how the OpenF1 fill is scored on its own.
    """
    value = None
    for sample in entry.get("timing") or []:
        if sample[0] > at or (before and sample[0] == at):
            break
        if skip is not None and sample[0] in skip:
            continue
        value = sample[column]
    return value


def check_timing_column(
    drivers, official_rows, numbers, column: int, tolerance: float, fill: bool = False
) -> tuple[int, int, float, list[str]]:
    """One timing column at every crossing vs what the archive states there.

    Returns `(within tolerance, numeric readings, median error, notes)`.

    `column` is 1 for `interval` and 2 for `gap_to_leader`. With `fill=True` the
    reading is taken strictly before the crossing and ignores this driver's own
    crossing samples, which scores what OpenF1 carried into the line rather than
    what the archive stamped on it.

    **Scored over numeric readings only, and the string branch is not a
    loophole.** A fifth of a real race's gaps are `"+1 LAP"` — from both sources
    now — which states a fact this comparison cannot express as a float;
    counting them as misses would put a floor of ~20% failure under a healthy
    round and make the threshold meaningless. They are already covered by
    `boundaries`, which scores every car on every lap regardless of what its gap
    column says, and the `+N` itself was cross-checked against OpenF1's own
    strings when it was written (2,794 of 2,809 agree, all eleven rounds).
    """
    label = "gap" if column == 2 else "int"
    hit = 0
    errors: list[float] = []
    notes: list[str] = []

    truth_rows = _truth_at_crossings(official_rows, numbers)

    # Per driver, not one shared set: an OpenF1 sample that happens to land on
    # *another* car's crossing millisecond is still fill and must still be
    # scored.
    crossing_times: dict[str, set[int]] = {}
    if fill:
        for _, number, at, _, _ in truth_rows:
            crossing_times.setdefault(number, set()).add(at)

    for lap, number, at, true_gap, true_interval in truth_rows:
        entry = drivers.get(number)
        if not entry:
            continue
        shown = _shown(
            entry, at, column, before=fill, skip=crossing_times.get(number) if fill else None
        )
        if not isinstance(shown, (int, float)) or isinstance(shown, bool):
            continue
        truth = true_gap if column == 2 else true_interval
        error = abs(shown - truth)
        errors.append(error)
        if error <= tolerance:
            hit += 1
        elif len(notes) < 3:
            notes.append(
                f"L{lap} #{number} {label} {shown:+.2f}, archive says {truth:+.2f}"
            )

    errors.sort()
    median = errors[len(errors) // 2] if errors else 0.0
    return hit, len(errors), median, notes


def check_fill(drivers, official_rows, numbers) -> tuple[int, int]:
    """`(intra-lap samples, samples in the opening two minutes)`.

    **Deliberately a count and not an agreement ratio.** Scoring these against
    the official position current at the same instant was tried and is
    structurally meaningless: `_collapse_positions` drops any sample that
    restates the position already showing, so a fill sample that *agrees* is
    never emitted, and the survivors are the disagreements by definition. That
    metric read 7% and meant nothing.

    What is worth asserting is that intra-lap movement exists at all — a payload
    with none of it is the lap-stepped tower the whole module exists to replace,
    and it would pass every other check here.
    """
    crossings = {
        (numbers.get(t["driverId"]), t["cumulative_ms"])
        for row in official_rows
        for t in row.get("timings") or []
    }
    intra = opening = 0
    for number, entry in drivers.items():
        for t_ms, _ in entry.get("positions") or []:
            if t_ms == 0 or (number, t_ms) in crossings:
                continue
            intra += 1
            if t_ms <= 120_000:
                opening += 1
    return intra, opening


def verify_round(db, year: int, round_number: int, deployed: bool) -> bool:
    results = (db.race_results.find_one({"season": year, "round": str(round_number)}) or {}).get("results") or []
    if not results:
        print(f"  round {round_number}: no race_results, skipped")
        return True

    numbers = race_timing.driver_numbers_from_results(results)
    grid = race_timing.grid_from_race_results(results)

    cached = db.official_laps.find_one(
        {"season": year, "round": str(round_number), "version": official_laps.OFFICIAL_VERSION}
    )
    official_rows = (cached or {}).get("laps") or official_laps.fetch_official_laps(year, round_number)
    if not official_rows:
        print(f"  round {round_number}: FAIL no official lap archive")
        return False

    if deployed:
        response = httpx.get(
            f"{DEPLOYED}/api/race_timing",
            params={"year": year, "round": round_number},
            timeout=180.0,
        )
        payload = response.json()
        drivers = payload.get("drivers") or {}
        lap_ms = payload.get("lap_ms") or []
        if not payload.get("synced"):
            print(f"  round {round_number}: FAIL deployed reports synced=false")
            return False
    else:
        doc = db.race_timing.find_one(
            {"season": year, "round": str(round_number), "version": race_timing.TIMING_VERSION}
        )
        if not doc:
            print(f"  round {round_number}: no cached v{race_timing.TIMING_VERSION} payload, skipped")
            return True
        drivers = doc.get("drivers") or {}
        lap_ms = doc.get("lap_ms") or []

    ok = True
    line = [f"  round {round_number:2d}:"]

    a_hit, a_tot, a_notes = check_archive(official_rows)
    ratio = a_hit / a_tot if a_tot else 0
    line.append(f"archive {ratio:.0%}")
    if ratio < MIN_ARCHIVE:
        ok = False
        line.append("FAIL")

    b_hit, b_tot, b_notes = check_boundaries(drivers, official_rows, numbers)
    ratio = b_hit / b_tot if b_tot else 0
    line.append(f"boundaries {ratio:.0%}")
    if ratio < MIN_BOUNDARY:
        ok = False
        line.append("FAIL")

    # A car that never started still holds a grid slot in the classification and
    # is deliberately not seeded — seeding it parks it on that position for the
    # whole race, duplicating every position behind it. So the check is over the
    # cars that actually took part, which is the same rule the code applies.
    started = {
        numbers.get(t["driverId"])
        for row in official_rows
        for t in row.get("timings") or []
    } - {None}
    starters = {number: slot for number, slot in grid.items() if number in started}
    non_starters = len(grid) - len(starters)

    # Every car served must be one the official record says took part.
    #
    # A car that never started still gets interval and position rows from
    # OpenF1, and one that slips through sits in the running order with no tower
    # row to draw it. The tower ranks the order to number its rows, so each
    # ghost punches a hole in the numbering: round 1 rendered
    # 1,2,3,4,6,7,8,9,11,... with Piastri and Hulkenberg occupying 5 and 10.
    # Nothing else here notices — the order is still internally consistent.
    ghosts = sorted(set(drivers) - started)
    if ghosts:
        ok = False
        line.append(f"FAIL ghosts {ghosts}")

    shown = order_at(drivers, 0)
    g_hit = sum(1 for number, slot in starters.items() if shown.get(number) == slot)
    ratio = g_hit / len(starters) if starters else 0
    line.append(f"grid {g_hit}/{len(starters)}" + (f" ({non_starters} DNS)" if non_starters else ""))
    if ratio < MIN_GRID:
        ok = False
        line.append("FAIL")

    end = max((max((s[0] for s in e.get("positions") or [0]), default=0) for e in drivers.values()), default=0)
    final = order_at(drivers, end)
    # "Lapped" is a *classified finisher*, not a retirement — 11 of round 1's 22
    # cars. Counting only "Finished" scored the round 6/6 and hid whatever the
    # other eleven were doing.
    classified = {
        str(row.get("number") or (row.get("Driver") or {}).get("permanentNumber")): int(row["position"])
        for row in results
        if str(row.get("status", "")).lower().startswith(("finished", "lapped", "+"))
        and row.get("position")
    }
    # **Informational, with no threshold, and that is a deliberate downgrade.**
    # The tower shows the order *as the flag falls*; the classification includes
    # penalties applied afterwards, which no live timing tower can know. Every
    # deviation measured across the 2026 season has the signature of exactly
    # that — one car displaced several places, everyone between it shifted by
    # one (round 9: Antonelli P9 on the road, classified P15).
    #
    # Asserting on this was scoring the stewards, not the code. The real
    # assertion is `boundaries`, which covers the final lap like any other and
    # is the thing that would actually break.
    f_hit = sum(1 for number, position in classified.items() if final.get(number) == position)
    penalised = len(classified) - f_hit
    line.append(f"flag-order {f_hit}/{len(classified)}" + (f" (+{penalised} penalised)" if penalised else ""))

    g_hit2, g_tot2, g_med, g_notes = check_timing_column(
        drivers, official_rows, numbers, 2, CROSSING_TOLERANCE
    )
    ratio = g_hit2 / g_tot2 if g_tot2 else 0
    line.append(f"gaps {ratio:.0%} (med {g_med:.2f}s)")
    if ratio < MIN_GAPS:
        ok = False
        line.append("FAIL")

    i_hit, i_tot, i_med, i_notes = check_timing_column(
        drivers, official_rows, numbers, 1, CROSSING_TOLERANCE
    )
    ratio = i_hit / i_tot if i_tot else 0
    line.append(f"intervals {ratio:.0%} (med {i_med:.2f}s)")
    if ratio < MIN_INTERVALS:
        ok = False
        line.append("FAIL")

    # The one number here that OpenF1 and the archive both contribute to, and
    # therefore the only remaining independent reading of the timing column.
    # No threshold: it measures the feed's cadence, which this repo cannot fix.
    f_hit2, f_tot2, f_med, _ = check_timing_column(
        drivers, official_rows, numbers, 2, FILL_TOLERANCE, fill=True
    )
    ratio = f_hit2 / f_tot2 if f_tot2 else 0
    line.append(f"fill-gap {ratio:.0%} (med {f_med:.2f}s)")

    intra, opening = check_fill(drivers, official_rows, numbers)
    line.append(f"intra-lap {intra} (opening 2min {opening})")
    line.append(f"laps {len(lap_ms)}")
    if intra == 0:
        ok = False
        line.append("FAIL no intra-lap movement")

    print(" ".join(line))
    for note in (a_notes + b_notes + g_notes + i_notes)[:6]:
        print(f"       - {note}")
    return ok


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--round", type=int, default=None)
    parser.add_argument("--deployed", action="store_true")
    args = parser.parse_args()

    db = _mongo()
    rounds = (
        [args.round]
        if args.round
        else sorted(int(r) for r in db.race_results.distinct("round", {"season": args.year}))
    )

    where = "deployed" if args.deployed else "cached"
    print(f"verifying {args.year} rounds {rounds} ({where}, v{race_timing.TIMING_VERSION})")
    failures = [r for r in rounds if not verify_round(db, args.year, r, args.deployed)]

    if failures:
        print(f"\nFAIL: rounds {failures}")
        return 1
    print("\nPASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
