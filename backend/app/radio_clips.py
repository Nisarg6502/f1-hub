"""Ingest: turn a session key into the list of team-radio clips it published.

This is the bottom of the radio pipeline. It fetches the index of clips, works
out how long each one is, and emits rows the rest of the pipeline
(`radio_transcribe` -> `radio_attribution` -> `radio_profanity`) works on. It
never downloads audio and never stores it — every clip stays a pointer at F1's
own CDN, which is the same posture the app already takes with race control.

Four facts drove the shape of this module, all measured against the live APIs on
2026-08-29 rather than assumed. `TEAM-RADIO-PLAN.md` §1 records them in full.

**"No radio" is a normal outcome, not an error.** F1 published nothing at all for
the first eight race and sprint sessions of 2026 — Australia through Miami — and
then resumed at the Canadian GP and has published for every round since. OpenF1
answers that with a bare `HTTP 404 {"detail": "No results found."}`. A session
with no radio must therefore cache as `synced: true, clips: []` so the endpoint
can say "F1 published none" rather than "not processed yet"; those are different
statements and only one of them invites a retry.

**A transport error is NOT the same as a 404, and conflating them writes wrong
numbers into the database.** OpenF1 rate-limits hard enough that a naive
sequential scan reports false zeros — the 2026 British GP read as zero clips on
one pass and 20 on the next. So `_fetch` distinguishes the two, and the caller is
required to distinguish them too: a 404 caches, a transport failure raises and
leaves the previous state alone.

**The origin has nothing OpenF1 lacks.** F1's own
`.../<meeting>/<session>/TeamRadio.json` carries exactly
`{"Captures": [{"Utc", "RacingNumber", "Path"}]}`. The fallback below exists to
survive OpenF1 being down or gapped, not to obtain richer data — there is no
richer data anywhere, which is why the whole feature needs an ASR step.

**Duration is free.** The MP3s are 128 kbps CBR, so `Content-Length / 16000` is
the length in seconds to within a frame, from a `HEAD`. Verified with `ffprobe`:
a 144,000-byte clip is 8.976s. That number is a triage signal (a 3s clip is very
likely "copy"; the longest clip at Zandvoort was a 192s open channel) and it sets
how long the watch-mode popup dwells, so it is worth the extra round trip.
"""

import datetime
import json
import re

import httpx

OPENF1_BASE = "https://api.openf1.org/v1"
LIVETIMING_BASE = "https://livetiming.formula1.com/static"

# 128 kbps CBR = 16,000 bytes per second. Re-verify once a season with
# `ffprobe -show_entries format=bit_rate` on any clip; if F1 changes encoder
# settings every stored duration becomes wrong at once and silently.
BYTES_PER_SECOND = 16000

# Long enough for CloudFront on a cold cache, short enough that a stalled job
# fails inside its timeout rather than at it.
_TIMEOUT = 20.0


class RadioSourceUnavailable(RuntimeError):
    """Every source failed for a reason that is not "F1 published nothing".

    Raised rather than returning empty so a caller cannot cache a transport
    failure as a session with no radio. See the module docstring.
    """


class _Result:
    """A fetch outcome that keeps "absent" and "failed" apart."""

    __slots__ = ("data", "absent")

    def __init__(self, data=None, absent: bool = False):
        self.data = data
        self.absent = absent

    @property
    def ok(self) -> bool:
        return self.data is not None


def _fetch(url: str, params: dict | None = None, client: httpx.Client | None = None) -> _Result:
    """GET and decode JSON, distinguishing 404 (absent) from failure.

    A 404 on either source means the same thing — F1 published no radio for this
    session — and is the single most common response for a 2026 session, so it
    gets its own outcome rather than being folded into "something went wrong".
    """
    try:
        get = client.get if client is not None else httpx.get
        response = get(url, params=params, timeout=_TIMEOUT)
    except httpx.HTTPError:
        return _Result()

    if response.status_code in (403, 404):
        # F1's S3/CloudFront answers a missing key with 403, not 404, because
        # listing is denied — so the two codes mean the same thing here. This is
        # not a guess: the 2026 Australian GP race session serves `Index.json`
        # with 200 and `TeamRadio.json` with 403, which is how we know the gap is
        # at F1's origin rather than in OpenF1's mirror.
        return _Result(absent=True)
    if response.status_code != 200:
        return _Result()

    try:
        # F1's static files are served with a UTF-8 BOM, which the stdlib JSON
        # decoder rejects outright. Decoding with `utf-8-sig` first costs nothing
        # and covers both sources with one path, so the fallback does not need a
        # parser of its own.
        return _Result(data=json.loads(response.content.decode("utf-8-sig")))
    except (ValueError, UnicodeDecodeError):
        return _Result()


