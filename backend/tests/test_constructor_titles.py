import asyncio
import datetime
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# constructor_titles imports motor (via db.py) at module scope; these tests
# never touch Mongo, same stub pattern as test_historical_index.py.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import constructor_titles


def constructor_standings_payload(constructor_id, name, season="1979"):
    return {
        "MRData": {
            "StandingsTable": {
                "season": season,
                "StandingsLists": [
                    {
                        "season": season,
                        "ConstructorStandings": [
                            {
                                "position": "1",
                                "Constructor": {
                                    "constructorId": constructor_id,
                                    "name": name,
                                },
                            }
                        ],
                    }
                ],
            }
        }
    }


def driver_standings_payload(given, family, constructor_ids, season="1979", driver_id="x"):
    return {
        "MRData": {
            "StandingsTable": {
                "season": season,
                "StandingsLists": [
                    {
                        "season": season,
                        "DriverStandings": [
                            {
                                "position": "1",
                                "Driver": {
                                    "driverId": driver_id,
                                    "givenName": given,
                                    "familyName": family,
                                },
                                "Constructors": [
                                    {"constructorId": cid, "name": cid}
                                    for cid in constructor_ids
                                ],
                            }
                        ],
                    }
                ],
            }
        }
    }


class FakeCursor:
    def __init__(self, items):
        self._items = items

    async def to_list(self, length=None):
        return list(self._items)


class FakeCollection:
    def __init__(self, docs=None):
        self.docs = list(docs or [])
        self.update_one_calls = []

    def find(self, query=None, projection=None):
        wanted = ((query or {}).get("season") or {}).get("$in")
        if wanted is None:
            return FakeCursor(self.docs)
        return FakeCursor([d for d in self.docs if d.get("season") in wanted])

    async def update_one(self, query, update, upsert=False):
        self.update_one_calls.append((query, update, upsert))


class FakeDb:
    def __init__(self, cache=None):
        self._collections = {constructor_titles.CACHE_COLLECTION: cache or FakeCollection()}

    def __getitem__(self, name):
        return self._collections[name]


# --- Parsing ---------------------------------------------------------------


class ParsingTests(unittest.TestCase):
    def test_constructor_champion_is_read_from_the_p1_row(self):
        parsed = constructor_titles.parse_constructor_champion(
            constructor_standings_payload("ferrari", "Ferrari")
        )
        self.assertEqual(parsed, {"raw_id": "ferrari", "name": "Ferrari"})

    def test_driver_champion_keeps_every_constructor_ergast_lists(self):
        # A champion who switched teams mid-season carries more than one
        # constructor. Dropping to the first would credit one team with a
        # title the record does not attribute to it alone.
        parsed = constructor_titles.parse_driver_champion(
            driver_standings_payload("Juan Manuel", "Fangio", ["maserati", "mercedes"])
        )
        self.assertEqual(parsed["driver"], "Juan Manuel Fangio")
        self.assertEqual(parsed["raw_ids"], ["maserati", "mercedes"])

    def test_empty_and_malformed_payloads_return_none_rather_than_raising(self):
        for payload in (None, {}, {"MRData": {}}, {"MRData": {"StandingsTable": {"StandingsLists": []}}}):
            self.assertIsNone(constructor_titles.parse_constructor_champion(payload))
            self.assertIsNone(constructor_titles.parse_driver_champion(payload))


# --- The current season is deliberately out of range -----------------------


class CoveredRangeTests(unittest.TestCase):
    def test_range_ends_at_the_previous_year_not_the_season_being_raced(self):
        # An in-progress season's standings return the current LEADER, not a
        # champion. Counting that as a title is the exact "a number presented
        # as something it is not" failure this module exists to avoid.
        self.assertEqual(
            constructor_titles.last_completed_season(datetime.date(2026, 8, 18)), 2025
        )
        self.assertEqual(
            constructor_titles.last_completed_season(datetime.date(2026, 12, 31)), 2025
        )


# --- Aggregation -----------------------------------------------------------


