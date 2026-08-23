import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import types

if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import session_sectors


def lap(driver, lap_number, s1, s2, s3, duration=None, pit_out=False):
    return {
        "driver_number": driver,
        "lap_number": lap_number,
        "duration_sector_1": s1,
        "duration_sector_2": s2,
        "duration_sector_3": s3,
        "lap_duration": duration if duration is not None else (
            None if None in (s1, s2, s3) else s1 + s2 + s3
        ),
        "is_pit_out_lap": pit_out,
    }


class ClassifyLapSectorsTests(unittest.TestCase):
    def test_a_single_driver_single_lap_is_purple_in_every_sector(self):
        rows = [lap(1, 10, 28.0, 30.0, 29.0)]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["driver_number"], 1)
        self.assertEqual(board[0]["sectors"]["1"], {"seconds": 28.0, "classification": "purple"})
        self.assertEqual(board[0]["sectors"]["2"], {"seconds": 30.0, "classification": "purple"})
        self.assertEqual(board[0]["sectors"]["3"], {"seconds": 29.0, "classification": "purple"})

    def test_a_slower_drivers_fastest_lap_can_mix_all_three_colors(self):
        rows = [
            # Driver 1 sets the session-best S1 (tied) and outright S3.
            lap(1, 10, 28.0, 30.5, 29.0, duration=87.5),
            # Driver 44's fastest lap overall (87.7s < the 88.5s lap below).
            # Its S1 (28.5) is slower than 44's own S1 from the *other* lap
            # (28.0) -> yellow. Its S2 (30.0) is the session's best -> purple.
            # Its S3 (29.2) matches 44's own best (set on this same lap, the
            # other lap's S3 is slower) but not driver 1's session-best S3
            # -> green.
            lap(44, 12, 28.5, 30.0, 29.2, duration=87.7),
            # Not driver 44's fastest lap (88.5s), but it sets their personal
            # best S1 (28.0), which is what makes lap 12's S1 yellow above.
            lap(44, 8, 28.0, 31.0, 29.5),
        ]

        board = session_sectors.classify_lap_sectors(rows)
        driver_44 = next(r for r in board if r["driver_number"] == 44)

        self.assertEqual(driver_44["lap_number"], 12)
        self.assertEqual(driver_44["sectors"]["1"]["classification"], "yellow")
        self.assertEqual(driver_44["sectors"]["2"]["classification"], "purple")
        self.assertEqual(driver_44["sectors"]["3"]["classification"], "green")

    def test_pit_out_laps_are_excluded(self):
        rows = [
            lap(1, 1, 40.0, 40.0, 40.0, duration=120.0, pit_out=True),
            lap(1, 2, 28.0, 30.0, 29.0, duration=87.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["lap_number"], 2)

    def test_laps_missing_any_sector_time_are_excluded(self):
        rows = [
            lap(1, 1, None, 30.0, 29.0),
            lap(1, 2, 28.0, 30.0, 29.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["lap_number"], 2)

    def test_picks_the_fastest_complete_lap_per_driver_by_total_duration(self):
        rows = [
            lap(1, 5, 28.0, 30.0, 29.0, duration=87.0),
            lap(1, 6, 27.0, 30.0, 29.0, duration=86.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(board[0]["lap_number"], 6)
        self.assertEqual(board[0]["lap_duration_seconds"], 86.0)

    def test_board_is_sorted_ascending_by_lap_duration(self):
        rows = [
            lap(1, 1, 29.0, 31.0, 30.0, duration=90.0),
            lap(44, 1, 28.0, 30.0, 29.0, duration=87.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual([r["driver_number"] for r in board], [44, 1])

    def test_no_rows_yields_an_empty_board(self):
        self.assertEqual(session_sectors.classify_lap_sectors([]), [])

    def test_a_driver_with_no_valid_lap_is_omitted(self):
        rows = [lap(1, 1, None, None, None, duration=None)]

        self.assertEqual(session_sectors.classify_lap_sectors(rows), [])


import asyncio
import json
from unittest.mock import patch


class FetchOpenf1SessionKeyForTests(unittest.TestCase):
    def test_matches_by_session_name_within_the_race_weekend_window(self):
        calls = []

        def fake_fetch(url, params=None, timeout=20.0):
            calls.append((url, params))
            return [
                {"session_key": 1001, "date_start": "2026-07-24T11:30:00+00:00"},  # FP1, Friday
                {"session_key": 1099, "date_start": "2025-05-02T11:30:00+00:00"},  # same name, prior season's round
            ]

        with patch.object(session_sectors, "_fetch_json", side_effect=fake_fetch):
            key = session_sectors.fetch_openf1_session_key_for("2026-07-26", "Practice 1")

        self.assertEqual(calls[0][1], {"year": "2026", "session_name": "Practice 1"})
        self.assertEqual(key, 1001)

    def test_no_matching_session_returns_none(self):
        with patch.object(session_sectors, "_fetch_json", return_value=[]):
            self.assertIsNone(
                session_sectors.fetch_openf1_session_key_for("2026-07-26", "Practice 1")
            )

    def test_no_race_date_returns_none_without_calling_openf1(self):
        with patch.object(session_sectors, "_fetch_json") as fetch:
            self.assertIsNone(session_sectors.fetch_openf1_session_key_for("", "Qualifying"))
        fetch.assert_not_called()


class BuildSessionSectorsOpenf1Tests(unittest.TestCase):
    def test_looks_up_the_session_then_fetches_and_classifies_its_laps(self):
        def fake_fetch(url, params=None, timeout=20.0):
            if url.endswith("/sessions"):
                return [{"session_key": 555, "date_start": "2026-07-25T14:00:00+00:00"}]
            self.assertEqual(params, {"session_key": 555})
            return [lap(1, 10, 28.0, 30.0, 29.0)]

        with patch.object(session_sectors, "_fetch_json", side_effect=fake_fetch):
            board = session_sectors.build_session_sectors_openf1("2026-07-26", "FP1")

        self.assertEqual(len(board), 1)

    def test_an_unknown_session_code_returns_none(self):
        self.assertIsNone(session_sectors.build_session_sectors_openf1("2026-07-26", "XX"))

    def test_no_session_key_returns_none(self):
        with patch.object(session_sectors, "_fetch_json", return_value=[]):
            self.assertIsNone(session_sectors.build_session_sectors_openf1("2026-07-26", "Q"))

    def test_empty_laps_returns_none(self):
        def fake_fetch(url, params=None, timeout=20.0):
            if url.endswith("/sessions"):
                return [{"session_key": 555, "date_start": "2026-07-25T14:00:00+00:00"}]
            return []

        with patch.object(session_sectors, "_fetch_json", side_effect=fake_fetch):
            self.assertIsNone(session_sectors.build_session_sectors_openf1("2026-07-26", "Q"))


class FakeCollection:
    def __init__(self, doc=None):
        self.doc = doc
        self.update = None

    async def find_one(self, *args, **kwargs):
        return self.doc

    async def update_one(self, query, update, upsert=False):
        self.update = {"query": query, "update": update, "upsert": upsert}


class FakeDb:
    def __init__(self, sectors_doc=None, race_date="2026-07-26"):
        self.session_sectors = sectors_doc or FakeCollection()
        self.races = FakeCollection({"date": race_date} if race_date else None)


class GetSessionSectorsEndpointTests(unittest.TestCase):
    def test_serves_a_cached_document_without_calling_openf1(self):
        cached = FakeCollection({
            "season": 2026, "round": "12", "session": "Q",
            "rows": [{"driver_number": 1, "lap_number": 10, "lap_duration_seconds": 87.0, "sectors": {}}],
        })

        with patch.object(session_sectors, "get_db", return_value=FakeDb(cached)), \
             patch.object(session_sectors, "build_session_sectors_openf1") as build:
            response = asyncio.run(
                session_sectors.get_session_sectors(year=2026, round_number=12, session="Q")
            )

        build.assert_not_called()
        body = json.loads(response.body)
        self.assertTrue(body["available"])
        self.assertEqual(len(body["rows"]), 1)

    def test_a_cache_miss_rebuilds_from_openf1_and_stores_the_result(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [{"driver_number": 1, "lap_number": 10, "lap_duration_seconds": 87.0, "sectors": {}}]

        with patch.object(session_sectors, "get_db", return_value=fake_db), \
             patch.object(session_sectors, "build_session_sectors_openf1", return_value=built) as build:
            response = asyncio.run(
                session_sectors.get_session_sectors(year=2026, round_number=12, session="fp1")
            )

        build.assert_called_once_with("2026-07-26", "FP1")
        self.assertEqual(fake_db.session_sectors.update["update"]["$set"]["rows"], built)
        body = json.loads(response.body)
        self.assertTrue(body["available"])

    def test_a_season_openf1_has_nothing_for_reports_unavailable(self):
        fake_db = FakeDb(FakeCollection(None))

        with patch.object(session_sectors, "get_db", return_value=fake_db), \
             patch.object(session_sectors, "build_session_sectors_openf1", return_value=None):
            response = asyncio.run(
                session_sectors.get_session_sectors(year=2018, round_number=3, session="Q")
            )

        body = json.loads(response.body)
        self.assertFalse(body["available"])
        self.assertEqual(body["rows"], [])

    def test_an_unknown_session_code_is_rejected_before_touching_the_db(self):
        with patch.object(session_sectors, "get_db") as get_db:
            response = asyncio.run(
                session_sectors.get_session_sectors(year=2026, round_number=12, session="XX")
            )

        get_db.assert_not_called()
        self.assertEqual(response.status_code, 400)
