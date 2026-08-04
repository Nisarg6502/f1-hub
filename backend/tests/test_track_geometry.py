"""Tests for the on-demand track-geometry control plane (CP57).

Everything external is faked: Mongo is an in-memory collection that reproduces
the two behaviours the lock actually depends on (filter matching, and a unique
`_id` index that raises DuplicateKeyError on a losing upsert), and both Google
APIs are patched out. No GCP call and no database connection happens here.
"""

import asyncio
import json
import os
import shutil
import sys
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# track_geometry imports motor transitively via db.py; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import track_geometry as tg


# --------------------------------------------------------------------------
# fakes
# --------------------------------------------------------------------------


def _matches(doc, query):
    for field, condition in query.items():
        if field == "$or":
            if not any(_matches(doc, clause) for clause in condition):
                return False
            continue
        value = doc.get(field, None)
        if isinstance(condition, dict):
            for op, operand in condition.items():
                if op == "$lte":
                    if value is None or not value <= operand:
                        return False
                elif op == "$exists":
                    if (field in doc) != operand:
                        return False
                else:  # pragma: no cover - unused operators
                    raise AssertionError(f"unsupported operator {op}")
        elif value != condition:
            return False
    return True


class FakeCollection:
    """In-memory collection with a unique `_id`, enough of Motor's surface."""

    def __init__(self, docs=None):
        self.docs = [dict(d) for d in (docs or [])]
        self.calls = 0

    async def find_one(self, query=None):
        await asyncio.sleep(0)
        for doc in self.docs:
            if _matches(doc, query or {}):
                return dict(doc)
        return None

    def find(self, query=None):
        docs = [dict(d) for d in self.docs if _matches(d, query or {})]

        class _Cursor:
            async def to_list(self_inner, length=None):
                return docs

        return _Cursor()

    async def update_one(self, query, update, upsert=False):
        await asyncio.sleep(0)
        for doc in self.docs:
            if _matches(doc, query):
                doc.update(update.get("$set", {}))
                return
        if upsert:
            new_doc = dict(query)
            new_doc.pop("$or", None)
            new_doc.update(update.get("$set", {}))
            self.docs.append(new_doc)

    async def find_one_and_update(
        self, query, update, upsert=False, return_document=None
    ):
        # The yield point is the whole point: it lets several coroutines sit
        # between "decide" and "write" the way separate Cloud Run instances do.
        self.calls += 1
        await asyncio.sleep(0)
        for doc in self.docs:
            if _matches(doc, query):
                doc.update(update.get("$set", {}))
                return dict(doc)
        if not upsert:
            return None
        new_id = query.get("_id")
        if new_id is not None and any(d.get("_id") == new_id for d in self.docs):
            # This is the real MongoDB behaviour a lost race produces, and the
            # only thing stopping two callers from both "taking" the lock.
            raise tg.DuplicateKeyError("duplicate _id")
        new_doc = dict(query)
        new_doc.pop("$or", None)
        new_doc.update(update.get("$set", {}))
        self.docs.append(new_doc)
        return dict(new_doc)


class FakeDb:
    def __init__(self, builds=None, lock=None, specs=None):
        # Every real build doc is keyed `_id: <circuit_id>` — both the pipeline
        # (BuildProgress) and the API upsert that way. A fixture that only sets
        # `circuit_id` and omits `_id` does not describe a document Mongo would
        # ever actually contain; defaulting it here means every test doc looks
        # like production data without having to repeat `"_id": "monaco"` next
        # to `"circuit_id": "monaco"` in every fixture in this file.
        normalized_builds = [
            {**doc, "_id": doc.get("_id", doc.get("circuit_id"))}
            for doc in (builds or [])
        ]
        self._collections = {
            tg.BUILDS_COLLECTION: FakeCollection(normalized_builds),
            tg.LOCK_COLLECTION: FakeCollection(lock),
            tg.SPECS_COLLECTION: FakeCollection(specs),
        }

    def __getitem__(self, name):
        return self._collections[name]


SPECS = {
    "silverstone": {
        "circuit_id": "silverstone",
        "ergast_circuit_id": "silverstone",
        "display_name": "Silverstone Circuit",
    },
    "monaco": {
        "circuit_id": "monaco",
        "ergast_circuit_id": "monaco",
        "display_name": "Circuit de Monaco",
    },
    "americas": {
        "circuit_id": "americas",
        "ergast_circuit_id": "americas",
        "display_name": "Circuit of the Americas",
    },
}


