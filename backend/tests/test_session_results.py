import asyncio
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

from app import f1_results, session_results


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


if __name__ == "__main__":
    unittest.main()
