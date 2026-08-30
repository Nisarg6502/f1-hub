"""Approach B's first half: separate a clip's speakers acoustically.

`radio_attribution.attribute_diarized_llm` needs a transcript carrying `turns` —
text already grouped by *voice* rather than by wording. This module produces
them, so the model's only remaining decision is which voice is the driver, once
per clip, instead of one guess per line.

## Why it is built this way

**Ungated models only.** `TEAM-RADIO-PLAN.md` §5.2 originally chose a hosted
diarizing ASR (Deepgram, AssemblyAI) precisely to avoid operating an ML service.
That is no longer the cheap option: Groq's free tier began asking for credits
mid-build, and every hosted alternative is another signup and another thing that
can be revoked. The obvious self-hosted choice, `pyannote/speaker-diarization`,
is gated on Hugging Face behind an account and accepted terms — the same class of
problem. So this uses `speechbrain/spkrec-ecapa-voxceleb`, which is Apache-2.0
and ungated: it downloads and runs with no account at all.

**Segments come from the ASR, refined by word timings — not from a segmentation
model.** Whisper places boundaries at acoustic pauses, which is where speaker
changes overwhelmingly happen on a radio channel. But it does not place *enough*
of them: measured on the 2026 Dutch GP, several clips carrying an obvious
two-way exchange arrived as a single segment, and a single segment gives
diarization nothing to separate — approach B scored "single voice" on clips
approach A split correctly, for reasons that had nothing to do with the voices.

`_segments_for_diarization` therefore re-splits each ASR segment at internal word
gaps longer than `WORD_GAP_S`, using the word timings transcription already
stored. A speaker handover on a half-duplex radio channel always leaves a gap;
this finds the ones Whisper smoothed over. What still cannot be found is a
handover with no pause at all, which on this medium barely happens.

**Two speakers is the prior, not an assumption.** A large share of clips are one
voice, and forcing those into two clusters would invent an exchange that never
happened. `_split` decides between one and two by how far apart the embeddings
actually are, so a monologue stays a monologue.

## The process-isolation rule

**This module must not be imported into the same process as `faster-whisper`.**
Both drag in a numerical stack with its own OpenMP runtime, and two OpenMP
runtimes in one Windows process is the crash `openf1_sessions.py` documents —
measured, exit 139, no traceback. The job therefore refuses to run `asr` and
`diarize` in one invocation, and says why rather than segfaulting. Run them as
two commands.
"""

import io
import os

import httpx

# Bump when the embedding model, the segmentation source, or the split rule
# changes. Stored per document so a change re-runs diarization without re-running
# transcription.
DIARIZE_VERSION = 1

EMBEDDING_MODEL = "speechbrain/spkrec-ecapa-voxceleb"

# Below this, one voice. Calibrated against real clips rather than guessed: on
# the 2026 Dutch GP, clips that plainly contain an exchange measured 0.97, 0.99,
# 1.02, 1.05, 1.05 and 1.11, while ambiguous ones sat at 0.70 and 0.79. 0.85
# separates those two groups with room either side.
#
# **This is a calibration target for the eval set, not a settled value.** With
# ground truth in hand, sweep it and pick the point that maximises turn-boundary
# F1; the number here is the best available reading from nine clips.
SPLIT_DISTANCE = 0.85

# Anything shorter carries too little voiced audio for a stable embedding, and a
# noisy embedding is worse than no vote: it lands arbitrarily and drags a cluster
# with it. Short segments inherit their neighbour's speaker instead.
MIN_SEGMENT_S = 0.6

# A pause inside one ASR segment long enough to be a handover. Radio is
# half-duplex — one party releases the button before the other speaks — so a real
# turn change always leaves a gap. Below ~0.4s the gaps are breaths and
# hesitations within one person's speech.
WORD_GAP_S = 0.45

_TIMEOUT = 120.0

_model = None


