"""Cache keys for documents derived from other documents.

Several endpoints cache an expensive derivation (`race_replay`, `race_timing`,
the AI recaps) built from source documents (`race_results`, `race_laps`,
`race_stints`, `pit_stops`, ...). They used to be keyed only by round plus a
hand-maintained version constant. That key is missing both of the things a
derived document actually depends on, and each gap shipped a real bug:

- **Its inputs.** A source document changing does not change the key. When
  the 2026 Monaco GP classification was revised on appeal, the replay and the
  AI recap kept Gasly on the podium indefinitely, because nothing about the
  key `{season, round, version}` moved.
- **The code that built it.** #173 changed how `build_replay` marks a car that
  retires mid-lap and did not bump `REPLAY_VERSION`, so every replay cached
  before it kept the old bug (2026 round 14 still showed two cars in fourth).
  A version constant is a promise someone has to remember to keep.

The two fingerprints here are computed, not remembered:

- `input_fingerprint(...)` hashes the content of the source documents a
  derivation read. A caller fetches its inputs, fingerprints them, and treats
  a cached document as valid only if it was built from the same fingerprint.
  Content rather than `synced_at`, because not every writer stamps one (six of
  2026's `race_laps` documents have none).
- `code_fingerprint(module)` hashes the source of the module that builds the
  cache and of every `app.*` module it reaches, transitively. Any edit to that
  code retires the cache. That over-invalidates on purpose (a docstring edit
  rebuilds too): a rebuild costs one cold request per round, a stale cache
  costs wrong data on the site until someone notices.

LLM-generated caches still carry their `PROMPT_VERSION`: regenerating prose is
a judgement call about whether a prompt change is worth the calls, which a
source hash cannot make. They do take an input fingerprint, because a recap
written from a classification that has since changed is simply wrong.
"""

import datetime
import hashlib
import inspect
import json
import sys
import types
from functools import lru_cache

_PACKAGE = __name__.rsplit(".", 1)[0]


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def input_fingerprint(*documents) -> str:
    """Stable hash of the content of the given source documents.

    Key order does not matter (`sort_keys`); list order does, because a
    reordered classification is a different classification. `None` stands for
    a missing document and hashes differently from an empty one.
    """
    return _digest(json.dumps(documents, sort_keys=True, default=str))


def _app_modules_reached_from(module: types.ModuleType) -> list[types.ModuleType]:
    """`module` plus every module of this package it references, transitively."""
    seen: dict[str, types.ModuleType] = {}
    pending = [module]
    while pending:
        current = pending.pop()
        if current.__name__ in seen:
            continue
        seen[current.__name__] = current
        for value in vars(current).values():
            if isinstance(value, types.ModuleType):
                name = value.__name__
            else:
                name = getattr(value, "__module__", None)
            if not isinstance(name, str):
                continue
            if name != _PACKAGE and not name.startswith(_PACKAGE + "."):
                continue
            target = sys.modules.get(name)
            if target is not None and target.__name__ not in seen:
                pending.append(target)
    return [seen[name] for name in sorted(seen)]


@lru_cache(maxsize=None)
def code_fingerprint(module_name: str) -> str:
    """Hash of the source of `module_name` and every `app.*` module it reaches.

    Computed once per process: the source cannot change under a running
    container, and a deploy is a new process.
    """
    module = sys.modules[module_name]
    parts = []
    for reached in _app_modules_reached_from(module):
        try:
            source = inspect.getsource(reached)
        except (OSError, TypeError):
            # No source on disk (a compiled-only module). Fall back to its
            # name so the fingerprint is still stable, and say so: a module
            # that silently stops counting is how a stale cache comes back.
            print(f"derived_cache: no source for {reached.__name__}, fingerprinting by name")
            source = reached.__name__
        parts.append(f"{reached.__name__}\n{source}")
    return _digest("\n\0\n".join(parts))


def is_current(doc: dict | None, code: str, inputs: str) -> bool:
    """True if a cached document was built by this code from these inputs."""
    return bool(doc) and doc.get("code") == code and doc.get("inputs") == inputs


# Readers that want "the" cached document for a round without validating it
# (the agent, the what-if endpoint, the radio sync) sort on this. A document
# written before `built_at` existed sorts last, so a rebuilt one always wins.
NEWEST_FIRST = [("built_at", -1)]


def _derived_document(year: int, round_number, code: str, inputs: str, payload: dict) -> tuple[dict, dict]:
    base = {"season": year, "round": str(round_number)}
    return base, {
        **base,
        "code": code,
        "inputs": inputs,
        "built_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **payload,
    }


async def store_derived(collection, year: int, round_number, code: str, inputs: str, payload: dict) -> None:
    """Write the one cached document for a round, replacing whatever was there.

    One document per round, not one per code or version: the key carries
    neither, so an edit rebuilds in place instead of leaving the previous
    document behind. Versioned keys left 59 of 70 `race_timing` documents dead
    (80% of the database, on a 512 MB tier) until `scripts/reap_stale_caches`
    was written to clean up after them. The `delete_many` also clears documents
    written under the old `version` scheme the first time a round rebuilds.
    """
    base, document = _derived_document(year, round_number, code, inputs, payload)
    await collection.delete_many({**base, "code": {"$ne": code}})
    await collection.replace_one({**base, "code": code}, document, upsert=True)


def store_derived_sync(collection, year: int, round_number, code: str, inputs: str, payload: dict) -> None:
    """`store_derived` for a synchronous pymongo collection (the scripts)."""
    base, document = _derived_document(year, round_number, code, inputs, payload)
    collection.delete_many({**base, "code": {"$ne": code}})
    collection.replace_one({**base, "code": code}, document, upsert=True)
