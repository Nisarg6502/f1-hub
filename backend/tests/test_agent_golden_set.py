"""CP65's CI gate — `CHAT-AGENT-PLAN.md` §9's "deterministic metrics gate
every PR" half, run every time (no model call, no `deepeval` import
required). See `agent/golden_set.py`'s module docstring for the scope
decisions (24 cases not 60, authored not mined, tier-1 verification gap
recorded honestly rather than asserted away).

**`deepeval`'s own metrics are deliberately not wired into this file.**
`ToolCorrectnessMetric` et al. need an actual agent run's `tools_called` to
compare against — there is no way to produce that without a real Ollama
call, and running ~24 live calls on every PR would spend real free-tier
quota this project's whole architecture is built to conserve (§4.2). That
tension is the plan's own §9 caveat ("LLM-judge metrics... cost GPU time we
do not have... deterministic metrics gate every PR") stretched to its
logical end: even a *deterministic* metric needs a live trace to compare
against. `EvalDatasetSmokeTests` below proves the `deepeval` integration
itself is wired correctly (dataset construction, a metric self-test with a
fabricated matching trace) without needing one — genuinely useful CI
infrastructure, not a live-model gate. It skips cleanly if `deepeval` is not
installed, which it deliberately is not in this shared dev sandbox (see
`requirements-agent-eval.txt`'s own docstring for why: this exact sandbox
already has one documented numpy/pandas ABI-break incident from installing
`requirements-agent.txt` directly into shared site-packages, and `deepeval`
carries its own large, independent dependency tree).
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import router, verifier
from agent.golden_set import GOLDEN_SET, KNOWN_HARD_CASES
from agent.ledger import EvidenceLedger

try:
    import deepeval  # noqa: F401

    HAS_DEEPEVAL = True
except ImportError:
    HAS_DEEPEVAL = False


class GoldenSetShapeTests(unittest.TestCase):
    """The dataset itself must be well-formed before anything else is worth
    checking — a duplicate id or an out-of-range taxonomy class would make
    every other test's failure message misleading about which case broke.
    """

    def test_every_case_has_a_unique_id(self):
        ids = [case.id for case in GOLDEN_SET]
        self.assertEqual(len(ids), len(set(ids)), "duplicate golden case id")

    def test_taxonomy_classes_are_in_the_documented_range(self):
        # CHAT-AGENT-PLAN.md §2 defines classes 1-15; class 12 is excluded
        # deliberately (see golden_set.py) but nothing here should reference
        # a class the taxonomy doesn't define at all.
        for case in GOLDEN_SET:
            self.assertGreaterEqual(case.taxonomy_class, 1)
            self.assertLessEqual(case.taxonomy_class, 15)

    def test_at_least_fourteen_of_the_fifteen_taxonomy_classes_are_covered(self):
        covered = {case.taxonomy_class for case in GOLDEN_SET}
        # 15 classes minus class 12 (deliberately excluded) = 14 required.
        self.assertGreaterEqual(len(covered), 14)

    def test_tiers_are_valid(self):
        for case in GOLDEN_SET:
            self.assertIn(case.expected_tier, (1, 2, 3), msg=case.id)


class RouterAgainstGoldenSetTests(unittest.TestCase):
    """The actual CI gate: every case's expected tier/framing flags must
    match what `router.classify` produces today. A change to `router.py`
    that silently reclassifies a golden question fails here immediately,
    with the case id in the failure message — this is what "gate every PR"
    means for the parts of the system that don't need a model to check.
    """

    def test_every_case_matches_its_expected_tier(self):
        for case in GOLDEN_SET:
            with self.subTest(case=case.id):
                route = router.classify(case.question)
                self.assertEqual(
                    route.tier,
                    case.expected_tier,
                    f"{case.id}: expected tier {case.expected_tier}, got {route.tier} "
                    f"(reason: {route.reason})",
                )

    def test_every_case_matches_its_expected_predictive_flag(self):
        for case in GOLDEN_SET:
            with self.subTest(case=case.id):
                route = router.classify(case.question)
                self.assertEqual(route.predictive, case.expected_predictive, case.id)

    def test_every_case_matches_its_expected_subjective_flag(self):
        for case in GOLDEN_SET:
            with self.subTest(case=case.id):
                route = router.classify(case.question)
                self.assertEqual(route.subjective, case.expected_subjective, case.id)


class KnownHardCaseTests(unittest.TestCase):
    """Each case lifted from a real post-mortem (CP38/41/44/64) asserts what
    the verifier ACTUALLY does today — pass or fail — not what would be
    ideal. Several are `expected_pass=True` specifically because they are
    OUT of this verifier's scope (a different checkpoint's fix already
    covers them elsewhere, or they need a check this module doesn't build);
    see each case's own `notes` in `golden_set.py` for which is which.
    """

    def test_known_hard_cases_match_their_expected_verdict(self):
        for case in KNOWN_HARD_CASES:
            with self.subTest(case=case.id):
                ledger = EvidenceLedger()
                for entry in case.evidence:
                    ledger.append(source=entry["source"], data=entry["data"])
                result = verifier.check(
                    case.draft, ledger, predictive=case.predictive, subjective=case.subjective
                )
                self.assertEqual(
                    result.passed,
                    case.expected_pass,
                    f"{case.id} ({case.source}): expected passed={case.expected_pass}, "
                    f"got {result.passed}, violations={[v.kind for v in result.violations]}",
                )

    def test_cp38_case_documents_the_verifiers_real_boundary(self):
        # Explicit, named assertion (not just covered by the loop above) that
        # this checkpoint does not claim to catch every relational-fact
        # hallucination — only ones with an unsupported number attached. A
        # future reader should not assume CP64 closed CP38 a second time.
        case = next(c for c in KNOWN_HARD_CASES if c.id == "cp38-teammate-hallucination")
        ledger = EvidenceLedger()
        for entry in case.evidence:
            ledger.append(source=entry["source"], data=entry["data"])
        result = verifier.check(case.draft, ledger)
        self.assertTrue(
            result.passed,
            "this verifier has no relational-claim check, so an invented "
            "teammate relationship with no accompanying unsupported number "
            "passes today — CP38's actual fix is precomputed facts in "
            "tools/base.py, not this module",
        )

    def test_tier_1_aggregate_question_is_not_verified_at_all(self):
        # The one gap this module records rather than hides: CP61's own
        # measured failure (an ungrounded aggregate answered from parametric
        # memory) was a tier-1 question, and CP64's verifier explicitly skips
        # tier 1. This test documents that the router still assigns tier 1
        # here today — i.e. the gap is real and reachable, not closed by
        # some other mechanism this suite failed to notice.
        case = next(c for c in GOLDEN_SET if c.id == "class2-aggregate-podiums")
        route = router.classify(case.question)
        self.assertEqual(route.tier, 1)
        self.assertFalse(
            route.tier >= 2,
            "if this ever becomes tier 2/3, the tier-1 verification gap for "
            "this exact question closes — update golden_set.py's notes",
        )


@unittest.skipUnless(HAS_DEEPEVAL, "deepeval not installed in this sandbox — see requirements-agent-eval.txt")
class EvalDatasetSmokeTests(unittest.TestCase):
    """Proves the `deepeval` integration itself is wired correctly, without
    needing a live agent trace. Not a production gate — see this module's
    docstring for why a real `ToolCorrectnessMetric` run needs live traces
    this project cannot afford to spend on every PR.
    """

    def test_tool_correctness_metric_passes_on_a_fabricated_matching_trace(self):
        from deepeval.metrics import ToolCorrectnessMetric
        from deepeval.test_case import LLMTestCase, ToolCall

        test_case = LLMTestCase(
            input="Who has the most wins at Monaco in F1 history?",
            actual_output="Ayrton Senna holds the record with 6 wins [ev_1].",
            tools_called=[ToolCall(name="get_historical_race_index")],
            expected_tools=[ToolCall(name="get_historical_race_index")],
        )
        metric = ToolCorrectnessMetric()
        metric.measure(test_case)
        self.assertTrue(metric.is_successful())

    def test_tool_correctness_metric_fails_on_a_fabricated_wrong_trace(self):
        # The "plausible neighbour" failure CP61's baseline actually
        # measured (get_standings instead of get_head_to_head) — this is
        # what the metric would have caught, had it been run against that
        # real trace.
        from deepeval.metrics import ToolCorrectnessMetric
        from deepeval.test_case import LLMTestCase, ToolCall

        test_case = LLMTestCase(
            input="Compare Verstappen and Norris this season.",
            actual_output="Verstappen leads the standings.",
            tools_called=[ToolCall(name="get_standings")],
            expected_tools=[ToolCall(name="get_head_to_head")],
        )
        metric = ToolCorrectnessMetric()
        metric.measure(test_case)
        self.assertFalse(metric.is_successful())


if __name__ == "__main__":
    unittest.main()
