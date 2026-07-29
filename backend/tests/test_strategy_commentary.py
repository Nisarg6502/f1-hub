import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# strategy_commentary imports motor (via db.py) at module scope; these tests
# never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import strategy_commentary


RACE = {
    "raceName": "British Grand Prix",
    "season": "2026",
    "round": "9",
    "Circuit": {"circuitName": "Silverstone"},
}


def result_row(number, driver_id, given, family, team="Mercedes", position="1"):
    return {
        "number": number,
        "position": position,
        "grid": position,
        "status": "Finished",
        "Driver": {"driverId": driver_id, "code": family[:3].upper(), "givenName": given, "familyName": family},
        "Constructor": {"name": team},
    }


RESULTS = [
    result_row("12", "antonelli", "Kimi", "Antonelli", position="1"),
    result_row("23", "albon", "Alexander", "Albon", team="Williams", position="2"),
]


class StintsByNumberTests(unittest.TestCase):
    def test_groups_and_sorts_by_stint_number(self):
        stints = [
            {"driver_number": 23, "stint_number": 2, "lap_start": 20, "lap_end": 40, "compound": "HARD"},
            {"driver_number": 23, "stint_number": 1, "lap_start": 1, "lap_end": 19, "compound": "MEDIUM"},
        ]

        by_number = strategy_commentary._stints_by_number(stints)

        self.assertEqual([s["stint_number"] for s in by_number["23"]], [1, 2])

    def test_a_stint_without_a_driver_number_is_skipped(self):
        stints = [{"driver_number": None, "stint_number": 1, "lap_start": 1, "lap_end": 5, "compound": "SOFT"}]

        self.assertEqual(strategy_commentary._stints_by_number(stints), {})


class StintFactsTests(unittest.TestCase):
    def test_computes_stint_length_and_stop_count(self):
        directory = strategy_commentary._driver_directory(RESULTS)
        stints_by_number = {
            "23": [
                {"stint_number": 1, "lap_start": 1, "lap_end": 19, "compound": "MEDIUM"},
                {"stint_number": 2, "lap_start": 20, "lap_end": 52, "compound": "HARD"},
            ]
        }

        facts = strategy_commentary._stint_facts(directory, stints_by_number)

        albon = facts[0]
        self.assertEqual(albon["driver"], "Alexander Albon")
        self.assertEqual(albon["team"], "Williams")
        self.assertEqual(albon["stops"], 1)
        self.assertEqual(albon["stints"][0]["length"], 19)
        self.assertEqual(albon["stints"][1]["length"], 33)


class StrategyOutlierTests(unittest.TestCase):
    def test_a_driver_off_the_fields_common_stop_count_is_flagged(self):
        stint_facts = [
            {"driver": "A", "team": "T1", "stops": 2, "stints": [1, 2, 3]},
            {"driver": "B", "team": "T2", "stops": 2, "stints": [1, 2, 3]},
            {"driver": "C", "team": "T3", "stops": 1, "stints": [1, 2]},
        ]

        outliers = strategy_commentary._strategy_outliers(stint_facts)

        self.assertEqual(len(outliers), 1)
        self.assertEqual(outliers[0]["driver"], "C")
        self.assertEqual(outliers[0]["field_common_stops"], 2)

    def test_no_outliers_when_the_field_agrees(self):
        stint_facts = [
            {"driver": "A", "team": "T1", "stops": 2, "stints": [1, 2, 3]},
            {"driver": "B", "team": "T2", "stops": 2, "stints": [1, 2, 3]},
        ]

        self.assertEqual(strategy_commentary._strategy_outliers(stint_facts), [])

    def test_empty_input_produces_no_outliers(self):
        self.assertEqual(strategy_commentary._strategy_outliers([]), [])