class AggregationTests(unittest.TestCase):
    def test_titles_accumulate_per_key_and_stay_in_separate_buckets(self):
        records = [
            {
                "season": 1979,
                "constructor_champion_key": "ferrari",
                "driver_champion": "Jody Scheckter",
                "driver_champion_constructor_keys": ["ferrari"],
            },
            {
                "season": 2009,
                "constructor_champion_key": "brawn",
                "driver_champion": "Jenson Button",
                "driver_champion_constructor_keys": ["brawn"],
            },
            {
                "season": 2007,
                "constructor_champion_key": "ferrari",
                "driver_champion": "Kimi Raikkonen",
                "driver_champion_constructor_keys": ["ferrari"],
            },
        ]

        titles = constructor_titles.aggregate_titles(records)

        self.assertEqual(titles["ferrari"]["constructor_titles"], [1979, 2007])
        self.assertEqual(
            [t["season"] for t in titles["ferrari"]["driver_titles"]], [1979, 2007]
        )
        self.assertEqual(titles["brawn"]["constructor_titles"], [2009])

    def test_a_driver_title_alone_never_creates_a_constructor_title(self):
        # 1958-2025 has seasons where the drivers' champion drove for a team
        # that did not win the constructors' title (1958 Hawthorn/Ferrari vs
        # Vanwall is the canonical case). The two must not be conflated.
        records = [
            {
                "season": 1958,
                "constructor_champion_key": "vanwall",
                "driver_champion": "Mike Hawthorn",
                "driver_champion_constructor_keys": ["ferrari"],
            }
        ]

        titles = constructor_titles.aggregate_titles(records)

        self.assertEqual(titles["vanwall"]["constructor_titles"], [1958])
        self.assertEqual(titles["vanwall"]["driver_titles"], [])
        self.assertEqual(titles["ferrari"]["constructor_titles"], [])
        self.assertEqual(
            titles["ferrari"]["driver_titles"],
            [{"season": 1958, "driver": "Mike Hawthorn"}],
        )

    def test_a_split_season_credits_both_constructors_the_record_names(self):
        records = [
            {
                "season": 1954,
                "driver_champion": "Juan Manuel Fangio",
                "driver_champion_constructor_keys": ["maserati", "mercedes"],
            }
        ]
        titles = constructor_titles.aggregate_titles(records)
        self.assertEqual(len(titles["maserati"]["driver_titles"]), 1)
        self.assertEqual(len(titles["mercedes"]["driver_titles"]), 1)


# --- Season fetch ----------------------------------------------------------


class SeasonFetchTests(unittest.TestCase):
    def test_pre_1958_seasons_are_valid_with_no_constructor_champion(self):
        # The Constructors' Championship did not exist before 1958. A season
        # with only a drivers' champion is a real record, not a failure.
        def fake_fetch(url, timeout=15):
            self.assertIn("driverStandings", url)
            return driver_standings_payload("Nino", "Farina", ["alfa"], season="1950")

        with patch.object(constructor_titles, "_fetch_json", fake_fetch):
            record = asyncio.run(constructor_titles._fetch_season_champions(1950))

        self.assertEqual(record["season"], 1950)
        self.assertEqual(record["driver_champion"], "Nino Farina")
        self.assertNotIn("constructor_champion_key", record)
        # `alfa` is one raw id spanning three unrelated eras; 1950 must
        # resolve to the 1950s works team, not Alfa Romeo Racing (Sauber).
        self.assertEqual(record["driver_champion_constructor_keys"], ["alfa_1950s"])

    def test_a_season_jolpica_will_not_answer_resolves_to_none(self):
        with patch.object(constructor_titles, "_fetch_json", lambda url, timeout=15: None):
            with patch.object(constructor_titles.asyncio, "sleep", _noop_sleep):
                record = asyncio.run(constructor_titles._fetch_season_champions(1995))
        self.assertIsNone(record)

    def test_a_post_1958_season_missing_constructor_standings_is_a_failure(self):
        # Not a real gap: every season from 1958 has a constructors' champion,
        # so an absent one means Jolpica did not answer and the season must
        # NOT be cached as "no title" — that would understate a team forever.
        def fake_fetch(url, timeout=15):
            if "driverStandings" in url:
                return driver_standings_payload("Ayrton", "Senna", ["mclaren"], season="1991")
            return None

        with patch.object(constructor_titles, "_fetch_json", fake_fetch):
            with patch.object(constructor_titles.asyncio, "sleep", _noop_sleep):
                record = asyncio.run(constructor_titles._fetch_season_champions(1991))

        self.assertIsNone(record)


