"""Build and cache the per-second timing payload for finished rounds.

The `/api/race_timing` endpoint self-heals, so this is not required for
correctness. It exists for two reasons:

* **Validation before deploy.** `verify_race_timing` scores what is in the
  cache; without this, the only way to check a change to the derivation is to
  ship it first and measure production, which is how the last several defects
  reached users.
* **The first view of a round is otherwise slow.** Assembling one round is a
  paged archive fetch plus three OpenF1 feeds, ~25,000 rows in total.

    python -m scripts.sync_race_timing            # every finished 2026 round
    python -m scripts.sync_race_timing --round 1
    python -m scripts.sync_race_timing --force    # rebuild rounds already cached
"""

import argparse
import os
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if "motor.motor_asyncio" not in sys.modules:
    _motor = types.ModuleType("motor")
    _asyncio_mod = types.ModuleType("motor.motor_asyncio")

    class _Client:  # pragma: no cover - stub
        pass

    _asyncio_mod.AsyncIOMotorClient = _Client
    sys.modules["motor"] = _motor
    sys.modules["motor.motor_asyncio"] = _asyncio_mod

import pymongo

from app import official_laps, race_timing


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


def sync_round(db, year: int, round_number: int, force: bool) -> bool:
    key = {"season": year, "round": str(round_number), "version": race_timing.TIMING_VERSION}
    if not force and db.race_timing.find_one(key, {"_id": 1}):
        print(f"  round {round_number:2d}: already cached")
        return True

    official_key = {
        "season": year,
        "round": str(round_number),
        "version": official_laps.OFFICIAL_VERSION,
    }
    cached = db.official_laps.find_one(official_key, {"_id": 0, "laps": 1})
    official_rows = (cached or {}).get("laps")
    if not official_rows:
        official_rows = official_laps.fetch_official_laps(year, round_number)
        if official_rows:
            db.official_laps.update_one(
                official_key, {"$set": {**official_key, "laps": official_rows}}, upsert=True
            )
    if not official_rows:
        print(f"  round {round_number:2d}: no official lap archive, skipped")
        return False

    results = (db.race_results.find_one({"season": year, "round": str(round_number)}) or {}).get("results") or []
    numbers = race_timing.driver_numbers_from_results(results)
    grid = race_timing.grid_from_race_results(results)

    race_date = (db.races.find_one({"season": year, "round": str(round_number)}) or {}).get("date")
    lap_rows, interval_rows, position_rows = (
        race_timing.fetch_openf1_feeds(race_date) if race_date else ([], [], [])
    )

    payload = race_timing.build_timing(
        official_rows, numbers, lap_rows, interval_rows, position_rows, grid
    )
    drivers = payload.get("drivers") or {}
    if not drivers:
        print(f"  round {round_number:2d}: build produced nothing, skipped")
        return False

    db.race_timing.update_one(
        key,
        {"$set": {**key, "drivers": drivers, "lap_ms": payload.get("lap_ms") or []}},
        upsert=True,
    )
    samples = sum(len(e["positions"]) for e in drivers.values())
    fill = "openf1" if interval_rows or position_rows else "official only"
    print(
        f"  round {round_number:2d}: {len(drivers)} drivers, "
        f"{len(payload.get('lap_ms') or [])} laps, {samples} position samples ({fill})"
    )
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--round", type=int, default=None)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    db = _mongo()
    rounds = (
        [args.round]
        if args.round
        else sorted(int(r) for r in db.race_results.distinct("round", {"season": args.year}))
    )
    print(f"syncing {args.year} rounds {rounds} (v{race_timing.TIMING_VERSION})")
    failed = [r for r in rounds if not sync_round(db, args.year, r, args.force)]
    if failed:
        print(f"\nincomplete: {failed}")
        return 1
    print("\ndone")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
