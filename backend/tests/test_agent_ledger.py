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


if __name__ == "__main__":
    unittest.main()
