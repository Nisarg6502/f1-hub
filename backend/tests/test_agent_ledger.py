"""Tests for the evidence ledger (CP60).

The properties asserted here are the ones CP64's verifier will depend on:
ids are ledger-assigned and monotonic, a hallucinated id is a lookup miss,
entries cannot be mutated after they are cited, and a round trip through
`to_dict`/`from_dict` continues the id sequence instead of restarting it.
"""

import dataclasses
import json
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# The agent package imports `app.db`, which imports motor at module scope.
# These tests never touch Mongo.
if "motor.motor_asyncio" not in sys.modules:
    motor_module = types.ModuleType("motor")
    motor_asyncio_module = types.ModuleType("motor.motor_asyncio")

    class AsyncIOMotorClient:
        pass

    motor_asyncio_module.AsyncIOMotorClient = AsyncIOMotorClient
    sys.modules["motor"] = motor_module
    sys.modules["motor.motor_asyncio"] = motor_asyncio_module

from agent.ledger import Evidence, EvidenceLedger, utcnow_iso


class AppendTests(unittest.TestCase):
    def test_ids_are_assigned_by_the_ledger_and_are_monotonic(self):
        ledger = EvidenceLedger()

        first = ledger.append(source="mongo:race_results/2026-14", data={"a": 1})
        second = ledger.append(source="mongo:pit_stops/2026-14", data={"b": 2})

        self.assertEqual(first.evidence_id, "ev_1")
        self.assertEqual(second.evidence_id, "ev_2")
        self.assertEqual(ledger.ids(), ["ev_1", "ev_2"])

    def test_a_tool_cannot_choose_its_own_id(self):
        """`append` takes no id argument at all — the guarantee is structural."""
        ledger = EvidenceLedger()
        with self.assertRaises(TypeError):
            ledger.append(evidence_id="ev_99", source="s", data={})

    def test_as_of_defaults_to_now_but_is_overridable(self):
        ledger = EvidenceLedger()

        defaulted = ledger.append(source="s", data={})
        supplied = ledger.append(source="s", data={}, as_of="2026-08-01T09:00:00+00:00")

        self.assertTrue(defaulted.as_of)
        self.assertEqual(supplied.as_of, "2026-08-01T09:00:00+00:00")

    def test_tool_and_args_are_recorded(self):
        ledger = EvidenceLedger()

        entry = ledger.append(
            source="s", data={}, tool="get_standings", args={"year": 2026}
        )

        self.assertEqual(entry.tool, "get_standings")
        self.assertEqual(entry.args, {"year": 2026})


class LookupTests(unittest.TestCase):
    def setUp(self):
        self.ledger = EvidenceLedger()
        self.ledger.append(source="mongo:race_results/2026-14", data={"winner": "Norris"})

    def test_a_real_id_resolves(self):
        entry = self.ledger.get("ev_1")

        self.assertIsNotNone(entry)
        self.assertEqual(entry.data, {"winner": "Norris"})

    def test_an_invented_id_is_a_miss_not_a_coincidental_hit(self):
        """The whole point of opaque ids: a plausible-looking one must not resolve."""
        self.assertIsNone(self.ledger.get("ev_race_1"))
        self.assertIsNone(self.ledger.get("ev_7"))
        self.assertNotIn("ev_7", self.ledger)
        self.assertIn("ev_1", self.ledger)

    def test_entries_returns_a_copy_so_the_ledger_cannot_be_edited_through_it(self):
        entries = self.ledger.entries()
        entries.clear()

        self.assertEqual(len(self.ledger), 1)

    def test_an_entry_is_frozen_after_it_has_been_cited(self):
        entry = self.ledger.get("ev_1")

        with self.assertRaises(dataclasses.FrozenInstanceError):
            entry.source = "mongo:something_else"


