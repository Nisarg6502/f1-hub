"""Unit tests for `agent/router.py` — CP63's rules-first tier classifier.

Pure Python, no Ollama, no network: `router.classify` never makes a model
call, so every case here is exhaustively testable without touching the
free-tier quota — exactly the property that justifies the router existing at
all (see the module's own docstring).
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import router


class ClassifyTierTests(unittest.TestCase):
    def test_empty_question_is_tier_1(self):
        route = router.classify("")
        self.assertEqual(route.tier, 1)
        self.assertFalse(route.use_subagents)

    def test_point_lookup_is_tier_1(self):
        route = router.classify("Who won the 2026 Hungarian Grand Prix?")
        self.assertEqual(route.tier, 1)

    def test_aggregate_lookup_is_tier_1(self):
        route = router.classify("How many podiums has Norris had this season?")
        self.assertEqual(route.tier, 1)

    def test_default_for_unmatched_question_is_tier_1(self):
        # CP61's flat toolset already answers taxonomy classes 1-7; nothing
        # about this question signals it needs a subagent or the web.
        route = router.classify("What team does Piastri drive for?")
        self.assertEqual(route.tier, 1)
        self.assertIn("no tier-2/3 pattern matched", route.reason)

    def test_comparative_question_is_tier_2(self):
        route = router.classify("Compare Verstappen and Norris this season.")
        self.assertEqual(route.tier, 2)
        # Tier 2 is classified for telemetry but does NOT use the
        # multi-agent graph — see `classify`'s docstring for the live
        # measurement (287s+ and unconverged on this exact question,
        # against CP61's own 50.9s baseline for the same class) that forced
        # this downgrade.
        self.assertFalse(route.use_subagents)

    def test_causal_question_is_tier_2(self):
        route = router.classify("Why did Norris lose the lead in Hungary?")
        self.assertEqual(route.tier, 2)

    def test_strategy_question_is_tier_2(self):
        route = router.classify("Why did Ferrari two-stop in Monza?")
        self.assertEqual(route.tier, 2)

    def test_deep_history_question_is_tier_2(self):
        route = router.classify("Who has the most wins at Monaco in F1 history?")
        self.assertEqual(route.tier, 2)

    def test_subjective_question_is_tier_2(self):
        route = router.classify("Is Hamilton better than Schumacher?")
        self.assertEqual(route.tier, 2)

    def test_news_question_is_tier_3(self):
        route = router.classify("What's the latest news on the 2027 engine regs?")
        self.assertEqual(route.tier, 3)
        self.assertTrue(route.use_subagents)

    def test_rumour_question_is_tier_3(self):
        route = router.classify("Any rumours about driver signings for next year?")
        self.assertEqual(route.tier, 3)

    def test_predictive_question_is_tier_3(self):
        route = router.classify("Who will win this weekend's race?")
        self.assertEqual(route.tier, 3)

    def test_out_of_domain_question_is_tier_1(self):
        # No tier-2/3 tool would help either — the SYSTEM_PROMPT declines
        # this without a tool call regardless of tier, so tier 1 is correct
        # and cheapest.
        route = router.classify("What's the weather in Tokyo right now?")
        self.assertEqual(route.tier, 1)

    def test_tie_between_tier_2_and_tier_3_prefers_tier_3(self):
        # Comparative ("compare") AND predictive ("will X win") both match —
        # the richer tier must win, per the module docstring's cost-asymmetry
        # argument.
        route = router.classify(
            "Compare Verstappen and Norris' chances — who will win the next race?"
        )
        self.assertEqual(route.tier, 3)

    def test_case_insensitive(self):
        route = router.classify("WHY DID FERRARI TWO-STOP IN MONZA?")
        self.assertEqual(route.tier, 2)

    def test_predictive_flag_set_for_prediction_question(self):
        route = router.classify("Who will win this weekend's race?")
        self.assertTrue(route.predictive)
        self.assertFalse(route.subjective)

    def test_subjective_flag_set_for_opinion_question(self):
        route = router.classify("Is Hamilton better than Schumacher?")
        self.assertTrue(route.subjective)
        self.assertFalse(route.predictive)

    def test_neither_flag_set_for_plain_point_lookup(self):
        route = router.classify("Who won the 2026 Hungarian Grand Prix?")
        self.assertFalse(route.predictive)
        self.assertFalse(route.subjective)

    def test_no_tier_ever_uses_subagents_except_tier_3(self):
        questions = [
            "Who won the 2026 Hungarian Grand Prix?",
            "Compare Verstappen and Norris this season.",
            "Why did Norris lose the lead in Hungary?",
            "Who has the most wins at Monaco in F1 history?",
        ]
        for question in questions:
            route = router.classify(question)
            self.assertLess(route.tier, 3)
            self.assertFalse(route.use_subagents, msg=question)


if __name__ == "__main__":
    unittest.main()
