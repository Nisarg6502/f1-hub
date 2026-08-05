"""Tests for deterministic reference resolution (CP60).

CP60's done-criterion names four cases explicitly — last race, next race,
nickname, ambiguity — and they are the four this file spends most of its
length on. Ambiguity gets the most, because it is the module's actual contract:
a resolver that silently picks the first match converts an answerable "which
one did you mean?" into a confident wrong answer, which is CP38's failure shape
wearing a different hat.

Everything here is pure — no Mongo, no network, no clock. `today` is passed in
on every call, so the season-boundary and race-weekend cases are testable at
all rather than only on the days they happen to occur.
"""

import datetime
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

from agent import resolve_context as rc


def race_doc(season, round_number, name, date, circuit_id, circuit_name, locality, country):
    """A `races` document in the shape Ergast/the sync job actually writes.

    `round` is a **string** here on purpose — that is how Ergast sends it and
    how Mongo stores it, and a fixture that quietly used an int would hide the
    string/int coercion `normalise_calendar` exists to do.
    """
    return {
        "season": season,
        "round": str(round_number),
        "raceName": name,
        "date": date,
        "Circuit": {
            "circuitId": circuit_id,
            "circuitName": circuit_name,
            "Location": {"locality": locality, "country": country},
        },
    }


CALENDAR_DOCS = [
    race_doc(2025, 24, "Abu Dhabi Grand Prix", "2025-12-07", "yas_marina", "Yas Marina Circuit", "Abu Dhabi", "UAE"),
    race_doc(2026, 1, "Australian Grand Prix", "2026-03-08", "albert_park", "Albert Park Grand Prix Circuit", "Melbourne", "Australia"),
    race_doc(2026, 6, "Miami Grand Prix", "2026-05-03", "miami", "Miami International Autodrome", "Miami", "USA"),
    race_doc(2026, 13, "Hungarian Grand Prix", "2026-07-26", "hungaroring", "Hungaroring", "Budapest", "Hungary"),
    race_doc(2026, 14, "Belgian Grand Prix", "2026-08-09", "spa", "Circuit de Spa-Francorchamps", "Spa", "Belgium"),
    race_doc(2026, 19, "United States Grand Prix", "2026-10-25", "americas", "Circuit of the Americas", "Austin", "USA"),
    race_doc(2026, 22, "Las Vegas Grand Prix", "2026-11-21", "vegas", "Las Vegas Strip Circuit", "Las Vegas", "USA"),
]

CALENDAR = rc.normalise_calendar(CALENDAR_DOCS)
CIRCUITS = rc.circuits_from_calendar(CALENDAR)

TODAY = datetime.date(2026, 8, 5)


def driver_row(driver_id, given, family, code, team):
    return {
        "Driver": {
            "driverId": driver_id,
            "givenName": given,
            "familyName": family,
            "code": code,
        },
        "Constructor": {"name": team},
    }


MODERN_ROSTER = rc.normalise_roster(
    [
        driver_row("max_verstappen", "Max", "Verstappen", "VER", "Red Bull"),
        driver_row("norris", "Lando", "Norris", "NOR", "McLaren"),
        driver_row("piastri", "Oscar", "Piastri", "PIA", "McLaren"),
        driver_row("hamilton", "Lewis", "Hamilton", "HAM", "Ferrari"),
        driver_row("kimi_antonelli", "Kimi", "Antonelli", "ANT", "Mercedes"),
        driver_row("perez", "Sergio", "Pérez", "PER", "Cadillac"),
        driver_row("hulkenberg", "Nico", "Hülkenberg", "HUL", "Sauber"),
    ]
)

# A season where both Kimis and both Verstappens are on the grid does not
# exist, but both ties are real over the sport's history and the resolver has
# to report them when the roster it is given contains both.
TWO_KIMI_ROSTER = rc.normalise_roster(
    [
        driver_row("kimi_antonelli", "Kimi", "Antonelli", "ANT", "Mercedes"),
        driver_row("raikkonen", "Kimi", "Räikkönen", "RAI", "Alfa Romeo"),
        driver_row("max_verstappen", "Max", "Verstappen", "VER", "Red Bull"),
        driver_row("verstappen", "Jos", "Verstappen", "VES", "Minardi"),
    ]
)


