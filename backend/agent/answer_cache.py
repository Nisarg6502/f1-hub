"""CP66's answer cache — `CHAT-AGENT-PLAN.md` §4.2: "Answer caching is
load-bearing, not an optimisation... On a portfolio site, repeat questions
dominate."

**Simplified for this checkpoint: keyed on normalised question text plus
`PROMPT_VERSION`, not resolved entities.** The plan's fuller design keys on
"normalized question + resolved entities" — but resolving entities ahead of
a cache lookup needs `resolve_context`, which itself needs the calendar/
roster loaded from Mongo, meaning a cache *miss* would cost a Mongo read
before the agent even starts and a cache *hit* would too. The simpler
exact-text key still catches the highest-value case on a low-traffic
portfolio site: the same question asked more than once — a demo audience
reading the panel's own suggested-question buttons, a repeat visitor, a
load test. Entity-aware caching (so "who won Monaco 2026" and "who won the
2026 Monaco GP" share a cache row) is a real refinement left for later, once
real traffic shows whether exact-match hit rate is actually the bottleneck.

**Never caches a `verification_failed` answer.** A hallucinated or uncited
draft cached forever would repeat that exact failure to every future asker
until `PROMPT_VERSION` bumps — the opposite of what caching is for. Tier 1
(`verification=None`, CP64 skips it there) and a `"passed"` tier 2/3 answer
are both safe to cache; a failed one is not, by construction —
`should_cache` is the one gate every write in this module goes through.

Mirrors `agent/ledger.py`'s own posture: never raises. A cache read or write
failing (a transient Mongo hiccup) must degrade to "no cache" — the same
tool a whole conversation's worth of quota went into producing must not be
allowed to 500 because of a caching layer that was only ever an optimisation
for the *next* asker, not this one.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any

from app.db import get_db

CACHE_COLLECTION = "agent_answer_cache"


def normalise_question(text: str) -> str:
    """Lowercase, strip accents/punctuation, collapse whitespace.

    Same shape as `resolve_context.normalise` — accent folding matters here
    for the identical reason: "Räikkönen" and "Raikkonen" should hit the same
    cache row, not silently miss each other.
    """
    decomposed = unicodedata.normalize("NFKD", (text or "").strip().lower())
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    collapsed = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", stripped))
    return collapsed.strip()


def cache_key(question: str, prompt_version: int) -> str:
    """An opaque, fixed-length id — never the raw question, so a Mongo
    `_id` index does not have to deal with arbitrarily long/odd text.
    """
    normalised = normalise_question(question)
    digest = hashlib.sha256(f"{normalised}|{prompt_version}".encode("utf-8"))
    return digest.hexdigest()


# Statuses that mean "this turn did not produce an answer worth keeping".
#
# `verification_failed` was the original member. `budget_exhausted` was added
# after a live production check: the step-budget degrade in `graph.py` streams
# as ordinary tokens, so this gate saw a normal model answer and cached it —
# and a single transient exhaustion then answered that question forever. It
# hid CP73's fix in production, since the pre-fix failure for "Compare Norris
# and Verstappen this year" was still being replayed after the deploy.
#
# The general rule this encodes, worth keeping in mind when adding a third
# member: a degrade that is *honest* to the reader is still not a fact, and
# caching is for facts.
UNCACHEABLE_STATUSES = frozenset({"verification_failed", "budget_exhausted"})


def should_cache(*, mode: str, verification: str | None) -> bool:
    """The one gate every cache write goes through — see module docstring."""
    return mode == "model" and verification not in UNCACHEABLE_STATUSES


async def get_cached(question: str, prompt_version: int, *, db: Any = None) -> dict | None:
    """The cached answer for this exact question, or None on a miss OR a
    transient failure — the two are deliberately indistinguishable to the
    caller, both just mean "run the agent for real."
    """
    try:
        database = db if db is not None else get_db()
        key = cache_key(question, prompt_version)
        return await database[CACHE_COLLECTION].find_one({"_id": key}, {"_id": 0})
    except Exception as error:  # noqa: BLE001 - degrade to "no cache", never raise
        print(f"agent answer_cache read failed: {type(error).__name__}: {error}")
        return None


async def set_cached(
    question: str,
    prompt_version: int,
    *,
    tier: int | None,
    text: str,
    sources: list[dict],
    visuals: list[dict] | None = None,
    db: Any = None,
) -> None:
    """Best-effort write. A failure here must never surface to the asker who
    already got their real, freshly-generated answer — see module docstring.

    `visuals` is `CHAT-VISUALS-CONTRACT.md` §7's last row: a turn's `visual`
    frames are stored with the answer and replayed, because they are pure
    functions of `(code, data)` and so cannot go stale in any way the prose
    beside them has not already. It defaults to `None` and is stored as `[]`,
    which is what makes this additive: every row written before visuals existed
    reads back as "no visuals" rather than as a missing key the replay path has
    to special-case.
    """
    try:
        database = db if db is not None else get_db()
        key = cache_key(question, prompt_version)
        await database[CACHE_COLLECTION].update_one(
            {"_id": key},
            {
                "$set": {
                    "question": question,
                    "tier": tier,
                    "text": text,
                    "sources": sources,
                    "visuals": list(visuals or []),
                    "prompt_version": prompt_version,
                }
            },
            upsert=True,
        )
    except Exception as error:  # noqa: BLE001 - see docstring
        print(f"agent answer_cache write failed: {type(error).__name__}: {error}")
