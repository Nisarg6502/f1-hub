"""Unit tests for `agent/graph.py` — the parts provable without Ollama.

Per the CP61 brief: "test the model seam by stubbing it... the free-tier
quota is shared and precious." So these tests exercise tool binding
(signature stripping, pydantic schema generation, the ledger injection that
makes a bound tool actually different from the raw CP60 function) and error
classification — the pure-Python logic around the model, never the model
itself. `agent/spikes/model_spike.py` is the one place real Ollama calls are
allowed, and only when run by hand.
"""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agent import graph, model
from agent.ledger import EvidenceLedger


async def _fake_tool(x: str, y: int = 2, *, ledger=None, db=None) -> dict:
    """Mirrors a real CP60 tool's shape: public args, then ledger/db."""
    return {"x": x, "y": y, "ledger_is_the_one_passed_in": ledger is _SENTINEL_LEDGER}


_fake_tool.__doc__ = (
    "One short summary line.\n\n"
    "A second paragraph full of post-mortem prose that the model should "
    "never see, because it would burn context for nothing."
)

_SENTINEL_LEDGER = EvidenceLedger()


class PublicSignatureTests(unittest.TestCase):
    def test_ledger_and_db_are_stripped(self):
        sig = graph._public_signature(_fake_tool)
        self.assertNotIn("ledger", sig.parameters)
        self.assertNotIn("db", sig.parameters)
        self.assertEqual(list(sig.parameters), ["x", "y"])


class ArgsModelTests(unittest.TestCase):
    def test_required_and_defaulted_fields(self):
        sig = graph._public_signature(_fake_tool)
        model_cls = graph._args_model("fake_tool", sig)
        fields = model_cls.model_fields
        self.assertTrue(fields["x"].is_required())
        self.assertFalse(fields["y"].is_required())
        self.assertEqual(fields["y"].default, 2)


class ToolDescriptionTests(unittest.TestCase):
    def test_only_the_first_paragraph_is_kept(self):
        description = graph._tool_description(_fake_tool, "fake_tool")
        self.assertEqual(description, "One short summary line.")
        self.assertNotIn("post-mortem", description)


class BindToolTests(unittest.TestCase):
    def test_bound_tool_injects_the_request_ledger(self):
        tool = graph._bind_tool("fake_tool", _fake_tool, _SENTINEL_LEDGER)
        result = asyncio.run(tool.ainvoke({"x": "hello"}))
        self.assertIn("ledger_is_the_one_passed_in", str(result) + repr(result))

    def test_bound_tool_schema_hides_ledger_and_db(self):
        tool = graph._bind_tool("fake_tool", _fake_tool, _SENTINEL_LEDGER)
        schema = tool.args_schema.model_json_schema()
        self.assertIn("x", schema["properties"])
        self.assertNotIn("ledger", schema["properties"])
        self.assertNotIn("db", schema["properties"])

    def test_bound_tool_applies_the_default(self):
        tool = graph._bind_tool("fake_tool", _fake_tool, _SENTINEL_LEDGER)
        result = asyncio.run(tool.ainvoke({"x": "hello"}))
        self.assertIn("'y': 2", str(result))


class BuildToolsTests(unittest.TestCase):
    def test_every_cp60_tool_gets_bound(self):
        from agent.tools import TOOLS

        ledger = EvidenceLedger()
        tools = graph.build_tools(ledger)
        names = {t.name for t in tools}
        self.assertEqual(names, set(TOOLS))

    def test_bound_tools_carry_a_one_line_description(self):
        ledger = EvidenceLedger()
        for tool in graph.build_tools(ledger):
            self.assertTrue(tool.description)
            self.assertNotIn("\n\n", tool.description)


class ActivityLabelTests(unittest.TestCase):
    def test_known_tool_gets_its_friendly_label(self):
        self.assertEqual(
            graph.activity_label("get_race_control"), "Reading race control"
        )

    def test_unknown_tool_falls_back_to_a_generic_label(self):
        self.assertIn("some_future_tool", graph.activity_label("some_future_tool"))


class ClassifyOllamaErrorTests(unittest.TestCase):
    def test_http_429_becomes_at_capacity(self):
        import ollama

        error = ollama.ResponseError("rate limited", 429)
        classified = graph._classify_ollama_error(error)
        self.assertIsInstance(classified, model.ModelAtCapacity)

    def test_mid_stream_quota_message_becomes_at_capacity(self):
        import ollama

        # Ollama's mid-stream error object has no real HTTP status; the
        # client defaults it to -1 (`ollama/_client.py`).
        error = ollama.ResponseError("quota exceeded for this session")
        classified = graph._classify_ollama_error(error)
        self.assertIsInstance(classified, model.ModelAtCapacity)

    def test_generic_failure_is_not_misclassified_as_capacity(self):
        import ollama

        error = ollama.ResponseError("model failed to load", 500)
        classified = graph._classify_ollama_error(error)
        self.assertIsInstance(classified, model.ModelError)
        self.assertNotIsInstance(classified, model.ModelAtCapacity)


class AstreamAnswerGuardTests(unittest.TestCase):
    def test_missing_api_key_raises_before_touching_the_network(self):
        from unittest.mock import patch

        async def _drive():
            async for _ in graph.astream_answer(
                "hello", thread_id=None, ledger=EvidenceLedger()
            ):
                pass

        with patch.object(graph.config, "api_key", lambda: None):
            with self.assertRaises(model.ModelUnavailable):
                asyncio.run(_drive())


if __name__ == "__main__":
    unittest.main()
