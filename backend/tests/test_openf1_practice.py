import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import openf1_practice as op

SESSIONS = [
    {"session_key": 100, "meeting_key": 9, "session_name": "Practice 1", "date_start": "2026-11-06T15:30:00+00:00"},
    {"session_key": 101, "meeting_key": 9, "session_name": "Practice 2", "date_start": "2026-11-06T19:00:00+00:00"},
    {"session_key": 102, "meeting_key": 9, "session_name": "Practice 3", "date_start": "2026-11-07T14:30:00+00:00"},
    {"session_key": 103, "meeting_key": 9, "session_name": "Qualifying", "date_start": "2026-11-07T18:00:00+00:00"},
    {"session_key": 104, "meeting_key": 9, "session_name": "Race", "date_start": "2026-11-08T17:00:00+00:00"},
    # A different meeting whose FP1 must never be picked for Brazil.
    {"session_key": 200, "meeting_key": 8, "session_name": "Practice 1", "date_start": "2026-10-30T18:30:00+00:00"},
    {"session_key": 204, "meeting_key": 8, "session_name": "Race", "date_start": "2026-11-01T20:00:00+00:00"},
]

DRIVERS = [
    {"driver_number": 12, "first_name": "Andrea Kimi", "last_name": "Antonelli", "name_acronym": "ANT", "team_name": "Mercedes"},
    {"driver_number": 3, "full_name": "Max VERSTAPPEN", "name_acronym": "VER", "team_name": "Red Bull Racing"},
    {"driver_number": 44, "first_name": "Lewis", "last_name": "Hamilton", "name_acronym": "HAM", "team_name": "Ferrari"},
]


class FormatLapTests(unittest.TestCase):
    def test_formats_minutes(self):
        self.assertEqual(op.format_lap(70.877), "1:10.877")
        self.assertEqual(op.format_lap(83.4), "1:23.400")

    def test_formats_sub_minute(self):
        self.assertEqual(op.format_lap(59.1), "59.100")

    def test_rounding_carries_into_the_minute(self):
        self.assertEqual(op.format_lap(59.9996), "1:00.000")

    def test_rejects_non_times(self):
        for value in (None, "", "abc", 0, -1, float("nan")):
            self.assertEqual(op.format_lap(value), "")


class FindSessionTests(unittest.TestCase):
    def test_finds_the_named_session_in_the_racing_meeting(self):
        self.assertEqual(op.find_session(SESSIONS, "2026-11-08", "FP1")["session_key"], 100)
        self.assertEqual(op.find_session(SESSIONS, "2026-11-08", "FP3")["session_key"], 102)
        self.assertEqual(op.find_session(SESSIONS, "2026-11-01", "FP1")["session_key"], 200)

    def test_a_session_the_weekend_never_had_is_none(self):
        self.assertIsNone(op.find_session(SESSIONS, "2026-11-08", "SQ"))
        self.assertIsNone(op.find_session(SESSIONS, "2026-11-01", "FP2"))

    def test_unknown_race_date_is_none(self):
        self.assertIsNone(op.find_session(SESSIONS, "2026-12-06", "FP1"))

    def test_2023_sprint_shootout_counts_as_sq(self):
        sessions = [
            {"session_key": 1, "meeting_key": 5, "session_name": "Sprint Shootout", "date_start": "2023-04-29T08:30:00+00:00"},
            {"session_key": 2, "meeting_key": 5, "session_name": "Race", "date_start": "2023-04-30T11:00:00+00:00"},
        ]
        self.assertEqual(op.find_session(sessions, "2023-04-30", "SQ")["session_key"], 1)


