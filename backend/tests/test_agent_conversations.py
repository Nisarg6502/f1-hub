"""Tests for saved chat history — `agent/conversations.py` and its endpoints.

Three layers, mirroring `test_agent_rate_limit.py`'s split:

* **Store** — the pure helpers (titles, size shrinking, trimming, seeding) and
  the Mongo-facing functions against an in-memory fake.
* **Endpoints** — `/api/conversations*` driven through the real ASGI app:
  auth, ownership, pagination, rename and both deletes.
* **Chat** — `/api/chat` with and without a token: a completed turn is stored
  with what the panel needs to re-render it, a guest writes nothing, a Mongo
  failure never breaks the stream, and continuing a chat whose checkpoint has
  expired replays the transcript.

**What `FakeCollection` proves.** It implements the handful of operations this
module calls, with the query operators it uses (`$in`, `$lt`, `$or`, an
escaped `$regex`), and nothing more. That is enough to test the *policy* —
who may read what, what gets pruned, how pages are cut — and is not evidence
about MongoDB itself, for the reason `test_agent_rate_limit.py` gives. No test
here touches a real database.
"""

import asyncio
import datetime
import json
import re
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import jwt

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import concurrency, conversations, main, rate_limit

SECRET = "test-user-token-secret-0123456789abcdef"
UTC = datetime.timezone.utc


# --------------------------------------------------------------------------
# fakes
# --------------------------------------------------------------------------


class DuplicateKeyError(Exception):
    pass


def _matches(doc: dict, selector: dict) -> bool:
    for key, cond in selector.items():
        if key == "$or":
            if not any(_matches(doc, branch) for branch in cond):
                return False
            continue
        value = doc.get(key)
        if isinstance(cond, dict):
            if "$in" in cond and value not in cond["$in"]:
                return False
            if "$lt" in cond and not (value is not None and value < cond["$lt"]):
                return False
            if "$regex" in cond:
                flags = re.I if "i" in cond.get("$options", "") else 0
                if not re.search(cond["$regex"], value or "", flags):
                    return False
        elif value != cond:
            return False
    return True


class FakeCursor:
    def __init__(self, docs: list[dict]):
        self.docs = docs

    def sort(self, keys):
        for field, direction in reversed(keys):
            self.docs.sort(key=lambda d: d.get(field), reverse=direction < 0)
        return self

    def limit(self, n):
        self.docs = self.docs[:n]
        return self

    async def to_list(self, length=None):
        return [dict(d) for d in self.docs]


class FakeCollection:
    def __init__(self):
        self.docs: dict[str, dict] = {}
        self.fail_with: Exception | None = None
        self.calls = 0

    def _check(self):
        self.calls += 1
        if self.fail_with:
            raise self.fail_with

    async def create_index(self, *_a, **_k):
        self._check()

    async def find_one(self, selector):
        self._check()
        for doc in self.docs.values():
            if _matches(doc, selector):
                return dict(doc)
        return None

    def find(self, selector, projection=None):
        self._check()
        rows = [d for d in self.docs.values() if _matches(d, selector)]
        if projection and projection.get("messages") == 0:
            rows = [{k: v for k, v in d.items() if k != "messages"} for d in rows]
        return FakeCursor(rows)

    async def replace_one(self, selector, doc, upsert=False):
        self._check()
        for key, existing in self.docs.items():
            if _matches(existing, selector):
                self.docs[key] = dict(doc)
                return
        if not upsert:
            return
        if doc["_id"] in self.docs:
            raise DuplicateKeyError(doc["_id"])
        self.docs[doc["_id"]] = dict(doc)

    async def find_one_and_update(self, selector, update, projection=None, return_document=None):
        self._check()
        for doc in self.docs.values():
            if _matches(doc, selector):
                doc.update(update.get("$set") or {})
                return {k: v for k, v in doc.items() if k != "messages"}
        return None

    async def delete_one(self, selector):
        self._check()
        for key, doc in list(self.docs.items()):
            if _matches(doc, selector):
                del self.docs[key]
                return _Deleted(1)
        return _Deleted(0)

    async def delete_many(self, selector):
        self._check()
        doomed = [k for k, d in self.docs.items() if _matches(d, selector)]
        for key in doomed:
            del self.docs[key]
        return _Deleted(len(doomed))


class _Deleted:
    def __init__(self, n):
        self.deleted_count = n


class FakeDB:
    def __init__(self):
        self.collection = FakeCollection()

    def __getitem__(self, name):
        assert name == conversations.COLLECTION, name
        return self.collection


