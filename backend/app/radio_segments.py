"""Cutting a radio transcript into the spans everything downstream reasons about.

Lives in its own module with no heavy imports because **both attribution
approaches must be handed the same spans**, and until they were, the bake-off
between them was not a fair test.

Approach B (`radio_diarize`) re-split Whisper's segments at word gaps and
measurably gained from it. Approach A (`radio_attribution.attribute_transcript_llm`)
kept reading Whisper's raw segments. Any margin between the two therefore mixed
"one approach reasons better" with "one approach was given better input", and
`TEAM-RADIO-PLAN.md` §5.5's decision rule cannot survive that — it would have
credited diarization for a gain that came from segmentation. The fix is not to
take the re-split away from B but to give it to A, since it is pure Python over
data already stored.

`radio_diarize` cannot host this: it imports torch and speechbrain, and the job
deliberately refuses to run transcription and diarization in one process. Nothing
in here imports anything beyond the standard library, so both callers can reach
it freely.

## Why word gaps, and what they cannot find

Whisper does not place enough boundaries. Measured on the 2026 Dutch GP, clips
carrying an obvious two-way exchange arrived as a *single* segment — and a single
segment gives diarization nothing to separate, so approach B scored "single
voice" on clips approach A split correctly, for reasons that had nothing to do
with the voices.

The cause is faster-whisper's VAD defaults, which require two full seconds of
silence before it will cut. A half-duplex radio handover is nowhere near that
long. Word timings are the finer signal already sitting in the stored transcript,
so the split happens there instead.

What this still cannot find is a handover with **no** pause at all. On a channel
where only one person can transmit at a time, that barely happens.

`RADIO-DIARIZATION-RESEARCH.md` §2 argues Silero VAD at 32 ms resolution would
beat this rule outright, and that the model is already on disk inside
faster-whisper. That is the next improvement here, not a rewrite of this file.
"""

# A pause inside one ASR segment long enough to be a speaker handover. Radio is
# half-duplex — one party releases the button before the other speaks — so a real
# turn change always leaves a gap. Below ~0.4s the gaps are breaths and
# hesitations within one person's speech.
WORD_GAP_S = 0.45


def split_segments(transcript: dict) -> list[dict]:
    """ASR segments, re-split at internal pauses long enough to be a handover.

    Diarization can only assign a speaker to a span it is given, and a model can
    only label a line it was shown as separate, so the spans set a ceiling on
    what either approach can find.

    Falls back to the raw segments when the transcript carries no word timings —
    a provider that does not return them, or a clip transcribed before they were
    requested. That is a lower ceiling rather than a failure.
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
        # understand" without the first person, is a different sentence to
        # anything reasoning about who is speaking.
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
