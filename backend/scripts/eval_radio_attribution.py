"""Score the attribution approaches against hand-labelled ground truth.

    python -m scripts.export_radio_eval                    # 1. draw the sample
    # 2. label it: open scripts/radio_label.html, save the fixture
    python -m scripts.eval_radio_attribution               # 3. score

`TEAM-RADIO-PLAN.md` §5.5 writes the decision rule down *before* the numbers
exist, so the result cannot be rationalised afterwards. This script applies it
mechanically and prints the verdict.

**The alignment problem, and why it is handled the way it is.** The approaches do
not agree on where one utterance ends and the next begins — that is half of what
is being measured — so predictions cannot be compared to ground truth
positionally. Each ground-truth line is instead matched to the predicted line it
shares the most text with, and the comparison is made there. A ground-truth line
no prediction covers counts as a miss rather than being skipped, because
"silently produced no label for this line" is a failure, not an abstention.

**Abstention is reported next to accuracy, never folded into it.** A model that
answers `unknown` to everything has perfect accuracy on the questions it chose to
answer and is useless. The two numbers only mean something together.
"""

import argparse
import json
import os
import re
import statistics
import sys
import time
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
from app.radio_attribution import APPROACHES, DRIVER, PIT, UNKNOWN, attribute

load_local_env()

MONGODB_URI = os.getenv("MONGODB_URI") or os.getenv("mongodburi") or "mongodb://localhost:27017"
DB_NAME = os.getenv("MONGODB_DB_NAME") or os.getenv("mongodb_db_name") or "f1_scratch"

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "radio_attribution_eval.json"

# §5.5. Adopt the diarized approach only if it clears BOTH margins at a
# comparable abstention rate; otherwise the simpler approach wins, because it has
# no second provider to operate and that is worth real accuracy.
ROLE_MARGIN = 8.0
EXACT_MARGIN = 10.0
ABSTENTION_TOLERANCE = 5.0
# If the free, deterministic lexicon comes this close to the model, the model is
# not earning its cost.
BASELINE_MARGIN = 5.0


