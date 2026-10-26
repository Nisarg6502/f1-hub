import asyncio
import json
import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# catch_up imports motor (via db.py) at module scope; these tests never touch
# Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from app import catch_up


# --------------------------------- fixtures ---------------------------------

DRIVERS = {
    "ant": ("antonelli", "Andrea Kimi", "Antonelli", "Mercedes", "mercedes"),
    "rus": ("russell", "George", "Russell", "Mercedes", "mercedes"),
    "ver": ("max_verstappen", "Max", "Verstappen", "Red Bull", "red_bull"),
    "nor": ("norris", "Lando", "Norris", "McLaren", "mclaren"),
    "lec": ("leclerc", "Charles", "Leclerc", "Ferrari", "ferrari"),
}

RACE_POINTS = [25, 18, 15, 12, 10]
SPRINT_POINTS = [8, 7, 6, 5, 4]


def row(code, position, points, status="Finished"):
    driver_id, given, family, team, team_id = DRIVERS[code]
    return {
        "position": str(position),
        "points": str(points),
        "status": status,
        "Driver": {
            "driverId": driver_id,
            "givenName": given,
            "familyName": family,
            "code": code.upper(),
        },
        "Constructor": {"constructorId": team_id, "name": team},
    }


def classification(order, points=RACE_POINTS, statuses=None):
    """`order` is driver codes, P1 first. `statuses` overrides by code."""
    statuses = statuses or {}
    return [
        row(code, index + 1, points[index] if statuses.get(code, "Finished") == "Finished" else 0,
            statuses.get(code, "Finished"))
        for index, code in enumerate(order)
    ]


def race_doc(round_number, name, order, **kwargs):
    return {
        "round": str(round_number),
        "race": {"raceName": name, "date": f"2026-0{min(round_number, 9)}-01"},
        "results": classification(order, **kwargs),
    }


def sprint_doc(round_number, name, order):
    return {
        "round": str(round_number),
        "race": {"raceName": name},
        "results": classification(order, points=SPRINT_POINTS),
    }


def schedule(*names):
    return [{"round": str(i + 1), "raceName": name} for i, name in enumerate(names)]


SCHEDULE = schedule(
    "Australian Grand Prix", "Chinese Grand Prix", "Japanese Grand Prix",
    "Miami Grand Prix", "Canadian Grand Prix",
)


def stored_from(payload_standings):
    """A `driver_standings` document body matching a rebuilt standings list."""
    return [
        {"points": str(s["points"]), "Driver": {"driverId": s["driver_id"]}}
        for s in payload_standings
    ]


# ------------------------------- the builder --------------------------------


class NoRoundsMissedTests(unittest.TestCase):
    def test_after_the_latest_classified_round_there_is_nothing_to_report(self):
        races = [race_doc(1, "Australian Grand Prix", ["ant", "rus", "ver"])]
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, [])
        self.assertEqual(payload["latest_round"], 1)
        self.assertEqual(payload["rounds"], [])
        self.assertIsNone(payload["facts"])

    def test_a_visitor_ahead_of_the_data_gets_nothing_rather_than_an_error(self):
        # The client thinks round 2 finished; its results are not synced yet.
        races = [race_doc(1, "Australian Grand Prix", ["ant", "rus", "ver"])]
        payload = catch_up.build_catch_up(2026, 2, SCHEDULE, races, [])
        self.assertEqual(payload["rounds"], [])


