"""Tests for `get_circuit_dossier` and the measurement behind it.

Two things are being proved here, and they are not the same thing.

**That the arithmetic is right** — `count_position_gains`, `classify_result`
and `summarise_results` are pure functions over plain documents, so every
edge case that bit during development (a lapped-but-classified finisher, a
pit-lane start, a driver whose timing drops out mid-race) is asserted against
a hand-built race rather than against the live cluster.

**That the answer is grounded** — which is the harder and more important
claim, because "Monaco is hard to overtake at" is something a language model
already believes. A tool that returned a plausible number would be
indistinguishable from one that returned a *retrieved* number, and the whole
feature is worthless if it is the former. `GroundingTests` below settles it
by inversion: it feeds the pipeline a fabricated world in which Monaco churns
harder than anywhere else and Monza is frozen solid, and asserts the tool
reports exactly that. Nothing that leans on prior knowledge of Formula 1 can
pass that test, and nothing that reads the rows it was given can fail it.

No Ollama call is made anywhere in this file, per the CP61 brief — the free
tier's quota is shared and precious, and none of these claims needs a model
to check.
"""

import asyncio
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

if "motor.motor_asyncio" not in sys.modules:  # pragma: no cover - env dependent
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from agent.ledger import EvidenceLedger
from agent.tools import TOOLS
from agent.tools.circuit_scope import VALID_FOCUSES, get_circuit_dossier
from app import circuit_character as cc


# --------------------------------------------------------------------------
# fakes
#
# Deliberately supports the two access shapes `circuit_character` actually
# uses and no more: `async for` over a cursor (it streams `race_laps`, which
# is ~1000 rows per race, rather than materialising all 52 documents) and
# `count_documents` (the freshness key). A fake that quietly accepted an
# operator it could not evaluate is the failure mode `test_agent_tools.py`'s
# docstring warns about, so unknown operators raise here too.
# --------------------------------------------------------------------------


def _field(doc, path):
    value = doc
    for part in path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def _matches(doc, query):
    for path, condition in (query or {}).items():
        if isinstance(condition, dict):
            raise AssertionError(
                f"the fake collection does not implement {condition!r}; "
                "implement it rather than letting an unevaluated query pass"
            )
        value = _field(doc, path)
        # Type-strict, like real MongoDB: `"14"` does not match `14`. Every
        # collection here stores `round` as an Ergast string, so a builder
        # that forgot `str()` must fail here rather than in production.
        if type(value) is not type(condition) or value != condition:
            return False
    return True


class FakeCollection:
    def __init__(self, docs=None, fail=False):
        self.docs = [dict(d) for d in (docs or [])]
        self.fail = fail

    async def find_one(self, query=None, projection=None):
        await asyncio.sleep(0)
        if self.fail:
            raise RuntimeError("connection lost")
        for doc in self.docs:
            if _matches(doc, query or {}):
                return dict(doc)
        return None

    async def count_documents(self, query=None):
        await asyncio.sleep(0)
        if self.fail:
            raise RuntimeError("connection lost")
        return sum(1 for d in self.docs if _matches(d, query or {}))

    async def replace_one(self, query, document, upsert=False):
        await asyncio.sleep(0)
        for index, doc in enumerate(self.docs):
            if _matches(doc, query or {}):
                self.docs[index] = dict(document)
                return
        if upsert:
            self.docs.append(dict(document))

    def find(self, query=None, projection=None):
        fail = self.fail
        matched = [dict(d) for d in self.docs if _matches(d, query or {})]

        class _Cursor:
            async def to_list(self_inner, length=None):
                await asyncio.sleep(0)
                if fail:
                    raise RuntimeError("connection lost")
                return matched if length is None else matched[:length]

            def __aiter__(self_inner):
                if fail:
                    raise RuntimeError("connection lost")

                async def _gen():
                    for doc in matched:
                        await asyncio.sleep(0)
                        yield doc

                return _gen()

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


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

SYNCED_RACES = "2026-07-20T09:00:00+00:00"