class FakeSaver:
    """The two checkpointer methods `conversations` calls."""

    def __init__(self, threads=()):
        self.threads = set(threads)
        self.deleted: list[str] = []

    async def aget_tuple(self, cfg):
        return object() if cfg["configurable"]["thread_id"] in self.threads else None

    async def adelete_thread(self, thread_id):
        self.deleted.append(thread_id)
        self.threads.discard(thread_id)


def run(coro):
    return asyncio.run(coro)


def at(minutes: int) -> datetime.datetime:
    return datetime.datetime(2026, 10, 26, 12, 0, tzinfo=UTC) + datetime.timedelta(minutes=minutes)


def turn(question="Who won Monaco?", answer="Lando Norris won [ev_1].", **extra):
    return conversations.build_turn(question=question, answer=answer, **extra)


# --------------------------------------------------------------------------
# store
# --------------------------------------------------------------------------


class TitleTests(unittest.TestCase):
    def test_a_short_question_is_its_own_title(self):
        self.assertEqual(conversations.make_title("  Who won   Monaco? "), "Who won Monaco?")

    def test_a_long_question_is_cut_at_a_word_and_marked(self):
        title = conversations.make_title("Compare " + "the championship fight " * 10)
        self.assertLessEqual(len(title), conversations.TITLE_MAX_CHARS)
        self.assertTrue(title.endswith("…"))
        self.assertFalse(title[:-1].endswith(" "))

    def test_one_enormous_word_is_cut_rather_than_erased(self):
        title = conversations.make_title("x" * 200)
        self.assertEqual(len(title), conversations.TITLE_MAX_CHARS)

    def test_a_rename_is_trimmed_and_empty_is_refused(self):
        self.assertEqual(conversations.clean_title("  Monaco  notes "), "Monaco notes")
        self.assertIsNone(conversations.clean_title("   "))


class ThreadIdTests(unittest.TestCase):
    def test_uuids_are_storable(self):
        self.assertTrue(conversations.is_storable_thread_id("6f1c1b8e-2a34-4b7e-9d33-6f0a3c9d5e21"))

    def test_repair_threads_are_never_storable(self):
        self.assertFalse(conversations.is_storable_thread_id("abc--repair"))
        self.assertFalse(conversations.is_storable_thread_id(None))
        self.assertFalse(conversations.is_storable_thread_id("../etc"))


class BuildTurnTests(unittest.TestCase):
    def test_a_plain_answer_stores_no_empty_fields(self):
        _user, assistant = turn()
        self.assertEqual(set(assistant), {"role", "content", "created_at"})

    def test_everything_the_panel_renders_is_kept(self):
        _user, assistant = turn(
            visuals=[{"visual_id": "vis_1", "code": "x", "data": [1]}],
            sources=[{"id": "ev_1", "n": 1}],
            anchors=[{"evidence_id": "ev_1", "start": 0, "end": 5}],
            followups=["And Verstappen?"],
            run_id="run-1",
            meta={"tier": 2, "verification": "verification_failed", "mode": "model", "elapsed_ms": 9},
        )
        self.assertEqual(assistant["visuals"][0]["visual_id"], "vis_1")
        self.assertEqual(assistant["citations"]["anchors"][0]["evidence_id"], "ev_1")
        self.assertEqual(assistant["followups"], ["And Verstappen?"])
        self.assertEqual(assistant["meta"]["verification"], "verification_failed")
        self.assertEqual(assistant["run_id"], "run-1")

    def test_an_oversized_answer_drops_its_largest_chart_first(self):
        big = {"visual_id": "big", "code": "x", "data": "y" * (conversations.MAX_MESSAGE_BYTES)}
        small = {"visual_id": "small", "code": "x", "data": [1, 2]}
        _user, assistant = turn(visuals=[big, small], sources=[{"id": "ev_1"}])
        self.assertEqual([v["visual_id"] for v in assistant["visuals"]], ["small"])
        self.assertEqual(assistant["visuals_omitted"], 1)
        self.assertEqual(assistant["citations"]["sources"], [{"id": "ev_1"}])
        self.assertLessEqual(conversations._size(assistant), conversations.MAX_MESSAGE_BYTES)


