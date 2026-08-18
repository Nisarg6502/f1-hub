"""Tests for `app/watch_session.py` — the paired watch-party sessions.

Two layers, for the same reason `test_agent_rate_limit.py` gives:

* **Unit** — the pure pieces (`resolve_client_ip`, code normalisation, the
  expiry clocks, the join counters against a fake collection). This is where the
  adversarial cases belong, because a mistake in them is *silent*: a limiter that
  reads a spoofable header still answers 200 and still looks like it works, and
  a code that outlives its own window still pairs.
* **End-to-end over ASGI** — because the security properties are properties of
  the wire, not of a function. "Only `join` accepts a code", "a burned code and
  a wrong code are indistinguishable" and "a 429 carries `Retry-After`" are only
  true if they survive FastAPI's routing and validation. Driven through the real
  app object rather than `fastapi.testclient`, following the convention
  `test_agent_chat.py` established so the suite is not coupled to an httpx major.

**What `FakeSessions` does and does not prove.** It implements the operations
this module actually issues — `insert_one` with the unique-on-`code` constraint,
`find_one_and_update` with `$set`/`$inc`/`$gt`/`$lt` and the *pre-update* return,
`delete_one` — and nothing else. That is enough to test the policy (what is
burned, what is refused, what expires) and it is explicitly NOT evidence about
MongoDB's own semantics: a fake written from the same assumptions as the code
cannot falsify them. Two of those assumptions are load-bearing and are called out
where they are used: that `find_one_and_update` returns the document as it stood
*before* the update by default, and that `$inc` is atomic. No test here touches a
real database.
"""

import asyncio
import json
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# `watch_session` imports motor via `db.py` at module scope; these tests never
# touch Mongo. Same stub the other endpoint suites install.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:  # pragma: no cover - stub
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import main, watch_session as ws


# --------------------------------------------------------------------------
# fakes
# --------------------------------------------------------------------------


class DuplicateKeyError(Exception):
    """Named to match pymongo's, because the retry loop in `create_session`
    recognises the failure by type name or message rather than by importing
    pymongo's exception hierarchy into an endpoint."""


def _matches(doc: dict, query: dict) -> bool:
    for field, condition in query.items():
        value = doc.get(field)
        if isinstance(condition, dict):
            for operator, operand in condition.items():
                if operator == "$gt":
                    if value is None or not _cmp(value) > _cmp(operand):
                        return False
                elif operator == "$lt":
                    if value is None or not _cmp(value) < _cmp(operand):
                        return False
                elif operator == "$type":
                    if operand == "string" and not isinstance(value, str):
                        return False
                else:  # pragma: no cover - would be a test bug, not a code path
                    raise AssertionError(f"unsupported operator {operator}")
        elif value != condition:
            return False
    return True


def _cmp(value):
    """Datetimes coming back out of a real Mongo are naive; the module is written
    to survive that (`_as_utc`). The fake stores whatever it was given, so
    comparisons normalise here rather than pretending the two are the same type."""
    if isinstance(value, datetime) and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


class FakeSessions:
    """In-memory stand-in for one collection. See the module docstring."""

    def __init__(self, *, unique_code: bool = True):
        self.docs: dict = {}
        self.unique_code = unique_code
        self.fail_with: Exception | None = None
        self.calls = 0

    async def create_index(self, *_args, **_kwargs):
        return "ok"

    async def insert_one(self, doc):
        if self.unique_code and doc.get("code"):
            for existing in self.docs.values():
                if existing.get("code") == doc["code"]:
                    raise DuplicateKeyError("E11000 duplicate key error: code")
        self.docs[doc["_id"]] = dict(doc)
        return SimpleNamespace(inserted_id=doc["_id"])

    async def find_one(self, query):
        for doc in self.docs.values():
            if _matches(doc, query):
                return dict(doc)
        return None

    async def find_one_and_update(
        self, query, update, upsert=False, return_document=None, **_kwargs
    ):
        self.calls += 1
        if self.fail_with:
            raise self.fail_with
        target = None
        for doc in self.docs.values():
            if _matches(doc, query):
                target = doc
                break
        if target is None:
            if not upsert:
                return None
            target = {"_id": query.get("_id")}
            self.docs[target["_id"]] = target
        before = dict(target)
        if self.unique_code:
            new_code = (update.get("$set") or {}).get("code")
            if new_code:
                for other in self.docs.values():
                    if other is not target and other.get("code") == new_code:
                        raise DuplicateKeyError("E11000 duplicate key error: code")
        for field, delta in (update.get("$inc") or {}).items():
            target[field] = (target.get(field) or 0) + delta
        target.update(update.get("$set") or {})
        # Mongo's default is `ReturnDocument.BEFORE`, and `watch_session` relies
        # on it in three places (it patches the returned doc rather than paying a
        # second round trip). Modelled faithfully so a change of that assumption
        # breaks here rather than in production.
        after = dict(target)
        if return_document is None:
            return before
        from pymongo import ReturnDocument

        return after if return_document == ReturnDocument.AFTER else before

    async def delete_one(self, query):
        for key, doc in list(self.docs.items()):
            if _matches(doc, query):
                del self.docs[key]
                return SimpleNamespace(deleted_count=1)
        return SimpleNamespace(deleted_count=0)