class NormalisationTests(unittest.TestCase):
    def test_accents_are_folded_so_a_correctly_spelled_name_still_matches(self):
        self.assertEqual(rc.normalise("Räikkönen"), "raikkonen")
        self.assertEqual(rc.normalise("Pérez"), "perez")

    def test_punctuation_and_case_are_stripped(self):
        self.assertEqual(rc.normalise("  The  HUNGARIAN G.P.!  "), "the hungarian g p")

    def test_calendar_rounds_are_coerced_from_ergast_strings_to_ints(self):
        rounds = [race["round"] for race in CALENDAR if race["season"] == 2026]

        self.assertEqual(rounds, sorted(rounds))
        self.assertTrue(all(isinstance(r, int) for r in rounds))

    def test_a_race_with_no_usable_round_is_dropped_rather_than_sorted_wrongly(self):
        calendar = rc.normalise_calendar([{"season": 2026, "round": None}])

        self.assertEqual(calendar, [])

    def test_roster_deduplicates_a_driver_who_appears_in_many_rounds(self):
        roster = rc.normalise_roster(
            [
                driver_row("norris", "Lando", "Norris", "NOR", "McLaren"),
                driver_row("norris", "Lando", "Norris", "NOR", "McLaren"),
            ]
        )

        self.assertEqual(len(roster), 1)

    def test_roster_accepts_a_standings_row_as_well_as_a_result_row(self):
        roster = rc.normalise_roster(
            [
                {
                    "Driver": {"driverId": "norris", "givenName": "Lando", "familyName": "Norris"},
                    "Constructors": [{"name": "McLaren"}],
                }
            ]
        )

        self.assertEqual(roster[0]["team"], "McLaren")


class LastRaceTests(unittest.TestCase):
    def test_the_last_race_is_the_most_recent_one_already_run(self):
        result = rc.resolve_race("how did he do in the last race", calendar=CALENDAR, today=TODAY)

        self.assertTrue(result.resolved)
        self.assertEqual(result.value["season"], 2026)
        self.assertEqual(result.value["round"], 13)
        self.assertEqual(result.value["race_name"], "Hungarian Grand Prix")
        self.assertEqual(result.via, "phrase:last_race")

    def test_race_day_itself_counts_as_run(self):
        """A question asked on Sunday evening is about that day's race."""
        result = rc.resolve_race(
            "the last race", calendar=CALENDAR, today=datetime.date(2026, 8, 9)
        )

        self.assertEqual(result.value["round"], 14)

    def test_latest_and_most_recent_are_the_same_phrase(self):
        for phrase in ("the latest race", "the most recent grand prix", "previous round"):
            with self.subTest(phrase=phrase):
                result = rc.resolve_race(phrase, calendar=CALENDAR, today=TODAY)
                self.assertEqual(result.value["round"], 13)

    def test_it_crosses_a_season_boundary_rather_than_reporting_nothing(self):
        result = rc.resolve_race(
            "the last race", calendar=CALENDAR, today=datetime.date(2026, 1, 15)
        )

        self.assertEqual(result.value["season"], 2025)
        self.assertEqual(result.value["round"], 24)

    def test_before_any_synced_race_it_reports_a_miss_rather_than_guessing_round_one(self):
        result = rc.resolve_race(
            "the last race", calendar=CALENDAR, today=datetime.date(2020, 1, 1)
        )

        self.assertFalse(result.resolved)
        self.assertFalse(result.ambiguous)
        self.assertIn("has been run", result.reason)


class NextRaceTests(unittest.TestCase):
    def test_the_next_race_is_the_first_one_still_to_come(self):
        result = rc.resolve_race("when is the next race", calendar=CALENDAR, today=TODAY)

        self.assertTrue(result.resolved)
        self.assertEqual(result.value["round"], 14)
        self.assertEqual(result.value["circuit_id"], "spa")

    def test_upcoming_is_the_same_phrase(self):
        result = rc.resolve_race("the upcoming grand prix", calendar=CALENDAR, today=TODAY)

        self.assertEqual(result.value["round"], 14)

    def test_after_the_final_round_it_says_so_instead_of_wrapping_around(self):
        result = rc.resolve_race(
            "the next race", calendar=CALENDAR, today=datetime.date(2026, 12, 25)
        )

        self.assertFalse(result.resolved)
        self.assertIn("season may be over", result.reason)


