"""Build and cache the team-radio payload for finished sessions.

    python -m scripts.sync_race_radio                  # every finished 2026 round
    python -m scripts.sync_race_radio --round 15
    python -m scripts.sync_race_radio --round 15 --session sprint
    python -m scripts.sync_race_radio --round 15 --force
    python -m scripts.sync_race_radio --round 15 --stage ingest

**Unlike `sync_race_timing`, this is required for correctness, not just speed.**
`/api/race_timing` self-heals on a cache miss because a rebuild is a few HTTP
fetches. A radio rebuild runs speech-to-text and a language model over every clip
in the session, so `/api/race_radio` deliberately does not self-heal — a
self-healing endpoint would attach an inference bill to the first page view of a
cold round. This job is how the collection gets filled.

The stages are separable and independently versioned, which is the point of
`--stage`:

    ingest     fetch the clip index and measure durations   (free, fast)
    asr        transcribe                                   (needs GROQ_API_KEY)
    attrib     split into utterances and label speakers      (needs OLLAMA_API_KEY)
    mask       apply `***` masking to the stored raw text   (free, fast)

Re-running a later stage does not re-run an earlier one. A profanity word-list
change re-masks from stored raw text without re-transcribing; an attribution
prompt change re-labels without re-transcribing. That separation is the entire
reason the raw transcript is stored, and the reason there are four version keys
rather than one.

**Nothing is destructive.** A stage that fails for one clip leaves that clip's
previous state alone and moves to the next; a session whose upstream is
unreachable is skipped rather than cached as empty, because caching a rate-limit
as "this race had no radio" is a wrong fact that never self-corrects.
"""

import argparse
import os
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# `app.race_radio` imports motor at module scope for the request path; this job
# talks to Mongo through pymongo directly, exactly as `data_sync` does. The stub
# keeps the import cheap rather than pulling in an async driver nothing here uses.
if "motor.motor_asyncio" not in sys.modules:
    _motor = types.ModuleType("motor")
    _asyncio_mod = types.ModuleType("motor.motor_asyncio")

    class _Client:  # pragma: no cover - stub
        pass

    _asyncio_mod.AsyncIOMotorClient = _Client
    sys.modules["motor"] = _motor
    sys.modules["motor.motor_asyncio"] = _asyncio_mod

from pymongo import MongoClient

from app.driver_directory import _driver_directory
from app.race_radio import RADIO_VERSION, place_clips
from app.race_stints import fetch_openf1_session_key
from app.radio_attribution import ATTRIB_VERSION, DEFAULT_APPROACH, attribute
from app.radio_clips import (
    RadioSourceUnavailable,
    annotate_durations,
    fetch_clips,
    livetiming_session_base,
)
from app.radio_profanity import MASK_VERSION, mask_utterances
from app.radio_transcribe import (
    TranscriptionError,
    TranscriptionUnconfigured,
    build_prompt,
    transcribe,
)

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

MONGODB_URI = os.getenv("MONGODB_URI") or os.getenv("mongodburi") or "mongodb://localhost:27017"
DB_NAME = os.getenv("MONGODB_DB_NAME") or os.getenv("mongodb_db_name") or "f1_scratch"

ASR_VERSION = 1

STAGES = ("ingest", "asr", "attrib", "mask")


def _log(message: str) -> None:
    print(message, flush=True)


def _session_key_for(db, year: int, round_number: int, session_type: str) -> tuple[int | None, str | None]:
    """OpenF1's session key for a round, plus the date it was held.

    Goes through the date because OpenF1 has no notion of a championship round —
    the same indirection `race_laps` and `race_timing` already make. Sprint and
    race share `session_type=Race` upstream and are separated by date, which is
    why `fetch_openf1_session_key` matches on a date prefix rather than an index.
    """
    race = db.races.find_one({"season": year, "round": str(round_number)}, {"_id": 0, "date": 1})
    date = (race or {}).get("date")
    if not date:
        return None, None
    if session_type == "sprint":
        # The sprint is the *other* `Race`-typed session in the same meeting,
        # held the day before. Resolved by scanning rather than by arithmetic so
        # a Saturday-race weekend does not silently produce the wrong key.
        return _sprint_key_for(date), date
    return fetch_openf1_session_key(date), date


def _sprint_key_for(race_date: str) -> int | None:
    from app.race_stints import OPENF1_BASE, _fetch_json

    sessions = _fetch_json(f"{OPENF1_BASE}/sessions", {"year": race_date[:4]})
    if not isinstance(sessions, list):
        return None
    meeting = next(
        (s for s in sessions if str(s.get("date_start", "")).startswith(race_date)), None
    )
    if not meeting:
        return None
    sprint = next(
        (
            s
            for s in sessions
            if s.get("meeting_key") == meeting.get("meeting_key")
            and str(s.get("session_name", "")).lower() == "sprint"
        ),
        None,
    )
    return sprint.get("session_key") if sprint else None