class FreshnessTests(unittest.TestCase):
    def test_oldest_as_of_reports_the_stalest_input(self):
        ledger = EvidenceLedger()
        ledger.append(source="a", data={}, as_of="2026-08-05T10:00:00+00:00")
        ledger.append(source="b", data={}, as_of="2026-07-01T10:00:00+00:00")
        ledger.append(source="c", data={}, as_of="2026-08-05T11:00:00+00:00")

        self.assertEqual(ledger.oldest_as_of(), "2026-07-01T10:00:00+00:00")

    def test_an_empty_ledger_has_no_cutoff_to_state(self):
        self.assertIsNone(EvidenceLedger().oldest_as_of())

    def test_utcnow_iso_carries_an_offset_so_it_sorts_against_synced_at(self):
        stamp = utcnow_iso()

        self.assertTrue(stamp.endswith("+00:00"), stamp)


class CitationTests(unittest.TestCase):
    def test_a_citation_has_no_url_for_an_internal_source(self):
        ledger = EvidenceLedger()
        ledger.append(
            source="mongo:race_results/2026-14",
            data={},
            as_of="2026-08-05T09:00:00+00:00",
        )

        self.assertEqual(
            ledger.citations(),
            [
                {
                    "id": "ev_1",
                    "n": 1,
                    "kind": "data",
                    "label": "mongo:race_results/2026-14",
                    "title": "mongo:race_results/2026-14",
                    "url": None,
                    "as_of": "2026-08-05T09:00:00+00:00",
                    "snippet": [],
                }
            ],
        )


class CitationShapeTests(unittest.TestCase):
    def test_citation_gains_a_human_title_from_the_tool_name(self):
        ledger = EvidenceLedger()
        entry = ledger.append(
            source="mongo:race_results/2026-14",
            data={"winner": "Norris"},
            tool="get_session_result",
        )
        citation = entry.citation()
        self.assertEqual(citation["title"], "Reading the session classification")
        # `label` keeps its existing raw value — additive, not a rename.
        self.assertEqual(citation["label"], "mongo:race_results/2026-14")

    def test_citation_without_a_tool_falls_back_to_the_raw_source_as_title(self):
        ledger = EvidenceLedger()
        entry = ledger.append(source="mongo:race_results/2026-14", data={})
        citation = entry.citation()
        self.assertEqual(citation["title"], "mongo:race_results/2026-14")

    def test_citation_kind_is_data_for_a_mongo_source(self):
        ledger = EvidenceLedger()
        entry = ledger.append(source="mongo:race_results/2026-14", data={})
        self.assertEqual(entry.citation()["kind"], "data")

    def test_citation_kind_is_wikipedia_for_a_wikipedia_source(self):
        ledger = EvidenceLedger()
        entry = ledger.append(source="web:wikipedia/Ayrton Senna", data={})
        self.assertEqual(entry.citation()["kind"], "wikipedia")

    def test_citation_kind_is_web_for_any_other_web_source(self):
        ledger = EvidenceLedger()
        entry = ledger.append(source="web:tavily-search/2027 regulations", data={})
        self.assertEqual(entry.citation()["kind"], "web")

    def test_citation_n_is_the_numeric_suffix_of_the_evidence_id(self):
        ledger = EvidenceLedger()
        ledger.append(source="s", data={})
        second = ledger.append(source="s", data={})
        self.assertEqual(second.citation()["n"], 2)

    def test_citation_url_is_populated_for_a_wikipedia_source(self):
        ledger = EvidenceLedger()
        entry = ledger.append(
            source="web:wikipedia/Ayrton Senna",
            data={
                "title": "Ayrton Senna",
                "page_url": "https://en.wikipedia.org/wiki/Ayrton_Senna",
            },
            tool="wikipedia_summary",
        )
        self.assertEqual(
            entry.citation()["url"], "https://en.wikipedia.org/wiki/Ayrton_Senna"
        )

    def test_citation_url_is_populated_for_a_web_search_source_from_its_first_result(self):
        ledger = EvidenceLedger()
        entry = ledger.append(
            source="web:tavily-search/2027 regulations",
            data={
                "query": "2027 regulations",
                "results": [
                    {"title": "F1 2027 rules", "url": "https://example.com/2027-rules"},
                    {"title": "Other", "url": "https://example.com/other"},
                ],
            },
            tool="web_search",
        )
        self.assertEqual(entry.citation()["url"], "https://example.com/2027-rules")

    def test_citation_url_falls_back_to_none_for_a_web_source_with_no_url_in_data(self):
        ledger = EvidenceLedger()
        entry = ledger.append(
            source="web:tavily-search/nothing found",
            data={"query": "nothing found", "results": []},
            tool="web_search",
        )
        self.assertIsNone(entry.citation()["url"])

    def test_citation_url_stays_none_for_a_mongo_source_even_if_data_carries_one(self):
        ledger = EvidenceLedger()
        entry = ledger.append(
            source="mongo:race_results/2026-14",
            data={"url": "https://example.com/should-be-ignored"},
        )
        self.assertIsNone(entry.citation()["url"])


