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
    def test_confident_regulation_claim_is_flagged(self):
        draft = "Under Article 12.4, this penalty was mandatory [ev_1]."
        violations = verifier.check_regulation(draft)
        self.assertTrue(any(v.kind == "unverifiable_regulation_claim" for v in violations))

    def test_hedged_regulation_mention_is_not_flagged(self):
        draft = "This app does not hold the full sporting regulations, so I can't confirm the exact rule here."
        violations = verifier.check_regulation(draft)
        self.assertEqual(violations, [])

    def test_ordinary_answer_with_no_regulation_talk_passes(self):
        draft = "Norris won the race [ev_1]."
        violations = verifier.check_regulation(draft)
        self.assertEqual(violations, [])


class ToxicityGuardTests(unittest.TestCase):
    def test_ordinary_answer_passes(self):
        self.assertEqual(verifier.check_toxicity("Norris won the race [ev_1]."), [])

    def test_denylisted_slur_pattern_is_flagged(self):
        # A deliberately mild stand-in pattern for the test — the real
        # denylist in the implementation is not reproduced in test comments.
        violations = verifier.check_toxicity("This driver is an absolute idiot and should be banned.")
        self.assertTrue(any(v.kind == "toxic_language" for v in violations))


if __name__ == "__main__":
    unittest.main()
