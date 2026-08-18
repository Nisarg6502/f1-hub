"""Delete cache documents left behind by superseded version constants.

`race_timing`, `race_replay` and `official_laps` all key their cached documents
on a version constant, so bumping one **retires** the old documents rather than
replacing them: the next read misses, rebuilds, and writes a new document beside
the old one. Nothing has ever deleted the old one. `HANDOFF.md` has carried
"superseded `race_replay` cache docs from older `REPLAY_VERSION`s are never
reaped" as known-and-accepted since Batch 21.

Measured 2026-08-18, before this script existed:

    race_timing    70 docs   71.1 MB   versions 1-6, only 11 docs current
    race_replay    39 docs    7.3 MB   versions 1-4, 34 docs current
    official_laps  15 docs    1.1 MB   version 1, all current
    ----------------------------------------------------------------
    database                  88.4 MB

So **59 of 70 `race_timing` documents were dead**, and that one collection was
80% of the entire database. This is not housekeeping for its own sake: the Atlas
free tier is 512 MB, `race_timing` grows ~6 MB per version bump per season, and
CP81 alone bumped it twice.

**Dry run by default.** `--apply` is required to delete anything, because the
failure mode of getting this wrong is deleting a live cache during a deploy
window, and the failure mode of getting it right slowly is a few MB.

**Refuses to reap a collection whose current version has no documents.** That is
the same guard the Batch 21 `race_laps` backfill used and for the same reason: if
the current version is empty, the likely explanation is that the constant was
just bumped and nothing has rebuilt yet — in which case the "stale" documents are
the only copy of anything, and deleting them turns a fast page into a slow one
for every round at once. Sync first, then reap.

    python -m scripts.reap_stale_caches            # report only
    python -m scripts.reap_stale_caches --apply    # actually delete
"""

import argparse
import os
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if "motor.motor_asyncio" not in sys.modules:  # the app modules import it via db.py
    _motor = types.ModuleType("motor")
    _asyncio_mod = types.ModuleType("motor.motor_asyncio")

    class _Client:  # pragma: no cover - stub
        pass

    _asyncio_mod.AsyncIOMotorClient = _Client
    sys.modules["motor"] = _motor
    sys.modules["motor.motor_asyncio"] = _asyncio_mod

import pymongo

from app import official_laps, race_replay, race_timing

# `(collection, the constant that defines "current")`. Read at runtime rather
# than copied, so this script cannot drift from the modules it is reaping for —
# which is the entire class of bug it exists to clean up after.
VERSIONED = [
    ("race_timing", lambda: race_timing.TIMING_VERSION),
    ("race_replay", lambda: race_replay.REPLAY_VERSION),
    ("official_laps", lambda: official_laps.OFFICIAL_VERSION),
]


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


def _size_mb(db, name: str) -> float:
    try:
        return db.command("collstats", name)["size"] / 1e6
    except Exception:
        return float("nan")


def reap(db, name: str, current: int, apply: bool) -> tuple[int, bool]:
    """`(documents deleted, ok)`. Deletes nothing unless `apply`."""
    counts = {
        row["_id"]: row["n"]
        for row in db[name].aggregate(
            [{"$group": {"_id": "$version", "n": {"$sum": 1}}}]
        )
    }
    live = counts.get(current, 0)
    # A version key this script does not understand (None, a string) is left
    # alone rather than guessed at: `race_laps` and `session_recap` are
    # unversioned by design, and a collection that grew a different scheme is a
    # thing to read before deleting from.
    stale = {v: n for v, n in counts.items() if isinstance(v, int) and v != current}

    if not stale:
        print(f"  {name:16} v{current}: {live} current, nothing stale")
        return 0, True

    doomed = sum(stale.values())
    detail = ", ".join(f"v{v}={n}" for v, n in sorted(stale.items()))

    if live == 0:
        print(
            f"  {name:16} v{current}: REFUSED — 0 documents at the current version, "
            f"{doomed} stale ({detail}). Sync before reaping; see this module's docstring."
        )
        return 0, False

    if not apply:
        print(
            f"  {name:16} v{current}: {live} current, would delete {doomed} ({detail}) "
            f"-> {_size_mb(db, name):.1f} MB total today"
        )
        return doomed, True

    before = _size_mb(db, name)
    result = db[name].delete_many({"version": {"$in": sorted(stale)}})
    after = _size_mb(db, name)
    print(
        f"  {name:16} v{current}: {live} current, deleted {result.deleted_count} "
        f"({detail}) : {before:.1f} MB -> {after:.1f} MB"
    )
    return result.deleted_count, True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply",
        action="store_true",
        help="actually delete; without it this only reports",
    )
    args = parser.parse_args()

    db = _mongo()
    before = db.command("dbstats")["dataSize"] / 1e6
    print(f"database {before:.1f} MB ({'APPLYING' if args.apply else 'dry run'})")

    total = 0
    refused = []
    for name, version_of in VERSIONED:
        count, ok = reap(db, name, version_of(), args.apply)
        total += count
        if not ok:
            refused.append(name)

    if args.apply:
        after = db.command("dbstats")["dataSize"] / 1e6
        print(f"\ndeleted {total} documents; database {before:.1f} MB -> {after:.1f} MB")
    else:
        print(f"\n{total} documents would be deleted; re-run with --apply")

    if refused:
        print(f"REFUSED (sync these first): {refused}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
