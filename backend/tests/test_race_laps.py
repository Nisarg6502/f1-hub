import asyncio
import json
import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# race_laps imports motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import race_laps


class FakeCollection:
    def __init__(self, doc=None):
        self.doc = doc
        self.update = None

    async def find_one(self, *args, **kwargs):
        return self.doc

    async def update_one(self, query, update, upsert=False):
        self.update = {"query": query, "update": update, "upsert": upsert}


class FakeDb:
    def __init__(self, race_laps=None):
        self.race_laps = race_laps or FakeCollection()


def lap(driver, lap_number, position):
    return {
        "DriverNumber": driver,
        "LapNumber": lap_number,
        "Position": position,
    }


class PositionsFromLapsTests(unittest.TestCase):
    def test_flattens_laps_into_one_record_per_driver_lap(self):
        laps = [
            lap("1", 1, 2),
            lap("1", 2, 1),
            lap("44", 1, 1),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0], {"driver_number": 1, "lap_number": 1, "position": 2})

    def test_orders_by_driver_then_lap_regardless_of_input_order(self):
        laps = [lap("44", 2, 3), lap("1", 1, 5), lap("44", 1, 4)]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(
            [(r["driver_number"], r["lap_number"]) for r in rows],
            [(1, 1), (44, 1), (44, 2)],
        )

    def test_drops_rows_missing_a_driver_lap_or_position(self):
        laps = [
            lap(None, 1, 1),
            lap("1", None, 1),
            lap("1", 1, None),
            lap("1", 2, 3),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["lap_number"], 2)

    def test_a_retired_driver_simply_has_no_rows_past_their_last_lap(self):
        laps = [lap("1", 1, 1), lap("1", 2, 1)]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual([r["lap_number"] for r in rows], [1, 2])

    def test_no_laps_yields_no_rows(self):
        self.assertEqual(race_laps.positions_from_laps([]), [])


class RaceLapsEndpointTests(unittest.TestCase):
    def test_serves_cached_laps_without_calling_fastf1(self):
        cached = FakeCollection({
            "season": 2026,
            "round": "3",
            "laps": [{"driver_number": 1, "lap_number": 1, "position": 1}],
        })

        with patch.object(race_laps, "get_db", return_value=FakeDb(cached)), \
             patch.object(race_laps, "build_race_laps") as build:
            response = asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        build.assert_not_called()
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(len(body["laps"]), 1)

    def test_rebuilds_from_fastf1_on_a_miss_and_self_heals_the_cache(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [{"driver_number": 1, "lap_number": 1, "position": 1}]

        with patch.object(race_laps, "get_db", return_value=fake_db), \
             patch.object(race_laps, "build_race_laps", return_value=built) as build:
            response = asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        build.assert_called_once_with(2026, 3)
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(body["laps"], built)

        self.assertTrue(fake_db.race_laps.update["upsert"])
        written = fake_db.race_laps.update["update"]["$set"]
        self.assertEqual(written["season"], 2026)
        self.assertEqual(written["round"], "3")
        self.assertEqual(written["laps"], built)

    def test_an_unbuildable_round_reports_unsynced_rather_than_failing(self):
        # This is the Cloud Run case: livetiming 403s, so the rebuild returns
        # nothing and the frontend should say "not synced yet", not error.
        fake_db = FakeDb(FakeCollection(None))

        with patch.object(race_laps, "get_db", return_value=fake_db), \
             patch.object(race_laps, "build_race_laps", return_value=None):
            response = asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        self.assertEqual(response.status_code, 200)
        body = json.loads(response.body)
        self.assertFalse(body["synced"])
        self.assertEqual(body["laps"], [])
        self.assertIsNone(fake_db.race_laps.update)

    def test_a_cached_doc_with_no_laps_triggers_a_rebuild(self):
        fake_db = FakeDb(FakeCollection({"season": 2026, "round": "3", "laps": []}))

        with patch.object(race_laps, "get_db", return_value=fake_db), \
             patch.object(race_laps, "build_race_laps", return_value=None) as build:
            asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        build.assert_called_once()


if __name__ == "__main__":
    unittest.main()
