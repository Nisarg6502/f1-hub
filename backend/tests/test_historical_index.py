import asyncio
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# historical_index imports motor (via db.py) at module scope; these tests
# never touch Mongo, same stub pattern as test_circuit_history.py.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import historical_index


def ergast_winner_race(season, round_, race_name, circuit_id, constructor_id, constructor_name,
                        given_name, family_name, date="2024-01-01"):
    return {
        "season": season,
        "round": round_,
        "date": date,
        "raceName": race_name,
        "Circuit": {"circuitId": circuit_id},
        "Results": [
            {
                "position": "1",
                "Driver": {"givenName": given_name, "familyName": family_name},
                "Constructor": {"constructorId": constructor_id, "name": constructor_name},
            }
        ],
    }


class FakeCursor:
    """Minimal stand-in for a Motor cursor: supports the .sort().to_list()
    chain used by get_historical_race_index, backed by a plain list."""

    def __init__(self, items):
        self._items = items

    def sort(self, *args, **kwargs):
        return self

    async def to_list(self, length=None):
        return list(self._items)


class FakeCollection:
    def __init__(self, find_result=None, find_one_result=None):
        self._find_result = find_result or []
        self._find_one_result = find_one_result
        self.insert_many_calls = []
        self.update_one_calls = []

    def find(self, *args, **kwargs):
        return FakeCursor(self._find_result)

    async def find_one(self, query=None, *args, **kwargs):
        return self._find_one_result

    async def insert_many(self, docs, ordered=False):
        self.insert_many_calls.append(list(docs))

    async def update_one(self, query, update, upsert=False):
        self.update_one_calls.append((query, update, upsert))


class FakeDb:
    def __init__(self, historical_race_index=None, constructor_seasons_cache=None):
        self.historical_race_index = historical_race_index or FakeCollection()
        self.constructor_seasons_cache = constructor_seasons_cache or FakeCollection()


# --- Defect 1: shared-drive races carry two P1 rows -------------------------


class SharedDriveDedupTests(unittest.TestCase):
    def test_a_race_with_two_p1_rows_produces_one_record(self):
        raw = [
            {
                "season": "1951",
                "round": "4",
                "date": "1951-07-01",
                "raceName": "French Grand Prix",
                "Circuit": {"circuitId": "reims"},
                "Results": [
                    {
                        "position": "1",
                        "Driver": {"givenName": "Juan Manuel", "familyName": "Fangio"},
                        "Constructor": {"constructorId": "alfa", "name": "Alfa Romeo"},
                    },
                ],
            },
            # A second, separately-listed P1 result for the same race (Ergast
            # actually returns this as one race with two Results entries, but
            # the endpoint pattern iterates races so this models the same
            # (season, round) key appearing twice, which is the real shape
            # `_fetch_all_winner_races` can produce across pages).
            {
                "season": "1951",
                "round": "4",
                "date": "1951-07-01",
                "raceName": "French Grand Prix",
                "Circuit": {"circuitId": "reims"},
                "Results": [
                    {
                        "position": "1",
                        "Driver": {"givenName": "Luigi", "familyName": "Fagioli"},
                        "Constructor": {"constructorId": "alfa", "name": "Alfa Romeo"},
                    },
                ],
            },
        ]

        records = historical_index.normalize_races(raw)

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["driver"], "Juan Manuel Fangio")

    def test_ergast_total_overcounts_but_pagination_is_by_limit_not_page_length(self):
        # Regression guard for the exact bug this batch found live: total
        # counts result rows (can be > race count), so offset must advance
        # by page_size, not len(page), or races silently get skipped.
        limit, total = historical_index._pagination_from(
            {"MRData": {"limit": "100", "total": "1163"}}
        )
        self.assertEqual((limit, total), (100, 1163))


# --- Defect 2: `alfa` spans three unrelated eras ----------------------------


class AlfaEraSplitTests(unittest.TestCase):
    def test_1950s_works_team_gets_its_own_key(self):
        self.assertEqual(historical_index.canonical_key("alfa", 1950), "alfa_1950s")
        self.assertEqual(historical_index.canonical_key("alfa", 1951), "alfa_1950s")

    def test_1980s_works_team_gets_a_different_key(self):
        self.assertEqual(historical_index.canonical_key("alfa", 1979), "alfa_1980s")
        self.assertEqual(historical_index.canonical_key("alfa", 1985), "alfa_1980s")

    def test_rebadged_sauber_era_gets_a_third_key(self):
        self.assertEqual(historical_index.canonical_key("alfa", 2019), "alfa_sauber")
        self.assertEqual(historical_index.canonical_key("alfa", 2023), "alfa_sauber")

    def test_the_three_eras_are_never_equal(self):
        keys = {
            historical_index.canonical_key("alfa", 1951),
            historical_index.canonical_key("alfa", 1980),
            historical_index.canonical_key("alfa", 2020),
        }
        self.assertEqual(len(keys), 3)


# --- Defect 3: chassis/engine-era constructor ids collapse ------------------


