"""Saved chat history for signed-in users — `agent_conversations`.

Until this module a conversation was disposable by design: the panel minted a
fresh thread id on every open, the checkpointer forgot it after
`CHECKPOINT_TTL_SECONDS`, and the panel said so in as many words. This is the
account-only exception (`user_auth.py` decides who counts as signed in). Guests
keep exactly the old behaviour — nothing in this module runs for them, not even
a read.

--------------------------------------------------------------------------
Why a transcript store separate from the checkpointer
--------------------------------------------------------------------------

The checkpointer already persists every thread's messages, so "just list the
checkpoints" looks like the cheaper design. It is not, for three reasons:

1. **It holds the wrong thing.** A checkpoint is LangGraph's working state —
   tool calls, tool results, subagent chatter, the `<thread>--repair` scratch
   threads `graph.py` spawns — not what the reader saw. The panel needs the
   answer exactly as rendered: the final draft with its `[ev_N]` markers, the
   anchored sources, the charts and the follow-up chips, none of which live in
   graph state (the ledger is per turn and discarded; visuals are drained from
   a per-turn buffer). Rebuilding a past answer from a checkpoint would mean
   re-running the tools, which is the whole cost the answer cache exists to
   avoid.
2. **It expires.** The TTL is what keeps the checkpointer from filling a 512MB
   cluster, and it is the right policy for thread *memory*. It is the wrong
   policy for a history the user asked to keep.
3. **It has no owner.** Checkpoints are keyed by thread id alone. A history
   list must be keyed by user, and a thread belonging to someone else must be
   indistinguishable from one that does not exist.

So this store holds the transcript, and the checkpointer keeps holding the
model's memory. When the memory has expired and the user continues an old chat,
`seed_messages` rebuilds enough context from the transcript to carry on — see
`main._stream`.

--------------------------------------------------------------------------
Document shape
--------------------------------------------------------------------------

    {_id: thread_id, user_id, title, created_at, updated_at,
     message_count, size_bytes,
     messages: [{role, content, created_at,
                 visuals?, citations?: {sources, anchors}, followups?,
                 run_id?, meta?: {tier, verification, mode, elapsed_ms}}]}

`content` is the answer's raw draft, `[ev_N]` markers included, because that is
what `citations.anchors`' offsets index (see `agent-api.ts`'s `AgentAnchor`) —
storing the rendered prose would break every inline citation on replay.
`visuals` and `citations` are the `visual` and `sources` SSE payloads verbatim,
so the panel replays a stored answer through the same code that rendered it
live. `meta` carries the `done` fields the panel shows: without
`verification`, an answer that streamed with a "could not be matched to a
stored record" warning would come back from history looking fully checked.

`_id` is the thread id the client already sends, so "is there a saved
conversation for this thread" is a primary-key read, and a second user writing
to someone else's id cannot create a duplicate — the insert collides with the
existing `_id` and fails. Ownership is enforced by the write, not only by the
read that precedes it.

--------------------------------------------------------------------------
Free-tier caps (the 512MB cluster also holds every F1 collection)
--------------------------------------------------------------------------

The bound that matters is per user, and it is enforced in bytes, because a
message count alone says nothing — one answer with two charts can carry
~560KB (`visuals.MAX_DATA_BYTES` 256KB + `MAX_CODE_CHARS` 24KB, twice) while a
plain one is ~5-15KB.

* `MAX_MESSAGE_BYTES` 320KB — one stored message. Over it, the largest visual's
  payload is dropped first (the prose and citations survive; a missing chart is
  the least bad loss), then the anchor rows.
* `MAX_MESSAGES_PER_CONVERSATION` 60 (30 turns) and `MAX_CONVERSATION_BYTES`
  1.5MB — oldest turns are dropped first. Far under Mongo's 16MB document cap.
* `MAX_CONVERSATIONS_PER_USER` 50 and `MAX_USER_BYTES` 4MB — oldest-updated
  conversations are pruned after every write.

So one user can never hold more than ~4MB; a typical one (a few dozen short
chats) holds well under 1MB. The cluster-level number is 4MB × signed-in users,
which is the figure to revisit if sign-ups ever approach a hundred. Pruning
does not delete checkpoints — those expire on their own TTL.

--------------------------------------------------------------------------
Failure posture
--------------------------------------------------------------------------

`record_turn` is **fail-soft**: it runs after `done` is already on the wire and
a Mongo failure costs the user their saved copy of one turn, never the answer
they are reading. The read paths behind the history endpoints are not —
they raise `Unavailable`, which `main.py` turns into a 503, because "your
history is empty" and "we could not load your history" are different things to
tell somebody, and only one of them is true during an outage.

Concurrency: `record_turn` is a read-modify-write rather than an atomic
`$push`, because trimming by bytes needs the sizes in hand. That is safe here
for the reason it is safe anywhere in this service: `concurrency.py` runs one
turn at a time, and a single thread cannot have two turns in flight.
"""