class OneRoundMissedTests(unittest.TestCase):
    def setUp(self):
        self.races = [
            race_doc(1, "Australian Grand Prix", ["rus", "ant", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["ant", "ver", "rus"]),
        ]
        self.payload = catch_up.build_catch_up(2026, 1, SCHEDULE, self.races, [])

    def test_reports_the_winner_and_podium(self):
        [missed] = self.payload["rounds"]
        self.assertEqual(missed["round"], 2)
        self.assertEqual(missed["round_key"], "2026-2")
        self.assertEqual(missed["race_name"], "Chinese Grand Prix")
        self.assertEqual(missed["race"]["status"], "classified")
        self.assertEqual(missed["race"]["winner"]["name"], "Andrea Kimi Antonelli")
        self.assertEqual(
            [p["driver_id"] for p in missed["race"]["podium"]],
            ["antonelli", "max_verstappen", "russell"],
        )
        self.assertIsNone(missed["sprint"])

    def test_title_gap_then_and_now(self):
        standings = self.payload["facts"]["standings"]
        # After R1: Russell 25, Antonelli 18. After R2: Antonelli 43, Russell 40.
        self.assertEqual(standings["title_gap_before"]["points"], 7)
        self.assertEqual(standings["title_gap_before"]["leader"]["driver_id"], "russell")
        self.assertEqual(standings["title_gap_now"]["points"], 3)
        self.assertEqual(standings["title_gap_now"]["leader_points"], 43)
        self.assertEqual(standings["title_gap_now"]["second_points"], 40)

    def test_baseline_names_the_last_round_the_visitor_saw(self):
        self.assertEqual(
            self.payload["baseline"], {"round": 1, "race_name": "Australian Grand Prix"}
        )


class SeveralRoundsMissedTests(unittest.TestCase):
    def setUp(self):
        self.races = [
            race_doc(1, "Australian Grand Prix", ["nor", "lec", "rus", "ant", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["ver", "ant", "rus", "nor", "lec"]),
            race_doc(3, "Japanese Grand Prix", ["ver", "ant", "rus", "lec", "nor"]),
            race_doc(4, "Miami Grand Prix", ["ant", "ver", "rus", "lec", "nor"]),
        ]
        self.payload = catch_up.build_catch_up(2026, 1, SCHEDULE, self.races, [])

    def test_lists_every_missed_round_in_order(self):
        self.assertEqual([r["round"] for r in self.payload["rounds"]], [2, 3, 4])

    def test_tallies_wins_so_the_model_never_has_to(self):
        wins = self.payload["facts"]["race_wins"]
        self.assertEqual(
            [(w["driver_id"], w["wins"]) for w in wins],
            [("max_verstappen", 2), ("antonelli", 1)],
        )
        self.assertEqual(wins[0]["races"], ["Chinese Grand Prix", "Japanese Grand Prix"])
        self.assertEqual(self.payload["facts"]["grands_prix_classified"], 3)

    def test_movers_are_ranked_by_size_of_move(self):
        movers = self.payload["facts"]["standings"]["movers"]
        # After R1: NOR, LEC, RUS, ANT, VER. After R4: VER 80, ANT 73, RUS 70,
        # NOR 59, LEC 50 -> VER +4, ANT +2, NOR -3, LEC -3, RUS 0.
        self.assertEqual(movers[0]["driver_id"], "max_verstappen")
        self.assertEqual((movers[0]["from_position"], movers[0]["to_position"]), (5, 1))
        self.assertEqual(movers[0]["change"], 4)
        self.assertEqual({m["driver_id"] for m in movers[1:]}, {"norris", "leclerc"})
        self.assertTrue(all(m["change"] == -3 for m in movers[1:]))
        self.assertEqual(len(movers), catch_up.MAX_MOVERS)

    def test_leader_change_is_resolved_here(self):
        standings = self.payload["facts"]["standings"]
        self.assertTrue(standings["leader_changed"])
        self.assertEqual(standings["leader_before"]["drivers"][0]["driver_id"], "norris")
        self.assertEqual(standings["leader_now"]["drivers"][0]["driver_id"], "max_verstappen")

    def test_top_scorer_counts_only_the_missed_sessions(self):
        top = self.payload["facts"]["standings"]["top_scorer"]
        self.assertEqual(top["drivers"][0]["driver_id"], "max_verstappen")
        self.assertEqual(top["points"], 68)


class SprintWeekendTests(unittest.TestCase):
    def test_sprint_podium_reported_alongside_the_race(self):
        races = [
            race_doc(1, "Australian Grand Prix", ["ant", "rus", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["rus", "ant", "ver"]),
        ]
        sprints = [sprint_doc(2, "Chinese Grand Prix", ["ver", "ant", "rus"])]
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, sprints)
        [missed] = payload["rounds"]
        self.assertEqual(missed["sprint"]["winner"]["driver_id"], "max_verstappen")
        self.assertEqual(missed["race"]["winner"]["driver_id"], "russell")
        self.assertEqual(
            [w["driver_id"] for w in payload["facts"]["sprint_wins"]], ["max_verstappen"]
        )

    def test_sprint_points_count_toward_the_standings(self):
        races = [
            race_doc(1, "Australian Grand Prix", ["ant", "rus", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["rus", "ant", "ver"]),
        ]
        sprints = [sprint_doc(2, "Chinese Grand Prix", ["ver", "ant", "rus"])]
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, sprints)
        gap = payload["facts"]["standings"]["title_gap_now"]
        # ANT 25+18+7 = 50, RUS 18+25+6 = 49.
        self.assertEqual((gap["leader_points"], gap["second_points"]), (50, 49))

    def test_a_sprint_alone_counts_and_leaves_the_race_pending(self):
        # Left on Friday; the sprint has run, Sunday's race has not.
        races = [race_doc(1, "Australian Grand Prix", ["ant", "rus", "ver"])]
        sprints = [sprint_doc(2, "Chinese Grand Prix", ["ver", "ant", "rus"])]
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, sprints)
        self.assertEqual(payload["latest_round"], 2)
        [missed] = payload["rounds"]
        self.assertEqual(missed["race"]["status"], "pending")
        self.assertEqual(missed["sprint"]["status"], "classified")

    def test_a_sprint_win_is_never_a_first_career_win(self):
        races = [race_doc(1, "Australian Grand Prix", ["ant", "rus", "ver"])]
        sprints = [sprint_doc(2, "Chinese Grand Prix", ["nor", "ant", "rus"])]
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, sprints, prior_winners=set())
        self.assertEqual(
            [n for n in payload["facts"]["notable"] if n["kind"] == "first_career_win"], []
        )


