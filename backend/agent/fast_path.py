"""A rules-first fast path for a handful of high-frequency, unambiguous intents.

**The problem this solves.** A full turn runs `router.classify` into a
LangGraph ReAct loop that can spend up to `config.AGENT_MAX_STEPS` model
round-trips deciding which tool to call, then reading its result, then
deciding it is done. For a question like "who won the last race?" that
decision is not actually in doubt — there is exactly one right tool sequence,
and asking a 30B model to rediscover it every single time is paying full
multi-hop latency (each hop a real Ollama Cloud round trip) for zero real
uncertainty. `router.py`'s own docstring makes the parallel case for tier
classification itself: "a model call spent classifying a question is a model
call not spent answering it." This module extends the same argument one level
further in, from "which tier" to "which tool", for the narrow slice of
questions where the tool choice is not actually a judgement call.

**What this module is not.** It is not a second, cheaper agent. It never lets
the model choose a tool, chain tools, or decide when it is done — that
reasoning is exactly what a full ReAct turn is for, and a question that
genuinely needs it (anything comparative, historical, predictive, or scoped
to a specific past race/season) must never land here. `detect()` is the one
gate this depends on for that, and it is written to fail closed: a false
negative (missing a fast-path opportunity) just falls through to the full
loop and costs nothing beyond what every other question already pays; a
false positive (fast-pathing something that needed real reasoning) would
skip that reasoning entirely and is the failure this module is built to
avoid. See `detect`'s own docstring for the mechanism.

**Why this stays framework-free.** `graph.py` pulls in `langchain_core`,
`ollama` and `deepagents` at import time — a real cost for a module whose
entire job here is "call two Python functions, then make one HTTP request".
This module imports only `router`, `verifier`, `ledger`, `model` and the two
tool submodules it actually calls, all of which are already framework-free
by their own docstrings' design. `graph.py` imports this module (the
dependency runs one way only), so nothing here may import `graph` back —
`ledger.py`'s docstring makes the identical argument for staying importable
without LangGraph, and it is worth restating here rather than silently
matching it, because breaking it would be an easy accident (`_chunk_draft`
lives in `graph.py` and it would be natural to reach for it). The eight-line
word-chunker below is a deliberate, small duplicate of `graph._chunk_draft`
for exactly that reason.

**Verification is not skipped.** `graph.astream_answer`'s own docstring
records that CP67 closed the tier-1-skips-verification gap after it produced
a real, measured failure (a fabricated "3 podiums" from zero tool calls that
nothing caught) — every tier now runs buffer -> `verifier.check` ->
one-shot-repair before a token reaches the reader. A fast-pathed answer is
now skipping tool-*selection* reasoning too, not just whatever tier 1 used to
skip, which is a strictly larger thing to trust unchecked — so it gets the
identical verify-and-repair treatment, not a lighter one. The one call this
module is allowed to spend on itself is the phrasing call; the repair call
is the same safety net every other tier already budgets for, not a new cost
this module introduces.
"""

from __future__ import annotations

import json
import re
from typing import Any, AsyncIterator

from . import config
from . import model as model_seam
from . import router
from . import verifier
from .labels import activity_label
from .ledger import EvidenceLedger
from .tools import context as context_tools
from .tools import season as season_tools

FastPathEvent = tuple[Any, ...]
"""Same shape as `graph.AgentEvent`, restricted to the subset this module
actually yields: `("activity", label, state, detail, kind)` and
`("verification", passed, violation_count)` and `("token", text)`. No
`("tier", ...)` (the caller already yielded one from `router.classify`) and
no `("visual", ...)` — every intent here resolves to a single named fact
(a winner, a leader, a date), and `graph._VISUAL_RULE`'s own second "real
reason to skip the chart" is exactly this shape: "a single scalar with
nothing to compare it to.\""""


# --------------------------------------------------------------------------
# Intent detection
# --------------------------------------------------------------------------

