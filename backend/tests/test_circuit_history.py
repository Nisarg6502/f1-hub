import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# circuit_history imports motor (via db.py) at module scope; these tests never
# touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import circuit_history


class FakeCursor:
    def __init__(self, docs):
        self.docs = docs

    async def to_list(self, length=None):
        return list(self.docs)


class FakeCollection:
    def __init__(self, docs=None):
        self.docs = docs if docs is not None else []
        self.queries = []

    def find(self, query=None, *args, **kwargs):
        self.queries.append(query)
        return FakeCursor(self.docs)


class FakeDb:
    def __init__(self, races=None, race_results=None):
        self.races = races or FakeCollection()
        self.race_results = race_results or FakeCollection()


def result_row(position, given_name, family_name, time=""):
    return {
        "position": position,
        "Driver": {"givenName": given_name, "familyName": family_name},
        "Time": {"time": time},
    }


class ParseGapSecondsTests(unittest.TestCase):
    def test_parses_a_plain_seconds_gap(self):
        self.assertAlmostEqual(circuit_history.parse_gap_seconds("+1.234"), 1.234)

    def test_parses_a_minutes_seconds_gap(self):
        self.assertAlmostEqual(circuit_history.parse_gap_seconds("+1:02.345"), 62.345)

    def test_rejects_a_lapped_finisher(self):
        self.assertIsNone(circuit_history.parse_gap_seconds("+1 Lap"))
        self.assertIsNone(circuit_history.parse_gap_seconds("+2 Laps"))

    def test_rejects_empty_or_missing(self):
        self.assertIsNone(circuit_history.parse_gap_seconds(""))
        self.assertIsNone(circuit_history.parse_gap_seconds(None))

    def test_rejects_garbage(self):
        self.assertIsNone(circuit_history.parse_gap_seconds("DNF"))


class FirstYearRacedTests(unittest.TestCase):
    def test_returns_the_earliest_season(self):
        races = [{"season": 2023}, {"season": 2019}, {"season": 2026}]
        self.assertEqual(circuit_history.first_year_raced(races), 2019)

    def test_no_races_yields_none(self):
        self.assertIsNone(circuit_history.first_year_raced([]))

    def test_ignores_malformed_season_values(self):
        races = [{"season": None}, {"season": "2019"}]
        # "2019" (a string) is not counted; only real ints qualify.
        self.assertIsNone(circuit_history.first_year_raced(races))


class MostWinsTests(unittest.TestCase):
    def test_tallies_wins_by_driver_and_reports_the_top_one(self):
        docs = [
            {"results": [result_row("1", "Max", "Verstappen")]},
            {"results": [result_row("1", "Max", "Verstappen")]},
            {"results": [result_row("1", "Lewis", "Hamilton")]},
        ]

        result = circuit_history.most_wins(docs)

        self.assertEqual(result, {"driver": "Max Verstappen", "wins": 2})

    def test_ties_report_whichever_driver_was_tallied_first(self):
        docs = [
            {"results": [result_row("1", "Lewis", "Hamilton")]},
            {"results": [result_row("1", "Max", "Verstappen")]},
        ]

        result = circuit_history.most_wins(docs)

        self.assertEqual(result, {"driver": "Lewis Hamilton", "wins": 1})

    def test_docs_with_no_winner_are_skipped(self):
        docs = [{"results": []}, {"results": [result_row("2", "Max", "Verstappen")]}]

        self.assertIsNone(circuit_history.most_wins(docs))

    def test_no_docs_yields_none(self):
        self.assertIsNone(circuit_history.most_wins([]))


class ClosestFinishTests(unittest.TestCase):
    def test_reports_the_smallest_valid_gap(self):
        docs = [
            {
                "season": 2022,
                "round": "10",
                "results": [
                    result_row("1", "Max", "Verstappen"),
                    result_row("2", "Lewis", "Hamilton", "+5.636"),
                ],
            },
            {
                "season": 2023,
                "round": "10",
                "results": [
                    result_row("1", "Max", "Verstappen"),
                    result_row("2", "Sergio", "Perez", "+0.088"),
                ],
            },
        ]

        result = circuit_history.closest_finish(docs)

        self.assertEqual(result["season"], 2023)
        self.assertEqual(result["round"], "10")
        self.assertAlmostEqual(result["gap_seconds"], 0.088)

    def test_skips_docs_with_a_non_numeric_gap(self):
        docs = [
            {
                "season": 2021,
                "round": "5",
                "results": [
                    result_row("1", "Max", "Verstappen"),
                    result_row("2", "Lewis", "Hamilton", "+1 Lap"),
                ],
            },
        ]

        self.assertIsNone(circuit_history.closest_finish(docs))

    def test_skips_docs_missing_p1_or_p2(self):
        docs = [{"season": 2021, "round": "5", "results": [result_row("1", "Max", "Verstappen")]}]

        self.assertIsNone(circuit_history.closest_finish(docs))

    def test_no_docs_yields_none(self):
        self.assertIsNone(circuit_history.closest_finish([]))


class CircuitHistoryEndpointTests(unittest.TestCase):
    def test_aggregates_across_matching_races_and_results(self):
        races = FakeCollection([
            {"season": 2022, "round": "10"},
            {"season": 2023, "round": "10"},
        ])
        race_results = FakeCollection([
            {
                "season": 2022,
                "round": "10",
                "results": [
                    result_row("1", "Max", "Verstappen"),
                    result_row("2", "Lewis", "Hamilton", "+5.636"),
                ],
            },
            {
                "season": 2023,
                "round": "10",
                "results": [
                    result_row("1", "Max", "Verstappen"),
                    result_row("2", "Sergio", "Perez", "+0.088"),
                ],
            },
        ])
        fake_db = FakeDb(races=races, race_results=race_results)

        with patch.object(circuit_history, "get_db", return_value=fake_db):
            response = asyncio.run(
                circuit_history.get_circuit_history(circuit_name="Silverstone Circuit")
            )

        body = json.loads(response.body)
        self.assertEqual(body["circuit_name"], "Silverstone Circuit")
        self.assertEqual(body["first_year"], 2022)
        self.assertEqual(body["most_wins"], {"driver": "Max Verstappen", "wins": 2})
        self.assertEqual(body["closest_finish"]["season"], 2023)
        self.assertAlmostEqual(body["closest_finish"]["gap_seconds"], 0.088)

        # Queried races by circuit name, not by any particular season.
        self.assertEqual(
            races.queries[0], {"Circuit.circuitName": "Silverstone Circuit"}
        )

    def test_a_circuit_with_no_cached_races_omits_every_field(self):
        fake_db = FakeDb(races=FakeCollection([]), race_results=FakeCollection([]))

        with patch.object(circuit_history, "get_db", return_value=fake_db):
            response = asyncio.run(
                circuit_history.get_circuit_history(circuit_name="Brand New Street Circuit")
            )

        body = json.loads(response.body)
        self.assertEqual(body, {"circuit_name": "Brand New Street Circuit"})

    def test_races_cached_but_no_race_results_yet_omits_wins_and_closest_finish(self):
        races = FakeCollection([{"season": 2019, "round": "1"}])
        fake_db = FakeDb(races=races, race_results=FakeCollection([]))

        with patch.object(circuit_history, "get_db", return_value=fake_db):
            response = asyncio.run(
                circuit_history.get_circuit_history(circuit_name="Some Circuit")
            )

        body = json.loads(response.body)
        self.assertEqual(body["first_year"], 2019)
        self.assertNotIn("most_wins", body)
        self.assertNotIn("closest_finish", body)


if __name__ == "__main__":
    unittest.main()
