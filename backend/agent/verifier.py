"""CP64's verifier — `CHAT-AGENT-PLAN.md` §7, "the part that makes this trustworthy".

Pure Python, no model call, no network: every check here is a regex over the
draft text plus a lookup against the turn's `EvidenceLedger`. This is
deliberately the deterministic core the plan describes ("citation presence,
`evidence_id` existence and number-matching against the ledger are string
and set operations — no model needed"), not the full five-stage pipeline
(§7 also names an LLM claim-extraction call and an LLM entailment pass).
Those are left for a future checkpoint once this deterministic core has
production data to show whether it is enough on its own — the same
"measure before adding the expensive part" discipline CP63 just re-learned
the hard way. What ships here already closes the two concrete failure
classes recorded so far:

- **CP38** — a model invented a teammate relationship from correct raw data.
  `check_citations` catches the citation-shaped version of this: any cited
  `evidence_id` that does not exist in the ledger, or a number in a cited
  sentence that does not appear anywhere in that evidence entry's data.
- **CP41** — a prompt rule ("no podium in a qualifying recap") was violated
  even after being restated in ALL CAPS, fixed only by a code-side
  regenerate-once loop (`app/session_recap.py`'s `SESSION_VALIDATORS`,
  reused here almost verbatim — see `graph.py`'s repair path). This module
  extends the same idea to two framing rules named directly in the plan:
  a predictive answer must hedge rather than assert an outcome, and a
  subjective answer must not deliver a verdict.

**Citation format: `[ev_N]`, matching `ledger.ID_PREFIX` exactly.** The
system prompts (`graph.SYSTEM_PROMPT` / `ORCHESTRATOR_SYSTEM_PROMPT`) tell
the model to cite this way — but per CP44's lesson ("never build on a
*documented* prompt contract, parse defensively"), nothing here assumes the
model reliably does. A draft with zero citations is not a crash, it is a
violation the repair loop gets one chance to fix.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from .ledger import Evidence, EvidenceLedger

# --------------------------------------------------------------------------
# parsing the draft
# --------------------------------------------------------------------------

# Bracket variants are accepted, not just ASCII `[`/`]`. CP73's live runs caught
# the deployed model closing a marker with the CJK full-width `【ev_2】` — the
# answer was correct and cited, but every marker in it was invisible to this
# regex, so the verifier reported nine violations against a good draft and
# CP72's anchors resolved to nothing.
#
# This is the CP41 lesson again: the prompt asks for `[ev_N]` and the model
# mostly complies, and "mostly" is not a contract. Widening the parser costs
# nothing and removes a whole class of silent failure; the alternative — asking
# the model more firmly — is the approach CP41 already watched fail in ALL CAPS.
# Only bracket *shape* is tolerated. The `ev_N` body stays exact, so a
# hallucinated id is still a lookup miss (see `ledger.py` on opaque ids).
_CITATION_RE = re.compile(r"[\[【［]ev_(\d+)[\]】］]")
_NUMBER_RE = re.compile(r"-?\d[\d,]*\.?\d+|-?\d+")
# Sentence-ish split: good enough for "does this sentence carry a number and
# a citation", not attempting real NLP. Keeps the delimiter's own punctuation
# out of the next sentence so a following citation marker is not mistaken for
# belonging to the prior one.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

# Numbers this common are almost always ordinals/list markers/single-digit
# counts embedded in ordinary prose ("in 3rd", "P1", "a 2-stop strategy")
# rather than a specific fact CP38 would worry about. Excluding them keeps
# `uncited_number` from flagging nearly every sentence in a normal answer —
# tuned against a real live draft during this checkpoint's own verification,
# not guessed in the abstract.
_TRIVIAL_NUMBERS = frozenset(str(n) for n in range(0, 10))


def _sentence_spans(text: str) -> list[tuple[int, int]]:
    """`_sentences`, but keeping each sentence's offsets in the draft.

    CP72's anchors have to name a span of the answer text so CP74 can mark the
    cited value where it appears in the prose. `re.split` throws positions
    away, so the split is done as a walk over the delimiter matches instead.
    `_sentences` is now defined in terms of this, which is deliberate: two
    sentence splitters that could drift apart would let the verifier check one
    set of sentences and anchor a different one.
    """
    source = text or ""
    spans: list[tuple[int, int]] = []
    cursor = 0
    for match in _SENTENCE_SPLIT_RE.finditer(source):
        spans.append((cursor, match.start()))
        cursor = match.end()
    spans.append((cursor, len(source)))

    trimmed: list[tuple[int, int]] = []
    for start, end in spans:
        # Reproduce `.strip()` as offset arithmetic so the retained substring
        # is character-for-character what the old splitter produced.
        while start < end and source[start].isspace():
            start += 1
        while end > start and source[end - 1].isspace():
            end -= 1
        if start < end:
            trimmed.append((start, end))
    return trimmed


def _sentences(text: str) -> list[str]:
    source = text or ""
    return [source[start:end] for start, end in _sentence_spans(source)]


def _citations_in(sentence: str) -> list[str]:
    return [f"ev_{n}" for n in _CITATION_RE.findall(sentence)]


def _significant_numbers_in(sentence: str) -> list[str]:
    without_citations = _CITATION_RE.sub("", sentence)
    return [n for n in _NUMBER_RE.findall(without_citations) if n.replace(",", "") not in _TRIVIAL_NUMBERS]


def _evidence_haystack(entry: Evidence) -> str:
    """Every number in an evidence entry's data, as one searchable string.

    `json.dumps` rather than `str()`: `str()` on a dict already looks
    JSON-ish for simple cases but is not guaranteed stable for nested
    dataclasses or non-string keys the way this codebase's fact bundles can
    carry; `default=str` covers anything `json` itself cannot serialise
    (a `datetime`, for instance) without raising.
    """
    try:
        return json.dumps(entry.data, default=str)
    except (TypeError, ValueError):
        return str(entry.data)


# --------------------------------------------------------------------------
# claim anchors (CP72)
# --------------------------------------------------------------------------

# A claim's *numbers* are what `check_citations` polices, and numbers alone
# would have anchored nothing in the bug that prompted this: "Who won the
# Australian GP?" is answered by a name, not a figure. So anchoring works from
# a wider token set than checking does — capitalised runs (driver, team,
# circuit and event names, which is what an F1 answer is mostly made of) and
# lap/race times, alongside the numbers.
#
# Widening the *checker* the same way would have been a silent regression:
# every unmatched name would become a new `unsupported_number`-shaped
# violation and start failing answers that pass today. Anchors are strictly a
# by-product — a token that locates gains a citation an anchor, and a token
# that does not changes nothing at all.
_ANCHOR_ENTITY_RE = re.compile(r"\b[A-Z][\w'’\-]*(?:\s+[A-Z][\w'’\-]*)*")
_ANCHOR_TIME_RE = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b")

# A capitalised word at the start of a sentence is capitalised by grammar, not
# because it names anything ("The Australian Grand Prix", "He finished
# second"). Leading stopwords are stripped off a run rather than the run being
# discarded, because the remainder is usually the actual entity.
_ANCHOR_STOPWORDS = frozenset(
    {
        "a", "an", "and", "after", "at", "before", "both", "but", "by",
        "despite", "for", "from", "he", "her", "his", "however", "in", "it",
        "its", "meanwhile", "no", "not", "of", "on", "overall", "separately",
        "she", "that", "the", "their", "they", "this", "to", "while", "with",
    }
)

# Per-sentence and per-claim caps. Both exist for the same reason: every token
# kept is a full `Evidence.locate` walk per cited entry, and every anchor kept
# rides to the browser carrying a row. A sentence with more than a handful of
# anchored values is also not a UI CP74 can render legibly — past that it is a
# highlighted paragraph, not a citation.
_ANCHOR_MAX_TOKENS = 12
ANCHORS_PER_CLAIM = 4


def _anchor_tokens_in(sentence: str) -> list[tuple[str, int]]:
    """The significant tokens of one sentence, each with its offset in it.

    Offsets rather than a bare list because the citation marker text must be
    excluded *without* shifting the positions of everything after it —
    `_significant_numbers_in` can afford `_CITATION_RE.sub("")` since it only
    needs the values, but an anchor that points a few characters off would
    underline the wrong word in the answer. So markers are recorded as blocked
    spans and overlapping candidates are dropped instead.
    """
    blocked = [m.span() for m in _CITATION_RE.finditer(sentence)]

    def overlaps_marker(start: int, end: int) -> bool:
        return any(start < b_end and b_start < end for b_start, b_end in blocked)

    candidates: list[tuple[int, str]] = []

    timed: list[tuple[int, int]] = []
    for match in _ANCHOR_TIME_RE.finditer(sentence):
        timed.append(match.span())
        candidates.append((match.start(), match.group(0)))

    for match in _NUMBER_RE.finditer(sentence):
        if match.group(0).replace(",", "") in _TRIVIAL_NUMBERS:
            continue
        # A lap time was already captured whole; its component numbers would
        # anchor the same fact twice, at a worse granularity.
        if any(match.start() < t_end and t_start < match.end() for t_start, t_end in timed):
            continue
        candidates.append((match.start(), match.group(0)))

    for match in _ANCHOR_ENTITY_RE.finditer(sentence):
        # Word positions are found by scanning the sentence itself rather than
        # by summing word lengths: a run split on `\s+` loses how wide each
        # gap was, and an offset a character out underlines the wrong text.
        words: list[tuple[int, str]] = [
            (word.start(), word.group(0))
            for word in re.finditer(r"\S+", match.group(0))
        ]
        words = [(match.start() + at, word) for at, word in words]
        while words and words[0][1].casefold() in _ANCHOR_STOPWORDS:
            words = words[1:]
        if not words:
            continue

        start = words[0][0]
        text = sentence[start : words[-1][0] + len(words[-1][1])]
        if len(text) >= 3:
            candidates.append((start, text))
        # A run of capitals is greedy, so two adjacent entities with no
        # lowercase word between them ("Mercedes McLaren Ferrari", a headline
        # or a list) arrive as one token that is stored in no single field and
        # therefore locates nowhere. The constituent words are offered as
        # fallbacks; the overlap rule in `anchors` keeps the whole run
        # preferred whenever the whole run does resolve, so this only ever
        # rescues a case that would otherwise have produced nothing.
        if len(words) > 1:
            for at, word in words:
                if len(word) >= 3 and word.casefold() not in _ANCHOR_STOPWORDS:
                    candidates.append((at, word))

    tokens: list[tuple[str, int]] = []
    seen: set[str] = set()
    # Longest first at a given offset, so the overlap rule downstream sees the
    # most specific reading of a span before any of its fragments.
    for start, text in sorted(candidates, key=lambda c: (c[0], -len(c[1]))):
        if overlaps_marker(start, start + len(text)):
            continue
        if text in seen:
            continue
        seen.add(text)
        tokens.append((text, start))
        if len(tokens) >= _ANCHOR_MAX_TOKENS:
            break
    return tokens


# --------------------------------------------------------------------------
# framing contracts (§7: "predictive must hedge", "subjective must not verdict")
# --------------------------------------------------------------------------

# Mirrors the intent of `router.py`'s tier-3 predictive patterns, but this
# module checks the *answer*, not the question — a verifier that only looked
# at the question could not tell whether the model actually hedged.
_PREDICTIVE_ASSERTION_RE = re.compile(
    r"\b(will|is going to|is set to)\s+(win|beat|dominate|finish|clinch|take)\b",
    re.IGNORECASE,
)
_HEDGE_RE = re.compile(
    r"\b(likely|probably|expected|may|might|could|possibly|uncertain|"
    r"no guarantee|hard to (say|predict)|commentary|not a promise|"
    r"favou?rite|favou?red|based on (recent )?form)\b",
    re.IGNORECASE,
)

_SUBJECTIVE_VERDICT_RE = re.compile(
    r"\b(is (clearly|definitely|objectively)?\s*(the )?(greatest|better|best)\b|"
    r"\bwithout (a )?doubt\b|\bno contest\b|\bhands down\b)",
    re.IGNORECASE,
)
_OPINION_HEDGE_RE = re.compile(
    r"\b(matter of opinion|subjective|depends on|no single (right )?answer|"
    r"reasonable people (could|might) disagree)\b",
    re.IGNORECASE,
)

# --------------------------------------------------------------------------
# regulation contract (§7 / CP67: this app holds no sporting-regulation
# data, so any confident claim about a specific rule or article number is
# ungrounded by construction — cheap to detect, easy to hedge)
# --------------------------------------------------------------------------

_REGULATION_CLAIM_RE = re.compile(
    r"\b(article|regulation|rule)\s+\d+(\.\d+)?\b|"
    r"\b(mandatory|required|prohibited)\s+(penalty|under\s+the\s+regulations)\b",
    re.IGNORECASE,
)
_REGULATION_HEDGE_RE = re.compile(
    r"\b(do(es)?n'?t|does not|do not)\s+(hold|have)\s+(the\s+)?(full\s+)?"
    r"(sporting\s+)?regulations\b|\bcan'?t confirm\b|\bnot certain (of|about) the exact rule\b",
    re.IGNORECASE,
)


def check_regulation(draft: str, ledger: EvidenceLedger) -> list[Violation]:
    """This app has no *internal* sporting-regulation dataset, but CP62's web
    tools can retrieve and cite real regulation text — so a regulation claim
    is only ungrounded when it isn't actually backed by anything this turn
    retrieved. Checked per sentence (`_sentences`, same helper
    `check_citations` uses): a sentence carrying a citation marker whose id
    resolves in the ledger is trusted the same way `check_citations` trusts
    it, and only an uncited (or unresolvable-citation) regulation claim gets
    flagged unless the draft itself hedges.
    """
    for sentence in _sentences(draft):
        if not _REGULATION_CLAIM_RE.search(sentence):
            continue
        if _REGULATION_HEDGE_RE.search(sentence):
            continue
        if any(ledger.get(evidence_id) is not None for evidence_id in _citations_in(sentence)):
            continue
        return [
            Violation(
                "unverifiable_regulation_claim",
                "cites a specific regulation/article number, but this app holds "
                "no sporting-regulation dataset to verify it against — state "
                "plainly that the exact rule can't be confirmed instead",
            )
        ]
    return []


# --------------------------------------------------------------------------
# toxicity contract (§7 / CP67: a small, deliberately unambitious denylist)
# --------------------------------------------------------------------------

_TOXIC_TERMS_RE = re.compile(
    r"\b(idiot|moron|stupid|trash|garbage)\b.*\b(banned|fired|should)\b|"
    # `fired(?!\s+up\b)` excludes the "fired up (about/for)" idiom — genuine
    # enthusiasm ("Alpine should be fired up about their upgrade package"),
    # not the termination sense this guard exists to catch.
    r"\b(should|deserves to)\s+(be\s+)?(banned|fired(?!\s+up\b)|die)\b",
    re.IGNORECASE,
)


def check_toxicity(draft: str) -> list[Violation]:
    """A small denylist against the answer text itself. Deliberately
    unambitious — this is a tripwire against the model's own output turning
    hostile about a driver/team, not a general-purpose content moderator.

    Checked per sentence (`_sentences`, already used by `check_citations`),
    not against the whole draft in one shot: `_TOXIC_TERMS_RE`'s `.*` is
    unanchored, and matched against the full draft it can span across
    sentence boundaries and stitch two unrelated clauses into a false
    positive — e.g. "...drove a stupid race [ev_1]. Separately, ... should
    retain Tsunoda [ev_2]." has no hostile claim in either sentence but
    matched as one string. Since CP67 tier 1 (the highest-traffic tier) also
    runs this check, that false-positive surface now costs a wasted repair
    call on far more real traffic than when only tier 2/3 paid for it.
    """
    for sentence in _sentences(draft):
        if _TOXIC_TERMS_RE.search(sentence):
            return [
                Violation(
                    "toxic_language",
                    "uses hostile/derogatory language about a person — rewrite "
                    "neutrally",
                )
            ]
    return []


# --------------------------------------------------------------------------
# result types
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Violation:
    kind: str
    detail: str


@dataclass(frozen=True)
class Anchor:
    """One claim token, tied to the exact field of the exact record proving it.

    An anchor is what a citation should have been all along. `Evidence` binds
    to a whole tool bundle, so a citation could only ever say *which bundle* a
    fact came from — which is why asking who won a race returned a table with
    no winner in it. An anchor says which value, in which field, in which row.

    `start`/`end` index the draft, not the sentence: CP74 marks the cited value
    where the reader sees it, and re-deriving a sentence offset in the frontend
    would be a second, drifting copy of this module's sentence splitter.
    `text` is the draft's own wording and `value` is the stored one — they are
    kept apart on purpose, because they legitimately differ ("Russell" in the
    prose, "George Russell" in the record) and collapsing them would either
    lose the span or misreport the evidence.
    """

    evidence_id: str
    text: str
    start: int
    end: int
    claim: str
    field: str
    value: str
    path: str
    row: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "evidence_id": self.evidence_id,
            "text": self.text,
            "start": self.start,
            "end": self.end,
            "claim": self.claim,
            "field": self.field,
            "value": self.value,
            "path": self.path,
            "row": dict(self.row or {}),
        }


def anchors(draft: str, ledger: EvidenceLedger) -> list[Anchor]:
    """Every claim token in the draft that a cited entry actually proves.

    This walks the same claim → cited entry → matched value path
    `check_citations` walks, and that is the whole argument for computing
    anchors here rather than asking the model for them. The alternative on the
    table was a finer citation format — `[ev_3#winner]` instead of `[ev_3]` —
    and this repo has three post-mortems (CP38, CP41, CP44) saying that a rule
    the model is asked to follow is not a rule. The verifier is already
    resolving the location and discarding it; keeping it costs nothing and
    cannot be violated.

    Emission is deliberately *additive to nothing else*: it reads the draft and
    the ledger, decides no pass or fail, and returns a possibly-empty list. A
    turn where every locate misses produces no anchors and is otherwise
    identical to a turn before this checkpoint existed.

    One anchor per located token per cited entry, capped at
    `ANCHORS_PER_CLAIM` per claim/entry pair, deduplicated by span so a
    sentence citing the same entry twice does not mark the same word twice.
    Sorted by position in the draft, which is the order CP74 renders them in.
    """
    found: list[Anchor] = []
    seen_spans: set[tuple[str, int, int]] = set()

    for start, end in _sentence_spans(draft or ""):
        sentence = (draft or "")[start:end]
        cited = _citations_in(sentence)
        if not cited:
            continue
        tokens = _anchor_tokens_in(sentence)
        if not tokens:
            continue

        for evidence_id in cited:
            entry = ledger.get(evidence_id)
            if entry is None:
                # Already a violation in `check_citations`; here it is simply
                # nothing to anchor to.
                continue
            located = {
                str(hit.get("token")): hit
                for hit in entry.locate([text for text, _ in tokens])
            }
            emitted = 0
            for text, offset in tokens:
                hit = located.get(text)
                if hit is None:
                    continue
                span = (evidence_id, start + offset, start + offset + len(text))
                # Overlap, not equality: `_anchor_tokens_in` offers a
                # multi-word entity alongside its individual words so a greedy
                # run that names nothing still resolves. Whichever reading came
                # first is the longest one that located, and a second anchor
                # inside its span would mark the same fact twice.
                if any(
                    seen_id == evidence_id and span[1] < seen_end and seen_start < span[2]
                    for seen_id, seen_start, seen_end in seen_spans
                ):
                    continue
                seen_spans.add(span)
                found.append(
                    Anchor(
                        evidence_id=evidence_id,
                        text=text,
                        start=span[1],
                        end=span[2],
                        claim=sentence,
                        field=str(hit.get("field") or ""),
                        value=str(hit.get("value") or ""),
                        path=str(hit.get("path") or ""),
                        row=dict(hit.get("row") or {}),
                    )
                )
                emitted += 1
                if emitted >= ANCHORS_PER_CLAIM:
                    break

    found.sort(key=lambda anchor: (anchor.start, anchor.evidence_id))
    return found


@dataclass(frozen=True)
class VerificationResult:
    passed: bool
    violations: tuple[Violation, ...] = ()
    citation_count: int = 0
    # Populated by `check` as a by-product, never consulted by `passed`. It
    # carries a default so every existing construction site and every test
    # asserting on this shape keeps working untouched — the anchors are new
    # information, not a new contract.
    anchors: tuple[Anchor, ...] = ()

    def repair_message(self) -> str:
        """The corrective instruction for the one-shot regenerate, mirroring
        `session_recap.py`'s `SESSION_VALIDATORS` retry-prompt shape exactly.
        """
        bullets = "\n".join(f"- {v.detail}" for v in self.violations)
        return (
            "YOUR PREVIOUS ANSWER WAS REJECTED by an automated fact-checker for "
            f"the following reason(s):\n{bullets}\n\n"
            "Rewrite your answer. Cite every factual claim with the evidence id "
            "from the tool result it came from, in the form [ev_N] — do not "
            "invent an id, and do not state a number that id's data does not "
            "actually contain. If the question asked you to predict an outcome, "
            "hedge explicitly rather than asserting it. If it asked for a "
            "subjective opinion, present both sides rather than a verdict."
        )


def check_citations(draft: str, ledger: EvidenceLedger) -> list[Violation]:
    """CP38's check: every citation must be real, every cited number must be
    backed by that citation's own evidence, and every sentence with a
    non-trivial number must cite *something*.
    """
    violations: list[Violation] = []
    seen_ids: set[str] = set()

    for sentence in _sentences(draft):
        cited = _citations_in(sentence)
        numbers = _significant_numbers_in(sentence)

        for evidence_id in cited:
            seen_ids.add(evidence_id)
            entry = ledger.get(evidence_id)
            if entry is None:
                violations.append(
                    Violation(
                        "unknown_citation",
                        f"cites [{evidence_id}], which does not exist in this turn's evidence ledger",
                    )
                )
                continue
            haystack = _evidence_haystack(entry)
            for number in numbers:
                if number.replace(",", "") not in haystack:
                    violations.append(
                        Violation(
                            "unsupported_number",
                            f"states '{number}' citing [{evidence_id}], but that "
                            "evidence entry's data does not contain this number",
                        )
                    )

        if numbers and not cited:
            violations.append(
                Violation(
                    "uncited_number",
                    f"states a number with no citation: \"{sentence[:120]}\"",
                )
            )

    return violations


def check_framing(draft: str, *, predictive: bool, subjective: bool) -> list[Violation]:
    """§7's two framing contracts. Only checked when the question actually
    needed one — `graph.py` decides `predictive`/`subjective` from the same
    question-side patterns `router.py` already classifies tier 3 with, so an
    ordinary point lookup never pays for a check it has no reason to fail.
    """
    violations: list[Violation] = []

    if predictive and _PREDICTIVE_ASSERTION_RE.search(draft) and not _HEDGE_RE.search(draft):
        violations.append(
            Violation(
                "predictive_no_hedge",
                "asserts a race outcome as fact ('X will win') without any "
                "hedging language — predictions must read as uncertain "
                "commentary, never a promise",
            )
        )

    if subjective and _SUBJECTIVE_VERDICT_RE.search(draft) and not _OPINION_HEDGE_RE.search(draft):
        violations.append(
            Violation(
                "subjective_verdict",
                "delivers a verdict on a subjective question ('X is the "
                "greatest') instead of presenting evidence on both sides "
                "without one",
            )
        )

    return violations


def check(
    draft: str,
    ledger: EvidenceLedger,
    *,
    predictive: bool = False,
    subjective: bool = False,
) -> VerificationResult:
    """Run every deterministic check and fold the results into one verdict.

    An empty draft is deliberately **not** a violation of its own — an
    honest "I don't have that data" decline (taxonomy class 14, or a tool
    reporting `available: false`) cites nothing and asserts nothing, which
    is correct, not unverified.
    """
    if not (draft or "").strip():
        return VerificationResult(passed=True, violations=(), citation_count=0)

    violations = check_citations(draft, ledger)
    violations += check_framing(draft, predictive=predictive, subjective=subjective)
    violations += check_regulation(draft, ledger)
    violations += check_toxicity(draft)

    citation_count = len({f"ev_{n}" for n in _CITATION_RE.findall(draft)})

    return VerificationResult(
        passed=not violations,
        violations=tuple(violations),
        citation_count=citation_count,
        # Computed after `violations`, and pointedly not folded into them: the
        # design note's condition is that existing verifier behaviour is
        # unchanged. An unanchored claim is not a new failure class — plenty of
        # true sentences ("that was his third win of a difficult season") name
        # nothing a bundle stores — and treating one as a violation would start
        # rejecting answers that pass today.
        anchors=tuple(anchors(draft, ledger)),
    )
