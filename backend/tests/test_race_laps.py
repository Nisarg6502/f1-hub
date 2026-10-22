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


def lap(driver, lap_number, position, lap_time=None, line=None):
    """Build a raw lap row the way FastF1's `session.laps` presents it.

    `lap_time` is the lap's own duration (`LapTime`) and `line` the session
    time at which the lap was completed (`Time`). Each takes seconds, a
    `timedelta` (mirroring the `pandas.Timedelta` FastF1 hands back), or
    `None`/omitted for a missing value. `positions_from_laps` is kept
    independent of pandas, so plain `timedelta` objects exercise the same
    `.total_seconds()` code path."""
    row = {
        "DriverNumber": driver,
        "LapNumber": lap_number,
        "Position": position,
    }
    for column, value in (("LapTime", lap_time), ("Time", line)):
        if value is not None:
            row[column] = value if isinstance(value, timedelta) else timedelta(seconds=value)
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
            {
                "driver_number": 1,
                "lap_number": 1,
                "position": 2,
                "lap_time_seconds": None,
                "line_seconds": None,
                "gap_seconds": None,
            },
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


def _row(rows, driver, lap_number):
    driver = int(driver)
    for row in rows:
        if row["driver_number"] == driver and row["lap_number"] == lap_number:
            return row
    raise AssertionError(f"no row for driver {driver} lap {lap_number}")


def _gap(rows, driver, lap_number):
    return _row(rows, driver, lap_number)["gap_seconds"]


# A two-driver race with complete timing on every lap, plus the exact
# `gap_seconds` it produced *before* `lap_time_seconds` was persisted. Driver 1
# leads at 90s a lap; 44 runs 91.0/91.5/90.0 behind, so the gaps are uneven
# rather than a constant offset. `line` is each lap's completion instant: on a
# race with complete timing it is exactly the running sum of lap times, which
# is why the gaps pinned here survive the move from summing durations to
# differencing crossings. See `GapSecondsIsUnchangedTests`.
COMPLETE_TIMING_LAPS = [
    lap("1", 1, 1, lap_time=90.0, line=90.0),
    lap("1", 2, 1, lap_time=90.0, line=180.0),
    lap("1", 3, 1, lap_time=90.0, line=270.0),
    lap("44", 1, 2, lap_time=91.0, line=91.0),
    lap("44", 2, 2, lap_time=91.5, line=182.5),
    lap("44", 3, 2, lap_time=90.0, line=272.5),
]
GAPS_BEFORE_LAP_TIME_SECONDS = {
    (1, 1): 0.0, (1, 2): 0.0, (1, 3): 0.0,
    (44, 1): 1.0, (44, 2): 2.5, (44, 3): 2.5,
}


class GapSecondsIsUnchangedTests(unittest.TestCase):
    """Pins `gap_seconds` against the values it produced before CP76.

    CP76 adds `lap_time_seconds` by keeping a key `_attach_gap_seconds` used to
    pop, which means it edits the exact function the live Lap Telemetry gap
    chart depends on. A regression there would be silent -- the chart would
    still render, with wrong numbers -- so the expected gaps are written out as
    literals here rather than left to be inferred from the tests that were
    already passing before the change. Recomputing them from the new code would
    defeat the point of the pin.
    """

    def test_gaps_for_a_race_with_complete_timing_are_byte_identical(self):
        rows = race_laps.positions_from_laps(COMPLETE_TIMING_LAPS)

        self.assertEqual(
            {(r["driver_number"], r["lap_number"]): r["gap_seconds"] for r in rows},
            GAPS_BEFORE_LAP_TIME_SECONDS,
        )

    def test_adding_the_duration_field_did_not_disturb_the_other_keys(self):
        rows = race_laps.positions_from_laps(COMPLETE_TIMING_LAPS)

        # Position and ordering are the gap chart's other two contracts; the
        # scratch key that used to be popped must not leak through under its
        # old name either.
        self.assertEqual(
            [(r["driver_number"], r["lap_number"], r["position"]) for r in rows],
            [(1, 1, 1), (1, 2, 1), (1, 3, 1), (44, 1, 2), (44, 2, 2), (44, 3, 2)],
        )
        self.assertTrue(all("_lap_time_seconds" not in r for r in rows))


