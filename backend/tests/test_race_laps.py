import asyncio
import json
import sys
import types
import unittest
from datetime import timedelta
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# race_laps imports motor at module scope; these tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import race_laps


class FakeCollection:
    def __init__(self, doc=None):
        self.doc = doc
        self.update = None

    async def find_one(self, *args, **kwargs):
        return self.doc

    async def update_one(self, query, update, upsert=False):
        self.update = {"query": query, "update": update, "upsert": upsert}


class FakeDb:
    def __init__(self, race_laps=None):
        self.race_laps = race_laps or FakeCollection()


def lap(driver, lap_number, position, lap_time=None):
    """Build a raw lap row. `lap_time` takes seconds (float/int), a
    `timedelta` (mirroring the `pandas.Timedelta` FastF1 actually hands back),
    or `None`/omitted for a missing LapTime (`positions_from_laps` is kept
    independent of pandas, so plain `timedelta` objects exercise the same
    `.total_seconds()` code path without needing pandas in these tests)."""
    row = {
        "DriverNumber": driver,
        "LapNumber": lap_number,
        "Position": position,
    }
    if lap_time is not None:
        row["LapTime"] = (
            lap_time if isinstance(lap_time, timedelta) else timedelta(seconds=lap_time)
        )
    return row


class PositionsFromLapsTests(unittest.TestCase):
    def test_flattens_laps_into_one_record_per_driver_lap(self):
        laps = [
            lap("1", 1, 2),
            lap("1", 2, 1),
            lap("44", 1, 1),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(len(rows), 3)
        self.assertEqual(
            rows[0],
            {"driver_number": 1, "lap_number": 1, "position": 2, "gap_seconds": None},
        )

    def test_orders_by_driver_then_lap_regardless_of_input_order(self):
        laps = [lap("44", 2, 3), lap("1", 1, 5), lap("44", 1, 4)]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(
            [(r["driver_number"], r["lap_number"]) for r in rows],
            [(1, 1), (44, 1), (44, 2)],
        )

    def test_drops_rows_missing_a_driver_lap_or_position(self):
        laps = [
            lap(None, 1, 1),
            lap("1", None, 1),
            lap("1", 1, None),
            lap("1", 2, 3),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["lap_number"], 2)

    def test_a_retired_driver_simply_has_no_rows_past_their_last_lap(self):
        laps = [lap("1", 1, 1), lap("1", 2, 1)]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual([r["lap_number"] for r in rows], [1, 2])

    def test_no_laps_yields_no_rows(self):
        self.assertEqual(race_laps.positions_from_laps([]), [])


def _gap(rows, driver, lap_number):
    driver = int(driver)
    for row in rows:
        if row["driver_number"] == driver and row["lap_number"] == lap_number:
            return row["gap_seconds"]
    raise AssertionError(f"no row for driver {driver} lap {lap_number}")


class GapToLeaderTests(unittest.TestCase):
    """Cumulative-time reconstruction and gap-to-leader math.

    `lap()`'s `lap_time` values are chosen so cumulative totals and gaps are
    round numbers, to make the arithmetic easy to eyeball in each assertion.
    """

    def test_leaders_gap_is_always_zero(self):
        laps = [
            lap("1", 1, 1, lap_time=90.0),
            lap("1", 2, 1, lap_time=91.0),
            lap("44", 1, 2, lap_time=91.0),
            lap("44", 2, 2, lap_time=91.5),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(_gap(rows, "1", 1), 0.0)
        self.assertEqual(_gap(rows, "1", 2), 0.0)

    def test_gap_is_the_trailing_drivers_cumulative_time_minus_the_leaders(self):
        # Driver 1 leads throughout, 1s clear each lap. Driver 44 starts 1s
        # back on lap 1 and loses another second on lap 2 -> 2s back total.
        laps = [
            lap("1", 1, 1, lap_time=90.0),
            lap("1", 2, 1, lap_time=90.0),
            lap("44", 1, 2, lap_time=91.0),
            lap("44", 2, 2, lap_time=91.0),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(_gap(rows, "44", 1), 1.0)
        self.assertEqual(_gap(rows, "44", 2), 2.0)

    def test_a_retiring_driver_keeps_correct_gaps_up_to_their_last_lap(self):
        # Driver 44 retires after lap 2 (no lap 3 row at all) -- same
        # "line ends here" behaviour the position chart already has, and the
        # gap for their last lap is still computed correctly from what they
        # did complete.
        laps = [
            lap("1", 1, 1, lap_time=90.0),
            lap("1", 2, 1, lap_time=90.0),
            lap("1", 3, 1, lap_time=90.0),
            lap("44", 1, 2, lap_time=92.0),
            lap("44", 2, 2, lap_time=92.0),
        ]

        rows = race_laps.positions_from_laps(laps)

        driver_44_laps = [r["lap_number"] for r in rows if r["driver_number"] == 44]
        self.assertEqual(driver_44_laps, [1, 2])
        self.assertEqual(_gap(rows, "44", 1), 2.0)
        self.assertEqual(_gap(rows, "44", 2), 4.0)

    def test_a_null_lap_time_is_skipped_not_treated_as_zero(self):
        # Driver 44's lap 2 has no recorded LapTime (e.g. a red-flag pickup
        # lap). Per the skip-and-carry-forward rule, their cumulative total
        # after lap 2 stays exactly what it was after lap 1 (91.0) -- it is
        # NOT treated as a free (zero-duration) lap added on top of the
        # leader's real lap 2 time.
        laps = [
            lap("1", 1, 1, lap_time=90.0),
            lap("1", 2, 1, lap_time=90.0),
            lap("1", 3, 1, lap_time=90.0),
            lap("44", 1, 2, lap_time=91.0),
            lap("44", 2, 2, lap_time=None),
            lap("44", 3, 2, lap_time=91.0),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(_gap(rows, "44", 1), 1.0)
        # This is the documented tradeoff of "skip and carry forward": since
        # 44's total is frozen at 91.0 while the leader's real lap 2 still
        # counts (total 180.0), the gap swings to *negative* for this one
        # lap -- an artifact of the missing sample, not a real overtake.
        # It self-corrects the moment a real LapTime resumes (lap 3 below).
        self.assertEqual(_gap(rows, "44", 2), round(91.0 - 180.0, 3))
        # Lap 3: 44's total is 91 + 91 = 182 (the skipped lap's duration never
        # gets added back), leader's total is 270.
        self.assertEqual(_gap(rows, "44", 3), round(182.0 - 270.0, 3))

    def test_a_driver_with_no_lap_time_yet_has_a_null_gap(self):
        # Driver 44's very first (and only) lap has no LapTime -- there is no
        # basis at all for their cumulative total yet, so the gap is None
        # rather than treating the unknown total as 0.
        laps = [
            lap("1", 1, 1, lap_time=90.0),
            lap("44", 1, 2, lap_time=None),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertIsNone(_gap(rows, "44", 1))

    def test_no_lap_times_anywhere_yields_null_gaps_not_a_crash(self):
        # Mirrors a session whose `laps` frame lacks a usable LapTime column
        # entirely (e.g. very old FastF1 data) -- position rows still come
        # through, just with every gap unresolved.
        laps = [lap("1", 1, 1), lap("44", 1, 2)]

        rows = race_laps.positions_from_laps(laps)

        self.assertTrue(all(r["gap_seconds"] is None for r in rows))
        self.assertEqual([r["position"] for r in rows], [1, 2])


class RaceLapsEndpointTests(unittest.TestCase):
    def test_serves_cached_laps_without_calling_fastf1(self):
        cached = FakeCollection({
            "season": 2026,
            "round": "3",
            "laps": [{"driver_number": 1, "lap_number": 1, "position": 1}],
        })

        with patch.object(race_laps, "get_db", return_value=FakeDb(cached)), \
             patch.object(race_laps, "build_race_laps") as build:
            response = asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        build.assert_not_called()
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(len(body["laps"]), 1)

    def test_rebuilds_from_fastf1_on_a_miss_and_self_heals_the_cache(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [{"driver_number": 1, "lap_number": 1, "position": 1}]

        with patch.object(race_laps, "get_db", return_value=fake_db), \
             patch.object(race_laps, "build_race_laps", return_value=built) as build:
            response = asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        build.assert_called_once_with(2026, 3)
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(body["laps"], built)

        self.assertTrue(fake_db.race_laps.update["upsert"])
        written = fake_db.race_laps.update["update"]["$set"]
        self.assertEqual(written["season"], 2026)
        self.assertEqual(written["round"], "3")
        self.assertEqual(written["laps"], built)

    def test_an_unbuildable_round_reports_unsynced_rather_than_failing(self):
        # This is the Cloud Run case: livetiming 403s, so the rebuild returns
        # nothing and the frontend should say "not synced yet", not error.
        fake_db = FakeDb(FakeCollection(None))

        with patch.object(race_laps, "get_db", return_value=fake_db), \
             patch.object(race_laps, "build_race_laps", return_value=None):
            response = asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        self.assertEqual(response.status_code, 200)
        body = json.loads(response.body)
        self.assertFalse(body["synced"])
        self.assertEqual(body["laps"], [])
        self.assertIsNone(fake_db.race_laps.update)

    def test_a_cached_doc_with_no_laps_triggers_a_rebuild(self):
        fake_db = FakeDb(FakeCollection({"season": 2026, "round": "3", "laps": []}))

        with patch.object(race_laps, "get_db", return_value=fake_db), \
             patch.object(race_laps, "build_race_laps", return_value=None) as build:
            asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        build.assert_called_once()


if __name__ == "__main__":
    unittest.main()