def body(response):
    return json.loads(bytes(response.body))


class TrackGeometryTestCase(unittest.TestCase):
    def setUp(self):
        tg._spec_cache["specs"] = dict(SPECS)
        tg._spec_cache["at"] = float("inf")  # never expires during a test
        tg._available_cache["keys"] = frozenset()
        tg._available_cache["at"] = 0.0
        tg._available_cache["ok"] = False
        tg._token_cache["token"] = None
        tg._token_cache["expires_at"] = 0.0

    def tearDown(self):
        tg._spec_cache["specs"] = {}
        tg._spec_cache["at"] = 0.0


# --------------------------------------------------------------------------
# input validation / unknown circuits
# --------------------------------------------------------------------------


class ValidationTests(TrackGeometryTestCase):
    def test_rejects_ids_that_are_not_plain_slugs(self):
        for hostile in [
            "../../etc/passwd",
            "spa/../../secret",
            "spa; rm -rf /",
            "spa json",
            "SPA!",
            "",
            "x" * 60,
            None,
            123,
        ]:
            self.assertIsNone(tg._normalise_id(hostile), hostile)

    def test_accepts_and_lowercases_a_real_key(self):
        self.assertEqual(tg._normalise_id("  Silverstone "), "silverstone")

    def test_unknown_circuit_is_404_and_never_touches_the_database(self):
        async def scenario():
            with patch.object(tg, "get_db", side_effect=AssertionError("db touched")):
                return await tg.start_track_geometry_build(
                    tg.BuildRequest(circuit_id="not-a-circuit")
                )

        response = asyncio.run(scenario())
        self.assertEqual(response.status_code, 404)
        self.assertEqual(body(response)["error"], "unknown_circuit")

    def test_hostile_id_is_404_not_500(self):
        async def scenario():
            with patch.object(tg, "get_db", side_effect=AssertionError("db touched")):
                return await tg.start_track_geometry_build(
                    tg.BuildRequest(circuit_id="../../../tracks/spa")
                )

        response = asyncio.run(scenario())
        self.assertEqual(response.status_code, 404)

    def test_job_args_only_ever_carry_the_registry_key(self):
        self.assertEqual(tg._job_args("silverstone"), ["--only", "silverstone"])

    def test_ergast_id_resolves_to_its_spec(self):
        async def scenario():
            return await tg.resolve_spec("MONACO")

        self.assertEqual(asyncio.run(scenario())["circuit_id"], "monaco")


# --------------------------------------------------------------------------
# the already-built short circuit
# --------------------------------------------------------------------------


class AlreadyBuiltTests(TrackGeometryTestCase):
    def test_existing_payload_short_circuits_with_200_and_never_triggers(self):
        db = FakeDb()

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "available_keys", return_value=(frozenset({"americas"}), True)
            ), patch.object(
                tg, "trigger_job", side_effect=AssertionError("must not trigger")
            ):
                return await tg.start_track_geometry_build(
                    tg.BuildRequest(circuit_id="americas")
                )

        response = asyncio.run(scenario())
        payload = body(response)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(payload["already_built"])
        self.assertEqual(payload["build"]["status"], "done")
        self.assertTrue(payload["build"]["url"].endswith("/tracks/americas.json"))
        # Nothing was queued and no lock was taken.
        self.assertEqual(db[tg.BUILDS_COLLECTION].docs, [])
        self.assertEqual(db[tg.LOCK_COLLECTION].docs, [])

    def test_degraded_listing_falls_back_to_a_terminal_build_record(self):
        db = FakeDb(
            builds=[{"circuit_id": "americas", "status": "done", "progress_pct": 100}]
        )

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "available_keys", return_value=(frozenset(), False)
            ), patch.object(
                tg, "trigger_job", side_effect=AssertionError("must not trigger")
            ):
                return await tg.start_track_geometry_build(
                    tg.BuildRequest(circuit_id="americas")
                )

        response = asyncio.run(scenario())
        self.assertEqual(response.status_code, 200)
        self.assertTrue(body(response)["already_built"])


# --------------------------------------------------------------------------
# the 409, and what it names
# --------------------------------------------------------------------------


