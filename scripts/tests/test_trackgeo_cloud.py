"""Tests for the cloud-side plumbing: shared quota, output sinks, progress.

Run from the repo root:

    python -m unittest discover scripts/tests

Same conventions as test_trackgeo.py — plain unittest, hand-built fixtures, no
network and no real database. `FakeCollection` implements just enough of the
pymongo Collection surface (`$set`/`$setOnInsert`/`$inc`, `upsert`,
`return_document`) to exercise the real code paths rather than mocks of them,
which matters here because the atomicity of the `$inc` is the entire point of
moving the counter to Mongo.

The failure this file exists to prevent: a Cloud Run Job's disk is recreated for
every execution, so a file-backed daily counter reads 0 on every run and the
real published OpenTopoData limit of 1000/day gets blown silently.
"""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from trackgeo import storage  # noqa: E402
from trackgeo.cache import (  # noqa: E402
    Budget,
    FileQuotaStore,
    MongoQuotaStore,
    QuotaExhausted,
)

PUBLIC = "https://api.opentopodata.org"
LOCAL = "http://localhost:5000"


class FakeCollection:
    """An in-memory stand-in for one pymongo Collection, keyed by `_id`."""

    def __init__(self) -> None:
        self.docs: dict[str, dict] = {}
        self.raises = False

    def _guard(self) -> None:
        if self.raises:
            raise RuntimeError("simulated driver failure")

    def find_one(self, filter: dict):  # noqa: A002 - matches the pymongo name
        self._guard()
        return self.docs.get(filter["_id"])

    def _apply(self, doc: dict, update: dict, *, inserted: bool) -> dict:
        for key, value in update.get("$set", {}).items():
            doc[key] = value
        if inserted:
            for key, value in update.get("$setOnInsert", {}).items():
                doc.setdefault(key, value)
        for key, delta in update.get("$inc", {}).items():
            doc[key] = doc.get(key, 0) + delta
        return doc

    def find_one_and_update(self, filter, update, upsert=False, return_document=False):  # noqa: A002
        self._guard()
        key = filter["_id"]
        inserted = key not in self.docs
        if inserted and not upsert:
            return None
        doc = self.docs.setdefault(key, {"_id": key})
        before = dict(doc)
        after = self._apply(doc, update, inserted=inserted)
        return after if return_document else before

    def update_one(self, filter, update, upsert=False):  # noqa: A002
        self._guard()
        key = filter["_id"]
        inserted = key not in self.docs
        if inserted and not upsert:
            return None
        doc = self.docs.setdefault(key, {"_id": key})
        self._apply(doc, update, inserted=inserted)
        return None


class TestMongoBudget(unittest.TestCase):
    """The counter has to survive the machine that spent it."""

    def setUp(self) -> None:
        self.collection = FakeCollection()
        self.store = MongoQuotaStore(self.collection)

    def _run(self, calls: int, limit: int = 900) -> Budget:
        """One 'execution' of the job: a fresh Budget over the shared store."""
        budget = Budget.load(PUBLIC, limit=limit, store=self.store)
        for _ in range(calls):
            budget.check(1)
            budget.spend(1)
        return budget

    def test_counter_persists_across_runs(self):
        """The bug this whole change exists for.

        Three separate processes, each with its own Budget object and its own
        (notionally empty) local disk, must see one cumulative total. With the
        file store on ephemeral disk each would independently report 5.
        """
        self.assertEqual(self._run(5).calls, 5)
        self.assertEqual(self._run(5).calls, 10)
        self.assertEqual(self._run(5).calls, 15)
        self.assertEqual(Budget.load(PUBLIC, store=self.store).calls, 15)

    def test_a_fresh_budget_starts_from_the_shared_total(self):
        self._run(30)
        fresh = Budget.load(PUBLIC, limit=900, store=self.store)
        self.assertEqual(fresh.calls, 30)
        self.assertEqual(fresh.remaining, 870)

    def test_check_refuses_the_call_that_would_cross_the_limit(self):
        budget = self._run(10, limit=10)
        with self.assertRaises(QuotaExhausted):
            budget.check(1)
        # And it stays refused for a brand-new run against the same store.
        with self.assertRaises(QuotaExhausted):
            Budget.load(PUBLIC, limit=10, store=self.store).check(1)

    def test_check_notices_a_concurrent_spender(self):
        """The in-process count is not trusted over the shared one."""
        budget = Budget.load(PUBLIC, limit=10, store=self.store)
        self.assertEqual(budget.calls, 0)
        self.store.add(budget.date, 10)  # another execution spends the day
        with self.assertRaises(QuotaExhausted):
            budget.check(1)

    def test_yesterdays_spend_does_not_count_against_today(self):
        self.store.add("2020-01-01", 900)
        budget = Budget.load(PUBLIC, limit=900, store=self.store)
        self.assertEqual(budget.calls, 0)
        budget.check(1)  # must not raise

    def test_spend_survives_a_driver_failure(self):
        """Telemetry must never be the reason a paid-for build dies."""
        budget = Budget.load(PUBLIC, limit=900, store=self.store)
        self.collection.raises = True
        budget.spend(1)  # falls back to an optimistic local count
        self.assertGreaterEqual(budget.calls, 1)

    def test_on_spend_fires_once_per_call(self):
        """The progress bar's only faithful per-API-call tick."""
        seen: list[int] = []
        budget = Budget.load(PUBLIC, limit=900, store=self.store)
        budget.on_spend = seen.append
        for _ in range(4):
            budget.spend(1)
        self.assertEqual(seen, [1, 2, 3, 4])


