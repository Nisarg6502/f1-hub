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
    def __init__(self, race_laps=None, race_date="2026-07-26"):
        self.race_laps = race_laps or FakeCollection()
        # The OpenF1 path looks a round's date up here before it can find a
        # session key; a None date means "no date on file" and skips OpenF1.
        self.races = FakeCollection({"date": race_date} if race_date else None)


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


def openf1_lap(driver, lap_number, date_start, duration=None):
    """One row in the shape OpenF1's `/laps` endpoint actually returns.

    Note what is *not* here: a position column. OpenF1 has none, which is why
    `positions_from_openf1` has to join against the `/position` feed.
    """
    return {
        "session_key": 11342,
        "driver_number": driver,
        "lap_number": lap_number,
        "date_start": date_start,
        "lap_duration": duration,
    }


def openf1_position(driver, date, position):
    """One row in the shape OpenF1's `/position` endpoint returns."""
    return {"session_key": 11342, "driver_number": driver, "date": date, "position": position}


# A tidy two-driver race: driver 1 leads and laps in 90s, driver 44 is 1s back
# after lap 1 and loses another second on lap 2. Timestamps are the moment each
# lap *starts*, so lap N's end is lap N+1's start.
CLEAN_LAPS = [
    openf1_lap(1, 1, "2026-07-26T13:00:00+00:00", 90.0),
    openf1_lap(1, 2, "2026-07-26T13:01:30+00:00", 90.0),
    openf1_lap(44, 1, "2026-07-26T13:00:00+00:00", 91.0),
    openf1_lap(44, 2, "2026-07-26T13:01:31+00:00", 91.0),
]
CLEAN_POSITIONS = [
    openf1_position(1, "2026-07-26T12:30:00+00:00", 1),
    openf1_position(44, "2026-07-26T12:30:00+00:00", 2),
]


