"""Profanity masking for team-radio captions.

Team radio arrives as raw pit-wall audio, not the broadcast mix. F1TV and the
world feed bleep swearing before it airs; that bleep does not exist in the files
`livetiming.formula1.com` publishes. So anything this app renders as text has to
do its own masking, and a driver who has just been squeezed into the wall is not
choosing his words for a general audience.

**Only the caption is masked. The audio is served untouched**, straight from
F1's CDN, and is tap-to-play rather than autoplay — see `TEAM-RADIO-PLAN.md` §6
for why editing the MP3 was rejected for v1 (the moment the bytes change we can
no longer hotlink F1's copy, and we inherit hosting plus ownership of a modified
derivative).

Three properties are load-bearing:

* **Whole-word matching only.** The Scunthorpe problem is not hypothetical here
  — "assist", "class", "pass" and "analysis" all appear in real race radio, and
  a substring matcher turns pit-wall instructions into asterisks. Every pattern
  is anchored with `\\b` on both sides, and `test_radio_profanity.py` asserts the
  specific words that have bitten other people's filters.
* **The replacement is exactly `***`**, three asterisks, regardless of how long
  the word was. Length-preserving masks (`f***`) leak the word they hide, which
  defeats the point.
* **Mild words are deliberately not masked.** "damn", "hell", "bloody" and
  "crap" are not bleeped by the broadcast either, and masking them makes ordinary
  frustration read as something worse than it was. This is a judgement about
  matching the broadcast's register, not an oversight — add them to `_STRONG` if
  that judgement changes.

The word list is a module constant with an override hook rather than a hard
literal, because word lists are never finished. `MASK_VERSION` is stored on each
cached document so a list change re-masks the stored raw transcripts instead of
forcing re-transcription — which is the entire reason the raw text is kept at
all (it is never served; see `race_radio.py`'s projection).
"""

import re

# Bump when the word list or the masking rule changes. Cached documents carry
# their own `mask_version`, so a bump re-masks from stored raw text without
# re-running ASR or attribution.
MASK_VERSION = 1

MASK = "***"

# Stems, matched whole-word with an optional inflection. Kept as stems rather
# than a flat word list so "fucking"/"fucked"/"fuckers" do not each need an
# entry — and so a missed inflection is a one-line fix rather than three.
#
# Non-English entries are here because F1 radio is not monolingual: Spanish,
# Italian, Portuguese and French are all routinely spoken between a driver and
# an engineer, and Whisper transcribes them verbatim.
_STRONG = (
    # English
    "fuck",
    "shit",
    "bullshit",
    "cunt",
    "bastard",
    "bollock",
    "bollocks",
    "wanker",
    "wank",
    "twat",
    "prick",
    "arsehole",
    "asshole",
    "arse",
    "ass",
    "dickhead",
    "piss",
    "bitch",
    "motherfucker",
    "goddamn",
    # Spanish / Portuguese
    "joder",
    "puta",
    "mierda",
    "merda",
    "coño",
    "cabron",
    "cabrón",
    # Italian
    "cazzo",
    "merd",
    "stronzo",
    "vaffanculo",
    # French
    "putain",
    "merde",
    "connard",
    # German / Dutch
    "scheisse",
    "scheiße",
    "kut",
    "godverdomme",
)

# Words that must never be masked even though a looser matcher would hit them.
# `\b` anchoring already prevents every one of these, so this set exists as a
# regression tripwire rather than as logic: if someone later relaxes the
# anchoring, the tests that assert these survive will fail immediately.
_ALLOW = frozenset(
    {
        "scunthorpe",
        "assist",
        "assists",
        "assess",
        "class",
        "pass",
        "passed",
        "grass",
        "bass",
        "mass",
        "glass",
        "brass",
        "compass",
        "analysis",
        "cockpit",
        "assembly",
        "massive",
        "title",
        "shifting",
        "assumed",
    }
)

# Inflections a stem can carry. Deliberately narrow: an over-broad suffix class
# reintroduces the substring problem it was meant to avoid.
_SUFFIX = r"(?:ing|ings|ed|er|ers|es|s|y|ies|head|heads|face|faces)?"

_STRONG_RE = re.compile(
    r"\b(?:" + "|".join(sorted(map(re.escape, _STRONG), key=len, reverse=True)) + r")" + _SUFFIX + r"\b",
    re.IGNORECASE | re.UNICODE,
)

# ASR output censors itself sometimes — Whisper will happily emit "f***ing" or
# "sh*t" when the acoustic model has learned the convention from its training
# data. Those tokens are already profanity by any reading, and normalising them
# to the same `***` keeps one masked form on screen instead of three.
#
# The token must contain BOTH a letter and an asterisk, which is what keeps this
# idempotent: our own `***` has no letter, so a second pass over an
# already-masked caption leaves it alone instead of chewing through it.
#
# `\b` cannot be used as the right-hand anchor — there is no word boundary
# between the `*` of "f***" and the following space, since neither is a word
# character — so the token's edges are asserted with explicit lookaround over
# the word-plus-asterisk character class instead.
_SELF_CENSORED_RE = re.compile(
    r"(?<![\w*])(?=[\w*]*[a-z])(?=[\w*]*\*)[\w*]+(?![\w*])",
    re.IGNORECASE,
)


def _keep(match: re.Match) -> bool:
    """True when a match is an allowlisted word that must survive."""
    return match.group(0).lower() in _ALLOW


def mask(text: str | None) -> tuple[str, bool]:
    """Mask strong language in a caption.

    Returns `(masked_text, contained_profanity)`. The flag is what the stored
    clip's `flags.strong_language` records; callers use it to decide whether a
    clip needs a heavier touch, not to decide whether to show the caption — the
    caption is always safe by the time it leaves this function.

    `None` and empty input return `("", False)` rather than raising: a clip whose
    transcription failed still has to render, as a playable clip with no caption.
    """
    if not text:
        return "", False

    found = False

    def replace(match: re.Match) -> str:
        nonlocal found
        if _keep(match):
            return match.group(0)
        found = True
        return MASK

    masked = _STRONG_RE.sub(replace, text)
    masked = _SELF_CENSORED_RE.sub(replace, masked)

    # Collapse "*** ***" runs — "fucking bullshit" reads better as one mask than
    # as two, and a wall of asterisks is louder than the word it hides.
    collapsed = re.sub(r"(?:\*{3})(?:\s+\*{3})+", MASK, masked)

    return collapsed, found


def mask_utterances(utterances: list[dict]) -> tuple[list[dict], bool]:
    """Apply `mask` across a clip's utterances, in place-ish.

    Each utterance gains `text_masked`; `text_raw` is left untouched because the
    attribution model and any future re-mask both need it. The returned flag is
    true when *any* utterance contained profanity, which is the clip-level
    `strong_language` value.
    """
    any_profanity = False
    out = []
    for utterance in utterances or []:
        masked, found = mask(utterance.get("text_raw"))
        any_profanity = any_profanity or found
        out.append({**utterance, "text_masked": masked})
    return out, any_profanity
