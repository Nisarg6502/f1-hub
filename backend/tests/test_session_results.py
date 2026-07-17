import asyncio
import datetime
import json
import math
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# The API modules import motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import data_sync, f1_results, session_results


class FakeCollection:
    def __init__(self, doc=None):
        self.doc = doc
        self.update = None

    async def find_one(self, *args, **kwargs):
        return self.doc

    async def update_one(self, query, update, upsert=False):
        self.update = {"query": query, "update": update, "upsert": upsert}


class FakeDb:
    def __init__(self, **collections):
        self.race_results = collections.get("race_results", FakeCollection())
        self.qualifying_results = collections.get("qualifying_results", FakeCollection())
        self.sprint_results = collections.get("sprint_results", FakeCollection())
        self.practice_results = collections.get("practice_results", FakeCollection())


class FakeSession:
    """Stands in for a FastF1 session with laps but no classification."""

    def __init__(self, laps, results):
        self.laps = laps
        self.results = results
        self.event = type("E", (), {"EventName": ""})()

    def load(self, **kwargs):
        pass


class SafeStrTests(unittest.TestCase):
    def test_missing_placeholders_collapse_to_fallback(self):
        for value in (None, math.nan, pd.NaT, "NaT", "nan", "None", "<NA>"):
            self.assertEqual(f1_results.safe_str(value), "")

    def test_passes_through_real_strings(self):
        self.assertEqual(f1_results.safe_str("1:12.345"), "1:12.345")

    def test_formats_lap_time_as_minutes_and_seconds(self):
        self.assertEqual(
            f1_results.safe_str(pd.Timedelta("0 days 00:01:29.260000")), "1:29.260"
        )

    def test_formats_sub_minute_gap_as_seconds(self):
        self.assertEqual(
            f1_results.safe_str(pd.Timedelta("0 days 00:00:00.427000")), "0.427"
        )

    def test_splits_hours_out_of_a_race_duration(self):
        # A winner's total time is over an hour; rolling the hours into minutes
        # would render "87:11.335".
        self.assertEqual(
            f1_results.safe_str(pd.Timedelta("0 days 01:27:11.335000")), "1:27:11.335"
        )


class SafeNumberTests(unittest.TestCase):
    def test_drops_the_float_suffix_fastf1_adds(self):
        self.assertEqual(f1_results.safe_number(1.0), "1")
        self.assertEqual(f1_results.safe_number("25.0"), "25")

    def test_keeps_genuinely_fractional_values(self):
        self.assertEqual(f1_results.safe_number(0.5), "0.5")

    def test_missing_values_use_the_fallback(self):
        self.assertEqual(f1_results.safe_number(math.nan, "0"), "0")


class SanitizeTests(unittest.TestCase):
    def test_removes_placeholder_values(self):
        cleaned = f1_results.sanitize_result({
            "position": "nan",
            "points": "nan",
            "status": "NaT",
            "Driver": {"givenName": "Lewis", "familyName": "Hamilton", "code": "HAM"},
            "Constructor": {"name": "Ferrari"},
            "Time": {"time": "NaT"},
            "Q1": "None",
        })

        self.assertEqual(cleaned["position"], "")
        self.assertEqual(cleaned["points"], "0")
        self.assertEqual(cleaned["status"], "")
        self.assertEqual(cleaned["Time"]["time"], "")
        self.assertEqual(cleaned["Q1"], "")
        self.assertEqual(cleaned["Driver"]["code"], "HAM")


class HasClassificationTests(unittest.TestCase):
    def test_false_when_every_row_lacks_a_position(self):
        # The shape FastF1 returns for practice before laps are considered.
        self.assertFalse(
            f1_results.has_classification([{"position": ""}, {"position": ""}])
        )

    def test_false_for_empty_input(self):
        self.assertFalse(f1_results.has_classification([]))
        self.assertFalse(f1_results.has_classification(None))

    def test_true_when_a_row_is_classified(self):
        self.assertTrue(f1_results.has_classification([{"position": "1"}]))