# Bail on any specific year at all. Every intent below answers about the
# *current* state of the season ("the last race", "leading", "the next
# race") — a question naming a year is asking about a specific season,
# which needs `resolve_context` to pin down, not the clock-relative tools
# this module calls unconditionally.
_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")

# Anchored at the end (allowing only a short, explicit whitelist of trailing
# phrases plus punctuation) rather than requiring the match to start the
# string. This is the actual mechanism that keeps a false positive rare: any
# extra clause after the core phrase — "...at Monaco?", "...between
# Verstappen and Norris?", "...this weekend, or will it rain?" — pushes the
# literal match past the point `$` requires, so the whole pattern simply
# does not match. A prefix like "hey, do you know" is harmless and still
# matches, because nothing anchors the *start*.
_TRAILING = r"(?:\s+(?:this season|right now|currently|today))?\s*[?!.]*\s*$"

_LAST_RACE_WINNER_RE = re.compile(
    r"who\s+(?:won|win|took|takes)\s+the\s+(?:last|most\s+recent|previous|latest)\s+"
    r"(?:f1\s+)?(?:grand\s+prix|gp|race)" + _TRAILING
)

_DRIVERS_LEADER_RE = re.compile(
    r"who(?:['’]s|\s+is)?\s+(?:currently\s+)?(?:leading|leads)\s+the\s+drivers['’]?\s*"
    r"(?:championship|standings|title)" + _TRAILING
)

_CONSTRUCTORS_LEADER_RE = re.compile(
    r"who(?:['’]s|\s+is)?\s+(?:currently\s+)?(?:leading|leads)\s+the\s+constructors['’]?\s*"
    r"(?:championship|standings|title)" + _TRAILING
)

_NEXT_RACE_RE = re.compile(
    r"(?:when(?:['’]s|\s+is)|what(?:['’]s|\s+is))\s+the\s+next\s+"
    r"(?:f1\s+)?race" + _TRAILING
)

# Ordered rather than a dict — earlier entries are tried first, though today
# none of these four patterns can double-match the same text (each requires a
# different verb/object combination), so order is documentation, not a real
# tie-break, until a fifth intent makes that no longer true.
_INTENTS: tuple[tuple[str, "re.Pattern[str]"], ...] = (
    ("last_race_winner", _LAST_RACE_WINNER_RE),
    ("drivers_leader", _DRIVERS_LEADER_RE),
    ("constructors_leader", _CONSTRUCTORS_LEADER_RE),
    ("next_race", _NEXT_RACE_RE),
)


def detect(question: str) -> str | None:
    """Which fast-path intent, if any, this question unambiguously names.

    **`router.classify` is the hard gate, not a suggestion to imitate.**
    Rather than hand-copying `router._TIER2_PATTERNS`' comparative/causal/
    strategy/history exclusions (and `_TIER3_PATTERNS`' news/rumour/
    predictive ones) into a second list here that could drift out of sync
    with the original, this calls `router.classify` directly and refuses to
    fast-path anything that does not come back tier 1. "Who won the last
    race, Verstappen or Norris?" and "who will win the next race?" are both
    already excluded by that gate before either regex below ever runs — and
    if `router.py` ever grows a new tier-2/3 pattern, this exclusion widens
    automatically instead of needing a second edit.

    Returns `None` — never raises — on anything that is not a clean match,
    which is deliberately the same value a plain "no intent" result would
    be. A question this cannot classify is not a caller error, it is the
    overwhelmingly common case.
    """
    text = (question or "").strip().lower()
    if not text or _YEAR_RE.search(text):
        return None
    if router.classify(question).tier != 1:
        return None
    for name, pattern in _INTENTS:
        if pattern.search(text):
            return name
    return None


# --------------------------------------------------------------------------
# Phrasing the answer — exactly one model call on the success path
# --------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are the Pitwall Assistant for F1 Hub, a Formula 1 analysis app.

You have already been given the exact data you need below. You have NO tools \
and cannot look anything else up — answer using ONLY this data.

