import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.race_control_facts import summarize_race_control


def message(text, lap=None, flag=None):
    return {"message": text, "lap_number": lap, "flag": flag}


RESULTS = [
    {
        "number": "44",
        "Driver": {"givenName": "Lewis", "familyName": "Hamilton"},
        "Constructor": {"name": "Ferrari"},
    },
    {
        "number": "55",
        "Driver": {"givenName": "Carlos", "familyName": "Sainz"},
        "Constructor": {"name": "Williams"},
    },
    {
        "number": "23",
        "Driver": {"givenName": "Alexander", "familyName": "Albon"},
        "Constructor": {"name": "Williams"},
    },
]


class PenaltyTests(unittest.TestCase):
    def test_a_time_penalty_is_kept_and_resolved_to_a_driver(self):
        messages = [
            message(
                "FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 44 (HAM) - SPEEDING IN THE PIT LANE",
                lap=66,
            )
        ]

        summary = summarize_race_control(messages, RESULTS)

        self.assertEqual(len(summary["events"]), 1)
        event = summary["events"][0]
        self.assertEqual(event["kind"], "penalty")
        self.assertEqual(event["lap"], 66)
        self.assertEqual(event["drivers"], ["Lewis Hamilton"])

    def test_a_served_penalty_is_distinguished_from_the_award(self):
        messages = [
            message("FIA STEWARDS: 5 SECOND TIME PENALTY FOR CAR 55 (SAI) - COLLISION", lap=44),
            message("FIA STEWARDS: PENALTY SERVED - 5 SECOND TIME PENALTY FOR CAR 55 (SAI)", lap=50),
        ]

        kinds = [e["kind"] for e in summarize_race_control(messages, RESULTS)["events"]]

        self.assertEqual(kinds, ["penalty", "penalty_served"])

    def test_a_drive_through_is_treated_as_a_penalty(self):
        messages = [message("FIA STEWARDS: DRIVE THROUGH PENALTY FOR CAR 44 (HAM)", lap=10)]

        self.assertEqual(summarize_race_control(messages, RESULTS)["events"][0]["kind"], "penalty")


class InvestigationTests(unittest.TestCase):
    def test_an_open_investigation_is_kept(self):
        messages = [message("FIA STEWARDS: INCIDENT INVOLVING CAR 44 (HAM) UNDER INVESTIGATION", lap=62)]

        self.assertEqual(
            summarize_race_control(messages, RESULTS)["events"][0]["kind"], "investigation"
        )

    def test_a_closed_investigation_is_kept_as_no_further_action(self):
        messages = [message("FIA STEWARDS: INCIDENT INVOLVING CAR 44 (HAM) NO FURTHER ACTION", lap=50)]

        self.assertEqual(
            summarize_race_control(messages, RESULTS)["events"][0]["kind"], "no_further_action"
        )


class SafetyCarTests(unittest.TestCase):
    def test_vsc_and_safety_car_deployments_are_kept_as_a_distinct_kind(self):
        # Deployment/ending are their own kind, distinct from a mere mention
        # of "safety car" in an infringement message (e.g. "FAILURE TO
        # ADHERE TO SAFETY CAR PROCEDURES") — that distinction is the whole
        # point of splitting this out from a single generic "safety_car".
        messages = [message("VSC DEPLOYED", lap=56), message("SAFETY CAR DEPLOYED", lap=12)]

        kinds = {e["kind"] for e in summarize_race_control(messages, RESULTS)["events"]}

        self.assertEqual(kinds, {"safety_car_deployed"})

    def test_a_safety_car_procedure_infringement_is_not_classified_as_a_deployment(self):
        messages = [
            message(
                "FIA STEWARDS: INCIDENT INVOLVING CAR 44 (HAM) UNDER INVESTIGATION - "
                "FAILURE TO ADHERE TO SAFETY CAR PROCEDURES",
                lap=20,
            )
        ]

        kinds = {e["kind"] for e in summarize_race_control(messages, RESULTS)["events"]}

        self.assertNotIn("safety_car_deployed", kinds)
        self.assertIn("investigation", kinds)

    def test_events_are_ordered_by_lap(self):
        messages = [message("VSC DEPLOYED", lap=56), message("SAFETY CAR DEPLOYED", lap=12)]

        laps = [e["lap"] for e in summarize_race_control(messages, RESULTS)["events"]]

        self.assertEqual(laps, [12, 56])


class NoiseFilteringTests(unittest.TestCase):
    def test_blue_flags_are_dropped(self):
        messages = [message("WAVED BLUE FLAG FOR CAR 44 (HAM)", lap=9, flag="BLUE")]

        self.assertEqual(summarize_race_control(messages, RESULTS)["events"], [])

    def test_sector_clear_messages_are_dropped(self):
        messages = [message("CLEAR IN TRACK SECTOR 6", lap=57, flag="CLEAR")]

        self.assertEqual(summarize_race_control(messages, RESULTS)["events"], [])

    def test_unremarkable_messages_are_dropped(self):
        messages = [message("GREEN LIGHT - PIT EXIT OPEN", lap=1, flag="GREEN")]

        self.assertEqual(summarize_race_control(messages, RESULTS)["events"], [])


class TrackLimitTests(unittest.TestCase):
    def test_deletions_are_collapsed_into_a_per_driver_count(self):
        messages = [
            message("CAR 23 (ALB) TIME 1:31.197 DELETED - TRACK LIMITS AT TURN 4", lap=13),
            message("CAR 23 (ALB) TIME 1:28.500 DELETED - TRACK LIMITS AT TURN 7", lap=20),
            message("CAR 23 (ALB) TIME 1:28.309 DELETED - TRACK LIMITS AT TURN 7", lap=21),
        ]

        summary = summarize_race_control(messages, RESULTS)

        self.assertEqual(summary["events"], [])
        self.assertEqual(summary["track_limit_deletions"], [{"driver": "Alexander Albon", "count": 3}])

    def test_a_single_deletion_is_not_reported(self):
        messages = [message("CAR 23 (ALB) LAP DELETED - TRACK LIMITS AT TURN 4", lap=13)]

        self.assertEqual(summarize_race_control(messages, RESULTS)["track_limit_deletions"], [])


class EmptyInputTests(unittest.TestCase):
    def test_no_messages_yields_empty_structures(self):
        summary = summarize_race_control([], RESULTS)

        self.assertEqual(summary["events"], [])
        self.assertEqual(summary["track_limit_deletions"], [])


if __name__ == "__main__":
    unittest.main()
