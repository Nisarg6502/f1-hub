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

_CITATION_RE = re.compile(r"\[ev_(\d+)\]")
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


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE_SPLIT_RE.split(text or "") if s.strip()]


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
# result types
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Violation:
    kind: str
    detail: str


@dataclass(frozen=True)
class VerificationResult:
    passed: bool
    violations: tuple[Violation, ...] = ()
    citation_count: int = 0

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

    citation_count = len({f"ev_{n}" for n in _CITATION_RE.findall(draft)})

    return VerificationResult(
        passed=not violations,
        violations=tuple(violations),
        citation_count=citation_count,
    )