class PositionsFromOpenF1Tests(unittest.TestCase):
    def test_produces_the_same_row_shape_as_the_fastf1_path(self):
        rows = race_laps.positions_from_openf1(CLEAN_LAPS, CLEAN_POSITIONS)

        # Key parity with `positions_from_laps` is the whole point: the
        # frontend must not be able to tell which source filled the cache.
        self.assertEqual(
            set(rows[0]),
            set(race_laps.positions_from_laps([lap("1", 1, 1)])[0]),
        )
        self.assertEqual(
            [(r["driver_number"], r["lap_number"], r["position"]) for r in rows],
            [(1, 1, 1), (1, 2, 1), (44, 1, 2), (44, 2, 2)],
        )

    def test_gap_is_the_difference_between_line_crossing_instants(self):
        rows = race_laps.positions_from_openf1(CLEAN_LAPS, CLEAN_POSITIONS)
        gaps = {(r["driver_number"], r["lap_number"]): r["gap_seconds"] for r in rows}

        self.assertEqual(gaps[(1, 1)], 0.0)
        self.assertEqual(gaps[(1, 2)], 0.0)
        self.assertEqual(gaps[(44, 1)], 1.0)
        self.assertEqual(gaps[(44, 2)], 2.0)

    def test_position_tracks_events_at_or_before_the_lap_was_completed(self):
        # Driver 44 passes driver 1 partway through lap 2 (13:02:00, before
        # either crosses the line at ~13:03), so lap 1 reads as the pre-race
        # order and lap 2 reads as the swapped order.
        positions = CLEAN_POSITIONS + [
            openf1_position(44, "2026-07-26T13:02:00+00:00", 1),
            openf1_position(1, "2026-07-26T13:02:00+00:00", 2),
        ]

        rows = race_laps.positions_from_openf1(CLEAN_LAPS, positions)
        by_key = {(r["driver_number"], r["lap_number"]): r["position"] for r in rows}

        self.assertEqual(by_key[(1, 1)], 1)
        self.assertEqual(by_key[(44, 1)], 2)
        self.assertEqual(by_key[(1, 2)], 2)
        self.assertEqual(by_key[(44, 2)], 1)

    def test_a_lap_before_any_position_event_falls_back_to_the_earliest_one(self):
        positions = [openf1_position(1, "2026-07-26T13:05:00+00:00", 4)]

        rows = race_laps.positions_from_openf1(CLEAN_LAPS[:2], positions)

        self.assertEqual([r["position"] for r in rows], [4, 4])

    def test_the_final_lap_falls_back_to_date_start_plus_duration(self):
        # There is no lap 3 to read a `date_start` off, so lap 2's end has to
        # come from arithmetic -- and its gap must still come out right.
        rows = race_laps.positions_from_openf1(CLEAN_LAPS, CLEAN_POSITIONS)
        last = [r for r in rows if r["driver_number"] == 44 and r["lap_number"] == 2][0]

        self.assertEqual(last["gap_seconds"], 2.0)

    def test_a_lap_with_neither_a_next_start_nor_a_duration_gets_a_null_gap(self):
        laps = [
            openf1_lap(1, 1, "2026-07-26T13:00:00+00:00", 90.0),
            openf1_lap(1, 2, "2026-07-26T13:01:30+00:00", 90.0),
            openf1_lap(44, 1, "2026-07-26T13:00:00+00:00", 91.0),
            openf1_lap(44, 2, "2026-07-26T13:01:31+00:00", None),
        ]

        rows = race_laps.positions_from_openf1(laps, CLEAN_POSITIONS)
        row = [r for r in rows if r["driver_number"] == 44 and r["lap_number"] == 2][0]

        # The position is still known and still charted; only the gap is lost,
        # which the frontend already renders as a break in the gap line.
        self.assertEqual(row["position"], 2)
        self.assertIsNone(row["gap_seconds"])

    def test_a_lap_no_leader_completed_gets_a_null_gap_not_a_wrong_one(self):
        laps = CLEAN_LAPS + [openf1_lap(44, 3, "2026-07-26T13:03:02+00:00", 91.0)]

        rows = race_laps.positions_from_openf1(laps, CLEAN_POSITIONS)
        row = [r for r in rows if r["driver_number"] == 44 and r["lap_number"] == 3][0]

        self.assertIsNone(row["gap_seconds"])

    def test_a_driver_with_no_position_events_is_dropped(self):
        rows = race_laps.positions_from_openf1(CLEAN_LAPS, CLEAN_POSITIONS[:1])

        self.assertEqual({r["driver_number"] for r in rows}, {1})

    def test_drops_rows_missing_a_driver_or_lap_number(self):
        laps = [
            openf1_lap(None, 1, "2026-07-26T13:00:00+00:00", 90.0),
            openf1_lap(1, None, "2026-07-26T13:00:00+00:00", 90.0),
            openf1_lap(1, 1, "2026-07-26T13:00:00+00:00", 90.0),
        ]

        rows = race_laps.positions_from_openf1(laps, CLEAN_POSITIONS)

        self.assertEqual(len(rows), 1)

    def test_orders_by_driver_then_lap(self):
        rows = race_laps.positions_from_openf1(list(reversed(CLEAN_LAPS)), CLEAN_POSITIONS)

        self.assertEqual(
            [(r["driver_number"], r["lap_number"]) for r in rows],
            [(1, 1), (1, 2), (44, 1), (44, 2)],
        )

    def test_no_laps_yields_no_rows(self):
        self.assertEqual(race_laps.positions_from_openf1([], CLEAN_POSITIONS), [])


class BuildRaceLapsOpenF1Tests(unittest.TestCase):
    def test_fetches_the_session_then_both_feeds(self):
        calls = []

        def fake_fetch(url, params=None, timeout=20.0):
            calls.append(url.rsplit("/", 1)[-1])
            if url.endswith("/laps"):
                return CLEAN_LAPS
            if url.endswith("/position"):
                return CLEAN_POSITIONS
            return None

        with patch.object(race_laps, "_fetch_json", side_effect=fake_fetch), \
             patch("app.race_stints.fetch_openf1_session_key", return_value=11342):
            rows = race_laps.build_race_laps_openf1("2026-07-26")

        self.assertEqual(calls, ["laps", "position"])
        self.assertEqual(len(rows), 4)

    def test_a_season_openf1_does_not_cover_returns_none(self):
        with patch("app.race_stints.fetch_openf1_session_key", return_value=None), \
             patch.object(race_laps, "_fetch_json") as fetch:
            self.assertIsNone(race_laps.build_race_laps_openf1("2018-07-26"))

        fetch.assert_not_called()

    def test_a_missing_position_feed_returns_none_so_fastf1_can_try(self):
        # Without positions there is no chart at all, so this has to read as
        # "OpenF1 has nothing" rather than caching a position-less document.
        def fake_fetch(url, params=None, timeout=20.0):
            return CLEAN_LAPS if url.endswith("/laps") else []

        with patch.object(race_laps, "_fetch_json", side_effect=fake_fetch), \
             patch("app.race_stints.fetch_openf1_session_key", return_value=11342):
            self.assertIsNone(race_laps.build_race_laps_openf1("2026-07-26"))

    def test_an_empty_lap_feed_returns_none(self):
        with patch.object(race_laps, "_fetch_json", return_value=[]), \
             patch("app.race_stints.fetch_openf1_session_key", return_value=11342):
            self.assertIsNone(race_laps.build_race_laps_openf1("2026-07-26"))


