import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# race_timing imports motor (via db.py) at module scope; these tests never
# touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import race_timing


# A three-lap race with two drivers, chosen so every boundary is a round number
# and every expected `t_ms` below can be worked out by hand.
#
# Car 1 leads: it starts lap 1 at 12:00:00 and crosses the line at 12:01:30,
# 12:03:00 and 12:04:30 — three 90-second laps. Car 44 is two seconds behind
# throughout, which is what proves the boundaries come from the *earliest*
# crossing rather than from whichever driver's rows happen to be seen first.
LAP_ROWS = [
    {"driver_number": 44, "lap_number": 1, "date_start": "2026-03-08T12:00:02", "lap_duration": 93.0},
    {"driver_number": 44, "lap_number": 2, "date_start": "2026-03-08T12:01:35", "lap_duration": 90.0},
    {"driver_number": 44, "lap_number": 3, "date_start": "2026-03-08T12:03:05", "lap_duration": 90.0},
    {"driver_number": 1, "lap_number": 1, "date_start": "2026-03-08T12:00:00", "lap_duration": 90.0},
    {"driver_number": 1, "lap_number": 2, "date_start": "2026-03-08T12:01:30", "lap_duration": 90.0},
    {"driver_number": 1, "lap_number": 3, "date_start": "2026-03-08T12:03:00", "lap_duration": 90.0},
]

RACE_START = "2026-03-08T12:00:00"
LAST_BOUNDARY = "2026-03-08T12:04:30"


def interval_row(date, driver_number=44, interval=1.0, gap_to_leader=2.0):
    return {
        "driver_number": driver_number,
        "date": date,
        "interval": interval,
        "gap_to_leader": gap_to_leader,
    }


def position_row(date, driver_number=44, position=2):
    return {"driver_number": driver_number, "date": date, "position": position}


class LeaderBoundaryTests(unittest.TestCase):
    """The timeline is derived from the earliest crossing per lap, which is the
    leader's crossing by definition — no `/position` lookup involved."""

    def test_boundaries_are_the_earliest_crossing_of_each_lap(self):
        boundaries, lap_one = race_timing._leader_boundaries(LAP_ROWS)

        self.assertEqual(sorted(boundaries), [1, 2, 3])
        self.assertEqual(boundaries[1].isoformat(), "2026-03-08T12:01:30")
        self.assertEqual(boundaries[2].isoformat(), "2026-03-08T12:03:00")
        self.assertEqual(boundaries[3].isoformat(), LAST_BOUNDARY)
        # Read off the driver who actually set that earliest lap-1 crossing —
        # car 1's 90s, not car 44's 93s.
        self.assertEqual(lap_one, 90.0)

    def test_lap_one_starts_a_leader_lap_duration_before_its_boundary(self):
        boundaries, lap_one = race_timing._leader_boundaries(LAP_ROWS)

        spans = race_timing._lap_spans(boundaries, lap_one)

        self.assertEqual(spans[0][0].isoformat(), RACE_START)
        self.assertEqual([span[2] for span in spans], [90.0, 90.0, 90.0])
        self.assertEqual([span[3] for span in spans], [0.0, 90.0, 180.0])

    def test_lap_one_is_dropped_rather_than_guessed_without_its_duration(self):
        """Without the leader's own lap-1 duration there is no race start, and
        inventing one would shift every sample in the race invisibly."""
        boundaries, _ = race_timing._leader_boundaries(LAP_ROWS)

        spans = race_timing._lap_spans(boundaries, None)

        self.assertEqual(len(spans), 2)
        self.assertEqual(spans[0][0].isoformat(), "2026-03-08T12:01:30")


class AnchoringTests(unittest.TestCase):
    def _drivers(self, intervals=(), positions=()):
        return race_timing.build_timing(LAP_ROWS, list(intervals), list(positions))

    def test_a_mid_lap_sample_lands_at_its_hand_computed_elapsed_time(self):
        """12:03:45 is halfway through lap 3. Two laps of 90s have already
        elapsed, plus 45s into this one: 225.000s exactly."""
        drivers = self._drivers(positions=[position_row("2026-03-08T12:03:45")])

        self.assertEqual(drivers["44"]["positions"], [[225000, 2]])

    def test_the_race_start_instant_anchors_to_zero(self):
        drivers = self._drivers(positions=[position_row(RACE_START)])

        self.assertEqual(drivers["44"]["positions"][0][0], 0)

    def test_the_final_crossing_is_kept_rather_than_falling_off_the_end(self):
        """The last span is closed at the top — there is no following lap to
        claim the instant, so a half-open interval would silently discard the
        chequered-flag sample."""
        drivers = self._drivers(positions=[position_row(LAST_BOUNDARY)])

        self.assertEqual(drivers["44"]["positions"], [[270000, 2]])

    def test_samples_outside_every_lap_are_dropped_not_clamped(self):
        """Grid-formation events sit well before lights out. Clamping them to
        t=0 would render as a phantom position shuffle the instant the race
        starts, so they are dropped — here that leaves the driver with nothing
        and therefore out of `drivers` entirely."""
        drivers = self._drivers(positions=[
            position_row("2026-03-08T11:45:00"),   # long before lap 1 started
            position_row("2026-03-08T12:10:00"),   # after the final crossing
        ])

        self.assertEqual(drivers, {})

    def test_an_in_race_sample_survives_alongside_dropped_ones(self):
        drivers = self._drivers(positions=[
            position_row("2026-03-08T11:45:00"),
            position_row("2026-03-08T12:03:45"),
            position_row("2026-03-08T12:10:00"),
        ])

        self.assertEqual(drivers["44"]["positions"], [[225000, 2]])


