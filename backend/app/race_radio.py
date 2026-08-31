"""Team radio for one session, served from cache and placed on the replay clock.

Two responsibilities, kept apart because only one of them is testable without a
network:

* **Placement** (`place_clips`, `resolve_lap`) — pure arithmetic turning a
  clip's wall-clock instant into the elapsed-milliseconds position watch mode
  indexes on. No Mongo, no clock, no network.
* **Serving** (`get_race_radio`) — a Mongo read and a projection. Nothing else.

**This endpoint deliberately does not self-heal.** `race_replay` and
`race_timing` both rebuild on a cache miss, and that is right for them: a rebuild
is a few HTTP fetches against free APIs. A radio rebuild runs speech-to-text and
a language model over every clip in the session, so a self-healing endpoint means
the first person to open a cold round pays an inference bill and waits for it.
The job fills this collection (`scripts/sync_race_radio.py`); the endpoint
reports `synced: false` and the UI renders an honest empty state, the same
contract `race_replay` already uses for an unsynced round.

**`text_raw` is projected out in the query, not filtered in Python.** The raw
transcript is stored because the attribution model needs it and because a
profanity word-list change has to re-mask from something (see
`radio_profanity.MASK_VERSION`). It must never reach a client. Excluding it at
the database boundary means a future endpoint author cannot leak it by
forgetting a line — the field simply is not in the object they are holding.
"""

import bisect
import datetime

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from .db import get_db

router = APIRouter(prefix="/api")

# Bump when the served payload's shape changes. Independent of `ASR_VERSION`,
# `ATTRIB_VERSION` and `MASK_VERSION` on purpose: re-masking after a word-list
# change must not invalidate transcripts, and a prompt change must not force
# re-transcription. Each stage checks only its own key.
RADIO_VERSION = 1

_SESSION_TYPES = {"race", "sprint"}


def _parse_iso(value) -> datetime.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.datetime.fromisoformat(value)
    except ValueError:
        return None


def lap_boundaries(lap_ms: list[int] | None) -> list[int]:
    """Cumulative elapsed time at the end of each lap, from per-lap durations.

    **`lap_ms` is a list of DURATIONS, not of elapsed instants**, and reading it
    as the latter is a silent failure rather than a loud one: every value in a
    real race is smaller than almost any mid-race timestamp, so a bisect against
    the raw array returns the final lap for every clip and the payload still
    looks plausible. Measured on the 2026 Dutch GP, where a clip 3 minutes into
    the race resolved to lap 72 of 72.

    `watch-clock.ts` makes the same conversion on the frontend (`cumulativeMs`
    over `lapDurations`), which is what the array is shaped for — the replay
    clock spends `lap_ms[i]` on lap `i + 1`.

    A null duration (a lap no runner reported a time for — routinely about one
    row in seven) contributes nothing rather than breaking the sum, which makes
    the boundary after it early rather than absent.
    """
    boundaries: list[int] = []
    running = 0
    for duration in lap_ms or []:
        running += duration or 0
        boundaries.append(running)
    return boundaries


def resolve_lap(t_ms: int | None, lap_ms: list[int] | None) -> int | None:
    """Which lap was running at `t_ms`. Takes per-lap durations — see above.

    Used for the popup's `LAP 34` chip and nothing load-bearing, which is why an
    absent or empty `lap_ms` returns None rather than estimating: a chip that is
    missing reads as "we don't know", while a chip that is wrong reads as a fact.
    """
    if t_ms is None or not lap_ms:
        return None
    boundaries = lap_boundaries(lap_ms)
    index = bisect.bisect_right(boundaries, t_ms)
    if index >= len(boundaries):
        # Past the final crossing — chequered-flag radio, of which there is a
        # lot, and often the best of it. It belongs to the last lap, not to a lap
        # that never happened.
        return len(boundaries)
    return index + 1