class RaceLapsSourceOrderTests(unittest.TestCase):
    """OpenF1 is tried before FastF1, and the winner is recorded on the doc."""

    def test_openf1_is_tried_first_and_fastf1_is_never_reached_when_it_answers(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [{"driver_number": 1, "lap_number": 1, "position": 1, "gap_seconds": 0.0}]

        with patch.object(race_laps, "get_db", return_value=fake_db), \
             patch.object(race_laps, "build_race_laps_openf1", return_value=built) as openf1, \
             patch.object(race_laps, "build_race_laps") as fastf1_build:
            response = asyncio.run(race_laps.get_race_laps(year=2026, round_number=11))

        openf1.assert_called_once_with("2026-07-26")
        fastf1_build.assert_not_called()
        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(body["laps"], built)
        self.assertEqual(fake_db.race_laps.update["update"]["$set"]["source"], "openf1")

    def test_falls_back_to_fastf1_and_marks_the_source_when_openf1_has_nothing(self):
        fake_db = FakeDb(FakeCollection(None))
        built = [{"driver_number": 1, "lap_number": 1, "position": 1, "gap_seconds": 0.0}]

        with patch.object(race_laps, "get_db", return_value=fake_db), \
             patch.object(race_laps, "build_race_laps_openf1", return_value=None), \
             patch.object(race_laps, "build_race_laps", return_value=built) as fastf1_build:
            asyncio.run(race_laps.get_race_laps(year=2026, round_number=11))

        fastf1_build.assert_called_once_with(2026, 11)
        self.assertEqual(fake_db.race_laps.update["update"]["$set"]["source"], "fastf1")

    def test_a_round_with_no_known_date_skips_openf1_and_uses_fastf1(self):
        fake_db = FakeDb(FakeCollection(None), race_date=None)

        with patch.object(race_laps, "get_db", return_value=fake_db), \
             patch.object(race_laps, "build_race_laps_openf1") as openf1, \
             patch.object(race_laps, "build_race_laps", return_value=None):
            response = asyncio.run(race_laps.get_race_laps(year=1998, round_number=3))

        openf1.assert_not_called()
        self.assertFalse(json.loads(response.body)["synced"])

    def test_a_cached_document_short_circuits_both_sources(self):
        cached = FakeCollection({
            "season": 2026,
            "round": "11",
            "laps": [{"driver_number": 1, "lap_number": 1, "position": 1, "gap_seconds": 0.0}],
        })

        with patch.object(race_laps, "get_db", return_value=FakeDb(cached)), \
             patch.object(race_laps, "build_race_laps_openf1") as openf1, \
             patch.object(race_laps, "build_race_laps") as fastf1_build:
            asyncio.run(race_laps.get_race_laps(year=2026, round_number=11))

        openf1.assert_not_called()
        fastf1_build.assert_not_called()


class RaceLapsEndpointTests(unittest.TestCase):
    def test_serves_cached_laps_without_calling_fastf1(self):
        cached = FakeCollection({
            "season": 2026,
            "round": "3",
            "laps": [{"driver_number": 1, "lap_number": 1, "position": 1}],
        })

        with patch.object(race_laps, "get_db", return_value=FakeDb(cached)), \
             patch.object(race_laps, "build_race_laps_openf1", return_value=None), \
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
             patch.object(race_laps, "build_race_laps_openf1", return_value=None), \
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
             patch.object(race_laps, "build_race_laps_openf1", return_value=None), \
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
             patch.object(race_laps, "build_race_laps_openf1", return_value=None), \
             patch.object(race_laps, "build_race_laps", return_value=None) as build:
            asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        build.assert_called_once()


if __name__ == "__main__":
    unittest.main()
