import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# The app modules import motor (via db.py) at module scope; these tests never
# touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import derived_cache, race_replay, race_timing


def run(coroutine):
    return asyncio.run(coroutine)


class FakeCollection:
    """Async Mongo collection over a list: equality, `$ne` and `$in`."""

    def __init__(self, docs=None):
        self.docs = [dict(d) for d in (docs or [])]
        self._next_id = 0
        for doc in self.docs:
            self._assign_id(doc)

    def _assign_id(self, doc):
        if "_id" not in doc:
            self._next_id += 1
            doc["_id"] = self._next_id

    @staticmethod
    def _matches(doc, query):
        for key, condition in query.items():
            if isinstance(condition, dict):
                if set(condition) == {"$ne"}:
                    if doc.get(key) == condition["$ne"]:
                        return False
                elif set(condition) == {"$in"}:
                    if doc.get(key) not in condition["$in"]:
                        return False
                else:
                    raise AssertionError(f"unsupported query {condition!r}")
            elif doc.get(key) != condition:
                return False
        return True

    def add(self, doc):
        doc = dict(doc)
        self._assign_id(doc)
        self.docs.append(doc)

    def find(self, query, projection=None):
        matched = [dict(d) for d in self.docs if self._matches(d, query)]

        class Cursor:
            async def to_list(self_inner, length=None):
                return matched
        return Cursor()

    async def find_one(self, query, projection=None, sort=None):
        for doc in self.docs:
            if self._matches(doc, query):
                return dict(doc)
        return None

    async def delete_many(self, query):
        self.docs = [d for d in self.docs if not self._matches(d, query)]

    async def replace_one(self, query, document, upsert=False):
        for index, doc in enumerate(self.docs):
            if self._matches(doc, query):
                self.docs[index] = {**dict(document), "_id": doc["_id"]}
                return
        if upsert:
            new = dict(document)
            self._assign_id(new)
            self.docs.append(new)


class FakeDb:
    def __init__(self, **collections):
        self._collections = {k: FakeCollection(v) for k, v in collections.items()}

    def __getattr__(self, name):
        return self._collections.setdefault(name, FakeCollection())


class InputFingerprintTests(unittest.TestCase):
    def test_key_order_does_not_matter(self):
        self.assertEqual(
            derived_cache.input_fingerprint({"a": 1, "b": 2}),
            derived_cache.input_fingerprint({"b": 2, "a": 1}),
        )

    def test_a_reordered_classification_is_a_different_input(self):
        gasly_third = [{"code": "ANT"}, {"code": "GAS"}, {"code": "HAD"}]
        hadjar_third = [{"code": "ANT"}, {"code": "HAD"}, {"code": "GAS"}]
        self.assertNotEqual(
            derived_cache.input_fingerprint(gasly_third),
            derived_cache.input_fingerprint(hadjar_third),
        )

    def test_a_missing_document_differs_from_an_empty_one(self):
        self.assertNotEqual(
            derived_cache.input_fingerprint(None), derived_cache.input_fingerprint({})
        )


class CodeFingerprintTests(unittest.TestCase):
    """The fingerprint must follow the code a cache actually depends on.

    #173 changed how a car that retires mid-lap is placed in the replay. The
    change lived in `race_replay.py`, the version constant was not bumped,
    and every replay cached before it kept two cars in the same position.
    """

    def test_it_reaches_the_modules_a_replay_is_built_from(self):
        reached = {
            m.__name__ for m in derived_cache._app_modules_reached_from(race_replay)
        }
        for name in (
            "app.race_replay",
            "app.race_control_facts",
            "app.driver_directory",
            "app.race_laps",
            "app.session_recap",
        ):
            self.assertIn(name, reached)

    def test_a_module_imported_inside_a_function_is_reached(self):
        # `race_timing.fetch_openf1_feeds` imports the session lookup locally;
        # a namespace-only walk never saw `openf1_sessions` or `race_stints`.
        reached = {
            m.__name__ for m in derived_cache._app_modules_reached_from(race_timing)
        }
        self.assertIn("app.openf1_sessions", reached)
        self.assertIn("app.race_stints", reached)

    def test_the_walk_covers_every_import_statement_in_the_source(self):
        # Compared against a static parse of each reached module, so a new
        # kind of import cannot slip past the fingerprint silently.
        reached = derived_cache._app_modules_reached_from(race_timing)
        names = {m.__name__ for m in reached}
        for module in reached:
            for name in derived_cache._statically_imported(module):
                if derived_cache._module(name) is not None:
                    self.assertIn(name, names, f"{module.__name__} imports {name}")

    def test_it_stays_inside_this_package(self):
        reached = derived_cache._app_modules_reached_from(race_replay)
        self.assertTrue(all(m.__name__.startswith("app.") for m in reached))

    def test_editing_a_reached_module_changes_the_fingerprint(self):
        before = derived_cache.code_fingerprint.__wrapped__("app.race_replay")
        real_getsource = derived_cache.inspect.getsource

        def edited(module):
            source = real_getsource(module)
            if module.__name__ == "app.race_control_facts":
                return source + "\n# an edit two imports away\n"
            return source

        with patch.object(derived_cache.inspect, "getsource", side_effect=edited):
            after = derived_cache.code_fingerprint.__wrapped__("app.race_replay")

        self.assertNotEqual(before, after)

    def test_it_is_stable_within_a_process(self):
        self.assertEqual(
            derived_cache.code_fingerprint("app.race_timing"),
            derived_cache.code_fingerprint("app.race_timing"),
        )


