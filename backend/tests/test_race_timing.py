import datetime
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

from app import official_laps, race_timing


# A three-lap race with two drivers, chosen so every number below can be worked
# out by hand.
#
# Car 1 leads and laps in 90s flat: it crosses at 90s, 180s and 270s. Car 44 is
# 2s behind at the end of lap 1 and holds that: 92s, 182s, 272s. Lights out is
# 12:00:00 in wall-clock terms.
#
# The official record is the spine, so it — not OpenF1 — decides positions at
# every crossing.
OFFICIAL_ROWS = [
    {"lap": 1, "timings": [
        {"driverId": "verstappen", "position": 1, "cumulative_ms": 90_000},
        {"driverId": "hamilton", "position": 2, "cumulative_ms": 92_000},
    ]},
    {"lap": 2, "timings": [
        {"driverId": "verstappen", "position": 1, "cumulative_ms": 180_000},
        {"driverId": "hamilton", "position": 2, "cumulative_ms": 182_000},
    ]},
    {"lap": 3, "timings": [
        {"driverId": "verstappen", "position": 1, "cumulative_ms": 270_000},
        {"driverId": "hamilton", "position": 2, "cumulative_ms": 272_000},
    ]},
]

DRIVER_NUMBERS = {"verstappen": "1", "hamilton": "44"}

# OpenF1's wall-clock crossings for the same race. Every lap implies the same
# lights-out instant, 12:00:00.
# Stamped `+00:00` deliberately. OpenF1's real rows carry an offset, and a naive
# string here would be read in the runner's local zone — which silently moves
# lights out by hours and makes every anchoring assertion below meaningless in a
# way that looks like a logic failure.
LAP_ROWS = [
    {"driver_number": 1, "lap_number": 1, "date_start": "2026-03-08T12:00:00+00:00", "lap_duration": 90.0},
    {"driver_number": 1, "lap_number": 2, "date_start": "2026-03-08T12:01:30+00:00", "lap_duration": 90.0},
    {"driver_number": 1, "lap_number": 3, "date_start": "2026-03-08T12:03:00+00:00", "lap_duration": 90.0},
    {"driver_number": 44, "lap_number": 1, "date_start": "2026-03-08T12:00:00+00:00", "lap_duration": 92.0},
    {"driver_number": 44, "lap_number": 2, "date_start": "2026-03-08T12:01:32+00:00", "lap_duration": 90.0},
    {"driver_number": 44, "lap_number": 3, "date_start": "2026-03-08T12:03:02+00:00", "lap_duration": 90.0},
]

RACE_START = datetime.datetime(2026, 3, 8, 12, 0, 0, tzinfo=datetime.timezone.utc)


def at(seconds: float) -> str:
    """A wall-clock ISO stamp `seconds` after lights out."""
    return (RACE_START + datetime.timedelta(seconds=seconds)).isoformat()


def interval_row(date, driver_number=44, interval=1.0, gap_to_leader=2.0):
    return {
        "driver_number": driver_number,
        "date": date,
        "interval": interval,
        "gap_to_leader": gap_to_leader,
    }


def position_row(date, driver_number=44, position=2):
    return {"driver_number": driver_number, "date": date, "position": position}


def build(**overrides):
    kwargs = {
        "official_rows": OFFICIAL_ROWS,
        "driver_numbers": DRIVER_NUMBERS,
        "lap_rows": LAP_ROWS,
        "interval_rows": [],
        "position_rows": [],
        "grid_positions": None,
    }
    kwargs.update(overrides)
    return race_timing.build_timing(**kwargs)