class SingleBuildLockTests(TrackGeometryTestCase):
    def _held_lock(self, holder="silverstone", display="Silverstone Circuit"):
        now = tg._now()
        return [
            {
                "_id": tg.LOCK_ID,
                "holder": holder,
                "holder_display": display,
                "acquired_at": now,
                "expires_at": now + timedelta(seconds=tg.LOCK_TTL_SECONDS),
            }
        ]

    def test_second_circuit_gets_409_naming_the_circuit_already_building(self):
        db = FakeDb(
            builds=[
                {
                    "circuit_id": "silverstone",
                    "display_name": "Silverstone Circuit",
                    "status": "running",
                    "phase": "elevation",
                    "progress_pct": 40,
                }
            ],
            lock=self._held_lock(),
        )

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "available_keys", return_value=(frozenset(), True)
            ), patch.object(
                tg, "trigger_job", side_effect=AssertionError("must not trigger")
            ):
                return await tg.start_track_geometry_build(
                    tg.BuildRequest(circuit_id="monaco")
                )

        response = asyncio.run(scenario())
        payload = body(response)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(payload["error"], "build_in_progress")
        # The whole point: the UI must be able to say "Already generating Silverstone".
        self.assertEqual(payload["circuit_id"], "silverstone")
        self.assertEqual(payload["display_name"], "Silverstone Circuit")
        self.assertFalse(payload["same_circuit"])
        self.assertIn("Silverstone", payload["message"])
        self.assertEqual(payload["build"]["status"], "running")

    def test_clicking_the_same_circuit_twice_reports_that_circuit(self):
        db = FakeDb(
            builds=[{"circuit_id": "monaco", "status": "queued", "progress_pct": 0}],
            lock=self._held_lock("monaco", "Circuit de Monaco"),
        )

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "available_keys", return_value=(frozenset(), True)
            ), patch.object(
                tg, "trigger_job", side_effect=AssertionError("must not trigger")
            ):
                return await tg.start_track_geometry_build(
                    tg.BuildRequest(circuit_id="monaco")
                )

        response = asyncio.run(scenario())
        payload = body(response)
        self.assertEqual(response.status_code, 409)
        self.assertTrue(payload["same_circuit"])
        self.assertEqual(payload["circuit_id"], "monaco")

    def test_exactly_one_of_many_concurrent_callers_takes_the_lock(self):
        db = FakeDb()

        async def scenario():
            results = await asyncio.gather(
                *[
                    tg.acquire_lock(db, SPECS[key])
                    for key in ["silverstone", "monaco", "americas", "monaco", "silverstone"]
                ]
            )
            return results

        results = asyncio.run(scenario())
        winners = [ok for ok, _ in results if ok]
        self.assertEqual(len(winners), 1, results)
        # And the collection holds exactly one lock document, not five.
        self.assertEqual(len(db[tg.LOCK_COLLECTION].docs), 1)

    def test_concurrent_build_requests_produce_one_202_and_the_rest_409(self):
        db = FakeDb()
        triggered = []

        async def fake_trigger(key):
            triggered.append(key)
            return True, ""

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "available_keys", return_value=(frozenset(), True)
            ), patch.object(tg, "trigger_job", side_effect=fake_trigger):
                return await asyncio.gather(
                    *[
                        tg.start_track_geometry_build(tg.BuildRequest(circuit_id=key))
                        for key in ["silverstone", "monaco", "americas"]
                    ]
                )

        responses = asyncio.run(scenario())
        codes = sorted(r.status_code for r in responses)
        self.assertEqual(codes, [202, 409, 409])
        self.assertEqual(len(triggered), 1)

    def test_an_expired_lock_can_be_taken_over(self):
        stale = tg._now() - timedelta(seconds=tg.LOCK_TTL_SECONDS + 60)
        db = FakeDb(
            lock=[
                {
                    "_id": tg.LOCK_ID,
                    "holder": "silverstone",
                    "holder_display": "Silverstone Circuit",
                    "acquired_at": stale,
                    "expires_at": stale + timedelta(seconds=tg.LOCK_TTL_SECONDS),
                }
            ]
        )

        ok, holder = asyncio.run(tg.acquire_lock(db, SPECS["monaco"]))
        self.assertTrue(ok)
        self.assertIsNone(holder)
        self.assertEqual(db[tg.LOCK_COLLECTION].docs[0]["holder"], "monaco")

    def test_a_finished_holder_hands_the_lock_on(self):
        db = FakeDb(
            builds=[{"circuit_id": "silverstone", "status": "done"}],
            lock=self._held_lock(),
        )
        ok, _ = asyncio.run(tg.acquire_lock(db, SPECS["monaco"]))
        self.assertTrue(ok)
        self.assertEqual(db[tg.LOCK_COLLECTION].docs[0]["holder"], "monaco")

    def test_a_still_running_holder_does_not_hand_the_lock_on(self):
        db = FakeDb(
            builds=[{"circuit_id": "silverstone", "status": "running"}],
            lock=self._held_lock(),
        )
        ok, holder = asyncio.run(tg.acquire_lock(db, SPECS["monaco"]))
        self.assertFalse(ok)
        self.assertEqual(holder["holder"], "silverstone")