class ChassisEngineNormalizationTests(unittest.TestCase):
    def test_all_classic_lotus_variants_collapse_to_one_key(self):
        variants = ["team_lotus", "lotus-climax", "lotus-ford", "lotus-brm"]
        keys = {historical_index.canonical_key(v) for v in variants}
        self.assertEqual(keys, {"lotus"})

    def test_lotus_f1_team_is_not_folded_into_classic_lotus(self):
        # `lotus_f1` (2012-15) is the renamed Renault-descended team, not a
        # continuation of the 1958-94 Team Lotus, despite the similar name —
        # a real trap found during live-data verification of this batch.
        self.assertNotEqual(historical_index.canonical_key("lotus_f1"), "lotus")
        self.assertEqual(historical_index.canonical_key("lotus_f1"), "lotus_f1")

    def test_all_brabham_variants_collapse_to_one_key(self):
        variants = ["brabham", "brabham-climax", "brabham-ford", "brabham-repco"]
        keys = {historical_index.canonical_key(v) for v in variants}
        self.assertEqual(keys, {"brabham"})

    def test_all_cooper_variants_collapse_to_one_key(self):
        variants = ["cooper", "cooper-climax", "cooper-maserati"]
        keys = {historical_index.canonical_key(v) for v in variants}
        self.assertEqual(keys, {"cooper"})

    def test_mclaren_ford_collapses_into_mclaren(self):
        self.assertEqual(historical_index.canonical_key("mclaren-ford"), "mclaren")
        self.assertEqual(historical_index.canonical_key("mclaren"), "mclaren")

    def test_unrelated_ids_pass_through_unchanged(self):
        self.assertEqual(historical_index.canonical_key("ferrari"), "ferrari")
        self.assertEqual(historical_index.canonical_key("red_bull"), "red_bull")

    def test_lotus_variants_produce_one_colour_across_the_1960s(self):
        raw = [
            ergast_winner_race(1962, 1, "Race A", "spa", "team_lotus", "Team Lotus", "Jim", "Clark"),
            ergast_winner_race(1963, 1, "Race B", "spa", "lotus-climax", "Lotus-Climax", "Jim", "Clark"),
            ergast_winner_race(1966, 1, "Race C", "spa", "lotus-brm", "Lotus-BRM", "Jim", "Clark"),
        ]

        records = historical_index.normalize_races(raw)

        self.assertEqual({r["constructor_key"] for r in records}, {"lotus"})
        self.assertEqual({r["constructor_name"] for r in records}, {"Lotus"})


# --- Defect 4: the 1950-60 Indy 500 counted for the championship -----------


class Indy500FlagTests(unittest.TestCase):
    def test_indianapolis_500_is_flagged(self):
        raw = [
            ergast_winner_race(1952, 1, "Indianapolis 500", "indianapolis", "kurtis_kraft", "Kurtis Kraft",
                                "Troy", "Ruttman"),
        ]
        records = historical_index.normalize_races(raw)
        self.assertTrue(records[0]["indy500"])

    def test_the_2000s_us_grand_prix_at_the_same_circuit_is_not_flagged(self):
        raw = [
            ergast_winner_race(2003, 14, "United States Grand Prix", "indianapolis", "ferrari", "Ferrari",
                                "Michael", "Schumacher"),
        ]
        records = historical_index.normalize_races(raw)
        self.assertFalse(records[0]["indy500"])

    def test_an_ordinary_grand_prix_elsewhere_is_not_flagged(self):
        raw = [
            ergast_winner_race(2023, 1, "Bahrain Grand Prix", "bahrain", "red_bull", "Red Bull",
                                "Max", "Verstappen"),
        ]
        records = historical_index.normalize_races(raw)
        self.assertFalse(records[0]["indy500"])


# --- normalize_races: general shape / robustness ----------------------------


class NormalizeRacesRobustnessTests(unittest.TestCase):
    def test_races_missing_a_p1_result_are_skipped(self):
        raw = [{"season": "2022", "round": "1", "Results": []}]
        self.assertEqual(historical_index.normalize_races(raw), [])

    def test_malformed_season_or_round_is_skipped(self):
        raw = [
            ergast_winner_race("not-a-year", 1, "Race", "spa", "ferrari", "Ferrari", "A", "B"),
        ]
        self.assertEqual(historical_index.normalize_races(raw), [])

    def test_results_are_sorted_by_season_then_round(self):
        raw = [
            ergast_winner_race(2024, 3, "Race C", "spa", "ferrari", "Ferrari", "A", "B"),
            ergast_winner_race(1950, 1, "Race A", "silverstone", "alfa", "Alfa Romeo", "Nino", "Farina"),
            ergast_winner_race(2024, 1, "Race B", "bahrain", "red_bull", "Red Bull", "Max", "Verstappen"),
        ]
        records = historical_index.normalize_races(raw)
        self.assertEqual(
            [(r["season"], r["round"]) for r in records],
            [(1950, 1), (2024, 1), (2024, 3)],
        )

    def test_missing_constructor_id_is_skipped_rather_than_raising(self):
        raw = [
            {
                "season": "2022",
                "round": "1",
                "raceName": "Race",
                "Circuit": {"circuitId": "spa"},
                "Results": [{"position": "1", "Driver": {"givenName": "A", "familyName": "B"}, "Constructor": {}}],
            }
        ]
        self.assertEqual(historical_index.normalize_races(raw), [])