class CitationSnippetTests(unittest.TestCase):
    """CP71: a citation carries a little of the evidence, not only its provenance.

    The pill's popover needs the actual supporting fact. `data` itself cannot
    ship — a race payload is 1000+ lap rows and this rides on every `sources`
    SSE event — so `snippet` is a capped, flattened, human-labelled rendering
    of it.
    """

    def _snippet(self, data, **kw):
        ledger = EvidenceLedger()
        return ledger.append(source="mongo:x/1", data=data, **kw).citation()["snippet"]

    # --- the additive guarantee ------------------------------------------

    def test_the_seven_existing_keys_are_untouched_by_the_new_field(self):
        ledger = EvidenceLedger()
        entry = ledger.append(
            source="web:wikipedia/Ayrton Senna",
            data={
                "title": "Ayrton Senna",
                "page_url": "https://en.wikipedia.org/wiki/Ayrton_Senna",
            },
            as_of="2026-08-05T09:00:00+00:00",
            tool="wikipedia_summary",
        )
        citation = entry.citation()

        self.assertEqual(citation["id"], "ev_1")
        self.assertEqual(citation["n"], 1)
        self.assertEqual(citation["kind"], "wikipedia")
        self.assertEqual(citation["label"], "web:wikipedia/Ayrton Senna")
        self.assertEqual(citation["title"], "Reading a Wikipedia summary")
        self.assertEqual(citation["url"], "https://en.wikipedia.org/wiki/Ayrton_Senna")
        self.assertEqual(citation["as_of"], "2026-08-05T09:00:00+00:00")
        self.assertIn("snippet", citation)

    def test_the_serialised_citation_is_still_json_encodable(self):
        ledger = EvidenceLedger()
        ledger.append(source="mongo:x/1", data={"race_name": "Hungarian GP", "laps": 70})

        self.assertIn("Race name", json.dumps(ledger.citations()))

    # --- flattening -------------------------------------------------------

    def test_top_level_scalars_become_ordered_pairs(self):
        snippet = self._snippet({"race_name": "Hungarian Grand Prix", "round": 14})

        self.assertEqual(
            snippet,
            [
                {"label": "Race name", "value": "Hungarian Grand Prix"},
                {"label": "Round", "value": "14"},
            ],
        )

    def test_keys_are_humanised_so_no_raw_snake_case_reaches_the_user(self):
        snippet = self._snippet({"fastest_lap_time": "1:16.627"})

        self.assertEqual(snippet[0]["label"], "Fastest lap time")

    def test_a_top_level_list_of_dicts_contributes_its_first_entry_prefixed(self):
        snippet = self._snippet(
            {
                "season": 2026,
                "results": [
                    {"position": 1, "driver": "Norris"},
                    {"position": 2, "driver": "Piastri"},
                ],
            }
        )

        self.assertEqual(snippet[0], {"label": "Season", "value": "2026"})
        labels = [pair["label"] for pair in snippet]
        self.assertIn("Results · Position", labels)
        self.assertIn("Results · Driver", labels)
        # The *second* entry never appears — one representative row, not a dump.
        self.assertNotIn("Piastri", [pair["value"] for pair in snippet])

    def test_a_nested_structure_is_summarised_rather_than_dumped(self):
        snippet = self._snippet(
            {
                "laps": list(range(12)),
                "meta": {"a": 1, "b": 2},
            }
        )

        pairs = {pair["label"]: pair["value"] for pair in snippet}
        self.assertEqual(pairs["Laps"], "12 items")
        self.assertEqual(pairs["Meta"], "2 fields")

    def test_none_valued_keys_are_dropped_rather_than_shown_as_none(self):
        snippet = self._snippet({"winner": "Norris", "penalty": None})

        self.assertEqual(snippet, [{"label": "Winner", "value": "Norris"}])

    def test_private_mongo_keys_are_not_leaked(self):
        snippet = self._snippet({"_id": "68a1", "winner": "Norris"})

        self.assertEqual(snippet, [{"label": "Winner", "value": "Norris"}])

    # --- the cap ----------------------------------------------------------

    def test_at_most_six_pairs_ship(self):
        snippet = self._snippet({f"key_{i}": i for i in range(30)})

        self.assertEqual(len(snippet), 6)

    def test_the_cap_holds_across_the_list_expansion_too(self):
        snippet = self._snippet(
            {
                "a": 1,
                "b": 2,
                "results": [{f"c{i}": i for i in range(20)}],
            }
        )

        self.assertLessEqual(len(snippet), 6)

    def test_a_long_value_is_truncated_with_an_ellipsis(self):
        snippet = self._snippet({"summary": "x" * 500})

        value = snippet[0]["value"]
        self.assertLessEqual(len(value), 120)
        self.assertTrue(value.endswith("…"), value)

    def test_a_value_at_the_limit_is_left_alone(self):
        snippet = self._snippet({"summary": "x" * 120})

        self.assertEqual(snippet[0]["value"], "x" * 120)

    # --- never crash on shape --------------------------------------------

    def test_an_empty_payload_yields_an_empty_snippet(self):
        self.assertEqual(self._snippet({}), [])

    def test_a_none_payload_yields_an_empty_snippet(self):
        self.assertEqual(self._snippet(None), [])

    def test_a_bare_string_payload_is_rendered_as_a_single_pair(self):
        self.assertEqual(
            self._snippet("Norris won in Budapest"),
            [{"label": "Value", "value": "Norris won in Budapest"}],
        )

    def test_a_bare_number_payload_is_rendered_as_a_single_pair(self):
        self.assertEqual(self._snippet(70), [{"label": "Value", "value": "70"}])

    def test_a_list_at_root_is_counted_and_its_first_entry_expanded(self):
        snippet = self._snippet([{"driver": "Norris"}, {"driver": "Piastri"}])

        self.assertEqual(snippet[0], {"label": "Items", "value": "2 items"})
        self.assertIn({"label": "Driver", "value": "Norris"}, snippet)

    def test_a_list_of_scalars_at_root_is_only_counted(self):
        self.assertEqual(
            self._snippet([1, 2, 3]), [{"label": "Items", "value": "3 items"}]
        )

    def test_an_unrepresentable_value_does_not_break_the_answer_path(self):
        """A formatting failure must never fail an otherwise-good turn."""

        class Hostile:
            def __repr__(self):
                raise RuntimeError("boom")

            __str__ = __repr__

        snippet = self._snippet({"ok": "fine", "bad": Hostile()})

        self.assertIsInstance(snippet, list)
        self.assertIn({"label": "Ok", "value": "fine"}, snippet)

    def test_a_hostile_mapping_still_returns_a_list(self):
        class Exploding(dict):
            def items(self):
                raise RuntimeError("boom")

        self.assertEqual(self._snippet(Exploding()), [])


