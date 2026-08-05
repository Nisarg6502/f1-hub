"""Serialize agent runs against Ollama Cloud's one-concurrent-model free tier.

`CHAT-AGENT-PLAN.md` §4.2 and failure mode 6b: requests past the concurrency
limit are queued by Ollama to a fixed depth and then **rejected**. Discovering
that as a 429 in the middle of an answer is strictly worse than never sending
the second request, so the service holds its own gate and tells queued callers
where they are ("thinking, you're next") instead of failing them.

The honest limit of this module, stated here so nobody trusts it further than
it deserves: the gate is **per process**. Two Cloud Run instances would each
admit one run and both would hit the same shared quota. That is why the service
is pinned with `--max-instances=1` for as long as we are on the free tier — the
semaphore and the instance cap are one mechanism, not two, and removing either
silently disables the other.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass

from . import config


class AtCapacity(Exception):
    """Raised when a caller waited longer than the queue timeout allows."""

    def __init__(self, waited: float, queued_ahead: int):
        self.waited = waited
        self.queued_ahead = queued_ahead
        super().__init__(
            f"waited {waited:.0f}s behind {queued_ahead} request(s) without a slot"
        )


@dataclass
class _State:
    semaphore: asyncio.Semaphore | None = None
    waiting: int = 0
    running: int = 0


_state = _State()


def _semaphore() -> asyncio.Semaphore:
    """Create the semaphore lazily, inside the running event loop.

    Built at import time it would bind to whatever loop happened to exist then
    — which under uvicorn's reload and under `asyncio.run` in tests is not the
    loop that later awaits it, producing a "bound to a different event loop"
    error that reads like a concurrency bug and is really an import-order one.
    """
    if _state.semaphore is None:
        _state.semaphore = asyncio.Semaphore(config.MAX_CONCURRENT_RUNS)
    return _state.semaphore


def snapshot() -> dict:
    """Current gate state, for `/health` and for the queue-position message."""
    return {
        "running": _state.running,
        "waiting": _state.waiting,
        "limit": config.MAX_CONCURRENT_RUNS,
    }


@dataclass
class Admission:
    """How this caller got its slot.

    `waited` is the honest signal for the UI: zero means the request went
    straight through, anything above zero means the caller sat behind another
    question and the wait is worth narrating.
    """

    waited: float
    ahead: int

    @property
    def was_queued(self) -> bool:
        return self.waited > 0


@contextlib.asynccontextmanager
async def run_slot(timeout: float | None = None):
    """Hold a run slot, or raise `AtCapacity` after `timeout` seconds.

    Yields an `Admission` describing whether the caller had to queue.
    """
    limit = config.QUEUE_TIMEOUT_SECONDS if timeout is None else timeout
    semaphore = _semaphore()
    loop = asyncio.get_running_loop()
    started = loop.time()

    # Fast path. `Semaphore.acquire()` returns without suspending when the
    # counter is positive, so an uncontended caller never touches the waiting
    # accounting. Going through `wait_for` unconditionally instead would wrap
    # the acquire in a task that needs a full event-loop iteration to settle,
    # during which the caller is counted as `waiting` while `running` is still
    # 0 — which makes `snapshot()` lie, and made the only user on an idle
    # service see "Waiting for a free slot…".
    #
    # This is race-free only because of two CPython details, and **the
    # `python:3.11-slim` base image is therefore load-bearing for correctness
    # here, not just for compatibility**: `Semaphore.locked()` accounts for
    # queued waiters (so a newcomer cannot barge past them), and `acquire()`
    # on an uncontended semaphore returns without an await point (so nothing
    # can slip in between the check and the acquire). On the older semaphore
    # implementation this fast path would let a fresh caller jump the queue.
    if not semaphore.locked():
        await semaphore.acquire()
        admission = Admission(waited=0.0, ahead=0)
    else:
        ahead = _state.waiting
        _state.waiting += 1
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=limit)
        except asyncio.TimeoutError:
            raise AtCapacity(loop.time() - started, ahead) from None
        finally:
            _state.waiting -= 1
        admission = Admission(waited=loop.time() - started, ahead=ahead)

    _state.running += 1
    try:
        yield admission
    finally:
        _state.running -= 1
        semaphore.release()


def reset_for_tests() -> None:
    """Drop the semaphore so the next acquisition binds to a fresh loop.

    Each `asyncio.run` in the test suite creates and destroys a loop; without
    this, the second test reuses a semaphore bound to the first test's dead
    loop.
    """
    _state.semaphore = None
    _state.waiting = 0
    _state.running = 0
