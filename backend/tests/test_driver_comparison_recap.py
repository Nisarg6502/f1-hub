import asyncio
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# driver_comparison_recap imports motor (via db.py) at module scope; these
# tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import driver_comparison_recap as dcr


class FakeCursor:
    def __init__(self, docs):
        self._docs = docs

    async def to_list(self, length=100):
        return self._docs


class FakeCollection:
    def __init__(self, find_one_result=None, find_result=None):
        self._find_one_result = find_one_result
        self._find_result = find_result or []
        self.update_one_calls = []

    async def find_one(self, query=None, *args, **kwargs):
        return self._find_one_result

    def find(self, query=None, *args, **kwargs):
        return FakeCursor(self._find_result)

    async def update_one(self, query, update, upsert=False):
        self.update_one_calls.append((query, update, upsert))


class FakeDb:
    def __init__(self, race_results=None, qualifying_results=None,
                 driver_standings=None, driver_comparison_recap=None):
        self.race_results = race_results or FakeCollection(find_result=[])
        self.qualifying_results = qualifying_results or FakeCollection(find_result=[])
        self.driver_standings = driver_standings or FakeCollection(find_one_result=None)
        self.driver_comparison_recap = driver_comparison_recap or FakeCollection()


def result_row(position, driver_id, given_name, family_name, team="Red Bull", **extra):
    row = {
        "position": position,
        "Driver": {"driverId": driver_id, "givenName": given_name, "familyName": family_name},
        "Constructor": {"name": team},
    }
    row.update(extra)
    return row


async def _drain(stream):
    return "".join([chunk async for chunk in stream])


class LapSecondsTests(unittest.TestCase):
    def test_parses_minutes_and_seconds(self):
        self.assertEqual(dcr._lap_seconds("1:17.207"), 77.207)

    def test_parses_bare_seconds(self):
        self.assertEqual(dcr._lap_seconds("58.212"), 58.212)

    def test_blank_and_junk_yield_none(self):
        self.assertIsNone(dcr._lap_seconds(""))
        self.assertIsNone(dcr._lap_seconds(None))
        self.assertIsNone(dcr._lap_seconds("not-a-time"))


class BestCommonQualiTimeTests(unittest.TestCase):
    def test_prefers_q3_when_both_reached_it(self):
        a = {"Q1": "1:20.000", "Q2": "1:19.000", "Q3": "1:18.000"}
        b = {"Q1": "1:20.500", "Q2": "1:19.500", "Q3": "1:18.500"}

        common = dcr._best_common_quali_time(a, b)

        self.assertEqual(common["segment"], "Q3")
        self.assertEqual(common["seconds_driver1"], 78.0)
        self.assertEqual(common["seconds_driver2"], 78.5)

    def test_falls_back_to_the_last_segment_both_reached(self):
        # a was eliminated in Q1, b reached Q3 -- only Q1 is common.
        a = {"Q1": "1:20.000"}
        b = {"Q1": "1:20.500", "Q2": "1:19.500", "Q3": "1:18.500"}

        common = dcr._best_common_quali_time(a, b)

        self.assertEqual(common["segment"], "Q1")

    def test_no_shared_segment_yields_none(self):
        self.assertIsNone(dcr._best_common_quali_time({}, {"Q1": "1:20.000"}))


class BuildHeadToHeadTests(unittest.TestCase):
    def test_counts_race_finishes_ahead_for_each_driver(self):
        rounds = [
            {
                "round": "1",
                "raceName": "Race 1",
                "results": [
                    result_row("1", "verstappen", "Max", "Verstappen"),
                    result_row("2", "norris", "Lando", "Norris"),
                ],
                "qualifying": [],
            },
            {
                "round": "2",
                "raceName": "Race 2",
                "results": [
                    result_row("3", "verstappen", "Max", "Verstappen"),
                    result_row("1", "norris", "Lando", "Norris"),
                ],
                "qualifying": [],
            },
        ]

        h2h = dcr.build_head_to_head(rounds, "verstappen", "norris")

        self.assertEqual(h2h["race_common_count"], 2)
        self.assertEqual(h2h["race_ahead_driver1"], 1)
        self.assertEqual(h2h["race_ahead_driver2"], 1)

    def test_a_round_where_only_one_driver_is_classified_is_not_counted(self):
        rounds = [
            {
                "round": "1",
                "raceName": "Race 1",
                "results": [result_row("1", "verstappen", "Max", "Verstappen")],
                "qualifying": [],
            },
        ]

        h2h = dcr.build_head_to_head(rounds, "verstappen", "norris")

        self.assertEqual(h2h["race_common_count"], 0)

    def test_counts_qualifying_pace_and_averages_the_gap(self):
        rounds = [
            {
                "round": "1",
                "raceName": "Race 1",
                "results": [],
                "qualifying": [
                    {"Driver": {"driverId": "verstappen"}, "Q1": "1:20.000", "Q2": "1:19.000", "Q3": "1:18.000"},
                    {"Driver": {"driverId": "norris"}, "Q1": "1:20.500", "Q2": "1:19.500", "Q3": "1:18.500"},
                ],
            },
        ]

        h2h = dcr.build_head_to_head(rounds, "verstappen", "norris")

        self.assertEqual(h2h["quali_common_count"], 1)
        self.assertEqual(h2h["quali_ahead_driver1"], 1)
        self.assertEqual(h2h["quali_ahead_driver2"], 0)
        self.assertAlmostEqual(h2h["avg_quali_gap_seconds_driver1_minus_driver2"], -0.5)

    def test_no_shared_rounds_yields_zero_counts_and_no_average(self):
        h2h = dcr.build_head_to_head([], "verstappen", "norris")

        self.assertEqual(h2h["race_common_count"], 0)
        self.assertEqual(h2h["quali_common_count"], 0)
        self.assertIsNone(h2h["avg_quali_gap_seconds_driver1_minus_driver2"])


