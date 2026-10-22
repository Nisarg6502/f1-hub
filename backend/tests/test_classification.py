import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import session_recap
from app.classification import mark_lapped_finishers

# The 2026 Singapore GP race classification as Jolpica serves it (trimmed to
# the fields that matter): lapped cars carry status "Lapped" and a "+X" time.
SINGAPORE = json.loads(
    (Path(__file__).parent / "fixtures" / "race_2026_r17_singapore.json").read_text()
)


def by_code(rows):
    return {row["Driver"]["code"]: row for row in rows}


class MarkLappedFinishersTests(unittest.TestCase):
    def test_singapore_lapped_cars_read_as_laps_down_not_seconds(self):
        rows = by_code(mark_lapped_finishers(SINGAPORE))

        self.assertEqual(rows["GAS"]["status"], "+1 Lap")
        self.assertEqual(rows["PER"]["status"], "+2 Laps")
        self.assertEqual(rows["BOT"]["status"], "+3 Laps")
        for code in ("GAS", "PER", "BOT"):
            self.assertEqual(rows[code]["Time"]["time"], "")
            self.assertTrue(rows[code]["Time"]["millis"])

    def test_lead_lap_finishers_keep_their_gap(self):
        rows = by_code(mark_lapped_finishers(SINGAPORE))

        self.assertEqual(rows["VER"]["Time"]["time"], "1:42:00.785")
        self.assertEqual(rows["LEC"]["Time"]["time"], "+7.335")
        self.assertEqual(rows["LEC"]["status"], "Finished")

    def test_retirements_keep_their_reason(self):
        rows = by_code(mark_lapped_finishers(SINGAPORE))

        self.assertEqual(rows["STR"]["status"], "Retired")
        self.assertEqual(rows["ALB"]["status"], "Retired")

    def test_the_stored_rows_are_not_modified(self):
        before = json.dumps(SINGAPORE, sort_keys=True)
        mark_lapped_finishers(SINGAPORE)
        self.assertEqual(json.dumps(SINGAPORE, sort_keys=True), before)

    def test_classic_ergast_rows_are_unchanged(self):
        rows = [
            {"position": "1", "laps": "57", "status": "Finished", "Time": {"time": "1:31:44.742"}},
            {"position": "15", "laps": "56", "status": "+1 Lap"},
        ]
        self.assertEqual(mark_lapped_finishers(rows), rows)

    def test_an_unclassified_car_marked_lapped_is_not_made_a_finisher(self):
        # Real Jolpica row, 2026 R1: Stroll, positionText "R", status "Lapped".
        rows = [
            {"position": "1", "positionText": "1", "laps": "58", "status": "Finished", "Time": {"time": "1:23:06.801"}},
            {"position": "20", "positionText": "R", "laps": "43", "status": "Lapped", "Time": {"time": ""}},
        ]
        self.assertEqual(mark_lapped_finishers(rows)[1]["status"], "Lapped")

    def test_a_winner_without_a_lap_count_changes_nothing(self):
        rows = [
            {"position": "1", "status": "Finished", "Time": {"time": "1:30:00.000"}},
            {"position": "2", "laps": "50", "status": "Lapped", "Time": {"time": "+2.0"}},
        ]
        self.assertEqual(mark_lapped_finishers(rows), rows)

    def test_rows_without_laps_are_left_alone(self):
        qualifying = [{"position": "1", "Q3": "1:29.1"}, {"position": "2", "Q3": "1:29.2"}]
        self.assertEqual(mark_lapped_finishers(qualifying), qualifying)


class RecapFactsTests(unittest.TestCase):
    def test_the_recap_is_not_told_a_lapped_car_was_seconds_behind(self):
        facts = session_recap._classification_facts(SINGAPORE)
        gasly = next(f for f in facts if f["position"] == "11")

        self.assertEqual(gasly["gap_to_leader"], "+1 Lap")


if __name__ == "__main__":
    unittest.main()