class OfficialSkeletonTests(unittest.TestCase):
    """Positions at line crossings come from the official record and nowhere else."""

    def test_each_driver_is_stamped_at_their_own_crossing_not_the_leaders(self):
        samples, _, _ = race_timing.official_samples(OFFICIAL_ROWS, DRIVER_NUMBERS)
        # Car 44 finishes lap 1 at 92s, two seconds after the leader. Stamping
        # the whole field at the leader's instant is what made the old tower
        # snap the entire order at once, once a lap.
        self.assertEqual(samples["44"][0], [92_000, 2])
        self.assertEqual(samples["1"][0], [90_000, 1])

    def test_lap_durations_are_the_leaders_and_index_align_to_lap_one(self):
        _, lap_ms, _ = race_timing.official_samples(OFFICIAL_ROWS, DRIVER_NUMBERS)
        self.assertEqual(lap_ms, [90_000, 90_000, 90_000])

    def test_a_driver_with_no_car_number_is_skipped_not_keyed_by_driver_id(self):
        # A mixed-key map joins against nothing else in the app and fails far
        # more quietly than an absent driver does.
        samples, _, _ = race_timing.official_samples(
            OFFICIAL_ROWS, {"verstappen": "1"}
        )
        self.assertEqual(set(samples), {"1"})

    def test_the_official_order_wins_over_a_contradicting_openf1_sample(self):
        # This is the Australian GP defect in miniature: OpenF1 claims car 44
        # leads at the lap-2 crossing, the official record says car 1 does.
        drivers = build(position_rows=[position_row(at(180), driver_number=44, position=1)])
        positions = drivers["drivers"]["44"]["positions"]
        # The bad claim is shown while it stands — that is the intra-lap fill
        # doing its job — and is corrected the instant car 44 crosses the line.
        self.assertIn([180_000, 1], positions)
        self.assertIn([182_000, 2], positions)

    def test_an_openf1_sample_between_crossings_survives(self):
        # The whole point of the module: intra-lap movement must reach the tower.
        drivers = build(position_rows=[position_row(at(120), driver_number=44, position=1)])
        self.assertIn([120_000, 1], drivers["drivers"]["44"]["positions"])


class RaceStartTests(unittest.TestCase):
    """Lights out is measured against the official record, robustly."""

    def test_the_start_is_the_offset_the_laps_agree_on(self):
        _, _, leader = race_timing.official_samples(OFFICIAL_ROWS, DRIVER_NUMBERS)
        start = race_timing.race_start_offset(LAP_ROWS, leader)
        self.assertEqual(start, RACE_START)

    def test_a_single_wildly_wrong_lap_is_outvoted(self):
        # Round 1 really does have laps whose implied start is 30s out, because
        # OpenF1 is missing crossings for the leading cars there. The median must
        # not follow them.
        rows = [dict(row) for row in LAP_ROWS]
        rows.append(
            {"driver_number": 77, "lap_number": 2, "date_start": "2026-03-08T11:59:00+00:00"}
        )
        _, _, leader = race_timing.official_samples(OFFICIAL_ROWS, DRIVER_NUMBERS)
        self.assertEqual(race_timing.race_start_offset(rows, leader), RACE_START)

    def test_no_shared_lap_yields_no_start(self):
        _, _, leader = race_timing.official_samples(OFFICIAL_ROWS, DRIVER_NUMBERS)
        self.assertIsNone(race_timing.race_start_offset([], leader))

    def test_openf1_samples_are_dropped_when_the_start_is_unknown(self):
        # Without a start there is no way to place a wall-clock sample, and
        # guessing one is how the opening of every race ended up 90s out.
        drivers = build(lap_rows=[], position_rows=[position_row(at(120), position=1)])
        positions = drivers["drivers"]["44"]["positions"]
        self.assertNotIn([120_000, 1], positions)
        # The official skeleton still stands on its own. Car 44 holds P2 from
        # its first crossing to the flag, so `_collapse_positions` reduces that
        # to the single sample which states it.
        self.assertEqual(positions, [[92_000, 2]])