def race_doc(season, rnd, circuit_id, name, url=None):
    return {
        "season": season,
        "round": str(rnd),
        "raceName": name,
        "date": f"{season}-05-25",
        "synced_at": SYNCED_RACES,
        "Circuit": {
            "circuitId": circuit_id,
            "circuitName": circuit_id.replace("_", " ").title(),
            "url": url or f"https://en.wikipedia.org/wiki/{circuit_id}",
            "Location": {"locality": "Somewhere", "country": "Nowhere"},
        },
    }


def laps_doc(season, rnd, orders):
    """`orders` is a list of per-lap position maps: `{driver_number: position}`."""
    rows = []
    for lap_number, order in enumerate(orders, start=1):
        for number, position in order.items():
            rows.append(
                {
                    "driver_number": number,
                    "lap_number": lap_number,
                    "position": position,
                }
            )
    return {"season": season, "round": str(rnd), "laps": rows,
            "synced_at": SYNCED_RACES}


def static_race(season, rnd, laps=10):
    """Nobody ever changes position — zero gains over `laps` laps."""
    return laps_doc(season, rnd, [{1: 1, 2: 2, 3: 3}] * laps)


def churning_race(season, rnd, laps=10):
    """Two cars swap the lead every lap — a gain on every other lap."""
    orders = []
    for lap in range(laps):
        orders.append({1: 1, 2: 2, 3: 3} if lap % 2 == 0 else {1: 2, 2: 1, 3: 3})
    return laps_doc(season, rnd, orders)


def result_row(number, driver_id, position_text, grid, position=None, status="Finished"):
    return {
        "number": str(number),
        "position": str(position if position is not None else position_text),
        "positionText": str(position_text),
        "grid": str(grid),
        "status": status,
        "Driver": {"driverId": driver_id, "givenName": "A", "familyName": "B"},
        "Constructor": {"constructorId": "team", "name": "Team"},
    }


# --------------------------------------------------------------------------
# the measurement
# --------------------------------------------------------------------------


class PositionGainTests(unittest.TestCase):
    def test_a_single_overtake_is_one_gain(self):
        rows = laps_doc(2026, 1, [{1: 1, 2: 2}, {1: 2, 2: 1}])["laps"]
        gains, pit_gains, racing_laps = cc.count_position_gains(rows)
        self.assertEqual(gains, 1)
        self.assertEqual(pit_gains, 0)
        self.assertEqual(racing_laps, 2)

    def test_a_static_race_produces_no_gains_at_all(self):
        gains, _, racing_laps = cc.count_position_gains(static_race(2026, 1)["laps"])
        self.assertEqual(gains, 0)
        self.assertEqual(racing_laps, 10)

    def test_places_gained_count_individually_not_as_one_move(self):
        """A driver going P8 to P3 in one lap gained five places, not one."""
        rows = laps_doc(2026, 1, [{7: 8}, {7: 3}])["laps"]
        gains, _, _ = cc.count_position_gains(rows)
        self.assertEqual(gains, 5)

    def test_a_gap_in_a_driver_s_lap_rows_is_not_bridged(self):
        """A missing lap usually means timing dropped out, not a 4-place move.

        Bridging it would credit a driver with every place that changed hands
        while they were invisible — and the invisible stretches are exactly
        the incident-heavy ones, so the error would concentrate at the
        circuits this metric is meant to distinguish.
        """
        rows = [
            {"driver_number": 5, "lap_number": 1, "position": 9},
            {"driver_number": 5, "lap_number": 4, "position": 5},
        ]
        gains, _, racing_laps = cc.count_position_gains(rows)
        self.assertEqual(gains, 0)
        self.assertEqual(racing_laps, 4)

    def test_pit_lap_gains_are_reported_separately_never_silently_dropped(self):
        rows = laps_doc(2026, 1, [{1: 1, 2: 2}, {1: 2, 2: 1}])["laps"]
        gains, pit_gains, _ = cc.count_position_gains(rows, {2: {1, 2}})
        self.assertEqual(gains, 1)
        self.assertEqual(pit_gains, 1)

    def test_rows_missing_a_position_are_skipped_not_treated_as_zero(self):
        rows = [
            {"driver_number": 1, "lap_number": 1, "position": None},
            {"driver_number": 1, "lap_number": 2, "position": 3},
        ]
        gains, _, _ = cc.count_position_gains(rows)
        self.assertEqual(gains, 0)


