"""Back up the collections that CANNOT be rebuilt from an upstream.

Run:
    python scripts/backup_user_data.py [--out DIR]

Atlas's free M0 tier has no automated backups and no scheduled export, so the
question is not "how do we back everything up" but "what would actually be
lost". Audited against the live database:

  Re-derivable from Jolpica / FastF1 / OpenF1 by running `data_sync.py`
  (28 collections, the overwhelming bulk of the data):
      races, *_results, race_laps, race_stints, pit_stops, race_timing,
      race_replay, official_laps, weather_cache, circuit_details,
      historical_race_index, *_standings, drivers, constructors, driver_bios,
      and the champion/constructor/circuit caches.

  Reproducible but not free -- regenerating them re-spends model quota, which
  is bounded by the daily budget rather than by money:
      session_recap, strategy_commentary, driver_comparison_recap,
      circuit_character_cache, agent_answer_cache.

  Deliberately ephemeral, and now TTL'd, so backing them up would be actively
  wrong:
      checkpoints, checkpoint_writes, agent_rate_limits, watch_sessions,
      watch_join_limits, track_geometry_lock.

  IRREPLACEABLE -- written by people, recoverable from nowhere:
      agent_feedback (thumbs up/down and the comments attached to them).

That last group is the only one this script copies. It is currently empty, and
that is precisely why the script exists now: the first real feedback is the
point at which losing this database stops being a two-hour resync and starts
being a permanent loss.

Writes newline-delimited JSON, one file per collection, so a partial file is
still readable and a restore can be a plain `mongoimport`.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
from pathlib import Path

# Collections a person wrote and no upstream can return. Add to this list
# rather than switching the script to "everything" -- the value here is that
# the output stays small enough to keep in version-controlled storage or a
# mail attachment, which a full dump would not.
IRREPLACEABLE = ("agent_feedback",)

DEFAULT_DB = "f1_scratch"


def _uri() -> str:
    """Read the connection string from the environment, then from `.env`.

    `.env` is gitignored and is where this project already keeps it; the
    environment wins so a caller can point the script at a different cluster
    without editing anything.
    """
    for key in ("MONGODB_URI", "mongodburi", "mongodb_uri"):
        value = os.getenv(key)
        if value:
            return value

    env_path = Path(__file__).resolve().parents[1] / ".env"
    if env_path.exists():
        raw = env_path.read_text(encoding="utf-8", errors="replace")
        match = re.search(r"^\s*mongodburi\s*=\s*(.+)$", raw, re.M | re.I)
        if match:
            return match.group(1).strip().strip("\"'")

    raise SystemExit(
        "No MongoDB URI found. Set MONGODB_URI, or put `mongodburi=...` in .env"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parents[1] / "backups"),
        help="Directory to write into (default: ./backups)",
    )
    parser.add_argument("--db", default=os.getenv("MONGODB_DB_NAME") or DEFAULT_DB)
    args = parser.parse_args()

    try:
        from pymongo import MongoClient
    except ImportError:
        raise SystemExit("pymongo is required: pip install -r backend/requirements.txt")

    db = MongoClient(_uri(), serverSelectionTimeoutMS=20000)[args.db]

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = Path(args.out) / stamp
    out_dir.mkdir(parents=True, exist_ok=True)

    existing = set(db.list_collection_names())
    total = 0

    for name in IRREPLACEABLE:
        if name not in existing:
            # Not an error: the collection is created lazily on first write.
            print(f"  {name}: does not exist yet, nothing to back up")
            continue

        path = out_dir / f"{name}.jsonl"
        count = 0
        with path.open("w", encoding="utf-8") as handle:
            for doc in db[name].find({}):
                doc["_id"] = str(doc.get("_id"))
                handle.write(json.dumps(doc, default=str) + "\n")
                count += 1
        total += count
        print(f"  {name}: {count} document(s) -> {path}")

    if total == 0:
        # Leave nothing behind rather than a tree of empty timestamped dirs.
        try:
            next(out_dir.iterdir())
        except StopIteration:
            out_dir.rmdir()
        print("\nNothing to back up yet. Everything else in this database can be "
              "rebuilt by running backend/app/data_sync.py.")
        return 0

    print(f"\nWrote {total} document(s) to {out_dir}")
    print("Restore with: mongoimport --uri <uri> --collection <name> --file <file>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
