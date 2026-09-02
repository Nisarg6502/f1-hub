"""Who said it — splitting a radio clip into utterances and labelling each one.

**No free source carries this.** OpenF1's `/team_radio` and F1's own
`TeamRadio.json` at the origin both carry exactly `{timestamp, car number,
file}`. Speaker direction is not a field that exists anywhere we can reach, so it
has to be inferred from the recording. This module is that inference.

Three approaches live here behind one interface, and they are all here on
purpose: which one is best is an empirical question that an armchair cannot
settle, so `scripts/eval_radio_attribution.py` scores them against a
hand-labelled set and `ATTRIB_VERSION` records which one produced what is stored.

* `keyword` — a weighted lexicon, no model at all. The baseline. This codebase's
  standing rule is "compute the facts in code, never trust the model to infer
  them", and a baseline is the only way to know whether the LLM is adding value
  or laundering it. If this comes within a few points of the LLM, it wins on cost
  and determinism.
* `transcript_llm` — one model call per clip reads the transcript and splits and
  labels it. Cheap, no new infrastructure. Structurally weak where the wording is
  neutral: "copy", "understood", "okay" are said by both ends of the radio.
* `diarized_llm` — an acoustically diarized transcript arrives with turns already
  separated by voice; the model then makes **one** decision per clip (which
  speaker index is the driver) instead of one per line. Turn boundaries become a
  measurement rather than a guess. Costs a second provider, and race radio —
  band-limited, clipped, engine noise over a helmet mic — is close to the worst
  case for diarization.

**Abstention is a correct answer, not a failure.** Every path can return
`unknown`, and the confidence floor turns a weak decision into one. A caption
that says "we're not sure who said this" costs nothing; a caption that
confidently puts a driver's words in his engineer's mouth undermines every other
number in the app. The floor is calibrated from the eval set — the point where
accuracy on non-abstained utterances reaches 95% — not guessed here.
"""

import json
import os
import re

import httpx

from .radio_segments import split_segments

# Bump when an approach, its prompt, or the confidence floor changes. Stored per
# document so a change re-runs attribution without re-running ASR.
#
# 2 adds the discriminators in `_SYSTEM_A` below. Measured on the 2026 Dutch GP
# (31 clips, 86 utterances), version 1 labelled 60 driver against 14 pit — a
# skew real radio does not have — and got the post-race debriefs backwards at
# maximum confidence: "Very well done. Gorgeous. Well executed." came back as
# the *driver* at 1.00.
#
# 3 makes the bake-off a fair test, and both halves were defects rather than
# choices. `keyword` never received the driver's name, so §5.3's strongest
# deterministic cue — being addressed by name means the pit wall is talking —
# was specified and never implemented; the baseline was being judged with its
# best signal switched off. And approach A read Whisper's raw segments while
# approach B read the word-gap re-split, so any margin between them mixed
# "reasons better" with "was given better input".
ATTRIB_VERSION = 3

DRIVER = "driver"
PIT = "pit"
UNKNOWN = "unknown"

APPROACHES = ("keyword", "transcript_llm", "diarized_llm")
DEFAULT_APPROACH = "transcript_llm"

# Provisional. `eval_radio_attribution.py` reports the value at which accuracy on
# non-abstained utterances hits 95%; set this from that number, and record the
# resulting abstention rate rather than hiding it.
CONFIDENCE_FLOOR = 0.6

OLLAMA_BASE = "https://ollama.com"
DEFAULT_MODEL = "gpt-oss:120b"
_TIMEOUT = 120.0


class AttributionUnconfigured(RuntimeError):
    """No model key. Callers fall back to `keyword` rather than storing nothing."""


# --------------------------------------------------------------------------
# Approach C — weighted lexicon
# --------------------------------------------------------------------------

# Positive weights point at the pit wall, negative at the driver. The asymmetry
# is real and is what makes this work at all: an engineer gives instructions and
# reports state about *the car and the race*, while a driver reports sensation
# and complains about *other people*. First person is the single strongest
# signal in either direction.
_PIT_CUES = (
    (r"\bbox\b", 3.0),
    (r"\bbox,? box\b", 4.0),
    (r"\bstay out\b", 3.0),
    (r"\bwe are checking\b", 3.0),
    (r"\bwe'?re checking\b", 3.0),
    (r"\btarget (?:plus|minus|lap)\b", 3.0),
    (r"\bdelta\b", 2.0),
    (r"\bmode\b", 2.0),
    (r"\bengine mode\b", 3.0),
    (r"\bpush now\b", 2.5),
    (r"\bgap (?:to|behind|ahead)\b", 1.5),
    (r"\byou can\b", 1.5),
    (r"\bwe need\b", 1.5),
    (r"\bconfirm\b", 1.0),
    (r"\bstrategy\b", 1.5),
    (r"\bplan [a-d]\b", 2.5),
    (r"\bwe'?ll (?:look|check|see)\b", 2.0),
    (r"\bstewards\b", 1.5),
    (r"\bsafety car (?:deployed|this lap)\b", 2.0),
    (r"\blast lap\b", 1.0),
)

