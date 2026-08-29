"""Speech-to-text for team radio clips — the ASR seam.

Everything above this module sees `transcribe(url)` and a small set of typed
errors. Swapping the provider is a change to this file alone, which is the same
argument `agent/model.py` makes for existing at all.

**Why an ASR step exists at all:** no free source labels a team-radio clip with
anything but a timestamp and a car number — not OpenF1, not F1's own
`TeamRadio.json` at the origin. Captions, `***` masking, speaker attribution and
notability ranking are all text problems, and there is no text. See
`TEAM-RADIO-PLAN.md` §1.

## Local by default, and that is the considered choice

`local` runs `faster-whisper` on this machine. `groq` calls the hosted API. The
default is local, and the reasoning is worth stating because "hosted is easier"
is usually right and is wrong here:

* **The work is tiny and finite.** A full Grand Prix is ~8.5 minutes of audio
  across ~31 clips. All of 2026's published radio — eleven sessions — is about
  40 minutes. This is a backfill, not a workload.
* **It never runs in production.** `race_radio.py` serves from Mongo and
  deliberately does not self-heal, so nothing on a request path ever transcribes.
  The model therefore never enters the deployed image, and this module's
  dependency lives in `requirements-radio.txt` rather than `requirements.txt`.
* **Free with no quota, no key, and no third party.** Every hosted option is
  free until it is not: Groq's free tier now prompts for credits, and quota
  changes are somebody else's decision to make about your backfill.
* **The quality is the same model.** Measured on a real 16-second Hamilton clip
  from the 2026 Dutch GP, `large-v3-turbo` on CPU produced a coherent transcript
  at 0.93 language confidence in 16.4s — around 1x real time on 12 threads, so a
  full race is ~9 minutes of compute. `small` was three times faster and
  meaningfully worse ("Happy to go to a new medium" became "Happy to walk what
  you need to"), which is the wrong trade for a one-time job.

`groq` stays wired up because the seam costs nothing and a machine without the
CPU budget should be able to hand the work off.

## Two details that are not obvious and cost real accuracy if missed

* **Whisper's `prompt` is capped at 224 tokens.** It is a decoder prefix, not an
  instruction — the model is being biased toward a vocabulary, not told what to
  do. Overrunning the cap silently truncates from the *front*, so a prompt that
  grows past it loses whatever was most important. `build_prompt` budgets for it
  explicitly rather than concatenating hopefully.
* **The model is loaded once per process, not once per clip.** Loading
  `large-v3-turbo` takes ~2.5 minutes cold; transcribing a clip takes seconds.
  Reloading per clip would turn a nine-minute race into a twelve-hour one.
"""

import io
import os

import httpx

GROQ_BASE = "https://api.groq.com/openai/v1"
GROQ_MODEL = "whisper-large-v3-turbo"

# The `faster-whisper` conversion of the same model. `small` and `medium` are
# valid values for a machine that cannot spare the time; see the module
# docstring for what the smaller model costs in accuracy.
LOCAL_MODEL = "large-v3-turbo"

# Generous: a cold CloudFront object plus an upload plus inference on a
# three-minute open-channel clip is not instant.
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
    """The chosen provider cannot run at all. Distinct from a per-clip failure."""


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
    becomes "for stopping", and the CC BY 4.0 corpus of ASR'd radio is full of
    real examples ("Van der Waal" for Vandoorne, "SuperSalt" for supersoft,
    "virtual safeguard" for virtual safety car). A caption that misnames a driver
    is worse than no caption, because it looks like a data error rather than an
    audio one.

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


# --------------------------------------------------------------------------
# Local provider
# --------------------------------------------------------------------------

_local_model = None
_local_model_name: str | None = None