class LeaderAndTieTests(unittest.TestCase):
    def test_a_points_tie_is_reported_as_a_tie_not_a_leader(self):
        # R1: RUS 25, ANT 18. R2: ANT 25, RUS 18 -> both 43.
        races = [
            race_doc(1, "Australian Grand Prix", ["rus", "ant", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["ant", "rus", "ver"]),
        ]
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, [])
        standings = payload["facts"]["standings"]
        self.assertTrue(standings["leader_now"]["tied"])
        self.assertEqual(
            {d["driver_id"] for d in standings["leader_now"]["drivers"]}, {"russell", "antonelli"}
        )
        self.assertEqual(standings["leader_now"]["points"], 43)
        self.assertEqual(standings["title_gap_now"]["points"], 0)
        # Sole leader -> co-leaders is a change in who leads.
        self.assertTrue(standings["leader_changed"])

    def test_same_leader_is_not_a_change(self):
        races = [
            race_doc(1, "Australian Grand Prix", ["ant", "rus", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["ant", "rus", "ver"]),
        ]
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, [])
        self.assertFalse(payload["facts"]["standings"]["leader_changed"])

    def test_the_leader_failing_to_finish_is_notable(self):
        races = [
            race_doc(1, "Australian Grand Prix", ["ant", "rus", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["rus", "ver", "ant"], statuses={"ant": "Retired"}),
        ]
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, [])
        [note] = [n for n in payload["facts"]["notable"] if n["kind"] == "leader_non_finish"]
        self.assertEqual(note["driver"]["driver_id"], "antonelli")
        self.assertEqual(note["status"], "Retired")
        self.assertEqual(note["round"], 2)

    def test_a_lapped_leader_is_a_finisher(self):
        races = [
            race_doc(1, "Australian Grand Prix", ["ant", "rus", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["rus", "ver", "ant"]),
        ]
        races[1]["results"][2]["status"] = "+1 Lap"
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, [])
        self.assertEqual(payload["facts"]["notable"], [])


