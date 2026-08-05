"""The fact-bundle contract every internal tool obeys.

`CHAT-AGENT-PLAN.md` §5 states the shape; this module is where it is actually
enforced, because a shape that lives only in a document is a shape the code
drifts away from (CP44's lesson, and the reason `agent/sse.py` says the same
thing about its event vocabulary).

Three rules, each one a post-mortem:

**A tool returns pre-joined, pre-computed facts — never a raw Mongo
document.** CP38 handed a model correct raw rows and watched it invent a
teammate relationship between two drivers on visibly different teams. The
conclusion was not "prompt harder", it was that relational facts must be
resolved in Python before the model sees anything. So `bundle()` takes a
`data` payload the caller has already reshaped, and every tool in this package
reshapes rather than forwards.

**A tool never raises.** `@fact_tool` converts any escaping exception into
`{"available": false, "reason": ...}`. This matches the fail-soft posture the
rest of the app already has (`session_recap`, `strategy_commentary`,
`race_laps` all report "not synced yet" rather than 500), and it matters more
here: an exception inside a tool call aborts a whole agent run that has
already spent GPU time from a free-tier quota, to report a missing collection
that the answer could simply have said it did not have.

**`as_of` comes from the data, not from the clock.** `ledger.append()` will
happily default `as_of` to now; that would be a lie about anything read out of
Mongo, because the hourly sync can be an hour behind and FastF1-sourced
collections can only be filled from a local machine at all (`HANDOFF.md`). So
`bundle()` takes the documents it read and derives `as_of` from their own
`synced_at`, taking the **oldest** — a bundle is only as fresh as its stalest
input, and quoting the newest would overstate freshness on exactly the
mixed-age joins these tools do. Tools therefore must not project `synced_at`
out of their queries, which is the one way this enforcement can be defeated.

**Nothing here may trigger a FastF1 fetch.** `livetiming.formula1.com` 403s
datacenter IPs and fails *soft* — empty frames, no exception — so a FastF1
path passes every local test and silently returns empty answers on Cloud Run.
Several `app` modules have a FastF1 fallback behind their Mongo read
(`session_results`, `race_laps`, `circuit_info`, `race_stints`); this package
reuses their *pure* helpers and fact builders and reads the collections
itself, rather than calling those endpoints. Where a tool would otherwise have
reached for one, the docstring says which function was bypassed and why.
"""

from __future__ import annotations

import functools
from typing import Any, Callable, Iterable

from app.db import get_db

from ..ledger import EvidenceLedger, utcnow_iso


def resolve_db(db=None):
    """The database handle, defaulting to the app's singleton Motor client.

    Never constructs a client of its own. Failure mode 14 in the plan is Mongo
    pool exhaustion under subagent fan-out, and a tool package that opened its
    own client would create exactly that: one pool per import, none of them
    bounded against the others.
    """
    return get_db() if db is None else db


def mongo_source(collection: str, *parts: Any) -> str:
    """A citation string like `mongo:race_results/2026-14`.

    Deliberately readable: it is rendered to the user as a source chip, and a
    chip reading `mongo:race_results/2026-14` tells a curious reader exactly
    which row an answer came from. Also deliberately *not* a URL — an internal
    collection has no public address, and inventing one would produce a chip
    that 404s.
    """
    tail = "-".join(str(p) for p in parts if p is not None and str(p) != "")
    return f"mongo:{collection}/{tail}" if tail else f"mongo:{collection}"


def as_of_from(docs: Iterable[dict | None]) -> str:
    """The oldest `synced_at` among the documents a bundle was built from.

    Falls back to now only when nothing carried one — which is the honest
    answer for a fact computed in Python from inputs that had no stamp, and is
    why this is not simply `min(...)` over a possibly-empty list.

    String comparison is safe because every writer in `app/` stamps with
    `datetime.now(timezone.utc).isoformat()`, so the format and offset are
    uniform. A document stamped in another offset would sort wrongly; nothing
    in this repo writes one.
    """
    stamps = [
        doc["synced_at"]
        for doc in docs
        if isinstance(doc, dict) and isinstance(doc.get("synced_at"), str) and doc["synced_at"]
    ]
    return min(stamps) if stamps else utcnow_iso()


def unavailable(reason: str, **extra: Any) -> dict:
    """The one failure shape. Never an exception, never an empty success.

    `available: false` is a *fact* about the world the answer is allowed to
    state ("I don't have qualifying for that round"), which is why it carries a
    human-readable reason rather than an error code — the reason is written to
    be quotable in the answer.
    """
    return {"available": False, "reason": reason, **extra}


def bundle(
    *,
    data: dict,
    source: str,
    docs: Iterable[dict | None] = (),
    ledger: EvidenceLedger | None = None,
    tool: str | None = None,
    args: dict | None = None,
    as_of: str | None = None,
) -> dict:
    """Wrap computed facts as a fact bundle and record them in the ledger.

    `available: true` is additive to the shape §5 specifies. It is there so a
    caller can branch on one key for both outcomes instead of testing for the
    presence of `data`, which is the kind of implicit contract CP44 warns
    against building on.

    `evidence_id` is None when no ledger is passed. That is legitimate — the
    unit tests and any future direct caller do not need one — but a bundle
    without an id cannot be cited, so CP61's agent always passes a ledger.
    """
    stamp = as_of or as_of_from(docs)
    evidence_id = None
    if ledger is not None:
        entry = ledger.append(
            source=source, data=data, as_of=stamp, tool=tool, args=args
        )
        evidence_id = entry.evidence_id
    return {
        "available": True,
        "data": data,
        "evidence_id": evidence_id,
        "source": source,
        "as_of": stamp,
    }


def fact_tool(name: str) -> Callable:
    """Mark an async function as a tool and make it incapable of raising.

    The name is attached as `tool_name` so `tools/__init__.py`'s registry and
    CP61's binding both read it off the function rather than repeating it in a
    table that can fall out of step.

    The blanket `except Exception` is deliberate and is the whole point: a tool
    is a leaf call inside an agent run, and there is no useful place further up
    to handle a `KeyError` from an unexpected document shape. It is logged with
    its type so a genuine bug is still visible in Cloud Logging rather than
    disappearing into a polite "unavailable".
    """

    def decorate(fn: Callable) -> Callable:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> dict:
            try:
                return await fn(*args, **kwargs)
            except Exception as error:  # noqa: BLE001 - see docstring
                print(f"agent tool {name} failed: {type(error).__name__}: {error}")
                return unavailable(
                    f"{name} could not be read", error=type(error).__name__
                )

        wrapper.tool_name = name  # type: ignore[attr-defined]
        return wrapper

    return decorate


# --- small shared coercions ------------------------------------------------
#
# Every `app` module has its own private copy of these because Ergast sends
# every numeric field as a string. They are repeated once here rather than
# imported from one of them, so this package does not take an import
# dependency on a module for a three-line helper — several of those modules
# pull in FastF1 transitively, which is exactly what this package avoids.


def as_int(value) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None


def as_float(value) -> float | None:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError, AttributeError):
        return None


def driver_name(entry: dict) -> str:
    driver = entry.get("Driver") or {}
    return f"{driver.get('givenName', '')} {driver.get('familyName', '')}".strip()