class UndercutOvercutTests(unittest.TestCase):
    """The relational fact this whole module exists to get right in Python
    rather than leave to the model: who gained track position around a pit
    window, and whether that's attributable to pitting first or staying out.
    """

    def _directory(self):
        return strategy_commentary._driver_directory(RESULTS)

    def test_the_earlier_stopper_undercutting_the_later_one(self):
        # 23 (Albon) is behind 12 (Antonelli) before the window, pits first,
        # and is ahead of 12 a few laps after 12 also pits -- a textbook
        # undercut by the earlier stopper.
        laps_index = {
            ("23", 19): {"position": 2},
            ("12", 19): {"position": 1},
            ("23", 23): {"position": 1},
            ("12", 23): {"position": 2},
        }
        driver_stops = [
            {"number": "23", "lap": 20, "stop_number": 1},
            {"number": "12", "lap": 21, "stop_number": 1},
        ]

        events = strategy_commentary._undercut_overcut_events(driver_stops, laps_index, self._directory())

        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["outcome"], "undercut")
        self.assertEqual(event["gainer"], "Alexander Albon")
        self.assertEqual(event["loser"], "Kimi Antonelli")
        self.assertEqual(event["earlier_stop"]["lap"], 20)
        self.assertEqual(event["later_stop"]["lap"], 21)

    def test_the_later_stopper_overcutting_the_earlier_one(self):
        # 23 pits first but is BEHIND 12 after the window closes -- 12 (who
        # stayed out longer) came out ahead: an overcut.
        laps_index = {
            ("23", 19): {"position": 1},
            ("12", 19): {"position": 2},
            ("23", 23): {"position": 2},
            ("12", 23): {"position": 1},
        }
        driver_stops = [
            {"number": "23", "lap": 20, "stop_number": 1},
            {"number": "12", "lap": 21, "stop_number": 1},
        ]

        events = strategy_commentary._undercut_overcut_events(driver_stops, laps_index, self._directory())

        self.assertEqual(events[0]["outcome"], "overcut")
        self.assertEqual(events[0]["gainer"], "Kimi Antonelli")

    def test_no_order_change_produces_no_event(self):
        laps_index = {
            ("23", 19): {"position": 2},
            ("12", 19): {"position": 1},
            ("23", 23): {"position": 2},
            ("12", 23): {"position": 1},
        }
        driver_stops = [
            {"number": "23", "lap": 20, "stop_number": 1},
            {"number": "12", "lap": 21, "stop_number": 1},
        ]

        events = strategy_commentary._undercut_overcut_events(driver_stops, laps_index, self._directory())

        self.assertEqual(events, [])

    def test_stops_outside_the_window_are_not_compared(self):
        driver_stops = [
            {"number": "23", "lap": 15, "stop_number": 1},
            {"number": "12", "lap": 40, "stop_number": 1},
        ]

        events = strategy_commentary._undercut_overcut_events(driver_stops, {}, self._directory())

        self.assertEqual(events, [])

    def test_missing_position_data_is_skipped_rather_than_guessed(self):
        laps_index = {
            ("23", 19): {"position": 2},
            ("12", 19): {"position": 1},
            # No rows for lap 23 at all.
        }
        driver_stops = [
            {"number": "23", "lap": 20, "stop_number": 1},
            {"number": "12", "lap": 21, "stop_number": 1},
        ]

        events = strategy_commentary._undercut_overcut_events(driver_stops, laps_index, self._directory())

        self.assertEqual(events, [])

    def test_same_driver_stops_are_never_compared_to_themselves(self):
        driver_stops = [
            {"number": "23", "lap": 20, "stop_number": 1},
            {"number": "23", "lap": 40, "stop_number": 2},
        ]

        events = strategy_commentary._undercut_overcut_events(driver_stops, {}, self._directory())

        self.assertEqual(events, [])


class DriverStopsByNumberTests(unittest.TestCase):
    def test_resolves_driver_id_to_car_number_and_sorts_by_lap(self):
        stops = [
            {"driver_id": "antonelli", "lap": 21, "stop": 1},
            {"driver_id": "albon", "lap": 20, "stop": 1},
        ]
        number_by_id = {"albon": "23", "antonelli": "12"}

        resolved = strategy_commentary._driver_stops_by_number(stops, number_by_id)

        self.assertEqual([r["number"] for r in resolved], ["23", "12"])

    def test_an_unmatched_driver_id_is_dropped(self):
        stops = [{"driver_id": "nobody", "lap": 20, "stop": 1}]

        self.assertEqual(strategy_commentary._driver_stops_by_number(stops, {"albon": "23"}), [])


class BuildFactsTests(unittest.TestCase):
    def test_assembles_the_full_bundle(self):
        stints = [
            {"driver_number": 12, "stint_number": 1, "lap_start": 1, "lap_end": 21, "compound": "MEDIUM"},
            {"driver_number": 12, "stint_number": 2, "lap_start": 22, "lap_end": 52, "compound": "HARD"},
            {"driver_number": 23, "stint_number": 1, "lap_start": 1, "lap_end": 19, "compound": "MEDIUM"},
            {"driver_number": 23, "stint_number": 2, "lap_start": 20, "lap_end": 52, "compound": "HARD"},
        ]
        stops = [
            {"driver_id": "antonelli", "lap": 22, "stop": 1},
            {"driver_id": "albon", "lap": 20, "stop": 1},
        ]
        laps = [
            {"driver_number": 23, "lap_number": 19, "position": 2},
            {"driver_number": 12, "lap_number": 19, "position": 1},
            {"driver_number": 23, "lap_number": 24, "position": 1},
            {"driver_number": 12, "lap_number": 24, "position": 2},
        ]

        facts = strategy_commentary.build_facts(RACE, RESULTS, stints, stops, laps)

        self.assertEqual(facts["race_name"], "British Grand Prix")
        self.assertEqual(facts["field_size"], 2)
        self.assertEqual(facts["field_common_stops"], 1)
        self.assertEqual(facts["strategy_outliers"], [])
        self.assertEqual(len(facts["undercut_overcut_events"]), 1)
        self.assertEqual(facts["undercut_overcut_events"][0]["outcome"], "undercut")
        self.assertIn("MEDIUM", facts["compound_usage"])

    def test_empty_sources_produce_an_empty_but_well_formed_bundle(self):
        facts = strategy_commentary.build_facts(RACE, [], [], [], [])

        self.assertEqual(facts["stints"], [])
        self.assertEqual(facts["strategy_outliers"], [])
        self.assertEqual(facts["undercut_overcut_events"], [])
        self.assertEqual(facts["field_size"], 0)
        self.assertIsNone(facts["field_common_stops"])


if __name__ == "__main__":
    unittest.main()