_DRIVER_CUES = (
    (r"\bi'?(?:ve|m| am| have)\b", -2.5),
    (r"\bmy \w+\b", -2.0),
    (r"\bno grip\b", -3.0),
    (r"\bthe (?:tyres|tires) are\b", -2.5),
    (r"\bwhat (?:is|are|the hell)\b", -2.0),
    (r"\bhe (?:just|pushed|hit|squeezed)\b", -2.5),
    (r"\bthat'?s (?:not|so)\b", -1.5),
    (r"\bcan'?t\b", -1.5),
    (r"\blosing\b", -1.0),
    (r"\bunsafe\b", -1.5),
    (r"\bdamage\b", -1.0),
    (r"\bpuncture\b", -1.5),
    (r"\bsomething'?s\b", -2.0),
    # Swearing is overwhelmingly a driver signal, and the fact that we mask it in
    # the caption does not stop it being evidence here — this runs on raw text.
    (r"\b(?:fuck\w*|shit\w*|bollocks|cazzo|merde|joder|putain)\b", -2.5),
)

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")


# Being addressed by name means the DRIVER is the listener, so the line is the
# engineer's. `TEAM-RADIO-PLAN.md` §5.3 named this as the baseline's strongest
# deterministic cue and it was never implemented, which made the §5.5 comparison
# unfair to the one approach that costs nothing to run.
#
# Weighted above every other cue because it is close to categorical on this
# material: "Okay Carlos, you're 7 tenths quicker" and "Lando, how are the
# tyres" are the pit wall, and a driver saying his own first name to his own
# engineer is vanishingly rare.
_VOCATIVE_WEIGHT = 3.5


def _vocative(text: str, driver_name) -> float:
    """Score the driver's own forename appearing as address, not as reference.

    Only the FORENAME counts. Surnames are how drivers refer to *other* drivers —
    "Verstappen is on the softs" is a driver talking about a rival, and scoring
    that as the pit wall would invert exactly the lines the cue exists to fix.

    Requires a comma, sentence edge or clause boundary around it, for the same
    reason: "Carlos is closing" is reference, "Okay Carlos, box" is address.
    """
    first = (driver_name or "").strip().split(" ")[0].lower()
    if len(first) < 3:
        return 0.0
    name = re.escape(first)
    # A copula or auxiliary straight after the name is what turns address into
    # reference: "Carlos, box this lap" is the pit wall, "Carlos is closing on
    # us" is somebody talking *about* a Carlos. Excluding it is what stops the
    # rule inverting the very lines it exists to fix.
    #
    # A comma is the cleanest evidence of address, but it is not required at the
    # start of a line — ASR punctuation is unreliable on clipped radio, and
    # "Lando how are the tyres" with the comma dropped is a common real output.
    not_reference = r"(?!\s+(?:is|was|are|were|has|had|have|will|would|'s)\b)"
    patterns = (
        rf"^\s*{name}\b{not_reference}",   # opens the line, as address
        rf"\b{name}\s*,",                  # "Carlos, box this lap"
        rf",\s*{name}\b\s*[.,!?]?$",       # "...box this lap, Carlos"
        rf"\b(?:okay|ok|so|right|and)\s+{name}\b{not_reference}",  # "Okay Carlos, ..."
    )
    return _VOCATIVE_WEIGHT if any(re.search(p, text) for p in patterns) else 0.0


def _score(text: str, driver_name=None) -> float:
    lowered = (text or "").lower()
    total = _vocative(lowered, driver_name)
    for pattern, weight in _PIT_CUES + _DRIVER_CUES:
        if re.search(pattern, lowered):
            total += weight
    return total


