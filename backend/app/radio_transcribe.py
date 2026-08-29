"""Speech-to-text for team radio clips — the ASR seam.

Everything above this module sees `transcribe(url)` and a small set of typed
errors. Swapping the provider is a change to this file alone, which is the same
argument `agent/model.py` makes for existing at all.

**Why an ASR step exists at all:** no free source labels a team-radio clip with
anything but a timestamp and a car number — not OpenF1, not F1's own
`TeamRadio.json` at the origin. Captions, `***` masking, speaker attribution and
notability ranking are all text problems, and there is no text. See
`TEAM-RADIO-PLAN.md` §1.

**Why the cost does not matter.** A full Grand Prix is about 8.5 minutes of audio
across ~31 clips — the entire radio content of a race. At Groq's
`whisper-large-v3-turbo` rate that is fractions of a cent per race, and the free
tier's 2,000 requests/day covers a whole season's backfill in a few days. This is
the rare pipeline where the right answer is "run the good model on everything,
once, and cache it forever".

**Transcribe once, ever.** Nothing here is called from a request path. The job
(`scripts/sync_race_radio.py`) fills the cache; `race_radio.py` only reads it.
That is the same discipline `session_recap` applies to generation, for the same
reason — an inference bill must never be attached to a page view.

Two details that are not obvious and cost real accuracy if missed:

* **Whisper's `prompt` is capped at 224 tokens.** It is a decoder prefix, not an
  instruction — the model is being biased toward a vocabulary, not told what to
  do. Overrunning the cap silently truncates from the *front*, so a prompt that
  grows past it loses whatever was most important. `build_prompt` budgets for it
  explicitly rather than concatenating hopefully.
* **The audio is downloaded and re-uploaded rather than passed as a URL.** F1's
  CDN sends no `Access-Control-Allow-Origin` and sits behind CloudFront; handing
  a third party a URL to fetch makes the transcription depend on their egress
  reaching F1's edge. Ten seconds of 128 kbps audio is ~160 KB — cheaper to move
  than to debug.
"""

import io
import os

import httpx

GROQ_BASE = "https://api.groq.com/openai/v1"
DEFAULT_MODEL = "whisper-large-v3-turbo"

# Generous: Groq is fast, but a cold CloudFront object plus an upload plus
# inference on a 3-minute open-channel clip is not instant.
_TIMEOUT = 120.0

# Whisper's decoder prefix limit. Not a soft guideline — tokens past it are
# dropped from the front of the prompt.
_PROMPT_TOKEN_BUDGET = 224
# Whisper's tokenizer is BPE; ~4 characters per token is the standard rough
# estimate and is deliberately conservative here, because overrunning silently
# discards the beginning of the prompt rather than erroring.
_CHARS_PER_TOKEN = 4


class TranscriptionError(RuntimeError):
    """The clip could not be transcribed. The job records it and moves on."""


class TranscriptionUnconfigured(TranscriptionError):
    """No API key. Distinct from a failure so the job can say which it was."""


# The fixed half of the decoder prefix: the jargon that is constant season to
# season and that a general-purpose model reliably mangles. "Box" as an
# instruction, "delta" as a time target and "graining" as a tyre state are all
# words Whisper knows in some other sense.
_JARGON = (
    "Box box box. Push now. Delta positive. DRS enabled. Undercut, overcut. "
    "Graining, blistering, degradation. Soft, medium, hard, intermediate, wet. "
    "Safety car, virtual safety car, red flag, blue flags. "
    "Stint, out-lap, in-lap, pit window, plank, front wing, engine mode."
)