class FrameworkFreedomTests(unittest.TestCase):
    def test_the_ledger_imports_no_framework(self):
        """The ledger must stay usable without the agent stack (module docstring)."""
        source = (
            Path(__file__).resolve().parents[1] / "agent" / "ledger.py"
        ).read_text(encoding="utf-8")

        self.assertNotIn("import langchain", source)
        self.assertNotIn("import langgraph", source)
        self.assertNotIn("from langchain", source)
        self.assertNotIn("from langgraph", source)


class SerialisationTests(unittest.TestCase):
    def test_round_trip_preserves_entries(self):
        ledger = EvidenceLedger()
        ledger.append(source="a", data={"x": [1, 2]}, tool="t", args={"y": 1})

        restored = EvidenceLedger.from_dict(ledger.to_dict())

        self.assertEqual(restored.to_dict(), ledger.to_dict())
        self.assertEqual(restored.get("ev_1").data, {"x": [1, 2]})

    def test_a_rehydrated_ledger_continues_its_sequence(self):
        """A restart at ev_1 would collide with the ids already cited upstream."""
        ledger = EvidenceLedger()
        ledger.append(source="a", data={})
        ledger.append(source="b", data={})

        restored = EvidenceLedger.from_dict(ledger.to_dict())
        added = restored.append(source="c", data={})

        self.assertEqual(added.evidence_id, "ev_3")

    def test_the_serialised_form_is_json_encodable(self):
        """It has to survive LangGraph state and LangSmith run metadata."""
        ledger = EvidenceLedger()
        ledger.append(source="a", data={"nested": {"k": [1, None, "s"]}})

        self.assertIn("ev_1", json.dumps(ledger.to_dict()))

    def test_duplicate_ids_are_rejected_at_construction(self):
        entry = Evidence(evidence_id="ev_1", source="a", as_of="x", data={})

        with self.assertRaises(ValueError):
            EvidenceLedger([entry, entry])

    def test_from_dict_tolerates_an_absent_payload(self):
        self.assertEqual(len(EvidenceLedger.from_dict(None)), 0)
        self.assertEqual(len(EvidenceLedger.from_dict({})), 0)


