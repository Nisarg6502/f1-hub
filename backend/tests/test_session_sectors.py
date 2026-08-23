import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import types

if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import session_sectors


def lap(driver, lap_number, s1, s2, s3, duration=None, pit_out=False):
    return {
        "driver_number": driver,
        "lap_number": lap_number,
        "duration_sector_1": s1,
        "duration_sector_2": s2,
        "duration_sector_3": s3,
        "lap_duration": duration if duration is not None else (
            None if None in (s1, s2, s3) else s1 + s2 + s3
        ),
        "is_pit_out_lap": pit_out,
    }


class ClassifyLapSectorsTests(unittest.TestCase):
    def test_a_single_driver_single_lap_is_purple_in_every_sector(self):
        rows = [lap(1, 10, 28.0, 30.0, 29.0)]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["driver_number"], 1)
        self.assertEqual(board[0]["sectors"]["1"], {"seconds": 28.0, "classification": "purple"})
        self.assertEqual(board[0]["sectors"]["2"], {"seconds": 30.0, "classification": "purple"})
        self.assertEqual(board[0]["sectors"]["3"], {"seconds": 29.0, "classification": "purple"})

    def test_a_slower_drivers_fastest_lap_can_mix_all_three_colors(self):
        rows = [
            # Driver 1 sets the session-best S1 (tied) and outright S3.
            lap(1, 10, 28.0, 30.5, 29.0, duration=87.5),
            # Driver 44's fastest lap overall (87.7s < the 88.5s lap below).
            # Its S1 (28.5) is slower than 44's own S1 from the *other* lap
            # (28.0) -> yellow. Its S2 (30.0) is the session's best -> purple.
            # Its S3 (29.2) matches 44's own best (set on this same lap, the
            # other lap's S3 is slower) but not driver 1's session-best S3
            # -> green.
            lap(44, 12, 28.5, 30.0, 29.2, duration=87.7),
            # Not driver 44's fastest lap (88.5s), but it sets their personal
            # best S1 (28.0), which is what makes lap 12's S1 yellow above.
            lap(44, 8, 28.0, 31.0, 29.5),
        ]

        board = session_sectors.classify_lap_sectors(rows)
        driver_44 = next(r for r in board if r["driver_number"] == 44)

        self.assertEqual(driver_44["lap_number"], 12)
        self.assertEqual(driver_44["sectors"]["1"]["classification"], "yellow")
        self.assertEqual(driver_44["sectors"]["2"]["classification"], "purple")
        self.assertEqual(driver_44["sectors"]["3"]["classification"], "green")

    def test_pit_out_laps_are_excluded(self):
        rows = [
            lap(1, 1, 40.0, 40.0, 40.0, duration=120.0, pit_out=True),
            lap(1, 2, 28.0, 30.0, 29.0, duration=87.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["lap_number"], 2)

    def test_laps_missing_any_sector_time_are_excluded(self):
        rows = [
            lap(1, 1, None, 30.0, 29.0),
            lap(1, 2, 28.0, 30.0, 29.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(len(board), 1)
        self.assertEqual(board[0]["lap_number"], 2)

    def test_picks_the_fastest_complete_lap_per_driver_by_total_duration(self):
        rows = [
            lap(1, 5, 28.0, 30.0, 29.0, duration=87.0),
            lap(1, 6, 27.0, 30.0, 29.0, duration=86.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual(board[0]["lap_number"], 6)
        self.assertEqual(board[0]["lap_duration_seconds"], 86.0)

    def test_board_is_sorted_ascending_by_lap_duration(self):
        rows = [
            lap(1, 1, 29.0, 31.0, 30.0, duration=90.0),
            lap(44, 1, 28.0, 30.0, 29.0, duration=87.0),
        ]

        board = session_sectors.classify_lap_sectors(rows)

        self.assertEqual([r["driver_number"] for r in board], [44, 1])

    def test_no_rows_yields_an_empty_board(self):
        self.assertEqual(session_sectors.classify_lap_sectors([]), [])

    def test_a_driver_with_no_valid_lap_is_omitted(self):
        rows = [lap(1, 1, None, None, None, duration=None)]

        self.assertEqual(session_sectors.classify_lap_sectors(rows), [])
