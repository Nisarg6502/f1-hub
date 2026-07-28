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


def result_row(
    position,
    given_name,
    family_name,
    team="Red Bull",
    status="Finished",
    time="",
    points="0",
    grid=None,
    number="1",
):
    return {
        "number": number,
        "position": position,
        "Driver": {"givenName": given_name, "familyName": family_name},
        "Constructor": {"name": team},
        "status": status,
        "Time": {"time": time} if time else None,
        "points": points,
        "grid": grid if grid is not None else position,
    }


async def _drain(stream):
    return "".join([chunk async for chunk in stream])


class ClassificationFactsTests(unittest.TestCase):
    def test_extracts_position_driver_team_status_gap_points(self):
        results = [result_row("1", "Max", "Verstappen", time="1:32:07.986", points="25")]

        facts = session_recap._classification_facts(results)

        self.assertEqual(facts[0]["driver"], "Max Verstappen")
        self.assertEqual(facts[0]["team"], "Red Bull")
        self.assertEqual(facts[0]["gap_to_leader"], "1:32:07.986")
        self.assertEqual(facts[0]["points"], "25")

    def test_a_dnf_falls_back_to_status_for_the_gap_field(self):
        results = [result_row("20", "Kevin", "Magnussen", status="Retired", time="")]

        facts = session_recap._classification_facts(results)

        self.assertEqual(facts[0]["gap_to_leader"], "Retired")

    def test_positions_gained_is_precomputed_from_grid(self):
        results = [result_row("3", "Andrea Kimi", "Antonelli", grid="7")]

        facts = session_recap._classification_facts(results)

        self.assertEqual(facts[0]["positions_gained"], 4)

    def test_a_missing_grid_yields_no_positions_gained(self):
        row = result_row("3", "Andrea Kimi", "Antonelli")
        row["grid"] = None

        facts = session_recap._classification_facts([row])

        self.assertIsNone(facts[0]["positions_gained"])


class TeammatesTests(unittest.TestCase):
    def test_pairs_drivers_sharing_a_constructor(self):
        results = [
            result_row("1", "Max", "Verstappen", team="Red Bull"),
            result_row("2", "Isack", "Hadjar", team="Red Bull"),
            result_row("3", "Andrea Kimi", "Antonelli", team="Mercedes"),
            result_row("4", "George", "Russell", team="Mercedes"),
        ]

        teammates = session_recap._teammates(results)

        self.assertIn({"team": "Red Bull", "drivers": ["Max Verstappen", "Isack Hadjar"]}, teammates)
        self.assertIn(
            {"team": "Mercedes", "drivers": ["Andrea Kimi Antonelli", "George Russell"]},
            teammates,
        )

    def test_drivers_on_different_teams_are_never_paired(self):
        """Regression: v1 claimed Antonelli (Mercedes) was Verstappen's (Red Bull) teammate."""
        results = [
            result_row("1", "Max", "Verstappen", team="Red Bull"),
            result_row("2", "Andrea Kimi", "Antonelli", team="Mercedes"),
        ]

        self.assertEqual(session_recap._teammates(results), [])

    def test_a_lone_entry_for_a_team_is_not_a_pairing(self):
        results = [result_row("1", "Max", "Verstappen", team="Red Bull")]

        self.assertEqual(session_recap._teammates(results), [])


class RetirementsTests(unittest.TestCase):
    def test_lapped_and_finished_drivers_are_not_retirements(self):
        classification = session_recap._classification_facts([
            result_row("1", "Lando", "Norris", status="Finished"),
            result_row("15", "Alexander", "Albon", status="Lapped"),
            result_row("16", "Esteban", "Ocon", status="+1 Lap"),
        ])

        self.assertEqual(session_recap._retirements(classification), [])

    def test_a_genuine_retirement_is_reported_with_grid_and_position(self):
        classification = session_recap._classification_facts([
            result_row("20", "Oscar", "Piastri", team="McLaren", status="Retired", grid="3"),
        ])

        retirements = session_recap._retirements(classification)

        self.assertEqual(len(retirements), 1)
        self.assertEqual(retirements[0]["driver"], "Oscar Piastri")
        self.assertEqual(retirements[0]["grid"], "3")
        self.assertEqual(retirements[0]["position"], "20")


class BiggestMoversTests(unittest.TestCase):
    def test_ranks_by_positions_gained_and_excludes_losers(self):
        classification = session_recap._classification_facts([
            result_row("13", "Lance", "Stroll", grid="20"),
            result_row("3", "Andrea Kimi", "Antonelli", grid="7"),
            result_row("18", "Carlos", "Sainz", grid="6"),
        ])

        movers = session_recap._biggest_movers(classification)

        self.assertEqual(movers[0]["driver"], "Lance Stroll")
        self.assertEqual(movers[0]["positions_gained"], 7)
        self.assertTrue(all(m["positions_gained"] > 0 for m in movers))


class FastestLapFactsTests(unittest.TestCase):
    def test_finds_the_rank_1_fastest_lap(self):
        results = [
            {
                "position": "4",
                "Driver": {"givenName": "Charles", "familyName": "Leclerc"},
                "Constructor": {"name": "Ferrari"},
                "FastestLap": {"rank": "1", "lap": "58", "Time": {"time": "1:22.000"}},
            },
            {
                "Driver": {"givenName": "Max", "familyName": "Verstappen"},
                "FastestLap": {"rank": "2"},
            },
        ]

        facts = session_recap._fastest_lap_facts(results)

        self.assertEqual(facts["driver"], "Charles Leclerc")
        self.assertEqual(facts["time"], "1:22.000")
        self.assertEqual(facts["finishing_position"], "4")

    def test_no_fastest_lap_rank_yields_none(self):
        self.assertIsNone(session_recap._fastest_lap_facts([{"Driver": {}}]))