class SeedTests(unittest.TestCase):
    def test_markers_are_stripped_and_only_recent_turns_replayed(self):
        messages = []
        for i in range(10):
            messages += turn(question=f"q{i}", answer=f"a{i} [ev_{i}] 【ev_2】.")
        seeded = conversations.seed_messages({"messages": messages}, turns=3)
        self.assertEqual([m["content"] for m in seeded][:2], ["q7", "a7."])
        self.assertEqual(len(seeded), 6)
        self.assertFalse(any("ev_" in m["content"] for m in seeded))
        self.assertEqual(set(seeded[0]), {"role", "content"})


class RecordTurnTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()

    def test_the_first_turn_creates_the_chat_titled_by_its_question(self):
        self.assertTrue(run(conversations.record_turn("u1", "t1", turn("  Who won   Monaco? "), db=self.db, now=at(0))))
        doc = self.db.collection.docs["t1"]
        self.assertEqual((doc["user_id"], doc["title"], doc["message_count"]), ("u1", "Who won Monaco?", 2))

    def test_later_turns_append_and_keep_the_title(self):
        run(conversations.record_turn("u1", "t1", turn("first"), db=self.db, now=at(0)))
        run(conversations.record_turn("u1", "t1", turn("second"), db=self.db, now=at(5)))
        doc = self.db.collection.docs["t1"]
        self.assertEqual(doc["title"], "first")
        self.assertEqual([m["content"] for m in doc["messages"] if m["role"] == "user"], ["first", "second"])
        self.assertEqual(doc["updated_at"], at(5))

    def test_another_users_thread_is_never_written(self):
        run(conversations.record_turn("u1", "t1", turn("mine"), db=self.db, now=at(0)))
        self.assertFalse(run(conversations.record_turn("u2", "t1", turn("theirs"), db=self.db)))
        self.assertEqual(self.db.collection.docs["t1"]["message_count"], 2)

    def test_a_mongo_failure_is_swallowed(self):
        self.db.collection.fail_with = RuntimeError("cluster unreachable")
        self.assertFalse(run(conversations.record_turn("u1", "t1", turn(), db=self.db)))

    def test_repair_threads_are_not_recorded(self):
        self.assertFalse(run(conversations.record_turn("u1", "t1--repair", turn(), db=self.db)))
        self.assertEqual(self.db.collection.docs, {})

    def test_a_long_chat_drops_its_oldest_turns(self):
        with patch.object(conversations, "MAX_MESSAGES_PER_CONVERSATION", 6):
            for i in range(5):
                run(conversations.record_turn("u1", "t1", turn(f"q{i}"), db=self.db, now=at(i)))
        doc = self.db.collection.docs["t1"]
        self.assertEqual([m["content"] for m in doc["messages"] if m["role"] == "user"], ["q2", "q3", "q4"])
        self.assertEqual(doc["messages"][0]["role"], "user")


class PruneTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()

    def test_the_oldest_chats_go_past_the_count_cap(self):
        with patch.object(conversations, "MAX_CONVERSATIONS_PER_USER", 3):
            for i in range(5):
                run(conversations.record_turn("u1", f"t{i}", turn(), db=self.db, now=at(i)))
            run(conversations.record_turn("u2", "other", turn(), db=self.db, now=at(0)))
        self.assertEqual(sorted(self.db.collection.docs), ["other", "t2", "t3", "t4"])

    def test_the_oldest_chats_go_past_the_byte_budget(self):
        one = conversations._size(turn())
        with patch.object(conversations, "MAX_USER_BYTES", one * 2 + 10):
            for i in range(4):
                run(conversations.record_turn("u1", f"t{i}", turn(), db=self.db, now=at(i)))
        self.assertEqual(sorted(self.db.collection.docs), ["t2", "t3"])

    def test_the_chat_just_written_survives_even_alone_over_budget(self):
        with patch.object(conversations, "MAX_USER_BYTES", 10):
            run(conversations.record_turn("u1", "t0", turn(), db=self.db, now=at(0)))
            run(conversations.record_turn("u1", "t1", turn(), db=self.db, now=at(1)))
        self.assertEqual(list(self.db.collection.docs), ["t1"])


class ListTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB()
        for i in range(7):
            run(conversations.record_turn("u1", f"t{i}", turn(f"question {i}"), db=self.db, now=at(i)))
        run(conversations.record_turn("u2", "x", turn("question x"), db=self.db, now=at(99)))

    def test_pages_are_newest_first_and_never_overlap(self):
        first = run(conversations.list_conversations("u1", limit=3, db=self.db))
        self.assertEqual([r["id"] for r in first["items"]], ["t6", "t5", "t4"])
        second = run(conversations.list_conversations("u1", limit=3, cursor=first["next_cursor"], db=self.db))
        self.assertEqual([r["id"] for r in second["items"]], ["t3", "t2", "t1"])
        third = run(conversations.list_conversations("u1", limit=3, cursor=second["next_cursor"], db=self.db))
        self.assertEqual([r["id"] for r in third["items"]], ["t0"])
        self.assertIsNone(third["next_cursor"])

    def test_rows_carry_no_messages(self):
        row = run(conversations.list_conversations("u1", limit=1, db=self.db))["items"][0]
        self.assertEqual(set(row), {"id", "title", "created_at", "updated_at", "message_count"})
        self.assertTrue(row["updated_at"].endswith("Z"))

    def test_search_is_a_case_insensitive_literal(self):
        found = run(conversations.list_conversations("u1", query="QUESTION 3", db=self.db))
        self.assertEqual([r["id"] for r in found["items"]], ["t3"])
        self.assertEqual(run(conversations.list_conversations("u1", query=".*", db=self.db))["items"], [])

    def test_an_unreachable_store_is_an_error_not_an_empty_list(self):
        self.db.collection.fail_with = RuntimeError("down")
        with self.assertRaises(conversations.Unavailable):
            run(conversations.list_conversations("u1", db=self.db))


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------


def mint(sub="user-1", *, exp_in=600, secret=SECRET):
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "aud": "f1-agent", "iss": "apex-frontend", "iat": now - 5, "exp": now + exp_in},
        secret,
        algorithm="HS256",
    )


class Result:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = {k.lower(): v for k, v in headers}
        self.body = body

    def json(self):
        return json.loads(self.body or b"null")

    @property
    def events(self):
        out = []
        for block in self.body.decode().split("\n\n"):
            block = block.strip()
            if not block or block.startswith(":"):
                continue
            name = data = None
            for line in block.splitlines():
                if line.startswith("event: "):
                    name = line[7:]
                elif line.startswith("data: "):
                    data = json.loads(line[6:])
            if name:
                out.append((name, data))
        return out


def call(method, path, body=None, *, token=None, headers=(), query=b""):
    async def drive():
        raw_headers = [(b"host", b"testserver"), (b"content-type", b"application/json")]
        if token:
            raw_headers.append((b"authorization", f"Bearer {token}".encode()))
        raw_headers += [(k.encode(), v.encode()) for k, v in headers]
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": method, "path": path, "raw_path": path.encode(),
            "query_string": query, "root_path": "", "scheme": "http",
            "headers": raw_headers, "client": ("127.0.0.1", 1), "server": ("testserver", 80),
        }
        inbound = [{"type": "http.request", "body": json.dumps(body).encode() if body is not None else b"", "more_body": False}]

        async def receive():
            if inbound:
                return inbound.pop(0)
            await asyncio.Event().wait()

        captured = {"status": None, "headers": [], "body": b""}

        async def send(message):
            if message["type"] == "http.response.start":
                captured["status"] = message["status"]
                captured["headers"] = [(k.decode(), v.decode()) for k, v in message.get("headers", [])]
            elif message["type"] == "http.response.body":
                captured["body"] += message.get("body", b"")

        await main.app(scope, receive, send)
        return Result(captured["status"], captured["headers"], captured["body"])

    return asyncio.run(drive())