# --- Endpoint self-heal ------------------------------------------------------


class HistoricalRaceIndexEndpointTests(unittest.TestCase):
    def test_empty_collection_self_heals_from_a_live_fetch(self):
        db_collection = FakeCollection(find_result=[])
        fake_db = FakeDb(historical_race_index=db_collection)

        built = [
            {
                "season": 1950,
                "round": 1,
                "date": "1950-05-13",
                "race_name": "British Grand Prix",
                "circuit_id": "silverstone",
                "driver": "Nino Farina",
                "constructor_key": "alfa_1950s",
                "constructor_name": "Alfa Romeo",
                "indy500": False,
            }
        ]

        async def fake_build_full_index():
            return built

        with patch.object(historical_index, "get_db", return_value=fake_db), patch.object(
            historical_index, "_build_full_index", side_effect=fake_build_full_index
        ):
            response = asyncio.run(historical_index.get_historical_race_index(detail="full"))

        body = json.loads(response.body)
        self.assertEqual(body["count"], 1)
        self.assertEqual(body["races"], built)
        self.assertEqual(len(db_collection.insert_many_calls), 1)

    def test_populated_collection_is_served_without_a_live_fetch(self):
        stored = [
            {
                "season": 2024,
                "round": 1,
                "date": "2024-03-02",
                "race_name": "Bahrain Grand Prix",
                "circuit_id": "bahrain",
                "driver": "Max Verstappen",
                "constructor_key": "red_bull",
                "constructor_name": "Red Bull",
                "indy500": False,
            }
        ]
        db_collection = FakeCollection(find_result=stored)
        fake_db = FakeDb(historical_race_index=db_collection)

        with patch.object(historical_index, "get_db", return_value=fake_db), patch.object(
            historical_index, "_build_full_index"
        ) as fetch_mock:
            response = asyncio.run(historical_index.get_historical_race_index(detail="full"))

        fetch_mock.assert_not_called()
        body = json.loads(response.body)
        self.assertEqual(body["count"], 1)

    def test_compact_detail_drops_narrative_fields(self):
        stored = [
            {
                "season": 2024,
                "round": 1,
                "date": "2024-03-02",
                "race_name": "Bahrain Grand Prix",
                "circuit_id": "bahrain",
                "driver": "Max Verstappen",
                "constructor_key": "red_bull",
                "constructor_name": "Red Bull",
                "indy500": False,
            }
        ]
        db_collection = FakeCollection(find_result=stored)
        fake_db = FakeDb(historical_race_index=db_collection)

        with patch.object(historical_index, "get_db", return_value=fake_db):
            response = asyncio.run(historical_index.get_historical_race_index(detail="compact"))

        body = json.loads(response.body)
        self.assertEqual(
            sorted(body["races"][0].keys()), sorted(["season", "round", "constructor_key", "indy500"])
        )


class ConstructorSeasonsEndpointTests(unittest.TestCase):
    def test_a_finished_constructor_is_cached(self):
        cache = FakeCollection(find_one_result=None)
        fake_db = FakeDb(constructor_seasons_cache=cache)

        async def fake_fetch(constructor_id):
            return [1985, 1986, 1987]

        with patch.object(historical_index, "get_db", return_value=fake_db), patch.object(
            historical_index, "_fetch_constructor_seasons", side_effect=fake_fetch
        ):
            response = asyncio.run(historical_index.get_constructor_seasons(constructor_id="minardi"))

        body = json.loads(response.body)
        self.assertEqual(body["seasons"], [1985, 1986, 1987])
        self.assertEqual(len(cache.update_one_calls), 1)

    def test_a_still_active_constructor_is_not_cached(self):
        cache = FakeCollection(find_one_result=None)
        fake_db = FakeDb(constructor_seasons_cache=cache)
        current_year = historical_index.datetime.datetime.now(historical_index.datetime.timezone.utc).year

        async def fake_fetch(constructor_id):
            return [current_year - 1, current_year]

        with patch.object(historical_index, "get_db", return_value=fake_db), patch.object(
            historical_index, "_fetch_constructor_seasons", side_effect=fake_fetch
        ):
            asyncio.run(historical_index.get_constructor_seasons(constructor_id="red_bull"))

        self.assertEqual(cache.update_one_calls, [])

    def test_a_cached_entry_is_served_without_a_live_fetch(self):
        cache = FakeCollection(find_one_result={"constructor_id": "minardi", "seasons": [1985, 1986]})
        fake_db = FakeDb(constructor_seasons_cache=cache)

        with patch.object(historical_index, "get_db", return_value=fake_db), patch.object(
            historical_index, "_fetch_constructor_seasons"
        ) as fetch_mock:
            response = asyncio.run(historical_index.get_constructor_seasons(constructor_id="minardi"))

        fetch_mock.assert_not_called()
        body = json.loads(response.body)
        self.assertEqual(body["seasons"], [1985, 1986])


if __name__ == "__main__":
    unittest.main()