class WindowTests(unittest.TestCase):
    """Samples outside the race are dropped, never clamped."""

    def test_a_pre_race_sample_is_dropped(self):
        # OpenF1's feeds run through grid formation and the reconnaissance laps.
        # Clamping those to t=0 renders as a phantom shuffle at lights out.
        drivers = build(position_rows=[position_row(at(-120), position=1)])
        self.assertNotIn(1, [s[1] for s in drivers["drivers"]["44"]["positions"]])

    def test_a_sample_after_the_final_crossing_is_dropped(self):
        # A position claim 128s after the flag — OpenF1's `/position` feed keeps
        # emitting through the slow-down lap, and on Monaco it walks a car from
        # P3 to P7 in the six seconds after it finishes.
        drivers = build(position_rows=[position_row(at(400), position=1)])
        positions = drivers["drivers"]["44"]["positions"]
        self.assertLessEqual(max(sample[0] for sample in positions), 272_000)
        self.assertNotIn(1, [sample[1] for sample in positions])

    def test_the_last_state_is_the_official_finishing_order(self):
        drivers = build()
        self.assertEqual(drivers["drivers"]["1"]["positions"][-1][1], 1)
        self.assertEqual(drivers["drivers"]["44"]["positions"][-1][1], 2)


class OutOfRaceTests(unittest.TestCase):
    """A car that stops is marked, so consumers stop carrying it forward."""

    def retiring(self):
        """Car 44 completes lap 1 and stops; car 1 runs the full three laps."""
        return [
            {"lap": 1, "timings": [
                {"driverId": "verstappen", "position": 1, "cumulative_ms": 90_000},
                {"driverId": "hamilton", "position": 2, "cumulative_ms": 92_000},
            ]},
            {"lap": 2, "timings": [
                {"driverId": "verstappen", "position": 1, "cumulative_ms": 180_000},
            ]},
            {"lap": 3, "timings": [
                {"driverId": "verstappen", "position": 1, "cumulative_ms": 270_000},
            ]},
        ]

    def test_a_retirement_is_stamped_with_when_it_left(self):
        payload = race_timing.build_timing(self.retiring(), DRIVER_NUMBERS, LAP_ROWS, [], [], None)
        self.assertEqual(payload["drivers"]["44"]["out_ms"], 92_000)

    def test_a_car_that_took_the_flag_is_not_marked(self):
        # Including a lapped one: it is classified laps down but still crosses
        # the line at the end of the race, so its final crossing is late.
        payload = build()
        self.assertNotIn("out_ms", payload["drivers"]["1"])
        self.assertNotIn("out_ms", payload["drivers"]["44"])


class GridTests(unittest.TestCase):
    def test_the_grid_is_seeded_at_zero(self):
        drivers = build(grid_positions={"44": 1, "1": 2})
        self.assertEqual(drivers["drivers"]["44"]["positions"][0], [0, 1])

    def test_a_car_that_never_started_is_absent_even_with_openf1_rows(self):
        # Excluding it from the grid seed alone was not enough: OpenF1 emits
        # interval and position rows for cars that never started, so they
        # re-entered through the fill and sat in the running order with no tower
        # row to draw them — the rendered ranks came out 1,2,3,4,6,7,8,9,11,...
        drivers = build(
            grid_positions={"81": 5},
            position_rows=[position_row(at(100), driver_number=81, position=5)],
            interval_rows=[interval_row(at(100), driver_number=81)],
        )["drivers"]
        self.assertNotIn("81", drivers)

    def test_a_car_that_never_started_is_not_seeded_onto_its_grid_slot(self):
        # A "did not start" still holds a grid slot in the classification.
        # Seeding it parked a car on that position for the whole race, because
        # nothing ever moved it — on round 1 that put Piastri on P5 and
        # Hulkenberg on P11 permanently, duplicating every position behind them.
        drivers = build(grid_positions={"44": 1, "1": 2, "81": 5})["drivers"]
        self.assertNotIn("81", drivers)

    def test_the_grid_beats_an_openf1_event_landing_exactly_on_zero(self):
        drivers = build(
            grid_positions={"44": 1},
            position_rows=[position_row(at(0), driver_number=44, position=9)],
        )
        self.assertEqual(drivers["drivers"]["44"]["positions"][0], [0, 1])