class StandingFactsTests(unittest.TestCase):
    def test_extracts_position_points_wins_team(self):
        standings = [
            {
                "position": "1",
                "points": "310",
                "wins": "8",
                "Driver": {"driverId": "verstappen"},
                "Constructors": [{"name": "Red Bull"}],
            }
        ]

        facts = dcr._standing_facts(standings, "verstappen")

        self.assertEqual(facts, {"position": "1", "points": "310", "wins": "8", "team": "Red Bull"})

    def test_a_driver_absent_from_standings_yields_none(self):
        self.assertIsNone(dcr._standing_facts([], "verstappen"))


class BuildFactsTests(unittest.TestCase):
    def test_assembles_driver_identity_standings_and_head_to_head(self):
        standings = [
            {"position": "1", "points": "310", "wins": "8",
             "Driver": {"driverId": "verstappen", "givenName": "Max", "familyName": "Verstappen"},
             "Constructors": [{"name": "Red Bull"}]},
            {"position": "2", "points": "280", "wins": "5",
             "Driver": {"driverId": "norris", "givenName": "Lando", "familyName": "Norris"},
             "Constructors": [{"name": "McLaren"}]},
        ]
        rounds = [
            {
                "round": "1",
                "raceName": "Race 1",
                "results": [
                    result_row("1", "verstappen", "Max", "Verstappen"),
                    result_row("2", "norris", "Lando", "Norris"),
                ],
                "qualifying": [],
            },
        ]

        facts = dcr.build_facts(2026, "verstappen", "norris", standings, rounds)

        self.assertEqual(facts["driver1"]["name"], "Max Verstappen")
        self.assertEqual(facts["driver1"]["standing"]["position"], "1")
        self.assertEqual(facts["driver2"]["name"], "Lando Norris")
        self.assertEqual(facts["race_head_to_head"]["shared_rounds"], 1)
        self.assertEqual(facts["race_head_to_head"]["driver1_finished_ahead_count"], 1)

    def test_falls_back_to_a_round_result_for_the_display_name_when_standings_miss(self):
        rounds = [
            {
                "round": "1",
                "raceName": "Race 1",
                "results": [result_row("1", "verstappen", "Max", "Verstappen")],
                "qualifying": [],
            },
        ]

        facts = dcr.build_facts(2026, "verstappen", "norris", [], rounds)

        self.assertEqual(facts["driver1"]["name"], "Max Verstappen")
        self.assertIsNone(facts["driver1"]["standing"])
        # driver2 appears nowhere at all -- falls all the way back to its id.
        self.assertEqual(facts["driver2"]["name"], "norris")


