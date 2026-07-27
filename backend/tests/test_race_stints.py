import asyncio
import json
import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# race_stints imports motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import race_stints


class FakeCollection:
    def __init__(self, doc=None):
        self.doc = doc
        self.update = None

    async def find_one(self, *args, **kwargs):
        return self.doc

    async def update_one(self, query, update, upsert=False):
        self.update = {"query": query, "update": update, "upsert": upsert}


class FakeDb:
    def __init__(self, race_stints=None):
        self.race_stints = race_stints or FakeCollection()


def lap(driver, stint, lap_number, compound="SOFT", tyre_life=1):
    return {
        "DriverNumber": driver,
        "Stint": stint,
        "LapNumber": lap_number,
        "Compound": compound,
        "TyreLife": tyre_life,
    }


class StintsFromLapsTests(unittest.TestCase):
    def test_groups_laps_into_one_record_per_driver_stint(self):
        laps = [
            lap("1", 1, 1, "SOFT", 1),
            lap("1", 1, 2, "SOFT", 2),
            lap("1", 2, 3, "HARD", 1),
            lap("44", 1, 1, "MEDIUM", 3),
        ]

        stints = race_stints.stints_from_laps(laps)

        self.assertEqual(len(stints), 3)
        self.assertEqual(stints[0], {
            "driver_number": 1,
            "stint_number": 1,
            "lap_start": 1,
            "lap_end": 2,
            "compound": "SOFT",
            "tyre_age_at_start": 1,
        })
        self.assertEqual(stints[1]["compound"], "HARD")
        self.assertEqual(stints[2]["driver_number"], 44)

    def test_orders_by_driver_then_stint_regardless_of_lap_order(self):
        laps = [lap("44", 2, 30), lap("1", 1, 5), lap("44", 1, 1)]

        stints = race_stints.stints_from_laps(laps)

        self.assertEqual(
            [(s["driver_number"], s["stint_number"]) for s in stints],
            [(1, 1), (44, 1), (44, 2)],
        )

    def test_tyre_age_comes_from_the_stints_earliest_lap_not_the_first_row(self):
        # FastF1 does not guarantee lap order within the frame.
        laps = [lap("1", 1, 12, "HARD", 9), lap("1", 1, 10, "HARD", 7)]

        stints = race_stints.stints_from_laps(laps)

        self.assertEqual(stints[0]["tyre_age_at_start"], 7)
        self.assertEqual(stints[0]["lap_start"], 10)
        self.assertEqual(stints[0]["lap_end"], 12)

    def test_drops_rows_missing_a_driver_stint_or_lap_number(self):
        laps = [
            lap(None, 1, 1),
            lap("1", None, 1),
            lap("1", 1, None),
            lap("1", 1, 4),
        ]

        stints = race_stints.stints_from_laps(laps)

        self.assertEqual(len(stints), 1)
        self.assertEqual(stints[0]["lap_start"], 4)

    def test_a_missing_compound_falls_back_to_unknown(self):
        stints = race_stints.stints_from_laps([lap("1", 1, 1, compound=None)])

        self.assertEqual(stints[0]["compound"], "UNKNOWN")

    def test_no_laps_yields_no_stints(self):
        self.assertEqual(race_stints.stints_from_laps([]), [])


class RaceStintsEndpointTests(unittest.TestCase):
    def test_serves_cached_stints_without_calling_fastf1(self):
        cached = FakeCollection({
            "season": 2026,
            "round": "3",
            "stints": [{
                "driver_number": 1,
                "stint_number": 1,
                "lap_start": 1,
                "lap_end": 20,
                "compound": "SOFT",
                "tyre_age_at_start": 0,
            }],
        })

        with patch.object(race_stints, "get_db", return_value=FakeDb(cached)), \
             patch.object(race_stints, "build_race_stints") as build:
            response = asyncio.run(race_stints.get_race_stints(year=2026, round_number=3))

        build.assert_not_called()
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(len(body["stints"]), 1)

    def test_rebuilds_from_fastf1_on_a_miss_and_self_heals_the_cache(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [{
            "driver_number": 1,
            "stint_number": 1,
            "lap_start": 1,
            "lap_end": 20,
            "compound": "SOFT",
            "tyre_age_at_start": 0,
        }]

        with patch.object(race_stints, "get_db", return_value=fake_db), \
             patch.object(race_stints, "build_race_stints", return_value=built) as build:
            response = asyncio.run(race_stints.get_race_stints(year=2026, round_number=3))

        build.assert_called_once_with(2026, 3)
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(body["stints"], built)

        self.assertTrue(fake_db.race_stints.update["upsert"])
        written = fake_db.race_stints.update["update"]["$set"]
        self.assertEqual(written["season"], 2026)
        self.assertEqual(written["round"], "3")
        self.assertEqual(written["stints"], built)

    def test_an_unbuildable_round_reports_unsynced_rather_than_failing(self):
        # This is the Cloud Run case: livetiming 403s, so the rebuild returns
        # nothing and the frontend should say "not synced yet", not error.
        fake_db = FakeDb(FakeCollection(None))

        with patch.object(race_stints, "get_db", return_value=fake_db), \
             patch.object(race_stints, "build_race_stints", return_value=None):
            response = asyncio.run(race_stints.get_race_stints(year=2026, round_number=3))

        self.assertEqual(response.status_code, 200)
        body = json.loads(response.body)
        self.assertFalse(body["synced"])
        self.assertEqual(body["stints"], [])
        self.assertIsNone(fake_db.race_stints.update)

    def test_a_cached_doc_with_no_stints_triggers_a_rebuild(self):
        fake_db = FakeDb(FakeCollection({"season": 2026, "round": "3", "stints": []}))

        with patch.object(race_stints, "get_db", return_value=fake_db), \
             patch.object(race_stints, "build_race_stints", return_value=None) as build:
            asyncio.run(race_stints.get_race_stints(year=2026, round_number=3))

        build.assert_called_once()


if __name__ == "__main__":
    unittest.main()