class TestFileBudgetFallback(unittest.TestCase):
    """With no Mongo configured the CLI keeps its original behaviour exactly."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self._tmp.name) / "quota.json"
        self.addCleanup(self._tmp.cleanup)

    def store(self) -> FileQuotaStore:
        return FileQuotaStore(self.path)

    def test_counter_persists_across_runs_on_disk(self):
        for expected in (3, 6, 9):
            budget = Budget.load(PUBLIC, store=self.store())
            for _ in range(3):
                budget.spend(1)
            self.assertEqual(budget.calls, expected)
        self.assertEqual(json.loads(self.path.read_text())["calls"], 9)

    def test_missing_file_is_a_fresh_day_not_an_error(self):
        self.assertEqual(Budget.load(PUBLIC, store=self.store()).calls, 0)

    def test_corrupt_file_does_not_block_a_build(self):
        self.path.write_text("{not json", encoding="utf-8")
        budget = Budget.load(PUBLIC, store=self.store())
        self.assertEqual(budget.calls, 0)
        budget.check(1)

    def test_exhaustion_still_raises_quota_exhausted(self):
        budget = Budget.load(PUBLIC, limit=2, store=self.store())
        budget.spend(1)
        budget.spend(1)
        with self.assertRaises(QuotaExhausted):
            budget.check(1)

    def test_default_store_is_the_file_when_mongo_is_not_configured(self):
        storage.reset_mongo_cache()
        self.addCleanup(storage.reset_mongo_cache)
        for name in ("MONGODB_URI", "mongodburi"):
            self._unset(name)
        budget = Budget.load(PUBLIC)
        self.assertIsInstance(budget.store, FileQuotaStore)

    def _unset(self, name: str) -> None:
        import os

        previous = os.environ.pop(name, None)
        if previous is not None:
            self.addCleanup(os.environ.__setitem__, name, previous)


class TestSelfHostedIsUnlimited(unittest.TestCase):
    def test_local_instance_touches_no_store_at_all(self):
        """The limit belongs to the public host, not to the protocol."""
        budget = Budget.load(LOCAL, limit=1)
        self.assertTrue(budget.unlimited)
        self.assertIsNone(budget.store)
        for _ in range(50):
            budget.check(1)
            budget.spend(1)  # must never raise
        self.assertGreater(budget.remaining, 1000)


class TestSinks(unittest.TestCase):
    def test_gs_destination_splits_into_bucket_and_prefix(self):
        sink = storage.resolve_sink("gs://f1-scratch-assets/tracks")
        self.assertIsInstance(sink, storage.GcsSink)
        self.assertEqual(sink.bucket, "f1-scratch-assets")
        self.assertEqual(sink.prefix, "tracks")
        self.assertEqual(sink.object_name("spa"), "tracks/spa.json")

    def test_gs_destination_without_a_prefix(self):
        sink = storage.resolve_sink("gs://f1-scratch-assets")
        self.assertEqual(sink.object_name("spa"), "spa.json")

    def test_gs_destination_needs_a_bucket(self):
        with self.assertRaises(ValueError):
            storage.resolve_sink("gs://")

    def test_a_plain_path_is_still_a_local_directory(self):
        sink = storage.resolve_sink("frontend/public/tracks")
        self.assertIsInstance(sink, storage.LocalSink)

    def test_local_sink_writes_the_same_bytes_as_before(self):
        with tempfile.TemporaryDirectory() as tmp:
            sink = storage.resolve_sink(tmp)
            payload = {"id": "spa", "name": "Spa", "length_m": 7004.0}
            location = sink.write(payload)
            self.assertTrue(location.endswith("spa.json"))
            self.assertEqual(json.loads(pathlib.Path(location).read_text()), payload)


class TestBuildProgress(unittest.TestCase):
    """CP57 and CP58 are being built against this document shape in parallel."""

    CONTRACT = {
        "circuit_id",
        "status",
        "phase",
        "progress_pct",
        "message",
        "started_at",
        "updated_at",
        "error",
    }

    def setUp(self) -> None:
        self.collection = FakeCollection()
        self.progress = storage.BuildProgress("monaco", self.collection)

    def doc(self) -> dict:
        return self.collection.docs["monaco"]

    def test_start_writes_every_contract_field_and_nothing_else(self):
        self.progress.start()
        doc = dict(self.doc())
        doc.pop("_id")
        self.assertEqual(set(doc), self.CONTRACT)
        self.assertEqual(doc["status"], "running")
        self.assertEqual(doc["circuit_id"], "monaco")
        self.assertEqual(doc["progress_pct"], 0)
        self.assertIsNone(doc["error"])

    def test_phase_message_is_written_for_a_person(self):
        self.progress.start()
        self.progress.phase("Sampling elevation", 30, "Sampling elevation data…")
        self.assertEqual(self.doc()["phase"], "Sampling elevation")
        self.assertEqual(self.doc()["message"], "Sampling elevation data…")
        self.assertEqual(self.doc()["progress_pct"], 30)

    def test_progress_pct_is_clamped(self):
        self.progress.start()
        self.progress.phase("x", 140, "m")
        self.assertEqual(self.doc()["progress_pct"], 100)
        self.progress.phase("x", -5, "m")
        self.assertEqual(self.doc()["progress_pct"], 0)

    def test_done_and_fail_are_terminal_statuses(self):
        self.progress.start()
        self.progress.done()
        self.assertEqual(self.doc()["status"], "done")
        self.assertEqual(self.doc()["progress_pct"], 100)
        self.progress.fail("boom")
        self.assertEqual(self.doc()["status"], "failed")
        self.assertEqual(self.doc()["error"], "boom")

    def test_rebuilding_restarts_the_clock(self):
        self.progress.start()
        first = self.doc()["started_at"]
        again = storage.BuildProgress("monaco", self.collection)
        again.start()
        self.assertGreaterEqual(self.doc()["started_at"], first)
        self.assertEqual(self.doc()["status"], "running")

    def test_a_reporting_failure_does_not_raise(self):
        self.collection.raises = True
        self.progress.start()
        self.progress.phase("x", 10, "m")
        self.progress.done()
        self.progress.fail("boom")  # none of these may propagate

    def test_null_progress_accepts_the_same_calls(self):
        null = storage.NullProgress()
        null.start()
        null.phase("x", 10, "m")
        null.done()
        null.fail("boom")
        self.assertFalse(null.enabled)

    def test_make_progress_is_null_without_mongo(self):
        storage.reset_mongo_cache()
        self.addCleanup(storage.reset_mongo_cache)
        import os

        for name in ("MONGODB_URI", "mongodburi"):
            previous = os.environ.pop(name, None)
            if previous is not None:
                self.addCleanup(os.environ.__setitem__, name, previous)
        self.assertIsInstance(storage.make_progress("spa"), storage.NullProgress)


if __name__ == "__main__":
    unittest.main(verbosity=2)