class FakeDB:
    def __init__(self):
        self.collections: dict = {}

    def __getitem__(self, name):
        if name not in self.collections:
            self.collections[name] = FakeSessions()
        return self.collections[name]


# --------------------------------------------------------------------------
# ASGI driving — same shape as `test_agent_chat.py::_drive`
# --------------------------------------------------------------------------


class Response:
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = dict(headers)
        self.body = body

    @property
    def json(self):
        return json.loads(self.body or b"{}")


async def _drive(method, path, body=None, query="", headers=None, client=("127.0.0.1", 1234)):
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "path": path,
        "raw_path": path.encode(),
        "query_string": query.encode(),
        "root_path": "",
        "scheme": "http",
        "headers": [(b"host", b"testserver"), (b"content-type", b"application/json")]
        + [(k.encode(), v.encode()) for k, v in (headers or {}).items()],
        "client": client,
        "server": ("testserver", 80),
    }
    payload = json.dumps(body).encode() if body is not None else b""
    inbound = [{"type": "http.request", "body": payload, "more_body": False}]

    async def receive():
        return inbound.pop(0) if inbound else {"type": "http.disconnect"}

    captured = {"status": None, "headers": [], "chunks": []}

    async def send(message):
        if message["type"] == "http.response.start":
            captured["status"] = message["status"]
            captured["headers"] = [
                (k.decode(), v.decode()) for k, v in message.get("headers", [])
            ]
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            if chunk:
                captured["chunks"].append(chunk)

    await main.app(scope, receive, send)
    return Response(captured["status"], captured["headers"], b"".join(captured["chunks"]))


def call(method, path, body=None, **kwargs):
    return asyncio.run(_drive(method, path, body, **kwargs))


class ASGICase(unittest.TestCase):
    """Installs a fresh fake database on the app for each test."""

    def setUp(self):
        ws.reset_for_tests()
        self.db = FakeDB()
        main.app.state.watch_db = self.db

    def tearDown(self):
        main.app.state.watch_db = None

    @property
    def sessions(self):
        return self.db[ws.SESSIONS]

    def create(self, race_id="2026-1"):
        response = call("POST", "/api/watch_session", {"race_id": race_id})
        self.assertEqual(response.status, 200, response.body)
        return response.json


# --------------------------------------------------------------------------
# codes
# --------------------------------------------------------------------------


class CodeTests(unittest.TestCase):
    def test_code_uses_only_unambiguous_symbols(self):
        for _ in range(200):
            code = ws.new_code()
            self.assertEqual(len(code), ws.CODE_LENGTH)
            self.assertTrue(set(code) <= set(ws.CODE_ALPHABET))
        # The whole reason the alphabet is hand-picked: none of these may appear.
        self.assertFalse(set("01ILOU") & set(ws.CODE_ALPHABET))

    def test_alphabet_gives_the_entropy_the_docstring_claims(self):
        self.assertEqual(len(ws.CODE_ALPHABET), 30)
        self.assertEqual(len(set(ws.CODE_ALPHABET)), 30)
        self.assertGreater(len(ws.CODE_ALPHABET) ** ws.CODE_LENGTH, 6e11)

    def test_normalise_accepts_how_people_actually_retype_a_code(self):
        self.assertEqual(ws.normalise_code("abcd 2345"), "ABCD2345")
        self.assertEqual(ws.normalise_code("ABCD-2345"), "ABCD2345")
        self.assertEqual(ws.normalise_code("  abcd2345\n"), "ABCD2345")

    def test_normalise_strips_symbols_that_are_not_in_the_alphabet(self):
        # `I`, `O` and `L` are not codes; silently dropping them rather than
        # substituting is deliberate — a substitution would let one typed string
        # resolve to a code its owner never saw.
        self.assertEqual(ws.normalise_code("ABIOLCD23"), "ABCD23")
        self.assertEqual(ws.normalise_code(None), "")
        self.assertEqual(ws.normalise_code("<script>"), "SCRPT")

    def test_session_id_is_128_bits(self):
        first, second = ws.new_session_id(), ws.new_session_id()
        self.assertEqual(len(first), 32)
        self.assertNotEqual(first, second)


