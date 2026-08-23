"""`f1-agent` — the Pitwall Assistant service.

CP59 proved the deployment path: SSE, the run gate, the error vocabulary and
LangSmith tracing, all against a plain streamed chat completion with no
tools. CP61 is this file's payoff — `_answer` now runs the CP61 deep agent
(`agent/graph.py`, all of CP60's internal tools bound directly, no
subagents, no verifier) instead of a bare model call, and every other piece
of the transport below is untouched from CP59 on purpose: that transport was
proven against the *deployed* service, and Batch 16's whole retrospective is
that re-deriving a working piece while building the next one is how you lose
a checkpoint's worth of time to a bug that was never really about the new
code.

Run locally:

    cd backend && python -m uvicorn agent.main:app --port 8100 --reload
"""

from __future__ import annotations

import asyncio
import datetime
import time
import uuid
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from . import (
    answer_cache,
    checkpointer,
    concurrency,
    config,
    followups,
    graph,
    guardrails,
    model,
    rate_limit,
    sse,
    tracing,
    verifier,
    visuals,
)
from .ledger import EvidenceLedger


HEARTBEAT_SECONDS = 15.0
"""How long `_stream` tolerates silence before emitting `sse.comment()`.

Comfortably under common intermediary idle-timeouts, generous enough not to
spam a fast turn. See `sse.comment`'s docstring for why this exists at all —
a deep agent thinking for 30-60s before its first token looks like a dead
socket to anything sitting between the browser and Cloud Run.
"""


async def _heartbeat_until_done(
    task: "asyncio.Task", *, interval: float | None = None
) -> AsyncIterator[str]:
    """Yield `sse.comment()` every `interval` seconds `task` stays pending.

    Does not touch `task` itself — never cancels it, never races it away.
    `asyncio.wait_for` was considered and rejected here specifically because
    it cancels its awaitable on timeout; that would drop whatever `task` was
    doing (the next agent event, the next queue check) the moment the clock
    ran out, which is the exact bug this function exists to avoid. Polling
    with `asyncio.wait(..., timeout=...)` in a loop lets the same pending
    task be re-checked indefinitely instead.

    Once `task` completes (successfully or with an exception) this simply
    stops yielding — an async generator "returning" a value isn't legal
    syntax, so the caller retrieves the outcome by `await`-ing the same
    `task` object after the loop, which is instant since it is already done.
    """
    wait_seconds = HEARTBEAT_SECONDS if interval is None else interval
    while not task.done():
        await asyncio.wait({task}, timeout=wait_seconds)
        if not task.done():
            yield sse.comment("heartbeat")


def _now_iso() -> str:
    """A live UTC timestamp for `sse.activity`'s `at` field.

    `sse.py`'s docstring says `at` should "always" be present — this is the
    one place in the module that stamps it, so every direct `sse.activity(...)`
    call below (and the tuple-unpacking path that already did this) uses the
    same clock read at the same point: when the event is actually put on the
    wire, not when the underlying step started.
    """
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # Opened once, held for the process lifetime — see `checkpointer.py`'s
    # docstring for why a per-request `with` block is wrong for a sync
    # context manager guarding async methods. Degrades to `None` (no thread
    # memory) rather than failing startup when `MONGODB_URI` is absent, which
    # is every local dev run and every test that does not explicitly set it.
    checkpointer.open_saver()
    try:
        yield
    finally:
        checkpointer.close_saver()