class ClassificationFromResultsTests(unittest.TestCase):
    def test_practice_rows_in_classified_order(self):
        results = [
            {"position": 2, "driver_number": 3, "duration": 71.002, "number_of_laps": 24},
            {"position": None, "driver_number": 44, "duration": None, "dns": True, "number_of_laps": 0},
            {"position": 1, "driver_number": 12, "duration": 70.877, "number_of_laps": 26},
        ]
        rows = op.classification_from_results(results, DRIVERS, "FP1")
        self.assertEqual([r["Driver"]["code"] for r in rows], ["ANT", "VER", "HAM"])
        self.assertEqual([r["position"] for r in rows], ["1", "2", ""])
        self.assertEqual(rows[0]["Time"]["time"], "1:10.877")
        self.assertEqual(rows[0]["Driver"]["givenName"], "Andrea Kimi")
        self.assertEqual(rows[0]["Driver"]["permanentNumber"], "12")
        self.assertEqual(rows[0]["Constructor"]["name"], "Mercedes")
        self.assertEqual(rows[0]["laps"], "26")
        self.assertEqual(rows[2]["status"], "DNS")
        self.assertNotIn("Q1", rows[0])

    def test_name_falls_back_to_full_name(self):
        rows = op.classification_from_results(
            [{"position": 1, "driver_number": 3, "duration": 71.0}], DRIVERS, "FP2"
        )
        self.assertEqual(rows[0]["Driver"]["givenName"], "Max")
        self.assertEqual(rows[0]["Driver"]["familyName"], "Verstappen")

    def test_sprint_qualifying_carries_segments_and_best(self):
        results = [
            {"position": 1, "driver_number": 12, "duration": [71.5, 70.9, 70.4]},
            {"position": 12, "driver_number": 3, "duration": [71.8, 71.6, None]},
        ]
        rows = op.classification_from_results(results, DRIVERS, "SQ")
        self.assertEqual(rows[0]["Q3"], "1:10.400")
        self.assertEqual(rows[0]["Time"]["time"], "1:10.400")
        self.assertEqual(rows[1]["Q3"], "")
        self.assertEqual(rows[1]["Time"]["time"], "1:11.600")


class ClassificationFromLapsTests(unittest.TestCase):
    def test_deleted_and_out_laps_are_ignored(self):
        laps = [
            {"driver_number": 12, "lap_number": 3, "lap_duration": 70.1, "date_start": "a"},  # deleted
            # Race control's "LAP 3" is not OpenF1's lap 3: this one is legal.
            {"driver_number": 3, "lap_number": 3, "lap_duration": 71.9, "date_start": "a"},
            {"driver_number": 12, "lap_number": 5, "lap_duration": 70.6, "date_start": "c"},
            {"driver_number": 3, "lap_number": 1, "lap_duration": 60.0, "is_pit_out_lap": True},
            {"driver_number": 3, "lap_number": 4, "lap_duration": 70.5, "date_start": "b"},
            {"driver_number": 44, "lap_number": 2, "lap_duration": None},
        ]
        messages = [
            {"message": "CAR 12 (ANT) TIME 1:10.100 DELETED - TRACK LIMITS AT TURN 4 LAP 3 15:02:11"},
        ]
        rows = op.classification_from_laps(laps, DRIVERS, messages)
        self.assertEqual([r["Driver"]["code"] for r in rows], ["VER", "ANT"])
        self.assertEqual(rows[1]["Time"]["time"], "1:10.600")

    def test_reinstated_lap_counts_again(self):
        messages = [
            {"message": "CAR 12 (ANT) TIME 1:10.100 DELETED - TRACK LIMITS AT TURN 4 LAP 3 15:02:11"},
            {"message": "CAR 12 (ANT) TIME 1:10.100 REINSTATED AT TURN 4 LAP 3 15:20:00"},
        ]
        self.assertEqual(op.deleted_laps(messages), set())

    def test_messages_are_applied_in_time_order_not_list_order(self):
        # OpenF1 does not always return race control sorted by date.
        messages = [
            {"date": "2026-11-07T15:20:00", "message": "CAR 12 (ANT) TIME 1:10.100 WILL BE REINSTATED"},
            {"date": "2026-11-07T15:02:11", "message": "CAR 12 (ANT) TIME 1:10.100 DELETED - TRACK LIMITS"},
        ]
        self.assertEqual(op.deleted_laps(messages), set())

    def test_laps_ranking_is_marked_provisional(self):
        laps = [{"driver_number": 3, "lap_number": 2, "lap_duration": 71.0}]
        rows = op.classification_from_laps(laps, DRIVERS, [])
        self.assertTrue(op.is_provisional(rows))
        self.assertFalse(op.is_provisional([{"position": "1"}]))
        self.assertFalse(op.is_provisional(None))

    def test_deletions_are_keyed_on_time(self):
        messages = [{"message": "CAR 23 (ALB) TIME 1:26.203 DELETED - TRACK LIMITS AT TURN 1 LAP 15 16:26:41"}]
        self.assertEqual(op.deleted_laps(messages), {(23, "1:26.203")})