# --------------------------------------------------------------------------
# client identity
# --------------------------------------------------------------------------


class ClientIpTests(unittest.TestCase):
    def test_reads_the_last_entry_by_default(self):
        self.assertEqual(
            ws.resolve_client_ip("203.0.113.9, 198.51.100.4", "10.0.0.1", hops=0),
            "198.51.100.4",
        )

    def test_client_authored_first_entry_is_never_the_identity(self):
        # The attack the "read from the left" implementation enables: a fresh
        # identity per request, for free.
        seen = {
            ws.resolve_client_ip(f"1.2.3.{n}, 198.51.100.4", "10.0.0.1", hops=0)
            for n in range(5)
        }
        self.assertEqual(seen, {"198.51.100.4"})

    def test_hops_skips_proxies_from_the_right(self):
        header = "203.0.113.9, 198.51.100.4, 192.0.2.7"
        self.assertEqual(ws.resolve_client_ip(header, None, hops=1), "198.51.100.4")
        self.assertEqual(ws.resolve_client_ip(header, None, hops=2), "203.0.113.9")

    def test_header_shorter_than_the_hop_count_falls_back_to_the_peer(self):
        # Falling further left would read exactly the entries the hop count
        # exists to skip.
        self.assertEqual(
            ws.resolve_client_ip("203.0.113.9", "198.51.100.4", hops=3), "198.51.100.4"
        )

    def test_junk_is_discarded_not_used_as_a_bucket_key(self):
        self.assertEqual(
            ws.resolve_client_ip("not-an-ip", "198.51.100.4", hops=0), "198.51.100.4"
        )
        self.assertIsNone(ws.resolve_client_ip("not-an-ip", "also-not", hops=0))

    def test_port_forms_and_ipv6_are_canonicalised(self):
        self.assertEqual(ws.resolve_client_ip(None, "1.2.3.4:5678"), "1.2.3.4")
        self.assertEqual(ws.resolve_client_ip(None, "[2001:db8::1]:443"), "2001:db8::1")
        self.assertEqual(
            ws.resolve_client_ip("2001:DB8:0:0::1", None, hops=0), "2001:db8::1"
        )

    def test_subnets(self):
        self.assertEqual(ws.subnet_of("198.51.100.4"), "198.51.100.0/24")
        self.assertEqual(ws.subnet_of("2001:db8::1"), "2001:db8::/64")
        self.assertIsNone(ws.subnet_of(None))

    def test_identify_charges_address_and_subnet_together(self):
        request = SimpleNamespace(
            headers={"x-forwarded-for": "203.0.113.9, 198.51.100.4"},
            client=SimpleNamespace(host="10.0.0.1"),
        )
        self.assertEqual(
            ws.identify(request),
            [("ip", "i:198.51.100.4"), ("net", "n:198.51.100.0/24")],
        )


# --------------------------------------------------------------------------
# expiry
# --------------------------------------------------------------------------


