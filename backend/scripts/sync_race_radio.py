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
    asr        transcribe                                   (local model by default)
    diarize    group segments by voice, for approach B      (optional, own process)
    attrib     split into utterances and label speakers      (needs OLLAMA_API_KEY)
    mask       apply `***` masking to the stored raw text   (free, fast)

**`asr` and `diarize` must not be run in one invocation.** Both load a numerical
stack with its own OpenMP runtime, and two in one Windows process is a hard
segfault — see `openf1_sessions.py`. The job refuses the combination rather than
crashing halfway through a round.

`asr` runs `faster-whisper` on this machine unless `RADIO_ASR_PROVIDER=groq`;
see `app/radio_transcribe.py` for why local is the default. Install its
dependency first: `pip install -r backend/requirements-radio.txt`.

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
import time
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
from app.openf1_sessions import fetch_openf1_session_key, fetch_openf1_sprint_key
from app.radio_attribution import ATTRIB_VERSION, DEFAULT_APPROACH, attribute
from app.radio_clips import (
    RadioSourceUnavailable,
    annotate_durations,
    fetch_clips,
    livetiming_session_base,
)
from app.radio_diarize import DIARIZE_VERSION, DiarizationUnavailable, diarize, summarise
from app.radio_profanity import MASK_VERSION, mask_utterances
from app.radio_transcribe import (
    TranscriptionError,
    TranscriptionUnconfigured,
    build_prompt,
    provider as asr_provider,
    transcribe,
)

from app.local_env import load_local_env

load_local_env()

MONGODB_URI = os.getenv("MONGODB_URI") or os.getenv("mongodburi") or "mongodb://localhost:27017"
DB_NAME = os.getenv("MONGODB_DB_NAME") or os.getenv("mongodb_db_name") or "f1_scratch"

ASR_VERSION = 1

STAGES = ("ingest", "asr", "diarize", "attrib", "mask")

# How often the transcription stage writes what it has. Every clip would be a
# Mongo round trip per ~17 seconds of CPU for no real gain; every eight bounds
# the loss from an interruption to a couple of minutes.
_ASR_CHECKPOINT_EVERY = 8


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
        return fetch_openf1_sprint_key(date), date
    return fetch_openf1_session_key(date), date


def _anchor_for(db, year: int, round_number: int, session_type: str) -> tuple[str | None, list[int]]:
    """The lights-out instant and lap boundaries, from the cached timing payload.

    `race_timing` measures this anchor to place OpenF1's own samples; a radio
    clip is the same kind of timestamp from the same feed, so reusing it is what
    keeps a caption and the tower underneath it describing the same instant.

    **A sprint gets no anchor, and must not borrow the race's.** `race_timing` is
    race-only — there is no sprint document — so a lookup keyed on the round
    alone silently returns the *race's* lights-out for a session held the day
    before. Measured on the 2026 Dutch GP sprint: every clip placed at about
    minus 27 hours. Watch mode never showed them (it drops negative times), but
    the Pitwall module labelled real sprint radio "Before lights out", which is
    true of the wrong session. `t_ms: None` is the correct answer here, and the
    module already renders it honestly as "Off the race clock".

    A round cached before `race_start` was persisted also has no anchor. That is
    a degraded session, not a broken one — clips still store, the Pitwall module
    lists them by wall-clock, and running `sync_race_timing` fills it in.
    """
    if session_type != "race":
        return None, []

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


def _run_asr(clips: list[dict], directory: dict, force: bool, on_progress=None) -> int:
    """Transcribe every clip that does not already have a current transcript.

    Sequential on purpose. The local model holds the CPU and loads once per
    process (~2.5 minutes cold, then seconds per clip); running clips in
    parallel would contend for the same threads and load nothing faster. A race
    is ~8.5 minutes of audio, so a session takes roughly nine minutes of compute
    after the model is warm.

    `on_progress` is called every `_ASR_CHECKPOINT_EVERY` clips so an interrupted
    run keeps the work it has already paid for. Checkpointing only once the whole
    stage finished would still throw away up to nine minutes of CPU to a Ctrl-C.
    """
    prompt = build_prompt(
        [entry.get("name") for entry in directory.values()],
        [entry.get("team") for entry in directory.values()],
    )
    pending = [
        clip
        for clip in clips
        if force or not clip.get("transcript") or clip.get("asr_version") != ASR_VERSION
    ]
    if not pending:
        return 0

    total_s = sum(clip.get("duration_s") or 0 for clip in pending)
    _log(
        f"    {len(pending)} clips, {total_s / 60:.1f} min of audio "
        f"via {asr_provider()} — the first clip also loads the model"
    )

    done = 0
    for index, clip in enumerate(pending, start=1):
        started = time.monotonic()
        try:
            clip["transcript"] = transcribe(clip["url"], prompt=prompt)
            clip["asr_version"] = ASR_VERSION
            # The transcript changed, so anything derived from it is stale.
            clip.pop("attrib_version", None)
            clip.pop("mask_version", None)
            done += 1
        except TranscriptionUnconfigured as error:
            # The provider cannot run at all — every remaining clip would fail
            # the same way. Stop the stage rather than emit 30 identical errors.
            _log(f"    ! {error}")
            return done
        except TranscriptionError as error:
            _log(f"    ! clip {clip['id']}: {error}")
            continue
        # Per clip, not per stage. Transcribing a race is ~9 minutes of compute,
        # and a stage that prints one line when it is already finished gives no
        # way to tell "working" from "hung".
        preview = (clip["transcript"].get("text") or "")[:58]
        _log(
            f"    [{index}/{len(pending)}] #{clip['driver_number']:<3} "
            f"{clip.get('duration_s') or 0:5.1f}s in {time.monotonic() - started:5.1f}s  {preview}"
        )
        if on_progress and index % _ASR_CHECKPOINT_EVERY == 0:
            on_progress()
    return done