class ClassifyResultTests(unittest.TestCase):
    """`positionText` is the authority, not `status`.

    Both cases below are real disagreements found in the stored data on
    2026-08-18: 13 rows carry a numeric position with a `"Retired"` status
    (classified despite stopping late), and 2 carry `"R"` with a `"Lapped"`
    status. Reading `status` would move both into the wrong bucket, and it
    would do so preferentially at circuits where cars break — inflating the
    retirement rate exactly where this tool is asked about it.
    """

    def test_a_numeric_position_with_a_retired_status_is_classified(self):
        row = result_row(1, "a", position_text=14, grid=3, status="Retired")
        self.assertEqual(cc.classify_result(row), "classified")

    def test_position_text_R_with_a_lapped_status_is_a_retirement(self):
        row = result_row(1, "a", position_text="R", grid=3, position=18, status="Lapped")
        self.assertEqual(cc.classify_result(row), "retired")

    def test_lapped_finishers_are_classified_under_both_spellings(self):
        for status in ("Lapped", "+1 Lap"):
            with self.subTest(status=status):
                row = result_row(1, "a", position_text=12, grid=3, status=status)
                self.assertEqual(cc.classify_result(row), "classified")

    def test_did_not_start_and_disqualified_are_their_own_buckets(self):
        self.assertEqual(
            cc.classify_result(result_row(1, "a", "W", 3, status="Did not start")),
            "did_not_start",
        )
        self.assertEqual(
            cc.classify_result(result_row(1, "a", "D", 3, status="Disqualified")),
            "disqualified",
        )


class SummariseResultsTests(unittest.TestCase):
    def test_a_pit_lane_start_is_excluded_rather_than_counted_as_grid_zero(self):
        """`grid: "0"` means the pit lane. Treating it as a grid slot would
        hand that driver a fabricated ~+18 place gain — 2 of 801 stored rows
        have it, and both are at circuits with only one or two races sampled,
        so each would move the circuit's mean on its own."""
        docs = [
            {
                "results": [
                    result_row(1, "a", 1, grid=1),
                    result_row(2, "b", 2, grid=0),
                ]
            }
        ]
        summary = cc.summarise_results(docs)
        self.assertEqual(summary["drivers_compared"], 1)
        self.assertEqual(summary["mean_abs_grid_to_finish"], 0.0)

    def test_pole_to_win_counts_only_wins_from_the_front_row_slot_one(self):
        docs = [
            {"results": [result_row(1, "a", 1, grid=1)]},
            {"results": [result_row(2, "b", 1, grid=4)]},
        ]
        summary = cc.summarise_results(docs)
        self.assertEqual(summary["winner_grid_slots"], [1, 4])
        self.assertEqual(summary["pole_to_win"], 1)

    def test_retirement_rate_is_over_entries_not_over_finishers(self):
        docs = [
            {
                "results": [
                    result_row(1, "a", 1, grid=1),
                    result_row(2, "b", "R", grid=2, position=20, status="Retired"),
                ]
            }
        ]
        summary = cc.summarise_results(docs)
        self.assertEqual(summary["outcomes"]["retired"], 1)
        self.assertEqual(summary["retirement_rate"], 0.5)


class RankTests(unittest.TestCase):
    def test_rank_one_is_the_least_position_change(self):
        ranks, median = cc.rank_and_median({"a": 3.0, "b": 1.0, "c": 2.0})
        self.assertEqual(ranks["b"], 1)
        self.assertEqual(ranks["a"], 3)
        self.assertEqual(median, 2.0)


# --------------------------------------------------------------------------
# grounding
# --------------------------------------------------------------------------