class CollapseTests(unittest.TestCase):
    def test_a_repeated_position_is_not_emitted_twice(self):
        # OpenF1 restates a position on its own cadence whether or not it moved;
        # those runs are roughly two thirds of the raw feed.
        collapsed = race_timing._collapse_positions([[0, 3], [1000, 3], [2000, 3], [3000, 2]])
        self.assertEqual(collapsed, [[0, 3], [3000, 2]])

    def test_a_tie_keeps_the_first_inserted(self):
        self.assertEqual(race_timing._collapse_positions([[5, 1], [5, 7]]), [[5, 1]])

    def test_samples_are_sorted_by_time(self):
        collapsed = race_timing._collapse_positions([[900, 1], [100, 3], [500, 2]])
        self.assertEqual([s[0] for s in collapsed], [100, 500, 900])


class ShapeTests(unittest.TestCase):
    def test_no_official_record_yields_nothing_at_all(self):
        # Policy, not an oversight: a timeline with no exact skeleton is the
        # thing that shipped laps 1 and 2 inverted. `synced: false` degrades to
        # the lap-stepped tower, which is honest rather than wrong.
        self.assertEqual(
            race_timing.build_timing([], DRIVER_NUMBERS, LAP_ROWS, [], [], None), {}
        )

    def test_both_keys_always_exist_for_a_present_driver(self):
        drivers = build()["drivers"]
        for entry in drivers.values():
            self.assertIn("timing", entry)
            self.assertIn("positions", entry)

    def test_timing_samples_are_time_ordered_triples(self):
        drivers = build(interval_rows=[
            interval_row(at(200)), interval_row(at(100)), interval_row(at(150)),
        ])
        samples = drivers["drivers"]["44"]["timing"]
        self.assertEqual([s[0] for s in samples], [100_000, 150_000, 200_000])
        self.assertTrue(all(len(s) == 3 for s in samples))


class ValuePassthroughTests(unittest.TestCase):
    def test_a_lapped_cars_gap_string_reaches_the_client_verbatim(self):
        drivers = build(interval_rows=[interval_row(at(100), gap_to_leader="+1 LAP")])
        self.assertEqual(drivers["drivers"]["44"]["timing"][0][2], "+1 LAP")

    def test_floats_are_rounded_to_two_places(self):
        drivers = build(interval_rows=[interval_row(at(100), interval=1.2340000000000002)])
        self.assertEqual(drivers["drivers"]["44"]["timing"][0][1], 1.23)

    def test_none_stays_none(self):
        drivers = build(interval_rows=[interval_row(at(100), interval=None)])
        self.assertIsNone(drivers["drivers"]["44"]["timing"][0][1])

    def test_a_boolean_is_not_emitted_as_one(self):
        self.assertIsNone(race_timing._round_value(True))


class OfficialLapParsingTests(unittest.TestCase):
    def test_lap_times_accumulate_into_elapsed_race_time(self):
        page = {"MRData": {"RaceTable": {"Races": [{"Laps": [
            {"number": "1", "Timings": [{"driverId": "leclerc", "position": "1", "time": "1:31.929"}]},
            {"number": "2", "Timings": [{"driverId": "leclerc", "position": "2", "time": "1:26.212"}]},
        ]}]}}}
        laps = official_laps.parse_lap_pages([page])
        self.assertEqual(laps[0]["timings"][0]["cumulative_ms"], 91_929)
        self.assertEqual(laps[1]["timings"][0]["cumulative_ms"], 178_141)

    def test_an_unparseable_lap_time_costs_only_that_entry(self):
        page = {"MRData": {"RaceTable": {"Races": [{"Laps": [
            {"number": "1", "Timings": [
                {"driverId": "leclerc", "position": "1", "time": "boom"},
                {"driverId": "russell", "position": "2", "time": "1:32.694"},
            ]},
        ]}]}}}
        laps = official_laps.parse_lap_pages([page])
        self.assertEqual([t["driverId"] for t in laps[0]["timings"]], ["russell"])

    def test_seconds_only_and_hour_forms_both_parse(self):
        self.assertAlmostEqual(official_laps._lap_seconds("31.929"), 31.929)
        self.assertAlmostEqual(official_laps._lap_seconds("1:00:01.5"), 3601.5)


