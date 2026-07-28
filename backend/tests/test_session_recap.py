import asyncio
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# session_recap imports motor (via db.py) at module scope; these tests never
# touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import session_recap


class FakeCollection:
    def __init__(self, find_one_result=None):
        self._find_one_result = find_one_result
        self.update_one_calls = []

    async def find_one(self, query=None, *args, **kwargs):
        return self._find_one_result

    async def update_one(self, query, update, upsert=False):
        self.update_one_calls.append((query, update, upsert))


class FakeDb:
    def __init__(self, race_results=None, session_recap=None):
        self.race_results = race_results or FakeCollection()
        self.session_recap = session_recap or FakeCollection()


def result_row(position, given_name, family_name, team="Red Bull", status="Finished", time="", points="0"):
    return {
        "position": position,
        "Driver": {"givenName": given_name, "familyName": family_name},
        "Constructor": {"name": team},
        "status": status,
        "Time": {"time": time} if time else None,
        "points": points,
    }


async def _drain(stream):
    return "".join([chunk async for chunk in stream])


class ClassificationFactsTests(unittest.TestCase):
    def test_extracts_position_driver_team_status_gap_points(self):
        results = [result_row("1", "Max", "Verstappen", time="1:32:07.986", points="25")]

        facts = session_recap._classification_facts(results)

        self.assertEqual(facts, [{
            "position": "1",
            "driver": "Max Verstappen",
            "team": "Red Bull",
            "status": "Finished",
            "gap_to_leader": "1:32:07.986",
            "points": "25",
        }])

    def test_a_dnf_falls_back_to_status_for_the_gap_field(self):
        results = [result_row("20", "Kevin", "Magnussen", status="Retired", time="")]

        facts = session_recap._classification_facts(results)

        self.assertEqual(facts[0]["gap_to_leader"], "Retired")


class FastestLapFactsTests(unittest.TestCase):
    def test_finds_the_rank_1_fastest_lap(self):
        results = [
            {
                "Driver": {"givenName": "Lando", "familyName": "Norris"},
                "FastestLap": {"rank": "1", "lap": "44", "Time": {"time": "1:18.492"}},
            },
            {
                "Driver": {"givenName": "Max", "familyName": "Verstappen"},
                "FastestLap": {"rank": "2"},
            },
        ]

        facts = session_recap._fastest_lap_facts(results)

        self.assertEqual(facts, {"driver": "Lando Norris", "time": "1:18.492", "lap": "44"})

    def test_no_fastest_lap_rank_yields_none(self):
        self.assertIsNone(session_recap._fastest_lap_facts([{"Driver": {}}]))


class BuildFactsTests(unittest.TestCase):
    def test_assembles_race_metadata_with_classification_and_fastest_lap(self):
        race = {
            "raceName": "British Grand Prix",
            "season": 2026,
            "round": "12",
            "Circuit": {"circuitName": "Silverstone Circuit"},
        }
        results = [result_row("1", "Max", "Verstappen")]

        facts = session_recap.build_facts(race, results)

        self.assertEqual(facts["race_name"], "British Grand Prix")
        self.assertEqual(facts["circuit"], "Silverstone Circuit")
        self.assertEqual(len(facts["classification"]), 1)


class GenerateRecapTests(unittest.TestCase):
    def test_yields_nothing_when_the_api_key_is_unset(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OLLAMA_API_KEY", None)
            text = asyncio.run(_drain(session_recap._generate_recap({"race_name": "Test GP"})))

        self.assertEqual(text, "")


class SessionRecapEndpointTests(unittest.TestCase):
    async def _drain_response(self, response):
        return "".join([chunk async for chunk in response.body_iterator])

    def test_a_fresh_cache_hit_replays_the_stored_text_without_calling_ollama(self):
        cache = FakeCollection(find_one_result={"text": "Verstappen dominated."})
        fake_db = FakeDb(session_recap=cache)

        with patch.object(session_recap, "get_db", return_value=fake_db), patch.object(
            session_recap, "_generate_recap"
        ) as generate_mock:
            response = asyncio.run(session_recap.get_session_recap(year=2026, round=12))
            body = asyncio.run(self._drain_response(response))

        generate_mock.assert_not_called()
        self.assertEqual(body, "Verstappen dominated.")

    def test_no_cached_race_results_yields_an_empty_stream(self):
        fake_db = FakeDb(race_results=FakeCollection(find_one_result=None))

        with patch.object(session_recap, "get_db", return_value=fake_db):
            response = asyncio.run(session_recap.get_session_recap(year=2026, round=12))
            body = asyncio.run(self._drain_response(response))

        self.assertEqual(body, "")

    def test_a_cache_miss_streams_generated_text_and_writes_it_back(self):
        race_results = FakeCollection(
            find_one_result={
                "race": {"raceName": "British Grand Prix"},
                "results": [result_row("1", "Max", "Verstappen")],
            }
        )
        cache = FakeCollection(find_one_result=None)
        fake_db = FakeDb(race_results=race_results, session_recap=cache)

        async def fake_generate(facts):
            yield "Max "
            yield "won."

        with patch.object(session_recap, "get_db", return_value=fake_db), patch.object(
            session_recap, "_generate_recap", side_effect=fake_generate
        ):
            response = asyncio.run(session_recap.get_session_recap(year=2026, round=12))
            body = asyncio.run(self._drain_response(response))

        self.assertEqual(body, "Max won.")
        self.assertEqual(len(cache.update_one_calls), 1)
        cached_text = cache.update_one_calls[0][1]["$set"]["text"]
        self.assertEqual(cached_text, "Max won.")

    def test_a_failed_generation_caches_nothing(self):
        race_results = FakeCollection(
            find_one_result={
                "race": {"raceName": "British Grand Prix"},
                "results": [result_row("1", "Max", "Verstappen")],
            }
        )
        cache = FakeCollection(find_one_result=None)
        fake_db = FakeDb(race_results=race_results, session_recap=cache)

        async def fake_generate(facts):
            return
            yield  # pragma: no cover

        with patch.object(session_recap, "get_db", return_value=fake_db), patch.object(
            session_recap, "_generate_recap", side_effect=fake_generate
        ):
            response = asyncio.run(session_recap.get_session_recap(year=2026, round=12))
            body = asyncio.run(self._drain_response(response))

        self.assertEqual(body, "")
        self.assertEqual(cache.update_one_calls, [])


if __name__ == "__main__":
    unittest.main()
