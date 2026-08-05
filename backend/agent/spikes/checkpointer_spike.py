"""CP59 checkpointer spike — does `langgraph-checkpoint-mongodb` still work?

`CHAT-AGENT-PLAN.md` §12 flags a specific risk: the async Mongo saver's import
path moved in LangGraph 1.0, and the plan's fallback is a hand-rolled Mongo
thread store. This resolves that by import and by round trip rather than by
reading a changelog — the same discipline the model spike applies to model
choice.

Thread memory is what makes multi-turn work at all ("how did *he* do in the
last race?" needs the previous turn), so this is a real dependency of CP61 and
not a nice-to-have.

Run it (needs `MONGODB_URI`; falls back to the repo-root `.env`):

    python -m agent.spikes.checkpointer_spike

The script writes to a `checkpoint_spike` thread id in whatever database the
URI points at and cleans up after itself.
"""

from __future__ import annotations

import asyncio
import importlib
import os
import sys
from pathlib import Path

# Every place an async-capable saver has plausibly lived, most-current first.
# Probing in order and reporting which one answered is the point: the answer is
# a fact about the installed versions, not about the docs.
#
# Measured against langgraph-checkpoint-mongodb 0.4.0 / langgraph 1.2.10 on
# 2026-08-05: the separately-named `AsyncMongoDBSaver` is GONE. Its async
# methods were merged into the one `MongoDBSaver` class, which now carries both
# `put`/`get_tuple` and `aput`/`aget_tuple`. So the plan's worry — "the async
# saver's import path moved" — is real, but the resolution is a merge rather
# than a move, and no fallback is needed.
CANDIDATE_PATHS = [
    ("langgraph.checkpoint.mongodb.aio", "AsyncMongoDBSaver"),
    ("langgraph.checkpoint.mongodb", "AsyncMongoDBSaver"),
    ("langgraph_checkpoint_mongodb.aio", "AsyncMongoDBSaver"),
    ("langgraph_checkpoint_mongodb", "AsyncMongoDBSaver"),
    # The 0.4.0 shape: one class, async methods included.
    ("langgraph.checkpoint.mongodb", "MongoDBSaver"),
    ("langgraph_checkpoint_mongodb", "MongoDBSaver"),
]

THREAD_ID = "checkpoint_spike"


def _load_mongo_uri() -> str | None:
    uri = os.getenv("MONGODB_URI") or os.getenv("mongodburi")
    if uri:
        return uri
    env_path = Path(__file__).resolve().parents[3] / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.lower().startswith("mongodburi="):
                return line.split("=", 1)[1].strip()
    return None


REQUIRED_ASYNC_METHODS = ("aput", "aget_tuple")


def resolve_saver() -> tuple[object | None, str]:
    """Return (class, description) for the first import path that works.

    A class that imports but has no `aput`/`aget_tuple` is not usable here —
    the service is async end to end, and a sync-only saver would block the
    event loop on every turn. So the probe checks capability, not just
    existence.
    """
    attempts: list[str] = []
    for module_name, attr in CANDIDATE_PATHS:
        try:
            module = importlib.import_module(module_name)
        except Exception as error:  # noqa: BLE001
            attempts.append(f"  {module_name}.{attr}: {type(error).__name__}: {error}")
            continue
        saver = getattr(module, attr, None)
        if saver is None:
            attempts.append(f"  {module_name}.{attr}: imported, but no {attr}")
            continue
        missing = [m for m in REQUIRED_ASYNC_METHODS if not hasattr(saver, m)]
        if missing:
            attempts.append(f"  {module_name}.{attr}: found, but missing {missing}")
            continue
        return saver, f"{module_name}.{attr}"
    return None, "no candidate import path resolved:\n" + "\n".join(attempts)


async def round_trip(saver_cls, uri: str) -> tuple[bool, str]:
    """Write a checkpoint and read it back.

    Importing the class proves nothing about whether it works against a real
    Atlas cluster — Batch 16's #97 was precisely a case where the code was
    correct against a fake and rejected by real MongoDB.
    """
    try:
        from langgraph.checkpoint.base import empty_checkpoint
    except Exception as error:  # noqa: BLE001
        return False, f"cannot import langgraph.checkpoint.base: {error}"

    config = {"configurable": {"thread_id": THREAD_ID, "checkpoint_ns": ""}}

    # `from_conn_string` is a SYNC context manager in 0.4.0 even though the
    # saver's methods are async — it only opens the client. Using `async with`
    # here fails with a bare `__aenter__` AttributeError that reads like a
    # missing dependency rather than a calling-convention mismatch.
    try:
        with saver_cls.from_conn_string(uri, db_name="f1_scratch") as saver:
            checkpoint = empty_checkpoint()
            saved = await saver.aput(config, checkpoint, {"source": "spike"}, {})
            loaded = await saver.aget_tuple(saved)
            if loaded is None:
                return False, "aput succeeded but aget_tuple returned None"

            found = loaded.checkpoint.get("id")
            if found != checkpoint["id"]:
                return False, f"round trip mismatch: wrote {checkpoint['id']}, read {found}"

            # Clean up so repeated runs do not accumulate threads.
            try:
                await saver.adelete_thread(THREAD_ID)
                cleaned = "cleaned up"
            except AttributeError:
                cleaned = "no adelete_thread on this version; left in place"

            return True, f"wrote and read checkpoint {found} ({cleaned})"
    except Exception as error:  # noqa: BLE001
        return False, f"{type(error).__name__}: {error}"


def main() -> int:
    print("=== langgraph-checkpoint-mongodb spike ===\n")

    saver_cls, description = resolve_saver()
    if saver_cls is None:
        print(f"[FAIL] import: {description}")
        print(
            "\nVerdict: use the in-memory saver plus a hand-rolled Mongo thread\n"
            "store, exactly as CHAT-AGENT-PLAN.md §12 anticipates."
        )
        return 1
    print(f"[PASS] import: {description}")

    uri = _load_mongo_uri()
    if not uri:
        print("[SKIP] round trip: MONGODB_URI is not set")
        return 0

    ok, detail = asyncio.run(round_trip(saver_cls, uri))
    print(f"[{'PASS' if ok else 'FAIL'}] round trip: {detail}")

    print(
        "\nVerdict: MongoDB checkpointer is usable — CP61 gets real thread memory."
        if ok
        else "\nVerdict: fall back to the in-memory saver + a Mongo thread store."
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