app = FastAPI(title="F1 Agent", version="0.1.0", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    # Flipped to True by the rate limiter, which is the first thing here that
    # is credentialed at all. Before it this read "no cookies, no auth header,
    # nothing credentialed — so allowing credentials would widen the surface
    # for nothing"; `rate_limit.SESSION_COOKIE` is now a cookie, the frontend
    # and the agent are separate Cloud Run origins, and a cross-site request
    # without this flag simply never sends it — which would silently downgrade
    # every browser caller to their shared IP identity while looking like it
    # worked.
    #
    # The reason that comment gave for keeping it False still stands and is now
    # a constraint rather than a preference: `allow_credentials=True` and a
    # literal `*` origin are mutually exclusive per the CORS spec, so this ties
    # the service permanently to the explicit origin list `config.ALLOWED_ORIGINS`
    # already defaults to. That is the direction we wanted anyway (see that
    # constant's own note on why `*` is wrong for a service rationing a shared
    # quota) — but it means a future `AGENT_ALLOWED_ORIGINS=*` would now fail
    # loudly at startup instead of quietly being permissive.
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

_TRACING_LIVE = tracing.configure()


class ChatRequest(BaseModel):
    """The chat request body, with a HARD ceiling on every field.

    These `max_length`s are an abuse ceiling, not the product limit. Pydantic
    enforces them before the handler runs -- before `estimate_cost` reads the
    message, before a rate-limit decision is taken, before a ledger exists --
    which is the whole point: without them FastAPI happily parses whatever
    Cloud Run accepts, and Cloud Run's request ceiling is 32 MiB. An
    unauthenticated endpoint that will parse a 32 MiB body and then run a cost
    estimator over it is a free way to burn the instance this service is
    limited to one of.

    `message` is capped at 8000 rather than the 4000 the product actually
    allows, and the gap is deliberate. The 4000-character limit is enforced
    further down as a streamed `bad_request` carrying a sentence a person can
    read; moving it here would replace that with a bare 422 and a Pydantic
    error blob. So ordinary overshoot keeps the good message, and only lengths
    no honest client would send are refused at the door.
    """

    message: str = Field(..., max_length=8000, description="The user's question")
    thread_id: str | None = Field(
        None,
        max_length=64,
        description="Conversation id; reserved for CP61's checkpointer",
    )


@app.get("/health")
async def health() -> dict:
    """Liveness plus the three facts that are otherwise guesswork in prod.

    Which model is actually loaded, whether tracing is really on, and whether
    the run gate is saturated. Batch 16 lost a full debugging cycle to a
    credentials path that failed silently; a health endpoint that only says
    "ok" invites the same class of blind debugging.
    """
    return {
        "status": "ok",
        "service": "f1-agent",
        "model": config.DEFAULT_MODEL,
        "inference_configured": bool(config.api_key()),
        "langsmith_tracing": _TRACING_LIVE,
        "thread_memory": checkpointer.current() is not None,
        "prompt_version": config.PROMPT_VERSION,
        "runs": concurrency.snapshot(),
        # Whether the limiter is on, and how much of today's budget this
        # process has watched go out. Process-local by construction (see
        # `rate_limit.budget_snapshot`) — with `--max-instances=1` that is the
        # service, and if that pin is ever lifted this number becomes a lower
        # bound rather than a total, which is worth knowing from the endpoint
        # rather than inferring from a dashboard.
        "rate_limit": rate_limit.budget_snapshot(),
    }


async def _echo(message: str) -> AsyncIterator[str]:
    """Stream the question back in word-sized chunks.

    Not a toy. It is the only way to verify the SSE path end to end while the
    free-tier quota is exhausted — session limits reset every 5 hours (§4.2),
    and a deployment check that can only run when quota happens to be
    available is not a deployment check. The `done` event reports
    `mode: "echo"` so this can never be mistaken for a real answer.
    """
    for word in (message or "").split():
        yield word + " "
        await asyncio.sleep(0.02)


async def _answer(
    message: str, *, thread_id: str | None, ledger
) -> AsyncIterator[graph.AgentEvent]:
    """Run the CP61 deep agent for one turn.

    Yields `("activity", label, state)` and `("token", text)` tuples — the
    same vocabulary `graph.astream_answer` produces — so `_stream` can turn
    them into SSE frames without knowing anything about LangGraph. This is
    the one line CP59's docstring predicted would change; everything around
    it is untouched.
    """
    async for event in graph.astream_answer(
        message,
        thread_id=thread_id,
        ledger=ledger,
        checkpointer=checkpointer.current(),
    ):
        yield event


async def _stream(
    request: ChatRequest,
    *,
    identity: "rate_limit.Identity | None" = None,
    decision: "rate_limit.Decision | None" = None,
) -> AsyncIterator[str]:
    """Stream one turn, reconciling the rate limiter's up-front charge as it goes.

    `decision` is the receipt from `chat`'s admission check, which already
    charged this caller the *estimated* cost of the question before the response
    was committed. Every path out of this function that costs materially less
    than that estimate settles the difference — a cache hit, a guardrail
    refusal, a malformed message, a queue timeout that never reached the model.
    The paths that do NOT settle are the ones where real inference happened and
    then failed (upstream error, model timeout): quota was genuinely spent
    there, and the estimate is the closest honest figure available for it.
    """
    started = time.monotonic()
    text = (request.message or "").strip()
    refund_only = rate_limit.measured_cost(tier=None, refused=True)

    if not text:
        await rate_limit.settle(decision, actual_cost=refund_only)
        yield sse.error("bad_request", "message must not be empty")
        return
    if len(text) > 4000:
        await rate_limit.settle(decision, actual_cost=refund_only)
        yield sse.error("bad_request", "message is too long (4000 character limit)")
        return

    # CP67: refuse before any quota is spent — no ledger, no cache lookup, no
    # concurrency slot. `guardrails.check_input` is pure and model-free, so
    # this costs microseconds regardless of the answer.
    verdict = guardrails.check_input(text)
    if not verdict.allowed:
        # Which guard fired, not the raw message — the scope guard is
        # deliberately generous by design (see `guardrails.py`'s docstring)
        # specifically to avoid false positives, and that bet is otherwise
        # unmeasurable in production. Logging `verdict.code` only (never the
        # user's text) keeps this measurable without risking a PII leak
        # through the very guard whose whole purpose is catching PII.
        print(f"agent guard refused: {verdict.code}")
        # CP82 layer 4: the verdict this line already computed is the abuse
        # signal, reused rather than re-detected. One strike costs the caller
        # nothing they will notice; a caller producing them steadily pays a
        # rising multiplier on every subsequent question until they stop for an
        # hour (`rate_limit.record_abuse`). The request itself is refunded down
        # to `REFUSED_COST` — refusing cost us microseconds of regex, and
        # charging a full tier estimate for it would penalise the false
        # positives the scope guard is deliberately generous enough to produce.
        if identity is not None:
            rate_limit.record_abuse(identity, code=verdict.code)
        await rate_limit.settle(decision, actual_cost=refund_only)
        yield sse.error("refused", verdict.reason or "That message could not be processed.")
        return

    # A fresh ledger per turn, per `graph.py`'s module docstring: two
    # concurrent requests must never share evidence ids, and a new thread
    # turn should not see citations from a previous one it did not itself
    # retrieve. Thread *conversation* memory still lives in the checkpointer;
    # this is only the evidence backing this turn's citations.
    ledger = EvidenceLedger()
    thread_id = request.thread_id or str(uuid.uuid4())

    # CP66: a cache hit skips the model, the concurrency gate and the
    # evidence ledger entirely — it is not "one more thing checked before
    # the queue," it is a genuinely different, much shorter path, which is
    # the whole point (`CHAT-AGENT-PLAN.md` §4.2: "answer caching is
    # load-bearing, not an optimisation"). A cached answer only ever came
    # from a run that passed `answer_cache.should_cache` originally, so it
    # is safe to replay with `verification: "passed"` unconditionally.
    #
    # Gated on `config.mongodb_uri()` the same way `checkpointer.open_saver`
    # already degrades to "no thread memory" without one — this is not
    # optional defensiveness, it is what keeps every local dev run and every
    # test that never sets `MONGODB_URI` from attempting a real network
    # connection on the very first message. `answer_cache.get_cached` also
    # never raises on its own, but a bad/absent URI can hang a Motor client
    # attempting to connect rather than fail fast, which this check avoids
    # hitting at all.
    cached = await answer_cache.get_cached(text, config.PROMPT_VERSION) if config.mongodb_uri() else None
    if cached:
        # Settled first, before a single token goes out: a cache hit is the
        # cheapest path in the service (one Mongo read, no model call) and the
        # limiter must charge it that way, or the caching layer that exists to
        # protect the quota would count against the allowance as if it had spent
        # it. Charging by request count is precisely the mistake this avoids.
        await rate_limit.settle(
            decision, actual_cost=rate_limit.measured_cost(tier=cached.get("tier"), cached=True)
        )
        yield sse.activity(
            "Answered from cache", "start", kind="system", at=_now_iso()
        )
        for piece in graph._chunk_draft(cached.get("text") or ""):
            yield sse.token(piece)
        yield sse.activity(
            "Answered from cache", "done", kind="system", at=_now_iso()
        )
        # Flattened back out of the stored sources rather than stored twice:
        # the cache round-trips one `sources` blob, and an entry written before
        # CP72 simply carries none, which the frontend already has to handle
        # for every unanchored answer.
        # Between the tokens and `sources`, the same position a live turn puts
        # them in (`CHAT-VISUALS-CONTRACT.md` §4) — a replayed answer must be
        # indistinguishable on the wire from the turn that produced it, apart
        # from `cached: true`. Rehydrated through `VisualBuffer.from_dicts`
        # rather than splatted straight from Mongo, so a row written before
        # visuals existed (no key), or one carrying a partial payload, yields a
        # complete §4 frame with empty strings instead of a `TypeError` inside
        # an already-committed stream.
        for stored in visuals.VisualBuffer.from_dicts(cached.get("visuals")):
            yield sse.visual(**stored.to_dict())
        cached_sources = cached.get("sources") or []
        yield sse.sources(
            cached_sources,
            anchors=[
                anchor
                for source in cached_sources
                for anchor in (source.get("anchors") or [])
            ],
        )
        yield sse.done(
            run_id=None,
            mode="model",
            model=config.DEFAULT_MODEL,
            prompt_version=config.PROMPT_VERSION,
            tier=cached.get("tier"),
            verification="passed",
            cached=True,
            elapsed_ms=int((time.monotonic() - started) * 1000),
        )
        return

    with tracing.traced_run(
        "chat",
        {"message": text},
        thread_id=thread_id,
        model=config.DEFAULT_MODEL,
        prompt_version=config.PROMPT_VERSION,
    ) as run:
        rid = tracing.run_id(run)
        mode = "model"
        chars = 0
        answer_parts: list[str] = []
        # Zero, one or two `visual` payloads (`CHAT-VISUALS-CONTRACT.md` §4),
        # collected as they stream so the same list can be handed to the cache
        # write below — the replay path has no agent run to regenerate them
        # from, and does not need one.
        answer_visuals: list[dict] = []
        tier: int | None = None
        # None for tier 1 (CP64 skips verification there — see graph.py's
        # astream_answer docstring) and for the echo fallback, neither of
        # which yields a "verification" event.
        verification_status: str | None = None
        verification_violations: int | None = None
        # The rate limiter's reconciliation, set by whichever path this turn
        # takes and applied once in the `finally` below. `None` means "leave
        # the up-front estimate standing" — see this function's docstring.
        settle_cost: float | None = None
        queued_ms = 0

        # CP75: the run slot is entered here rather than with a plain
        # `async with`, because it now has to stay held *past* the `done`
        # event. `followups.suggest` makes a real model call, and Ollama
        # Cloud's free tier serves exactly one concurrent model — firing that
        # call after the slot released would race whatever the gate admitted
        # next, which is the single failure `concurrency.py` exists to
        # prevent. An `AsyncExitStack` lets the acquire stay inside the inner
        # `try` (so `AtCapacity` is still caught by the chain below, which
        # never entered the stack and unwinds to a no-op) while the release
        # moves down to after the chips are on the wire. `aclose()` is
        # idempotent, so the explicit release on the success path and the
        # `finally` backstop cannot double-release.
        run_gate = AsyncExitStack()

        try:
            try:
                # Announce the queue *before* blocking on the gate, so a wait
                # behind another user reads as progress rather than as a hung
                # request. `snapshot()` is only consulted here — the authority
                # on whether this caller actually queued is the `Admission` it
                # gets back, since the gate can free up in between.
                gate = concurrency.snapshot()
                if gate["running"] or gate["waiting"]:
                    ahead = gate["waiting"]
                    yield sse.activity(
                        "You're next — one question is answered at a time."
                        if not ahead
                        else f"Queued — {ahead} question(s) ahead of you.",
                        "start",
                        kind="system",
                        at=_now_iso(),
                    )

                admission = await run_gate.enter_async_context(
                    concurrency.run_slot()
                )
                # Time spent queued behind somebody else's question is not
                # this caller's model time, and `rate_limit.measured_cost`
                # refuses to bill it as such — so it is captured here, at the
                # only point that knows it, and subtracted below.
                queued_ms = int(admission.waited * 1000)
                # Only worth reporting if the wait was long enough to have
                # been felt. Below that it rounds to "Waited 0s", which
                # reads as a bug rather than as reassurance.
                if admission.waited >= 1.0:
                    yield sse.activity(
                        f"Waited {admission.waited:.0f}s for a slot.",
                        "done",
                        kind="system",
                        at=_now_iso(),
                    )
                yield sse.activity(
                    "Thinking…", "start", kind="system", at=_now_iso()
                )

                # Driven manually (rather than `async for`) so each step
                # of pulling the next event can be raced against
                # `HEARTBEAT_SECONDS` of silence without losing the event
                # that's still in flight when the clock runs out — see
                # `_heartbeat_until_done`'s docstring. This is the one
                # genuinely unbounded silence in the turn (model thinking,
                # tool calls); the queue-wait above it is bounded by
                # `config.QUEUE_TIMEOUT_SECONDS` (45s default) and always
                # resolves into a clean `AtCapacity` error on its own, so
                # it does not get the same treatment here.
                answer_iter = _answer(
                    text, thread_id=thread_id, ledger=ledger
                ).__aiter__()
                next_task: "asyncio.Task | None" = None
                try:
                    while True:
                        next_task = asyncio.ensure_future(answer_iter.__anext__())
                        async for heartbeat in _heartbeat_until_done(next_task):
                            yield heartbeat
                        try:
                            event = await next_task
                        except StopAsyncIteration:
                            break

                        kind = event[0]
                        if kind == "token":
                            _, delta = event
                            chars += len(delta)
                            answer_parts.append(delta)
                            yield sse.token(delta)
                        elif kind == "activity":
                            if len(event) == 5:
                                _, label, state, detail, activity_kind = event
                            else:
                                _, label, state = event
                                detail, activity_kind = None, "system"
                            yield sse.activity(
                                label, state, detail=detail, kind=activity_kind,
                                at=_now_iso(),
                            )
                        elif kind == "tier":
                            _, tier, _reason = event
                        elif kind == "verification":
                            _, passed, violation_count = event
                            verification_status = "passed" if passed else "verification_failed"
                            verification_violations = violation_count
                        elif kind == "visual":
                            # `CHAT-VISUALS-CONTRACT.md` §4. `graph.py`
                            # yields these after the last token, so simply
                            # forwarding them in arrival order puts them
                            # between the answer and `sources` — no
                            # sequencing logic here to fall out of step with
                            # that guarantee. Kept for the cache write too:
                            # a visual is a pure function of `(code, data)`
                            # (§7), so a replay of this answer must show the
                            # same picture.
                            _, payload = event
                            answer_visuals.append(payload)
                            yield sse.visual(**payload)
                        elif kind == "degraded":
                            # The step-budget degrade (see graph.py). It reads
                            # as a normal answer on the wire by design, which
                            # is exactly why the cache needs to be told.
                            _, verification_status = event
                finally:
                    # `_heartbeat_until_done` deliberately never cancels
                    # `next_task` (see its docstring) — polling with
                    # `asyncio.wait` must not drop the in-flight event.
                    # But that means nothing upstream of it cancels the
                    # *real* model/tool call either, and `asyncio.wait`
                    # does not propagate a cancellation of itself onto
                    # the task it was waiting on (a well-documented
                    # asyncio gotcha). Left alone, a client disconnect
                    # here would let this loop's own `CancelledError`
                    # sail through cleanly while `next_task` — the actual
                    # live `_answer.__anext__()` call — kept running
                    # detached in the background, still burning quota
                    # for a request nobody is listening to. This is the
                    # one place that can still be true when the loop
                    # exits, for any reason (normal `StopAsyncIteration`,
                    # an exception from `_answer`, or our own
                    # cancellation), so it is the one place responsible
                    # for making sure `next_task` never outlives it.
                    if next_task is not None and not next_task.done():
                        next_task.cancel()
                        try:
                            await next_task
                        except BaseException:
                            # Cancellation landing inside `_answer` can
                            # surface as `CancelledError`,
                            # `StopAsyncIteration`, or whatever the
                            # underlying call was doing when the
                            # cancellation hit it — none of those are
                            # this function's to report, and none may be
                            # left unretrieved (that logs an "exception
                            # was never retrieved" warning once the task
                            # is garbage collected).
                            pass

            except model.ModelUnavailable:
                # No key configured: fall back to the echo so the transport is
                # still provable. Explicitly surfaced, never silent.
                mode = "echo"
                yield sse.activity(
                    "Inference is not configured — echoing to verify the stream.",
                    "done",
                    kind="system",
                    at=_now_iso(),
                )
                async for delta in _echo(text):
                    chars += len(delta)
                    yield sse.token(delta)

            yield sse.activity("Thinking…", "done", kind="system", at=_now_iso())
            # CP72: the source list is derived from the finished answer, not
            # from the ledger, so it names the records the answer actually
            # leaned on rather than everything the tools happened to fetch.
            # Run here rather than inside `graph.py`'s verify step because this
            # is the only place holding the whole assembled draft — the repair
            # loop can replace a draft after verification, and anchoring the
            # rejected one would mark spans that are no longer in the text.
            # `verifier.anchors` is total in the same way `Evidence.locate` is,
            # so a bundle it cannot walk yields no anchors rather than costing
            # the reader the answer they are already looking at.
            answer_anchors = [
                anchor.to_dict()
                for anchor in verifier.anchors("".join(answer_parts), ledger)
            ]
            answer_sources = ledger.anchored_citations(answer_anchors)
            elapsed_ms = int((time.monotonic() - started) * 1000)
            # The turn's real price, replacing the tier estimate charged before
            # the stream opened. `mode == "echo"` means no key was configured
            # and nothing was inferred at all, so it settles like a refusal.
            settle_cost = (
                refund_only
                if mode == "echo"
                else rate_limit.measured_cost(
                    tier=tier, model_ms=max(0, elapsed_ms - queued_ms)
                )
            )
            yield sse.sources(answer_sources, anchors=answer_anchors)
            yield sse.done(
                run_id=rid,
                mode=mode,
                model=config.DEFAULT_MODEL,
                prompt_version=config.PROMPT_VERSION,
                tier=tier,
                verification=verification_status,
                elapsed_ms=elapsed_ms,
            )
            tracing.end(
                run,
                {
                    "mode": mode,
                    "chars": chars,
                    "evidence": len(ledger),
                    "tier": tier,
                    "verification": verification_status,
                    "verification_violations": verification_violations,
                },
            )

            # CP75's follow-up chips: after `done` — deliberately, and after
            # `tracing.end` so the turn's own telemetry is settled whatever
            # this does — but *before* the run slot is released, which is the
            # part that is easy to get wrong. `followups.suggest` is a real
            # model call, and Ollama Cloud's free tier serves one concurrent
            # model; released first, this would be the second caller the gate
            # was built to prevent. Held here, the reader already has the
            # complete answer and its sources, and the only cost is that the
            # *next* asker's slot opens up to `followups.TIMEOUT_SECONDS`
            # later — bounded, and paid only on turns that got that far.
            #
            # `suggest` is total: no key, a timeout, exhausted quota,
            # unparseable output, or a candidate set the router emptied all
            # return `[]`. An empty list emits no frame at all rather than an
            # empty one, so "no chips" is one state on the wire, not two.
            # The echo fallback is excluded because its "answer" is the
            # question echoed back — there is nothing to follow up on, and it
            # runs precisely when no key is configured anyway.
            # Belt and braces on top of `suggest`'s own totality, and not
            # redundant: the outer except chain below is *already past* the
            # point where it can help. It would turn an exception here into an
            # `error` frame emitted after `done`, and the frontend treats an
            # error on a message as replacing its answer — so a bug in an
            # optional surface would blank out a complete, correct answer the
            # reader is already looking at. Nothing this far down the turn may
            # reach that handler.
            if mode != "echo":
                try:
                    chips = await followups.suggest(text, "".join(answer_parts))
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - additive surface
                    print(f"follow-up chips skipped: {type(error).__name__}: {error}")
                    chips = []
                if chips:
                    yield sse.suggestions(chips)

            # Everything below this point is off the critical path and must
            # not hold a slot the next caller is queued for.
            await run_gate.aclose()

            # After `done` is already on the wire — a slow or failed cache
            # write must never delay or break the response the asker is
            # already reading. `should_cache` is the one gate that decides
            # whether a `verification_failed` answer gets excluded (see
            # `answer_cache.py`'s module docstring for why that matters).
            if config.mongodb_uri() and answer_cache.should_cache(
                mode=mode, verification=verification_status
            ):
                await answer_cache.set_cached(
                    text,
                    config.PROMPT_VERSION,
                    tier=tier,
                    text="".join(answer_parts),
                    # The anchored list, so a replay renders identically to the
                    # turn that produced it. `answer_cache`'s `sources=` is the
                    # only channel available for this, which is why the anchors
                    # ride nested inside each source rather than alongside them
                    # — the replay path flattens them back out.
                    sources=answer_sources,
                    # §7's last row. Stored with the answer rather than
                    # rebuilt, because rebuilding would mean re-running the
                    # tools to refill a ledger — which is the entire cost the
                    # cache exists to avoid — and because a visual is a pure
                    # function of `(code, data)`, so the stored pair replays
                    # to the identical picture.
                    visuals=answer_visuals,
                )

        # CP73: these three used to blur into one apology. They are three
        # different events with three different things the reader can do
        # about them, and the copy now says which one happened.
        #
        # The batch-20 design note calls the old wording out directly —
        # "the `at_capacity` copy is misleading when the true cause is a slow
        # answer rather than contention". It was misleading in a specific,
        # reproducible way: a comparative question that ran long would leave
        # the *next* asker waiting on the semaphore until the queue timeout,
        # and that asker was told the assistant was "busy" with no hint that
        # waiting a moment was in fact the right move, while the person whose
        # slow question caused it was told nothing distinguishable at all.
        #
        # The SSE codes are unchanged and deliberately so — `sse.py`'s
        # `ERROR_CODES` is owned by another checkpoint this batch, and the
        # frontend already branches on these three. Only the human-readable
        # message differs, which is where the ambiguity actually lived.
        except concurrency.AtCapacity as error:
            # Waited out the queue and never reached a model — zero inference,
            # so the estimate charged up front is refunded down to nothing.
            settle_cost = refund_only
            yield sse.error(
                "at_capacity",
                "Another question is being answered right now — this plan runs "
                f"one at a time, and yours waited {error.waited:.0f}s for a turn "
                "without getting one. Nothing is wrong with your question; ask "
                "it again in a moment.",
            )
            tracing.end(run, {"error": "queue_timeout", "waited": error.waited})

        except model.ModelAtCapacity as error:
            yield sse.error(
                "at_capacity",
                "The assistant has run out of inference quota for now — this is "
                "the free tier's daily allowance, not a problem with your "
                "question. It resets within a few hours, and cached answers "
                "still work in the meantime.",
            )
            tracing.end(run, {"error": "quota", "detail": str(error)})

        except model.ModelTimeout as error:
            yield sse.error(
                "timeout",
                "This question took too long to answer and was stopped before "
                "it finished — it needed more research than one turn allows. "
                "A narrower question (one driver, one season, one race) will "
                "usually get through.",
            )
            tracing.end(run, {"error": "timeout", "detail": str(error)})

        except model.ModelError as error:
            print(f"agent upstream failure: {error}")
            yield sse.error("upstream", "The assistant's model is unavailable.")
            tracing.end(run, {"error": "upstream", "detail": str(error)})

        except asyncio.CancelledError:
            # The client closed the tab. Re-raised so the slot's `finally`
            # releases and the next queued caller is admitted immediately
            # rather than waiting out the timeout.
            tracing.end(run, {"error": "cancelled"})
            raise

        except Exception as error:  # noqa: BLE001 - a stream must end cleanly
            print(f"agent internal failure: {type(error).__name__}: {error}")
            yield sse.error("internal", "Something went wrong answering that.")
            tracing.end(run, {"error": "internal", "detail": str(error)})

        finally:
            # The backstop for every path that does not reach the explicit
            # release above: an error handler, a client disconnect, or the
            # generator being closed mid-stream. Since CP75 moved the slot's
            # lifetime out of an `async with`, this is the thing standing
            # between a failed turn and a permanently-held gate — `aclose()`
            # is idempotent, so running it twice on the success path is a
            # no-op, and running it on a stack that never acquired a slot
            # (the `AtCapacity` path) is also a no-op.
            await run_gate.aclose()

            # One reconciliation per turn, here rather than at each `yield
            # sse.done`/`sse.error` site, so no future path can forget it.
            # `settle` is itself total, but this is also the one place a
            # cancelled client can land, and a bookkeeping error must never be
            # what a reader sees — `CancelledError` is deliberately NOT caught
            # (it is `BaseException`, not `Exception`), so a disconnect still
            # propagates to release the gate as CP75 intends.
            if settle_cost is not None:
                try:
                    await rate_limit.settle(decision, actual_cost=settle_cost)
                except Exception as error:  # noqa: BLE001 - bookkeeping only
                    print(f"rate_limit settle skipped: {type(error).__name__}: {error}")


@app.post("/api/chat")
async def chat(request: ChatRequest, http: Request):
    """Stream an answer as Server-Sent Events, or refuse with a 429.

    POST rather than GET, so `EventSource` cannot be used on the client — the
    frontend reads the body with `fetch` + a stream reader instead. That is a
    deliberate trade: questions can be long and multi-turn state belongs in a
    body, and EventSource's only real advantage (automatic reconnect) is wrong
    here anyway, since silently re-running an agent turn would double-charge a
    quota we are already rationing.

    **The rate-limit check runs here, not in `_stream`, and that placement is
    the whole reason this endpoint can return a status code at all.**
    `sse.py`'s contract — every failure is an SSE `error` event, never a 4xx —
    is a consequence of *when* its failures occur: by then the response is
    committed with 200 and a status code has nowhere to go. A refusal decided
    before `StreamingResponse` is constructed has no such problem, so it gets
    the standard, intermediary-legible answer: **429 with `Retry-After`**, which
    a proxy, a CDN, a monitoring probe and a `fetch` retry helper all understand
    and none of which parse `text/event-stream` looking for an event. It also
    keeps abuse visible in Cloud Run's own request metrics instead of hiding it
    behind a wall of 200s. See `rate_limit.py`'s module docstring for the full
    argument and for why `sse.ERROR_CODES` was left alone rather than widened.

    The cookie is attached to the *streaming* response as well as to the
    refusal, because headers are sent before the body: a caller refused on their
    first request still leaves with an identity, so their next attempt is
    measured against their own allowance rather than the whole CGNAT range's.
    """
    identity = rate_limit.identify(http)
    decision = await rate_limit.check_and_charge(
        identity, cost=rate_limit.estimate_cost(request.message or "")
    )
    if not decision.allowed:
        refusal = JSONResponse(
            decision.http_body(),
            status_code=429,
            headers={"Retry-After": str(decision.retry_after)},
        )
        rate_limit.attach_session_cookie(refusal, identity, http)
        return refusal

    response = StreamingResponse(
        _stream(request, identity=identity, decision=decision),
        media_type=sse.MEDIA_TYPE,
        headers=sse.SSE_HEADERS,
    )
    rate_limit.attach_session_cookie(response, identity, http)
    return response


# Fixed, arbitrary namespace for deriving feedback ids below — any stable
# UUID works here; it only has to be constant across process restarts so the
# same `run_id` always maps to the same `feedback_id`. Not `uuid.NAMESPACE_DNS`
# or another well-known namespace, to avoid colliding with ids anyone else
# might derive the same way for an unrelated purpose.
_FEEDBACK_NAMESPACE = uuid.UUID("7f2b6e5a-2a34-4b7e-9d33-6f0a3c9d5e21")


class FeedbackRequest(BaseModel):
    # Deliberately required (not `Optional[str]`): a caller sending a
    # null/missing `run_id` gets a 422, not a soft `{"recorded": false}`.
    # `FeedbackControls` never renders/submits without a truthy `run_id` in
    # the first place (see that component's docstring), so a null here is a
    # client bug worth surfacing, not telemetry to swallow — matches
    # `test_agent_feedback.py`'s `test_null_run_id_is_a_pydantic_422_and_calls_nothing`.
    run_id: str = Field(
        ..., max_length=128, description="The LangSmith run id from the matching `done` event"
    )
    score: int = Field(..., description="1 for thumbs up, -1 for thumbs down")
    # Bounded because this is unauthenticated free text that is written
    # straight to Mongo. Unbounded, it is a way for anyone to fill a 512MB
    # free-tier cluster one POST at a time. 2000 characters is far more than
    # anyone types into a thumbs-down box.
    comment: str | None = Field(
        None, max_length=2000, description="Optional free-text, typically on thumbs-down"
    )

    @field_validator("score")
    @classmethod
    def _score_is_a_thumb(cls, v: int) -> int:
        if v not in (-1, 1):
            raise ValueError("score must be 1 or -1")
        return v


FEEDBACK_COLLECTION = "agent_feedback"
"""Our own record of which `feedback_id`s have already been forwarded.

This is CP69's accepted-but-unproven risk closed on our side. See `feedback`'s
docstring for what it replaces and why the previous mitigation could not be
confirmed.
"""


async def _claim_feedback(feedback_id: str, request: "FeedbackRequest") -> bool:
    """True if this vote is new and should be forwarded; False if already sent.

    A single `update_one(..., $setOnInsert, upsert=True)`: the upsert is atomic,
    so two simultaneous double-click POSTs cannot both see "not present" and
    both forward. `upserted_id` is non-None only for the call that actually
    created the document, which makes "did I win the claim" a property of the
    write itself rather than of a read that raced it. `$setOnInsert` rather than
    `$set` so a replay cannot overwrite the original vote's timestamp or score
    — the first vote for a run is the one on file.

    **Fails open**: no Mongo URI (every local run and every test), an
    unreachable database, or any driver error means the vote is forwarded
    unconditionally. This is telemetry on an already fail-soft endpoint, and the
    failure this dedupe prevents — a duplicate row in a LangSmith feedback
    table — is smaller than the failure of silently dropping real votes because
    a database was briefly unavailable.
    """
    if not config.mongodb_uri():
        return True
    try:
        from app.db import get_db

        result = await asyncio.wait_for(
            get_db()[FEEDBACK_COLLECTION].update_one(
                {"_id": feedback_id},
                {
                    "$setOnInsert": {
                        "run_id": request.run_id,
                        "score": request.score,
                        "comment": request.comment,
                        "at": datetime.datetime.now(datetime.timezone.utc),
                    }
                },
                upsert=True,
            ),
            # A vote is fire-and-forget on the client; it must not be able to
            # hold a connection open through Motor's 30s server-selection
            # timeout. Same ceiling the rate limiter's own counters use.
            timeout=rate_limit.DB_TIMEOUT_SECONDS,
        )
        return result.upserted_id is not None
    except Exception as error:  # noqa: BLE001 - see docstring: fail open
        print(f"feedback dedupe unavailable: {type(error).__name__}: {error}")
        return True


@app.post("/api/feedback")
async def feedback(request: FeedbackRequest, http: Request) -> Any:
    """Forward a thumbs up/down to LangSmith, fail-soft.

    Telemetry, not the answer itself — a broken LangSmith install, an
    unconfigured project, or a missing run id (e.g. a cached answer, which
    never opens a trace) must degrade to `{"recorded": False}`, never a
    user-visible error. Matches `tracing.py`'s own bare-except discipline.

    `feedback_id` is derived deterministically from `run_id` (`uuid.uuid5`
    against `_FEEDBACK_NAMESPACE`) rather than left to LangSmith's default
    random id, so a repeated POST for the same `run_id` — a double-click
    landing before React commits the `disabled` state on the thumbs-up
    button (`feedback-controls.tsx`), or a devtools/curl replay — always
    produces the same id instead of a fresh one each time.

    **CP82 stops relying on that id alone.** Whether the installed `langsmith`
    SDK's backend treats a repeated `feedback_id` as an upsert was never
    confirmed — `Client.create_feedback`'s docstring does not document it, and
    the SDK ships a *separate* `Client.update_feedback(feedback_id, ...)`,
    which suggests create and update are genuinely distinct server-side
    operations rather than one POST upserting on id collision (`HANDOFF.md`,
    CP69: an accepted-but-unproven risk). The dedupe is now ours: the same
    derived id is claimed in our own Mongo collection *before* the forward, so
    a second POST is dropped here regardless of what the vendor does with a
    repeated id. The derivation is unchanged and still worth keeping — it is
    what gives us a stable key to claim.

    A duplicate returns `{"recorded": True}`, not `False`. The field answers
    "is this reader's vote on file", and for a replay it is — it was recorded
    the first time. Returning `False` would tell the client its vote was lost
    and invite a retry loop against the exact endpoint being deduped.

    Rate-limited on the same composite identity as `/api/chat`, at a token
    charge and with no draw against the daily inference budget: a vote costs no
    GPU time, so it must not consume the quota, but an unauthenticated write
    endpoint with no per-caller ceiling is still a way to flood a collection.
    """
    if config.RATE_LIMIT_ENABLED:
        vote_identity = rate_limit.identify(http)
        vote_decision = await rate_limit.check_and_charge(
            vote_identity, cost=rate_limit.FEEDBACK_COST, charge_global=False
        )
        if not vote_decision.allowed:
            return JSONResponse(
                vote_decision.http_body(),
                status_code=429,
                headers={"Retry-After": str(vote_decision.retry_after)},
            )

    if not _TRACING_LIVE or not request.run_id:
        return {"recorded": False}
    feedback_id = str(uuid.uuid5(_FEEDBACK_NAMESPACE, f"{request.run_id}:user-score"))
    if not await _claim_feedback(feedback_id, request):
        print(f"feedback duplicate suppressed for run {request.run_id}")
        return {"recorded": True}
    try:
        import langsmith

        client = langsmith.Client()
        await asyncio.to_thread(
            client.create_feedback,
            request.run_id,
            key="user-score",
            score=request.score,
            comment=request.comment,
            feedback_id=feedback_id,
        )
        return {"recorded": True}
    except Exception as exc:  # telemetry: degrade, never 500 the client — matches tracing.py's rule
        print(f"feedback not recorded: {exc}")
        return {"recorded": False}


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8100)