def _split_sentences(transcript: dict) -> list[dict]:
    """Best-effort utterance spans from whatever timing the transcript carries.

    Prefers the ASR's own segments, which are acoustic pause boundaries and so
    are already close to turn boundaries. Falls back to punctuation over the flat
    text, which is what a provider returning no segments leaves us with.
    """
    # The SAME spans approach B gets. Reading raw ASR segments here while B read
    # the word-gap re-split made the comparison measure two things at once — see
    # `radio_segments` and ATTRIB_VERSION 3.
    segments = split_segments(transcript)
    if segments:
        return [
            {"start": segment.get("start"), "end": segment.get("end"), "text_raw": segment["text"]}
            for segment in segments
            if (segment.get("text") or "").strip()
        ]
    text = (transcript.get("text") or "").strip()
    if not text:
        return []
    return [
        {"start": None, "end": None, "text_raw": part.strip()}
        for part in _SENTENCE_SPLIT.split(text)
        if part.strip()
    ]


def attribute_keyword(transcript: dict, *, driver_name=None, **_) -> list[dict]:
    """Approach C. Deterministic, free, and the bar the models have to clear.

    `driver_name` is now actually consumed. It used to be swallowed by `**_`,
    which silently disabled §5.3's vocative rule — the baseline's single
    strongest signal — while the plan claimed it was in use.
    """
    utterances = []
    for span in _split_sentences(transcript):
        score = _score(span["text_raw"], driver_name)
        magnitude = min(abs(score) / 4.0, 1.0)
        if magnitude < 0.25:
            speaker, confidence = UNKNOWN, 0.0
        else:
            speaker = PIT if score > 0 else DRIVER
            confidence = round(magnitude, 2)
        utterances.append({**span, "speaker": speaker, "confidence": confidence})
    return utterances


# --------------------------------------------------------------------------
# Approaches A and B1 — the model calls
# --------------------------------------------------------------------------

_SYSTEM_A = """You label Formula 1 team-radio transcripts.

A clip is a recording of one car's radio channel. It may contain the driver
speaking, the race engineer on the pit wall speaking, or an exchange between
them. Split the transcript into utterances and label each one.

Labels:
- "driver": the person driving the car.
- "pit": the race engineer or anyone else on the pit wall.
- "unknown": you cannot tell.

Rules you must follow:
- "unknown" is the CORRECT answer for neutral wording. "Copy", "Understood",
  "Okay", "Yes", "Thank you" and bare acknowledgements are said by both ends of
  this radio. Do not guess between them.
- The engineer gives instructions, reports gaps and times, and addresses the
  driver by their first name. The driver speaks in the first person about the
  car and about other drivers.

Discriminators that decide most real cases:
- PRAISE AND DEBRIEF ARE THE ENGINEER. "Well done", "great drive", "very well
  executed", "that's P2", "brilliant job" are said BY the pit wall TO the
  driver, almost never the other way round. Post-race congratulation is the
  engineer's. Do not label it "driver" because it sounds pleased.
- "We" about the team's decisions, strategy or data ("we thought", "we're
  checking", "we lost time there") is the engineer. "I" about how the car feels
  ("I've got no grip", "I can't hold him") is the driver.
- The driver asks questions about strategy and gets answers containing numbers.
  A question is not automatically the driver's — the engineer asks "how are the
  tyres?" constantly.
- Being addressed by name means the DRIVER is the listener, so that line is the
  engineer's.
- Do not assume the clip opens with the driver. Many transmissions are the pit
  wall calling the driver.
- Do not invent, correct, translate or tidy the text. Reproduce each utterance
  verbatim from the transcript, including profanity and disfluency.
- Do not merge the whole clip into one utterance if two people speak.
- confidence is 0.0-1.0 and must reflect real uncertainty, not politeness.

Return ONLY this JSON object, with no prose around it:

{"utterances": [{"text": "...", "speaker": "driver|pit|unknown", "confidence": 0.0}]}

The top level must be an object with an "utterances" key, not a bare array."""

_SYSTEM_B = """You are told which speaker index in a diarized Formula 1
team-radio clip is the driver and which is the pit wall.

The audio has already been separated into speakers acoustically. You are NOT
re-segmenting it. Your only decision is which speaker index belongs to the
driver of the car.

- The engineer gives instructions, reports gaps and times, and addresses the
  driver by their first name. The driver speaks in the first person about the
  car and about other drivers.
- If the clip has only one speaker, decide whether that speaker is the driver or
  the pit wall.
- If you genuinely cannot tell, say so — every speaker may map to "unknown".
- confidence is 0.0-1.0 for the mapping as a whole.

Return ONLY this JSON object, with no prose around it:

{"speakers": [{"speaker_index": 0, "role": "driver|pit|unknown", "confidence": 0.0}]}

The top level must be an object with a "speakers" key, not a bare array."""

