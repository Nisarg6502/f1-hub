"""LangSmith tracing, wired so that it can never break a chat.

deepagents is LangGraph underneath and LangGraph traces to LangSmith natively,
so from CP61 onward most spans appear without any code here. This module exists
for the two things that do not come for free:

1. **CP59 has no LangGraph yet**, and its done-criterion is that a trace
   appears in LangSmith. So the echo/stream path is traced explicitly.
2. **The run id has to escape to the client.** CP65's thumbs-up/down posts
   feedback keyed by run id, so the id must ride out on the `done` SSE event.
   A trace nobody can attach feedback to is only half an observability story.

Everything is wrapped in a bare `except Exception`. That is normally a smell,
and here it is deliberate: LangSmith is telemetry. A tracing outage, a bad key
or a version skew must degrade to "no trace" and never to "no answer".
"""

from __future__ import annotations

import contextlib
import os
from typing import Any, Iterator

from . import config


class _NullRun:
    """Stand-in when tracing is off, so callers need no branching."""

    id = None

    def end(self, **_: Any) -> None:  # noqa: D102
        pass

    def add_metadata(self, _: dict) -> None:  # noqa: D102
        pass


def configure() -> bool:
    """Normalise the LangSmith env vars. Returns whether tracing is live.

    Called once at startup. `LANGSMITH_TRACING` is what the SDK reads, but the
    older `LANGCHAIN_TRACING_V2` name is still honoured by parts of the stack,
    so both are set from our single flag rather than relying on whichever the
    installed version happens to prefer.
    """
    if not config.langsmith_configured():
        return False
    os.environ.setdefault("LANGSMITH_TRACING", "true")
    os.environ.setdefault("LANGCHAIN_TRACING_V2", "true")
    os.environ.setdefault("LANGSMITH_PROJECT", config.LANGSMITH_PROJECT)
    os.environ.setdefault("LANGCHAIN_PROJECT", config.LANGSMITH_PROJECT)
    return True


@contextlib.contextmanager
def traced_run(name: str, inputs: dict, **metadata: Any) -> Iterator[Any]:
    """Open a LangSmith run, yielding something with `.id` and `.end()`.

    Yields a `_NullRun` when tracing is off or unavailable, so the calling code
    is identical either way.
    """
    if not config.langsmith_configured():
        yield _NullRun()
        return

    try:
        from langsmith.run_helpers import trace
    except Exception:  # pragma: no cover - langsmith not installed
        yield _NullRun()
        return

    # The `try` covers ONLY opening the trace, never the `yield`. Wrapping the
    # yield in `except Exception` looks like the same defensive move and is a
    # different thing entirely: an exception raised by the caller's `with` body
    # is thrown back in at the yield point, gets swallowed here, and the
    # generator then yields a second time — which Python reports as
    # "generator didn't stop after throw()", replacing the caller's real error
    # with a bogus RuntimeError and leaving the LangSmith run unclosed.
    try:
        manager = trace(
            name=name,
            run_type="chain",
            project_name=config.LANGSMITH_PROJECT,
            inputs=inputs,
            metadata=metadata or None,
        )
        run = manager.__enter__()
    except Exception as error:  # noqa: BLE001 - telemetry must never be fatal
        print(f"LangSmith tracing unavailable, continuing untraced: {error}")
        yield _NullRun()
        return

    try:
        yield run
    finally:
        # Closing the span must not resurrect a telemetry failure as an
        # application one — the caller has already streamed its answer.
        try:
            manager.__exit__(None, None, None)
        except Exception as error:  # noqa: BLE001
            print(f"LangSmith span failed to close: {error}")


def end(run: Any, outputs: dict) -> None:
    """Close a run's outputs, swallowing any telemetry failure.

    Exists because `run.end()` was the one unguarded telemetry call left in the
    endpoint, and it sat at the end of every `except` handler *and* on the
    success path. A raise there produced two terminal SSE events for one
    perfectly good answer — a `done` immediately followed by an `error` — and
    then escaped the generator, tearing down a response that had already been
    committed. This module's whole contract is that a tracing outage degrades
    to "no trace", never to "no answer".
    """
    try:
        run.end(outputs=outputs)
    except Exception as error:  # noqa: BLE001
        print(f"LangSmith run.end failed, continuing: {error}")


def run_id(run: Any) -> str | None:
    """Best-effort string id for a run, for the `done` event."""
    try:
        value = getattr(run, "id", None)
        return str(value) if value else None
    except Exception:  # noqa: BLE001
        return None
