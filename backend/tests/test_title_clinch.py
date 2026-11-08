import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.title_clinch import ceilings, remaining_after, title_status


class CeilingTests(unittest.TestCase):
    def test_no_fastest_lap_point_after_2024(self):
        # The bug this module fixed: the site counted 26 a race in 2026.
        self.assertEqual(ceilings(2026), (25, 8))
        self.assertEqual(ceilings(2025), (25, 8))

    def test_fastest_lap_point_2019_to_2024(self):
        self.assertEqual(ceilings(2024), (26, 8))
        self.assertEqual(ceilings(2019), (26, 0))
        self.assertEqual(ceilings(2018), (25, 0))

    def test_sprint_points_by_era(self):
        self.assertEqual(ceilings(2021), (26, 3))
        self.assertEqual(ceilings(2021, "constructor"), (44, 5))

    def test_constructor_takes_a_one_two(self):
        self.assertEqual(ceilings(2026, "constructor"), (43, 15))

    def test_older_points_systems_are_not_modelled(self):
        self.assertIsNone(ceilings(2009))
        self.assertIsNone(title_status(100, 0, 1, 0, 2009))


class RemainingTests(unittest.TestCase):
    SCHEDULE = [
        {"round": "18"}, {"round": "19"}, {"round": "20"},
        {"round": "21", "Sprint": {"date": "x"}}, {"round": "22"}, {"round": "bad"},
    ]

    def test_counts_rounds_after_the_standings_round(self):
        self.assertEqual(remaining_after(self.SCHEDULE, 19), (3, 1))
        self.assertEqual(remaining_after(self.SCHEDULE, 22), (0, 0))


class TitleStatusTests(unittest.TestCase):
    def test_2026_after_mexico_is_decided(self):
        status = title_status(380, 261, 4, 0, 2026)
        self.assertTrue(status["clinched"])
        self.assertEqual(status["points_available"], 100)
        self.assertEqual(status["gap"], 119)
        self.assertEqual(status["points_to_clinch"], 0)

    def test_equal_to_the_points_left_is_not_decided(self):
        # Level at the end goes to countback, which is not modelled.
        status = title_status(125, 25, 4, 0, 2026)
        self.assertFalse(status["clinched"])
        self.assertEqual(status["points_to_clinch"], 1)

    def test_constructors_still_open(self):
        status = title_status(500, 374, 4, 0, 2026, "constructor")
        self.assertFalse(status["clinched"])
        self.assertEqual(status["points_available"], 172)


if __name__ == "__main__":
    unittest.main()