def _anchor_for(db, year: int, round_number: int) -> tuple[str | None, list[int]]:
    """The lights-out instant and lap boundaries, from the cached timing payload.

    `race_timing` measures this anchor to place OpenF1's own samples; a radio
    clip is the same kind of timestamp from the same feed, so reusing it is what
    keeps a caption and the tower underneath it describing the same instant.

    A round cached before `race_start` was persisted simply has no anchor here.
    That is a degraded session, not a broken one — clips still store with
    `t_ms: None`, the Pitwall module lists them by wall-clock, and running
    `sync_race_timing` for that round fills the anchor in.
    """
    doc = db.race_timing.find_one(
        {"season": year, "round": str(round_number)},
        {"_id": 0, "race_start": 1, "lap_ms": 1},
        sort=[("version", -1)],
    )
    if not doc:
        return None, []
    return doc.get("race_start"), doc.get("lap_ms") or []


def _directory_for(db, year: int, round_number: int) -> dict:
    results = (
        db.race_results.find_one({"season": year, "round": str(round_number)}, {"_id": 0, "results": 1})
        or {}
    ).get("results") or []
    return _driver_directory(results)


def _existing(db, year: int, round_number: int, session_type: str) -> dict | None:
    return db.race_radio.find_one(
        {
            "season": year,
            "round": str(round_number),
            "session_type": session_type,
            "version": RADIO_VERSION,
        },
        {"_id": 0},
    )


def _merge_previous(clips: list[dict], previous: dict | None) -> list[dict]:
    """Carry transcripts and labels forward onto a freshly fetched clip index.

    Clip ids are stable across re-ingests (session, car, instant), so a re-fetch
    that returns the same clips must not throw away work that cost money. Only
    the derived sub-documents are carried; the index fields are taken from the
    fresh fetch, since those are the ones a re-ingest exists to correct.
    """
    if not previous:
        return clips
    by_id = {clip.get("id"): clip for clip in previous.get("clips") or []}
    merged = []
    for clip in clips:
        old = by_id.get(clip["id"])
        if not old:
            merged.append(clip)
            continue
        carried = {
            key: old[key]
            for key in ("transcript", "flags", "notability", "asr_version", "attrib_version", "mask_version")
            if key in old
        }
        # Duration is measured, not derived — keep a previous measurement rather
        # than paying for another HEAD.
        if clip.get("duration_s") is None and old.get("duration_s") is not None:
            clip["duration_s"] = old["duration_s"]
        merged.append({**clip, **carried})
    return merged


def _run_asr(clips: list[dict], directory: dict, force: bool) -> int:
    prompt = build_prompt(
        [entry.get("name") for entry in directory.values()],
        [entry.get("team") for entry in directory.values()],
    )
    done = 0
    for clip in clips:
        if not force and clip.get("transcript") and clip.get("asr_version") == ASR_VERSION:
            continue
        try:
            clip["transcript"] = transcribe(clip["url"], prompt=prompt)
            clip["asr_version"] = ASR_VERSION
            # The transcript changed, so anything derived from it is stale.
            clip.pop("attrib_version", None)
            clip.pop("mask_version", None)
            done += 1
        except TranscriptionUnconfigured as error:
            _log(f"    ! {error}")
            return done
        except TranscriptionError as error:
            _log(f"    ! clip {clip['id']}: {error}")
    return done


def _run_attrib(clips: list[dict], directory: dict, approach: str, force: bool) -> int:
    done = 0
    for clip in clips:
        transcript = clip.get("transcript")
        if not transcript:
            continue
        if not force and clip.get("attrib_version") == ATTRIB_VERSION:
            continue
        driver = directory.get(str(clip.get("driver_number"))) or {}
        try:
            utterances = attribute(
                transcript,
                approach=approach,
                driver_name=driver.get("name"),
                driver_code=driver.get("code"),
                team=driver.get("team"),
            )
        except Exception as error:  # noqa: BLE001 - one bad clip must not stop a session
            _log(f"    ! clip {clip['id']} attribution failed: {error}")
            continue
        transcript["utterances"] = utterances
        clip["attrib_version"] = ATTRIB_VERSION
        clip.pop("mask_version", None)
        done += 1
    return done