class FirstCareerWinTests(unittest.TestCase):
    def setUp(self):
        self.races = [
            race_doc(1, "Australian Grand Prix", ["rus", "ant", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["ant", "rus", "ver"]),
            race_doc(3, "Japanese Grand Prix", ["ant", "rus", "ver"]),
        ]

    def test_flagged_once_when_history_has_no_earlier_win(self):
        payload = catch_up.build_catch_up(
            2026, 1, SCHEDULE, self.races, [], prior_winners={"George Russell"}
        )
        firsts = [n for n in payload["facts"]["notable"] if n["kind"] == "first_career_win"]
        self.assertEqual([(n["round"], n["driver"]["driver_id"]) for n in firsts], [(2, "antonelli")])

    def test_not_flagged_for_a_previous_winner(self):
        payload = catch_up.build_catch_up(
            2026, 1, SCHEDULE, self.races, [], prior_winners={"Andrea Kimi Antonelli"}
        )
        self.assertEqual(payload["facts"]["notable"], [])

    def test_never_claimed_when_history_cannot_vouch(self):
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, self.races, [], prior_winners=None)
        self.assertEqual(payload["facts"]["notable"], [])

    def test_an_earlier_win_this_season_counts(self):
        payload = catch_up.build_catch_up(2026, 2, SCHEDULE, self.races, [], prior_winners=set())
        self.assertEqual(payload["facts"]["notable"], [])


class SeasonBoundaryTests(unittest.TestCase):
    def test_from_the_start_of_the_season_there_is_no_before(self):
        races = [
            race_doc(1, "Australian Grand Prix", ["rus", "ant", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["ant", "rus", "ver"]),
        ]
        payload = catch_up.build_catch_up(2026, 0, SCHEDULE, races, [])
        self.assertEqual([r["round"] for r in payload["rounds"]], [1, 2])
        self.assertEqual(payload["baseline"], {"round": 0, "race_name": None})
        standings = payload["facts"]["standings"]
        self.assertIsNone(standings["leader_before"])
        self.assertIsNone(standings["title_gap_before"])
        self.assertFalse(standings["leader_changed"])
        self.assertEqual(standings["movers"], [])
        self.assertEqual(
            catch_up.narrative_facts(payload)["missed_since"], "the start of the season"
        )

    def test_before_the_first_race_there_is_nothing(self):
        payload = catch_up.build_catch_up(2026, 0, SCHEDULE, [], [])
        self.assertEqual(payload["latest_round"], 0)
        self.assertEqual(payload["rounds"], [])


class MissingResultTests(unittest.TestCase):
    def test_a_scheduled_round_with_no_result_is_stated_as_missing(self):
        races = [
            race_doc(1, "Australian Grand Prix", ["rus", "ant", "ver"]),
            race_doc(3, "Japanese Grand Prix", ["ant", "rus", "ver"]),
        ]
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, [])
        self.assertEqual([r["round"] for r in payload["rounds"]], [2, 3])
        cancelled = payload["rounds"][0]
        self.assertEqual(cancelled["race_name"], "Chinese Grand Prix")
        self.assertEqual(cancelled["race"]["status"], "missing")
        self.assertIsNone(cancelled["race"]["winner"])
        # Its absence adds no points to anyone.
        self.assertEqual(payload["facts"]["standings"]["title_gap_now"]["leader_points"], 43)

    def test_an_empty_results_document_is_missing_too(self):
        races = [
            race_doc(1, "Australian Grand Prix", ["rus", "ant", "ver"]),
            {"round": "2", "race": {"raceName": "Chinese Grand Prix"}, "results": []},
            race_doc(3, "Japanese Grand Prix", ["ant", "rus", "ver"]),
        ]
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, races, [])
        self.assertEqual(payload["rounds"][0]["race"]["status"], "missing")


