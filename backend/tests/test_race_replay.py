import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# race_replay imports motor (via db.py) at module scope; these tests never
# touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import race_replay


RACE = {"raceName": "British Grand Prix", "Circuit": {"circuitName": "Silverstone"}, "date": "2026-07-05"}


def result_row(number, driver_id, given, family, team="Mercedes", position="1", grid="2", status="Finished"):
    return {
        "number": number,
        "position": position,
        "grid": grid,
        "status": status,
        "Driver": {"driverId": driver_id, "code": family[:3].upper(), "givenName": given, "familyName": family},
        "Constructor": {"name": team},
    }


RESULTS = [
    result_row("23", "albon", "Alexander", "Albon", team="Williams", position="2", grid="4"),
    result_row("12", "antonelli", "Kimi", "Antonelli", position="1", grid="1"),
]


class DriverDirectoryTests(unittest.TestCase):
    def test_keys_by_car_number_and_keeps_the_driver_id(self):
        directory = race_replay._driver_directory(RESULTS)

        self.assertEqual(set(directory), {"23", "12"})
        self.assertEqual(directory["23"]["driver_id"], "albon")
        self.assertEqual(directory["23"]["name"], "Alexander Albon")
        self.assertEqual(directory["23"]["team"], "Williams")

    def test_an_entry_without_a_number_is_skipped(self):
        directory = race_replay._driver_directory([result_row("", "ghost", "No", "Number")])

        self.assertEqual(directory, {})


class DriverIdBridgeTests(unittest.TestCase):
    """The join this whole module exists to get right.

    pit_stops keys on driver_id ("albon"); race_laps/race_stints key on
    driver_number (23). Getting this wrong drops every pit marker silently.
    """

    def test_maps_every_driver_id_to_its_car_number(self):
        bridge = race_replay._number_by_driver_id(race_replay._driver_directory(RESULTS))

        self.assertEqual(bridge, {"albon": "23", "antonelli": "12"})

    def test_a_pit_stop_is_attached_to_the_matching_car_number(self):
        stops = [{"driver_id": "albon", "lap": 14, "stop": 1, "duration_seconds": 2.4}]

        by_lap = race_replay._stops_by_lap(stops, {"albon": "23"})

        self.assertEqual(by_lap[("23", 14)]["duration_seconds"], 2.4)

    def test_an_unmatched_driver_id_is_dropped_rather_than_guessed(self):
        stops = [{"driver_id": "nobody", "lap": 14, "stop": 1, "duration_seconds": 2.4}]

        by_lap = race_replay._stops_by_lap(stops, {"albon": "23"})

        self.assertEqual(by_lap, {})


class TyreExpansionTests(unittest.TestCase):
    def test_a_stint_range_is_expanded_to_one_entry_per_lap(self):
        stints = [{"driver_number": 23, "stint_number": 1, "lap_start": 1, "lap_end": 3, "compound": "MEDIUM", "tyre_age_at_start": 0}]

        by_lap = race_replay._compound_by_lap(stints)

        self.assertEqual(sorted(by_lap), [("23", 1), ("23", 2), ("23", 3)])
        self.assertEqual(by_lap[("23", 1)]["compound"], "MEDIUM")

    def test_tyre_age_counts_up_from_the_age_the_stint_started_on(self):
        stints = [{"driver_number": 23, "stint_number": 2, "lap_start": 10, "lap_end": 12, "compound": "HARD", "tyre_age_at_start": 5}]

        by_lap = race_replay._compound_by_lap(stints)

        self.assertEqual(by_lap[("23", 10)]["tyre_age"], 5)
        self.assertEqual(by_lap[("23", 12)]["tyre_age"], 7)


class EventsByLapTests(unittest.TestCase):
    def test_events_are_grouped_by_lap(self):
        summary = {"events": [
            {"kind": "penalty", "lap": 8, "drivers": ["Sergio Perez"], "message": "10 SECOND TIME PENALTY"},
            {"kind": "safety_car_deployed", "lap": 8, "drivers": [], "message": "SAFETY CAR DEPLOYED"},
        ]}

        by_lap = race_replay._events_by_lap(summary)

        self.assertEqual(len(by_lap[8]), 2)

    def test_an_event_with_no_lap_is_dropped(self):
        summary = {"events": [{"kind": "penalty", "lap": None, "drivers": [], "message": "X"}]}

        self.assertEqual(race_replay._events_by_lap(summary), {})