class GenerateRecapTests(unittest.TestCase):
    def test_yields_nothing_when_the_api_key_is_unset(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OLLAMA_API_KEY", None)
            text = asyncio.run(_drain(dcr._generate_recap({"season": 2026})))

        self.assertEqual(text, "")


class DriverComparisonRecapEndpointTests(unittest.TestCase):
    async def _drain_response(self, response):
        return "".join([chunk async for chunk in response.body_iterator])

    def test_identical_drivers_yield_an_empty_stream(self):
        fake_db = FakeDb()

        with patch.object(dcr, "get_db", return_value=fake_db):
            response = asyncio.run(
                dcr.get_driver_comparison_recap(year=2026, driver1="norris", driver2="norris")
            )
            body = asyncio.run(self._drain_response(response))

        self.assertEqual(body, "")

    def test_no_shared_race_rounds_yields_an_empty_stream(self):
        fake_db = FakeDb(
            race_results=FakeCollection(find_result=[
                {"round": "1", "race": {"raceName": "Race 1"},
                 "results": [result_row("1", "verstappen", "Max", "Verstappen")]},
            ]),
        )

        with patch.object(dcr, "get_db", return_value=fake_db):
            response = asyncio.run(
                dcr.get_driver_comparison_recap(year=2026, driver1="verstappen", driver2="norris")
            )
            body = asyncio.run(self._drain_response(response))

        self.assertEqual(body, "")

    def test_driver_order_is_canonicalised_so_either_order_hits_the_same_cache_row(self):
        cache = FakeCollection(find_one_result={"text": "cached narrative"})
        fake_db = FakeDb(
            race_results=FakeCollection(find_result=[
                {"round": "1", "race": {"raceName": "Race 1"}, "results": [
                    result_row("1", "verstappen", "Max", "Verstappen"),
                    result_row("2", "norris", "Lando", "Norris"),
                ]},
            ]),
            driver_comparison_recap=cache,
        )

        with patch.object(dcr, "get_db", return_value=fake_db):
            response_ab = asyncio.run(
                dcr.get_driver_comparison_recap(year=2026, driver1="norris", driver2="verstappen")
            )
            body_ab = asyncio.run(self._drain_response(response_ab))
            response_ba = asyncio.run(
                dcr.get_driver_comparison_recap(year=2026, driver1="verstappen", driver2="norris")
            )
            body_ba = asyncio.run(self._drain_response(response_ba))

        self.assertEqual(body_ab, "cached narrative")
        self.assertEqual(body_ba, "cached narrative")

    def test_a_cache_hit_replays_stored_text_without_calling_ollama(self):
        cache = FakeCollection(find_one_result={"text": "Verstappen leads on race pace."})
        fake_db = FakeDb(
            race_results=FakeCollection(find_result=[
                {"round": "1", "race": {"raceName": "Race 1"}, "results": [
                    result_row("1", "verstappen", "Max", "Verstappen"),
                    result_row("2", "norris", "Lando", "Norris"),
                ]},
            ]),
            driver_comparison_recap=cache,
        )

        with patch.object(dcr, "get_db", return_value=fake_db), patch.object(
            dcr, "_generate_recap"
        ) as generate_mock:
            response = asyncio.run(
                dcr.get_driver_comparison_recap(year=2026, driver1="verstappen", driver2="norris")
            )
            body = asyncio.run(self._drain_response(response))

        generate_mock.assert_not_called()
        self.assertEqual(body, "Verstappen leads on race pace.")

    def test_a_cache_miss_streams_generated_text_and_writes_it_back_keyed_by_rounds_compared(self):
        cache = FakeCollection(find_one_result=None)
        fake_db = FakeDb(
            race_results=FakeCollection(find_result=[
                {"round": "1", "race": {"raceName": "Race 1"}, "results": [
                    result_row("1", "verstappen", "Max", "Verstappen"),
                    result_row("2", "norris", "Lando", "Norris"),
                ]},
            ]),
            driver_comparison_recap=cache,
        )

        async def fake_generate(facts, system_prompt=None):
            yield "Verstappen "
            yield "leads."

        with patch.object(dcr, "get_db", return_value=fake_db), patch.object(
            dcr, "_generate_recap", side_effect=fake_generate
        ):
            response = asyncio.run(
                dcr.get_driver_comparison_recap(year=2026, driver1="verstappen", driver2="norris")
            )
            body = asyncio.run(self._drain_response(response))

        self.assertEqual(body, "Verstappen leads.")
        written_key, written_update, _ = cache.update_one_calls[0]
        self.assertEqual(written_key["rounds_compared"], 1)
        self.assertEqual(written_key["driver1"], "norris")
        self.assertEqual(written_key["driver2"], "verstappen")
        self.assertEqual(written_update["$set"]["text"], "Verstappen leads.")

    def test_a_failed_generation_caches_nothing(self):
        cache = FakeCollection(find_one_result=None)
        fake_db = FakeDb(
            race_results=FakeCollection(find_result=[
                {"round": "1", "race": {"raceName": "Race 1"}, "results": [
                    result_row("1", "verstappen", "Max", "Verstappen"),
                    result_row("2", "norris", "Lando", "Norris"),
                ]},
            ]),
            driver_comparison_recap=cache,
        )

        async def fake_generate(facts, system_prompt=None):
            return
            yield  # pragma: no cover

        with patch.object(dcr, "get_db", return_value=fake_db), patch.object(
            dcr, "_generate_recap", side_effect=fake_generate
        ):
            response = asyncio.run(
                dcr.get_driver_comparison_recap(year=2026, driver1="verstappen", driver2="norris")
            )
            body = asyncio.run(self._drain_response(response))

        self.assertEqual(body, "")
        self.assertEqual(cache.update_one_calls, [])


if __name__ == "__main__":
    unittest.main()
