"""Unit tests for `agent/subagents.py` — CP63's four subagent specs.

Only assembly is tested here: that every named tool actually exists in the
registry, that each subagent gets bound `StructuredTool` instances sharing
one ledger, and that the required `SubAgent` keys are present. Real
delegation behaviour (does the orchestrator actually pick the right
subagent) needs a live model and is exercised sparingly by hand, the same
`agent/spikes/` pattern CP59/61 already established — not by this suite.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import subagents
from agent.ledger import EvidenceLedger
from agent.tools import TOOLS


class SubagentToolNamesExistTests(unittest.TestCase):
    """Every name in a tool grouping must be a real entry in `tools.TOOLS`."""

    def test_stats_scout_tools_exist(self):
        for name in subagents.STATS_SCOUT_TOOLS:
            self.assertIn(name, TOOLS)

    def test_historian_tools_exist(self):
        for name in subagents.HISTORIAN_TOOLS:
            self.assertIn(name, TOOLS)

    def test_race_analyst_tools_exist(self):
        for name in subagents.RACE_ANALYST_TOOLS:
            self.assertIn(name, TOOLS)

    def test_web_researcher_tool_fns_are_the_web_module_tools(self):
        names = {fn.tool_name for fn in subagents.WEB_RESEARCHER_TOOL_FNS}
        self.assertEqual(names, {"web_search", "web_extract", "wikipedia_summary"})


class BuildSubagentsTests(unittest.TestCase):
    def setUp(self):
        self.ledger = EvidenceLedger()
        self.specs = subagents.build_subagents(self.ledger)

    def test_returns_exactly_four_subagents(self):
        self.assertEqual(len(self.specs), 4)

    def test_names_match_the_roster(self):
        names = {spec["name"] for spec in self.specs}
        self.assertEqual(
            names, {"stats-scout", "historian", "web-researcher", "race-analyst"}
        )

    def test_every_spec_has_the_required_subagent_keys(self):
        for spec in self.specs:
            self.assertIn("name", spec)
            self.assertIn("description", spec)
            self.assertIn("system_prompt", spec)
            self.assertIn("tools", spec)
            self.assertTrue(spec["description"], "description must not be empty")
            self.assertTrue(spec["system_prompt"], "system_prompt must not be empty")

    def test_stats_scout_has_its_own_tool_count(self):
        stats_scout = next(s for s in self.specs if s["name"] == "stats-scout")
        self.assertEqual(len(stats_scout["tools"]), len(subagents.STATS_SCOUT_TOOLS))

    def test_web_researcher_has_three_tools(self):
        web_researcher = next(s for s in self.specs if s["name"] == "web-researcher")
        self.assertEqual(len(web_researcher["tools"]), 3)

    def test_web_researcher_tools_are_named_correctly(self):
        web_researcher = next(s for s in self.specs if s["name"] == "web-researcher")
        names = {tool.name for tool in web_researcher["tools"]}
        self.assertEqual(names, {"web_search", "web_extract", "wikipedia_summary"})

    def test_different_calls_bind_independent_tool_instances(self):
        # Two ledgers, two builds — the tools must not be shared/cached
        # across requests the way `graph.build_tools` also builds fresh
        # per-request (module docstring: "two overlapping requests... can
        # never see each other's evidence").
        other_ledger = EvidenceLedger()
        other_specs = subagents.build_subagents(other_ledger)
        first_web = next(s for s in self.specs if s["name"] == "web-researcher")
        second_web = next(s for s in other_specs if s["name"] == "web-researcher")
        self.assertIsNot(first_web["tools"][0], second_web["tools"][0])


if __name__ == "__main__":
    unittest.main()