def normalise(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def overlap(a: str, b: str) -> int:
    """Longest common substring length — cheap, and enough to match a line to
    the prediction that covers it even when the split differs."""
    left, right = normalise(a), normalise(b)
    if not left or not right:
        return 0
    best = 0
    previous = [0] * (len(right) + 1)
    for i in range(1, len(left) + 1):
        current = [0] * (len(right) + 1)
        for j in range(1, len(right) + 1):
            if left[i - 1] == right[j - 1]:
                current[j] = previous[j - 1] + 1
                best = max(best, current[j])
        previous = current
    return best


def match(truth_text: str, predictions: list[dict]) -> dict | None:
    best, score = None, 0
    for prediction in predictions:
        value = overlap(truth_text, prediction.get("text_raw") or "")
        if value > score:
            best, score = prediction, value
    # A token or two of incidental overlap ("the", "okay") is not coverage.
    return best if score >= max(4, len(normalise(truth_text)) // 4) else None


def boundary_points(lines: list[str]) -> set[int]:
    """Character offsets where a split was placed, over the concatenated clip."""
    points, running = set(), 0
    for line in lines[:-1]:
        running += len(normalise(line))
        points.add(running)
    return points


def score_approach(name: str, clips: list[dict], transcripts: dict) -> dict:
    role_hits = role_total = 0
    abstained = 0
    exact_clips = 0
    scored_clips = 0
    boundary_tp = boundary_fp = boundary_fn = 0
    latencies: list[float] = []

    for clip in clips:
        transcript = transcripts.get(clip["id"])
        if not transcript:
            continue
        started = time.monotonic()
        try:
            predicted = attribute(
                transcript,
                approach=name,
                driver_name=clip.get("driver_name"),
                driver_code=clip.get("driver_code"),
                team=clip.get("team"),
            )
        except Exception as error:  # noqa: BLE001 - a failing clip is a zero, not a crash
            print(f"    ! {name} failed on {clip['id']}: {error}")
            continue
        latencies.append(time.monotonic() - started)
        scored_clips += 1

        clip_ok = True
        for truth in clip["utterances"]:
            prediction = match(truth["text"], predicted)
            guess = (prediction or {}).get("speaker", UNKNOWN)
            if guess == UNKNOWN:
                abstained += 1
                # An abstention is not a wrong answer, but a clip is only
                # "exactly right" if every line was actually decided.
                if truth["speaker"] in (DRIVER, PIT):
                    clip_ok = False
                continue
            if truth["speaker"] in (DRIVER, PIT):
                role_total += 1
                if guess == truth["speaker"]:
                    role_hits += 1
                else:
                    clip_ok = False
        if clip_ok:
            exact_clips += 1

        truth_points = boundary_points([u["text"] for u in clip["utterances"]])
        pred_points = boundary_points([p.get("text_raw") or "" for p in predicted])
        # +/- 3 characters: the same split expressed either side of a comma.
        for point in truth_points:
            if any(abs(point - other) <= 3 for other in pred_points):
                boundary_tp += 1
            else:
                boundary_fn += 1
        for point in pred_points:
            if not any(abs(point - other) <= 3 for other in truth_points):
                boundary_fp += 1

    total_lines = sum(len(clip["utterances"]) for clip in clips if transcripts.get(clip["id"]))
    precision = boundary_tp / (boundary_tp + boundary_fp) if boundary_tp + boundary_fp else 0.0
    recall = boundary_tp / (boundary_tp + boundary_fn) if boundary_tp + boundary_fn else 0.0
    return {
        "approach": name,
        "role_accuracy": 100 * role_hits / role_total if role_total else 0.0,
        "role_total": role_total,
        "abstention": 100 * abstained / total_lines if total_lines else 0.0,
        "exact_match": 100 * exact_clips / scored_clips if scored_clips else 0.0,
        "boundary_f1": 200 * precision * recall / (precision + recall) if precision + recall else 0.0,
        "latency_p50": statistics.median(latencies) if latencies else 0.0,
        "clips": scored_clips,
    }


def verdict(rows: dict[str, dict]) -> list[str]:
    a, b, c = rows.get("transcript_llm"), rows.get("diarized_llm"), rows.get("keyword")
    out: list[str] = []
    if not a:
        return ["transcript_llm did not run — no verdict."]

    if c and c["role_accuracy"] >= a["role_accuracy"] - BASELINE_MARGIN:
        out.append(
            f"SHIP `keyword`: the free lexicon is within {BASELINE_MARGIN:.0f} points of the "
            f"model ({c['role_accuracy']:.1f}% vs {a['role_accuracy']:.1f}%). The LLM call is "
            "not earning its cost."
        )
        return out

    if not b:
        out.append("SHIP `transcript_llm`: the diarized arm did not run, so there is nothing to beat it.")
        return out

    role_gain = b["role_accuracy"] - a["role_accuracy"]
    exact_gain = b["exact_match"] - a["exact_match"]
    abstention_gap = abs(b["abstention"] - a["abstention"])
    clears = (
        role_gain >= ROLE_MARGIN
        and exact_gain >= EXACT_MARGIN
        and abstention_gap <= ABSTENTION_TOLERANCE
    )
    out.append(
        f"diarized_llm vs transcript_llm: role {role_gain:+.1f} (need >= {ROLE_MARGIN:.0f}), "
        f"exact {exact_gain:+.1f} (need >= {EXACT_MARGIN:.0f}), "
        f"abstention gap {abstention_gap:.1f} (need <= {ABSTENTION_TOLERANCE:.0f})"
    )
    out.append(
        "SHIP `diarized_llm`." if clears
        else "SHIP `transcript_llm`: the diarized arm does not clear the bar, and it costs a "
             "second provider to operate."
    )
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", default=str(FIXTURE))
    parser.add_argument("--approaches", default=",".join(APPROACHES))
    args = parser.parse_args()

    path = Path(args.fixture)
    if not path.exists():
        print(f"No labelled fixture at {path}.\n")
        print("The bake-off needs ground truth a person produced by listening — labelling")
        print("from the transcript alone is what approach A already does, so it would score")
        print("that approach against its own reasoning. To produce it:\n")
        print("  python -m scripts.export_radio_eval")
        print("  open backend/scripts/radio_label.html, load the candidates, label, save")
        print(f"  save the result as {path}")
        raise SystemExit(2)

    fixture = json.loads(path.read_text(encoding="utf-8"))
    clips = fixture.get("clips") or []

    # Transcripts come from Mongo, not the fixture: every approach must score
    # against the *same* text, or a transcription difference would masquerade as
    # an attribution win.
    db = MongoClient(MONGODB_URI)[DB_NAME]
    transcripts: dict[str, dict] = {}
    for doc in db.race_radio.find({}, {"_id": 0, "clips": 1}):
        for clip in doc.get("clips") or []:
            if clip.get("transcript"):
                transcripts[clip["id"]] = clip["transcript"]

    usable = [clip for clip in clips if clip["id"] in transcripts]
    lines = sum(len(clip["utterances"]) for clip in usable)
    print(f"Fixture: {len(usable)}/{len(clips)} clips have stored transcripts, {lines} labelled lines")
    if not usable:
        raise SystemExit("No overlap between the fixture and stored transcripts.")

    names = [n.strip() for n in args.approaches.split(",") if n.strip() in APPROACHES]
    rows = {}
    for name in names:
        print(f"  scoring {name}…")
        rows[name] = score_approach(name, usable, transcripts)

    print()
    header = f"{'approach':<16}{'role acc':>10}{'(n)':>7}{'abstain':>10}{'exact':>9}{'bound F1':>10}{'p50 s':>8}"
    print(header)
    print("-" * len(header))
    for name in names:
        row = rows[name]
        print(
            f"{row['approach']:<16}{row['role_accuracy']:>9.1f}%{row['role_total']:>7}"
            f"{row['abstention']:>9.1f}%{row['exact_match']:>8.1f}%"
            f"{row['boundary_f1']:>9.1f}%{row['latency_p50']:>8.2f}"
        )
    print()
    for line in verdict(rows):
        print(line)


if __name__ == "__main__":
    main()
