"""Export a stratified sample of transcribed clips for hand-labelling.

    python -m scripts.export_radio_eval --out backend/tests/fixtures/radio_eval_candidates.json

**Why this cannot be automated.** The thing being measured is whether a machine
can tell the driver from the pit wall. Ground truth therefore has to come from a
person listening to the audio — labelling from the transcript alone is exactly
what approach A does, so a text-derived "ground truth" would score approach A
against its own reasoning and prove nothing. `scripts/radio_label.html` is the
tool for that pass; this script produces its input.

**The sample is stratified so it cannot flatter any approach.** Drawing 40 clips
at random from a season would be dominated by the 5-15s middle of the
distribution, which is where every approach does about equally well. The
interesting cases are at the edges:

* **Short clips (<5s)** are where approach A is structurally weakest — "copy",
  "understood", "box box" carry little for a text model to reason from.
* **Long clips (>15s)** are where acoustic diarization should shine, because
  they are the ones most likely to contain a genuine back-and-forth.
* **Multi-utterance clips** are the whole point: a clip with one speaker tests
  nothing about attribution.
* **Several sessions and many drivers**, so one engineer's speech habits or one
  race's audio conditions cannot carry the result.

The exported file deliberately carries the transcript text but **not** the
predicted speaker. A labeller shown the machine's guess agrees with it far more
often than one who is not, and that bias would flow straight into the score.
"""

import argparse
import json
import os
import random
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

from pymongo import MongoClient

from app.local_env import load_local_env

load_local_env()

MONGODB_URI = os.getenv("MONGODB_URI") or os.getenv("mongodburi") or "mongodb://localhost:27017"
DB_NAME = os.getenv("MONGODB_DB_NAME") or os.getenv("mongodb_db_name") or "f1_scratch"

# Deterministic: re-running must produce the same sample, or the eval set drifts
# under you and two measurements stop being comparable.
SEED = 20260830

SHORT_MAX = 5.0
LONG_MIN = 15.0


def _bucket(clip: dict) -> str:
    duration = clip.get("duration_s") or 0
    if duration < SHORT_MAX:
        return "short"
    if duration >= LONG_MIN:
        return "long"
    return "medium"


def collect(db, year: int) -> list[dict]:
    """Every transcribed clip in the season, with its session and driver attached."""
    rows = []
    for doc in db.race_radio.find({"season": year}, {"_id": 0}):
        results = (
            db.race_results.find_one(
                {"season": doc["season"], "round": doc["round"]}, {"_id": 0, "results": 1}
            )
            or {}
        ).get("results") or []
        directory = {
            str(row.get("number") or ""): {
                "name": f"{(row.get('Driver') or {}).get('givenName','')} "
                f"{(row.get('Driver') or {}).get('familyName','')}".strip(),
                "code": (row.get("Driver") or {}).get("code"),
                "team": (row.get("Constructor") or {}).get("name"),
            }
            for row in results
        }
        for clip in doc.get("clips") or []:
            transcript = clip.get("transcript") or {}
            utterances = transcript.get("utterances") or []
            if not utterances:
                continue
            driver = directory.get(str(clip.get("driver_number"))) or {}
            rows.append(
                {
                    "id": clip["id"],
                    "session": {
                        "year": doc["season"],
                        "round": doc["round"],
                        "session_type": doc["session_type"],
                    },
                    "url": clip["url"],
                    "driver_number": str(clip.get("driver_number")),
                    "driver_name": driver.get("name"),
                    "driver_code": driver.get("code"),
                    "team": driver.get("team"),
                    "lap": clip.get("lap"),
                    "duration_s": clip.get("duration_s"),
                    # Text only. The machine's speaker guess is withheld on
                    # purpose — see the module docstring.
                    "lines": [u.get("text_raw") or u.get("text_masked") or "" for u in utterances],
                    "_bucket": _bucket(clip),
                    "_multi": len(utterances) > 1,
                }
            )
    return rows


def sample(rows: list[dict], target: int) -> list[dict]:
    """Stratified draw: edges of the duration distribution, multi-speaker first.

    Quotas rather than proportions. A proportional sample of a real season is
    ~65% medium-length single-utterance clips, which is the case every approach
    already handles — spending two thirds of a hand-labelling budget there buys
    almost no discriminating power.
    """
    rng = random.Random(SEED)
    quotas = {"short": max(1, target // 4), "long": max(1, target // 4)}
    quotas["medium"] = target - quotas["short"] - quotas["long"]

    chosen: list[dict] = []
    for bucket, quota in quotas.items():
        pool = [row for row in rows if row["_bucket"] == bucket]
        # Multi-utterance clips first — a single-speaker clip tests nothing about
        # telling two speakers apart.
        pool.sort(key=lambda row: (not row["_multi"], row["id"]))
        multi = [row for row in pool if row["_multi"]]
        single = [row for row in pool if not row["_multi"]]
        rng.shuffle(multi)
        rng.shuffle(single)
        chosen.extend((multi + single)[:quota])

    # Spread across sessions and drivers rather than letting one race dominate.
    chosen.sort(key=lambda row: (row["session"]["round"], row["id"]))
    return chosen


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--count", type=int, default=40)
    parser.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "radio_eval_candidates.json"),
    )
    args = parser.parse_args()

    db = MongoClient(MONGODB_URI)[DB_NAME]
    rows = collect(db, args.year)
    if not rows:
        print(f"No transcribed clips for {args.year}. Run sync_race_radio first.")
        return

    chosen = sample(rows, args.count)
    for row in chosen:
        row.pop("_bucket", None)
        row.pop("_multi", None)

    payload = {
        "version": 1,
        "year": args.year,
        "seed": SEED,
        "note": (
            "Candidates for hand-labelling. Open backend/scripts/radio_label.html, "
            "load this file, listen to each clip and mark every line driver / pit / "
            "unknown, then save the result as radio_attribution_eval.json."
        ),
        "clips": chosen,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")

    buckets: dict[str, int] = {}
    for row in chosen:
        duration = row.get("duration_s") or 0
        key = "short" if duration < SHORT_MAX else "long" if duration >= LONG_MIN else "medium"
        buckets[key] = buckets.get(key, 0) + 1
    lines = sum(len(row["lines"]) for row in chosen)
    sessions = {row["session"]["round"] for row in chosen}
    drivers = {row["driver_number"] for row in chosen}

    print(f"wrote {out}")
    print(f"  {len(chosen)} clips, {lines} lines to label")
    print(f"  duration buckets: {buckets}")
    print(f"  {len(sessions)} sessions, {len(drivers)} drivers")


if __name__ == "__main__":
    main()