def _inverted_world():
    """A world where Monaco churns and Monza is frozen — the opposite of life.

    Monaco: two cars swapping the lead every lap for 10 laps.
    Monza:  the same three cars in the same order for 10 laps.
    """
    return FakeDB(
        races=[
            race_doc(2026, 1, "monaco", "Monaco Grand Prix"),
            race_doc(2026, 2, "monza", "Italian Grand Prix"),
        ],
        race_laps=[churning_race(2026, 1), static_race(2026, 2)],
        race_results=[
            {"season": 2026, "round": "1", "synced_at": SYNCED_RACES,
             "results": [result_row(1, "a", 1, grid=1), result_row(2, "b", 2, grid=2)]},
            {"season": 2026, "round": "2", "synced_at": SYNCED_RACES,
             "results": [result_row(1, "a", 1, grid=1), result_row(2, "b", 2, grid=2)]},
        ],
    )


class GroundingTests(unittest.TestCase):
    """The claim this whole feature rests on, tested the only way it can be.

    A model already "knows" Monaco is hard to overtake at. So does a reader
    skimming the output. That means a tool returning a *plausible* number is
    indistinguishable from one returning a *retrieved* number by inspection —
    the only way to tell them apart is to make the data disagree with the
    world and check which one the tool follows.

    `_inverted_world` is Monaco churning twice a lap and Monza frozen. The
    real cached data says the reverse (Monaco 0.846, Monza 3.123, measured
    2026-08-18). If any part of this path leaned on a hardcoded table, a
    reputation, or a model's priors, these assertions fail.
    """

    def test_the_index_follows_the_data_and_not_the_reputation(self):
        db = _inverted_world()
        index = run(cc.build_index(db))
        monaco = index["circuits"]["monaco"]["position_gains_per_lap"]
        monza = index["circuits"]["monza"]["position_gains_per_lap"]
        self.assertGreater(monaco, monza)
        self.assertEqual(monza, 0.0)
        self.assertEqual(index["field"]["lowest"], "monza")
        self.assertEqual(index["field"]["highest"], "monaco")

    def test_the_tool_reports_monaco_as_the_easiest_circuit_in_that_world(self):
        db = _inverted_world()
        result = run(get_circuit_dossier("monaco", "overtaking", db=db))
        self.assertTrue(result["available"])
        data = result["data"]
        # Rank 1 is the LEAST position change. In this fabricated world that
        # is Monza, so Monaco must be rank 2 of 2.
        self.assertEqual(data["rank_least_position_change"], 2)
        self.assertEqual(data["circuits_compared"], 2)
        self.assertGreater(
            data["position_gains_per_lap"],
            data["field_median_position_gains_per_lap"],
        )

    def test_every_number_in_the_bundle_is_recomputable_from_the_rows(self):
        """Not "looks right" — recomputed independently from the same laps.

        9 gains over 10 racing laps: the two lead cars swap on every lap after
        the first, and only the car moving *up* scores.
        """
        db = _inverted_world()
        result = run(get_circuit_dossier("monaco", "overtaking", db=db))
        data = result["data"]
        self.assertEqual(data["raw_gains"], 9)
        self.assertEqual(data["racing_laps"], 10)
        self.assertEqual(data["pit_excluded_gains"], 0)
        self.assertEqual(data["position_gains_per_lap"], 0.9)

    def test_the_wikipedia_url_is_the_stored_one_not_a_composed_guess(self):
        """The '+ Wikipedia extract' half of the roadmap item. A URL composed
        from a circuit name resolves to a disambiguation page or a 404 for
        several circuits; this one came from the same Ergast record as the
        results, so `web_extract` has something real to read."""
        db = FakeDB(
            races=[
                race_doc(2026, 1, "monaco", "Monaco Grand Prix",
                         url="https://en.wikipedia.org/wiki/Circuit_de_Monaco")
            ],
            race_laps=[churning_race(2026, 1)],
        )
        result = run(get_circuit_dossier("monaco", "overtaking", db=db))
        self.assertEqual(
            result["data"]["wikipedia_url"],
            "https://en.wikipedia.org/wiki/Circuit_de_Monaco",
        )


