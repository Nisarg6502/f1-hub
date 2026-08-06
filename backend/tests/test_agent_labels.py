"""Tests for `agent/labels.py` — CP68's extraction of CP63's activity-label
mapping out of `graph.py`.

This module has zero LangChain/LangGraph imports, unlike `graph.py`, because
`agent/ledger.py` needs to reuse `activity_label()` for CP68's human-readable
citation titles and `ledger.py`'s own docstring is explicit that it must stay
framework-free — importing `graph.py` from `ledger.py` would pull the whole
LangGraph dependency chain into a module whose entire design point is to be
unit-testable without it.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import labels


class ActivityLabelTests(unittest.TestCase):
    def test_known_tool_gets_its_friendly_label(self):
        self.assertEqual(labels.activity_label("web_search"), "Searching the web")

    def test_unknown_tool_falls_back_to_a_generic_label(self):
        self.assertEqual(labels.activity_label("some_future_tool"), "Running some_future_tool…")

    def test_task_tool_with_subagent_type_uses_the_subagent_label(self):
        self.assertEqual(
            labels.activity_label("task", subagent_type="web-researcher"),
            "Researching the web",
        )

    def test_task_tool_with_unknown_subagent_type_falls_back(self):
        self.assertEqual(
            labels.activity_label("task", subagent_type="some-future-agent"),
            "Delegating to some-future-agent",
        )

    def test_module_has_no_langchain_import(self):
        # Structural guarantee, not just a style preference — see module
        # docstring. Import failure here would mean this module pulled in
        # LangChain/LangGraph transitively, breaking `ledger.py`'s
        # framework-free contract the moment it imports `labels`.
        import sys as _sys

        before = set(_sys.modules)
        import importlib

        importlib.reload(labels)
        after = set(_sys.modules)
        newly_imported = after - before
        self.assertFalse(
            any("langchain" in m or "langgraph" in m for m in newly_imported),
            f"agent.labels pulled in a LangChain/LangGraph module: {newly_imported}",
        )
