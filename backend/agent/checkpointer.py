"""Thread memory via `MongoDBSaver` — CP61.

`CHAT-AGENT-PLAN.md` §12 flagged the async saver's import path as a real risk.
`agent/spikes/checkpointer_spike.py` resolved it by measurement rather than by
reading a changelog: against `langgraph-checkpoint-mongodb` 0.4.0, the
separately-named `AsyncMongoDBSaver` is gone, merged into one `MongoDBSaver`
class that carries both sync (`put`, `get_tuple`) and async (`aput`,
`aget_tuple`) methods — and `from_conn_string` is a **sync** context manager
even though the methods on the object it yields are async. `with`, not
`async with`; then `await` the methods.

That shape is why this module opens the saver **once**, at process startup,
and keeps the sync context manager's `__enter__` result alive for the app's
lifetime rather than entering and exiting it per request. Two reasons:

1. `async with` on `from_conn_string` fails outright (a bare `__aenter__`
   AttributeError), so a per-request `with` block would still need to run in
   a thread to avoid blocking the event loop on every single chat turn just
   to open a socket that CP61's free-tier semaphore of 1 guarantees only one
   coroutine will use at a time anyway.
2. It matches the ledger's `to_dict`/`from_dict` framework-free posture:
   this module is the only place that imports `langgraph.checkpoint.mongodb`,
   so a version bump or an unconfigured Mongo URI cannot break anything
   outside it.

A missing or unreachable `MONGODB_URI` degrades to **no thread memory**
(`None`, which `create_deep_agent(checkpointer=None)` treats as "run
stateless") rather than refusing to start — this repo's fail-soft posture
everywhere else (`session_recap`, `strategy_commentary`, the tool layer
itself) applies here too. A chat service that cannot remember "the last race"
is a worse product than one that cannot start at all only if losing memory
were silent; `/health` reports whether it is configured, matching the
`langsmith_tracing` pattern already established there.
"""

from __future__ import annotations

from typing import Any

from . import config

_STATE: dict[str, Any] = {"cm": None, "saver": None}


def open_saver() -> Any | None:
    """Open the Mongo checkpointer for the process lifetime, or return None.

    Opened with a TTL, which is the difference between thread memory and an
    unbounded write log. Every conversation writes checkpoints, the frontend
    mints a fresh thread id on each panel open, and repairs spawn a second
    `<thread>--repair` thread of their own -- so abandoned threads accumulate
    permanently, in a 512MB free-tier cluster, for memory nothing will ever
    read again. `MongoDBSaver` supports this natively (it already stamps each
    document with a real `created_at` and creates the expiring index itself),
    so this is a supported parameter rather than an index hand-rolled against
    a schema this module does not own.

    Call once, at startup. Safe to call again after `close_saver()` — mainly
    for tests, which need a clean slate between cases that patch
    `config.mongodb_uri`.
    """
    uri = config.mongodb_uri()
    if not uri:
        return None

    try:
        from langgraph.checkpoint.mongodb import MongoDBSaver
    except Exception as error:  # noqa: BLE001 - see module docstring
        print(f"agent checkpointer unavailable, continuing without thread memory: {error}")
        return None

    try:
        # Sync context manager; only `__enter__`/`__exit__` are used, never
        # `async with` — see module docstring.
        context_manager = MongoDBSaver.from_conn_string(
            uri,
            db_name=config.MONGODB_DB_NAME,
            ttl=config.CHECKPOINT_TTL_SECONDS,
        )
        saver = context_manager.__enter__()
    except Exception as error:  # noqa: BLE001 - a bad URI must not crash the service
        print(f"agent checkpointer failed to open, continuing without thread memory: {error}")
        return None

    _STATE["cm"] = context_manager
    _STATE["saver"] = saver
    return saver


def close_saver() -> None:
    """Close the checkpointer opened by `open_saver`, if any. Never raises."""
    context_manager = _STATE.get("cm")
    if context_manager is not None:
        try:
            context_manager.__exit__(None, None, None)
        except Exception as error:  # noqa: BLE001 - shutdown must not crash either
            print(f"agent checkpointer failed to close cleanly: {error}")
    _STATE["cm"] = None
    _STATE["saver"] = None


def current() -> Any | None:
    """The currently-open saver, or None if thread memory is unconfigured."""
    return _STATE.get("saver")