def clip_id(session_key: int, driver_number, date: str) -> str:
    """A stable id for one clip: session, car, instant.

    Stable across re-ingests and independent of list order, so a transcript
    cached against a clip survives the session being re-fetched. Deliberately not
    the filename — the filename is F1's and could change format — and
    deliberately not an index, which would re-key every clip if F1 published one
    more.

    The instant is normalised to UTC before formatting rather than having its
    punctuation stripped, so the same clip reached through OpenF1
    (`...920000+00:00`) and through livetiming (`....92Z`) produces the same id.
    Without that the fallback path would silently re-transcribe every clip it
    touched.
    """
    moment = _parse_iso(_normalize_utc(date or ""))
    stamp = (
        moment.astimezone(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%f")[:-3]
        if moment
        else re.sub(r"[^0-9]", "", date or "")
    )
    return f"{session_key}-{driver_number}-{stamp}"


def _parse_iso(value) -> datetime.datetime | None:
    """Parse an ISO-8601 timestamp, or None. Mirrors `race_laps._parse_iso`."""
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.datetime.fromisoformat(value)
    except ValueError:
        return None


def _rows_from_openf1(payload) -> list[dict]:
    rows = []
    for row in payload or []:
        date = row.get("date")
        number = row.get("driver_number")
        url = row.get("recording_url")
        if not (date and number and url):
            continue
        rows.append({"driver_number": int(number), "date": date, "url": url})
    return rows


def _rows_from_livetiming(payload, base_url: str) -> list[dict]:
    """Map F1's own `TeamRadio.json` onto the same row shape.

    `Captures` is a list in the keyframe file but a *dict keyed by index* in the
    incremental `.jsonStream` updates. Only the keyframe is read here, but both
    shapes are handled because the difference is invisible until the one day it
    is not.
    """
    captures = (payload or {}).get("Captures")
    if isinstance(captures, dict):
        captures = list(captures.values())
    rows = []
    for capture in captures or []:
        date = capture.get("Utc")
        number = capture.get("RacingNumber")
        path = capture.get("Path")
        if not (date and number and path):
            continue
        rows.append(
            {
                "driver_number": int(number),
                # Livetiming stamps `...Z` and sometimes seven fractional
                # digits; normalise to the offset-aware form OpenF1 uses so both
                # sources produce timestamps `_parse_iso` reads identically.
                "date": _normalize_utc(date),
                "url": f"{base_url}/{path}",
            }
        )
    return rows


def _normalize_utc(value: str) -> str:
    """`2026-08-23T12:19:56.92Z` -> `2026-08-23T12:19:56.920000+00:00`."""
    text = (value or "").strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.datetime.fromisoformat(text).isoformat()
    except ValueError:
        # Python rejects more than six fractional digits; livetiming emits seven.
        trimmed = re.sub(r"(\.\d{6})\d+", r"\1", text)
        try:
            return datetime.datetime.fromisoformat(trimmed).isoformat()
        except ValueError:
            return value


def livetiming_session_base(sibling_recording_url: str, session_date: str, session_name: str) -> str | None:
    """Build a session's livetiming folder URL from a sibling session's clip URL.

    The fallback's chicken-and-egg problem: reaching F1's origin needs the
    meeting's folder name, which is an official title we cannot reliably derive
    from anything the app stores ("United States Grand Prix" is Austin, Miami and
    Las Vegas in different years). But *any* clip URL from *any* session of the
    same meeting contains it, and a meeting where every session lacks radio is
    one the fallback could not help with anyway.

        .../static/2026/2026-03-08_Australian_Grand_Prix/2026-03-06_Practice_2/TeamRadio/X.mp3
        -> .../static/2026/2026-03-08_Australian_Grand_Prix/2026-03-08_Race

    Returns None when the URL does not have the expected shape, rather than
    guessing at one.
    """
    if not sibling_recording_url or not session_date or not session_name:
        return None
    match = re.match(rf"(.*/static/\d{{4}}/[^/]+)/", sibling_recording_url)
    if not match:
        return None
    meeting_base = match.group(1)
    folder = f"{session_date}_{session_name.strip().replace(' ', '_')}"
    return f"{meeting_base}/{folder}"


def fetch_clips(
    session_key: int,
    *,
    livetiming_base: str | None = None,
    client: httpx.Client | None = None,
) -> dict:
    """Every clip F1 published for one session.

    Returns `{"clips": [...], "source": "openf1" | "livetiming" | None}`.
    `source` is None when both sources agree there is nothing — which is a real
    answer about half of 2026 and must be cached as such.

    Raises `RadioSourceUnavailable` when no source could be reached at all. That
    distinction is the whole reason `_Result` exists: caching a rate-limit as
    "this race had no radio" is a wrong fact that never self-corrects.
    """
    primary = _fetch(f"{OPENF1_BASE}/team_radio", {"session_key": session_key}, client)
    if primary.ok:
        rows = _rows_from_openf1(primary.data)
        if rows:
            return {"clips": _finalize(session_key, rows), "source": "openf1"}

    fallback_absent = False
    if livetiming_base:
        secondary = _fetch(f"{livetiming_base}/TeamRadio.json", None, client)
        fallback_absent = secondary.absent
        if secondary.ok:
            rows = _rows_from_livetiming(secondary.data, livetiming_base)
            if rows:
                return {"clips": _finalize(session_key, rows), "source": "livetiming"}

    # Nothing came back. Only call that "F1 published none" if a source said so
    # explicitly — a 404/403, or a 200 carrying an empty list. Silence is not
    # evidence of absence when the upstream rate-limits.
    explicitly_empty = primary.absent or fallback_absent or primary.ok
    if explicitly_empty:
        return {"clips": [], "source": None}

    raise RadioSourceUnavailable(
        f"team radio unreachable for session {session_key}: OpenF1 did not answer "
        "and no livetiming fallback was available"
    )


def _finalize(session_key: int, rows: list[dict]) -> list[dict]:
    """Normalise timestamps, sort by time, attach stable ids.

    Normalisation happens here rather than in either source adapter so the two
    cannot drift: the rows are sorted by comparing these strings, and
    `...56.92Z` sorts before `...56.920000+00:00` on any lexical comparison even
    though they are the same instant. One form in, one order out.

    Duration is a separate, slower step — it costs a `HEAD` per clip.
    """
    normalized = [{**row, "date": _normalize_utc(row["date"])} for row in rows]
    ordered = sorted(normalized, key=lambda row: row["date"])
    return [
        {
            "id": clip_id(session_key, row["driver_number"], row["date"]),
            "driver_number": row["driver_number"],
            "date": row["date"],
            "url": row["url"],
            "duration_s": None,
        }
        for row in ordered
    ]


def annotate_durations(clips: list[dict], client: httpx.Client | None = None) -> list[dict]:
    """Fill `duration_s` from each clip's `Content-Length`.

    One `HEAD` per clip — about 31 for a race, which is a few seconds in a job
    and never happens on a request path. A clip whose header is missing or
    unparseable keeps `duration_s: None` and is not dropped: an unmeasured clip
    is still a playable clip, and the popup falls back to a default dwell.
    """
    head = client.head if client is not None else httpx.head
    for clip in clips:
        if clip.get("duration_s") is not None:
            continue
        try:
            response = head(clip["url"], timeout=_TIMEOUT, follow_redirects=True)
            length = int(response.headers.get("Content-Length") or 0)
        except (httpx.HTTPError, TypeError, ValueError):
            continue
        if length > 0:
            clip["duration_s"] = round(length / BYTES_PER_SECOND, 1)
    return clips
