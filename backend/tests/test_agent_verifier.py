"""Unit tests for `agent/verifier.py` — CP64's deterministic verifier core.

No model call anywhere in this file: every check under test is a regex over
plain text plus a ledger lookup, exactly the "no LLM needed" core the plan
describes. The forced-failure case this checkpoint's own brief requires
(`agent/spikes/`-style: prove the repair loop actually fires) is
`RepairMessageTests` plus the graph-level test in `test_agent_graph.py` that
stubs a rejected-then-accepted draft — no live Ollama call needed to prove
the mechanism works, matching this repo's "test the model seam by stubbing
it" convention.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import verifier
from agent.ledger import EvidenceLedger


def _ledger_with(*, data: dict, source: str = "mongo:race_results/2026-11") -> EvidenceLedger:
    ledger = EvidenceLedger()
    ledger.append(source=source, data=data, as_of="2026-08-05T00:00:00+00:00")
    return ledger


class CitationCheckTests(unittest.TestCase):
    def test_clean_answer_passes(self):
        ledger = _ledger_with(data={"winner": "Lando Norris", "points": 25})
        draft = "Lando Norris won with 25 points [ev_1]."
        result = verifier.check(draft, ledger)
        self.assertTrue(result.passed)
        self.assertEqual(result.violations, ())
        self.assertEqual(result.citation_count, 1)

    def test_empty_draft_passes(self):
        # An honest decline cites nothing and asserts nothing.
        ledger = EvidenceLedger()
        result = verifier.check("", ledger)
        self.assertTrue(result.passed)

    def test_unknown_citation_fails(self):
        ledger = _ledger_with(data={"winner": "Norris"})
        draft = "Norris won [ev_99]."
        result = verifier.check(draft, ledger)
        self.assertFalse(result.passed)
        self.assertEqual(result.violations[0].kind, "unknown_citation")

    def test_uncited_number_fails(self):
        ledger = _ledger_with(data={"winner": "Norris"})
        draft = "Norris scored 25 points this weekend."
        result = verifier.check(draft, ledger)
        self.assertFalse(result.passed)
        self.assertEqual(result.violations[0].kind, "uncited_number")

    def test_unsupported_number_fails(self):
        ledger = _ledger_with(data={"winner": "Norris", "points": 25})
        draft = "Norris scored 99 points [ev_1]."
        result = verifier.check(draft, ledger)
        self.assertFalse(result.passed)
        self.assertEqual(result.violations[0].kind, "unsupported_number")

    def test_trivial_single_digit_numbers_are_not_flagged(self):
        # "P1"/"3rd"/a 2-stop strategy are not the kind of fact CP38 worried
        # about — flagging every one of these would make nearly every
        # ordinary answer fail.
        ledger = _ledger_with(data={"position": 1})
        draft = "He finished in P1 after a 2-stop strategy."
        result = verifier.check(draft, ledger)
        self.assertTrue(result.passed)

    def test_multiple_sentences_checked_independently(self):
        ledger = _ledger_with(data={"points": 25})
        draft = "Norris scored 25 points [ev_1]. He also won 40 races uncited."
        result = verifier.check(draft, ledger)
        self.assertFalse(result.passed)
        kinds = {v.kind for v in result.violations}
        self.assertIn("uncited_number", kinds)

    def test_citation_count_deduplicates_repeated_markers(self):
        ledger = _ledger_with(data={"points": 25})
        draft = "Norris scored 25 points [ev_1]. He led the race the whole way [ev_1]."
        result = verifier.check(draft, ledger)
        self.assertEqual(result.citation_count, 1)

    def test_evidence_data_search_handles_nested_structures(self):
        ledger = _ledger_with(data={"standings": [{"driver": "Norris", "points": 275}]})
        draft = "Norris has 275 championship points [ev_1]."
        result = verifier.check(draft, ledger)
        self.assertTrue(result.passed)


class FramingCheckTests(unittest.TestCase):
    def test_predictive_assertion_without_hedge_fails(self):
        result = verifier.check(
            "Verstappen will win on Sunday.", EvidenceLedger(), predictive=True
        )
        self.assertFalse(result.passed)
        self.assertEqual(result.violations[0].kind, "predictive_no_hedge")

    def test_predictive_assertion_with_hedge_passes(self):
        result = verifier.check(
            "Verstappen is likely to win on Sunday, based on recent form, "
            "though nothing is certain.",
            EvidenceLedger(),
            predictive=True,
        )
        self.assertTrue(result.passed)

    def test_predictive_flag_off_does_not_check_framing(self):
        # Same unhedged sentence, but the question wasn't predictive — no
        # framing check should apply at all.
        result = verifier.check("Verstappen will win on Sunday.", EvidenceLedger(), predictive=False)
        self.assertTrue(result.passed)

    def test_subjective_verdict_without_hedge_fails(self):
        result = verifier.check(
            "Hamilton is clearly the greatest driver of all time.",
            EvidenceLedger(),
            subjective=True,
        )
        self.assertFalse(result.passed)
        self.assertEqual(result.violations[0].kind, "subjective_verdict")

    def test_subjective_with_hedge_passes(self):
        result = verifier.check(
            "Whether Hamilton is the greatest is a matter of opinion — "
            "reasonable people could disagree.",
            EvidenceLedger(),
            subjective=True,
        )
        self.assertTrue(result.passed)

    def test_subjective_flag_off_does_not_check_framing(self):
        result = verifier.check(
            "Hamilton is clearly the greatest driver of all time.",
            EvidenceLedger(),
            subjective=False,
        )
        self.assertTrue(result.passed)


class RepairMessageTests(unittest.TestCase):
    def test_repair_message_names_every_violation(self):
        ledger = EvidenceLedger()
        draft = "Norris scored 25 points."
        result = verifier.check(draft, ledger)
        self.assertFalse(result.passed)
        message = result.repair_message()
        self.assertIn("REJECTED", message)
        for v in result.violations:
            self.assertIn(v.detail, message)

    def test_repair_message_instructs_citation_format(self):
        result = verifier.check("Norris scored 25 points.", EvidenceLedger())
        self.assertIn("[ev_N]", result.repair_message())


class RegulationGuardTests(unittest.TestCase):
    def test_confident_uncited_regulation_claim_is_flagged(self):
        # ev_1 is cited but never registered in the ledger, so it cannot
        # ground the claim — same as an uncited claim.
        draft = "Under Article 12.4, this penalty was mandatory [ev_1]."
        violations = verifier.check_regulation(draft, EvidenceLedger())
        self.assertTrue(any(v.kind == "unverifiable_regulation_claim" for v in violations))

    def test_hedged_regulation_mention_is_not_flagged(self):
        draft = "This app does not hold the full sporting regulations, so I can't confirm the exact rule here."
        violations = verifier.check_regulation(draft, EvidenceLedger())
        self.assertEqual(violations, [])

    def test_ordinary_answer_with_no_regulation_talk_passes(self):
        draft = "Norris won the race [ev_1]."
        violations = verifier.check_regulation(draft, EvidenceLedger())
        self.assertEqual(violations, [])

    def test_cited_regulation_claim_backed_by_the_ledger_is_not_flagged(self):
        # CP62's web tools can retrieve and cite real regulation text — a
        # regulation claim carrying a citation that actually resolves in
        # this turn's ledger is grounded, not a hallucination, and must not
        # force a pointless repair.
        ledger = _ledger_with(data={"text": "Rule 5 governs the sprint format."}, source="web:fia.com")
        draft = "Rule 5 of the sprint format applies [ev_1]."
        violations = verifier.check_regulation(draft, ledger)
        self.assertEqual(violations, [])


class ToxicityGuardTests(unittest.TestCase):
    def test_ordinary_answer_passes(self):
        self.assertEqual(verifier.check_toxicity("Norris won the race [ev_1]."), [])

    def test_denylisted_slur_pattern_is_flagged(self):
        # A deliberately mild stand-in pattern for the test — the real
        # denylist in the implementation is not reproduced in test comments.
        violations = verifier.check_toxicity("This driver is an absolute idiot and should be banned.")
        self.assertTrue(any(v.kind == "toxic_language" for v in violations))


class AnchorTests(unittest.TestCase):
    """CP72 — the location the verifier used to compute and throw away."""

    RACE_BUNDLE = {
        "race_name": "Australian Grand Prix",
        "results": [
            {"position": 1, "driver": "George Russell", "team": "Mercedes",
             "points": 25},
            {"position": 2, "driver": "Lando Norris", "team": "McLaren",
             "points": 18},
        ],
    }

    def test_who_won_anchors_on_the_p1_driver_field(self):
        """The done-condition of the checkpoint, and the reported bug.

        A reader asked who won the Australian GP and was shown a table with
        nothing about the winner in it, because the citation named a bundle
        rather than a field. The winner's name in the answer must now resolve
        to the P1 row's `driver`.
        """
        ledger = _ledger_with(data=self.RACE_BUNDLE)
        draft = "George Russell won the Australian Grand Prix [ev_1]."

        anchors = verifier.anchors(draft, ledger)

        winner = next(a for a in anchors if a.text == "George Russell")
        self.assertEqual(winner.evidence_id, "ev_1")
        self.assertEqual(winner.field, "driver")
        self.assertEqual(winner.value, "George Russell")
        self.assertEqual(winner.path, "results[0]")
        self.assertEqual(winner.row["position"], "1")
        self.assertEqual(draft[winner.start:winner.end], "George Russell")

    def test_check_carries_the_anchors_as_a_by_product(self):
        ledger = _ledger_with(data=self.RACE_BUNDLE)
        result = verifier.check("George Russell won [ev_1].", ledger)

        self.assertTrue(result.passed)
        self.assertEqual(result.anchors[0].field, "driver")

    def test_anchors_never_change_the_verdict(self):
        # An answer whose claims anchor nowhere is not a new failure class —
        # plenty of true sentences name nothing a bundle stores.
        ledger = _ledger_with(data={"winner": "Norris"})
        result = verifier.check("It was a strong drive all afternoon [ev_1].", ledger)

        self.assertTrue(result.passed)
        self.assertEqual(result.violations, ())
        self.assertEqual(result.anchors, ())

    def test_numbers_anchor_too(self):
        ledger = _ledger_with(data=self.RACE_BUNDLE)
        anchors = verifier.anchors("Russell took 25 points [ev_1].", ledger)

        fields = {a.field for a in anchors}
        self.assertIn("points", fields)
        self.assertIn("driver", fields)

    def test_an_uncited_sentence_produces_no_anchors(self):
        ledger = _ledger_with(data=self.RACE_BUNDLE)

        self.assertEqual(verifier.anchors("George Russell won.", ledger), [])

    def test_an_unknown_citation_produces_no_anchors(self):
        ledger = _ledger_with(data=self.RACE_BUNDLE)

        self.assertEqual(verifier.anchors("George Russell won [ev_9].", ledger), [])

    def test_spans_index_the_draft_not_the_sentence(self):
        ledger = _ledger_with(data=self.RACE_BUNDLE)
        draft = "The race was chaotic. Lando Norris finished second [ev_1]."

        anchors = verifier.anchors(draft, ledger)

        anchor = next(a for a in anchors if a.text == "Lando Norris")
        self.assertEqual(draft[anchor.start:anchor.end], "Lando Norris")

    def test_a_sentence_initial_article_is_stripped_from_an_entity(self):
        # "The Australian Grand Prix" is capitalised by grammar; the record
        # stores "Australian Grand Prix".
        ledger = _ledger_with(data=self.RACE_BUNDLE)
        draft = "The Australian Grand Prix ran long [ev_1]."

        anchors = verifier.anchors(draft, ledger)

        self.assertEqual(anchors[0].field, "race_name")
        self.assertEqual(draft[anchors[0].start:anchors[0].end],
                         "Australian Grand Prix")

    def test_anchors_are_sorted_by_position_in_the_draft(self):
        ledger = _ledger_with(data=self.RACE_BUNDLE)
        draft = "Lando Norris was second [ev_1]. George Russell won [ev_1]."

        anchors = verifier.anchors(draft, ledger)

        self.assertEqual([a.start for a in anchors], sorted(a.start for a in anchors))

    def test_repeated_citation_of_one_entry_does_not_duplicate_a_span(self):
        ledger = _ledger_with(data=self.RACE_BUNDLE)
        draft = "George Russell won [ev_1] [ev_1]."

        anchors = verifier.anchors(draft, ledger)

        self.assertEqual(len(anchors), 1)

    def test_a_citation_marker_is_never_itself_anchored(self):
        ledger = _ledger_with(data={"ev_1": "Norris", "driver": "Norris"})
        anchors = verifier.anchors("Norris won [ev_1].", ledger)

        self.assertTrue(all(a.text != "ev_1" for a in anchors))

    def test_anchors_per_claim_is_capped(self):
        ledger = _ledger_with(
            data={"a": "Alpha", "b": "Bravo", "c": "Charlie", "d": "Delta",
                  "e": "Echo", "f": "Foxtrot"}
        )
        draft = "Alpha Bravo Charlie Delta Echo Foxtrot [ev_1]."

        anchors = verifier.anchors(draft, ledger)

        self.assertLessEqual(len(anchors), verifier.ANCHORS_PER_CLAIM)

    def test_an_anchor_serialises_to_plain_json(self):
        import json

        ledger = _ledger_with(data=self.RACE_BUNDLE)
        anchor = verifier.anchors("George Russell won [ev_1].", ledger)[0]

        self.assertIn("results[0]", json.dumps(anchor.to_dict()))

    def test_empty_draft_yields_no_anchors(self):
        self.assertEqual(verifier.anchors("", EvidenceLedger()), [])
        self.assertEqual(verifier.anchors(None, EvidenceLedger()), [])


class SentenceSpanTests(unittest.TestCase):
    def test_spans_reproduce_the_existing_sentence_split_exactly(self):
        # The splitter the checks run on and the splitter the anchors run on
        # must not be able to drift apart.
        for draft in [
            "",
            "One sentence only",
            "Norris won [ev_1]. Verstappen was second [ev_2]!  Really?",
            "  leading and trailing whitespace  ",
            "Multi\nline\ndraft. With a second one.",
        ]:
            spans = verifier._sentence_spans(draft)
            self.assertEqual(
                [draft[s:e] for s, e in spans], verifier._sentences(draft)
            )


if __name__ == "__main__":
    unittest.main()
