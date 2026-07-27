import asyncio
import json
import sys
import types
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# pit_stops imports motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import pit_stops


class FakeCollection:
    def __init__(self, doc=None):
        self.doc = doc
        self.update = None

    async def find_one(self, *args, **kwargs):
        return self.doc

    async def update_one(self, query, update, upsert=False):
        self.update = {"query": query, "update": update, "upsert": upsert}


class FakeDb:
    def __init__(self, pit_stops=None):
        self.pit_stops = pit_stops or FakeCollection()


def raw_stop(driver="max_verstappen", lap="14", stop="1", duration="21.625", time="15:23:24"):
    """An Ergast PitStops row — every field arrives as a string."""
    return {"driverId": driver, "lap": lap, "stop": stop, "duration": duration, "time": time}


def ergast_page(rows, total=None):
    return {
        "MRData": {
            "total": str(len(rows) if total is None else total),
            "RaceTable": {"Races": [{"round": "11", "PitStops": rows}]},
        }
    }


class ParseDurationTests(unittest.TestCase):
    def test_plain_seconds(self):
        self.assertEqual(pit_stops.parse_duration("21.789"), 21.789)

    def test_minutes_and_seconds(self):
        # A car sitting in the pits through a red flag; Ergast reports pit-lane
        # time, so this really does come back as "16:12.356".
        self.assertEqual(pit_stops.parse_duration("16:12.356"), 972.356)

    def test_hours_minutes_seconds(self):
        self.assertEqual(pit_stops.parse_duration("1:00:30.5"), 3630.5)

    def test_unparseable_values_yield_none(self):
        for value in (None, "", "abc", "1:2:3:4", "12:xx"):
            self.assertIsNone(pit_stops.parse_duration(value), value)


class NormalisePitStopsTests(unittest.TestCase):
    def test_coerces_ergast_strings_to_numbers(self):
        stops = pit_stops.normalise_pit_stops([raw_stop()])

        self.assertEqual(stops, [{
            "driver_id": "max_verstappen",
            "lap": 14,
            "stop": 1,
            "duration": "21.625",
            "duration_seconds": 21.625,
            "time": "15:23:24",
        }])

    def test_orders_by_lap_then_stop(self):
        rows = [
            raw_stop("hamilton", lap="30", stop="2"),
            raw_stop("stroll", lap="8", stop="1"),
            raw_stop("norris", lap="30", stop="1"),
        ]

        stops = pit_stops.normalise_pit_stops(rows)

        self.assertEqual(
            [(s["lap"], s["stop"]) for s in stops],
            [(8, 1), (30, 1), (30, 2)],
        )

    def test_drops_rows_missing_a_driver_lap_or_usable_duration(self):
        rows = [
            raw_stop(driver=""),
            raw_stop(lap="not-a-lap"),
            raw_stop(duration="???"),
            raw_stop("alonso", lap="20"),
        ]

        stops = pit_stops.normalise_pit_stops(rows)

        self.assertEqual(len(stops), 1)
        self.assertEqual(stops[0]["driver_id"], "alonso")

    def test_keeps_the_raw_duration_string_alongside_the_parsed_seconds(self):
        stops = pit_stops.normalise_pit_stops([raw_stop(duration="16:12.356")])

        self.assertEqual(stops[0]["duration"], "16:12.356")
        self.assertEqual(stops[0]["duration_seconds"], 972.356)

    def test_no_rows_yields_no_stops(self):
        self.assertEqual(pit_stops.normalise_pit_stops([]), [])
        self.assertEqual(pit_stops.normalise_pit_stops(None), [])