class SessionTotalLapsTests(unittest.TestCase):
    def test_returns_the_lap_count(self):
        class Loaded:
            total_laps = 52

        self.assertEqual(f1_results.session_total_laps(Loaded()), 52)

    def test_returns_none_when_the_property_raises(self):
        # FastF1 raises DataNotLoadedError from `total_laps` when the lap-count
        # stream is absent, so getattr(..., None) does not guard it.
        class Unloaded:
            @property
            def total_laps(self):
                raise RuntimeError("The data you are trying to access has not been loaded")

        self.assertIsNone(f1_results.session_total_laps(Unloaded()))

    def test_treats_zero_as_no_data(self):
        class Zero:
            total_laps = 0

        self.assertIsNone(f1_results.session_total_laps(Zero()))


class ClassificationFromLapsTests(unittest.TestCase):
    def _session(self):
        laps = pd.DataFrame({
            "Driver": ["HAM", "HAM", "VER", "VER", "LEC"],
            "LapTime": [
                pd.Timedelta("0 days 00:01:30.500000"),
                pd.Timedelta("0 days 00:01:29.260000"),  # HAM's best
                pd.Timedelta("0 days 00:01:29.900000"),  # VER's best
                pd.NaT,                                   # in-lap, ignored
                pd.NaT,                                   # LEC set no time
            ],
            "Deleted": [False, False, False, False, False],
            "Team": ["Ferrari", "Ferrari", "Red Bull", "Red Bull", "Ferrari"],
            "DriverNumber": ["44", "44", "1", "1", "16"],
        })
        results = pd.DataFrame({
            "Abbreviation": ["HAM", "VER", "LEC"],
            "FullName": ["Lewis Hamilton", "Max Verstappen", "Charles Leclerc"],
            "TeamName": ["Ferrari", "Red Bull Racing", "Ferrari"],
            "DriverNumber": ["44", "1", "16"],
        })
        return FakeSession(laps, results)

    def test_ranks_drivers_by_their_fastest_lap(self):
        classification = f1_results.classification_from_laps(self._session())

        self.assertEqual(
            [(r["position"], r["Driver"]["code"]) for r in classification],
            [("1", "HAM"), ("2", "VER")],
        )

    def test_reports_each_driver_best_lap_time(self):
        classification = f1_results.classification_from_laps(self._session())
        self.assertEqual(classification[0]["Time"]["time"], "1:29.260")

    def test_drivers_without_a_timed_lap_are_excluded(self):
        classification = f1_results.classification_from_laps(self._session())
        self.assertNotIn("LEC", [r["Driver"]["code"] for r in classification])

    def test_enriches_rows_from_the_results_frame(self):
        leader = f1_results.classification_from_laps(self._session())[0]
        self.assertEqual(leader["Driver"]["givenName"], "Lewis")
        self.assertEqual(leader["Driver"]["familyName"], "Hamilton")
        self.assertEqual(leader["Constructor"]["name"], "Ferrari")

    def test_returns_empty_when_there_are_no_laps(self):
        empty = FakeSession(pd.DataFrame(), pd.DataFrame())
        self.assertEqual(f1_results.classification_from_laps(empty), [])

    def test_deleted_laps_are_not_ranked(self):
        # A lap chopped for track limits keeps its LapTime, so filtering on
        # LapTime alone would rank a driver on a lap that never counted.
        laps = pd.DataFrame({
            "Driver": ["VER", "VER", "HAM"],
            "LapTime": [
                pd.Timedelta("0 days 00:01:28.000000"),  # deleted
                pd.Timedelta("0 days 00:01:30.000000"),  # VER's real best
                pd.Timedelta("0 days 00:01:29.000000"),
            ],
            "Deleted": [True, False, False],
            "Team": ["Red Bull", "Red Bull", "Ferrari"],
            "DriverNumber": ["1", "1", "44"],
        })
        results = pd.DataFrame({
            "Abbreviation": ["VER", "HAM"],
            "FullName": ["Max Verstappen", "Lewis Hamilton"],
            "TeamName": ["Red Bull Racing", "Ferrari"],
            "DriverNumber": ["1", "44"],
        })

        classification = f1_results.classification_from_laps(FakeSession(laps, results))

        self.assertEqual(
            [(r["position"], r["Driver"]["code"], r["Time"]["time"]) for r in classification],
            [("1", "HAM", "1:29.000"), ("2", "VER", "1:30.000")],
        )

    def test_a_driver_whose_only_lap_was_deleted_is_excluded(self):
        laps = pd.DataFrame({
            "Driver": ["VER", "HAM"],
            "LapTime": [
                pd.Timedelta("0 days 00:01:28.000000"),
                pd.Timedelta("0 days 00:01:29.000000"),
            ],
            "Deleted": [True, False],
            "Team": ["Red Bull", "Ferrari"],
            "DriverNumber": ["1", "44"],
        })
        results = pd.DataFrame({
            "Abbreviation": ["VER", "HAM"],
            "FullName": ["Max Verstappen", "Lewis Hamilton"],
            "TeamName": ["Red Bull Racing", "Ferrari"],
            "DriverNumber": ["1", "44"],
        })

        classification = f1_results.classification_from_laps(FakeSession(laps, results))

        self.assertEqual([r["Driver"]["code"] for r in classification], ["HAM"])

    def test_tied_times_keep_the_lap_set_first(self):
        # The laps frame is chronological, so a stable sort implements the rule
        # that whoever set the time first takes the place.
        same = pd.Timedelta("0 days 00:01:29.000000")
        laps = pd.DataFrame({
            "Driver": ["HAM", "VER"],
            "LapTime": [same, same],
            "Deleted": [False, False],
            "Team": ["Ferrari", "Red Bull"],
            "DriverNumber": ["44", "1"],
        })
        results = pd.DataFrame({
            "Abbreviation": ["HAM", "VER"],
            "FullName": ["Lewis Hamilton", "Max Verstappen"],
            "TeamName": ["Ferrari", "Red Bull Racing"],
            "DriverNumber": ["44", "1"],
        })

        classification = f1_results.classification_from_laps(FakeSession(laps, results))

        self.assertEqual([r["Driver"]["code"] for r in classification], ["HAM", "VER"])

    def test_works_when_the_deleted_column_is_absent(self):
        laps = pd.DataFrame({
            "Driver": ["HAM"],
            "LapTime": [pd.Timedelta("0 days 00:01:29.000000")],
            "Team": ["Ferrari"],
            "DriverNumber": ["44"],
        })
        results = pd.DataFrame({
            "Abbreviation": ["HAM"],
            "FullName": ["Lewis Hamilton"],
            "TeamName": ["Ferrari"],
            "DriverNumber": ["44"],
        })

        classification = f1_results.classification_from_laps(FakeSession(laps, results))

        self.assertEqual([r["Driver"]["code"] for r in classification], ["HAM"])


