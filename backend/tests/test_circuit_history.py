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


class FakeCollection:
    """Minimal stand-in for a Motor collection: one `find_one` result, and
    `update_one` calls recorded for assertions rather than actually stored."""

    def __init__(self, find_one_result=None):
        self._find_one_result = find_one_result
        self.update_one_calls = []

    async def find_one(self, query=None, *args, **kwargs):
        return self._find_one_result

    async def update_one(self, query, update, upsert=False):
        self.update_one_calls.append((query, update, upsert))


class FakeDb:
    def __init__(self, races=None, circuit_history_cache=None):
        self.races = races or FakeCollection()
        self.circuit_history_cache = circuit_history_cache or FakeCollection()


def ergast_race(season, round_, position, given_name, family_name, time=""):
    return {
        "season": season,
        "round": round_,
        "Results": [
            {
                "position": position,
                "Driver": {"givenName": given_name, "familyName": family_name},
                "Time": {"time": time},
            }
        ],
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
        races = [{"season": "2023"}, {"season": "1950"}, {"season": "2026"}]
        self.assertEqual(circuit_history.first_year_raced(races), 1950)

    def test_no_races_yields_none(self):
        self.assertIsNone(circuit_history.first_year_raced([]))

    def test_ignores_malformed_season_values(self):
        races = [{"season": None}, {"season": "not-a-year"}]
        self.assertIsNone(circuit_history.first_year_raced(races))


class MostWinsTests(unittest.TestCase):
    def test_tallies_wins_by_driver_and_reports_the_top_one(self):
        races = [
            ergast_race("2022", "10", "1", "Max", "Verstappen"),
            ergast_race("2023", "10", "1", "Max", "Verstappen"),
            ergast_race("2024", "10", "1", "Lewis", "Hamilton"),
        ]

        result = circuit_history.most_wins(races)

        self.assertEqual(result, {"driver": "Max Verstappen", "wins": 2})

    def test_ties_report_whichever_driver_was_tallied_first(self):
        races = [
            ergast_race("2022", "10", "1", "Lewis", "Hamilton"),
            ergast_race("2023", "10", "1", "Max", "Verstappen"),
        ]

        result = circuit_history.most_wins(races)

        self.assertEqual(result, {"driver": "Lewis Hamilton", "wins": 1})

    def test_races_missing_a_p1_result_are_skipped(self):
        races = [{"season": "2022", "round": "10", "Results": []}]

        self.assertIsNone(circuit_history.most_wins(races))

    def test_no_races_yields_none(self):
        self.assertIsNone(circuit_history.most_wins([]))


class ClosestFinishTests(unittest.TestCase):
    def test_reports_the_smallest_valid_gap(self):
        races = [
            ergast_race("2022", "10", "2", "Lewis", "Hamilton", "+5.636"),
            ergast_race("2023", "10", "2", "Sergio", "Perez", "+0.088"),
        ]

        result = circuit_history.closest_finish(races)

        self.assertEqual(result["season"], 2023)
        self.assertEqual(result["round"], "10")
        self.assertAlmostEqual(result["gap_seconds"], 0.088)

    def test_skips_races_with_a_non_numeric_gap(self):
        races = [ergast_race("2021", "5", "2", "Lewis", "Hamilton", "+1 Lap")]

        self.assertIsNone(circuit_history.closest_finish(races))

    def test_skips_races_missing_a_p2_result(self):
        races = [{"season": "2021", "round": "5", "Results": []}]

        self.assertIsNone(circuit_history.closest_finish(races))

    def test_no_races_yields_none(self):
        self.assertIsNone(circuit_history.closest_finish([]))


class CircuitHistoryEndpointTests(unittest.TestCase):
    def _fake_fetch_all_races(self, winner_races, runner_up_races):
        async def fake(path: str, *args, **kwargs):
            if "/results/1/" in path:
                return winner_races
            if "/results/2/" in path:
                return runner_up_races
            raise AssertionError(f"unexpected path: {path}")

        return fake

    def test_resolves_circuit_id_and_aggregates_full_ergast_history(self):
        races = FakeCollection(find_one_result={"Circuit": {"circuitId": "silverstone"}})
        cache = FakeCollection(find_one_result=None)
        fake_db = FakeDb(races=races, circuit_history_cache=cache)

        winner_races = [
            ergast_race("1950", "1", "1", "Nino", "Farina"),
            ergast_race("2024", "12", "1", "Lewis", "Hamilton"),
        ]
        runner_up_races = [ergast_race("2024", "12", "2", "Max", "Verstappen", "+0.500")]

        with patch.object(circuit_history, "get_db", return_value=fake_db), patch.object(
            circuit_history,
            "_fetch_all_races",
            side_effect=self._fake_fetch_all_races(winner_races, runner_up_races),
        ):
            response = asyncio.run(
                circuit_history.get_circuit_history(circuit_name="Silverstone Circuit")
            )

        body = json.loads(response.body)
        self.assertEqual(body["circuit_name"], "Silverstone Circuit")
        self.assertEqual(body["first_year"], 1950)
        self.assertEqual(body["most_wins"], {"driver": "Nino Farina", "wins": 1})
        self.assertAlmostEqual(body["closest_finish"]["gap_seconds"], 0.5)

        # Looked up circuitId by circuit name, not scoped to any one season.
        self.assertEqual(races.update_one_calls, [])
        # Result got written back to the cache collection.
        self.assertEqual(len(cache.update_one_calls), 1)

    def test_a_circuit_never_synced_at_all_omits_every_field(self):
        races = FakeCollection(find_one_result=None)
        fake_db = FakeDb(races=races)

        with patch.object(circuit_history, "get_db", return_value=fake_db):
            response = asyncio.run(
                circuit_history.get_circuit_history(circuit_name="Brand New Street Circuit")
            )

        body = json.loads(response.body)
        self.assertEqual(body, {"circuit_name": "Brand New Street Circuit"})

    def test_a_fresh_cache_entry_is_served_without_hitting_ergast(self):
        cache = FakeCollection(
            find_one_result={
                "circuit_name": "Silverstone Circuit",
                "first_year": 1950,
                "synced_at": circuit_history._utcnow_iso(),
            }
        )
        fake_db = FakeDb(circuit_history_cache=cache)

        with patch.object(circuit_history, "get_db", return_value=fake_db), patch.object(
            circuit_history, "_fetch_all_races"
        ) as fetch_mock:
            response = asyncio.run(
                circuit_history.get_circuit_history(circuit_name="Silverstone Circuit")
            )

        fetch_mock.assert_not_called()
        body = json.loads(response.body)
        self.assertEqual(body["first_year"], 1950)
        self.assertNotIn("synced_at", body)

    def test_a_stale_cache_entry_triggers_a_refetch(self):
        import datetime

        stale_time = (
            datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=48)
        ).isoformat()
        cache = FakeCollection(
            find_one_result={
                "circuit_name": "Silverstone Circuit",
                "first_year": 1950,
                "synced_at": stale_time,
            }
        )
        races = FakeCollection(find_one_result={"Circuit": {"circuitId": "silverstone"}})
        fake_db = FakeDb(races=races, circuit_history_cache=cache)

        with patch.object(circuit_history, "get_db", return_value=fake_db), patch.object(
            circuit_history,
            "_fetch_all_races",
            side_effect=self._fake_fetch_all_races([], []),
        ) as fetch_mock:
            asyncio.run(circuit_history.get_circuit_history(circuit_name="Silverstone Circuit"))

        fetch_mock.assert_called()


if __name__ == "__main__":
    unittest.main()