class DiarizationUnavailable(RuntimeError):
    """The dependency is missing. Callers fall back to approach A."""


def _load_model():
    global _model
    if _model is not None:
        return _model
    try:
        import torch  # noqa: F401
        from speechbrain.inference.speaker import EncoderClassifier
        from speechbrain.utils.fetching import LocalStrategy
    except ImportError as error:
        raise DiarizationUnavailable(
            "speechbrain is not installed. Install the transcription extras:\n"
            "    pip install -r backend/requirements-radio.txt"
        ) from error

    _model = EncoderClassifier.from_hparams(
        source=EMBEDDING_MODEL,
        savedir=os.getenv("RADIO_DIARIZE_CACHE") or ".cache/spkrec-ecapa",
        run_opts={"device": os.getenv("RADIO_DIARIZE_DEVICE") or "cpu"},
        # COPY, not the default SYMLINK. SpeechBrain links its `savedir` at the
        # Hugging Face cache, and creating a symlink on Windows needs Developer
        # Mode or an elevated process — otherwise this dies with WinError 1314
        # ("a required privilege is not held"), which reads like a permissions
        # problem with the project rather than a link-strategy default.
        local_strategy=LocalStrategy.COPY,
    )
    return _model


def _decode(audio: bytes):
    """MP3 bytes -> a 16 kHz mono float array.

    Uses `faster_whisper.decode_audio`'s underlying PyAV rather than adding a
    second audio dependency. Imported lazily and only for the decoder, which does
    not load CTranslate2 — but see the module docstring: the *stage* is still
    kept in its own process.
    """
    from faster_whisper.audio import decode_audio

    return decode_audio(io.BytesIO(audio), sampling_rate=16000)


def _segments_for_diarization(transcript: dict) -> list[dict]:
    """ASR segments, re-split at internal pauses long enough to be a handover.

    Diarization can only assign a speaker to a span it is given, so the spans it
    is given set a ceiling on what it can find. Whisper's own segmentation puts
    that ceiling too low — see the module docstring for the measurement.

    Falls back to the raw segments when the transcript carries no word timings
    (a provider that does not return them, or a clip transcribed before they were
    requested), which is a lower ceiling rather than a failure.
    """
    segments = transcript.get("segments") or []
    words = transcript.get("words") or []
    if not words:
        return segments

    out: list[dict] = []
    for segment in segments:
        start, end = segment.get("start"), segment.get("end")
        if start is None or end is None:
            out.append(segment)
            continue
        inside = [
            word
            for word in words
            if word.get("start") is not None and start - 0.01 <= word["start"] <= end + 0.01
        ]
        if len(inside) < 2:
            out.append(segment)
            continue

        # Seeded with the FIRST word, because the pairwise walk below starts at
        # the second. Without this the opening word of every turn is silently
        # dropped — and on this material that is the word that decides the label:
        # "Lando, how are the tyres" without the vocative, or "I don't
        # understand" without the first person, is a different sentence to a
        # model reasoning about who is speaking.
        piece = {"start": start, "end": end, "text": (inside[0].get("word") or "").strip()}
        pieces = [piece]
        for previous, word in zip(inside, inside[1:]):
            gap = (word.get("start") or 0) - (previous.get("end") or 0)
            if gap >= WORD_GAP_S:
                piece["end"] = previous.get("end")
                piece = {"start": word.get("start"), "end": end, "text": ""}
                pieces.append(piece)
            piece["text"] = (piece["text"] + (word.get("word") or "")).strip()
        out.extend(p for p in pieces if (p.get("text") or "").strip())
    return out or segments