class BestLapByDriverTests(unittest.TestCase):
    def test_returns_each_drivers_fastest_legal_lap(self):
        laps = pd.DataFrame({
            "Driver": ["HAM", "HAM", "VER"],
            "LapTime": [
                pd.Timedelta("0 days 00:01:30.000000"),
                pd.Timedelta("0 days 00:01:29.000000"),
                pd.Timedelta("0 days 00:01:28.500000"),
            ],
            "Deleted": [False, False, False],
        })
        best = f1_results.best_lap_by_driver(FakeSession(laps, pd.DataFrame()))
        self.assertEqual(best, {"HAM": "1:29.000", "VER": "1:28.500"})

    def test_ignores_deleted_laps(self):
        laps = pd.DataFrame({
            "Driver": ["VER", "VER"],
            "LapTime": [
                pd.Timedelta("0 days 00:01:28.000000"),  # deleted
                pd.Timedelta("0 days 00:01:30.000000"),
            ],
            "Deleted": [True, False],
        })
        best = f1_results.best_lap_by_driver(FakeSession(laps, pd.DataFrame()))
        self.assertEqual(best, {"VER": "1:30.000"})


class LoadSessionMergeTests(unittest.TestCase):
    """The behaviour of load_session when FastF1 reports positions but no times.

    This is sprint qualifying and, on some sessions, practice: FastF1 knows the
    classification once messages are loaded but leaves the Time column empty.
    """

    def _patch_load(self, results_df, laps_df, event_name="British Grand Prix"):
        session = FakeSession(laps_df, results_df)
        session.event = type("E", (), {"EventName": event_name})()

        def fake_get_session(year, rnd, code):
            return session

        return patch.object(f1_results.fastf1, "get_session", fake_get_session)

    def test_keeps_fastf1_order_and_fills_times_from_laps(self):
        # STR is classified last with no legal lap; the leaders' blank Time is
        # filled from their fastest lap.
        results_df = pd.DataFrame({
            "Position": [1.0, 2.0, 22.0],
            "Points": [0.0, 0.0, 0.0],
            "Status": ["", "", ""],
            "Abbreviation": ["HAM", "ANT", "STR"],
            "FullName": ["Lewis Hamilton", "Kimi Antonelli", "Lance Stroll"],
            "TeamName": ["Ferrari", "Mercedes", "Aston Martin"],
            "DriverNumber": ["44", "12", "18"],
            "Time": [pd.NaT, pd.NaT, pd.NaT],
            "Q1": [pd.NaT, pd.NaT, pd.NaT],
            "Q2": [pd.NaT, pd.NaT, pd.NaT],
            "Q3": [pd.NaT, pd.NaT, pd.NaT],
        })
        laps_df = pd.DataFrame({
            "Driver": ["HAM", "ANT", "STR"],
            "LapTime": [
                pd.Timedelta("0 days 00:01:28.376000"),
                pd.Timedelta("0 days 00:01:28.387000"),
                pd.Timedelta("0 days 00:01:33.438000"),  # deleted
            ],
            "Deleted": [False, False, True],
        })

        with self._patch_load(results_df, laps_df):
            _, results = f1_results.load_session(2026, 9, "SQ")

        self.assertEqual([r["Driver"]["code"] for r in results], ["HAM", "ANT", "STR"])
        self.assertEqual(results[0]["Time"]["time"], "1:28.376")
        # STR keeps his classified position but has no legal time to show.
        self.assertEqual(results[2]["position"], "22")
        self.assertEqual(results[2]["Time"]["time"], "")

    def test_falls_back_to_lap_ranking_when_fastf1_has_no_positions(self):
        results_df = pd.DataFrame({
            "Position": [float("nan"), float("nan")],
            "Abbreviation": ["HAM", "VER"],
            "FullName": ["Lewis Hamilton", "Max Verstappen"],
            "TeamName": ["Ferrari", "Red Bull Racing"],
            "DriverNumber": ["44", "1"],
            "Time": [pd.NaT, pd.NaT],
        })
        laps_df = pd.DataFrame({
            "Driver": ["HAM", "VER"],
            "LapTime": [
                pd.Timedelta("0 days 00:01:30.000000"),
                pd.Timedelta("0 days 00:01:29.000000"),  # faster
            ],
            "Deleted": [False, False],
            "Team": ["Ferrari", "Red Bull"],
            "DriverNumber": ["44", "1"],
        })

        with self._patch_load(results_df, laps_df):
            _, results = f1_results.load_session(2026, 9, "FP1")

        # VER set the faster lap, so the derived order leads with him.
        self.assertEqual([r["Driver"]["code"] for r in results], ["VER", "HAM"])
        self.assertEqual(results[0]["Time"]["time"], "1:29.000")