class StandingsVerificationTests(unittest.TestCase):
    def setUp(self):
        self.races = [
            race_doc(1, "Australian Grand Prix", ["ant", "rus", "ver"]),
            race_doc(2, "Chinese Grand Prix", ["rus", "ver", "ant"], statuses={"ant": "Retired"}),
        ]

    def test_matching_stored_standings_keep_every_fact(self):
        rebuilt = catch_up._standings(catch_up._sessions(
            {1: self.races[0]["results"], 2: self.races[1]["results"]}, {}
        ))
        payload = catch_up.build_catch_up(
            2026, 1, SCHEDULE, self.races, [], stored_standings=stored_from(rebuilt)
        )
        self.assertTrue(payload["facts"]["standings_verified"])
        self.assertIsNotNone(payload["facts"]["standings"])

    def test_disagreeing_stored_standings_withhold_standings_facts(self):
        # As 2025 does in this database: its sprints were never synced, so the
        # rebuilt totals come up short of the official ones.
        stored = [
            {"points": "999", "Driver": {"driverId": "antonelli"}},
            {"points": "43", "Driver": {"driverId": "russell"}},
        ]
        payload = catch_up.build_catch_up(
            2026, 1, SCHEDULE, self.races, [], stored_standings=stored
        )
        self.assertFalse(payload["facts"]["standings_verified"])
        self.assertIsNone(payload["facts"]["standings"])
        # Who led into a race is a standings fact as well.
        self.assertEqual(payload["facts"]["notable"], [])
        # Podiums do not depend on the standings and still render.
        self.assertEqual(payload["rounds"][0]["race"]["winner"]["driver_id"], "russell")
        self.assertIsNone(catch_up.narrative_facts(payload)["standings"])


# ------------------------------ the narrative -------------------------------


def one_round_payload():
    races = [
        race_doc(1, "Australian Grand Prix", ["rus", "ant", "ver"]),
        race_doc(2, "Chinese Grand Prix", ["ant", "ver", "rus"]),
    ]
    return catch_up.build_catch_up(2026, 1, SCHEDULE, races, [])


class NarrativeFactsTests(unittest.TestCase):
    def test_drops_dates_ids_and_codes(self):
        facts = catch_up.narrative_facts(one_round_payload())
        dumped = json.dumps(facts)
        for absent in ("2026-02-01", "2026-2", "antonelli\"", "ANT", "red_bull"):
            self.assertNotIn(absent, dumped)

    def test_short_spans_get_every_podium(self):
        facts = catch_up.narrative_facts(one_round_payload())
        self.assertIn("rounds", facts)
        self.assertNotIn("most_recent_round", facts)

    def test_long_spans_get_a_tally_and_the_latest_round_only(self):
        races = [race_doc(r, f"Race {r}", ["ant", "rus", "ver"]) for r in range(1, 7)]
        payload = catch_up.build_catch_up(2026, 1, schedule(*[f"Race {r}" for r in range(1, 7)]), races, [])
        facts = catch_up.narrative_facts(payload)
        self.assertNotIn("rounds", facts)
        self.assertEqual([r["round"] for r in facts["most_recent_round"]], [6])
        self.assertEqual(facts["race_wins"][0]["wins"], 5)


class GroundingGuardTests(unittest.TestCase):
    def setUp(self):
        self.facts = catch_up.narrative_facts(one_round_payload())

    def test_numbers_copied_from_the_facts_pass(self):
        text = "Andrea Kimi Antonelli won in China and now leads by 3 points, on 43, after trailing by 7."
        self.assertEqual(catch_up.ungrounded_numbers(text, self.facts), [])

    def test_an_invented_number_is_caught(self):
        text = "Antonelli now leads by 12 points."
        self.assertEqual(catch_up.ungrounded_numbers(text, self.facts), ["12"])

    def test_matching_is_exact_not_a_substring_search(self):
        # "15" and "25" are in the facts; "5" alone must not ride on them.
        self.assertIn("15", json.dumps(self.facts))
        self.assertIn("25", json.dumps(self.facts))
        self.assertEqual(catch_up.ungrounded_numbers("He won 5 races.", self.facts), ["5"])

    def test_a_spelled_out_count_is_checked_too(self):
        self.assertEqual(
            catch_up.ungrounded_numbers("He has won nine races.", self.facts), ["nine"]
        )
        # "one" is a pronoun more often than a count, and is left alone.
        self.assertEqual(catch_up.ungrounded_numbers("One of them won.", self.facts), [])

    def test_banned_labels_are_violations(self):
        self.assertEqual(
            catch_up.narrative_violations("Antonelli dominated in China.", self.facts),
            ["dominated"],
        )


