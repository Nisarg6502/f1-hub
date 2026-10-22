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

import ast
import datetime
import hashlib
import importlib
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


def _in_package(name) -> bool:
    return isinstance(name, str) and name.startswith(_PACKAGE + ".")


def _statically_imported(module: types.ModuleType) -> set[str]:
    """Package modules named by any import statement in `module`'s source.

    Read from the syntax tree rather than the module's namespace because an
    import inside a function body never appears in the namespace:
    `race_timing.fetch_openf1_feeds` imports the OpenF1 session lookup locally,
    and a namespace-only walk missed `openf1_sessions` and `race_stints`
    entirely, so editing how a session is chosen would not have retired a
    single cached timing payload.
    """
    try:
        tree = ast.parse(inspect.getsource(module))
    except (OSError, TypeError, SyntaxError):
        return set()
    package = module.__name__.rsplit(".", 1)[0]
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = package.rsplit(".", node.level - 1)[0] if node.level > 1 else package
                target = f"{base}.{node.module}" if node.module else base
            else:
                target = node.module or ""
            names.add(target)
            # `from . import x` / `from .pkg import mod` name modules too.
            names.update(f"{target}.{alias.name}" for alias in node.names)
    return {name for name in names if _in_package(name)}


def _module(name: str) -> types.ModuleType | None:
    module = sys.modules.get(name)
    if module is not None:
        return module
    try:
        return importlib.import_module(name)
    except ImportError:
        # `from .x import y` where `y` is a function, not a submodule.
        return None


def _app_modules_reached_from(module: types.ModuleType) -> list[types.ModuleType]:
    """`module` plus every module of this package it can reach, transitively.

    Two sources, unioned: what the module's namespace refers to (names bound
    by `from .x import f` carry `f.__module__`), and every import statement in
    its source, wherever it sits (see `_statically_imported`).
    """
    seen: dict[str, types.ModuleType] = {}
    pending = [module]
    while pending:
        current = pending.pop()
        if current.__name__ in seen:
            continue
        seen[current.__name__] = current
        names = set(_statically_imported(current))
        for value in vars(current).values():
            if isinstance(value, types.ModuleType):
                names.add(value.__name__)
            else:
                names.add(getattr(value, "__module__", None))
        for name in names:
            if _in_package(name) and name not in seen:
                target = _module(name)
                if target is not None:
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


# First season OpenF1 covers. From here on every race has race-control
# messages and live feeds, so an empty answer for one means the fetch failed.
OPENF1_FIRST_SEASON = 2023


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


# Builds kept per round. One per code would be the minimum, but two code
# versions are routinely live against the same database at once: a Cloud Run
# rollout overlaps the old and new revisions, and `scripts/sync_race_timing`
# exists to build and verify a branch's payloads against production BEFORE it
# ships. With one, each side would delete the other's document on every write
# and the two would rebuild each other forever. Two bounds storage at 2x a
# round instead of the unbounded growth versioned keys produced (59 of 70
# `race_timing` documents were dead, 80% of a 512 MB database, until
# `scripts/reap_stale_caches` was written to clean up after them).
KEEP_BUILDS = 2


def _doomed(docs: list[dict], code: str) -> list:
    """`_id`s to delete: anything without a `code` (the old `version` scheme),
    and every build older than the newest `KEEP_BUILDS` distinct codes."""
    keep: list[str] = [code]
    for doc in sorted(docs, key=lambda d: d.get("built_at") or "", reverse=True):
        doc_code = doc.get("code")
        if doc_code and doc_code not in keep and len(keep) < KEEP_BUILDS:
            keep.append(doc_code)
    return [doc["_id"] for doc in docs if doc.get("code") not in keep]


async def store_derived(collection, year: int, round_number, code: str, inputs: str, payload: dict) -> None:
    """Write this code's cached document for a round, replacing its previous one.

    The key carries no version, so an edit rebuilds in place instead of
    leaving a document per version behind; older builds beyond `KEEP_BUILDS`
    and every document from the old `version` scheme are deleted here.
    """
    base, document = _derived_document(year, round_number, code, inputs, payload)
    await collection.replace_one({**base, "code": code}, document, upsert=True)
    docs = await collection.find(base, {"_id": 1, "code": 1, "built_at": 1}).to_list(length=None)
    doomed = _doomed(docs, code)
    if doomed:
        await collection.delete_many({"_id": {"$in": doomed}})


def store_derived_sync(collection, year: int, round_number, code: str, inputs: str, payload: dict) -> None:
    """`store_derived` for a synchronous pymongo collection (the scripts)."""
    base, document = _derived_document(year, round_number, code, inputs, payload)
    collection.replace_one({**base, "code": code}, document, upsert=True)
    docs = list(collection.find(base, {"_id": 1, "code": 1, "built_at": 1}))
    doomed = _doomed(docs, code)
    if doomed:
        collection.delete_many({"_id": {"$in": doomed}})