_SCHEMA_A = {
    "type": "object",
    "properties": {
        "utterances": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "speaker": {"type": "string", "enum": [DRIVER, PIT, UNKNOWN]},
                    "confidence": {"type": "number"},
                },
                "required": ["text", "speaker", "confidence"],
            },
        }
    },
    "required": ["utterances"],
}

_SCHEMA_B = {
    "type": "object",
    "properties": {
        "speakers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "speaker_index": {"type": "integer"},
                    "role": {"type": "string", "enum": [DRIVER, PIT, UNKNOWN]},
                    "confidence": {"type": "number"},
                },
                "required": ["speaker_index", "role", "confidence"],
            },
        }
    },
    "required": ["speakers"],
}


def _chat(system: str, user: dict, schema: dict, key: str, client: httpx.Client | None = None) -> dict:
    """One structured, non-streaming call to Ollama Cloud.

    Deliberately mirrors `session_recap._generate_recap`'s posture — same host,
    same key, near-greedy — but non-streaming, because this returns data rather
    than prose and a malformed label is a bug rather than a stylistic wobble.

    **The schema is sent but is NOT enforced, and the prompt carries the shape
    for that reason.** Measured against Ollama Cloud's `gpt-oss:120b` on
    2026-08-29: passing a JSON Schema as `format` produced valid JSON in a shape
    of the model's own invention (`{"type": "team_radio", "driver": "Brendan",
    "action": "pit_stop"}`) rather than the requested one. The schema is kept in
    the request because it costs nothing and other providers do honour it, but
    nothing may *depend* on it — hence the explicit shape in each system prompt
    and the tolerance below.

    `key` names the array this call is asking for, so the two callers get the
    same unwrapping and the same error rather than each reinventing it.
    """
    api_key = os.getenv("OLLAMA_API_KEY")
    if not api_key:
        raise AttributionUnconfigured("OLLAMA_API_KEY is not set")

    payload = {
        "model": os.getenv("OLLAMA_MODEL") or DEFAULT_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        "stream": False,
        "format": schema,
        # Near-greedy for the same reason `agent/model.py` records: this
        # narrates retrieved facts, and sampling variance is what produces
        # confident invention.
        "options": {"temperature": 0.1},
    }

    post = client.post if client is not None else httpx.post
    response = post(
        f"{OLLAMA_BASE}/api/chat",
        json=payload,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=_TIMEOUT,
    )
    if response.status_code != 200:
        raise RuntimeError(f"attribution call failed: HTTP {response.status_code}")

    body = response.json()
    # `message.thinking` is deliberately never read. Reasoning models on Ollama
    # Cloud stream raw chain-of-thought in a sibling field to `content`; it is
    # not an answer and must not be parsed as one. Same rule `agent/model.py`
    # records.
    content = ((body.get("message") or {}).get("content")) or "{}"
    try:
        parsed = json.loads(content)
    except ValueError as error:
        raise RuntimeError(f"attribution returned non-JSON: {error}") from error

    # A bare array is the model's most common deviation from the requested
    # shape, and it is trivially recoverable — accepting it is cheaper than
    # spending a retry to insist on the wrapper.
    if isinstance(parsed, list):
        return {key: parsed}
    if not isinstance(parsed, dict):
        raise RuntimeError(f"attribution returned {type(parsed).__name__}, not an object")
    if not isinstance(parsed.get(key), list):
        raise RuntimeError(f"attribution response has no `{key}` array: {content[:160]}")
    return parsed


def _facts(driver_name, driver_code, team) -> dict:
    """Identity handed over as fact, never left for the model to infer.

    `session_recap`'s post-mortem is the precedent: asked to *derive* a
    relational fact, the model confabulated a teammate pairing between two
    drivers on visibly different teams. Who is in this car is exactly that kind
    of fact, and it is one query away in the classification.
    """
    return {
        "driver_name": driver_name or None,
        "driver_code": driver_code or None,
        "team": team or None,
    }