# --------------------------------------------------------------------------
# the happy path and trigger failures
# --------------------------------------------------------------------------


class TriggerTests(TrackGeometryTestCase):
    def test_successful_build_returns_202_with_a_queued_doc(self):
        db = FakeDb()
        seen = []

        async def fake_trigger(key):
            seen.append(key)
            return True, ""

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "available_keys", return_value=(frozenset(), True)
            ), patch.object(tg, "trigger_job", side_effect=fake_trigger):
                return await tg.start_track_geometry_build(
                    tg.BuildRequest(circuit_id="monaco")
                )

        response = asyncio.run(scenario())
        payload = body(response)["build"]
        self.assertEqual(response.status_code, 202)
        self.assertEqual(seen, ["monaco"])
        self.assertEqual(payload["status"], "queued")
        self.assertEqual(payload["progress_pct"], 0)
        self.assertEqual(payload["display_name"], "Circuit de Monaco")
        self.assertIsNotNone(payload["started_at"])
        # The queued doc carries every contract field, including the ones the
        # job (CP56) will overwrite as it runs.
        for field in [
            "circuit_id",
            "status",
            "phase",
            "progress_pct",
            "message",
            "started_at",
            "updated_at",
            "error",
        ]:
            self.assertIn(field, payload)
        self.assertEqual(db[tg.LOCK_COLLECTION].docs[0]["holder"], "monaco")

    def test_the_queued_doc_is_keyed_by_id_not_only_the_circuit_id_field(self):
        """Regression test for a real production incident.

        `BuildProgress` in scripts/trackgeo/storage.py always upserts
        `{"_id": self.circuit_id}` — never `{"circuit_id": self.circuit_id}` as
        a filter. If this endpoint's queued-doc write filters by the
        `circuit_id` field instead, Mongo's upsert creates a document with an
        unrelated auto-generated ObjectId `_id`. The job then upserts a SECOND,
        separate document under `_id: <circuit_id>` as it runs — two rows for
        one circuit, and this endpoint keeps reading the first one, which
        nothing ever updates past "queued" again. In production this stayed
        invisible for days because an unrelated bug (a Mongo $set/$setOnInsert
        conflict in storage.py) meant the job's write always failed too, so
        there was only ever one stuck row and no way to see the split.
        """
        db = FakeDb()

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "available_keys", return_value=(frozenset(), True)
            ), patch.object(tg, "trigger_job", return_value=(True, "")):
                return await tg.start_track_geometry_build(
                    tg.BuildRequest(circuit_id="monaco")
                )

        asyncio.run(scenario())

        docs = db[tg.BUILDS_COLLECTION].docs
        self.assertEqual(len(docs), 1, "exactly one row must exist for the circuit")
        self.assertEqual(docs[0]["_id"], "monaco")

        # The exact write BuildProgress performs once the job starts running —
        # if the endpoint's own doc has a different `_id`, this creates a
        # second row instead of updating the one the endpoint already made.
        async def job_writes_progress():
            await db[tg.BUILDS_COLLECTION].update_one(
                {"_id": "monaco"},
                {"$set": {"status": "running", "phase": "Starting", "progress_pct": 0}},
                upsert=True,
            )

        asyncio.run(job_writes_progress())

        docs = db[tg.BUILDS_COLLECTION].docs
        self.assertEqual(
            len(docs), 1, "the job's write must land on the same row the API created"
        )
        self.assertEqual(docs[0]["status"], "running")

        # And /status must actually see that update, not the stale queued row.
        async def read_status():
            with patch.object(tg, "get_db", return_value=db):
                return await tg.get_track_geometry_status(circuit_id="monaco")

        response = asyncio.run(read_status())
        self.assertEqual(body(response)["build"]["status"], "running")

    def test_a_failed_trigger_marks_the_build_failed_and_frees_the_lock(self):
        db = FakeDb()

        async def fake_trigger(key):
            return False, "permission_denied"

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "available_keys", return_value=(frozenset(), True)
            ), patch.object(tg, "trigger_job", side_effect=fake_trigger):
                return await tg.start_track_geometry_build(
                    tg.BuildRequest(circuit_id="monaco")
                )

        response = asyncio.run(scenario())
        self.assertEqual(response.status_code, 503)
        self.assertEqual(body(response)["error"], "permission_denied")
        self.assertEqual(db[tg.BUILDS_COLLECTION].docs[0]["status"], "failed")
        self.assertIsNone(db[tg.LOCK_COLLECTION].docs[0]["holder"])

    def test_no_job_name_configured_is_reported_not_guessed(self):
        with patch.object(tg, "JOB_NAME", ""):
            ok, code = asyncio.run(tg.trigger_job("monaco"))
        self.assertFalse(ok)
        self.assertEqual(code, "job_not_configured")

    def test_trigger_never_leaks_the_upstream_error_body(self):
        class FakeResponse:
            status_code = 403
            text = "PERMISSION_DENIED: caller sa-secret@project.iam has no run.jobs.run"

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

            async def post(self, *args, **kwargs):
                return FakeResponse()

        with patch.object(tg, "JOB_NAME", "f1-track-geometry"), patch.object(
            tg, "_access_token", return_value="token"
        ), patch.object(tg.httpx, "AsyncClient", lambda *a, **k: FakeClient()):
            ok, code = asyncio.run(tg.trigger_job("monaco"))
        self.assertFalse(ok)
        self.assertEqual(code, "permission_denied")


