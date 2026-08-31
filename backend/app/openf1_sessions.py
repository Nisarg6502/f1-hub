"""OpenF1 session-key lookup, in a module with no heavy imports.

`fetch_openf1_session_key` was born in `race_stints.py` and stays re-exported
from there, so every existing caller is unchanged. It lives here now for the
same reason `driver_directory.py` exists: *where* it is imported from has a
consequence its original home cannot avoid.

`race_stints` imports `fastf1`, which drags in pandas and NumPy. That is fine
for `f1-backend`, which needs FastF1 anyway. It is **not** fine for the team-radio
transcription job, and the failure mode is not a slow import — it is a hard
crash.

**Measured on Windows, 2026-08-30.** `import fastf1` followed by loading a
CTranslate2 model (which is what `faster-whisper` is) segfaults the interpreter
immediately, exit code 139, before a single clip is transcribed. NumPy and
CTranslate2 each load their own Intel OpenMP runtime, and two OpenMP runtimes in
one Windows process is the classic hard failure. Isolated by bisection: the
model loads and transcribes perfectly in a process that has not imported fastf1,
and dies in one that has.

    print("1"); import fastf1; print("2")
    from faster_whisper import WhisperModel; print("3")
    WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")
    # -> prints 1, 2, 3, then Segmentation fault

`KMP_DUPLICATE_LIB_OK=TRUE` silences it and is not a fix — Intel's own docs warn
it can crash or produce wrong results. Moving twenty lines of HTTP into a module
with no scientific stack turns the rule from a convention into a guarantee: the
job cannot import fastf1 because nothing it imports does.
"""

import httpx

OPENF1_BASE = "https://api.openf1.org/v1"


def as_int(value) -> int | None:
    """Coerce a scalar to a plain int, or None if it isn't one."""
    if value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    # NaN survives int() on some numpy types but never equals itself as a float.
    return None if number != number else number


def fetch_json(url: str, params: dict | None = None, timeout: float = 20.0):
    """GET `url` and decode JSON, or None on any failure.

    Mirrors `session_recap._fetch_json` — same upstream (OpenF1), same
    "enrichment, never a hard dependency" posture.
    """
    try:
        response = httpx.get(url, params=params, timeout=timeout)
        if response.status_code != 200:
            return None
        return response.json()
    except (httpx.HTTPError, ValueError):
        return None


def fetch_openf1_session_key(race_date: str) -> int | None:
    """OpenF1's `session_key` for the race held on `race_date` (YYYY-MM-DD).

    Sessions are matched on the `date_start` date prefix rather than by index,
    because `session_type=Race` also returns sprint races — a sprint weekend
    contributes two entries for one round, so positional indexing would drift.
    """
    if not race_date:
        return None

    sessions = fetch_json(
        f"{OPENF1_BASE}/sessions", {"year": race_date[:4], "session_type": "Race"}
    )
    if not isinstance(sessions, list):
        return None

    session = next(
        (s for s in sessions if str(s.get("date_start", "")).startswith(race_date)), None
    )
    if not session:
        return None
    return as_int(session.get("session_key"))


def fetch_openf1_sprint_key(race_date: str) -> int | None:
    """The sprint's `session_key` for the meeting whose race is on `race_date`.

    Found by matching the meeting and then its session *name*, not by assuming
    the sprint is the day before or the other `Race`-typed entry. Both of those
    have been true in most seasons and neither is guaranteed — a Saturday race,
    or a calendar change, would silently return the wrong session, and a wrong
    session key produces a full payload of somebody else's radio rather than an
    error anyone would notice.
    """
    if not race_date:
        return None

    sessions = fetch_json(f"{OPENF1_BASE}/sessions", {"year": race_date[:4]})
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
    return as_int(sprint.get("session_key")) if sprint else None