class ExpiryTests(unittest.TestCase):
    def test_sliding_expiry_is_capped_from_creation(self):
        created = datetime(2026, 8, 18, 12, 0, tzinfo=timezone.utc)
        early = ws.sliding_expiry(created, created + timedelta(minutes=5))
        self.assertEqual(early, created + timedelta(minutes=5, seconds=ws.SESSION_TTL_SECONDS))
        late = ws.sliding_expiry(created, created + timedelta(hours=5))
        self.assertEqual(late, created + timedelta(seconds=ws.SESSION_MAX_SECONDS))

    def test_naive_datetimes_from_mongo_do_not_raise(self):
        # BSON dates carry no zone, so every document read back has naive
        # datetimes in it. Comparing one to an aware `now()` raises TypeError —
        # which would turn every expiry check into a 500 rather than a refusal.
        now = datetime(2026, 8, 18, 12, 0, tzinfo=timezone.utc)
        self.assertFalse(is_expired := ws.is_expired({"expires_at": datetime(2026, 8, 18, 13, 0)}, now))
        self.assertTrue(ws.is_expired({"expires_at": datetime(2026, 8, 18, 11, 0)}, now))
        del is_expired

    def test_missing_or_absent_expiry_reads_as_expired(self):
        now = datetime(2026, 8, 18, 12, 0, tzinfo=timezone.utc)
        self.assertTrue(ws.is_expired(None, now))
        self.assertTrue(ws.is_expired({}, now))

    def test_a_burned_code_is_not_live_even_inside_its_window(self):
        now = datetime(2026, 8, 18, 12, 0, tzinfo=timezone.utc)
        future = now + timedelta(minutes=5)
        self.assertTrue(ws.code_is_live({"code": "ABCD2345", "code_expires_at": future}, now))
        self.assertFalse(ws.code_is_live({"code": None, "code_expires_at": future}, now))
        self.assertFalse(
            ws.code_is_live({"code": "ABCD2345", "code_expires_at": now - timedelta(seconds=1)}, now)
        )


# --------------------------------------------------------------------------
# the join limiter
# --------------------------------------------------------------------------