class ThisWeekendTests(unittest.TestCase):
    def test_a_race_a_few_days_away_is_this_weekend(self):
        result = rc.resolve_race(
            "who is racing this weekend", calendar=CALENDAR, today=datetime.date(2026, 8, 7)
        )

        self.assertTrue(result.resolved)
        self.assertEqual(result.value["round"], 14)

    def test_a_race_two_days_ago_is_still_this_weekend(self):
        result = rc.resolve_race(
            "this weekend", calendar=CALENDAR, today=datetime.date(2026, 8, 11)
        )

        self.assertEqual(result.value["round"], 14)

    def test_a_fallow_weekend_reports_no_race_rather_than_the_nearest_one(self):
        result = rc.resolve_race("this weekend", calendar=CALENDAR, today=TODAY)

        self.assertFalse(result.resolved)
        self.assertFalse(result.ambiguous)
        self.assertIn("no race within a few days", result.reason)


class ExplicitRoundAndCircuitRaceTests(unittest.TestCase):
    def test_an_explicit_round_resolves_within_the_current_season(self):
        result = rc.resolve_race("what happened in round 6", calendar=CALENDAR, today=TODAY)

        self.assertEqual(result.value["race_name"], "Miami Grand Prix")

    def test_a_round_that_does_not_exist_is_a_miss(self):
        result = rc.resolve_race("round 30", calendar=CALENDAR, today=TODAY)

        self.assertFalse(result.resolved)
        self.assertIn("not in the 2026 calendar", result.reason)

    def test_a_circuit_name_resolves_to_that_circuits_round(self):
        result = rc.resolve_race("the Hungarian GP", calendar=CALENDAR, today=TODAY)

        self.assertTrue(result.resolved)
        self.assertEqual(result.value["round"], 13)

    def test_a_circuit_plus_an_explicit_year_scopes_to_that_season(self):
        result = rc.resolve_race("Abu Dhabi 2025", calendar=CALENDAR, today=TODAY)

        self.assertEqual(result.value["season"], 2025)
        self.assertEqual(result.value["round"], 24)

    def test_a_circuit_not_on_that_seasons_calendar_is_a_miss(self):
        result = rc.resolve_race("Hungary 2025", calendar=CALENDAR, today=TODAY)

        self.assertFalse(result.resolved)
        self.assertIn("2025 calendar", result.reason)

    def test_an_ambiguous_circuit_makes_the_race_ambiguous_too(self):
        result = rc.resolve_race("the USA race", calendar=CALENDAR, today=TODAY)

        self.assertFalse(result.resolved)
        self.assertTrue(result.ambiguous)


class SeasonTests(unittest.TestCase):
    def test_an_explicit_year_wins(self):
        result = rc.resolve_season("who won in 2021", calendar=CALENDAR, today=TODAY)

        self.assertEqual(result.value, 2021)

    def test_an_explicit_year_beats_a_relative_phrase_in_the_same_sentence(self):
        result = rc.resolve_season("how did he do last year in 2021", calendar=CALENDAR, today=TODAY)

        self.assertEqual(result.value, 2021)

    def test_two_different_years_are_reported_rather_than_one_being_picked(self):
        result = rc.resolve_season("compare 2021 and 2023", calendar=CALENDAR, today=TODAY)

        self.assertFalse(result.resolved)
        self.assertTrue(result.ambiguous)
        self.assertEqual([c.id for c in result.candidates], ["2021", "2023"])

    def test_this_season_uses_the_calendar_and_the_clock(self):
        result = rc.resolve_season("this season", calendar=CALENDAR, today=TODAY)

        self.assertEqual(result.value, 2026)

    def test_last_year_is_relative_to_the_current_season(self):
        result = rc.resolve_season("last year", calendar=CALENDAR, today=TODAY)

        self.assertEqual(result.value, 2025)

    def test_no_season_reference_is_a_miss_not_a_default(self):
        result = rc.resolve_season("who won", calendar=CALENDAR, today=TODAY)

        self.assertFalse(result.resolved)
        self.assertIsNone(result.value)