def place_clips(
    clips: list[dict],
    race_start: str | datetime.datetime | None,
    lap_ms: list[int] | None = None,
) -> list[dict]:
    """Give each clip a `t_ms` and a best-effort `lap`.

    The conversion is the same arithmetic `race_timing._elapsed_ms` performs on
    OpenF1's `/position` and `/intervals` samples, against the same anchor, and
    that is the point: radio timestamps come from the same feed, stamped by the
    same clock, so reusing the anchor rather than deriving a second one is what
    keeps a caption and the tower underneath it describing the same instant.

    **A clip outside the race keeps a null `t_ms` rather than being dropped.**
    F1 publishes radio from the grid walk and from well after the flag, and
    `race_timing` drops such samples because a phantom position shuffle is worse
    than a missing one. A caption is not a position: the Pitwall module still
    lists these by wall-clock, and only watch mode — which indexes on `t_ms` —
    skips them. Dropping here would delete real messages from a feed whose whole
    value is completeness.

    With no anchor at all, every clip gets `t_ms: None`. That is a degraded
    session, not a broken one.
    """
    anchor = race_start if isinstance(race_start, datetime.datetime) else _parse_iso(race_start)
    placed = []
    for clip in clips:
        t_ms = None
        moment = _parse_iso(clip.get("date"))
        if anchor is not None and moment is not None:
            t_ms = round((moment - anchor).total_seconds() * 1000)
        entry = {**clip, "t_ms": t_ms}
        lap = resolve_lap(t_ms, lap_ms) if t_ms is not None and t_ms >= 0 else None
        if lap is not None:
            entry["lap"] = lap
        placed.append(entry)
    return sort_clips(placed)


def sort_clips(clips: list[dict]) -> list[dict]:
    """Ascending by `t_ms`, nulls last, wall-clock breaking ties.

    Nulls last rather than first because the consumer that cares about order is
    a timeline, and an unplaceable clip has no place on it. The secondary key
    keeps the order of unplaced clips stable and chronological instead of
    whatever the previous sort happened to leave behind.
    """
    return sorted(
        clips,
        key=lambda clip: (clip.get("t_ms") is None, clip.get("t_ms") or 0, clip.get("date") or ""),
    )


def to_wire(clip: dict) -> dict:
    """One stored clip as the frontend sees it.

    Flattens `transcript.utterances` to the two fields a caption needs and drops
    everything the client has no use for — engine name, model version, raw text.
    A smaller wire shape is the lesser reason; the greater one is that the shape
    the UI depends on stops changing every time the pipeline's internals do.
    """
    transcript = clip.get("transcript") or {}
    utterances = [
        {
            "speaker": utterance.get("speaker") or "unknown",
            "text": utterance.get("text_masked") or "",
            "start": utterance.get("start"),
            "end": utterance.get("end"),
            "confidence": utterance.get("confidence"),
        }
        for utterance in transcript.get("utterances") or []
        if utterance.get("text_masked")
    ]
    flags = clip.get("flags") or {}
    return {
        "id": clip.get("id"),
        "driver_number": str(clip.get("driver_number")),
        "date": clip.get("date"),
        "t_ms": clip.get("t_ms"),
        "lap": clip.get("lap"),
        "duration_s": clip.get("duration_s"),
        "url": clip.get("url"),
        "utterances": utterances,
        "strong_language": bool(flags.get("strong_language")),
        "notability": (clip.get("notability") or {}).get("score"),
    }


@router.get("/race_radio")
async def get_race_radio(
    year: int = Query(..., description="Season year, e.g. 2026"),
    round_number: int = Query(..., alias="round", description="Round number within the season"),
    session: str = Query("race", description="`race` or `sprint`"),
):
    """Cached team radio for one session. Serve-only — see the module docstring.

    Nothing here raises. A session that has never been processed, a session F1
    published no radio for, and a database that is briefly unavailable all answer
    with the same well-formed empty payload, because the popup's behaviour on all
    three is identical: render nothing, say nothing, do not retry.

    The two states are still distinguishable by a caller that cares:
    `synced: true, clips: []` is "F1 published none", `synced: false` is "not
    processed yet".
    """
    session_type = (session or "race").strip().lower()
    if session_type not in _SESSION_TYPES:
        session_type = "race"

    empty = {
        "year": year,
        "round": round_number,
        "session": session_type,
        "clips": [],
        "synced": False,
        "source": None,
    }

    db = get_db()
    try:
        cached = await db.race_radio.find_one(
            {
                "season": year,
                "round": str(round_number),
                "session_type": session_type,
                "version": RADIO_VERSION,
            },
            # `transcript.utterances.text_raw` is excluded at the database, not
            # in application code. See the module docstring.
            {"_id": 0, "clips.transcript.utterances.text_raw": 0},
        )
    except Exception as error:
        print(f"race_radio: cache read failed for {year} R{round_number} {session_type}: {error}")
        return JSONResponse(content=empty)

    if not cached:
        return JSONResponse(content=empty)

    clips = [to_wire(clip) for clip in sort_clips(cached.get("clips") or [])]
    return JSONResponse(content={
        "year": year,
        "round": round_number,
        "session": session_type,
        "clips": clips,
        "synced": bool(cached.get("synced", True)),
        "source": cached.get("source"),
    })