def _embed(model, waveform, segments, sample_rate=16000):
    """One embedding per usable segment; None for segments too short to trust."""
    import torch

    embeddings: list = []
    for segment in segments:
        start = max(0, int((segment.get("start") or 0) * sample_rate))
        end = min(len(waveform), int((segment.get("end") or 0) * sample_rate))
        if end - start < MIN_SEGMENT_S * sample_rate:
            embeddings.append(None)
            continue
        chunk = torch.from_numpy(waveform[start:end]).unsqueeze(0)
        with torch.no_grad():
            vector = model.encode_batch(chunk).squeeze().cpu().numpy()
        norm = float((vector**2).sum()) ** 0.5
        embeddings.append(vector / norm if norm > 0 else None)
    return embeddings


def _distance(a, b) -> float:
    return 1.0 - float((a * b).sum())


def _split(embeddings) -> list[int]:
    """Assign each segment a speaker index, deciding one cluster or two.

    Seeds the two clusters with the *furthest apart* pair of embeddings rather
    than the first two, which is what makes the result independent of which
    speaker happens to talk first. Everything else joins whichever seed it is
    closer to.

    Segments with no embedding (too short) inherit their previous neighbour, so a
    two-word acknowledgement stays attached to the exchange it belongs to instead
    of becoming a third voice.
    """
    usable = [(index, vector) for index, vector in enumerate(embeddings) if vector is not None]
    speakers = [0] * len(embeddings)
    if len(usable) < 2:
        return speakers

    far_pair, far_distance = (usable[0][0], usable[1][0]), -1.0
    for i in range(len(usable)):
        for j in range(i + 1, len(usable)):
            distance = _distance(usable[i][1], usable[j][1])
            if distance > far_distance:
                far_pair, far_distance = (usable[i][0], usable[j][0]), distance

    if far_distance < SPLIT_DISTANCE:
        return speakers  # one voice throughout

    seed_a, seed_b = embeddings[far_pair[0]], embeddings[far_pair[1]]
    previous = 0
    for index, vector in enumerate(embeddings):
        if vector is None:
            speakers[index] = previous
            continue
        speakers[index] = 0 if _distance(vector, seed_a) <= _distance(vector, seed_b) else 1
        previous = speakers[index]
    return speakers


def diarize(url: str, transcript: dict, client: httpx.Client | None = None) -> list[dict]:
    """Group a transcript's segments by voice. Returns `turns`, or [] if it cannot.

    Consecutive segments from the same speaker are merged, because a "turn" is
    what one party said before the other replied — that is the unit approach B's
    model reasons about, and leaving it as raw segments would hand the model back
    the per-line decision diarization exists to remove.
    """
    segments = _segments_for_diarization(transcript)
    if len(segments) < 2:
        return []

    model = _load_model()

    get = client.get if client is not None else httpx.get
    try:
        response = get(url, timeout=_TIMEOUT, follow_redirects=True)
    except httpx.HTTPError as error:
        raise DiarizationUnavailable(f"could not fetch audio {url}: {error}") from error
    if response.status_code != 200 or not response.content:
        raise DiarizationUnavailable(f"could not fetch audio {url}: HTTP {response.status_code}")

    waveform = _decode(response.content)
    speakers = _split(_embed(model, waveform, segments))

    turns: list[dict] = []
    for segment, speaker in zip(segments, speakers):
        text = (segment.get("text") or "").strip()
        if not text:
            continue
        if turns and turns[-1]["speaker"] == speaker:
            turns[-1]["text"] = f"{turns[-1]['text']} {text}".strip()
            turns[-1]["end"] = segment.get("end")
            continue
        turns.append(
            {
                "speaker": speaker,
                "start": segment.get("start"),
                "end": segment.get("end"),
                "text": text,
            }
        )

    # One turn means diarization found nothing to separate. Returning it would
    # make approach B look like it had done work; returning nothing lets
    # `attribute_diarized_llm` fall back to approach A honestly.
    return turns if len(turns) > 1 else []


def summarise(turns: list[dict]) -> str:
    """A one-line description for the job's log."""
    if not turns:
        return "single voice"
    voices = len({turn["speaker"] for turn in turns})
    return f"{voices} voice{'s' if voices != 1 else ''}, {len(turns)} turns"
