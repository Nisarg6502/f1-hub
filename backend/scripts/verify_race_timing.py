"""Cross-validate the per-second timing track against sources it is not built from.

**Why this exists.** CP79 shipped six defects in a row that every existing check
passed: the unit suite, a real browser, and "we observe intra-lap movement" were
all satisfied by a payload whose timeline was shifted a whole lap and which
silently discarded the opening ~90 seconds of every race. The common cause is
that all of those checks compared the OpenF1 feed against itself. A feed always
agrees with itself.

So every assertion here is against something else:

- `race_results.grid`        — the official starting order (Jolpica/Ergast)
- `race_results.position`    — the official classification
- `race_laps`                — this app's own lap-indexed positions, derived from
                               the same feed by a *different* method (a join at
                               line crossings), so it disagrees where the
                               anchoring is wrong even though the data is shared
- the raw feed's own volume  — how many events we keep versus how many exist

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

from app import race_timing

OPENF1 = "https://api.openf1.org/v1"

# Round 6 (Monaco) is a known, measured outlier: its `/position` feed reports a
# finishing order that disagrees with the official classification regardless of
# anchoring — it walks Gasly P3 -> P7 in the six seconds after he takes the
# flag. Excluded from the finish threshold rather than silently lowering it for
# every round. See HANDOFF.md.
FINISH_OUTLIERS = {6}


def _mongo():
    uri = os.environ.get("MONGODB_URI")
    if not uri:
        env = Path(__file__).resolve().parents[2] / ".env"
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.lower().startswith("mongodburi="):
                uri = line.split("=", 1)[1].strip()
                break
    if not uri:
        raise SystemExit("MONGODB_URI not set and no mongodburi in .env")
    return pymongo.MongoClient(uri).get_database("f1_scratch")


def _fetch(path, session_key, timeout=90.0):
    return httpx.get(f"{OPENF1}/{path}", params={"session_key": session_key}, timeout=timeout).json()


def _official(results):
    """`(grid, classification)` keyed by car number, from `race_results`."""
    grid, finish = {}, {}
    for row in results:
        driver = row.get("Driver") or {}
        number = str(row.get("number") or driver.get("permanentNumber"))
        slot = row.get("grid")
        if slot and int(slot) > 0:
            grid[number] = int(slot)
        status = str(row.get("status") or "")
        if status.startswith("Finished") or "Lap" in status:
            finish[number] = int(row["position"])
    return grid, finish


def _order_at(drivers, t_ms):
    """The field's order at `t_ms`, carrying each driver's last sample forward."""
    order = {}
    for number, driver in drivers.items():
        seen = None
        for sample_t, position in driver["positions"]:
            if sample_t <= t_ms:
                seen = position
            else:
                break
        if seen is not None:
            order[number] = seen
    return order


def check_round(db, year, round_number, drivers, raw_positions):
    """Every cross-check for one round. Returns `(failures, lines)`."""
    results_doc = db.race_results.find_one({"season": year, "round": str(round_number)}, {"_id": 0})
    laps_doc = db.race_laps.find_one({"season": year, "round": str(round_number)}, {"_id": 0})
    results = (results_doc or {}).get("results") or []
    lap_rows = (laps_doc or {}).get("laps") or []
    grid, finish = _official(results)

    failures, lines = [], []

    # 1. The starting grid, against the official classification.
    at_zero = {
        number: driver["positions"][0][1]
        for number, driver in drivers.items()
        if driver["positions"] and driver["positions"][0][0] == 0
    }
    grid_ok = sum(1 for number, slot in grid.items() if at_zero.get(number) == slot)
    lines.append(f"  grid            {grid_ok}/{len(grid)}")
    if grid and grid_ok != len(grid):
        wrong = [
            f"{n} ours={at_zero.get(n)} official={p}"
            for n, p in sorted(grid.items(), key=lambda kv: kv[1])
            if at_zero.get(n) != p
        ][:4]
        failures.append(f"round {round_number}: grid {grid_ok}/{len(grid)} — {'; '.join(wrong)}")

    # 2. Coverage: how much of the feed survives anchoring. The only events that
    #    should be dropped are pre-race and post-race, ~1-2 per driver. Losing
    #    materially more than that means the race window itself is wrong, which
    #    is exactly the failure that hid for six iterations.
    grid_seeded = sum(
        1 for d in drivers.values() if d["positions"] and d["positions"][0][0] == 0
    )
    kept = sum(len(d["positions"]) for d in drivers.values()) - grid_seeded
    coverage = kept / len(raw_positions) if raw_positions else 0.0
    lines.append(f"  feed coverage   {kept}/{len(raw_positions)} ({coverage:.0%})")
    if coverage < 0.85:
        failures.append(
            f"round {round_number}: only {coverage:.0%} of position events anchored "
            f"({kept}/{len(raw_positions)}) — the race window is probably wrong"
        )

    # 3. The opening lap must be alive. A race whose first lap shows no position
    #    change at all is the signature of a start instant landing late: cars sat
    #    frozen on their grid slots through the whole first lap.
    opening = [
        1
        for driver in drivers.values()
        for sample_t, _ in driver["positions"]
        if 0 < sample_t <= 120_000
    ]
    lines.append(f"  opening 2 min   {len(opening)} position changes")
    if grid and len(opening) < 5:
        failures.append(
            f"round {round_number}: only {len(opening)} position changes in the first two "
            f"minutes — the field appears frozen on the grid"
        )

    # 4. Against this app's own lap-indexed positions, which reach the same facts
    #    by a different route. Compared at each lap boundary, where the two
    #    representations genuinely describe the same instant.
    by_lap = {}
    for row in lap_rows:
        by_lap.setdefault(int(row["lap_number"]), {})[str(row["driver_number"])] = row["position"]
    clock = race_timing.clock_seconds_from_race_laps(lap_rows)
    # A lap with no measured duration falls back to the race's median, exactly as
    # `watch-clock.lapDurations` does. Treating it as zero instead is not a
    # harmless simplification: round 10 has two such laps, and zeroing them put
    # every later comparison instant ~220s early, which this script then reported
    # as a 60% timeline misalignment in a payload that was fine. A verification
    # harness that models the clock differently from the clock invents failures.
    ordered = sorted(clock.values())
    median = ordered[len(ordered) // 2] if ordered else 0.0
    elapsed, agree, total = 0.0, 0, 0
    for lap in sorted(by_lap):
        elapsed += clock.get(lap, median)
        ours = _order_at(drivers, int(elapsed * 1000))
        for number, position in by_lap[lap].items():
            if number in ours:
                total += 1
                agree += ours[number] == position
    share = agree / total if total else 0.0
    lines.append(f"  vs race_laps    {agree}/{total} ({share:.0%}) at lap boundaries")
    if total and share < 0.70:
        failures.append(
            f"round {round_number}: only {share:.0%} agreement with race_laps at lap "
            f"boundaries — the timeline is probably misaligned"
        )

    # 5. The finishing order, against the official classification. Soft: post-race
    #    penalties are real classification changes a position feed cannot express.
    last = {n: d["positions"][-1][1] for n, d in drivers.items() if d["positions"]}
    finish_ok = sum(1 for number, position in finish.items() if last.get(number) == position)
    share_f = finish_ok / len(finish) if finish else 0.0
    lines.append(f"  finish          {finish_ok}/{len(finish)} ({share_f:.0%})")
    if finish and share_f < 0.6 and round_number not in FINISH_OUTLIERS:
        failures.append(
            f"round {round_number}: finishing order {finish_ok}/{len(finish)} against official"
        )

    return failures, lines


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--round", type=int, default=None)
    parser.add_argument(
        "--deployed",
        metavar="BASE_URL",
        nargs="?",
        const="https://f1-backend-2w5wydk2ca-el.a.run.app",
        help="Check the deployed endpoint's payload instead of rebuilding locally.",
    )
    args = parser.parse_args()

    db = _mongo()
    sessions = httpx.get(
        f"{OPENF1}/sessions", params={"year": args.year, "session_name": "Race"}, timeout=60
    ).json()
    by_date = {s["date_start"][:10]: s["session_key"] for s in sessions}

    rounds = [args.round] if args.round else sorted(
        int(d["round"]) for d in db.race_laps.find({"season": args.year}, {"round": 1})
    )

    all_failures = []
    for round_number in rounds:
        race = db.races.find_one({"season": args.year, "round": str(round_number)}, {"_id": 0, "date": 1})
        key = by_date.get((race or {}).get("date"))
        if key is None:
            print(f"round {round_number}: no OpenF1 session — skipped")
            continue

        raw_positions = _fetch("position", key)
        if args.deployed:
            payload = httpx.get(
                f"{args.deployed}/api/race_timing",
                params={"year": args.year, "round": round_number},
                timeout=400,
            ).json()
            drivers = payload.get("drivers") or {}
            source = "deployed"
        else:
            lap_rows = _fetch("laps", key)
            lap_doc = db.race_laps.find_one({"season": args.year, "round": str(round_number)}, {"_id": 0})
            res_doc = db.race_results.find_one({"season": args.year, "round": str(round_number)}, {"_id": 0})
            drivers = race_timing.build_timing(
                lap_rows,
                [],
                raw_positions,
                race_timing.clock_seconds_from_race_laps((lap_doc or {}).get("laps") or []),
                race_timing.grid_from_race_results((res_doc or {}).get("results") or []),
            )
            source = "local"

        print(f"round {round_number} ({source}):")
        failures, lines = check_round(db, args.year, round_number, drivers, raw_positions)
        for line in lines:
            print(line)
        all_failures.extend(failures)

    print()
    if all_failures:
        print(f"FAILED — {len(all_failures)} check(s):")
        for failure in all_failures:
            print(f"  - {failure}")
        return 1
    print(f"PASSED — every cross-check clean across {len(rounds)} round(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