from __future__ import annotations

import asyncio
import base64
import datetime
import json
import re
from typing import Any

from . import config

COLLECTION = "agent_conversations"

MAX_MESSAGE_BYTES = 320 * 1024
MAX_MESSAGES_PER_CONVERSATION = 60
MAX_CONVERSATION_BYTES = 1536 * 1024
MAX_CONVERSATIONS_PER_USER = 50
MAX_USER_BYTES = 4 * 1024 * 1024

TITLE_MAX_CHARS = 80
"""The first question, trimmed. Long enough to tell two chats apart in a list,
short enough to fit one line of a 480px drawer at 13px."""

SEED_TURNS = 6
"""How many prior turns `seed_messages` replays when the checkpoint is gone.

Six turns is what a reader can plausibly mean by "that" or "him" in a
follow-up; more is context the model pays for on every later turn (the seeded
messages are written into the new checkpoint and ride along from then on)."""

SEED_MESSAGE_CHARS = 2000
"""Per-message ceiling on seeded content. An old answer's tables and lists are
the bulk of its length and the least of what a follow-up needs."""

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 50
MAX_QUERY_CHARS = 100

DB_TIMEOUT_SECONDS = 3.0
"""Ceiling on any single operation here.

Above `rate_limit.DB_TIMEOUT_SECONDS` (1.5s) because nothing here sits in
front of every request: the writes run after the answer is delivered and the
reads back a list the user explicitly opened. Still far below Motor's 30s
server-selection default, which would otherwise hold a finished stream open for
half a minute during an outage."""

_THREAD_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")

# Mirror of `verifier._CITATION_RE` — the same marker set, stripped from seeded
# history. Copied rather than imported because `verifier` pulls in the whole
# ledger/anchor machinery for one regex, and this module must stay importable
# by the endpoints without it.
_CITATION_RE = re.compile(r"\s?[\[【［]ev_\d+[\]】］]")


class Unavailable(Exception):
    """The store could not be reached — distinct from "nothing there"."""


# --------------------------------------------------------------------------
# pure helpers
# --------------------------------------------------------------------------


def _utcnow() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc)


def _as_utc(value: Any) -> datetime.datetime | None:
    """Motor hands back naive datetimes (UTC by convention); make them aware."""
    if not isinstance(value, datetime.datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=datetime.timezone.utc)
    return value


def _iso(value: Any) -> str | None:
    moment = _as_utc(value)
    return moment.isoformat().replace("+00:00", "Z") if moment else None


