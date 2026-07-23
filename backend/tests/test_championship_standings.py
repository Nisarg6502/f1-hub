import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# championship_standings imports motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import championship_standings


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
        self.driver_standings = collections.get("driver_standings", FakeCollection())
        self.constructor_standings = collections.get("constructor_standings", FakeCollection())


DRIVER_STANDINGS_PAYLOAD = {
    "MRData": {
        "StandingsTable": {
            "StandingsLists": [{
                "DriverStandings": [{
                    "position": "1",
                    "points": "410",
                    "wins": "12",
                    "Driver": {"driverId": "max_verstappen", "givenName": "Max", "familyName": "Verstappen"},
                    "Constructors": [{"name": "Red Bull"}],
                }]
            }]
        }
    }
}

CONSTRUCTOR_STANDINGS_PAYLOAD = {
    "MRData": {
        "StandingsTable": {
            "StandingsLists": [{
                "ConstructorStandings": [{
                    "position": "1",
                    "points": "600",
                    "wins": "15",
                    "Constructor": {"name": "Red Bull"},
                }]
            }]
        }
    }
}


class DriverStandingsCacheHitTests(unittest.TestCase):
    def test_serves_from_mongo_without_calling_ergast(self):
        cached = FakeCollection({"standings": [{"position": "1", "Driver": {"driverId": "x"}}]})
        fake_db = FakeDb(driver_standings=cached)

        with patch.object(championship_standings, "get_db", return_value=fake_db), \
             patch.object(championship_standings, "_fetch_json") as fetch:
            response = asyncio.run(
                championship_standings.get_driver_standings(year=2026, fields="standings")
            )

        fetch.assert_not_called()
        body = json.loads(response.body)
        self.assertEqual(body["driver_standings"][0]["Driver"]["driverId"], "x")


class DriverStandingsCacheMissTests(unittest.TestCase):
    def test_falls_back_to_ergast_and_self_heals(self):
        fake_db = FakeDb(driver_standings=FakeCollection(None))

        with patch.object(championship_standings, "get_db", return_value=fake_db), \
             patch.object(championship_standings, "_fetch_json", return_value=DRIVER_STANDINGS_PAYLOAD):
            response = asyncio.run(
                championship_standings.get_driver_standings(year=2019, fields="standings")
            )

        body = json.loads(response.body)
        self.assertEqual(
            body["driver_standings"][0]["Driver"]["driverId"], "max_verstappen"
        )
        self.assertTrue(fake_db.driver_standings.update["upsert"])
        written = fake_db.driver_standings.update["update"]["$set"]
        self.assertEqual(written["season"], 2019)
        self.assertEqual(len(written["standings"]), 1)

    def test_an_unsynced_year_with_no_ergast_data_returns_empty_without_writing(self):
        fake_db = FakeDb(driver_standings=FakeCollection(None))

        with patch.object(championship_standings, "get_db", return_value=fake_db), \
             patch.object(championship_standings, "_fetch_json", return_value=None):
            response = asyncio.run(
                championship_standings.get_driver_standings(year=1885, fields="standings")
            )

        body = json.loads(response.body)
        self.assertEqual(body["driver_standings"], [])
        self.assertIsNone(fake_db.driver_standings.update)


class ConstructorStandingsCacheMissTests(unittest.TestCase):
    def test_falls_back_to_ergast_and_self_heals(self):
        fake_db = FakeDb(constructor_standings=FakeCollection(None))

        with patch.object(championship_standings, "get_db", return_value=fake_db), \
             patch.object(
                 championship_standings, "_fetch_json", return_value=CONSTRUCTOR_STANDINGS_PAYLOAD
             ):
            response = asyncio.run(
                championship_standings.get_constructor_standings(year=2019, fields="standings")
            )

        body = json.loads(response.body)
        self.assertEqual(body["constructor_standings"][0]["Constructor"]["name"], "Red Bull")
        self.assertTrue(fake_db.constructor_standings.update["upsert"])


if __name__ == "__main__":
    unittest.main()