class LocateTests(unittest.TestCase):
    """CP72's `Evidence.locate` — where a claim's tokens sit inside a bundle."""

    RACE_BUNDLE = {
        "race_name": "Australian Grand Prix",
        "season": 2026,
        "round": 3,
        "results": [
            {"position": 1, "driver": "George Russell", "team": "Mercedes",
             "time": "1:31:12.481", "points": 25},
            {"position": 2, "driver": "Lando Norris", "team": "McLaren",
             "time": "+4.812", "points": 18},
        ],
    }

    def _entry(self, data):
        ledger = EvidenceLedger()
        return ledger.append(source="mongo:race_results/2026-3", data=data)

    def test_who_won_locates_the_p1_driver_field(self):
        """The exact reported bug: asking who won returned a table with the
        winner nowhere in it, because a citation could only name the bundle.
        The winner's name must resolve to the P1 row's `driver` field.
        """
        entry = self._entry(self.RACE_BUNDLE)

        located = entry.locate(["George Russell"])

        self.assertEqual(len(located), 1)
        self.assertEqual(located[0]["field"], "driver")
        self.assertEqual(located[0]["value"], "George Russell")
        self.assertEqual(located[0]["path"], "results[0]")
        self.assertEqual(located[0]["row"]["position"], "1")

    def test_a_partial_name_still_locates_the_full_stored_value(self):
        # Prose says "Russell"; the record says "George Russell". Both name
        # the same fact.
        located = self._entry(self.RACE_BUNDLE).locate(["Russell"])

        self.assertEqual(located[0]["field"], "driver")
        self.assertEqual(located[0]["value"], "George Russell")

    def test_document_order_decides_between_two_matching_rows(self):
        # Both rows carry a `team`, so "first match wins" is what makes an
        # unqualified claim land on the leading row rather than an arbitrary
        # one.
        located = self._entry(self.RACE_BUNDLE).locate(["Mercedes", "McLaren"])

        paths = [hit["path"] for hit in located]
        self.assertEqual(paths, ["results[0]", "results[1]"])

    def test_a_top_level_scalar_is_located_with_an_empty_path(self):
        located = self._entry(self.RACE_BUNDLE).locate(["Australian Grand Prix"])

        self.assertEqual(located[0]["field"], "race_name")
        self.assertEqual(located[0]["path"], "")

    def test_tokens_that_are_absent_are_simply_not_returned(self):
        located = self._entry(self.RACE_BUNDLE).locate(["Verstappen", "Norris"])

        self.assertEqual([hit["token"] for hit in located], ["Norris"])

    def test_a_number_does_not_match_inside_a_longer_number(self):
        located = self._entry({"points": 125}).locate(["25"])

        self.assertEqual(located, [])

    def test_thousands_separators_and_case_do_not_defeat_a_match(self):
        located = self._entry({"laps": "1,234", "team": "MERCEDES"}).locate(
            ["1234", "Mercedes"]
        )

        self.assertEqual({hit["field"] for hit in located}, {"laps", "team"})

    def test_locate_never_raises_on_an_unwalkable_payload(self):
        class Hostile:
            def __str__(self):
                raise RuntimeError("no")

            def items(self):
                raise RuntimeError("no")

        # A failed locate must cost a citation its anchor, never cost the
        # reader a finished answer — the same discipline `_snippet` follows.
        self.assertEqual(self._entry({"x": Hostile()}).locate(["x"]), [])
        self.assertEqual(self._entry(Hostile()).locate(["x"]), [])

    def test_locate_tolerates_an_empty_or_absent_query(self):
        entry = self._entry(self.RACE_BUNDLE)

        self.assertEqual(entry.locate([]), [])
        self.assertEqual(entry.locate(None), [])

    def test_the_walk_is_bounded(self):
        # A payload far past the node budget must return promptly rather than
        # walking every lap row for a token that is not there.
        deep = {"laps": [{"lap": n, "driver": "X"} for n in range(20_000)]}

        self.assertEqual(self._entry(deep).locate(["Verstappen"]), [])

    def test_underscore_prefixed_keys_are_skipped(self):
        located = self._entry({"_id": "Norris", "driver": "Norris"}).locate(["Norris"])

        self.assertEqual(located[0]["field"], "driver")