class _StoreCase(unittest.TestCase):
    """Patches the store onto a fresh fake and the token secret onto `SECRET`."""

    def setUp(self):
        concurrency.reset_for_tests()
        rate_limit.reset_for_tests()
        self.db = FakeDB()
        self.saver = FakeSaver()
        for patcher in (
            patch.object(conversations, "_database", lambda db=None: self.db),
            patch.object(main.user_auth.config, "user_token_secret", lambda: SECRET),
            patch.object(main.checkpointer, "current", lambda: self.saver),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def seed(self, user="user-1", thread="t1", minute=0, question="Who won Monaco?"):
        run(conversations.record_turn(user, thread, turn(question), db=self.db, now=at(minute)))


class EndpointAuthTests(_StoreCase):
    def test_no_token_is_401_with_a_bearer_challenge(self):
        result = call("GET", "/api/conversations")
        self.assertEqual(result.status, 401)
        self.assertIn("Bearer", result.headers["www-authenticate"])

    def test_an_expired_token_is_401(self):
        self.assertEqual(call("GET", "/api/conversations", token=mint(exp_in=-600)).status, 401)

    def test_a_forged_token_is_401(self):
        forged = mint(secret="another-secret-entirely-0000000000000")
        self.assertEqual(call("GET", "/api/conversations", token=forged).status, 401)

    def test_an_unreachable_store_is_503(self):
        self.db.collection.fail_with = RuntimeError("down")
        self.assertEqual(call("GET", "/api/conversations", token=mint()).status, 503)

    def test_history_requests_are_charged_a_token_cost_per_caller_only(self):
        with patch.object(main.config, "RATE_LIMIT_ENABLED", True), \
             patch.object(main.rate_limit, "check_and_charge") as charge:
            async def allow(*_a, **kwargs):
                return rate_limit.Decision(allowed=True, enabled=True)
            charge.side_effect = allow
            call("GET", "/api/conversations", token=mint())
        self.assertEqual(charge.call_args.kwargs["cost"], rate_limit.HISTORY_COST)
        self.assertFalse(charge.call_args.kwargs["charge_global"])


class EndpointTests(_StoreCase):
    def test_list_get_rename_delete(self):
        self.seed(thread="t1", minute=0, question="Monaco")
        self.seed(thread="t2", minute=1, question="Silverstone")
        token = mint()

        listed = call("GET", "/api/conversations", token=token, query=b"limit=1").json()
        self.assertEqual([r["id"] for r in listed["items"]], ["t2"])
        more = call("GET", "/api/conversations", token=token,
                    query=f"limit=1&cursor={listed['next_cursor']}".encode()).json()
        self.assertEqual([r["id"] for r in more["items"]], ["t1"])

        full = call("GET", "/api/conversations/t1", token=token).json()
        self.assertEqual([m["role"] for m in full["messages"]], ["user", "assistant"])
        self.assertTrue(full["messages"][0]["created_at"].endswith("Z"))

        renamed = call("PATCH", "/api/conversations/t1", {"title": "  My Monaco chat  "}, token=token)
        self.assertEqual(renamed.json()["title"], "My Monaco chat")
        self.assertEqual(call("PATCH", "/api/conversations/t1", {"title": "  "}, token=token).status, 400)

        self.assertEqual(call("DELETE", "/api/conversations/t1", token=token).status, 204)
        self.assertEqual(call("GET", "/api/conversations/t1", token=token).status, 404)
        self.assertEqual(self.saver.deleted, ["t1", "t1--repair"])

        self.assertEqual(call("DELETE", "/api/conversations", token=token).json(), {"deleted": 1})
        self.assertEqual(call("GET", "/api/conversations", token=token).json()["items"], [])

    def test_another_users_thread_is_404_everywhere(self):
        self.seed(user="user-1", thread="t1")
        intruder = mint("user-2")
        self.assertEqual(call("GET", "/api/conversations/t1", token=intruder).status, 404)
        self.assertEqual(call("PATCH", "/api/conversations/t1", {"title": "mine"}, token=intruder).status, 404)
        self.assertEqual(call("DELETE", "/api/conversations/t1", token=intruder).status, 404)
        self.assertEqual(call("GET", "/api/conversations", token=intruder).json()["items"], [])
        self.assertEqual(call("DELETE", "/api/conversations", token=intruder).json(), {"deleted": 0})
        self.assertIn("t1", self.db.collection.docs)
        self.assertEqual(self.db.collection.docs["t1"]["title"], "Who won Monaco?")

    def test_the_preflight_allows_the_bearer_header_and_new_methods(self):
        result = call(
            "OPTIONS", "/api/conversations/t1",
            headers=[
                ("origin", main.config.ALLOWED_ORIGINS[0]),
                ("access-control-request-method", "DELETE"),
                ("access-control-request-headers", "authorization,content-type"),
            ],
        )
        self.assertEqual(result.status, 200)
        self.assertIn("authorization", result.headers["access-control-allow-headers"].lower())
        self.assertIn("DELETE", result.headers["access-control-allow-methods"])


# --------------------------------------------------------------------------
# chat
# --------------------------------------------------------------------------


async def _no_chips(*_a, **_k):
    return []


async def _chips(*_a, **_k):
    return ["What about Verstappen?"]


def _agent(seen: list):
    async def fake(message, *, thread_id, ledger, checkpointer=None, history=None):
        seen.append({"message": message, "thread_id": thread_id, "history": history})
        ledger.append(source="mongo:race_results/2026-8", data={"winner": "Lando Norris"})
        yield ("tier", 2, "test")
        await asyncio.sleep(0)
        yield ("token", "Lando Norris won ")
        yield ("token", "[ev_1].")
        yield ("verification", True, 0)
        yield ("visual", {
            "visual_id": "vis_1", "evidence_id": "ev_1", "title": "Finishing order",
            "caption": "", "as_of": "2026-06-07", "code": "export default () => {}",
            "data": {"winner": "Lando Norris"},
        })
    return fake


class ChatPersistenceTests(_StoreCase):
    def setUp(self):
        super().setUp()
        self.seen: list = []
        for patcher in (
            patch.object(main.graph, "astream_answer", _agent(self.seen)),
            patch.object(main.config, "api_key", lambda: "test-key"),
            patch.object(main.followups, "suggest", _chips),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def chat(self, message="Who won Monaco?", thread="t1", token=None):
        result = call("POST", "/api/chat", {"message": message, "thread_id": thread}, token=token)
        return result

    def test_a_signed_in_turn_is_stored_with_everything_needed_to_replay_it(self):
        result = self.chat(token=mint())
        self.assertEqual(result.status, 200)
        self.assertIn("done", [n for n, _ in result.events])
        doc = self.db.collection.docs["t1"]
        self.assertEqual(doc["user_id"], "user-1")
        self.assertEqual(doc["title"], "Who won Monaco?")
        user, assistant = doc["messages"]
        self.assertEqual(user["content"], "Who won Monaco?")
        self.assertEqual(assistant["content"], "Lando Norris won [ev_1].")
        self.assertEqual(assistant["visuals"][0]["title"], "Finishing order")
        self.assertEqual(assistant["citations"]["sources"][0]["id"], "ev_1")
        self.assertTrue(assistant["citations"]["anchors"])
        self.assertEqual(assistant["followups"], ["What about Verstappen?"])
        self.assertEqual(assistant["meta"]["verification"], "passed")
        self.assertEqual(assistant["meta"]["tier"], 2)

    def test_a_guest_turn_touches_no_database(self):
        with patch.object(conversations, "_database", side_effect=AssertionError("guest hit the store")):
            result = self.chat()
        self.assertIn("done", [n for n, _ in result.events])
        self.assertEqual(self.db.collection.calls, 0)

    def test_an_expired_token_is_answered_as_a_guest_and_not_stored(self):
        result = self.chat(token=mint(exp_in=-600))
        self.assertEqual(result.status, 200)
        self.assertIn("done", [n for n, _ in result.events])
        self.assertEqual(self.db.collection.docs, {})

    def test_a_mongo_failure_never_breaks_the_stream(self):
        self.db.collection.fail_with = RuntimeError("cluster unreachable")
        result = self.chat(token=mint())
        names = [n for n, _ in result.events]
        self.assertIn("done", names)
        self.assertIn("suggestions", names)
        self.assertNotIn("error", names)

    def test_a_failed_turn_is_not_stored(self):
        async def broken(*_a, **_k):
            raise main.model.ModelError("boom")
            yield  # pragma: no cover

        with patch.object(main.graph, "astream_answer", broken):
            result = self.chat(token=mint())
        self.assertIn("error", [n for n, _ in result.events])
        self.assertEqual(self.db.collection.docs, {})

    def test_continuing_another_users_thread_is_404_and_runs_nothing(self):
        self.seed(user="user-1", thread="t1")
        result = self.chat(thread="t1", token=mint("user-2"))
        self.assertEqual(result.status, 404)
        self.assertEqual(self.seen, [])
        self.assertEqual(self.db.collection.docs["t1"]["message_count"], 2)

    def test_continuing_with_a_live_checkpoint_reuses_the_thread_only(self):
        self.seed(thread="t1")
        self.saver.threads.add("t1")
        self.chat(message="And who was second?", thread="t1", token=mint())
        self.assertIsNone(self.seen[0]["history"])
        self.assertEqual(self.db.collection.docs["t1"]["message_count"], 4)

    def test_continuing_after_the_checkpoint_expired_replays_the_transcript(self):
        self.seed(thread="t1", question="Who won Monaco?")
        # No checkpoint for t1: it has expired.
        self.chat(message="And who was second?", thread="t1", token=mint())
        history = self.seen[0]["history"]
        self.assertEqual(history[0], {"role": "user", "content": "Who won Monaco?"})
        self.assertEqual(history[1]["role"], "assistant")
        self.assertNotIn("[ev_", history[1]["content"])
        self.assertEqual(self.seen[0]["thread_id"], "t1")

    def test_a_new_thread_has_nothing_to_replay(self):
        self.chat(thread="fresh", token=mint())
        self.assertIsNone(self.seen[0]["history"])


if __name__ == "__main__":
    unittest.main()