class RaceResultsTests(unittest.TestCase):
    def test_falls_back_to_ergast_and_caches_the_result(self):
        fake_db = FakeDb()
        payload = {
            "MRData": {
                "RaceTable": {
                    "Races": [{
                        "season": "2026",
                        "round": "5",
                        "raceName": "Canadian Grand Prix",
                        "Results": [{
                            "position": "1",
                            "points": "25",
                            "Driver": {"givenName": "Andrea Kimi", "familyName": "Antonelli"},
                            "Constructor": {"name": "Mercedes"},
                            "Time": {"time": "1:28:15.758"},
                        }],
                    }]
                }
            }
        }

        with patch.object(session_results, "get_db", return_value=fake_db), \
             patch.object(session_results, "_fetch_json", return_value=payload):
            response = asyncio.run(
                session_results.get_race_results(year=2026, round=5, fields="race,results")
            )

        body = json.loads(response.body)
        self.assertEqual(body["race"]["raceName"], "Canadian Grand Prix")
        self.assertEqual(body["results"][0]["Driver"]["familyName"], "Antonelli")
        self.assertEqual(fake_db.race_results.update["query"], {"season": 2026, "round": "5"})
        self.assertTrue(fake_db.race_results.update["upsert"])


class SessionClassificationTests(unittest.TestCase):
    def test_serves_a_valid_practice_cache_without_calling_fastf1(self):
        cached = FakeCollection({
            "event_name": "British Grand Prix",
            "results": [{"position": "1", "Driver": {"code": "HAM"}}],
        })
        fake_db = FakeDb(practice_results=cached)

        with patch.object(session_results, "get_db", return_value=fake_db), \
             patch.object(session_results, "load_session") as load:
            response = asyncio.run(
                session_results.get_session_classification(year=2026, round=9, session="FP1")
            )

        load.assert_not_called()
        self.assertEqual(json.loads(response.body)["results"][0]["Driver"]["code"], "HAM")

    def test_refetches_when_the_cache_has_no_positions(self):
        # Entries written before practice was classified from laps carry the
        # driver list with every timing field blank; they must not be served.
        poisoned = FakeCollection({
            "event_name": "British Grand Prix",
            "results": [{"position": "", "Driver": {"code": "HAM"}}],
        })
        fake_db = FakeDb(practice_results=poisoned)
        fresh = [{"position": "1", "Driver": {"code": "VER"}, "Time": {"time": "1:29.260"}}]

        with patch.object(session_results, "get_db", return_value=fake_db), \
             patch.object(
                 session_results, "load_session",
                 return_value=("British Grand Prix", fresh),
             ) as load:
            response = asyncio.run(
                session_results.get_session_classification(year=2026, round=9, session="FP1")
            )

        load.assert_called_once_with(2026, 9, "FP1")
        body = json.loads(response.body)
        self.assertEqual(body["results"][0]["Driver"]["code"], "VER")
        # ...and the repaired classification replaces the bad cache entry.
        self.assertTrue(poisoned.update["upsert"])

    def test_a_session_the_event_never_had_returns_empty_not_an_error(self):
        fake_db = FakeDb()

        with patch.object(session_results, "get_db", return_value=fake_db), \
             patch.object(
                 session_results, "load_session",
                 side_effect=ValueError("Session type 'FP2' does not exist for this event"),
             ):
            response = asyncio.run(
                session_results.get_session_classification(year=2026, round=9, session="FP2")
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.body)["results"], [])