def _size(obj: Any) -> int:
    """Approximate stored size: the JSON encoding, which BSON tracks closely
    for this shape (strings dominate) and which is computable without a
    round trip."""
    return len(json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8"))


def is_storable_thread_id(thread_id: str | None) -> bool:
    """Whether `thread_id` may key a saved conversation.

    The frontend sends `crypto.randomUUID()`, which this accepts. What it
    refuses is anything containing `--`, which is how `graph.py` names its
    repair threads (`<thread>--repair`): those are scratch state, and no shape
    of request may turn one into a listed conversation.
    """
    if not thread_id or "--" in thread_id:
        return False
    return bool(_THREAD_ID_RE.match(thread_id))


def make_title(question: str) -> str:
    """The first question, whitespace-collapsed and cut at a word boundary."""
    text = " ".join((question or "").split())
    if len(text) <= TITLE_MAX_CHARS:
        return text or "Untitled chat"
    cut = text[: TITLE_MAX_CHARS - 1]
    space = cut.rfind(" ")
    # Only back off to the word boundary when it does not throw away most of
    # the title — a 70-character first word should be cut, not erased.
    if space >= TITLE_MAX_CHARS // 2:
        cut = cut[:space]
    return cut.rstrip(" ,.;:-") + "…"


def clean_title(raw: str | None) -> str | None:
    """A user-supplied rename, or None when it is empty after trimming."""
    text = " ".join((raw or "").split())
    if not text:
        return None
    return text[:TITLE_MAX_CHARS]


def _shrink(message: dict) -> dict:
    """Bring one assistant message under `MAX_MESSAGE_BYTES`, losing the least.

    Order of sacrifice: the largest visual first (a chart is the one part with
    a real substitute — the source strip still lists the record it drew), then
    the per-anchor `row` payloads (the inline marks survive; only the popover's
    row view goes), and only then the prose itself. Each step records what was
    dropped, so the panel could say so rather than silently rendering less.
    """
    if _size(message) <= MAX_MESSAGE_BYTES:
        return message
    out = dict(message)
    visuals = list(out.get("visuals") or [])
    omitted = 0
    while visuals and _size({**out, "visuals": visuals}) > MAX_MESSAGE_BYTES:
        largest = max(range(len(visuals)), key=lambda i: _size(visuals[i]))
        visuals.pop(largest)
        omitted += 1
    out["visuals"] = visuals
    if omitted:
        out["visuals_omitted"] = omitted
    if _size(out) > MAX_MESSAGE_BYTES and out.get("citations"):
        citations = out["citations"]
        out["citations"] = {
            "sources": [
                {**s, "anchors": [{**a, "row": None} for a in (s.get("anchors") or [])]}
                for s in citations.get("sources") or []
            ],
            "anchors": [{**a, "row": None} for a in citations.get("anchors") or []],
        }
    if _size(out) > MAX_MESSAGE_BYTES:
        out["citations"] = {"sources": [], "anchors": []}
        out["content"] = (out.get("content") or "")[: MAX_MESSAGE_BYTES // 4]
    return out


def build_turn(
    *,
    question: str,
    answer: str,
    visuals: list[dict] | None = None,
    sources: list[dict] | None = None,
    anchors: list[dict] | None = None,
    followups: list[str] | None = None,
    run_id: str | None = None,
    meta: dict | None = None,
    now: datetime.datetime | None = None,
) -> list[dict]:
    """The two messages one completed turn stores: the question and the answer.

    Empty optional fields are omitted rather than stored as empty lists, which
    is most of what keeps a plain answer at a few KB.
    """
    moment = now or _utcnow()
    assistant: dict[str, Any] = {"role": "assistant", "content": answer, "created_at": moment}
    if visuals:
        assistant["visuals"] = list(visuals)
    if sources or anchors:
        assistant["citations"] = {"sources": list(sources or []), "anchors": list(anchors or [])}
    if followups:
        assistant["followups"] = list(followups)
    if run_id:
        assistant["run_id"] = run_id
    if meta:
        assistant["meta"] = {k: v for k, v in meta.items() if v is not None}
    return [
        {"role": "user", "content": question, "created_at": moment},
        _shrink(assistant),
    ]


def _trim(messages: list[dict]) -> list[dict]:
    """Drop the oldest whole turns until both conversation caps hold.

    Always in user/assistant pairs, and never the newest turn: a conversation
    must not start with an orphaned answer, and the turn just written is the
    one the reader expects to find.
    """
    out = list(messages)
    while len(out) > 2 and (
        len(out) > MAX_MESSAGES_PER_CONVERSATION or _size(out) > MAX_CONVERSATION_BYTES
    ):
        out = out[2:] if out[0].get("role") == "user" and len(out) > 2 else out[1:]
    return out


def seed_messages(doc: dict | None, *, turns: int = SEED_TURNS) -> list[dict]:
    """Prior turns as plain `{role, content}` messages for a fresh checkpoint.

    Citation markers are stripped: they name evidence ids from ledgers that no
    longer exist, and a model that sees `[ev_3]` in its own history will cite
    `[ev_3]` again — against this turn's ledger, where it means something else
    or nothing, which the verifier then flags as a fabricated citation.
    """
    if not doc:
        return []
    history = [m for m in doc.get("messages") or [] if m.get("role") in ("user", "assistant")]
    history = history[-(turns * 2):]
    if history and history[0].get("role") != "user":
        history = history[1:]
    out = []
    for message in history:
        content = message.get("content") or ""
        if message["role"] == "assistant":
            content = _CITATION_RE.sub("", content)
        content = content.strip()[:SEED_MESSAGE_CHARS]
        if content:
            out.append({"role": message["role"], "content": content})
    return out


def _encode_cursor(updated_at: Any, thread_id: str) -> str:
    moment = _as_utc(updated_at) or _utcnow()
    raw = json.dumps({"u": int(moment.timestamp() * 1000), "i": thread_id})
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str | None) -> tuple[datetime.datetime, str] | None:
    if not cursor:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        moment = datetime.datetime.fromtimestamp(int(data["u"]) / 1000, datetime.timezone.utc)
        return moment, str(data["i"])
    except Exception:  # noqa: BLE001 - a bad cursor is just "from the top"
        return None


def summary(doc: dict) -> dict:
    """The list-row view of a conversation."""
    return {
        "id": doc["_id"],
        "title": doc.get("title") or "Untitled chat",
        "created_at": _iso(doc.get("created_at")),
        "updated_at": _iso(doc.get("updated_at")),
        "message_count": int(doc.get("message_count") or 0),
    }


def public(doc: dict) -> dict:
    """The full view: the summary plus messages with ISO timestamps."""
    messages = []
    for message in doc.get("messages") or []:
        item = {k: v for k, v in message.items() if k != "created_at"}
        item["created_at"] = _iso(message.get("created_at"))
        messages.append(item)
    return {**summary(doc), "messages": messages}


# --------------------------------------------------------------------------
# database access
# --------------------------------------------------------------------------


def _database(db: Any = None) -> Any:
    """The conversations database, or None when Mongo is not configured.

    Gated on `config.mongodb_uri()` for the reason `rate_limit._database`
    gives: without a URI Motor points at localhost and the first operation
    hangs through server-selection rather than failing. Uses the shared client
    but `config.conversations_db_name()`, so a dev run can point at
    `f1_scratch_dev` without moving anything else.
    """
    if db is not None:
        return db
    if not config.mongodb_uri():
        return None
    try:
        from app.db import get_client

        return get_client()[config.conversations_db_name()]
    except Exception as error:  # noqa: BLE001
        print(f"conversations: no database ({type(error).__name__}: {error})")
        return None


async def _op(awaitable: Any) -> Any:
    return await asyncio.wait_for(awaitable, timeout=DB_TIMEOUT_SECONDS)


_index_ready = False


async def _ensure_index(database: Any) -> None:
    """The one index the list query needs, created once per process.

    `(user_id, updated_at desc)` serves the history list, its pagination and
    the prune walk. Best-effort like `rate_limit._ensure_index`: an unindexed
    collection is slower, not wrong.
    """
    global _index_ready
    if _index_ready:
        return
    _index_ready = True
    try:
        await _op(database[COLLECTION].create_index([("user_id", 1), ("updated_at", -1)]))
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        print(f"conversations: index not created ({type(error).__name__}: {error})")


def _require(db: Any) -> Any:
    database = _database(db)
    if database is None:
        raise Unavailable("conversation store is not configured")
    return database


async def lookup(user_id: str, thread_id: str | None, *, db: Any = None) -> tuple[str, dict | None]:
    """Who owns `thread_id`: `("absent"|"owned"|"foreign"|"unavailable", doc)`.

    `/api/chat` calls this before streaming so a signed-in user cannot continue
    another user's thread — the checkpointer would otherwise hand them its
    memory, since it is keyed on thread id alone. "unavailable" lets the chat
    proceed (the write that follows is ownership-checked by `_id` anyway);
    `doc` is only ever returned to its owner.
    """
    if not is_storable_thread_id(thread_id):
        return "absent", None
    database = _database(db)
    if database is None:
        return "unavailable", None
    try:
        doc = await _op(database[COLLECTION].find_one({"_id": thread_id}))
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001 - fail-soft, see docstring
        print(f"conversations: lookup failed ({type(error).__name__}: {error})")
        return "unavailable", None
    if doc is None:
        return "absent", None
    if doc.get("user_id") != user_id:
        return "foreign", None
    return "owned", doc


async def record_turn(
    user_id: str,
    thread_id: str,
    turn: list[dict],
    *,
    db: Any = None,
    now: datetime.datetime | None = None,
) -> bool:
    """Append one completed turn and prune the user's oldest chats. Total.

    Returns whether the turn was stored. Never raises: this runs inside an
    already-committed stream (see the module docstring's failure posture).
    """
    if not user_id or not is_storable_thread_id(thread_id) or not turn:
        return False
    database = _database(db)
    if database is None:
        return False
    moment = now or _utcnow()
    try:
        await _ensure_index(database)
        collection = database[COLLECTION]
        existing = await _op(collection.find_one({"_id": thread_id}))
        if existing is not None and existing.get("user_id") != user_id:
            print("conversations: refused a write to another user's thread")
            return False
        if existing is None:
            question = next((m.get("content") for m in turn if m.get("role") == "user"), "")
            doc = {
                "_id": thread_id,
                "user_id": user_id,
                "title": make_title(question or ""),
                "created_at": moment,
                "messages": [],
            }
        else:
            doc = dict(existing)
        messages = _trim(list(doc.get("messages") or []) + list(turn))
        doc.update(
            messages=messages,
            updated_at=moment,
            message_count=len(messages),
            size_bytes=_size(messages),
        )
        # Filtered on `user_id` as well as `_id`: if another user's document
        # appeared since the read above, the upsert's insert collides on
        # `_id` and raises instead of overwriting it.
        await _op(collection.replace_one({"_id": thread_id, "user_id": user_id}, doc, upsert=True))
        await _prune(collection, user_id, keep=thread_id)
        return True
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001 - fail-soft by contract
        print(f"conversations: turn not saved ({type(error).__name__}: {error})")
        return False


async def _prune(collection: Any, user_id: str, *, keep: str) -> int:
    """Delete the user's oldest conversations past either per-user cap.

    Walks newest-first, keeping conversations while both the count and the
    cumulative bytes fit; `keep` (the one just written) is always kept even if
    it alone is over the byte budget — deleting the chat the reader is in the
    middle of would be the cap defeating the feature.
    """
    cursor = collection.find(
        {"user_id": user_id}, {"_id": 1, "size_bytes": 1, "updated_at": 1}
    ).sort([("updated_at", -1), ("_id", -1)])
    rows = await _op(cursor.to_list(length=None))
    kept, total, doomed = 0, 0, []
    for row in rows:
        size = int(row.get("size_bytes") or 0)
        if row["_id"] == keep or (
            kept < MAX_CONVERSATIONS_PER_USER and total + size <= MAX_USER_BYTES
        ):
            kept += 1
            total += size
        else:
            doomed.append(row["_id"])
    if doomed:
        await _op(collection.delete_many({"_id": {"$in": doomed}, "user_id": user_id}))
    return len(doomed)


async def list_conversations(
    user_id: str,
    *,
    limit: int = DEFAULT_PAGE_SIZE,
    cursor: str | None = None,
    query: str | None = None,
    db: Any = None,
) -> dict:
    """One page of the user's chats, newest first: `{items, next_cursor}`.

    Keyset pagination on `(updated_at, _id)` rather than skip/limit: a chat
    continued while the reader is paging moves to the top, and an offset would
    then show one row twice and skip another. `messages` is projected out — a
    list row needs a title and a time, not up to 1.5MB of transcript.

    `query` is a case-insensitive substring match on the title, escaped, so a
    search for "1:23.4" is not a regex.
    """
    database = _require(db)
    size = max(1, min(int(limit or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
    selector: dict[str, Any] = {"user_id": user_id}
    position = _decode_cursor(cursor)
    if position is not None:
        moment, last_id = position
        selector["$or"] = [
            {"updated_at": {"$lt": moment}},
            {"updated_at": moment, "_id": {"$lt": last_id}},
        ]
    text = (query or "").strip()[:MAX_QUERY_CHARS]
    if text:
        selector["title"] = {"$regex": re.escape(text), "$options": "i"}
    try:
        rows = await _op(
            database[COLLECTION]
            .find(selector, {"messages": 0})
            .sort([("updated_at", -1), ("_id", -1)])
            .limit(size + 1)
            .to_list(length=size + 1)
        )
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        raise Unavailable(str(error)) from error
    more = len(rows) > size
    rows = rows[:size]
    next_cursor = _encode_cursor(rows[-1].get("updated_at"), rows[-1]["_id"]) if more and rows else None
    return {"items": [summary(row) for row in rows], "next_cursor": next_cursor}


async def get_conversation(user_id: str, thread_id: str, *, db: Any = None) -> dict | None:
    """The owner's full conversation, or None — for a missing id AND a foreign one."""
    database = _require(db)
    if not is_storable_thread_id(thread_id):
        return None
    try:
        return await _op(database[COLLECTION].find_one({"_id": thread_id, "user_id": user_id}))
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        raise Unavailable(str(error)) from error


async def rename(user_id: str, thread_id: str, title: str, *, db: Any = None) -> dict | None:
    """Set the title; returns the updated summary, or None if not the owner's.

    Deliberately does not bump `updated_at`: renaming is housekeeping, and a
    chat jumping to the top of "Today" because its title was edited would read
    as the list reshuffling itself.
    """
    database = _require(db)
    if not is_storable_thread_id(thread_id):
        return None
    try:
        from pymongo import ReturnDocument

        doc = await _op(
            database[COLLECTION].find_one_and_update(
                {"_id": thread_id, "user_id": user_id},
                {"$set": {"title": title}},
                projection={"messages": 0},
                return_document=ReturnDocument.AFTER,
            )
        )
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        raise Unavailable(str(error)) from error
    return summary(doc) if doc else None


async def _forget_threads(saver: Any, thread_ids: list[str]) -> None:
    """Delete the checkpointer's memory for deleted chats, best-effort.

    "Delete" should mean the model forgets too, not only that the list row
    disappears — otherwise a deleted chat's content would still sit in
    `checkpoints` for up to the TTL, keyed by an id the user may still have.
    The `--repair` scratch thread goes with it. Failures are logged and
    swallowed: the TTL is the backstop.
    """
    if saver is None:
        return
    for thread_id in thread_ids:
        for tid in (thread_id, f"{thread_id}--repair"):
            try:
                await _op(saver.adelete_thread(tid))
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001
                print(f"conversations: checkpoint not deleted ({type(error).__name__}: {error})")


async def delete(user_id: str, thread_id: str, *, saver: Any = None, db: Any = None) -> bool:
    """Delete one of the owner's chats. False (→ 404) if it is not theirs."""
    database = _require(db)
    if not is_storable_thread_id(thread_id):
        return False
    try:
        result = await _op(database[COLLECTION].delete_one({"_id": thread_id, "user_id": user_id}))
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        raise Unavailable(str(error)) from error
    if not result.deleted_count:
        return False
    await _forget_threads(saver, [thread_id])
    return True


async def delete_all(user_id: str, *, saver: Any = None, db: Any = None) -> int:
    """Delete every chat the user owns; returns how many."""
    database = _require(db)
    collection = database[COLLECTION]
    try:
        rows = await _op(collection.find({"user_id": user_id}, {"_id": 1}).to_list(length=None))
        ids = [row["_id"] for row in rows]
        if ids:
            await _op(collection.delete_many({"user_id": user_id}))
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        raise Unavailable(str(error)) from error
    await _forget_threads(saver, ids)
    return len(ids)


async def checkpoint_exists(saver: Any, thread_id: str) -> bool | None:
    """Whether the checkpointer still holds memory for `thread_id`.

    None when it cannot tell (no saver, or the read failed). The caller seeds
    only on a definite False: seeding on top of a live checkpoint would put
    every old turn into the model's context twice.
    """
    if saver is None:
        return None
    try:
        found = await _op(saver.aget_tuple({"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}))
    except asyncio.CancelledError:
        raise
    except Exception as error:  # noqa: BLE001
        print(f"conversations: checkpoint probe failed ({type(error).__name__}: {error})")
        return None
    return found is not None
