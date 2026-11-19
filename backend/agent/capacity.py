"""Whether the model provider has said its allowance is used up.

When Ollama Cloud's usage cap is hit, every question that reaches the model
fails the same way, but only after the agent has spent its time on it: the first
reader to ask after the cap was measured at 32 seconds before being told so,
and so was everyone behind them. This keeps one note for the whole process, set
the first time a turn fails with `model.ModelAtCapacity`, so that:

- later questions are refused at once, before any model work, with a message
  that says when to come back (`main._stream`);
- `/health` reports it, so the frontend can say so *before* someone types
  (`getAgentHealth` -> `assistantAvailability`).

Cached answers are not affected: they cost no inference, so `_stream` serves
them before it asks this module anything.

Process-local on purpose. `f1-agent` runs `--max-instances=1` (see
`main.health`), so one process is the whole service; if that pin is ever lifted,
each instance finds out for itself on its first refused turn, which is correct
and merely slower.

The cooldown is a guess, because Ollama does not say when the allowance returns.
Too short costs one slow refusal per cooldown; too long refuses people who could
have been answered. Fifteen minutes errs towards the first.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

from . import config

COOLDOWN_S: int = config._int("AGENT_CAPACITY_COOLDOWN_S", 900)

_until: float | None = None


def record_exhausted(now: float | None = None) -> None:
    """Note that the provider just refused for lack of allowance."""
    global _until
    _until = (time.time() if now is None else now) + COOLDOWN_S


def exhausted_until(now: float | None = None) -> float | None:
    """Epoch seconds the note holds until, or `None` once it has lapsed."""
    if _until is None:
        return None
    return _until if (time.time() if now is None else now) < _until else None


def clear() -> None:
    global _until
    _until = None


def snapshot(now: float | None = None) -> dict:
    """The `/health` shape: `{"available": bool, "retry_at": ISO-8601 UTC | None}`."""
    until = exhausted_until(now)
    if until is None:
        return {"available": True, "retry_at": None}
    retry_at = datetime.fromtimestamp(until, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"available": False, "retry_at": retry_at}