def _load_local(model_name: str):
    """Load and memoise the local model.

    Module-level rather than per call because a cold load of `large-v3-turbo`
    costs ~2.5 minutes against seconds per clip. The first call in a process pays
    it; every subsequent clip in the session does not. `faster_whisper` is
    imported inside the function so that importing this module — which the
    FastAPI app does, transitively — never drags in CTranslate2.
    """
    global _local_model, _local_model_name
    if _local_model is not None and _local_model_name == model_name:
        return _local_model

    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise TranscriptionUnconfigured(
            "faster-whisper is not installed. Install the transcription extras:\n"
            "    pip install -r backend/requirements-radio.txt\n"
            "or set GROQ_API_KEY and RADIO_ASR_PROVIDER=groq to use the hosted API."
        ) from error

    # int8 on CPU is what makes this practical: it is roughly 4x faster than
    # float32 with no measurable accuracy cost on speech this short, and it keeps
    # the model inside ~1.5GB of RAM rather than ~6GB.
    _local_model = WhisperModel(
        model_name,
        device=os.getenv("RADIO_ASR_DEVICE") or "cpu",
        compute_type=os.getenv("RADIO_ASR_COMPUTE") or "int8",
        cpu_threads=int(os.getenv("RADIO_ASR_THREADS") or max(1, (os.cpu_count() or 4) - 2)),
    )
    _local_model_name = model_name
    return _local_model


def _transcribe_local(audio: bytes, prompt: str | None, language: str | None) -> dict:
    model_name = os.getenv("RADIO_ASR_MODEL") or LOCAL_MODEL
    model = _load_local(model_name)

    try:
        segments, info = model.transcribe(
            io.BytesIO(audio),
            language=language,
            initial_prompt=prompt or None,
            # Beam search rather than greedy. This audio is noisy enough that the
            # first token is often wrong, and the job is not latency-bound.
            beam_size=5,
            word_timestamps=True,
            # Radio is bursty and mostly silence between transmissions; VAD stops
            # the decoder hallucinating text over the gaps, which is Whisper's
            # signature failure on short clips.
            vad_filter=True,
        )
        segments = list(segments)
    except Exception as error:  # noqa: BLE001 - any decode failure is one clip's
        raise TranscriptionError(f"local transcription failed: {error}") from error

    words = []
    for segment in segments:
        for word in getattr(segment, "words", None) or []:
            words.append({"start": word.start, "end": word.end, "word": word.word})

    return {
        "engine": f"faster-whisper/{model_name}",
        "language": info.language,
        "language_probability": round(float(info.language_probability or 0), 3),
        "text": " ".join(segment.text.strip() for segment in segments).strip(),
        "segments": [
            {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
            for segment in segments
            if segment.text.strip()
        ],
        "words": words,
    }


# --------------------------------------------------------------------------
# Groq provider
# --------------------------------------------------------------------------


def _transcribe_groq(
    audio: bytes, prompt: str | None, language: str | None, client: httpx.Client | None
) -> dict:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise TranscriptionUnconfigured("GROQ_API_KEY is not set")

    model = os.getenv("GROQ_WHISPER_MODEL") or GROQ_MODEL
    data = {
        "model": model,
        "response_format": "verbose_json",
        # Both granularities, in one call. Asking for words alone silently drops
        # segments in the OpenAI-compatible schema.
        "timestamp_granularities[]": ["segment", "word"],
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
    if response.status_code in (401, 402, 403):
        # A billing wall is not a transient failure and must not be retried per
        # clip. Groq's free tier began requiring credits during this feature's
        # build; the local provider exists because of it.
        raise TranscriptionUnconfigured(
            f"Groq rejected the key (HTTP {response.status_code}) — check credits, "
            "or drop RADIO_ASR_PROVIDER to fall back to local transcription."
        )
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


# --------------------------------------------------------------------------
# The seam
# --------------------------------------------------------------------------


def provider() -> str:
    """Which backend `transcribe` will use.

    Explicit `RADIO_ASR_PROVIDER` wins. Otherwise local, because it is the one
    that always works — a hosted key that has run out of credit should not be
    the reason a backfill stops.
    """
    chosen = (os.getenv("RADIO_ASR_PROVIDER") or "").strip().lower()
    return chosen if chosen in ("local", "groq") else "local"


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
    audio = _fetch_audio(url, audio_client)
    if provider() == "groq":
        return _transcribe_groq(audio, prompt, language, client)
    return _transcribe_local(audio, prompt, language)