# --------------------------------------------------------------------------
# status + availability
# --------------------------------------------------------------------------


class StatusTests(TrackGeometryTestCase):
    def test_status_returns_the_jobs_own_progress_fields_untouched(self):
        updated = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)
        db = FakeDb(
            builds=[
                {
                    "circuit_id": "monaco",
                    "status": "running",
                    "phase": "elevation",
                    "progress_pct": 62,
                    "message": "Querying DEM tiles",
                    "started_at": updated,
                    "updated_at": updated,
                    "error": None,
                }
            ]
        )

        async def scenario():
            with patch.object(tg, "get_db", return_value=db):
                return await tg.get_track_geometry_status(circuit_id="monaco")

        payload = body(asyncio.run(scenario()))["build"]
        self.assertEqual(payload["phase"], "elevation")
        self.assertEqual(payload["progress_pct"], 62)
        self.assertEqual(payload["updated_at"], "2026-07-31T12:00:00Z")

    def test_status_404s_for_a_circuit_never_built(self):
        db = FakeDb()

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "available_keys", return_value=(frozenset(), True)
            ):
                return await tg.get_track_geometry_status(circuit_id="monaco")

        response = asyncio.run(scenario())
        self.assertEqual(response.status_code, 404)
        self.assertEqual(body(response)["error"], "not_built")

    def test_status_404s_for_an_unknown_circuit(self):
        async def scenario():
            with patch.object(tg, "get_db", side_effect=AssertionError("db touched")):
                return await tg.get_track_geometry_status(circuit_id="nurburgring")

        self.assertEqual(asyncio.run(scenario()).status_code, 404)

    def test_status_reports_done_for_a_payload_baked_before_this_api_existed(self):
        db = FakeDb()

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "available_keys", return_value=(frozenset({"americas"}), True)
            ):
                return await tg.get_track_geometry_status(circuit_id="americas")

        payload = body(asyncio.run(scenario()))["build"]
        self.assertEqual(payload["status"], "done")


    def test_status_done_refreshes_an_availability_listing_that_predates_the_build(self):
        """`done` must imply `/available` lists the circuit, with no TTL lag.

        The frontend stops polling on `done` and immediately re-reads
        `/available` to swap the Generate button for the viewer. A build that
        finishes inside the availability cache window would otherwise report
        done against a listing taken before the payload existed, and the page
        would render straight back to the Generate button — for a build that
        actually succeeded. Observed live on Silverstone.
        """
        done = datetime(2026, 8, 4, 18, 50, tzinfo=timezone.utc)
        db = FakeDb(
            builds=[
                {
                    "circuit_id": "monaco",
                    "status": "done",
                    "phase": "Done",
                    "progress_pct": 100,
                    "message": "3D view ready.",
                    "started_at": done,
                    "updated_at": done,
                    "error": None,
                }
            ]
        )

        async def scenario():
            # Prime the cache with a pre-build listing, well inside its TTL.
            with patch.object(tg, "_list_bucket_keys", return_value=(frozenset(), True)):
                await tg.available_keys(force=True)

            # The payload now exists in the bucket, but the cache predates it.
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "_list_bucket_keys", return_value=(frozenset({"monaco"}), True)
            ):
                response = await tg.get_track_geometry_status(circuit_id="monaco")
                keys, _ok = await tg.available_keys()
            return response, keys

        response, keys = asyncio.run(scenario())
        self.assertEqual(body(response)["build"]["status"], "done")
        self.assertIn("monaco", keys)