class BuildReplayTests(unittest.TestCase):
    def _replay(self):
        laps = [
            {"driver_number": 12, "lap_number": 1, "position": 1, "gap_seconds": 0.0},
            {"driver_number": 23, "lap_number": 1, "position": 2, "gap_seconds": 1.5},
            {"driver_number": 12, "lap_number": 2, "position": 1, "gap_seconds": 0.0},
            {"driver_number": 23, "lap_number": 2, "position": 2, "gap_seconds": 2.1},
        ]
        stints = [
            {"driver_number": 12, "stint_number": 1, "lap_start": 1, "lap_end": 2, "compound": "SOFT", "tyre_age_at_start": 1},
            {"driver_number": 23, "stint_number": 1, "lap_start": 1, "lap_end": 2, "compound": "MEDIUM", "tyre_age_at_start": 0},
        ]
        stops = [{"driver_id": "albon", "lap": 2, "stop": 1, "duration_seconds": 2.4}]
        race_control = {"events": [{"kind": "penalty", "lap": 2, "drivers": ["Alexander Albon"], "message": "PENALTY"}]}
        return race_replay.build_replay(RACE, RESULTS, laps, stints, stops, race_control)

    def test_laps_are_indexed_and_ordered(self):
        replay = self._replay()

        self.assertEqual([lap["lap"] for lap in replay["laps"]], [1, 2])
        self.assertEqual(replay["total_laps"], 2)

    def test_runners_are_sorted_by_position(self):
        replay = self._replay()

        self.assertEqual([r["number"] for r in replay["laps"][0]["runners"]], ["12", "23"])

    def test_tyre_state_is_attached_to_each_runner(self):
        replay = self._replay()

        leader = replay["laps"][0]["runners"][0]
        self.assertEqual(leader["compound"], "SOFT")
        self.assertEqual(leader["tyre_age"], 1)

    def test_a_pit_stop_lands_on_the_right_driver_and_lap(self):
        """End-to-end version of the driver_id/driver_number join."""
        replay = self._replay()

        lap1 = {r["number"]: r for r in replay["laps"][0]["runners"]}
        lap2 = {r["number"]: r for r in replay["laps"][1]["runners"]}

        self.assertIsNone(lap1["23"]["pit"])
        self.assertEqual(lap2["23"]["pit"]["duration_seconds"], 2.4)
        self.assertIsNone(lap2["12"]["pit"])

    def test_race_control_events_land_on_their_lap(self):
        replay = self._replay()

        self.assertEqual(replay["laps"][0]["events"], [])
        self.assertEqual(replay["laps"][1]["events"][0]["kind"], "penalty")

    def test_driver_identity_is_emitted_once_not_per_lap(self):
        replay = self._replay()

        self.assertEqual(replay["drivers"]["23"]["name"], "Alexander Albon")
        # The per-lap rows carry only the number, keeping the payload flat.
        self.assertNotIn("name", replay["laps"][0]["runners"][0])

    def test_no_track_coordinates_are_emitted(self):
        """Guards the module docstring's claim: there is no GPS data to serve."""
        replay = self._replay()

        runner = replay["laps"][0]["runners"][0]
        self.assertNotIn("x", runner)
        self.assertNotIn("y", runner)


class CarryForwardFinisherTests(unittest.TestCase):
    """Every driver's last real `race_laps` row can sit before the race's
    actual final lap, for two different reasons: a classified finisher who's
    a lap down never raced the leader's final lap, and a car that retired
    stopped having any rows at all. Both are carried forward so the tower
    doesn't visibly thin out and look like a wave of retirements — but a
    retirement is tagged `retired: True` (frozen gap, no longer live) while a
    lapped finisher's carried row is indistinguishable from a real one.
    """

    RESULTS = [
        result_row("12", "antonelli", "Kimi", "Antonelli", position="1", grid="1"),
        result_row("23", "albon", "Alexander", "Albon", team="Williams", position="2", grid="4", status="Lapped"),
        result_row("44", "hamilton", "Lewis", "Hamilton", team="Ferrari", position="20", grid="10", status="Retired"),
    ]

    def _replay(self):
        laps = [
            # 44 leads lap 1, then retires — its frozen position (1) is
            # numerically as good as or better than the actively-racing
            # cars' positions on every later lap, which is exactly the case
            # that would sort it above them without the `retired`-first key.
            {"driver_number": 44, "lap_number": 1, "position": 1, "gap_seconds": 0.0},
            {"driver_number": 12, "lap_number": 1, "position": 2, "gap_seconds": 1.0},
            {"driver_number": 23, "lap_number": 1, "position": 3, "gap_seconds": 2.0},
            {"driver_number": 12, "lap_number": 2, "position": 1, "gap_seconds": 0.0},
            {"driver_number": 23, "lap_number": 2, "position": 2, "gap_seconds": 1.5},
            # 44 retires after lap 1 — no more real rows for it, ever.
            {"driver_number": 12, "lap_number": 3, "position": 1, "gap_seconds": 0.0},
            # 23 is a lap down — it never races lap 3, same as the real data.
        ]
        return race_replay.build_replay(RACE, self.RESULTS, laps, [], [], {"events": []})

    def test_a_lapped_finisher_is_carried_forward_unmarked(self):
        replay = self._replay()

        lap3 = {r["number"]: r for r in replay["laps"][2]["runners"]}
        self.assertIn("23", lap3)
        self.assertEqual(lap3["23"]["gap_seconds"], 1.5)
        self.assertEqual(lap3["23"]["position"], 2)
        self.assertIsNone(lap3["23"]["pit"])
        self.assertFalse(lap3["23"]["retired"])

    def test_a_retirement_is_carried_forward_but_tagged_retired(self):
        replay = self._replay()

        lap2 = {r["number"]: r for r in replay["laps"][1]["runners"]}
        lap3 = {r["number"]: r for r in replay["laps"][2]["runners"]}
        for lap in (lap2, lap3):
            self.assertIn("44", lap)
            self.assertTrue(lap["44"]["retired"])
            self.assertEqual(lap["44"]["gap_seconds"], 0.0)  # frozen, not live

    def test_a_retired_driver_sorts_below_every_active_runner(self):
        """44's frozen position (1) ties or beats the active runners' real
        positions on laps 2 and 3 — proving the sort is keyed on `retired`
        first, not just on the numbers themselves."""
        replay = self._replay()

        for lap in replay["laps"][1:]:
            numbers = [r["number"] for r in lap["runners"]]
            self.assertEqual(numbers[-1], "44")

    def test_the_leader_who_races_every_lap_is_unaffected(self):
        replay = self._replay()

        self.assertEqual(len(replay["laps"]), 3)
        for lap in replay["laps"]:
            self.assertIn("12", {r["number"] for r in lap["runners"]})


if __name__ == "__main__":
    unittest.main()