def scripted_llm(*answers):
    """A stand-in for `session_recap._generate_recap` that yields one scripted
    answer per call, recording the prompts it was given."""
    calls = []
    queue = list(answers)

    async def fake(facts, system_prompt):
        calls.append(system_prompt)
        answer = queue.pop(0) if queue else ""
        if answer:
            yield answer

    return fake, calls


class WriteNarrativeTests(unittest.TestCase):
    def setUp(self):
        self.facts = catch_up.narrative_facts(one_round_payload())

    def test_a_grounded_draft_ships(self):
        fake, calls = scripted_llm("Antonelli won and leads by 3 points.")
        with patch.object(catch_up, "_generate_recap", fake):
            self.assertEqual(
                asyncio.run(catch_up.write_narrative(self.facts)),
                ("Antonelli won and leads by 3 points.", False),
            )
        self.assertEqual(len(calls), 1)

    def test_an_invented_number_triggers_one_retry_naming_it(self):
        fake, calls = scripted_llm("Antonelli leads by 12 points.", "Antonelli leads by 3 points.")
        with patch.object(catch_up, "_generate_recap", fake):
            text, rejected = asyncio.run(catch_up.write_narrative(self.facts))
        self.assertEqual((text, rejected), ("Antonelli leads by 3 points.", False))
        self.assertEqual(len(calls), 2)
        self.assertIn("12", calls[1])

    def test_a_second_failure_drops_the_narrative(self):
        fake, _ = scripted_llm("Antonelli leads by 12 points.", "Antonelli leads by 11 points.")
        with patch.object(catch_up, "_generate_recap", fake):
            self.assertEqual(asyncio.run(catch_up.write_narrative(self.facts)), (None, True))

    def test_no_answer_is_not_a_rejection(self):
        fake, _ = scripted_llm("")
        with patch.object(catch_up, "_generate_recap", fake):
            self.assertEqual(asyncio.run(catch_up.write_narrative(self.facts)), (None, False))

    def test_markdown_emphasis_is_stripped(self):
        fake, _ = scripted_llm("**Antonelli** won.")
        with patch.object(catch_up, "_generate_recap", fake):
            self.assertEqual(asyncio.run(catch_up.write_narrative(self.facts))[0], "Antonelli won.")


# ------------------------------- the endpoint -------------------------------


class FakeCursor:
    def __init__(self, docs):
        self._docs = docs

    async def to_list(self, length=100):
        return self._docs


class FakeCollection:
    def __init__(self, find_result=None, find_one_result=None, distinct_result=None):
        self._find_result = find_result or []
        self._find_one_result = find_one_result
        self._distinct_result = distinct_result or []
        self.update_one_calls = []
        self.find_one_queries = []

    def find(self, query=None, *args, **kwargs):
        return FakeCursor(self._find_result)

    async def find_one(self, query=None, *args, **kwargs):
        self.find_one_queries.append(query)
        return self._find_one_result

    async def distinct(self, field, query=None):
        return self._distinct_result

    async def update_one(self, query, update, upsert=False):
        self.update_one_calls.append((query, update, upsert))