class FetchPitStopsTests(unittest.TestCase):
    def test_pages_until_ergasts_total_is_satisfied(self):
        first = [raw_stop(f"d{i}", lap=str(i + 1)) for i in range(pit_stops.PAGE_SIZE)]
        second = [raw_stop("last", lap="99")]
        pages = [ergast_page(first, total=101), ergast_page(second, total=101)]
        urls = []

        def fake_fetch(url, timeout=15):
            urls.append(url)
            return pages[len(urls) - 1]

        with patch.object(pit_stops, "_fetch_json", side_effect=fake_fetch):
            stops = pit_stops.fetch_pit_stops(2026, 11)

        self.assertEqual(len(stops), pit_stops.PAGE_SIZE + 1)
        self.assertIn(f"limit={pit_stops.PAGE_SIZE}&offset=0", urls[0])
        self.assertIn(f"offset={pit_stops.PAGE_SIZE}", urls[1])

    def test_a_single_page_race_makes_exactly_one_request(self):
        calls = []

        def fake_fetch(url, timeout=15):
            calls.append(url)
            return ergast_page([raw_stop(), raw_stop("norris", lap="20")])

        with patch.object(pit_stops, "_fetch_json", side_effect=fake_fetch):
            stops = pit_stops.fetch_pit_stops(2026, 11)

        self.assertEqual(len(calls), 1)
        self.assertEqual(len(stops), 2)

    def test_a_failed_request_is_distinguishable_from_a_race_with_no_stops(self):
        with patch.object(pit_stops, "_fetch_json", return_value=None):
            self.assertIsNone(pit_stops.fetch_pit_stops(2026, 11))

        with patch.object(pit_stops, "_fetch_json", return_value=ergast_page([])):
            self.assertEqual(pit_stops.fetch_pit_stops(2026, 24), [])

    def test_a_future_round_with_no_race_row_yields_no_stops(self):
        empty = {"MRData": {"total": "0", "RaceTable": {"Races": []}}}

        with patch.object(pit_stops, "_fetch_json", return_value=empty):
            self.assertEqual(pit_stops.fetch_pit_stops(2026, 24), [])


class PitStopsEndpointTests(unittest.TestCase):
    def test_serves_cached_stops_without_calling_ergast(self):
        cached = FakeCollection({
            "season": 2026,
            "round": "11",
            "stops": [{
                "driver_id": "max_verstappen",
                "lap": 14,
                "stop": 1,
                "duration": "21.625",
                "duration_seconds": 21.625,
                "time": "15:23:24",
            }],
        })

        with patch.object(pit_stops, "get_db", return_value=FakeDb(cached)), \
             patch.object(pit_stops, "fetch_pit_stops") as fetch:
            response = asyncio.run(pit_stops.get_pit_stops(year=2026, round_number=11))

        fetch.assert_not_called()
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(len(body["stops"]), 1)

    def test_rebuilds_from_ergast_on_a_miss_and_self_heals_the_cache(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [{
            "driver_id": "max_verstappen",
            "lap": 14,
            "stop": 1,
            "duration": "21.625",
            "duration_seconds": 21.625,
            "time": "15:23:24",
        }]

        with patch.object(pit_stops, "get_db", return_value=fake_db), \
             patch.object(pit_stops, "fetch_pit_stops", return_value=built) as fetch:
            response = asyncio.run(pit_stops.get_pit_stops(year=2026, round_number=11))

        fetch.assert_called_once_with(2026, 11)
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(body["stops"], built)

        self.assertTrue(fake_db.pit_stops.update["upsert"])
        written = fake_db.pit_stops.update["update"]["$set"]
        self.assertEqual(written["season"], 2026)
        self.assertEqual(written["round"], "11")
        self.assertEqual(written["stops"], built)

    def test_a_round_with_no_data_reports_unsynced_rather_than_failing(self):
        fake_db = FakeDb(FakeCollection(None))

        with patch.object(pit_stops, "get_db", return_value=fake_db), \
             patch.object(pit_stops, "fetch_pit_stops", return_value=None):
            response = asyncio.run(pit_stops.get_pit_stops(year=2026, round_number=24))

        self.assertEqual(response.status_code, 200)
        body = json.loads(response.body)
        self.assertFalse(body["synced"])
        self.assertEqual(body["stops"], [])
        self.assertIsNone(fake_db.pit_stops.update)

    def test_a_cached_doc_with_no_stops_triggers_a_rebuild(self):
        fake_db = FakeDb(FakeCollection({"season": 2026, "round": "11", "stops": []}))

        with patch.object(pit_stops, "get_db", return_value=fake_db), \
             patch.object(pit_stops, "fetch_pit_stops", return_value=None) as fetch:
            asyncio.run(pit_stops.get_pit_stops(year=2026, round_number=11))

        fetch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