class LapTimeSecondsTests(unittest.TestCase):
    """The per-lap duration CP76 persists for the watch-party clock."""

    def test_each_row_carries_its_own_lap_duration(self):
        rows = race_laps.positions_from_laps(COMPLETE_TIMING_LAPS)

        # Not cumulative and not relative to anyone: lap 2 for 44 is that lap's
        # own 91.5s, even though their gap to the leader by then is 2.5s.
        self.assertEqual(_row(rows, "44", 1)["lap_time_seconds"], 91.0)
        self.assertEqual(_row(rows, "44", 2)["lap_time_seconds"], 91.5)
        self.assertEqual(_row(rows, "44", 3)["lap_time_seconds"], 90.0)
        self.assertEqual(_row(rows, "1", 2)["lap_time_seconds"], 90.0)

    def test_a_missing_lap_time_is_null_not_zero_and_not_an_error(self):
        # The first-class null case: a lap can legitimately have no usable
        # LapTime (in-lap, out-lap, red-flag pickup). Nothing here invents a
        # stand-in -- a consumer that needs the clock to keep moving picks its
        # own fallback, which is CP77's decision, not this function's.
        laps = [
            lap("1", 1, 1, lap_time=90.0, line=90.0),
            lap("1", 2, 1, lap_time=None, line=180.0),
            lap("1", 3, 1, lap_time=90.0, line=270.0),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertIsNone(_row(rows, "1", 2)["lap_time_seconds"])
        self.assertIsNotNone(_row(rows, "1", 2)["gap_seconds"])
        self.assertEqual(_row(rows, "1", 3)["lap_time_seconds"], 90.0)

    def test_a_race_with_no_lap_times_at_all_yields_nulls_not_a_crash(self):
        rows = race_laps.positions_from_laps([lap("1", 1, 1), lap("44", 1, 2)])

        self.assertTrue(all(r["lap_time_seconds"] is None for r in rows))
        self.assertEqual([r["position"] for r in rows], [1, 2])

    def test_the_openf1_path_fills_it_from_lap_duration(self):
        # OpenF1 is tried first and is the only source reachable from a
        # datacenter IP, so a duration on the FastF1 path alone would leave the
        # field null across most production rows.
        rows = race_laps.positions_from_openf1(CLEAN_LAPS, CLEAN_POSITIONS)
        by_key = {
            (r["driver_number"], r["lap_number"]): r["lap_time_seconds"] for r in rows
        }

        self.assertEqual(by_key[(1, 1)], 90.0)
        self.assertEqual(by_key[(44, 1)], 91.0)
        self.assertEqual(by_key[(44, 2)], 91.0)

    def test_a_null_openf1_lap_duration_stays_null(self):
        laps = [openf1_lap(1, 1, "2026-07-26T13:00:00+00:00", None)]

        rows = race_laps.positions_from_openf1(laps, CLEAN_POSITIONS)

        self.assertIsNone(rows[0]["lap_time_seconds"])


class GapToLeaderTests(unittest.TestCase):
    """Gap-to-leader is the difference between line-crossing instants."""

    def test_leaders_gap_is_always_zero(self):
        laps = [
            lap("1", 1, 1, line=90.0),
            lap("1", 2, 1, line=181.0),
            lap("44", 1, 2, line=91.0),
            lap("44", 2, 2, line=182.5),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(_gap(rows, "1", 1), 0.0)
        self.assertEqual(_gap(rows, "1", 2), 0.0)

    def test_gap_is_the_trailing_drivers_crossing_minus_the_leaders(self):
        laps = [
            lap("1", 1, 1, line=90.0),
            lap("1", 2, 1, line=180.0),
            lap("44", 1, 2, line=91.0),
            lap("44", 2, 2, line=182.0),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(_gap(rows, "44", 1), 1.0)
        self.assertEqual(_gap(rows, "44", 2), 2.0)

    def test_a_retiring_driver_keeps_correct_gaps_up_to_their_last_lap(self):
        laps = [
            lap("1", 1, 1, line=90.0),
            lap("1", 2, 1, line=180.0),
            lap("1", 3, 1, line=270.0),
            lap("44", 1, 2, line=92.0),
            lap("44", 2, 2, line=184.0),
        ]

        rows = race_laps.positions_from_laps(laps)

        driver_44_laps = [r["lap_number"] for r in rows if r["driver_number"] == 44]
        self.assertEqual(driver_44_laps, [1, 2])
        self.assertEqual(_gap(rows, "44", 1), 2.0)
        self.assertEqual(_gap(rows, "44", 2), 4.0)

    def test_a_missing_lap_time_does_not_move_anyones_gap(self):
        # The old derivation summed LapTimes and skipped a missing one, so a
        # car's running total lost that whole lap: this case used to produce a
        # gap of -89.0 here, asserted as "the documented tradeoff". The
        # crossing instant does not depend on the duration being recorded.
        laps = [
            lap("1", 1, 1, lap_time=90.0, line=90.0),
            lap("1", 2, 1, lap_time=90.0, line=180.0),
            lap("1", 3, 1, lap_time=90.0, line=270.0),
            lap("44", 1, 2, lap_time=91.0, line=91.0),
            lap("44", 2, 2, lap_time=None, line=182.0),
            lap("44", 3, 2, lap_time=91.0, line=273.0),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(_gap(rows, "44", 1), 1.0)
        self.assertEqual(_gap(rows, "44", 2), 2.0)
        self.assertEqual(_gap(rows, "44", 3), 3.0)

    def test_the_leader_missing_lap_times_does_not_push_the_field_back(self):
        # 2026 Japan: the leader had no LapTime on laps 23-25 (most of the
        # field only on 25), so summing put P2 324s behind on the final lap.
        # Officially it was 13.7s.
        laps = []
        for n in range(1, 31):
            leader_duration = None if n in (23, 24, 25) else 93.0
            other_duration = None if n == 25 else 93.5
            laps.append(lap("12", n, 1, lap_time=leader_duration, line=93.0 * n))
            laps.append(lap("81", n, 2, lap_time=other_duration, line=93.5 * n))

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(_gap(rows, "81", 30), round(93.5 * 30 - 93.0 * 30, 3))
        self.assertTrue(all(abs(r["gap_seconds"]) < 20 for r in rows))

    def test_a_missing_crossing_nulls_only_that_rows_gap(self):
        laps = [
            lap("1", 1, 1, line=90.0),
            lap("1", 2, 1, line=180.0),
            lap("44", 1, 2, line=91.0),
            lap("44", 2, 2, line=None),
        ]

        rows = race_laps.positions_from_laps(laps)

        self.assertEqual(_gap(rows, "44", 1), 1.0)
        self.assertIsNone(_gap(rows, "44", 2))

    def test_no_crossing_times_anywhere_yields_null_gaps_not_a_crash(self):
        laps = [lap("1", 1, 1, lap_time=90.0), lap("44", 1, 2, lap_time=91.0)]

        rows = race_laps.positions_from_laps(laps)

        self.assertTrue(all(r["gap_seconds"] is None for r in rows))
        self.assertEqual([r["position"] for r in rows], [1, 2])


class HasLineTimesTests(unittest.TestCase):
    def test_rows_from_the_summed_derivation_are_not_trusted(self):
        self.assertFalse(race_laps.has_line_times([{"lap_number": 1, "gap_seconds": 324.0}]))

    def test_rows_with_crossing_instants_are(self):
        self.assertTrue(race_laps.has_line_times([{"lap_number": 1, "line_seconds": None}]))

    def test_no_rows(self):
        self.assertFalse(race_laps.has_line_times([]))
        self.assertFalse(race_laps.has_line_times(None))


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
            "laps": [{"driver_number": 1, "lap_number": 1, "position": 1, "gap_seconds": 0.0, "line_seconds": 90.0}],
        })

        with patch.object(race_laps, "get_db", return_value=FakeDb(cached)), \
             patch.object(race_laps, "build_race_laps_openf1") as openf1, \
             patch.object(race_laps, "build_race_laps") as fastf1_build:
            asyncio.run(race_laps.get_race_laps(year=2026, round_number=11))

        openf1.assert_not_called()
        fastf1_build.assert_not_called()


class RaceLapsEndpointTests(unittest.TestCase):
    def test_a_document_from_the_summed_derivation_is_rebuilt(self):
        # Production 2026 round 3 as stored: gaps from summed LapTimes, no
        # crossing instants. It must not be served while a rebuild is possible.
        stale = FakeCollection({
            "season": 2026,
            "round": "3",
            "laps": [{"driver_number": 81, "lap_number": 53, "position": 2, "gap_seconds": 324.067}],
        })
        rebuilt = [{"driver_number": 81, "lap_number": 53, "position": 2, "gap_seconds": 13.546, "line_seconds": 5000.0}]

        with patch.object(race_laps, "get_db", return_value=FakeDb(stale)), \
             patch.object(race_laps, "build_race_laps_openf1", return_value=rebuilt), \
             patch.object(race_laps, "build_race_laps") as fastf1_build:
            response = asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        fastf1_build.assert_not_called()
        self.assertEqual(json.loads(response.body)["laps"], rebuilt)
        self.assertEqual(stale.update["update"]["$set"]["laps"], rebuilt)
        self.assertEqual(stale.update["update"]["$set"]["source"], "openf1")

    def test_a_rebuild_missing_drivers_is_not_served_or_stored(self):
        # OpenF1 drops any driver whose /position stream is missing.
        stale_rows = [{"driver_number": n, "lap_number": 1, "position": n, "gap_seconds": 0.0} for n in (1, 2)]
        stale = FakeCollection({"season": 2026, "round": "3", "laps": stale_rows})
        partial = [{"driver_number": 1, "lap_number": 1, "position": 1, "gap_seconds": 0.0, "line_seconds": 90.0}]

        with patch.object(race_laps, "get_db", return_value=FakeDb(stale)),              patch.object(race_laps, "build_race_laps_openf1", return_value=partial):
            response = asyncio.run(race_laps.get_race_laps(year=2026, round_number=3))

        self.assertEqual(json.loads(response.body)["laps"], stale_rows)
        self.assertIsNone(stale.update)

    def test_a_stale_document_is_still_served_when_nothing_can_rebuild_it(self):
        # Pre-2023 rounds have no OpenF1 data and FastF1 may be unreachable:
        # the old gaps are better than reporting the round as unsynced.
        stale_rows = [{"driver_number": 1, "lap_number": 1, "position": 1, "gap_seconds": 0.0}]
        stale = FakeCollection({"season": 2019, "round": "3", "laps": stale_rows})

        with patch.object(race_laps, "get_db", return_value=FakeDb(stale)), \
             patch.object(race_laps, "build_race_laps_openf1", return_value=None), \
             patch.object(race_laps, "build_race_laps", return_value=None):
            response = asyncio.run(race_laps.get_race_laps(year=2019, round_number=3))

        body = json.loads(response.body)
        self.assertTrue(body["synced"])
        self.assertEqual(body["laps"], stale_rows)
        self.assertIsNone(stale.update)

    def test_serves_cached_laps_without_calling_fastf1(self):
        cached = FakeCollection({
            "season": 2026,
            "round": "3",
            "laps": [{"driver_number": 1, "lap_number": 1, "position": 1, "line_seconds": 90.0}],
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


class SyncRaceLapsTests(unittest.TestCase):
    """The hourly sync rebuilds rounds written by the old derivation."""

    class Collection:
        def __init__(self, docs):
            self.docs = docs
            self.writes = []

        def find_one(self, query, projection=None):
            return next((d for d in self.docs if d["round"] == query["round"]), None)

        def update_one(self, query, update, upsert=False):
            self.writes.append((query["round"], update["$set"]))

    def _sync(self, docs):
        from app import data_sync

        class Db:
            pass
        db = Db()
        db.race_laps = self.Collection(docs)
        fresh = [{"driver_number": 1, "lap_number": 1, "position": 1, "gap_seconds": 0.0, "line_seconds": 90.0}]
        races = [{"round": "2", "date": "2026-03-15"}, {"round": "17", "date": "2026-10-11"}]
        with patch.object(race_laps, "build_race_laps_any", return_value=(fresh, "openf1")) as build,                 patch.object(data_sync.time, "sleep"):
            data_sync.sync_race_laps(db, 2026, races)
        return db.race_laps.writes, build

    def test_a_summed_derivation_round_is_rebuilt_and_a_current_one_is_not(self):
        writes, build = self._sync([
            {"round": "2", "laps": [{"lap_number": 1, "gap_seconds": 160.5}]},
            {"round": "17", "laps": [{"lap_number": 1, "gap_seconds": 0.0, "line_seconds": 90.0}]},
        ])

        self.assertEqual([round_number for round_number, _ in writes], ["2"])
        self.assertEqual(writes[0][1]["source"], "openf1")
        build.assert_called_once_with(2026, 2, "2026-03-15")

    def test_an_openf1_document_is_already_crossing_based_and_is_kept(self):
        writes, build = self._sync([
            {"round": "2", "source": "openf1", "laps": [{"lap_number": 1, "gap_seconds": 5.4}]},
            {"round": "17", "source": "openf1", "laps": [{"lap_number": 1, "gap_seconds": 0.0}]},
        ])
        self.assertEqual(writes, [])
        build.assert_not_called()

    def test_a_rebuild_with_fewer_drivers_does_not_replace_the_stored_round(self):
        stored = [{"driver_number": n, "lap_number": 1, "gap_seconds": 0.0} for n in (1, 4, 16)]
        writes, _ = self._sync([
            {"round": "2", "laps": stored},
            {"round": "17", "source": "openf1", "laps": stored},
        ])
        self.assertEqual(writes, [])


if __name__ == "__main__":
    unittest.main()