class AvailabilityTests(TrackGeometryTestCase):
    def test_available_intersects_the_bucket_with_the_spec_registry(self):
        async def scenario():
            with patch.object(
                tg,
                "available_keys",
                return_value=(frozenset({"americas", "monaco", "not-a-spec"}), True),
            ):
                return await tg.list_available_track_geometry()

        payload = body(asyncio.run(scenario()))
        ids = [c["circuit_id"] for c in payload["circuits"]]
        self.assertEqual(ids, ["americas", "monaco"])  # arbitrary object names dropped
        self.assertFalse(payload["degraded"])
        self.assertEqual(payload["buildable"], ["americas", "monaco", "silverstone"])
        self.assertTrue(payload["circuits"][0]["url"].endswith("/tracks/americas.json"))
        self.assertIn("ergast_circuit_id", payload["circuits"][0])

    def test_available_flags_degraded_when_the_listing_fails(self):
        async def scenario():
            with patch.object(tg, "available_keys", return_value=(frozenset(), False)):
                return await tg.list_available_track_geometry()

        self.assertTrue(body(asyncio.run(scenario()))["degraded"])

    def test_listing_is_cached_so_a_public_button_cannot_hammer_gcs(self):
        calls = []

        async def fake_list():
            calls.append(1)
            return frozenset({"americas"}), True

        async def scenario():
            with patch.object(tg, "_list_bucket_keys", side_effect=fake_list):
                return await asyncio.gather(*[tg.available_keys() for _ in range(6)])

        results = asyncio.run(scenario())
        self.assertEqual(len(calls), 1, "the listing should be single-flighted + cached")
        self.assertTrue(all(ok for _keys, ok in results))

    def test_a_failed_listing_keeps_the_last_good_answer(self):
        async def scenario():
            with patch.object(
                tg, "_list_bucket_keys", return_value=(frozenset({"spa"}), True)
            ):
                await tg.available_keys(force=True)
            with patch.object(tg, "_list_bucket_keys", return_value=(frozenset(), False)):
                return await tg.available_keys(force=True)

        keys, ok = asyncio.run(scenario())
        self.assertFalse(ok)
        self.assertEqual(keys, frozenset({"spa"}))


# --------------------------------------------------------------------------
# spec discovery — the thing that must never be a hardcoded list
# --------------------------------------------------------------------------