class DriverNicknameTests(unittest.TestCase):
    def test_a_given_name_resolves_without_needing_a_table_entry(self):
        self.assertEqual(rc.resolve_driver("Max", roster=MODERN_ROSTER).value, "max_verstappen")

    def test_a_surname_resolves(self):
        self.assertEqual(rc.resolve_driver("Hamilton", roster=MODERN_ROSTER).value, "hamilton")

    def test_a_genuine_nickname_needs_the_table(self):
        result = rc.resolve_driver("Checo", roster=MODERN_ROSTER)

        self.assertEqual(result.value, "perez")
        self.assertEqual(result.via, "nickname")

    def test_the_hulk_resolves(self):
        self.assertEqual(rc.resolve_driver("the Hulk", roster=MODERN_ROSTER).value, "hulkenberg")

    def test_an_accented_surname_typed_plainly_still_resolves(self):
        self.assertEqual(rc.resolve_driver("Perez", roster=MODERN_ROSTER).value, "perez")
        self.assertEqual(rc.resolve_driver("Hulkenberg", roster=MODERN_ROSTER).value, "hulkenberg")

    def test_a_tv_code_resolves(self):
        result = rc.resolve_driver("VER", roster=MODERN_ROSTER)

        self.assertEqual(result.value, "max_verstappen")
        self.assertEqual(result.via, "code")

    def test_a_full_name_resolves(self):
        self.assertEqual(
            rc.resolve_driver("Kimi Antonelli", roster=MODERN_ROSTER).value, "kimi_antonelli"
        )

    def test_a_driver_id_resolves_to_itself(self):
        self.assertEqual(
            rc.resolve_driver("max_verstappen", roster=MODERN_ROSTER).value, "max_verstappen"
        )

    def test_a_nickname_is_unambiguous_when_only_one_of_its_targets_is_racing(self):
        """Era-correctness: "Kimi" in a 2026 roster is Antonelli and nobody else."""
        result = rc.resolve_driver("Kimi", roster=MODERN_ROSTER)

        self.assertTrue(result.resolved)
        self.assertEqual(result.value, "kimi_antonelli")

    def test_a_nickname_whose_targets_are_all_absent_says_so(self):
        result = rc.resolve_driver("Schumi", roster=MODERN_ROSTER)

        self.assertFalse(result.resolved)
        self.assertFalse(result.ambiguous)
        self.assertIn("known nickname", result.reason)


class AmbiguityTests(unittest.TestCase):
    """The module's actual contract. Every case here must refuse to pick."""

    def test_a_shared_nickname_returns_both_candidates(self):
        result = rc.resolve_driver("Kimi", roster=TWO_KIMI_ROSTER)

        self.assertFalse(result.resolved)
        self.assertTrue(result.ambiguous)
        self.assertIsNone(result.value)
        self.assertEqual(
            sorted(c.id for c in result.candidates), ["kimi_antonelli", "raikkonen"]
        )

    def test_a_shared_surname_returns_both_candidates(self):
        result = rc.resolve_driver("Verstappen", roster=TWO_KIMI_ROSTER)

        self.assertTrue(result.ambiguous)
        self.assertEqual(
            sorted(c.id for c in result.candidates), ["max_verstappen", "verstappen"]
        )

    def test_candidates_carry_enough_detail_to_ask_a_useful_question(self):
        result = rc.resolve_driver("Kimi", roster=TWO_KIMI_ROSTER)

        teams = {c.detail["team"] for c in result.candidates}
        self.assertEqual(teams, {"Mercedes", "Alfa Romeo"})

    def test_an_ambiguous_rule_does_not_fall_through_to_a_looser_one(self):
        """A looser rule matching only one of them must not break a genuine tie."""
        result = rc.resolve_driver("Verstappen", roster=TWO_KIMI_ROSTER)

        self.assertEqual(result.via, "family_name")
        self.assertFalse(result.resolved)

    def test_a_country_hosting_several_rounds_is_ambiguous(self):
        result = rc.resolve_circuit("USA", circuits=CIRCUITS)

        self.assertTrue(result.ambiguous)
        self.assertEqual(
            sorted(c.id for c in result.candidates), ["americas", "miami", "vegas"]
        )

    def test_an_unknown_name_is_a_miss_not_an_ambiguity(self):
        result = rc.resolve_driver("Barrichello", roster=MODERN_ROSTER)

        self.assertFalse(result.resolved)
        self.assertFalse(result.ambiguous)
        self.assertEqual(result.candidates, ())

    def test_a_pronoun_is_reported_as_needing_thread_memory(self):
        result = rc.resolve_driver("he", roster=MODERN_ROSTER)

        self.assertFalse(result.resolved)
        self.assertEqual(result.via, "pronoun")
        self.assertIn("thread memory", result.reason)