class ValuePassthroughTests(unittest.TestCase):
    def test_a_string_gap_survives_verbatim(self):
        """`"+1 LAP"` is broadcast semantics for a lapped car, not corrupt data
        — roughly a fifth of real `gap_to_leader` values. Parsing or dropping it
        would blank the gap column for most of the field for most of the race."""
        drivers = race_timing.build_timing(
            LAP_ROWS,
            [interval_row("2026-03-08T12:03:45", gap_to_leader="+1 LAP")],
            [],
        )

        self.assertEqual(drivers["44"]["timing"], [[225000, 1.0, "+1 LAP"]])

    def test_a_string_interval_survives_verbatim_too(self):
        drivers = race_timing.build_timing(
            LAP_ROWS,
            [interval_row("2026-03-08T12:03:45", interval="+2 LAPS", gap_to_leader="+2 LAPS")],
            [],
        )

        self.assertEqual(drivers["44"]["timing"][0][1], "+2 LAPS")

    def test_a_none_gap_stays_none_and_keeps_its_row(self):
        """`null` is "not reported at this instant" — a real state the sample
        still belongs in the series for."""
        drivers = race_timing.build_timing(
            LAP_ROWS,
            [interval_row("2026-03-08T12:03:45", interval=None, gap_to_leader=None)],
            [],
        )

        self.assertEqual(drivers["44"]["timing"], [[225000, None, None]])

    def test_floats_are_rounded_to_two_decimals(self):
        drivers = race_timing.build_timing(
            LAP_ROWS,
            [interval_row("2026-03-08T12:03:45", interval=1.2340000000000002, gap_to_leader=9.876)],
            [],
        )

        self.assertEqual(drivers["44"]["timing"][0][1], 1.23)
        self.assertEqual(drivers["44"]["timing"][0][2], 9.88)


class ShapeTests(unittest.TestCase):
    def test_arrays_are_sorted_ascending_by_t_ms(self):
        drivers = race_timing.build_timing(
            LAP_ROWS,
            [
                interval_row("2026-03-08T12:04:00"),
                interval_row("2026-03-08T12:00:30"),
                interval_row("2026-03-08T12:02:00"),
            ],
            [
                position_row("2026-03-08T12:04:00"),
                position_row("2026-03-08T12:00:30", position=3),
            ],
        )

        timing_times = [sample[0] for sample in drivers["44"]["timing"]]
        position_times = [sample[0] for sample in drivers["44"]["positions"]]
        self.assertEqual(timing_times, sorted(timing_times))
        self.assertEqual(position_times, sorted(position_times))
        self.assertEqual(timing_times, [30000, 120000, 240000])

    def test_every_sample_has_the_arity_the_contract_states(self):
        """Key parity: a triple for timing, a pair for positions, always."""
        drivers = race_timing.build_timing(
            LAP_ROWS,
            [interval_row("2026-03-08T12:02:00"), interval_row("2026-03-08T12:03:00", driver_number=1)],
            [position_row("2026-03-08T12:02:00"), position_row("2026-03-08T12:03:00", driver_number=1, position=1)],
        )

        self.assertEqual(set(drivers), {"1", "44"})
        for entry in drivers.values():
            self.assertEqual(set(entry), {"timing", "positions"})
            for sample in entry["timing"]:
                self.assertEqual(len(sample), 3)
                self.assertIsInstance(sample[0], int)
            for sample in entry["positions"]:
                self.assertEqual(len(sample), 2)
                self.assertIsInstance(sample[0], int)
                self.assertIsInstance(sample[1], int)

    def test_a_driver_with_no_anchorable_samples_is_absent_entirely(self):
        """Absent, not present-with-empty-arrays: a driver in `drivers` always
        means there is something to draw."""
        drivers = race_timing.build_timing(
            LAP_ROWS,
            [interval_row("2026-03-08T12:02:00", driver_number=1)],
            [position_row("2026-03-08T11:30:00", driver_number=44)],
        )

        self.assertEqual(set(drivers), {"1"})

    def test_empty_inputs_produce_an_empty_map_rather_than_raising(self):
        """"No data" is a normal state of the world here — the endpoint reports
        it as `synced: false`, and there is nothing a raise could add."""
        self.assertEqual(race_timing.build_timing([], [], []), {})
        self.assertEqual(race_timing.build_timing(LAP_ROWS, [], []), {})
        self.assertEqual(race_timing.build_timing([], [interval_row(RACE_START)], []), {})

    def test_malformed_rows_are_skipped_without_taking_the_build_down(self):
        drivers = race_timing.build_timing(
            LAP_ROWS,
            [
                {"driver_number": None, "date": "2026-03-08T12:02:00", "interval": 1.0},
                {"driver_number": 44, "date": "not a timestamp", "interval": 1.0},
                interval_row("2026-03-08T12:02:00"),
            ],
            [{"driver_number": 44, "date": "2026-03-08T12:02:00", "position": None}],
        )

        self.assertEqual(drivers["44"]["timing"], [[120000, 1.0, 2.0]])
        self.assertEqual(drivers["44"]["positions"], [])


if __name__ == "__main__":
    unittest.main()