class StoreDerivedTests(unittest.TestCase):
    def _codes(self, collection, round_number="6"):
        return sorted(
            d.get("code") or "v%s" % d.get("version")
            for d in collection.docs
            if d["round"] == round_number
        )

    def test_old_version_documents_go_on_the_first_rebuild(self):
        collection = FakeCollection([
            {"season": 2026, "round": "6", "version": 3, "replay": "v3"},
            {"season": 2026, "round": "6", "version": 4, "replay": "v4"},
            {"season": 2026, "round": "7", "version": 4, "replay": "other round"},
        ])

        run(derived_cache.store_derived(collection, 2026, 6, "code-a", "in-1", {"replay": "a"}))

        self.assertEqual(self._codes(collection), ["code-a"])
        self.assertEqual(self._codes(collection, "7"), ["v4"])

    def test_a_rebuild_by_the_same_code_replaces_in_place(self):
        collection = FakeCollection()
        run(derived_cache.store_derived(collection, 2026, 6, "code-a", "in-1", {"replay": "old"}))
        run(derived_cache.store_derived(collection, 2026, 6, "code-a", "in-2", {"replay": "new"}))

        self.assertEqual([d["replay"] for d in collection.docs], ["new"])

    def test_two_codes_coexist_and_a_third_retires_the_oldest(self):
        # Production and a branch running `sync_race_timing` against the same
        # database must not delete each other's builds.
        collection = FakeCollection()
        with patch.object(derived_cache.datetime, "datetime") as clock:
            for stamp, code in (("2026-10-01", "prod"), ("2026-10-02", "branch"), ("2026-10-03", "prod")):
                clock.now.return_value.isoformat.return_value = stamp
                run(derived_cache.store_derived(collection, 2026, 6, code, "in", {}))
            self.assertEqual(self._codes(collection), ["branch", "prod"])

            clock.now.return_value.isoformat.return_value = "2026-10-04"
            run(derived_cache.store_derived(collection, 2026, 6, "next", "in", {}))
        self.assertEqual(self._codes(collection), ["next", "prod"])

    def test_is_current_needs_both_fingerprints(self):
        doc = {"code": "c", "inputs": "i"}
        self.assertTrue(derived_cache.is_current(doc, "c", "i"))
        self.assertFalse(derived_cache.is_current(doc, "c", "other"))
        self.assertFalse(derived_cache.is_current(doc, "other", "i"))
        self.assertFalse(derived_cache.is_current(None, "c", "i"))


def _sources(results):
    return {
        "race_results": [{"season": 2026, "round": "6", "results": results, "race": {}}],
        "race_laps": [{"season": 2026, "round": "6", "laps": [{"lap_number": 1}]}],
        "race_stints": [{"season": 2026, "round": "6", "stints": []}],
        "pit_stops": [{"season": 2026, "round": "6", "stops": []}],
    }