class RegressionTests(unittest.TestCase):
    """The 2026 Australian GP, laps 1 and 2, as reported by the user.

    Official: Leclerc leads lap 1, Russell leads lap 2, Leclerc leads lap 3.
    Confirmed independently by cumulative lap times (RUS 177.701s vs LEC
    178.141s at the end of lap 2). The shipped payload had 1 and 2 inverted.
    """

    OFFICIAL = [
        {"lap": 1, "timings": [
            {"driverId": "leclerc", "position": 1, "cumulative_ms": 91_929},
            {"driverId": "russell", "position": 2, "cumulative_ms": 92_694},
        ]},
        {"lap": 2, "timings": [
            {"driverId": "russell", "position": 1, "cumulative_ms": 177_701},
            {"driverId": "leclerc", "position": 2, "cumulative_ms": 178_141},
        ]},
        {"lap": 3, "timings": [
            {"driverId": "leclerc", "position": 1, "cumulative_ms": 263_594},
            {"driverId": "russell", "position": 2, "cumulative_ms": 264_145},
        ]},
    ]
    NUMBERS = {"leclerc": "16", "russell": "63"}

    def order_at(self, drivers, ms):
        out = []
        for number, entry in drivers.items():
            position = None
            for sample in entry["positions"]:
                if sample[0] <= ms:
                    position = sample[1]
                else:
                    break
            if position is not None:
                out.append((position, number))
        return [number for _, number in sorted(out)]

    def test_the_lead_changes_hands_exactly_as_the_official_record_says(self):
        payload = race_timing.build_timing(self.OFFICIAL, self.NUMBERS, [], [], [], None)
        drivers = payload["drivers"]
        # Read once both cars have crossed, which is when the lap's order is
        # fully expressed. **In the 0.44s between Russell's crossing and
        # Leclerc's, both legitimately read P1** — each is stamped with the
        # position they held at their own line crossing, and Leclerc has not yet
        # reached his. That transient is inherent to per-driver stamping and is
        # the honest rendering: the alternative, stamping the whole field at the
        # leader's instant, snaps the entire order at once and is exactly the
        # once-a-lap behaviour this module exists to remove.
        self.assertEqual(self.order_at(drivers, 92_694), ["16", "63"])
        self.assertEqual(self.order_at(drivers, 178_141), ["63", "16"])
        self.assertEqual(self.order_at(drivers, 264_145), ["16", "63"])

    def test_openf1_cannot_invert_a_lap_it_disagrees_with(self):
        # OpenF1's own crossings put Leclerc 0.56s ahead at the end of lap 2,
        # where the official times have Russell ahead by 0.44s. The official
        # record must win.
        start = datetime.datetime(2026, 3, 8, 4, 4, 50, tzinfo=datetime.timezone.utc)
        lap_rows = [
            {"driver_number": 16, "lap_number": 1, "date_start": start.isoformat()},
            {"driver_number": 16, "lap_number": 2,
             "date_start": (start + datetime.timedelta(seconds=91.929)).isoformat()},
        ]
        payload = race_timing.build_timing(
            self.OFFICIAL, self.NUMBERS, lap_rows,
            [],
            [{"driver_number": 16, "position": 1,
              "date": (start + datetime.timedelta(seconds=170)).isoformat()}],
            None,
        )
        self.assertEqual(self.order_at(payload["drivers"], 178_141), ["63", "16"])


if __name__ == "__main__":
    unittest.main()