def build_prompt(driver_names=None, team_names=None) -> str:
    """A decoder prefix biasing Whisper toward this season's vocabulary.

    Proper nouns are where noisy radio ASR fails most visibly — "Verstappen"
    becomes "for stopping", "Hulkenberg" becomes almost anything — and a caption
    that misnames a driver is worse than no caption, because it looks like a
    data error rather than an audio one.

    Names go first and jargon second: the budget truncates from the front, so
    whatever is least affordable to lose must be furthest from the cut. Names are
    also the half that changes yearly, so they are passed in rather than baked in.
    """
    names = " ".join(dict.fromkeys(n for n in (driver_names or []) if n))
    teams = " ".join(dict.fromkeys(t for t in (team_names or []) if t))
    parts = [part for part in (names, teams, _JARGON) if part]
    prompt = " ".join(parts)

    budget = _PROMPT_TOKEN_BUDGET * _CHARS_PER_TOKEN
    if len(prompt) <= budget:
        return prompt
    # Trim from the tail — the jargon — never from the names.
    return prompt[:budget].rsplit(" ", 1)[0]


def _fetch_audio(url: str, client: httpx.Client | None = None) -> bytes:
    get = client.get if client is not None else httpx.get
    try:
        response = get(url, timeout=_TIMEOUT, follow_redirects=True)
    except httpx.HTTPError as error:
        raise TranscriptionError(f"could not fetch audio {url}: {error}") from error
    if response.status_code != 200:
        raise TranscriptionError(f"could not fetch audio {url}: HTTP {response.status_code}")
    if not response.content:
        raise TranscriptionError(f"empty audio body for {url}")
    return response.content


def transcribe(
    url: str,
    *,
    prompt: str | None = None,
    language: str | None = None,
    client: httpx.Client | None = None,
    audio_client: httpx.Client | None = None,
) -> dict:
    """Transcribe one clip. Returns the stored `transcript` sub-document.

        {"engine": ..., "language": ..., "text": ..., "segments": [...], "words": [...]}

    `segments` and `words` both carry timings. Words are requested even though
    nothing reads them yet, because they are free at transcription time and are
    the only thing that could ever support audio-level bleeping — and going back
    for them later means re-transcribing everything.

    `language` is left unset by default rather than pinned to English. F1 radio
    is not monolingual: Spanish, Italian, Portuguese and Dutch all appear between
    a driver and their engineer, and forcing `en` makes Whisper *translate*
    rather than transcribe, which silently invents wording that was never said.
    """
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise TranscriptionUnconfigured(
            "GROQ_API_KEY is not set — transcription cannot run. "
            "Get a free key at https://console.groq.com and set it in the job's environment."
        )

    audio = _fetch_audio(url, audio_client)
    model = os.getenv("GROQ_WHISPER_MODEL") or DEFAULT_MODEL

    data = {
        "model": model,
        "response_format": "verbose_json",
        # Both granularities, in one call. Asking for words alone silently drops
        # segments in the OpenAI-compatible schema.
        "timestamp_granularities[]": ["segment", "word"],
        # Greedy. This is transcription, not writing; sampling variance here is
        # pure downside, the same reasoning `agent/model.py` records.
        "temperature": "0",
    }
    if prompt:
        data["prompt"] = prompt
    if language:
        data["language"] = language

    post = client.post if client is not None else httpx.post
    try:
        response = post(
            f"{GROQ_BASE}/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": ("clip.mp3", io.BytesIO(audio), "audio/mpeg")},
            data=data,
            timeout=_TIMEOUT,
        )
    except httpx.HTTPError as error:
        raise TranscriptionError(f"transcription request failed: {error}") from error

    if response.status_code == 429:
        raise TranscriptionError("transcription rate-limited (HTTP 429) — retry with backoff")
    if response.status_code != 200:
        raise TranscriptionError(
            f"transcription failed: HTTP {response.status_code} {response.text[:200]}"
        )

    try:
        payload = response.json()
    except ValueError as error:
        raise TranscriptionError(f"transcription returned non-JSON: {error}") from error

    return {
        "engine": f"groq/{model}",
        "language": payload.get("language"),
        "text": (payload.get("text") or "").strip(),
        "segments": [
            {
                "start": segment.get("start"),
                "end": segment.get("end"),
                "text": (segment.get("text") or "").strip(),
            }
            for segment in payload.get("segments") or []
        ],
        "words": [
            {"start": word.get("start"), "end": word.get("end"), "word": word.get("word")}
            for word in payload.get("words") or []
        ],
    }