class CircuitTests(unittest.TestCase):
    def test_the_circuits_own_name_resolves(self):
        self.assertEqual(rc.resolve_circuit("Hungaroring", circuits=CIRCUITS).value, "hungaroring")

    def test_the_country_resolves_when_it_hosts_one_round(self):
        self.assertEqual(rc.resolve_circuit("Hungary", circuits=CIRCUITS).value, "hungaroring")

    def test_the_grand_prix_name_resolves(self):
        self.assertEqual(rc.resolve_circuit("the Hungarian GP", circuits=CIRCUITS).value, "hungaroring")
        self.assertEqual(
            rc.resolve_circuit("Hungarian Grand Prix", circuits=CIRCUITS).value, "hungaroring"
        )

    def test_the_city_resolves(self):
        self.assertEqual(rc.resolve_circuit("Budapest", circuits=CIRCUITS).value, "hungaroring")

    def test_the_circuit_id_resolves(self):
        self.assertEqual(rc.resolve_circuit("spa", circuits=CIRCUITS).value, "spa")

    def test_a_partial_name_resolves_when_it_is_unique(self):
        self.assertEqual(rc.resolve_circuit("Francorchamps", circuits=CIRCUITS).value, "spa")

    def test_an_unknown_circuit_is_a_miss(self):
        result = rc.resolve_circuit("Nurburgring", circuits=CIRCUITS)

        self.assertFalse(result.resolved)
        self.assertIn("no circuit matches", result.reason)

    def test_a_circuit_carries_the_seasons_it_appears_in(self):
        entry = next(c for c in CIRCUITS if c["circuit_id"] == "hungaroring")

        self.assertEqual(entry["seasons"], [2026])


class SeasonStateTests(unittest.TestCase):
    def test_it_reports_the_clock_and_both_neighbouring_races(self):
        state = rc.season_state(CALENDAR, TODAY)

        self.assertEqual(state["today"], "2026-08-05")
        self.assertEqual(state["season"], 2026)
        self.assertEqual(state["rounds_scheduled"], 6)
        self.assertEqual(state["rounds_completed"], 3)
        self.assertEqual(state["last_race"]["round"], 13)
        self.assertEqual(state["next_race"]["round"], 14)

    def test_an_empty_calendar_produces_nulls_rather_than_an_exception(self):
        state = rc.season_state([], TODAY)

        self.assertIsNone(state["season"])
        self.assertIsNone(state["last_race"])


class CombinedResolveTests(unittest.TestCase):
    def test_a_question_resolves_every_kind_it_carries(self):
        result = rc.resolve(
            "how did Max do in the last race",
            calendar=CALENDAR,
            roster=MODERN_ROSTER,
            today=TODAY,
        )

        self.assertFalse(result["ambiguous"])
        self.assertEqual(result["driver"]["value"], "max_verstappen")
        self.assertEqual(result["race"]["value"]["round"], 13)

    def test_a_resolved_race_pins_the_season_even_when_no_year_was_typed(self):
        result = rc.resolve("the last race", calendar=CALENDAR, today=TODAY)

        self.assertTrue(result["season"]["resolved"])
        self.assertEqual(result["season"]["value"], 2026)
        self.assertEqual(result["season"]["via"], "from_race")

    def test_one_ambiguous_kind_flags_the_whole_resolution(self):
        result = rc.resolve(
            "how did Kimi do in the last race",
            calendar=CALENDAR,
            roster=TWO_KIMI_ROSTER,
            today=TODAY,
        )

        self.assertTrue(result["ambiguous"])
        self.assertTrue(result["race"]["resolved"])
        self.assertFalse(result["driver"]["resolved"])

    def test_the_payload_is_plain_json_types(self):
        result = rc.resolve("the last race", calendar=CALENDAR, today=TODAY)

        import json

        self.assertIn("hungaroring", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