class FakeDb:
    def __init__(self, race_docs, sprint_docs=None, cached=None, stored_standings=None):
        self.races = FakeCollection(find_result=SCHEDULE)
        self.race_results = FakeCollection(find_result=race_docs)
        self.sprint_results = FakeCollection(find_result=sprint_docs or [])
        self.driver_standings = FakeCollection(
            find_one_result={"standings": stored_standings} if stored_standings else None
        )
        self.historical_race_index = FakeCollection(
            distinct_result=list(range(1950, 2026)),
            find_result=[{"driver": "George Russell"}],
        )
        self.catch_up_narrative = FakeCollection(find_one_result=cached)


RACES = [
    race_doc(1, "Australian Grand Prix", ["rus", "ant", "ver"]),
    race_doc(2, "Chinese Grand Prix", ["ant", "ver", "rus"]),
]


def call(db, after_round=1, narrative=True):
    async def run():
        with patch.object(catch_up, "get_db", return_value=db):
            response = await catch_up.get_catch_up(season=2026, after_round=after_round, narrative=narrative)
            return json.loads(response.body)

    return asyncio.run(run())


class EndpointTests(unittest.TestCase):
    def tearDown(self):
        catch_up._IN_FLIGHT.clear()

    def test_nothing_missed_answers_without_calling_the_model(self):
        fake, calls = scripted_llm("should not be asked")
        with patch.object(catch_up, "_generate_recap", fake):
            body = call(FakeDb(RACES), after_round=2)
        self.assertEqual(body["rounds"], [])
        self.assertIsNone(body["narrative"])
        self.assertEqual(calls, [])

    def test_llm_unavailable_still_returns_the_facts(self):
        with patch.dict(os.environ, {"OLLAMA_API_KEY": ""}):
            db = FakeDb(RACES)
            body = call(db)
        self.assertEqual(body["rounds"][0]["race"]["winner"]["driver_id"], "antonelli")
        self.assertEqual(body["facts"]["standings"]["title_gap_now"]["points"], 3)
        self.assertIsNone(body["narrative"])
        # An empty answer is not cached, so the next visitor tries again.
        self.assertEqual(db.catch_up_narrative.update_one_calls, [])

    def test_first_career_win_uses_the_history_index(self):
        with patch.dict(os.environ, {"OLLAMA_API_KEY": ""}):
            body = call(FakeDb(RACES))
        self.assertEqual(
            [(n["kind"], n["driver"]["driver_id"]) for n in body["facts"]["notable"]],
            [("first_career_win", "antonelli")],
        )

    def test_a_cache_miss_generates_and_writes_back_under_the_bounded_key(self):
        db = FakeDb(RACES)
        fake, calls = scripted_llm("Antonelli won in China and leads by 3 points.")
        with patch.object(catch_up, "_generate_recap", fake):
            body = call(db)
        self.assertEqual(body["narrative"], "Antonelli won in China and leads by 3 points.")
        [(query, update, upsert)] = db.catch_up_narrative.update_one_calls
        self.assertEqual(
            query,
            {"season": 2026, "after_round": 1, "latest_round": 2,
             "prompt_version": catch_up.PROMPT_VERSION},
        )
        self.assertTrue(upsert)
        self.assertEqual(update["$set"]["rejected"], False)
        self.assertEqual(
            update["$set"]["inputs"],
            catch_up.input_fingerprint(catch_up.narrative_facts(body), catch_up.SYSTEM_PROMPT),
        )

    def test_a_cache_hit_with_matching_inputs_replays_without_the_model(self):
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, RACES, [], prior_winners=set())
        inputs = catch_up.input_fingerprint(catch_up.narrative_facts(payload), catch_up.SYSTEM_PROMPT)
        db = FakeDb(RACES, cached={"text": "cached summary", "inputs": inputs})
        fake, calls = scripted_llm("fresh summary")
        with patch.object(catch_up, "_generate_recap", fake):
            body = call(db)
        self.assertEqual(body["narrative"], "cached summary")
        self.assertEqual(calls, [])

    def test_a_narrative_written_from_different_facts_is_regenerated(self):
        # e.g. the classification was revised after the narrative was written.
        db = FakeDb(RACES, cached={"text": "stale summary", "inputs": "before-the-appeal"})
        fake, calls = scripted_llm("Antonelli won in China.")
        with patch.object(catch_up, "_generate_recap", fake):
            body = call(db)
        self.assertEqual(body["narrative"], "Antonelli won in China.")
        self.assertEqual(len(calls), 1)

    def test_a_rejected_narrative_replays_as_null_without_regenerating(self):
        payload = catch_up.build_catch_up(2026, 1, SCHEDULE, RACES, [], prior_winners=set())
        inputs = catch_up.input_fingerprint(catch_up.narrative_facts(payload), catch_up.SYSTEM_PROMPT)
        db = FakeDb(RACES, cached={"text": None, "rejected": True, "inputs": inputs})
        fake, calls = scripted_llm("should not be asked")
        with patch.object(catch_up, "_generate_recap", fake):
            body = call(db)
        self.assertIsNone(body["narrative"])
        self.assertEqual(calls, [])

    def test_a_rejection_is_cached_as_rejected(self):
        db = FakeDb(RACES)
        fake, _ = scripted_llm("Leads by 12.", "Leads by 11.")
        with patch.object(catch_up, "_generate_recap", fake):
            body = call(db)
        self.assertIsNone(body["narrative"])
        [(_, update, _)] = db.catch_up_narrative.update_one_calls
        self.assertEqual((update["$set"]["text"], update["$set"]["rejected"]), (None, True))

    def test_facts_only_requests_do_not_wait_for_the_model(self):
        db = FakeDb(RACES)
        gate = asyncio.Event()

        async def slow(facts, system_prompt):
            await gate.wait()
            yield "never seen by this request"

        async def run():
            with patch.object(catch_up, "get_db", return_value=db), \
                    patch.object(catch_up, "_generate_recap", slow):
                response = await catch_up.get_catch_up(season=2026, after_round=1, narrative=False)
                body = json.loads(response.body)
                # The generation was started in the background...
                self.assertEqual(len(catch_up._IN_FLIGHT), 1)
                gate.set()
                await asyncio.gather(*catch_up._IN_FLIGHT.values())
                return body

        body = asyncio.run(run())
        self.assertIsNone(body["narrative"])
        self.assertEqual(body["rounds"][0]["round"], 2)
        # ...and still wrote its result for the next visitor.
        self.assertEqual(len(db.catch_up_narrative.update_one_calls), 1)

    def test_concurrent_visitors_share_one_generation(self):
        db = FakeDb(RACES)
        fake, calls = scripted_llm("Antonelli won in China.")

        async def run():
            with patch.object(catch_up, "get_db", return_value=db), \
                    patch.object(catch_up, "_generate_recap", fake):
                return await asyncio.gather(
                    catch_up.get_catch_up(season=2026, after_round=1, narrative=True),
                    catch_up.get_catch_up(season=2026, after_round=1, narrative=True),
                )

        responses = asyncio.run(run())
        self.assertEqual(
            [json.loads(r.body)["narrative"] for r in responses],
            ["Antonelli won in China."] * 2,
        )
        self.assertEqual(len(calls), 1)

    def test_a_slow_model_times_out_to_null(self):
        db = FakeDb(RACES)

        async def never(facts, system_prompt):
            await asyncio.sleep(3600)
            yield ""

        async def run():
            with patch.object(catch_up, "get_db", return_value=db), \
                    patch.object(catch_up, "_generate_recap", never), \
                    patch.object(catch_up, "NARRATIVE_WAIT_SECONDS", 0.05):
                response = await catch_up.get_catch_up(season=2026, after_round=1, narrative=True)
                for task in catch_up._IN_FLIGHT.values():
                    task.cancel()
                return json.loads(response.body)

        body = asyncio.run(run())
        self.assertIsNone(body["narrative"])
        self.assertEqual(body["rounds"][0]["race"]["winner"]["driver_id"], "antonelli")


if __name__ == "__main__":
    unittest.main()