# --------------------------------------------------------------------------
# the fact-bundle contract
# --------------------------------------------------------------------------


class BundleContractTests(unittest.TestCase):
    def test_a_success_is_a_citable_fact_bundle(self):
        ledger = EvidenceLedger()
        db = _inverted_world()
        result = run(get_circuit_dossier("monaco", "overtaking", ledger=ledger, db=db))

        self.assertTrue(result["available"])
        for key in ("data", "evidence_id", "source", "as_of"):
            self.assertIn(key, result)
        self.assertTrue(result["source"].startswith("mongo:circuit_character_cache/"))
        # The id the answer must cite actually resolves in the ledger it was
        # written to — an unresolvable id is the same as no citation.
        self.assertIsNotNone(ledger.get(result["evidence_id"]))

    def test_as_of_comes_from_the_data_not_the_clock(self):
        db = _inverted_world()
        result = run(get_circuit_dossier("monaco", "overtaking", db=db))
        # `races` is the oldest input here; the freshly built index is stamped
        # now, and a bundle is only as fresh as its stalest input.
        self.assertEqual(result["as_of"], SYNCED_RACES)

    def test_an_unknown_circuit_is_unavailable_not_an_exception(self):
        result = run(get_circuit_dossier("nurburgring", "overtaking", db=_inverted_world()))
        self.assertFalse(result["available"])
        self.assertIn("nurburgring", result["reason"])

    def test_an_empty_circuit_id_is_unavailable(self):
        self.assertFalse(run(get_circuit_dossier("", db=_inverted_world()))["available"])

    def test_an_unreachable_database_is_unavailable_not_an_exception(self):
        """`fact_tool`'s blanket catch, exercised rather than assumed."""
        db = FakeDB(races=FakeCollection(fail=True))
        result = run(get_circuit_dossier("monaco", "overtaking", db=db))
        self.assertFalse(result["available"])

    def test_a_circuit_in_the_calendar_with_no_races_says_which_is_missing(self):
        """The two failures are different and the reason must say which: the
        circuit being absent from the calendar is a bad id, while a calendared
        circuit with no cached races is a sync gap. Collapsing them sends a
        reader hunting the wrong problem."""
        db = FakeDB(races=[race_doc(2027, 5, "madring", "Madrid Grand Prix")])
        result = run(get_circuit_dossier("madring", "overtaking", db=db))
        self.assertFalse(result["available"])
        self.assertIn("has not been measured", result["reason"])
        self.assertIn("in the calendar", result["reason"])