async def _noop_sleep(_seconds):
    return None


# --- Cache behaviour + the `complete` contract -----------------------------


class ResolveSeasonsTests(unittest.TestCase):
    def test_cached_seasons_are_never_refetched(self):
        cache = FakeCollection(
            [
                {"season": 2020, "driver_champion": "Lewis Hamilton",
                 "driver_champion_constructor_keys": ["mercedes"],
                 "constructor_champion_key": "mercedes"},
            ]
        )
        calls = []

        def fake_fetch(url, timeout=15):
            calls.append(url)
            return None

        with patch.object(constructor_titles, "get_db", lambda: FakeDb(cache)):
            with patch.object(constructor_titles, "_fetch_json", fake_fetch):
                records, expected = asyncio.run(constructor_titles._resolve_seasons([2020]))

        self.assertEqual(calls, [])
        self.assertEqual(expected, 1)
        self.assertEqual(records[0]["constructor_champion_key"], "mercedes")

    def test_a_freshly_fetched_season_is_cached_because_it_can_never_change(self):
        cache = FakeCollection([])

        def fake_fetch(url, timeout=15):
            if "driverStandings" in url:
                return driver_standings_payload("Nico", "Rosberg", ["mercedes"], season="2016")
            return constructor_standings_payload("mercedes", "Mercedes", season="2016")

        with patch.object(constructor_titles, "get_db", lambda: FakeDb(cache)):
            with patch.object(constructor_titles, "_fetch_json", fake_fetch):
                records, _ = asyncio.run(constructor_titles._resolve_seasons([2016]))

        self.assertEqual(len(records), 1)
        self.assertEqual(len(cache.update_one_calls), 1)
        self.assertEqual(cache.update_one_calls[0][0], {"season": 2016})

    def test_a_failed_season_is_absent_and_not_cached(self):
        # The whole point of `complete`: a partial resolve is an UNDERCOUNT,
        # which reads as data rather than as an error.
        cache = FakeCollection([])

        def fake_fetch(url, timeout=15):
            if "/2016/" in url:
                if "driverStandings" in url:
                    return driver_standings_payload("Nico", "Rosberg", ["mercedes"], season="2016")
                return constructor_standings_payload("mercedes", "Mercedes", season="2016")
            return None

        with patch.object(constructor_titles, "get_db", lambda: FakeDb(cache)):
            with patch.object(constructor_titles, "_fetch_json", fake_fetch):
                with patch.object(constructor_titles.asyncio, "sleep", _noop_sleep):
                    records, expected = asyncio.run(
                        constructor_titles._resolve_seasons([2016, 2017])
                    )

        self.assertEqual(expected, 2)
        self.assertEqual([r["season"] for r in records], [2016])
        self.assertEqual([c[0] for c in cache.update_one_calls], [{"season": 2016}])


class EndpointTests(unittest.TestCase):
    def test_payload_states_its_range_and_completeness(self):
        cache = FakeCollection([])

        def fake_fetch(url, timeout=15):
            if "driverStandings" in url:
                return driver_standings_payload("A", "Driver", ["ferrari"])
            return constructor_standings_payload("ferrari", "Ferrari")

        with patch.object(constructor_titles, "get_db", lambda: FakeDb(cache)):
            with patch.object(constructor_titles, "_fetch_json", fake_fetch):
                with patch.object(constructor_titles, "last_completed_season", lambda: 1952):
                    response = asyncio.run(constructor_titles.get_constructor_titles())

        import json as _json

        body = _json.loads(response.body)
        self.assertEqual(body["first_season"], 1950)
        self.assertEqual(body["last_season"], 1952)
        self.assertEqual(body["constructor_title_first_season"], 1958)
        self.assertTrue(body["complete"])
        self.assertEqual(body["seasons_expected"], 3)
        # Pre-1958: drivers' titles only, no constructors' title anywhere.
        self.assertEqual(body["constructors"]["ferrari"]["constructor_titles"], [])
        self.assertEqual(len(body["constructors"]["ferrari"]["driver_titles"]), 3)


if __name__ == "__main__":
    unittest.main()