Cite every factual claim with the evidence id it came from, in the form \
[ev_N] — for example "Norris is leading with 320 points [ev_2]." Use an id \
exactly as given below; never invent one, and never cite an id that is not \
listed.

If a fact below is marked as not available, say plainly that the data is \
not available and why — never guess or fill the gap from general knowledge.

Answer in 1-3 clear, concise sentences, in plain prose. No headers, no \
bullet list, no table — this is a short, direct lookup, not a research \
report."""


def _render_evidence(tool_name: str, result: dict) -> str:
    """One line of evidence for the phrasing prompt, cited or not.

    Mirrors the shape a tool result already has inside a real ReAct turn
    (`{"available": ..., "data": ...}` per `tools/base.py`'s contract) rather
    than inventing a new one, so the same evidence a full turn would have
    read is what this prompt hands the model — just without the model having
    had to ask for it. An unavailable result carries no `evidence_id`
    (`bundle()` never appends one for it), so there is nothing to cite; the
    prompt is told the reason instead, which is itself the honest answer for
    the model to relay.
    """
    if result.get("available"):
        return f"[{result['evidence_id']}] {tool_name}: {json.dumps(result['data'], default=str)}"
    reason = result.get("reason") or "no reason given"
    return f"({tool_name} — not available: {reason})"


async def _phrase(messages: list[dict]) -> str:
    """One buffered model call — see `model.stream_chat`'s own docstring for
    why streaming and reassembling is still correct here: this module never
    forwards a token before `verifier.check` has seen the whole thing, same
    as every other tier (`graph._run_turn`'s docstring).

    Explicit `model=config.FAST_MODEL`: this path only ever runs for tier-1
    intents (`fast_path.detect` re-derives tier 1 itself), and leaving `model`
    unset would silently fall back to `config.DEFAULT_MODEL` — which, since
    the tier split landed, means the slow tier-3 model on the one call this
    whole module exists to make fast. See `graph.model_for`'s docstring for
    which model belongs to which tier."""
    parts: list[str] = []
    async for delta in model_seam.stream_chat(messages, model=config.FAST_MODEL):
        parts.append(delta)
    return "".join(parts)


async def _answer_from_evidence(
    question: str, evidence_lines: list[str], ledger: EvidenceLedger
) -> AsyncIterator[FastPathEvent]:
    """Phrase, verify, repair-once — the shared tail every intent below runs.

    Identical in shape to `graph.astream_answer`'s own verify/repair block,
    deliberately: a fast-pathed answer earns exactly the same trust bar as
    the ReAct loop's, not a lighter one (see this module's docstring).
    """
    evidence_block = "\n".join(evidence_lines) if evidence_lines else "(no evidence retrieved)"
    user_message = f"{question}\n\nEvidence:\n{evidence_block}"
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user_message},
    ]

    draft = await _phrase(messages)
    result = verifier.check(draft, ledger, predictive=False, subjective=False)

    if not result.passed:
        repair_messages = [
            *messages,
            {"role": "assistant", "content": draft},
            {"role": "user", "content": result.repair_message()},
        ]
        repaired = await _phrase(repair_messages)
        # Same call `graph.astream_answer` makes: a repaired answer that
        # still carries one flaw beats discarding it and emitting nothing.
        if repaired:
            draft = repaired
            result = verifier.check(draft, ledger, predictive=False, subjective=False)

    yield ("verification", result.passed, len(result.violations))
    for piece in _chunk_draft(draft):
        yield ("token", piece)


# Deliberately a small, standalone copy of `graph._chunk_draft` — see this
# module's docstring for why importing it from `graph` instead is the wrong
# fix for eight lines of code with no agent-specific behaviour in them.
_CHUNK_WORDS = 6


def _chunk_draft(text: str) -> list[str]:
    words = (text or "").split(" ")
    chunks = []
    for i in range(0, len(words), _CHUNK_WORDS):
        piece = " ".join(words[i : i + _CHUNK_WORDS])
        if i + _CHUNK_WORDS < len(words):
            piece += " "
        chunks.append(piece)
    return chunks


def _activity(tool_name: str, state: str) -> FastPathEvent:
    return ("activity", activity_label(tool_name), state, None, "tool")


# --------------------------------------------------------------------------
# Per-intent tool orchestration — plain Python calls, no model choosing
# --------------------------------------------------------------------------


async def _run_last_race_winner(
    question: str, ledger: EvidenceLedger, *, db: Any = None
) -> AsyncIterator[FastPathEvent]:
    yield _activity("get_season_state", "start")
    state = await context_tools.get_season_state(ledger=ledger, db=db)
    yield _activity("get_season_state", "done")

    evidence = [_render_evidence("get_season_state", state)]
    last_race = (state.get("data") or {}).get("last_race") if state.get("available") else None

    if last_race:
        season = last_race.get("season")
        round_number = last_race.get("round")
        if season is not None and round_number is not None:
            yield _activity("get_session_result", "start")
            result = await season_tools.get_session_result(
                season, round_number, "R", ledger=ledger, db=db
            )
            yield _activity("get_session_result", "done")
            evidence.append(_render_evidence("get_session_result", result))

    async for event in _answer_from_evidence(question, evidence, ledger):
        yield event


async def _run_leader(
    question: str, ledger: EvidenceLedger, *, kind: str, db: Any = None
) -> AsyncIterator[FastPathEvent]:
    yield _activity("get_season_state", "start")
    state = await context_tools.get_season_state(ledger=ledger, db=db)
    yield _activity("get_season_state", "done")

    evidence = [_render_evidence("get_season_state", state)]
    season = (state.get("data") or {}).get("season") if state.get("available") else None

    if season is not None:
        yield _activity("get_standings", "start")
        standings = await season_tools.get_standings(season, kind, ledger=ledger, db=db)
        yield _activity("get_standings", "done")
        evidence.append(_render_evidence("get_standings", standings))

    async for event in _answer_from_evidence(question, evidence, ledger):
        yield event


async def _run_next_race(
    question: str, ledger: EvidenceLedger, *, db: Any = None
) -> AsyncIterator[FastPathEvent]:
    yield _activity("get_season_state", "start")
    state = await context_tools.get_season_state(ledger=ledger, db=db)
    yield _activity("get_season_state", "done")

    evidence = [_render_evidence("get_season_state", state)]
    async for event in _answer_from_evidence(question, evidence, ledger):
        yield event


_RUNNERS = {
    "last_race_winner": _run_last_race_winner,
    "drivers_leader": lambda q, l, db=None: _run_leader(q, l, kind="driver", db=db),
    "constructors_leader": lambda q, l, db=None: _run_leader(q, l, kind="constructor", db=db),
    "next_race": _run_next_race,
}


async def run(
    question: str, intent: str, ledger: EvidenceLedger, *, db: Any = None
) -> AsyncIterator[FastPathEvent]:
    """Run one fast-path intent to completion, yielding the same event
    vocabulary `graph._run_turn`/`astream_answer` produce for everything
    except `tier` (already yielded by the caller) and `visual` (never drawn
    here — see `FastPathEvent`'s docstring).

    `intent` must be a key `detect()` actually returned; an unknown one is a
    caller bug, not a data condition, so this raises `KeyError` rather than
    degrading — the same posture `graph.build_tool_subset` takes for a
    subagent naming a tool that does not exist in `TOOLS`.

    `db` defaults to `None`, which every tool call below resolves to the
    app's singleton Motor client (`tools/base.py`'s `resolve_db`) exactly as
    a real turn would — it exists as a parameter at all so a test can inject
    a fake collection the same way `test_agent_tools.py` already does for
    every tool in this package, without this module needing its own mocking
    convention.
    """
    runner = _RUNNERS[intent]
    async for event in runner(question, ledger, db=db):
        yield event