class JoinRateTests(unittest.TestCase):
    def setUp(self):
        self.limits = FakeSessions()
        self.now = 1_700_000_000.0

    def check(self, keys, now=None):
        return asyncio.run(
            ws.check_join_rate(self.limits, keys, now=self.now if now is None else now)
        )

    def test_burst_limit_refuses_after_its_allowance(self):
        keys = [("ip", "i:198.51.100.4"), ("net", "n:198.51.100.0/24")]
        for _ in range(ws.JOIN_LIMITS["ip"]["burst"]):
            self.assertEqual(self.check(keys), 0)
        wait = self.check(keys)
        self.assertGreater(wait, 0)
        self.assertLessEqual(wait, ws.BURST_SECONDS)

    def test_rotating_within_a_subnet_does_not_multiply_the_allowance(self):
        # The whole reason the subnet is a parallel counter: an attacker with a
        # /24 would otherwise get 256 times the guesses.
        # **Iterate past the subnet limit, not up to it.** The first version of
        # this test looped 39 times against a limit of 40 and asserted 40 —
        # it could not have observed the cap binding even if the cap did not
        # exist, because it never made a 41st attempt. Every address here is
        # distinct, so no per-IP counter is ever spent twice; the only thing
        # that can refuse is the shared subnet counter.
        limit = ws.JOIN_LIMITS["net"]["burst"]
        allowed = 0
        for host in range(1, limit + 20):
            keys = [("ip", f"i:198.51.100.{host}"), ("net", "n:198.51.100.0/24")]
            if self.check(keys) == 0:
                allowed += 1
        self.assertEqual(allowed, limit)

    def test_a_new_window_starts_a_fresh_allowance(self):
        keys = [("ip", "i:198.51.100.4")]
        for _ in range(ws.JOIN_LIMITS["ip"]["burst"]):
            self.assertEqual(self.check(keys), 0)
        self.assertGreater(self.check(keys), 0)
        self.assertEqual(self.check(keys, now=self.now + ws.BURST_SECONDS), 0)

    def test_sustained_window_bounds_a_patient_guesser(self):
        keys = [("ip", "i:198.51.100.4")]
        allowed = 0
        # **Stay inside ONE sustained window.** The first version of this test
        # spread its attempts over two hours and asserted 60; it got 120, which
        # was the limiter working correctly — 3600s is one window, so two hours
        # is two fresh allowances. A test that spans a boundary is measuring
        # rollover, not the cap.
        #
        # Two attempts per burst window keeps the 10-per-minute burst counter
        # well clear, so the only thing that can refuse is the hour window —
        # which is the patient-guesser pattern this bound exists for.
        # **Align to a window start.** `self.now` sits 2800s into a sustained
        # window, so an unaligned hour-long loop straddles the boundary and
        # measures 60 in one window plus 26 in the next — which is the limiter
        # working, reported as a failure. A fixed-window bound can only be
        # observed from inside a single window.
        span = int(ws.SUSTAINED_SECONDS)
        base = (int(self.now) // span + 1) * span
        windows = span // int(ws.BURST_SECONDS)
        for minute in range(windows):
            for offset in (0, 1):
                at = base + minute * ws.BURST_SECONDS + offset
                if self.check(keys, now=at) == 0:
                    allowed += 1
        self.assertEqual(allowed, ws.JOIN_LIMITS["ip"]["sustained"])
        # Non-vacuity: the loop must genuinely have tried more than the limit,
        # or "allowed == limit" would hold for a limiter that refused nothing.
        self.assertGreater(windows * 2, ws.JOIN_LIMITS["ip"]["sustained"])

    def test_a_counter_failure_refuses_rather_than_allowing(self):
        # Fails CLOSED, unlike `agent/rate_limit.py`. The session lookup this
        # guards lives in the same database, so nothing that would have worked is
        # being refused — and failing open here would mean an attacker who can
        # make Mongo wobble gets unlimited guesses.
        self.limits.fail_with = RuntimeError("mongo down")
        self.assertGreater(self.check([("ip", "i:198.51.100.4")]), 0)

    def test_an_unidentifiable_caller_is_refused(self):
        self.assertGreater(self.check([]), 0)


# --------------------------------------------------------------------------
# end to end
# --------------------------------------------------------------------------


class PairingFlowTests(ASGICase):
    def test_create_join_and_drive_from_either_side(self):
        created = self.create()
        self.assertEqual(len(created["code"]), ws.CODE_LENGTH)
        self.assertEqual(created["race_id"], "2026-1")
        self.assertEqual(created["state"]["lap_index"], 0)

        joined = call("POST", "/api/watch_session/join", {"code": created["code"]})
        self.assertEqual(joined.status, 200, joined.body)
        self.assertEqual(joined.json["session_id"], created["session_id"])
        self.assertEqual(joined.json["race_id"], "2026-1")
        self.assertEqual(joined.json["devices"], 2)

        # The joiner drives.
        wrote = call(
            "POST",
            "/api/watch_session/state",
            {
                "session_id": created["session_id"],
                "state": {"lap_index": 17, "playing": True, "timing_mode": "gap", "device": "phone"},
            },
        )
        self.assertEqual(wrote.status, 200, wrote.body)
        self.assertGreater(wrote.json["rev"], created["rev"])

        # The creator sees it.
        read = call("GET", "/api/watch_session", query=f"session_id={created['session_id']}")
        self.assertEqual(read.status, 200)
        self.assertEqual(read.json["state"]["lap_index"], 17)
        self.assertEqual(read.json["state"]["device"], "phone")
        self.assertEqual(read.json["rev"], wrote.json["rev"])

        # And drives back — there is no role, which is the design requirement.
        back = call(
            "POST",
            "/api/watch_session/state",
            {
                "session_id": created["session_id"],
                "state": {"lap_index": 18, "playing": False, "timing_mode": "gap", "device": "desk"},
            },
        )
        self.assertEqual(back.status, 200)
        again = call("GET", "/api/watch_session", query=f"session_id={created['session_id']}")
        self.assertEqual(again.json["state"]["lap_index"], 18)
        self.assertEqual(again.json["state"]["device"], "desk")

    def test_the_join_response_never_echoes_a_code(self):
        created = self.create()
        joined = call("POST", "/api/watch_session/join", {"code": created["code"]})
        self.assertNotIn("code", joined.json)

    def test_a_code_is_single_use(self):
        created = self.create()
        first = call("POST", "/api/watch_session/join", {"code": created["code"]})
        self.assertEqual(first.status, 200)
        second = call("POST", "/api/watch_session/join", {"code": created["code"]})
        self.assertEqual(second.status, 404)

    def test_a_burned_code_and_a_wrong_code_are_indistinguishable(self):
        created = self.create()
        call("POST", "/api/watch_session/join", {"code": created["code"]})
        burned = call("POST", "/api/watch_session/join", {"code": created["code"]})
        wrong = call("POST", "/api/watch_session/join", {"code": "ZZZZ2345"})
        malformed = call("POST", "/api/watch_session/join", {"code": "nope"})
        self.assertEqual(burned.status, wrong.status, malformed.status)
        self.assertEqual(burned.json, wrong.json)
        self.assertEqual(burned.json, malformed.json)

    def test_an_expired_code_stops_working_before_the_ttl_index_sweeps_it(self):
        # The document is still perfectly readable — Mongo's TTL monitor runs
        # about once a minute — so this is the read-time check doing its job.
        created = self.create()
        doc = self.sessions.docs[created["session_id"]]
        doc["code_expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        refused = call("POST", "/api/watch_session/join", {"code": created["code"]})
        self.assertEqual(refused.status, 404)

    def test_an_expired_session_is_refused_although_the_document_survives(self):
        created = self.create()
        doc = self.sessions.docs[created["session_id"]]
        doc["expires_at"] = datetime.now(timezone.utc) - timedelta(seconds=1)
        self.assertIn(created["session_id"], self.sessions.docs)
        read = call("GET", "/api/watch_session", query=f"session_id={created['session_id']}")
        self.assertEqual(read.status, 404)

    def test_polling_slides_the_expiry_forward(self):
        created = self.create()
        doc = self.sessions.docs[created["session_id"]]
        doc["expires_at"] = datetime.now(timezone.utc) + timedelta(seconds=30)
        call("GET", "/api/watch_session", query=f"session_id={created['session_id']}")
        refreshed = self.sessions.docs[created["session_id"]]["expires_at"]
        self.assertGreater(
            refreshed, datetime.now(timezone.utc) + timedelta(seconds=ws.SESSION_TTL_SECONDS - 60)
        )

    def test_reissue_mints_a_different_code_and_the_old_one_stays_dead(self):
        created = self.create()
        call("POST", "/api/watch_session/join", {"code": created["code"]})
        reissued = call(
            "POST", "/api/watch_session/code", {"session_id": created["session_id"]}
        )
        self.assertEqual(reissued.status, 200, reissued.body)
        self.assertNotEqual(reissued.json["code"], created["code"])
        self.assertEqual(
            call("POST", "/api/watch_session/join", {"code": created["code"]}).status, 404
        )
        self.assertEqual(
            call("POST", "/api/watch_session/join", {"code": reissued.json["code"]}).status,
            200,
        )

    def test_ending_a_session_takes_effect_immediately(self):
        created = self.create()
        self.assertEqual(
            call("POST", "/api/watch_session/end", {"session_id": created["session_id"]}).status,
            200,
        )
        self.assertEqual(
            call("GET", "/api/watch_session", query=f"session_id={created['session_id']}").status,
            404,
        )

    def test_a_code_is_not_a_session_id(self):
        # The security model rests on this: if any other endpoint accepted a
        # code, the limiter on `join` would bound nothing because `GET` would
        # answer the same question for free.
        created = self.create()
        read = call("GET", "/api/watch_session", query=f"session_id={created['code']}")
        self.assertEqual(read.status, 404)
        wrote = call(
            "POST",
            "/api/watch_session/state",
            {"session_id": created["code"], "state": {"lap_index": 3}},
        )
        self.assertEqual(wrote.status, 404)

    def test_a_wrong_session_id_is_refused(self):
        self.create()
        read = call("GET", "/api/watch_session", query=f"session_id={'0' * 32}")
        self.assertEqual(read.status, 404)

    def test_a_code_collision_retries_rather_than_failing(self):
        with patch.object(ws, "new_code", side_effect=["AAAA2345", "AAAA2345", "BBBB2345"]):
            first = call("POST", "/api/watch_session", {"race_id": "2026-1"})
            self.assertEqual(first.json["code"], "AAAA2345")
            second = call("POST", "/api/watch_session", {"race_id": "2026-2"})
        self.assertEqual(second.status, 200, second.body)
        self.assertEqual(second.json["code"], "BBBB2345")


class JoinLimitOverTheWireTests(ASGICase):
    def test_guessing_is_refused_with_a_retry_after_header(self):
        self.create()
        statuses = [
            call(
                "POST",
                "/api/watch_session/join",
                {"code": f"ZZZZ23{n:02d}".replace("0", "2").replace("1", "3")},
                headers={"x-forwarded-for": "198.51.100.77"},
            )
            for n in range(ws.JOIN_LIMITS["ip"]["burst"] + 2)
        ]
        self.assertTrue(all(r.status == 404 for r in statuses[: ws.JOIN_LIMITS["ip"]["burst"]]))
        refused = statuses[-1]
        self.assertEqual(refused.status, 429)
        # A real 429 with a real header, not a 200 carrying an error string —
        # everything between the browser and the service understands the former.
        self.assertIn("retry-after", {k.lower() for k in refused.headers})
        self.assertEqual(refused.json["error"], "rate_limited")

    def test_a_correct_code_is_still_refused_once_the_limit_is_reached(self):
        # The limiter runs *before* the lookup, so a guesser who happens to hit
        # the right code on their eleventh attempt gains nothing.
        created = self.create()
        for n in range(ws.JOIN_LIMITS["ip"]["burst"]):
            call(
                "POST",
                "/api/watch_session/join",
                {"code": "ZZZZ2345"},
                headers={"x-forwarded-for": "198.51.100.88"},
            )
            del n
        blocked = call(
            "POST",
            "/api/watch_session/join",
            {"code": created["code"]},
            headers={"x-forwarded-for": "198.51.100.88"},
        )
        self.assertEqual(blocked.status, 429)
        # And the code was not burned by the refusal.
        allowed = call(
            "POST",
            "/api/watch_session/join",
            {"code": created["code"]},
            headers={"x-forwarded-for": "203.0.113.5"},
        )
        self.assertEqual(allowed.status, 200)


class ValidationTests(ASGICase):
    def test_state_rejects_unknown_fields(self):
        # A passthrough dict would be a stored-content hole: this is an
        # unauthenticated write that is read back and rendered in another
        # person's browser.
        created = self.create()
        response = call(
            "POST",
            "/api/watch_session/state",
            {
                "session_id": created["session_id"],
                "state": {"lap_index": 1, "html": "<script>alert(1)</script>"},
            },
        )
        self.assertEqual(response.status, 422)

    def test_state_rejects_an_unknown_timing_mode_and_a_silly_lap(self):
        created = self.create()
        for state in ({"lap_index": 1, "timing_mode": "sector"}, {"lap_index": 10_000}, {"lap_index": -1}):
            response = call(
                "POST",
                "/api/watch_session/state",
                {"session_id": created["session_id"], "state": state},
            )
            self.assertEqual(response.status, 422, state)

    def test_device_label_is_restricted(self):
        created = self.create()
        response = call(
            "POST",
            "/api/watch_session/state",
            {"session_id": created["session_id"], "state": {"lap_index": 1, "device": "<img>"}},
        )
        self.assertEqual(response.status, 422)

    def test_race_id_must_look_like_a_race_id(self):
        for race_id in ("../etc", "2026", "https://example.com", "2026-1x"):
            response = call("POST", "/api/watch_session", {"race_id": race_id})
            self.assertEqual(response.status, 422, race_id)

    def test_extra_top_level_fields_are_rejected(self):
        response = call("POST", "/api/watch_session", {"race_id": "2026-1", "admin": True})
        self.assertEqual(response.status, 422)


class KillSwitchTests(ASGICase):
    def test_disabling_turns_every_endpoint_off_without_a_redeploy(self):
        created = self.create()
        with patch.dict("os.environ", {"WATCH_SESSION_ENABLED": "false"}):
            self.assertFalse(ws.enabled())
            for method, path, body, query in (
                ("POST", "/api/watch_session", {"race_id": "2026-1"}, ""),
                ("POST", "/api/watch_session/join", {"code": created["code"]}, ""),
                ("POST", "/api/watch_session/state", {"session_id": created["session_id"], "state": {"lap_index": 1}}, ""),
                ("POST", "/api/watch_session/code", {"session_id": created["session_id"]}, ""),
                ("POST", "/api/watch_session/end", {"session_id": created["session_id"]}, ""),
                ("GET", "/api/watch_session", None, f"session_id={created['session_id']}"),
            ):
                response = call(method, path, body, query=query)
                self.assertEqual(response.status, 503, path)
        self.assertTrue(ws.enabled())


if __name__ == "__main__":
    unittest.main()
