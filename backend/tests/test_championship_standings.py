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


class FakeCursor:
    def __init__(self, docs):
        self.docs = docs

    async def to_list(self, length=None):
        return list(self.docs)


class ResultsCollection:
    def __init__(self, docs=None):
        self.docs = docs or []

    def find(self, *args, **kwargs):
        return FakeCursor(self.docs)


class FakeDb:
    def __init__(self, **collections):
        self.driver_standings = collections.get("driver_standings", FakeCollection())
        self.constructor_standings = collections.get("constructor_standings", FakeCollection())
        self.race_results = collections.get("race_results", ResultsCollection())
        self.sprint_results = collections.get("sprint_results", ResultsCollection())


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



def _result(driver, team, points):
    return {"points": str(points), "Driver": {"driverId": driver}, "Constructor": {"constructorId": team}}


class StandingsRoundTests(unittest.TestCase):
    RACES = [
        {"round": "1", "results": [_result("ant", "merc", 25), _result("ver", "rbr", 18)]},
        {"round": "2", "results": [_result("ver", "rbr", 25), _result("ant", "merc", 18)]},
    ]
    SPRINTS = [{"round": "2", "results": [_result("ant", "merc", 8), _result("ver", "rbr", 7)]}]

    def table(self, ant, ver):
        return [
            {"points": str(ant), "Driver": {"driverId": "ant"}},
            {"points": str(ver), "Driver": {"driverId": "ver"}},
        ]

    def test_matches_the_round_the_points_describe(self):
        self.assertEqual(championship_standings.round_of_table(self.table(25, 18), self.RACES, self.SPRINTS, "driver"), 1)
        self.assertEqual(championship_standings.round_of_table(self.table(51, 50), self.RACES, self.SPRINTS, "driver"), 2)

    def test_no_match_is_none_not_the_latest_round(self):
        # Results a round ahead of the table must not be mistaken for it.
        self.assertIsNone(championship_standings.round_of_table(self.table(30, 10), self.RACES, self.SPRINTS, "driver"))

    def test_a_table_after_a_sprint_is_the_round_before(self):
        # Round 2's sprint is in (25+8, 18+7) but its Grand Prix is not: that
        # race is still to score, so the table describes round 1.
        self.assertEqual(
            championship_standings.round_of_table(self.table(33, 25), self.RACES, self.SPRINTS, "driver"), 1
        )
        # Before round 2's race result is even stored, the same holds.
        self.assertEqual(
            championship_standings.round_of_table(self.table(33, 25), self.RACES[:1], self.SPRINTS, "driver"), 1
        )

    def test_stored_round_is_used_when_no_points_match(self):
        doc = {"standings": self.table(30, 10), "round": 2}
        db = FakeDb(
            driver_standings=FakeCollection(doc),
            race_results=ResultsCollection(self.RACES),
            sprint_results=ResultsCollection(self.SPRINTS),
        )
        with patch.object(championship_standings, "get_db", return_value=db):
            response = asyncio.run(championship_standings.get_driver_standings(year=2026, fields="standings"))
        self.assertEqual(json.loads(response.body)["round"], 2)

    def test_stored_round_without_its_race_result_is_the_round_before(self):
        # Ergast numbers a table published after a sprint with the weekend's round.
        doc = {"standings": self.table(30, 10), "round": 2}
        db = FakeDb(
            driver_standings=FakeCollection(doc),
            race_results=ResultsCollection(self.RACES[:1]),
            sprint_results=ResultsCollection(self.SPRINTS),
        )
        with patch.object(championship_standings, "get_db", return_value=db):
            response = asyncio.run(championship_standings.get_driver_standings(year=2026, fields="standings"))
        self.assertEqual(json.loads(response.body)["round"], 1)

    def test_points_evidence_beats_the_stored_round(self):
        doc = {"standings": self.table(25, 18), "round": 2}
        db = FakeDb(
            driver_standings=FakeCollection(doc),
            race_results=ResultsCollection(self.RACES),
            sprint_results=ResultsCollection(self.SPRINTS),
        )
        with patch.object(championship_standings, "get_db", return_value=db):
            response = asyncio.run(championship_standings.get_driver_standings(year=2026, fields="standings"))
        self.assertEqual(json.loads(response.body)["round"], 1)

    def test_missing_round_is_derived_from_results(self):
        doc = {"standings": self.table(51, 50)}
        db = FakeDb(
            driver_standings=FakeCollection(doc),
            race_results=ResultsCollection(self.RACES),
            sprint_results=ResultsCollection(self.SPRINTS),
        )
        with patch.object(championship_standings, "get_db", return_value=db):
            response = asyncio.run(championship_standings.get_driver_standings(year=2026, fields="standings"))
        self.assertEqual(json.loads(response.body)["round"], 2)


if __name__ == "__main__":
    unittest.main()
