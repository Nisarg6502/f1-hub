"""Pre-warm `answer_cache` for the frontend's own suggested questions.

**The problem.** `pitwall-assistant-panel.tsx`'s `ROUTE_SUGGESTIONS` /
`DEFAULT_SUGGESTIONS` are the ~30 highest-probability first questions any
visitor will ever click — they are shown as buttons before a single word is
typed. `answer_cache.py`'s own docstring calls caching "load-bearing, not an
optimisation" on this portfolio site, and yet today every one of those
buttons pays the full 30-60s cold-run cost for whichever visitor clicks it
*first* — the cache only helps the *second* asker of an exact question. This
module runs each suggestion through the real agent pipeline ahead of time, so
the first real click is a cache hit like every one after it.

**How it invokes the agent outside of a real HTTP request.** `main.py`'s
`_stream` is not reusable as-is — it is laced with SSE framing, the rate
limiter, the run-slot queue and heartbeat plumbing, none of which apply to a
trusted background job talking to itself. What actually matters is
underneath all of that: `graph.astream_answer(...)` yielding the same tier /
activity / token / verification / visual events for any caller, and
`answer_cache.should_cache` / `answer_cache.set_cached` deciding what is safe
to keep. This module drives the first and calls the second directly — the
same two calls `_stream` makes, with none of the transport around them.
Using the *identical* `should_cache` gate is the part that matters most: a
prewarm run that bypassed it because "it's just a batch job" would be able to
cache a `verification_failed` or `budget_exhausted` draft forever, which is
precisely the failure `answer_cache.py`'s docstring records happening once
already in production.

**Why this bypasses `rate_limit.py` entirely, on purpose.** That limiter
polices an unauthenticated public endpoint sharing one metered inference
quota; this module is a trusted operator-run job, run the same way
`app/data_sync.py` and `scripts/build_track_geometry.py` already are —
neither of those goes through this service's rate limiter either, and adding
a rate-limit dependency here would mean importing `main.py`'s FastAPI/Starlette
surface into a script that has no request to rate-limit in the first place.

**The frontend/backend question-list duplication, and why it is not worth
removing.** `SUGGESTED_QUESTIONS` below is a hand-kept copy of the strings in
`frontend/src/components/pitwall-assistant-panel.tsx`'s `ROUTE_SUGGESTIONS`
and `DEFAULT_SUGGESTIONS`. Sharing one source across the Python/TypeScript
boundary for a ~30-item list would mean either a build step that generates
one file from the other (real infrastructure for a list that changes rarely)
or a runtime fetch of the frontend's own bundle from a batch job (a new,
fragile coupling between two independently-deployed Cloud Run services). A
plainly-labelled duplicate is the boring, low-risk choice for this size of
list — the failure mode if the two drift is "a new suggestion isn't
pre-warmed yet," which costs one visitor a slow first answer, not a wrong
one. **If you add, remove or reword a suggestion in the frontend file, update
the copy below too.**

**A handful of these questions are page-relative, and pre-warming does not
fix that — nor is it supposed to.** "Who won this race?" and "What's the lap
record at this circuit?" mean something different on every race/circuit
page, but `agent-api.ts`'s `streamChat` sends only the literal button text —
no route, season or round rides along in the request body. That is a
pre-existing property of the chat protocol (`frontend/` is out of scope for
this change), not something this module introduces: a real visitor asking
that literal text today already gets whatever the model does with no page
context, and every other visitor asking the same literal text — from a
*different* race or circuit page — already gets the same cached answer once
one exists. Pre-warming does not make this more or less correct; it just
means that already-shared answer is fast for everyone instead of slow for
whoever asks it first.

**Why the default is "skip a question that is already cached" rather than
always re-running all of them.** `agent_answer_cache` has no TTL and no
notion of staleness beyond `PROMPT_VERSION` — a cached "who won the last
race" answer is served forever until the prompt/tool contract changes,
whether or not a new race has actually happened since. Given that, always
re-running the full ~30-question sweep on every trigger (e.g. every hour,
alongside `f1-data-sync`) would burn `config.DAILY_COST_BUDGET` (240
units/day) on the prewarm alone — roughly 30 units per full sweep, so an
hourly trigger would spend 720/day, three times the entire daily budget,
crowding out the organic traffic this service exists for. The default
(`force=False`) instead treats "already cached for this `PROMPT_VERSION`" as
"nothing to do" — a `get_cached` is a single indexed Mongo read, not a model
call, so re-running the whole sweep on every trigger is cheap *after* the
first successful pass, and the first pass is the only one that spends real
inference. `--force` exists for the two cases that genuinely need a fresh
answer: a manual re-warm right after a `PROMPT_VERSION` bump (nothing is
cached yet under the new key anyway, so `--force` costs nothing extra there),
or a deliberate refresh of the small subset of questions that go stale with
real-world results (see `VOLATILE_QUESTIONS` below).

**The volatile subset, and the recommended trigger.** Four of the cached
questions describe state that changes every race weekend — who won the last
race, who leads each championship, when the next race is — and those are
exactly `fast_path.py`'s own four intents (Task B), not a coincidence: both
tasks independently converged on "the small set of questions with one
current, unambiguous answer." `--refresh-volatile` re-runs (with `force`)
only that subset, cheaply, and is the flag meant to run on a schedule; a full
unforced sweep is meant to run rarely (after a `PROMPT_VERSION` bump, or by
hand). The intended wiring, mirroring the existing `f1-data-sync` Cloud Run
Job + Cloud Scheduler pattern this repo already has (see `cloudbuild-sync
.yaml` and `README.md`'s "Deployment" section): a **second** Cloud Scheduler
job, a few minutes after the existing hourly sync fires, invoking this
module with `--refresh-volatile` against the *same* `f1-agent` container
image (no new Dockerfile/Cloud Build config needed — this is a `python -m`
entrypoint override on an image that already has every dependency this
script imports) via `gcloud run jobs execute` on a `f1-agent-cache-prewarm`
job resource pointed at `gcr.io/f1-dashboard-493015/f1-agent`. "A few minutes
after," not concurrently with, sync — the same reasoning `data_sync.py`'s own
docstring gives for why a round is refreshed on the hourly cadence at all:
data changes when sync runs, so a cache that could otherwise go stale should
refresh right after, not on an unrelated clock.

**The one real risk this does not solve, and does not try to.** Ollama
Cloud's free tier serves exactly one concurrent model
(`config.MAX_CONCURRENT_RUNS`'s docstring), and `f1-agent`'s own
`concurrency.py` semaphore only guards *that process* — it cannot see a
second process's calls. This script runs as a separate Cloud Run Job
execution, so if it happens to call Ollama at the exact moment a real visitor
is mid-conversation, one of the two calls can lose the race and come back
`ModelAtCapacity`. That is the identical, already-accepted risk
`config.MAX_CONCURRENT_RUNS`'s own docstring names for running `f1-agent` at
more than one Cloud Run instance — this script does not introduce a new
class of failure, it is a second occurrence of one this codebase already
decided not to solve with cross-process locking (out of scope: "not touching
Cloud Run scaling"). What this module does instead: run strictly
sequentially (never two in-flight `astream_answer` calls from this process),
so it can only ever be the *one* extra caller, never several; and treat a
losing collision as this question's problem alone — one `ModelAtCapacity`
here is logged and skipped, not fatal to the run, so it costs one stale
answer until the next scheduled attempt rather than aborting the whole sweep.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import uuid
from collections import Counter
from typing import Any

from . import answer_cache, config, verifier
from . import model as model_seam
from .ledger import EvidenceLedger

# --------------------------------------------------------------------------
# The question list — a hand-kept mirror of
# `frontend/src/components/pitwall-assistant-panel.tsx`'s `ROUTE_SUGGESTIONS`
# and `DEFAULT_SUGGESTIONS`. See this module's docstring for why a duplicate
# beats a shared source for a list this size, and update BOTH files together.
# --------------------------------------------------------------------------

ROUTE_SUGGESTIONS: tuple[str, ...] = (
    # /schedule/[season]/[round]/pitwall
    "What's happening in this session right now?",
    "Summarize the race control messages so far",
    "Who's currently on the fastest lap?",
    # /schedule/[season]/[round]
    "Who won this race?",
    "Walk me through this race's key moments",
    "What was the podium and fastest lap?",
    # /schedule
    "When is the next race?",
    "How many races are left this season?",
    "Which circuit hosts the most iconic race?",
    # /standings
    "Who's leading the drivers' championship?",
    "How close is the constructors' title fight?",
    "How has the championship lead changed this season?",
    # /drivers
    "Compare Verstappen and Norris this season",
    "Who has the most race wins this season?",
    "Which driver has the best qualifying record?",
    # /teams
    "Which team has the fastest car this season?",
    "Compare the top two constructors this season",
    "Who has the most reliable car this season?",
    # /circuits/[circuitId]
    "What's the lap record at this circuit?",
    "Who has won the most races here?",
    "What makes this circuit challenging to drive?",
    # /circuits
    "Who has the most wins at Monaco in F1 history?",
    "Which circuit has produced the most overtakes?",
    "What's the fastest circuit on the calendar?",
    # /telemetry
    "What's happening in the session right now?",
    "Who's currently fastest on track?",
    "Explain what these telemetry traces show",
    # /history
    "Who has the most world championships?",
    "What was the closest title fight in F1 history?",
    "Tell me about a famous rivalry in F1 history",
)

DEFAULT_SUGGESTIONS: tuple[str, ...] = (
    "Who won the last race?",
    "Compare Verstappen and Norris this season",
    "Who has the most wins at Monaco in F1 history?",
)

# Deduplicated, order-preserving — `DEFAULT_SUGGESTIONS` repeats two of
# `ROUTE_SUGGESTIONS`' own strings verbatim (the frontend list does too), and
# pre-warming the same exact text twice would just be a wasted second run
# that immediately hits its own freshly-written cache row.
SUGGESTED_QUESTIONS: tuple[str, ...] = tuple(
    dict.fromkeys((*ROUTE_SUGGESTIONS, *DEFAULT_SUGGESTIONS))
)

# The subset whose correct answer changes on its own as the season moves —
# see the module docstring's "volatile subset" section. Intentionally the
# same four questions `fast_path.py` fast-paths (Task B), not a coincidence:
# both modules independently arrived at "the small set with one current,
# unambiguous answer." Written out in full here rather than imported from
# `fast_path.detect`, because that function answers "does this exact
# phrasing match", not "which of the cached suggestions are volatile" — two
# different questions that happen to share an intent list today but have no
# reason to share an implementation.
VOLATILE_QUESTIONS: tuple[str, ...] = (
    "Who won the last race?",
    "When is the next race?",
    "Who's leading the drivers' championship?",
)


# --------------------------------------------------------------------------
# Running one question through the real pipeline
# --------------------------------------------------------------------------


async def _run_and_cache(question: str, *, db: Any = None) -> dict:
    """Run `question` through `graph.astream_answer` for real and cache it if
    `should_cache` says it is safe to.

    Deferred import of `graph` (LangChain/LangGraph/deepagents) so this
    module's question list and cache-key logic stay importable — and this
    function's docstring readable in a diff — without paying that import cost
    for every other use of this module (`--dry-run`, `--only` filtering,
    listing questions), matching `graph.build_agent`'s own deferred
    `create_deep_agent` import for the identical reason.
    """
    from . import graph

    ledger = EvidenceLedger()
    # Never a real conversation thread — each question is a fresh, isolated
    # turn, and `checkpointer=None` below means nothing is persisted under
    # this id anyway. Still unique per call so two questions in the same
    # process can never be confused if a future edit makes this concurrent.
    thread_id = f"prewarm-{uuid.uuid4()}"

    answer_parts: list[str] = []
    answer_visuals: list[dict] = []
    tier: int | None = None
    verification_status: str | None = None

    try:
        async for event in graph.astream_answer(
            question, thread_id=thread_id, ledger=ledger, checkpointer=None
        ):
            kind = event[0]
            if kind == "token":
                answer_parts.append(event[1])
            elif kind == "tier":
                tier = event[1]
            elif kind == "verification":
                verification_status = "passed" if event[1] else "verification_failed"
            elif kind == "visual":
                answer_visuals.append(event[1])
            elif kind == "degraded":
                # Step-budget exhaustion — streams as ordinary tokens per
                # `graph.py`'s own docstring, which is exactly why this
                # status has to be tracked explicitly rather than inferred
                # from the text: `should_cache` below is what keeps a
                # transient exhaustion from being written down as a
                # permanent answer.
                verification_status = event[1]
            # "activity" carries no information this batch job acts on —
            # there is no timeline UI here to show it in.
    except model_seam.ModelUnavailable as error:
        return {"question": question, "status": "no_model_configured", "detail": str(error)}
    except model_seam.ModelError as error:
        # `ModelAtCapacity`/`ModelTimeout`/a bare `ModelError` — logged and
        # skipped, not fatal to the run. See the module docstring's "one
        # real risk this does not solve" section for why a single collision
        # with live traffic is expected, not exceptional.
        return {"question": question, "status": "model_error", "detail": str(error)}
    except Exception as error:  # noqa: BLE001 - one bad question must not kill the sweep
        return {
            "question": question,
            "status": "error",
            "detail": f"{type(error).__name__}: {error}",
        }

    answer_text = "".join(answer_parts)
    answer_anchors = [a.to_dict() for a in verifier.anchors(answer_text, ledger)]
    answer_sources = ledger.anchored_citations(answer_anchors)

    if not answer_cache.should_cache(mode="model", verification=verification_status):
        return {
            "question": question,
            "status": "not_cacheable",
            "verification": verification_status,
        }

    await answer_cache.set_cached(
        question,
        config.PROMPT_VERSION,
        tier=tier,
        text=answer_text,
        sources=answer_sources,
        visuals=answer_visuals,
        db=db,
    )
    return {"question": question, "status": "cached", "tier": tier}


async def prewarm_question(question: str, *, force: bool = False, db: Any = None) -> dict:
    """Cache `question`'s answer unless it is already cached and `force` is
    False. See the module docstring for why "already cached" is the default
    reason to do nothing at all, not a lesser check than actually running it.
    """
    if not force:
        cached = await answer_cache.get_cached(question, config.PROMPT_VERSION, db=db)
        if cached is not None:
            return {"question": question, "status": "skipped_already_cached"}
    return await _run_and_cache(question, db=db)


async def prewarm_all(
    questions: "tuple[str, ...] | list[str]", *, force: bool = False, db: Any = None
) -> list[dict]:
    """Prewarm every question in `questions`, strictly one at a time.

    Sequential on purpose, not `asyncio.gather` — see the module docstring's
    "one real risk this does not solve" section: this process must never be
    more than one extra concurrent caller against Ollama Cloud's single-slot
    free tier, and firing several `astream_answer` calls at once from here
    would turn a rare collision into a routine one.
    """
    results = []
    for question in questions:
        result = await prewarm_question(question, force=force, db=db)
        results.append(result)
        print(f"prewarm: {result['status']:<24} {question!r}")
    return results


# --------------------------------------------------------------------------
# CLI entrypoint — `python -m agent.prewarm_cache [flags]`
# --------------------------------------------------------------------------


def _select_questions(args: argparse.Namespace) -> tuple[str, ...]:
    if args.refresh_volatile:
        return VOLATILE_QUESTIONS
    if args.only:
        wanted = [token.strip().lower() for token in args.only.split(",") if token.strip()]
        return tuple(q for q in SUGGESTED_QUESTIONS if any(w in q.lower() for w in wanted))
    return SUGGESTED_QUESTIONS


async def _main_async(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Pre-warm the Pitwall Assistant's answer cache for the "
        "frontend's suggested questions."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="re-run every selected question even if it is already cached "
        "for the current PROMPT_VERSION",
    )
    parser.add_argument(
        "--refresh-volatile",
        action="store_true",
        help="only re-run VOLATILE_QUESTIONS (implies --force) — the cheap "
        "cadence meant to run after every f1-data-sync execution; see the "
        "module docstring",
    )
    parser.add_argument(
        "--only",
        default=None,
        help="comma-separated substrings; only prewarm suggested questions "
        "containing one of them (case-insensitive). Ignored with "
        "--refresh-volatile.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print which questions would be prewarmed and exit without "
        "touching Mongo or Ollama",
    )
    args = parser.parse_args(argv)
    force = args.force or args.refresh_volatile
    questions = _select_questions(args)

    if args.dry_run:
        for question in questions:
            print(f"[dry-run] would prewarm ({'forced' if force else 'if not cached'}): {question!r}")
        return 0

    if not config.mongodb_uri():
        print("prewarm_cache: no MONGODB_URI configured — nothing to cache into. Exiting.")
        return 1
    if not config.api_key():
        print("prewarm_cache: no OLLAMA_API_KEY configured — cannot run the agent. Exiting.")
        return 1

    results = await prewarm_all(questions, force=force)
    summary = Counter(result["status"] for result in results)
    print(f"prewarm summary ({len(results)} question(s)): {dict(summary)}")
    # Never a nonzero exit for individual question failures — `model_error`/
    # `error` are already logged per-question above, and this script's own
    # fail-soft posture (matching `answer_cache.py`'s "never raise") treats a
    # partial sweep as a successful run that found less to do, not a failed
    # one. A future caller that wants to alert on a bad sweep can grep this
    # summary line rather than the process exit code.
    return 0


def main(argv: "list[str] | None" = None) -> int:
    return asyncio.run(_main_async(argv if argv is not None else sys.argv[1:]))


if __name__ == "__main__":
    raise SystemExit(main())
