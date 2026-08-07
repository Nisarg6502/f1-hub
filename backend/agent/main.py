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
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from . import (
    answer_cache,
    checkpointer,
    concurrency,
    config,
    graph,
    guardrails,
    model,
    sse,
    tracing,
    verifier,
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
    # No cookies, no auth header, nothing credentialed — so allowing
    # credentials would widen the surface for nothing. It also forbids a
    # genuine `*` should we ever want one, since the two are mutually
    # exclusive per the CORS spec.
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

_TRACING_LIVE = tracing.configure()


class ChatRequest(BaseModel):
    message: str = Field(..., description="The user's question")
    thread_id: str | None = Field(
        None, description="Conversation id; reserved for CP61's checkpointer"
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


async def _stream(request: ChatRequest) -> AsyncIterator[str]:
    started = time.monotonic()
    text = (request.message or "").strip()

    if not text:
        yield sse.error("bad_request", "message must not be empty")
        return
    if len(text) > 4000:
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
        tier: int | None = None
        # None for tier 1 (CP64 skips verification there — see graph.py's
        # astream_answer docstring) and for the echo fallback, neither of
        # which yields a "verification" event.
        verification_status: str | None = None
        verification_violations: int | None = None

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

                async with concurrency.run_slot() as admission:
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
            yield sse.sources(answer_sources, anchors=answer_anchors)
            yield sse.done(
                run_id=rid,
                mode=mode,
                model=config.DEFAULT_MODEL,
                prompt_version=config.PROMPT_VERSION,
                tier=tier,
                verification=verification_status,
                elapsed_ms=int((time.monotonic() - started) * 1000),
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
                )

        except concurrency.AtCapacity as error:
            yield sse.error(
                "at_capacity",
                "The assistant is busy right now — only one question can be "
                "answered at a time on the current inference plan. Try again "
                "in a moment.",
            )
            tracing.end(run, {"error": "queue_timeout", "waited": error.waited})

        except model.ModelAtCapacity as error:
            yield sse.error(
                "at_capacity",
                "The assistant has reached its inference quota. It resets "
                "within a few hours — cached answers still work in the "
                "meantime.",
            )
            tracing.end(run, {"error": "quota", "detail": str(error)})

        except model.ModelTimeout as error:
            yield sse.error("timeout", "The assistant took too long to respond.")
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


@app.post("/api/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    """Stream an answer as Server-Sent Events.

    POST rather than GET, so `EventSource` cannot be used on the client — the
    frontend reads the body with `fetch` + a stream reader instead. That is a
    deliberate trade: questions can be long and multi-turn state belongs in a
    body, and EventSource's only real advantage (automatic reconnect) is wrong
    here anyway, since silently re-running an agent turn would double-charge a
    quota we are already rationing.
    """
    return StreamingResponse(
        _stream(request),
        media_type=sse.MEDIA_TYPE,
        headers=sse.SSE_HEADERS,
    )


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
    run_id: str = Field(..., description="The LangSmith run id from the matching `done` event")
    score: int = Field(..., description="1 for thumbs up, -1 for thumbs down")
    comment: str | None = Field(None, description="Optional free-text, typically on thumbs-down")

    @field_validator("score")
    @classmethod
    def _score_is_a_thumb(cls, v: int) -> int:
        if v not in (-1, 1):
            raise ValueError("score must be 1 or -1")
        return v


@app.post("/api/feedback")
async def feedback(request: FeedbackRequest) -> dict:
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
    produces the same id instead of a fresh one each time. Whether the
    installed `langsmith` SDK's backend treats a repeated `feedback_id` as an
    upsert could not be confirmed: `Client.create_feedback`'s docstring does
    not document that behavior, and the SDK ships a *separate*
    `Client.update_feedback(feedback_id, ...)` method, which suggests
    create and update are genuinely distinct server-side operations rather
    than the same POST upserting on id collision. See `HANDOFF.md`'s CP69
    paragraph: this is applied as defense-in-depth (real dedupe if the
    backend does upsert on id collision; otherwise a harmless no-op), not
    relied on as a proven fix — server-side dedupe remains an accepted risk
    either way, appropriate for a telemetry-only, fail-soft, already
    unauthenticated endpoint.
    """
    if not _TRACING_LIVE or not request.run_id:
        return {"recorded": False}
    feedback_id = str(uuid.uuid5(_FEEDBACK_NAMESPACE, f"{request.run_id}:user-score"))
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