class AnchoredCitationTests(unittest.TestCase):
    """`anchored_citations` — the user-visible list, from the anchor set."""

    def _ledger(self):
        ledger = EvidenceLedger()
        ledger.append(source="mongo:a", data={"driver": "Russell"})
        ledger.append(source="mongo:b", data={"driver": "Norris"})
        return ledger

    def test_only_anchored_entries_are_listed(self):
        ledger = self._ledger()

        listed = ledger.anchored_citations([{"evidence_id": "ev_2"}])

        self.assertEqual([c["id"] for c in listed], ["ev_2"])

    def test_unanchored_entries_stay_in_the_ledger(self):
        # Dropping them from the *list* must not drop them from the ledger:
        # the verifier still has to resolve citations against them.
        ledger = self._ledger()
        ledger.anchored_citations([{"evidence_id": "ev_2"}])

        self.assertEqual(len(ledger), 2)
        self.assertIsNotNone(ledger.get("ev_1"))
        self.assertEqual(len(ledger.citations()), 2)

    def test_each_citation_carries_its_own_anchors(self):
        ledger = self._ledger()
        anchors = [{"evidence_id": "ev_1", "field": "driver"},
                   {"evidence_id": "ev_1", "field": "team"}]

        listed = ledger.anchored_citations(anchors)

        self.assertEqual(listed[0]["anchors"], anchors)

    def test_listing_follows_ledger_order_not_anchor_order(self):
        ledger = self._ledger()

        listed = ledger.anchored_citations(
            [{"evidence_id": "ev_2"}, {"evidence_id": "ev_1"}]
        )

        self.assertEqual([c["id"] for c in listed], ["ev_1", "ev_2"])

    def test_an_anchor_naming_an_unknown_entry_is_ignored(self):
        ledger = self._ledger()

        self.assertEqual(ledger.anchored_citations([{"evidence_id": "ev_99"}]), [])

    def test_no_anchors_means_no_sources(self):
        self.assertEqual(self._ledger().anchored_citations(None), [])


if __name__ == "__main__":
    unittest.main()