class SyncCollection:
    """Minimal stand-in for a pymongo (synchronous) collection."""

    def __init__(self, docs=None):
        self.docs = list(docs or [])

    def find_one(self, query, projection=None):
        for doc in self.docs:
            if all(doc.get(k) == v for k, v in query.items()):
                return doc
        return None

    def find(self, query, projection=None):
        return [
            doc for doc in self.docs
            if all(doc.get(k) == v for k, v in query.items())
        ]


class AlreadyStoredTests(unittest.TestCase):
    def test_false_when_nothing_is_stored(self):
        self.assertFalse(data_sync._already_stored(SyncCollection(), {"round": "1"}))

    def test_false_when_the_document_has_no_results(self):
        collection = SyncCollection([{"round": "1", "results": []}])
        self.assertFalse(data_sync._already_stored(collection, {"round": "1"}))

    def test_true_for_a_stored_document(self):
        collection = SyncCollection([{"round": "1", "results": [{"position": "1"}]}])
        self.assertTrue(data_sync._already_stored(collection, {"round": "1"}))

    def test_unclassified_rows_are_not_treated_as_stored(self):
        collection = SyncCollection([{"round": "1", "results": [{"position": ""}]}])
        self.assertFalse(
            data_sync._already_stored(collection, {"round": "1"}, classified=True)
        )

    def test_a_fastf1_stopgap_does_not_block_the_ergast_result(self):
        # The API's FastF1 fallback writes a thinner shape when Ergast lags the
        # flag. Skipping on mere non-emptiness would make that permanent.
        collection = SyncCollection([
            {"round": "1", "results": [{"position": "1"}], "source": "fastf1"}
        ])
        self.assertFalse(
            data_sync._already_stored(collection, {"round": "1"}, source="ergast")
        )

    def test_an_ergast_document_is_kept(self):
        collection = SyncCollection([
            {"round": "1", "results": [{"position": "1"}], "source": "ergast"}
        ])
        self.assertTrue(
            data_sync._already_stored(collection, {"round": "1"}, source="ergast")
        )

    def test_a_document_predating_the_source_marker_is_refetched_once(self):
        collection = SyncCollection([{"round": "1", "results": [{"position": "1"}]}])
        self.assertFalse(
            data_sync._already_stored(collection, {"round": "1"}, source="ergast")
        )


