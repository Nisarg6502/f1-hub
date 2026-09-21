"""Unit tests for `agent/fast_path.py` — the rules-first fast path for a
handful of high-frequency, unambiguous intents.

Same fake-Mongo pattern `test_agent_tools.py` already uses (a plain
dict-backed fake collection, not a Motor mock), duplicated here rather than
imported — this repo's existing test files each keep their own copy rather
than share one, and `fast_path.py`'s own docstring makes the identical
argument for staying import-light: a shared test-fixtures module would be one
more thing this file did not actually need.

`model.stream_chat` is monkeypatched to a scripted async generator rather
than hitting the network, matching how the rest of this test suite treats the
model seam as an external dependency to fake, never to call for real.
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import fast_path, router
from agent.ledger import EvidenceLedger


@contextlib.contextmanager
def patched_model(replies: list[str]):
    """Swap `fast_path.model_seam.stream_chat` for a scripted fake, and put
    the real function back afterwards.

    `model_seam` is `fast_path`'s own alias for the `agent.model` module
    object (`from . import model as model_seam`), so assigning through it
    patches the same module every other caller sees — deliberately restored
    with the saved original rather than `del`, since `del`ing a module-level
    name here would leave nothing behind for the next test to patch over.
    """
    scripted = ScriptedModel(replies)
    original = fast_path.model_seam.stream_chat
    fast_path.model_seam.stream_chat = scripted
    try:
        yield scripted
    finally:
        fast_path.model_seam.stream_chat = original


# --------------------------------------------------------------------------
# fakes
# --------------------------------------------------------------------------


def _matches(doc, query):
    for key, value in (query or {}).items():
        if doc.get(key) != value:
            return False
    return True


class FakeCollection:
    def __init__(self, docs=None):
        self.docs = [dict(d) for d in (docs or [])]

    async def find_one(self, query=None, projection=None):
        await asyncio.sleep(0)
        for doc in self.docs:
            if _matches(doc, query or {}):
                return dict(doc)
        return None

    def find(self, query=None, projection=None):
        matched = [dict(d) for d in self.docs if _matches(d, query or {})]

        class _Cursor:
            async def to_list(self_inner, length=None):
                await asyncio.sleep(0)
                return matched if length is None else matched[:length]

        return _Cursor()


class FakeDB:
    def __init__(self, **collections):
        self._collections = {
            name: value if isinstance(value, FakeCollection) else FakeCollection(value)
            for name, value in collections.items()
        }

    def __getattr__(self, name):
        return self._collections.setdefault(name, FakeCollection())

    def __getitem__(self, name):
        return getattr(self, name)


def run(coro):
    return asyncio.run(coro)


class ScriptedModel:
    """Stands in for `model.stream_chat`: yields each scripted reply's text in
    one chunk, in order, one script entry per call. Also records every
    `messages` list it was called with, so a test can assert whether a repair
    call happened at all."""

    def __init__(self, replies: list[str]):
        self.replies = list(replies)
        self.calls: list[list[dict]] = []

    async def __call__(self, messages, *, model=None, tools=None):
        self.calls.append(messages)
        reply = self.replies.pop(0) if self.replies else ""
        yield reply


# --------------------------------------------------------------------------
# fixtures — one past round, one future round, deliberately far from "today"
# on both sides so this suite never depends on the real wall clock.
# --------------------------------------------------------------------------

PAST_RACE = {
    "season": 2026, "round": "1", "raceName": "Bahrain Grand Prix",
    "date": "2020-01-01",
    "Circuit": {
        "circuitId": "bahrain", "circuitName": "Bahrain International Circuit",
        "Location": {"locality": "Sakhir", "country": "Bahrain"},
    },
}
FUTURE_RACE = {
    "season": 2026, "round": "2", "raceName": "Saudi Arabian Grand Prix",
    "date": "2099-01-01",
    "Circuit": {
        "circuitId": "jeddah", "circuitName": "Jeddah Corniche Circuit",
        "Location": {"locality": "Jeddah", "country": "Saudi Arabia"},
    },
}

RACE_RESULT_DOC = {
    "season": 2026, "round": "1", "synced_at": "2026-01-02T00:00:00+00:00",
    "race": {"raceName": "Bahrain Grand Prix", "date": "2020-01-01",
              "Circuit": {"circuitName": "Bahrain International Circuit"}},
    "results": [
        {
            "position": "1", "positionText": "1", "grid": "1", "points": "25",
            "status": "Finished", "Time": {"time": "1:30:00.000"},
            "Driver": {"driverId": "verstappen", "code": "VER",
                       "givenName": "Max", "familyName": "Verstappen"},
            "Constructor": {"constructorId": "red_bull", "name": "Red Bull"},
        },
        {
            "position": "2", "positionText": "2", "grid": "2", "points": "18",
            "status": "Finished", "Time": {"time": "+5.000"},
            "Driver": {"driverId": "norris", "code": "NOR",
                       "givenName": "Lando", "familyName": "Norris"},
            "Constructor": {"constructorId": "mclaren", "name": "McLaren"},
        },
    ],
}

DRIVER_STANDINGS_DOC = {
    "season": 2026, "synced_at": "2026-01-02T00:00:00+00:00",
    "standings": [
        {
            "position": "1", "points": "25", "wins": "1",
            "Driver": {"driverId": "verstappen", "givenName": "Max", "familyName": "Verstappen"},
            "Constructors": [{"name": "Red Bull"}],
        },
        {
            "position": "2", "points": "18", "wins": "0",
            "Driver": {"driverId": "norris", "givenName": "Lando", "familyName": "Norris"},
            "Constructors": [{"name": "McLaren"}],
        },
    ],
}

CONSTRUCTOR_STANDINGS_DOC = {
    "season": 2026, "synced_at": "2026-01-02T00:00:00+00:00",
    "standings": [
        {"position": "1", "points": "25", "wins": "1",
         "Constructor": {"constructorId": "red_bull", "name": "Red Bull"}},
        {"position": "2", "points": "18", "wins": "0",
         "Constructor": {"constructorId": "mclaren", "name": "McLaren"}},
    ],
}


def full_db() -> FakeDB:
    return FakeDB(
        races=[PAST_RACE, FUTURE_RACE],
        race_results=[RACE_RESULT_DOC],
        driver_standings=[DRIVER_STANDINGS_DOC],
        constructor_standings=[CONSTRUCTOR_STANDINGS_DOC],
    )


def empty_db() -> FakeDB:
    return FakeDB()


async def _collect(agen):
    return [event async for event in agen]


# --------------------------------------------------------------------------
# detect()
# --------------------------------------------------------------------------


class DetectTests(unittest.TestCase):
    def test_last_race_winner_matches(self):
        for question in (
            "Who won the last race?",
            "who won the last f1 race",
            "Who took the most recent grand prix?",
            "Who won the last race this season?",
        ):
            self.assertEqual(fast_path.detect(question), "last_race_winner", question)

    def test_drivers_leader_matches(self):
        for question in (
            "Who's leading the drivers' championship?",
            "who leads the drivers championship",
            "Who is currently leading the drivers standings?",
        ):
            self.assertEqual(fast_path.detect(question), "drivers_leader", question)

    def test_constructors_leader_matches(self):
        self.assertEqual(
            fast_path.detect("Who's leading the constructors' championship?"),
            "constructors_leader",
        )

    def test_next_race_matches(self):
        for question in ("When is the next race?", "What's the next race?"):
            self.assertEqual(fast_path.detect(question), "next_race", question)

    def test_empty_question_is_none(self):
        self.assertIsNone(fast_path.detect(""))
        self.assertIsNone(fast_path.detect(None))

    def test_a_named_year_is_excluded(self):
        # A specific season needs `resolve_context`, not the clock-relative
        # tools this module calls unconditionally.
        self.assertIsNone(fast_path.detect("Who won the last race in 2021?"))

    def test_trailing_qualifier_breaks_the_anchor(self):
        # "at Monaco" makes this a *specific* race, not "the last one" — the
        # end-anchored pattern is the actual mechanism that excludes it.
        self.assertIsNone(fast_path.detect("Who won the last race at Monaco?"))

    def test_comparative_question_is_excluded_via_the_router_gate(self):
        # Tier 2 (comparative) — excluded through `router.classify`, not a
        # second copy of its patterns.
        self.assertEqual(router.classify("Compare Verstappen and Norris this season").tier, 2)
        self.assertIsNone(
            fast_path.detect("Compare Verstappen and Norris this season")
        )

    def test_predictive_question_is_excluded_via_the_router_gate(self):
        question = "Who will win this weekend's next race?"
        self.assertEqual(router.classify(question).tier, 3)
        self.assertIsNone(fast_path.detect(question))

    def test_unrelated_question_is_none(self):
        self.assertIsNone(fast_path.detect("What team does Piastri drive for?"))


# --------------------------------------------------------------------------
# run() — last_race_winner
# --------------------------------------------------------------------------


class RunLastRaceWinnerTests(unittest.TestCase):
    def test_success_path_cites_real_evidence_and_passes_verification(self):
        with patched_model(["Verstappen won the last race [ev_1]."]) as scripted:
            ledger = EvidenceLedger()
            events = run(_collect(
                fast_path.run("Who won the last race?", "last_race_winner", ledger, db=full_db())
            ))

        kinds = [e[0] for e in events]
        self.assertIn("activity", kinds)
        self.assertIn("verification", kinds)
        self.assertIn("token", kinds)

        verification = next(e for e in events if e[0] == "verification")
        self.assertTrue(verification[1], msg=events)
        self.assertEqual(verification[2], 0)

        text = "".join(e[1] for e in events if e[0] == "token")
        self.assertIn("Verstappen", text)
        self.assertEqual(len(scripted.calls), 1)  # exactly one model call

        # Both tool calls actually ran and landed real evidence in the ledger.
        self.assertEqual(len(ledger), 2)

    def test_repair_runs_once_when_the_first_draft_is_uncited(self):
        # ev_1 is `get_season_state`'s bundle; ev_2 is `get_session_result`'s
        # — the "25 points" figure only actually lives in ev_2's data, so the
        # repaired draft has to cite the right one to pass.
        with patched_model([
            "Verstappen won the last race with 25 points.",  # uncited number
            "Verstappen won the last race with 25 points [ev_2].",
        ]) as scripted:
            ledger = EvidenceLedger()
            events = run(_collect(
                fast_path.run("Who won the last race?", "last_race_winner", ledger, db=full_db())
            ))

        self.assertEqual(len(scripted.calls), 2)  # the repair call happened
        verification = next(e for e in events if e[0] == "verification")
        self.assertTrue(verification[1], msg=events)
        text = "".join(e[1] for e in events if e[0] == "token")
        self.assertIn("[ev_2]", text)

    def test_no_completed_race_yet_still_produces_a_cited_non_answer(self):
        no_race_db = FakeDB(races=[FUTURE_RACE])  # nothing completed
        with patched_model(["No race has been completed yet this season."]):
            ledger = EvidenceLedger()
            events = run(_collect(
                fast_path.run("Who won the last race?", "last_race_winner", ledger, db=no_race_db)
            ))

        # Only `get_season_state` ran — there is no round to look up a result for.
        self.assertEqual(len(ledger), 1)
        verification = next(e for e in events if e[0] == "verification")
        self.assertTrue(verification[1])


# --------------------------------------------------------------------------
# run() — championship leaders
# --------------------------------------------------------------------------


class RunLeaderTests(unittest.TestCase):
    def test_drivers_leader_cites_the_standings(self):
        with patched_model(["Verstappen leads the drivers' championship [ev_2]."]):
            ledger = EvidenceLedger()
            events = run(_collect(
                fast_path.run(
                    "Who's leading the drivers' championship?",
                    "drivers_leader",
                    ledger,
                    db=full_db(),
                )
            ))

        verification = next(e for e in events if e[0] == "verification")
        self.assertTrue(verification[1], msg=events)
        text = "".join(e[1] for e in events if e[0] == "token")
        self.assertIn("Verstappen", text)

    def test_constructors_leader_cites_the_standings(self):
        with patched_model(["Red Bull leads the constructors' championship [ev_2]."]):
            ledger = EvidenceLedger()
            events = run(_collect(
                fast_path.run(
                    "Who's leading the constructors' championship?",
                    "constructors_leader",
                    ledger,
                    db=full_db(),
                )
            ))

        verification = next(e for e in events if e[0] == "verification")
        self.assertTrue(verification[1], msg=events)
        text = "".join(e[1] for e in events if e[0] == "token")
        self.assertIn("Red Bull", text)


# --------------------------------------------------------------------------
# run() — next race
# --------------------------------------------------------------------------


class RunNextRaceTests(unittest.TestCase):
    def test_next_race_cites_the_season_state(self):
        with patched_model(["The next race is the Saudi Arabian Grand Prix [ev_1]."]):
            ledger = EvidenceLedger()
            events = run(_collect(
                fast_path.run("When is the next race?", "next_race", ledger, db=full_db())
            ))

        verification = next(e for e in events if e[0] == "verification")
        self.assertTrue(verification[1], msg=events)
        text = "".join(e[1] for e in events if e[0] == "token")
        self.assertIn("Saudi Arabian", text)

    def test_no_calendar_synced_is_still_a_clean_run(self):
        with patched_model(["I don't have the season calendar available right now."]):
            ledger = EvidenceLedger()
            events = run(_collect(
                fast_path.run("When is the next race?", "next_race", ledger, db=empty_db())
            ))

        self.assertEqual(len(ledger), 0)  # get_season_state came back unavailable
        verification = next(e for e in events if e[0] == "verification")
        self.assertTrue(verification[1])


if __name__ == "__main__":
    unittest.main()