class FocusTests(unittest.TestCase):
    def test_the_default_focus_is_the_one_the_feature_was_built_for(self):
        result = run(get_circuit_dossier("monaco", db=_inverted_world()))
        self.assertEqual(result["data"]["focus"], "overtaking")
        self.assertIn("position_gains_per_lap", result["data"])

    def test_each_focus_returns_only_its_own_facts(self):
        """§5's context-budget rule: a focus that leaked its siblings' fields
        would make the parameter decorative and triple the bundle."""
        db = _inverted_world()
        overtaking = run(get_circuit_dossier("monaco", "overtaking", db=db))["data"]
        attrition = run(get_circuit_dossier("monaco", "attrition", db=db))["data"]
        strategy = run(get_circuit_dossier("monaco", "strategy", db=db))["data"]

        self.assertIn("position_gains_per_lap", overtaking)
        self.assertNotIn("retirement_rate", overtaking)

        self.assertIn("retirement_rate", attrition)
        self.assertNotIn("position_gains_per_lap", attrition)

        self.assertIn("safety_car_deployments", strategy)
        self.assertNotIn("position_gains_per_lap", strategy)

    def test_an_unknown_focus_redirects_to_the_tool_that_owns_it(self):
        """`winners` is the focus a model will reach for, and it is
        deliberately absent — see the tool's docstring on why a recent-seasons
        win tally must not sit beside `get_circuit_history`'s all-time one.
        The failure has to name that tool or the redirect does not happen."""
        result = run(get_circuit_dossier("monaco", "winners", db=_inverted_world()))
        self.assertFalse(result["available"])
        self.assertIn("get_circuit_history", result["reason"])
        self.assertEqual(result["valid_focuses"], list(VALID_FOCUSES))
        self.assertNotIn("winners", VALID_FOCUSES)

    def test_every_focus_carries_the_sample_size_it_was_measured_over(self):
        """A comparative index quoted without its own n is the overclaim this
        repo keeps writing post-mortems about. One to three races per circuit
        is thin, and the bundle has to say so on every path."""
        db = _inverted_world()
        for focus in VALID_FOCUSES:
            with self.subTest(focus=focus):
                data = run(get_circuit_dossier("monaco", focus, db=db))["data"]
                self.assertIn("sample", data)
                self.assertIn("confidence", data["sample"])
                self.assertGreaterEqual(data["sample"]["races_with_lap_data"], 1)

    def test_the_overtaking_bundle_forbids_calling_the_number_overtakes(self):
        """The metric counts position change, which includes retirements and
        pit cycles. The caveat travels with the number rather than living in
        a prompt, because a prompt rule is what CP41 proved does not hold."""
        data = run(get_circuit_dossier("monaco", "overtaking", db=_inverted_world()))["data"]
        self.assertIn("metric_caveat", data)
        self.assertIn("NOT an overtake count", data["metric_caveat"])

    def test_focus_is_case_and_whitespace_insensitive(self):
        result = run(get_circuit_dossier("MONACO", "  Overtaking ", db=_inverted_world()))
        self.assertTrue(result["available"])


class RegistrationTests(unittest.TestCase):
    def test_the_tool_is_in_the_registry_under_the_name_it_answers_to(self):
        self.assertIs(TOOLS["get_circuit_dossier"], get_circuit_dossier)

    def test_stats_scout_can_actually_reach_it(self):
        """A tool in `TOOLS` but in no subagent's list is unreachable on the
        tier-3 path. Asserted because the roster is a hand-written tuple."""
        from agent.subagents import STATS_SCOUT_TOOLS

        self.assertIn("get_circuit_dossier", STATS_SCOUT_TOOLS)


class CacheTests(unittest.TestCase):
    def test_the_index_is_rebuilt_when_a_new_race_lands(self):
        """Freshness is keyed on the source document count, not on a clock:
        the inputs only change when a race syncs, so a time-based check would
        rebuild for nothing between rounds and serve a stale index right after
        one."""
        db = _inverted_world()
        first = run(cc.load_index(db))
        self.assertEqual(first["source_lap_documents"], 2)

        again = run(cc.load_index(db))
        self.assertEqual(again["synced_at"], first["synced_at"])  # served cached

        db.race_laps.docs.append(static_race(2026, 3))
        db.races.docs.append(race_doc(2026, 3, "spa", "Belgian Grand Prix"))
        third = run(cc.load_index(db))
        self.assertEqual(third["source_lap_documents"], 3)
        self.assertIn("spa", third["circuits"])

    def test_a_version_bump_retires_an_index_written_by_the_old_definition(self):
        db = _inverted_world()
        run(cc.load_index(db))
        stored = run(db[cc.CACHE_COLLECTION].find_one({"_id": cc.CACHE_ID}))
        stored["version"] = cc.CHARACTER_VERSION - 1
        stored["circuits"] = {}
        run(db[cc.CACHE_COLLECTION].replace_one({"_id": cc.CACHE_ID}, stored))

        rebuilt = run(cc.load_index(db))
        self.assertEqual(rebuilt["version"], cc.CHARACTER_VERSION)
        self.assertIn("monaco", rebuilt["circuits"])

    def test_rebuild_false_reports_a_miss_rather_than_paying_for_a_build(self):
        self.assertIsNone(run(cc.load_index(_inverted_world(), rebuild=False)))


if __name__ == "__main__":
    unittest.main()