class CompletedRoundsTests(unittest.TestCase):
    class FakeDb:
        def __init__(self, races):
            self.races = SyncCollection(races)

    def _db(self, races):
        return self.FakeDb(races)

    def test_orders_rounds_numerically(self):
        # Ergast stores round as a string, so a lexicographic sort puts 10 first.
        db = self._db([
            {"season": 2026, "round": "10", "date": "2026-01-01", "time": "12:00:00Z"},
            {"season": 2026, "round": "2", "date": "2026-01-01", "time": "12:00:00Z"},
        ])
        rounds = [r["round"] for r in data_sync._completed_rounds(db, 2026)]
        self.assertEqual(rounds, ["2", "10"])

    def test_a_garbage_round_does_not_crash_the_sync(self):
        db = self._db([
            {"season": 2026, "round": None, "date": "2026-01-01", "time": "12:00:00Z"},
            {"season": 2026, "round": "1", "date": "2026-01-01", "time": "12:00:00Z"},
        ])
        self.assertEqual(len(data_sync._completed_rounds(db, 2026)), 2)

    def test_future_races_are_excluded(self):
        future = (data_sync._utcnow() + datetime.timedelta(days=7)).strftime("%Y-%m-%d")
        db = self._db([{"season": 2026, "round": "1", "date": future, "time": "12:00:00Z"}])
        self.assertEqual(data_sync._completed_rounds(db, 2026), [])

    def test_a_race_in_progress_counts_as_started_but_not_settled(self):
        # Its results table simply isn't published yet, but summarising the
        # session now would cache a fastest lap from a half-run race.
        start = data_sync._utcnow() - datetime.timedelta(hours=1)
        db = self._db([{
            "season": 2026, "round": "1",
            "date": start.strftime("%Y-%m-%d"),
            "time": start.strftime("%H:%M:%SZ"),
        }])
        self.assertEqual(len(data_sync._completed_rounds(db, 2026)), 1)
        self.assertEqual(data_sync._completed_rounds(db, 2026, settled=True), [])

    def test_a_finished_race_is_settled(self):
        start = data_sync._utcnow() - datetime.timedelta(hours=6)
        db = self._db([{
            "season": 2026, "round": "1",
            "date": start.strftime("%Y-%m-%d"),
            "time": start.strftime("%H:%M:%SZ"),
        }])
        self.assertEqual(len(data_sync._completed_rounds(db, 2026, settled=True)), 1)


if __name__ == "__main__":
    unittest.main()
