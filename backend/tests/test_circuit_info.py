import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# circuit_info imports motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import circuit_info


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
        self.circuit_details = collections.get("circuit_details", FakeCollection())
        self.races = collections.get("races", FakeCollection())


class FakeLaps:
    def __init__(self, fastest=None):
        self._fastest = fastest

    def pick_fastest(self):
        return self._fastest


class FakeSession:
    def __init__(self, event, laps, corners=11, total_laps=53):
        self.event = event
        self.laps = laps
        self.total_laps = total_laps
        self._corners = corners

    def load(self, **kwargs):
        pass

    def get_circuit_info(self):
        return type("CircuitGeometry", (), {"corners": [0] * self._corners})()


class CircuitInfoCacheHitTests(unittest.TestCase):
    def test_serves_from_circuit_details_without_calling_fastf1(self):
        cached = FakeCollection({
            "country": "Italy",
            "grand_prix": "Italian Grand Prix",
            "track_information": {
                "number_of_laps": 53,
                "number_of_corners": 11,
                "lap_record": "1:21.046 (VER)",
            },
        })
        fake_db = FakeDb(circuit_details=cached)

        with patch.object(circuit_info, "get_db", return_value=fake_db), \
             patch.object(circuit_info.fastf1, "get_session") as get_session:
            response = asyncio.run(
                circuit_info.get_circuit_info(year=2026, event_name="Italian Grand Prix")
            )

        get_session.assert_not_called()
        body = json.loads(response.body)
        self.assertEqual(body["total_laps"], 53)
        self.assertEqual(body["num_corners"], 11)
        self.assertEqual(
            body["fastest_lap"], {"time": "1:21.046", "driver": "VER", "year": 2026}
        )

    def test_missing_lap_record_leaves_fastest_lap_empty(self):
        cached = FakeCollection({
            "country": "Monaco",
            "track_information": {"number_of_laps": 78, "number_of_corners": None, "lap_record": None},
        })
        fake_db = FakeDb(circuit_details=cached)

        with patch.object(circuit_info, "get_db", return_value=fake_db):
            response = asyncio.run(
                circuit_info.get_circuit_info(year=2026, event_name="Monaco Grand Prix")
            )

        body = json.loads(response.body)
        self.assertEqual(body["num_corners"], 0)
        self.assertIsNone(body["fastest_lap"]["time"])


class CircuitInfoCacheMissTests(unittest.TestCase):
    def test_falls_back_to_fastf1_and_self_heals_the_cache(self):
        fake_db = FakeDb(
            circuit_details=FakeCollection(None),
            races=FakeCollection({
                "round": "16",
                "raceName": "Italian Grand Prix",
                "date": "2026-09-06",
                "Circuit": {
                    "circuitName": "Autodromo Nazionale di Monza",
                    "Location": {"country": "Italy"},
                },
            }),
        )

        event = type("Event", (), {"Country": "Italy", "Location": "Monza", "Year": 2026})()
        laps = FakeLaps(fastest={"LapTime": "1:21.046", "Driver": "VER"})
        session = FakeSession(event, laps, corners=11, total_laps=53)

        with patch.object(circuit_info, "get_db", return_value=fake_db), \
             patch.object(circuit_info.fastf1, "get_session", return_value=session) as get_session:
            response = asyncio.run(
                circuit_info.get_circuit_info(year=2026, event_name="Italian Grand Prix")
            )

        get_session.assert_called_once()
        body = json.loads(response.body)
        self.assertEqual(body["total_laps"], 53)
        self.assertEqual(body["num_corners"], 11)
        self.assertEqual(body["fastest_lap"]["driver"], "VER")

        self.assertTrue(fake_db.circuit_details.update["upsert"])
        written = fake_db.circuit_details.update["update"]["$set"]
        self.assertEqual(written["round"], 16)
        self.assertEqual(written["season"], 2026)
        self.assertEqual(written["grand_prix"], "Italian Grand Prix")
        self.assertEqual(written["track_information"]["lap_record"], "1:21.046 (VER)")

    def test_skips_self_heal_when_the_race_is_not_synced_yet(self):
        fake_db = FakeDb(circuit_details=FakeCollection(None), races=FakeCollection(None))
        event = type("Event", (), {"Country": "Italy", "Location": "Monza", "Year": 2026})()
        session = FakeSession(event, FakeLaps(fastest=None))

        with patch.object(circuit_info, "get_db", return_value=fake_db), \
             patch.object(circuit_info.fastf1, "get_session", return_value=session):
            response = asyncio.run(
                circuit_info.get_circuit_info(year=2026, event_name="Italian Grand Prix")
            )

        self.assertEqual(response.status_code, 200)
        self.assertIsNone(fake_db.circuit_details.update)

    def test_a_fastf1_load_failure_returns_502(self):
        fake_db = FakeDb(circuit_details=FakeCollection(None))

        with patch.object(circuit_info, "get_db", return_value=fake_db), \
             patch.object(
                 circuit_info.fastf1, "get_session", side_effect=RuntimeError("no such event")
             ):
            response = asyncio.run(
                circuit_info.get_circuit_info(year=2026, event_name="Nowhere Grand Prix")
            )

        self.assertEqual(response.status_code, 502)


class SplitLapRecordTests(unittest.TestCase):
    def test_splits_time_and_driver(self):
        self.assertEqual(
            circuit_info._split_lap_record("1:21.046 (VER)"), ("1:21.046", "VER")
        )

    def test_handles_a_time_only_record(self):
        self.assertEqual(circuit_info._split_lap_record("1:21.046"), ("1:21.046", None))

    def test_handles_none(self):
        self.assertEqual(circuit_info._split_lap_record(None), (None, None))


if __name__ == "__main__":
    unittest.main()
