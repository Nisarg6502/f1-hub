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
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import checkpointer, concurrency, config, graph, model, sse, tracing
from .ledger import EvidenceLedger


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

    # A fresh ledger per turn, per `graph.py`'s module docstring: two
    # concurrent requests must never share evidence ids, and a new thread
    # turn should not see citations from a previous one it did not itself
    # retrieve. Thread *conversation* memory still lives in the checkpointer;
    # this is only the evidence backing this turn's citations.
    ledger = EvidenceLedger()
    thread_id = request.thread_id or str(uuid.uuid4())

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
        tier: int | None = None

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
                    )

                async with concurrency.run_slot() as admission:
                    # Only worth reporting if the wait was long enough to have
                    # been felt. Below that it rounds to "Waited 0s", which
                    # reads as a bug rather than as reassurance.
                    if admission.waited >= 1.0:
                        yield sse.activity(
                            f"Waited {admission.waited:.0f}s for a slot.", "done"
                        )
                    yield sse.activity("Thinking…", "start")

                    async for event in _answer(text, thread_id=thread_id, ledger=ledger):
                        kind = event[0]
                        if kind == "token":
                            _, delta = event
                            chars += len(delta)
                            yield sse.token(delta)
                        elif kind == "activity":
                            _, label, state = event
                            yield sse.activity(label, state)
                        elif kind == "tier":
                            _, tier, _reason = event

            except model.ModelUnavailable:
                # No key configured: fall back to the echo so the transport is
                # still provable. Explicitly surfaced, never silent.
                mode = "echo"
                yield sse.activity(
                    "Inference is not configured — echoing to verify the stream.",
                    "done",
                )
                async for delta in _echo(text):
                    chars += len(delta)
                    yield sse.token(delta)

            yield sse.activity("Thinking…", "done")
            yield sse.sources(ledger.citations())
            yield sse.done(
                run_id=rid,
                mode=mode,
                model=config.DEFAULT_MODEL,
                prompt_version=config.PROMPT_VERSION,
                tier=tier,
                elapsed_ms=int((time.monotonic() - started) * 1000),
            )
            tracing.end(run, {"mode": mode, "chars": chars, "evidence": len(ledger), "tier": tier})

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


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8100)