class BuildPracticeTests(unittest.TestCase):
    def _fake(self, responses):
        def fetch(url, params=None, timeout=20.0):
            return responses.get(url.rsplit("/", 1)[-1])
        return fetch

    def test_uses_session_result_when_published(self):
        responses = {
            "drivers": DRIVERS,
            "session_result": [{"position": 1, "driver_number": 44, "duration": 70.0}],
        }
        with patch.object(op, "fetch_json", self._fake(responses)), patch.object(op.time, "sleep"):
            rows = op.build_practice_openf1(2026, "2026-11-08", "FP3", sessions=SESSIONS)
        self.assertEqual(rows[0]["Driver"]["code"], "HAM")

    def test_live_lock_returns_none(self):
        # During a live session OpenF1 401s everything; fetch_json yields None.
        with patch.object(op, "fetch_json", return_value=None), patch.object(op.time, "sleep"):
            self.assertIsNone(op.build_practice_openf1(2026, "2026-11-08", "FP1"))

    def test_falls_back_to_laps_for_practice(self):
        responses = {
            "drivers": DRIVERS,
            "session_result": [],
            "laps": [{"driver_number": 3, "lap_number": 2, "lap_duration": 71.0}],
            "race_control": [],
        }
        with patch.object(op, "fetch_json", self._fake(responses)), patch.object(op.time, "sleep"):
            rows = op.build_practice_openf1(2026, "2026-11-08", "FP1", sessions=SESSIONS)
        self.assertEqual(rows[0]["Driver"]["code"], "VER")

    def test_no_names_means_no_classification(self):
        # A failed /drivers call would otherwise store nameless rows that,
        # carrying positions, are never refetched.
        responses = {
            "session_result": [{"position": 1, "driver_number": 44, "duration": 70.0}],
        }
        with patch.object(op, "fetch_json", self._fake(responses)), patch.object(op.time, "sleep"):
            self.assertIsNone(op.build_practice_openf1(2026, "2026-11-08", "FP3", sessions=SESSIONS))

    def test_official_result_is_not_provisional(self):
        responses = {
            "drivers": DRIVERS,
            "session_result": [{"position": 1, "driver_number": 44, "duration": 70.0}],
        }
        with patch.object(op, "fetch_json", self._fake(responses)), patch.object(op.time, "sleep"):
            rows = op.build_practice_openf1(2026, "2026-11-08", "FP3", sessions=SESSIONS)
        self.assertFalse(op.is_provisional(rows))

    def test_no_laps_fallback_without_race_control(self):
        responses = {
            "drivers": DRIVERS,
            "session_result": [],
            "laps": [{"driver_number": 3, "lap_number": 2, "lap_duration": 71.0}],
            # race_control missing -> None
        }
        with patch.object(op, "fetch_json", self._fake(responses)), patch.object(op.time, "sleep"):
            self.assertIsNone(op.build_practice_openf1(2026, "2026-11-08", "FP1", sessions=SESSIONS))


if __name__ == "__main__":
    unittest.main()