def _run_diarize(clips: list[dict], force: bool) -> int:
    """Attach acoustic `turns` to each transcript, for approach B.

    Failure is per clip and never fatal: a clip that cannot be diarized keeps its
    transcript and is attributed by approach A, which is the honest degradation
    rather than a hole in the data.
    """
    pending = [
        clip
        for clip in clips
        if clip.get("transcript")
        and (force or clip.get("diarize_version") != DIARIZE_VERSION)
    ]
    if not pending:
        return 0
    _log(f"    {len(pending)} clips to diarize")

    done = 0
    for index, clip in enumerate(pending, start=1):
        try:
            turns = diarize(clip["url"], clip["transcript"])
        except DiarizationUnavailable as error:
            # The model or its dependency is missing — every remaining clip
            # fails identically, so stop rather than repeat the message.
            _log(f"    ! {error}")
            return done
        except Exception as error:  # noqa: BLE001 - one clip must not stop a session
            _log(f"    ! clip {clip['id']}: diarization failed: {error}")
            continue
        clip["transcript"]["turns"] = turns
        clip["diarize_version"] = DIARIZE_VERSION
        done += 1
        _log(f"    [{index}/{len(pending)}] #{clip['driver_number']:<3} {summarise(turns)}")
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


def _checkpoint(
    db,
    year: int,
    round_number: int,
    session_type: str,
    clips: list[dict],
    source: str | None,
    label: str,
    *,
    announce: bool = False,
) -> None:
    """Write what exists so far.

    Called after **every** stage rather than once at the end, and that is not
    tidiness. Transcribing a race is ~9 minutes of CPU; writing only at the end
    means a Ctrl-C, a laptop lid, or an OOM anywhere in that window throws all of
    it away and the next run starts from nothing. Each stage is independently
    version-keyed, so a partial document is a perfectly valid resume point — the
    next run picks up exactly the clips that are missing their stage.

    Placement is redone on every checkpoint because it is pure arithmetic over
    data already in hand, and doing it once at the end would leave an
    interrupted round's clips stored without a `t_ms`.
    """
    race_start, lap_ms = _anchor_for(db, year, round_number, session_type)
    if announce and race_start is None and clips:
        # Session-aware, because the two causes need different actions — and
        # telling someone to run a race-only job for a sprint sends them after a
        # fix that does not exist.
        why = (
            "sprints have no timing document, so this is expected"
            if session_type != "race"
            else "run sync_race_timing for this round"
        )
        _log(f"  {label}: no timing anchor — clips stored unplaced ({why})")
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
                "race_start": race_start,
                "source": source,
                "synced": True,
                "clips": placed,
            }
        },
        upsert=True,
    )
    if announce:
        transcribed = sum(1 for clip in placed if clip.get("transcript"))
        _log(f"  {label}: stored {len(placed)} clips ({transcribed} transcribed), source={source}")


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
        # Each header is logged BEFORE the stage runs. Interpolating the return
        # value into the message instead means the line appears only once the
        # stage is over, which for ASR is ten minutes of total silence.
        if "asr" in stages:
            _log(f"  {label}: transcribing…")
            _log(
                f"  {label}: transcribed "
                f"{_run_asr(clips, directory, force, on_progress=lambda: _checkpoint(db, year, round_number, session_type, clips, source, label))} new"
            )
            _checkpoint(db, year, round_number, session_type, clips, source, label)
        if "diarize" in stages:
            _log(f"  {label}: diarizing…")
            _log(f"  {label}: diarized {_run_diarize(clips, force)} new")
            _checkpoint(db, year, round_number, session_type, clips, source, label)
        if "attrib" in stages:
            _log(f"  {label}: attributing…")
            _log(f"  {label}: attributed {_run_attrib(clips, directory, approach, force)} new")
            _checkpoint(db, year, round_number, session_type, clips, source, label)
        if "mask" in stages:
            _log(f"  {label}: masked {_run_mask(clips, force)} new")

    _checkpoint(db, year, round_number, session_type, clips, source, label, announce=True)


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
    if "asr" in stages and "diarize" in stages:
        # Not a style preference. Transcription and diarization each load a
        # numerical stack carrying its own OpenMP runtime, and two of those in
        # one Windows process segfaults the interpreter with no traceback — the
        # failure `openf1_sessions.py` documents. Refusing here turns a mystery
        # crash halfway through a round into a sentence.
        parser.error(
            "--stage cannot combine `asr` and `diarize`: they load conflicting "
            "OpenMP runtimes and the process segfaults. Run them separately -- "
            "`--stage asr` first, then `--stage diarize`."
        )

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