class SpecRegistryTests(unittest.TestCase):
    def setUp(self):
        tg._spec_cache["specs"] = {}
        tg._spec_cache["at"] = 0.0

    tearDown = setUp

    def test_env_override_parses_key_ergast_and_display_name(self):
        with patch.dict(
            os.environ,
            {"TRACK_GEOMETRY_SPECS": "silverstone:silverstone:Silverstone Circuit,monaco"},
        ):
            specs = tg._specs_from_env()
        self.assertEqual(specs["silverstone"]["display_name"], "Silverstone Circuit")
        self.assertEqual(specs["monaco"]["ergast_circuit_id"], "monaco")

    def test_env_override_drops_entries_that_are_not_valid_slugs(self):
        with patch.dict(os.environ, {"TRACK_GEOMETRY_SPECS": "../etc,ok-circuit"}):
            specs = tg._specs_from_env()
        self.assertEqual(sorted(specs), ["ok-circuit"])

    def test_specs_are_read_from_the_curated_pipeline_file_not_a_hardcoded_list(self):
        """The registry must pick up CP55's new specs with no backend change."""
        specs = tg._specs_from_curated_file()
        if not specs:
            self.skipTest("scripts/trackgeo/curated.py not present in this tree")
        # Whatever CP55 lands, the Batch 15 circuits are still there.
        self.assertIn("spa", specs)
        self.assertEqual(specs["spa"]["ergast_circuit_id"], "spa")
        self.assertTrue(specs["spa"]["display_name"])
        # Every key the file defines is a usable slug, so anything CP55 adds is
        # immediately buildable without touching this module.
        for key, spec in specs.items():
            self.assertEqual(tg._normalise_id(key), key)
            self.assertTrue(spec["ergast_circuit_id"])

    def test_specs_load_from_the_container_image_layout(self):
        """The deployed image must be able to answer "which circuits exist?".

        `Dockerfile.backend` copies `curated.py` to `/app/scripts/trackgeo/`
        beside `/app/app/`, so this rebuilds that exact layout in a temp dir and
        loads through it. If the COPY is dropped or the loader stops walking up
        from its own file, this fails — and without it a fresh deploy would 404
        every `/build`, including the very first click.
        """
        source = tg._repo_curated_path()
        if source is None:
            self.skipTest("curated.py not present in this tree")

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)  # stands in for the image's /app
            (root / "app").mkdir()
            (root / "scripts" / "trackgeo").mkdir(parents=True)
            shutil.copy(source, root / "scripts" / "trackgeo" / "curated.py")

            # No repo checkout anywhere above this path, exactly as in the image.
            with patch.object(tg, "__file__", str(root / "app" / "track_geometry.py")):
                specs = tg._specs_from_curated_file()

        self.assertTrue(specs, "the container layout must yield a spec registry")
        self.assertIn("spa", specs)

    def test_dockerfile_ships_the_spec_module(self):
        dockerfile = Path(tg.__file__).resolve().parents[2] / "Dockerfile.backend"
        if not dockerfile.is_file():
            self.skipTest("Dockerfile.backend not present in this tree")
        text = dockerfile.read_text(encoding="utf-8")
        self.assertIn("COPY scripts/trackgeo/curated.py ./scripts/trackgeo/curated.py", text)

    def test_explicit_spec_file_env_var_wins(self):
        source = tg._repo_curated_path()
        if source is None:
            self.skipTest("curated.py not present in this tree")
        with patch.dict(os.environ, {"TRACK_GEOMETRY_SPEC_FILE": str(source)}):
            self.assertEqual(tg._repo_curated_path(), source)
        with patch.dict(os.environ, {"TRACK_GEOMETRY_SPEC_FILE": "/nope/curated.py"}):
            self.assertIsNone(tg._repo_curated_path())

    def test_mongo_is_never_consulted_when_the_baked_in_file_is_present(self):
        """Mongo must never be the primary source — it is empty on a fresh deploy.

        Also keeps a slow or unreachable Mongo off the "which circuits are
        buildable?" path entirely for any deployment that ships curated.py.
        """
        if tg._repo_curated_path() is None:
            self.skipTest("curated.py not present in this tree")

        async def scenario():
            with patch.object(tg, "get_db", side_effect=AssertionError("mongo touched")), \
                    patch.dict(os.environ, {"TRACK_GEOMETRY_SPECS": ""}):
                return await tg.load_specs(force=True)

        specs = asyncio.run(scenario())
        self.assertIn("spa", specs)

    def test_mongo_is_the_fallback_when_the_file_is_missing(self):
        db = FakeDb(
            specs=[{"key": "monza", "ergast_circuit_id": "monza", "display_name": "Monza"}]
        )

        async def scenario():
            with patch.object(tg, "get_db", return_value=db), patch.object(
                tg, "_specs_from_curated_file", return_value={}
            ), patch.dict(os.environ, {"TRACK_GEOMETRY_SPECS": ""}):
                return await tg.load_specs(force=True)

        self.assertEqual(sorted(asyncio.run(scenario())), ["monza"])

    def test_mongo_specs_are_used_when_the_repo_tree_is_absent(self):
        db = FakeDb(
            specs=[
                {"key": "hungaroring", "ergast_circuit_id": "hungaroring", "display_name": "H"},
                {"key": "!!bad!!", "display_name": "nope"},
            ]
        )

        async def scenario():
            with patch.object(tg, "get_db", return_value=db):
                return await tg._specs_from_mongo()

        specs = asyncio.run(scenario())
        self.assertEqual(sorted(specs), ["hungaroring"])


if __name__ == "__main__":
    unittest.main()