def _run_mask(clips: list[dict], force: bool) -> int:
    done = 0
    for clip in clips:
        transcript = clip.get("transcript")
        if not transcript or not transcript.get("utterances"):
            continue
        if not force and clip.get("mask_version") == MASK_VERSION:
            continue
        masked, strong = mask_utterances(transcript["utterances"])
        transcript["utterances"] = masked
        clip["flags"] = {
            **(clip.get("flags") or {}),
            "strong_language": strong,
            "overlong": bool((clip.get("duration_s") or 0) > 30),
        }
        clip["mask_version"] = MASK_VERSION
        done += 1
    return done


def sync_session(
    db,
    year: int,
    round_number: int,
    session_type: str,
    *,
    stages: tuple[str, ...],
    approach: str,
    force: bool,
) -> None:
    label = f"{year} R{round_number} {session_type}"
    session_key, race_date = _session_key_for(db, year, round_number, session_type)
    if session_key is None:
        _log(f"  {label}: no OpenF1 session key (round not held, or not synced yet) — skipped")
        return

    previous = _existing(db, year, round_number, session_type)
    directory = _directory_for(db, year, round_number)

    if "ingest" in stages:
        fallback_base = None
        if previous:
            sibling = next(
                (clip.get("url") for clip in previous.get("clips") or [] if clip.get("url")), None
            )
            if sibling:
                fallback_base = livetiming_session_base(
                    sibling, race_date, "Race" if session_type == "race" else "Sprint"
                )
        try:
            fetched = fetch_clips(session_key, livetiming_base=fallback_base)
        except RadioSourceUnavailable as error:
            _log(f"  {label}: {error} — skipped, nothing overwritten")
            return
        clips = _merge_previous(fetched["clips"], previous)
        annotate_durations(clips)
        source = fetched["source"]
    else:
        if not previous:
            _log(f"  {label}: nothing ingested yet — run with --stage ingest first")
            return
        clips = previous.get("clips") or []
        source = previous.get("source")

    if not clips:
        _log(f"  {label}: F1 published no radio for this session")
    else:
        if "asr" in stages:
            _log(f"  {label}: transcribing… ({_run_asr(clips, directory, force)} new)")
        if "attrib" in stages:
            _log(f"  {label}: attributing… ({_run_attrib(clips, directory, approach, force)} new)")
        if "mask" in stages:
            _log(f"  {label}: masking… ({_run_mask(clips, force)} new)")

    race_start, lap_ms = _anchor_for(db, year, round_number)
    if race_start is None and clips:
        _log(f"  {label}: no timing anchor — clips stored unplaced (run sync_race_timing)")
    placed = place_clips(clips, race_start, lap_ms)

    db.race_radio.update_one(
        {
            "season": year,
            "round": str(round_number),
            "session_type": session_type,
            "version": RADIO_VERSION,
        },
        {
            "$set": {
                "season": year,
                "round": str(round_number),
                "session_type": session_type,
                "version": RADIO_VERSION,
                "session_key": session_key,
                "race_start": race_start,
                "source": source,
                "synced": True,
                "clips": placed,
            }
        },
        upsert=True,
    )
    transcribed = sum(1 for clip in placed if clip.get("transcript"))
    _log(f"  {label}: stored {len(placed)} clips ({transcribed} transcribed), source={source}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, default=int(os.getenv("SYNC_YEAR") or 2026))
    parser.add_argument("--round", type=int, default=None, dest="round_number")
    parser.add_argument("--session", default="race", choices=("race", "sprint", "both"))
    parser.add_argument(
        "--stage",
        default="all",
        help="Comma-separated: " + ",".join(STAGES) + ", or `all`.",
    )
    parser.add_argument("--approach", default=DEFAULT_APPROACH)
    parser.add_argument("--force", action="store_true", help="Redo stages already at version.")
    args = parser.parse_args()

    stages = STAGES if args.stage == "all" else tuple(
        stage.strip() for stage in args.stage.split(",") if stage.strip() in STAGES
    )
    if not stages:
        parser.error(f"--stage must name at least one of {STAGES}")

    client = MongoClient(MONGODB_URI)
    db = client[DB_NAME]

    rounds = (
        [args.round_number]
        if args.round_number
        else sorted(
            int(race["round"])
            for race in db.races.find({"season": args.year}, {"_id": 0, "round": 1})
            if str(race.get("round", "")).isdigit()
        )
    )
    sessions = ("race", "sprint") if args.session == "both" else (args.session,)

    _log(f"Team radio sync — {args.year}, stages={','.join(stages)}, approach={args.approach}")
    for round_number in rounds:
        for session_type in sessions:
            try:
                sync_session(
                    db,
                    args.year,
                    round_number,
                    session_type,
                    stages=stages,
                    approach=args.approach,
                    force=args.force,
                )
            except Exception as error:  # noqa: BLE001 - one round must not stop the run
                _log(f"  {args.year} R{round_number} {session_type}: failed — {error}")

    client.close()


if __name__ == "__main__":
    main()