def attribute_transcript_llm(
    transcript: dict, *, driver_name=None, driver_code=None, team=None, client=None, **_
) -> list[dict]:
    """Approach A. One call per clip: split and label from the wording."""
    text = (transcript.get("text") or "").strip()
    if not text:
        return []

    spans = _split_sentences(transcript)
    result = _chat(
        _SYSTEM_A,
        {
            **_facts(driver_name, driver_code, team),
            "transcript": text,
            "asr_segments": [span["text_raw"] for span in spans],
        },
        _SCHEMA_A,
        "utterances",
        client,
    )

    utterances = []
    for item in result.get("utterances") or []:
        content = (item.get("text") or "").strip()
        if not content:
            continue
        utterances.append(
            {
                "text_raw": content,
                "speaker": _valid_role(item.get("speaker")),
                "confidence": _valid_confidence(item.get("confidence")),
                # Timings come from the ASR's own spans where the model's text
                # matches one. The model is never asked for timestamps: it has no
                # way to know them and would produce plausible fiction.
                **_timing_for(content, spans),
            }
        )
    return _apply_floor(utterances)


def attribute_diarized_llm(
    transcript: dict, *, driver_name=None, driver_code=None, team=None, client=None, **_
) -> list[dict]:
    """Approach B1. Turns arrive pre-separated; one call maps indices to roles.

    Falls back to A when the provider returned no turns — a clip with a single
    continuous voice diarizes to nothing useful, and refusing to label it at all
    would make B look worse than it is for a reason that has nothing to do with
    its accuracy.
    """
    turns = transcript.get("turns") or []
    if not turns:
        return attribute_transcript_llm(
            transcript, driver_name=driver_name, driver_code=driver_code, team=team, client=client
        )

    result = _chat(
        _SYSTEM_B,
        {
            **_facts(driver_name, driver_code, team),
            "turns": [
                {
                    "speaker_index": turn.get("speaker"),
                    "text": (turn.get("text") or "").strip(),
                }
                for turn in turns
            ],
        },
        _SCHEMA_B,
        "speakers",
        client,
    )

    mapping = {
        entry.get("speaker_index"): (
            _valid_role(entry.get("role")),
            _valid_confidence(entry.get("confidence")),
        )
        for entry in result.get("speakers") or []
    }

    utterances = []
    for turn in turns:
        content = (turn.get("text") or "").strip()
        if not content:
            continue
        speaker, confidence = mapping.get(turn.get("speaker"), (UNKNOWN, 0.0))
        utterances.append(
            {
                "text_raw": content,
                "speaker": speaker,
                "confidence": confidence,
                "start": turn.get("start"),
                "end": turn.get("end"),
            }
        )
    return _apply_floor(utterances)


# --------------------------------------------------------------------------
# Shared
# --------------------------------------------------------------------------


def _valid_role(value) -> str:
    return value if value in (DRIVER, PIT, UNKNOWN) else UNKNOWN


def _valid_confidence(value) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


def _timing_for(text: str, spans: list[dict]) -> dict:
    """Borrow start/end from the ASR span whose text this utterance came from.

    Matched on a normalised prefix rather than equality: the model is instructed
    to reproduce text verbatim and mostly does, but a split can land mid-segment.
    No match yields no timing, which is honest — nothing downstream requires it,
    and inventing a span would put a caption's highlight in the wrong place.
    """
    needle = re.sub(r"\W+", "", text.lower())[:24]
    if not needle:
        return {}
    for span in spans:
        haystack = re.sub(r"\W+", "", (span["text_raw"] or "").lower())
        if needle and needle in haystack:
            return {"start": span.get("start"), "end": span.get("end")}
    return {}


def _apply_floor(utterances: list[dict]) -> list[dict]:
    """Demote weak decisions to `unknown` rather than shipping a coin flip."""
    for utterance in utterances:
        if utterance["speaker"] != UNKNOWN and utterance["confidence"] < CONFIDENCE_FLOOR:
            utterance["speaker"] = UNKNOWN
    return utterances


_DISPATCH = {
    "keyword": attribute_keyword,
    "transcript_llm": attribute_transcript_llm,
    "diarized_llm": attribute_diarized_llm,
}


def attribute(
    transcript: dict,
    *,
    approach: str = DEFAULT_APPROACH,
    driver_name=None,
    driver_code=None,
    team=None,
    client: httpx.Client | None = None,
) -> list[dict]:
    """Split and label one clip, by whichever approach is configured.

    Falls back to `keyword` when a model call cannot be made at all — an
    unattributed transcript is still a caption, and a session that stores nothing
    because a key was missing is a worse outcome than one that stores the
    baseline's answer.
    """
    if approach not in _DISPATCH:
        approach = DEFAULT_APPROACH
    try:
        return _DISPATCH[approach](
            transcript,
            driver_name=driver_name,
            driver_code=driver_code,
            team=team,
            client=client,
        )
    except AttributionUnconfigured:
        return attribute_keyword(transcript)
