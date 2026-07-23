import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# races imports motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import races


class FakeCursor:
    def __init__(self, docs):
        self.docs = docs

    async def to_list(self, length=None):
        return list(self.docs)


class FakeCollection:
    def __init__(self, docs=None):
        self.docs = docs if docs is not None else []
        self.updates = []

    def find(self, *args, **kwargs):
        return FakeCursor(self.docs)

    async def update_one(self, query, update, upsert=False):
        self.updates.append({"query": query, "update": update, "upsert": upsert})


class FakeDb:
    def __init__(self, **collections):
        self.races = collections.get("races", FakeCollection())
        self.circuit_details = collections.get("circuit_details", FakeCollection())


ERGAST_RACES_PAYLOAD = {
    "MRData": {
        "RaceTable": {
            "Races": [
                {"season": "2019", "round": "10", "raceName": "British Grand Prix"},
                {"season": "2019", "round": "2", "raceName": "Bahrain Grand Prix"},
            ]
        }
    }
}


class RacesCacheHitTests(unittest.TestCase):
    def test_serves_from_mongo_without_calling_ergast(self):
        cached = FakeCollection([
            {"season": 2026, "round": "1", "raceName": "Australian Grand Prix"},
        ])
        fake_db = FakeDb(races=cached)

        with patch.object(races, "get_db", return_value=fake_db), \
             patch.object(races, "_fetch_json") as fetch:
            response = asyncio.run(races.get_races(year=2026, fields="races"))

        fetch.assert_not_called()
        body = json.loads(response.body)
        self.assertEqual(body["races"][0]["raceName"], "Australian Grand Prix")


class RacesCacheMissTests(unittest.TestCase):
    def test_falls_back_to_ergast_self_heals_and_sorts_numerically(self):
        fake_db = FakeDb(races=FakeCollection([]))

        with patch.object(races, "get_db", return_value=fake_db), \
             patch.object(races, "_fetch_json", return_value=ERGAST_RACES_PAYLOAD):
            response = asyncio.run(races.get_races(year=2019, fields="races"))

        body = json.loads(response.body)
        # Ergast stores round as a string; "10" must not sort before "2".
        self.assertEqual(
            [r["raceName"] for r in body["races"]],
            ["Bahrain Grand Prix", "British Grand Prix"],
        )
        self.assertEqual(len(fake_db.races.updates), 2)
        self.assertTrue(all(u["upsert"] for u in fake_db.races.updates))
        self.assertEqual(fake_db.races.updates[0]["query"]["season"], 2019)

    def test_a_year_with_no_ergast_data_returns_empty_without_writing(self):
        fake_db = FakeDb(races=FakeCollection([]))

        with patch.object(races, "get_db", return_value=fake_db), \
             patch.object(races, "_fetch_json", return_value=None):
            response = asyncio.run(races.get_races(year=1885, fields="races,total"))

        body = json.loads(response.body)
        self.assertEqual(body["races"], [])
        self.assertEqual(body["total_races"], 0)
        self.assertEqual(fake_db.races.updates, [])


class CircuitDetailsTests(unittest.TestCase):
    def test_returns_details_sorted_by_round(self):
        cached = FakeCollection([
            {"season": 2026, "round": "10", "grand_prix": "British Grand Prix"},
            {"season": 2026, "round": "2", "grand_prix": "Bahrain Grand Prix"},
        ])
        fake_db = FakeDb(circuit_details=cached)

        with patch.object(races, "get_db", return_value=fake_db):
            response = asyncio.run(races.get_circuit_details(year=2026))

        body = json.loads(response.body)
        self.assertEqual(
            [d["grand_prix"] for d in body["circuit_details"]],
            ["Bahrain Grand Prix", "British Grand Prix"],
        )


if __name__ == "__main__":
    unittest.main()