class BuildFactsTests(unittest.TestCase):
    def test_assembles_metadata_classification_teammates_and_race_control(self):
        race = {
            "raceName": "Hungarian Grand Prix",
            "season": 2026,
            "round": "11",
            "Circuit": {"circuitName": "Hungaroring"},
        }
        results = [
            result_row("1", "Lando", "Norris", team="McLaren", grid="1", number="1"),
            result_row("2", "Oscar", "Piastri", team="McLaren", grid="2", number="81"),
        ]
        messages = [
            {
                "message": "FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 81 (PIA) - SPEEDING",
                "lap_number": 66,
                "flag": None,
            }
        ]

        facts = session_recap.build_facts(race, results, messages)

        self.assertEqual(facts["race_name"], "Hungarian Grand Prix")
        self.assertEqual(facts["circuit"], "Hungaroring")
        self.assertEqual(len(facts["classification"]), 2)
        self.assertEqual(facts["teammates"], [{"team": "McLaren", "drivers": ["Lando Norris", "Oscar Piastri"]}])
        self.assertEqual(len(facts["race_control"]["events"]), 1)
        self.assertEqual(facts["race_control"]["events"][0]["kind"], "penalty")

    def test_builds_without_race_control_when_none_is_available(self):
        race = {"raceName": "Test GP", "Circuit": {}}
        results = [result_row("1", "Lando", "Norris")]

        facts = session_recap.build_facts(race, results, [])

        self.assertEqual(facts["race_control"]["events"], [])


class GenerateRecapTests(unittest.TestCase):
    def test_yields_nothing_when_the_api_key_is_unset(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OLLAMA_API_KEY", None)
            text = asyncio.run(_drain(session_recap._generate_recap({"race_name": "Test GP"})))

        self.assertEqual(text, "")


class SessionRecapEndpointTests(unittest.TestCase):
    async def _drain_response(self, response):
        return "".join([chunk async for chunk in response.body_iterator])

    def test_a_cache_hit_replays_stored_text_without_calling_ollama(self):
        cache = FakeCollection(find_one_result={"text": "Norris dominated."})
        fake_db = FakeDb(session_recap=cache)

        with patch.object(session_recap, "get_db", return_value=fake_db), patch.object(
            session_recap, "_generate_recap"
        ) as generate_mock:
            response = asyncio.run(session_recap.get_session_recap(year=2026, round=11))
            body = asyncio.run(self._drain_response(response))

        generate_mock.assert_not_called()
        self.assertEqual(body, "Norris dominated.")

    def test_the_cache_is_keyed_by_prompt_version(self):
        """A prompt/fact-shape change must retire old recaps rather than serve them."""
        cache = FakeCollection(find_one_result=None)
        race_results = FakeCollection(
            find_one_result={"race": {}, "results": [result_row("1", "Lando", "Norris")]}
        )
        fake_db = FakeDb(race_results=race_results, session_recap=cache)

        async def fake_generate(facts):
            yield "text"

        with patch.object(session_recap, "get_db", return_value=fake_db), patch.object(
            session_recap, "fetch_race_control", return_value=[]
        ), patch.object(session_recap, "_generate_recap", side_effect=fake_generate):
            response = asyncio.run(session_recap.get_session_recap(year=2026, round=11))
            asyncio.run(self._drain_response(response))

        written_key = cache.update_one_calls[0][0]
        self.assertEqual(written_key["prompt_version"], session_recap.PROMPT_VERSION)

    def test_no_cached_race_results_yields_an_empty_stream(self):
        fake_db = FakeDb(race_results=FakeCollection(find_one_result=None))

        with patch.object(session_recap, "get_db", return_value=fake_db):
            response = asyncio.run(session_recap.get_session_recap(year=2026, round=11))
            body = asyncio.run(self._drain_response(response))

        self.assertEqual(body, "")

    def test_a_cache_miss_streams_generated_text_and_writes_it_back(self):
        race_results = FakeCollection(
            find_one_result={
                "race": {"raceName": "Hungarian Grand Prix"},
                "results": [result_row("1", "Lando", "Norris")],
            }
        )
        cache = FakeCollection(find_one_result=None)
        fake_db = FakeDb(race_results=race_results, session_recap=cache)

        async def fake_generate(facts):
            yield "Norris "
            yield "won."

        with patch.object(session_recap, "get_db", return_value=fake_db), patch.object(
            session_recap, "fetch_race_control", return_value=[]
        ), patch.object(session_recap, "_generate_recap", side_effect=fake_generate):
            response = asyncio.run(session_recap.get_session_recap(year=2026, round=11))
            body = asyncio.run(self._drain_response(response))

        self.assertEqual(body, "Norris won.")
        self.assertEqual(cache.update_one_calls[0][1]["$set"]["text"], "Norris won.")

    def test_a_failed_generation_caches_nothing(self):
        race_results = FakeCollection(
            find_one_result={"race": {}, "results": [result_row("1", "Lando", "Norris")]}
        )
        cache = FakeCollection(find_one_result=None)
        fake_db = FakeDb(race_results=race_results, session_recap=cache)

        async def fake_generate(facts):
            return
            yield  # pragma: no cover

        with patch.object(session_recap, "get_db", return_value=fake_db), patch.object(
            session_recap, "fetch_race_control", return_value=[]
        ), patch.object(session_recap, "_generate_recap", side_effect=fake_generate):
            response = asyncio.run(session_recap.get_session_recap(year=2026, round=11))
            body = asyncio.run(self._drain_response(response))

        self.assertEqual(body, "")
        self.assertEqual(cache.update_one_calls, [])


if __name__ == "__main__":
    unittest.main()