class ReplayCacheTests(unittest.TestCase):
    """End to end through the endpoint: the cached replay is served only while
    it matches the stored results it was built from and the current code."""

    PROVISIONAL = [{"position": "3", "Driver": {"code": "GAS"}}]
    FINAL = [{"position": "3", "Driver": {"code": "HAD"}}]

    def _cached(self, db, results, code=None):
        inputs = run(race_replay.replay_input_fingerprint(db, 2026, 6))
        db.race_replay.add({
            "season": 2026,
            "round": "6",
            "code": code or race_replay.replay_code_fingerprint(),
            "inputs": inputs,
            "replay": {"total_laps": 1, "drivers": {}, "laps": [], "marker": "cached"},
        })

    def _get(self, db, race_control=None):
        rebuilt = {"total_laps": 1, "drivers": {}, "laps": [], "marker": "rebuilt"}

        async def payload(coroutine):
            coroutine.close()
            return {"laps": [{"lap_number": 1}], "stints": [], "stops": []}

        with patch.object(race_replay, "get_db", return_value=db), \
                patch.object(race_replay, "_endpoint_payload", side_effect=payload), \
                patch.object(
                    race_replay,
                    "fetch_race_control",
                    return_value=[{"message": "GREEN"}] if race_control is None else race_control,
                ), \
                patch.object(race_replay, "summarize_race_control", return_value={}), \
                patch.object(race_replay, "build_replay", return_value=rebuilt):
            response = run(race_replay.get_race_replay(year=2026, round_number=6))
        return json.loads(response.body)["marker"]

    def test_an_unchanged_replay_is_served_from_cache(self):
        db = FakeDb(**_sources(self.PROVISIONAL))
        self._cached(db, self.PROVISIONAL)
        self.assertEqual(self._get(db), "cached")

    def test_a_revised_classification_rebuilds_the_replay(self):
        db = FakeDb(**_sources(self.PROVISIONAL))
        self._cached(db, self.PROVISIONAL)
        db.race_results.docs[0]["results"] = self.FINAL

        self.assertEqual(self._get(db), "rebuilt")
        stored = [d for d in db.race_replay.docs if d["round"] == "6"]
        self.assertEqual(len(stored), 1)
        self.assertEqual(stored[0]["replay"]["marker"], "rebuilt")
        self.assertEqual(self._get(db), "rebuilt")  # and is then served cached

    def test_a_replay_built_by_other_code_is_rebuilt(self):
        db = FakeDb(**_sources(self.PROVISIONAL))
        self._cached(db, self.PROVISIONAL, code="code-before-173")
        self.assertEqual(self._get(db), "rebuilt")

    def test_a_build_without_race_control_is_served_but_not_cached(self):
        # `fetch_race_control` answers [] on failure. Cached, that would be the
        # replay (no flags, no safety cars) until the code next changes.
        db = FakeDb(**_sources(self.PROVISIONAL))
        self.assertEqual(self._get(db, race_control=[]), "rebuilt")
        self.assertEqual(db.race_replay.docs, [])

    def test_a_document_from_the_version_scheme_is_rebuilt_and_removed(self):
        db = FakeDb(**_sources(self.PROVISIONAL))
        db.race_replay.add({
            "season": 2026, "round": "6", "version": 4,
            "replay": {"total_laps": 1, "drivers": {}, "laps": [], "marker": "v4"},
        })
        self.assertEqual(self._get(db), "rebuilt")
        self.assertEqual([d.get("version") for d in db.race_replay.docs], [None])


class TimingInputTests(unittest.TestCase):
    def test_a_late_filled_grid_changes_the_timing_inputs(self):
        # 2026 rounds 12, 13 and 15 were captured before their grid existed,
        # and the timing payload reads the grid from `race_results`.
        blank = {"results": [{"number": "4", "grid": ""}]}
        filled = {"results": [{"number": "4", "grid": "1"}]}
        official = {"laps": [{"lap": 1}]}
        self.assertNotEqual(
            race_timing.timing_input_fingerprint(blank, official),
            race_timing.timing_input_fingerprint(filled, official),
        )


class TimingCacheTests(unittest.TestCase):
    """`race_timing` must not cache a build whose OpenF1 feeds failed."""

    def _get(self, feeds):
        db = FakeDb(
            race_results=[{"season": 2026, "round": "6", "results": [{"number": "4", "grid": "1"}]}],
            official_laps=[{"season": 2026, "round": "6", "version": race_timing.OFFICIAL_VERSION, "laps": [{"lap": 1}]}],
            races=[{"season": 2026, "round": "6", "date": "2026-06-07"}],
        )

        async def official(year, round_number):
            return [{"lap": 1}]

        payload = {"drivers": {"4": {"positions": []}}, "lap_ms": [90000], "race_start": None}
        with patch.object(race_timing, "get_db", return_value=db),                 patch.object(race_timing, "official_laps_for", side_effect=official),                 patch.object(race_timing, "_race_date", side_effect=lambda *a: asyncio.sleep(0, "2026-06-07")),                 patch.object(race_timing, "fetch_openf1_feeds", return_value=feeds),                 patch.object(race_timing, "build_timing", return_value=payload):
            response = run(race_timing.get_race_timing(year=2026, round_number=6))
        return json.loads(response.body), db

    def test_a_failed_openf1_fetch_is_served_but_not_cached(self):
        body, db = self._get(([], [], []))
        self.assertTrue(body["synced"])
        self.assertEqual(db.race_timing.docs, [])

    def test_a_complete_build_is_cached(self):
        body, db = self._get(([{"lap": 1}], [{"gap": 1}], [{"position": 1}]))
        self.assertTrue(body["synced"])
        self.assertEqual(len(db.race_timing.docs), 1)


if __name__ == "__main__":
    unittest.main()
