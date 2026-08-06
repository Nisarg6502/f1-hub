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


# --------------------------------------------------------------------------
# CP64: proving the verify/repair loop actually fires, with a stubbed agent
# --------------------------------------------------------------------------
# "test the model seam by stubbing it" (this file's own module docstring)
# applied to CP64's repair loop: `_run_turn` only needs an object with an
# `astream_events(inputs, version, config)` method, so a fake agent scripted
# to return an uncited draft on its first invocation and a cited draft on its
# second is a complete, deterministic proof that `astream_answer` actually
# regenerates once on a verification failure — no live Ollama call needed to
# demonstrate the mechanism, mirroring how `test_agent_chat.py` proves the
# SSE transport without a real model behind it.


class _FakeChunk:
    def __init__(self, content):
        self.content = content


class _FakeOutput:
    def __init__(self, tool_calls=None):
        self.tool_calls = tool_calls or []


class _ScriptedAgent:
    """Returns one scripted draft per call to `astream_events`, in order."""

    def __init__(self, drafts: list[str]):
        self._drafts = list(drafts)
        self.calls: list[dict] = []

    async def astream_events(self, inputs, version, config):
        self.calls.append(inputs)
        draft = self._drafts[len(self.calls) - 1]
        run_id = f"run-{len(self.calls)}"
        yield {
            "event": "on_chat_model_stream",
            "run_id": run_id,
            "data": {"chunk": _FakeChunk(draft)},
        }
        yield {
            "event": "on_chat_model_end",
            "run_id": run_id,
            "data": {"output": _FakeOutput(tool_calls=[])},
        }


class RunTurnTests(unittest.TestCase):
    def test_tokens_are_buffered_and_only_yielded_as_draft(self):
        # CP67 removed tier 1's live-yield special case: every tier now
        # buffers tokens and only surfaces them via the caller's
        # `_chunk_draft` replay after verification, never as live `("token",
        # ...)` events out of `_run_turn` itself.
        agent = _ScriptedAgent(["hello world"])

        async def _drive():
            events = []
            async for event in graph._run_turn(agent, {}, {}):
                events.append(event)
            return events

        events = asyncio.run(_drive())
        self.assertNotIn(("token", "hello world"), events)
        self.assertEqual(events[-1], ("draft", "hello world"))


class ChunkDraftTests(unittest.TestCase):
    def test_empty_text_yields_no_chunks(self):
        self.assertEqual(graph._chunk_draft(""), [""])

    def test_rejoined_chunks_equal_original_text(self):
        text = "Lando Norris won the 2026 Hungarian Grand Prix with a great drive today."
        self.assertEqual("".join(graph._chunk_draft(text)), text)


class RepairLoopTests(unittest.TestCase):
    def test_tier_2_question_with_uncited_draft_triggers_one_repair(self):
        from unittest.mock import patch

        ledger = EvidenceLedger()
        ledger.append(source="mongo:race_results/2026-11", data={"points": 25})

        rejected_draft = "Norris scored 25 points this weekend."
        repaired_draft = "Norris scored 25 points [ev_1] this weekend."
        agent = _ScriptedAgent([rejected_draft, repaired_draft])

        async def _drive():
            events = []
            with patch.object(graph.config, "api_key", lambda: "fake-key"):
                with patch.object(graph, "build_agent", lambda *a, **k: agent):
                    async for event in graph.astream_answer(
                        "Compare Verstappen and Norris this season.",
                        thread_id="t1",
                        ledger=ledger,
                    ):
                        events.append(event)
            return events

        events = asyncio.run(_drive())

        # Exactly two invocations: the original draft, then one repair.
        self.assertEqual(len(agent.calls), 2)
        # The repair call's messages must name the original question, the
        # rejected draft, and the corrective instruction naming the
        # violation — not a bare retry with no context.
        repair_messages = agent.calls[1]["messages"]
        self.assertEqual(len(repair_messages), 3)
        self.assertIn(rejected_draft, repair_messages[1]["content"])
        self.assertIn("REJECTED", repair_messages[2]["content"])

        verification_events = [e for e in events if e[0] == "verification"]
        self.assertEqual(len(verification_events), 1)
        self.assertTrue(verification_events[0][1])  # passed, after repair

        # The user only ever sees the repaired text, streamed as tokens —
        # never the rejected first draft.
        streamed_text = "".join(e[1] for e in events if e[0] == "token")
        self.assertEqual(streamed_text, repaired_draft)

    def test_tier_2_question_with_clean_draft_skips_repair(self):
        from unittest.mock import patch

        ledger = EvidenceLedger()
        ledger.append(source="mongo:race_results/2026-11", data={"points": 25})
        clean_draft = "Norris scored 25 points [ev_1] this weekend."
        agent = _ScriptedAgent([clean_draft])

        async def _drive():
            events = []
            with patch.object(graph.config, "api_key", lambda: "fake-key"):
                with patch.object(graph, "build_agent", lambda *a, **k: agent):
                    async for event in graph.astream_answer(
                        "Compare Verstappen and Norris this season.",
                        thread_id="t2",
                        ledger=ledger,
                    ):
                        events.append(event)
            return events

        events = asyncio.run(_drive())

        self.assertEqual(len(agent.calls), 1)
        verification_events = [e for e in events if e[0] == "verification"]
        self.assertTrue(verification_events[0][1])

    def test_tier_1_question_now_verifies_and_repairs_a_bad_draft(self):
        # CP67: this used to be
        # `test_tier_1_question_never_verifies_even_with_a_bad_draft` and
        # asserted the opposite — tier 1 skipping verification entirely.
        # `astream_answer` no longer special-cases tier 1, so it now takes
        # the exact same buffer -> verify -> one-shot-repair path tier 2/3
        # already had (see `test_tier_2_question_with_uncited_draft_triggers_
        # one_repair` above, which this mirrors).
        from unittest.mock import patch

        ledger = EvidenceLedger()
        ledger.append(source="mongo:race_results/2026-11", data={"points": 25})

        rejected_draft = "Norris scored 25 points this weekend."
        repaired_draft = "Norris scored 25 points [ev_1] this weekend."
        agent = _ScriptedAgent([rejected_draft, repaired_draft])

        async def _drive():
            events = []
            with patch.object(graph.config, "api_key", lambda: "fake-key"):
                with patch.object(graph, "build_agent", lambda *a, **k: agent):
                    async for event in graph.astream_answer(
                        "Who won the 2026 Hungarian Grand Prix?",
                        thread_id="t3",
                        ledger=ledger,
                    ):
                        events.append(event)
            return events

        events = asyncio.run(_drive())

        # Tier 1 now runs the verifier — two calls (original + one repair),
        # one "verification" event, and only the repaired, cited text
        # streamed to the client.
        self.assertEqual(len(agent.calls), 2)
        verification_events = [e for e in events if e[0] == "verification"]
        self.assertEqual(len(verification_events), 1)
        self.assertTrue(verification_events[0][1])  # passed, after repair
        streamed_text = "".join(e[1] for e in events if e[0] == "token")
        self.assertEqual(streamed_text, repaired_draft)

    def test_tier_1_ungrounded_draft_is_now_verified_and_repaired(self):
        """CP67's core fix. Before this task, an empty-ledger tier-1 draft
        that asserts a number streamed straight to the client with nothing
        checking it. After this task, tier 1 gets the same verifier.check +
        one-shot repair loop tier 2/3 already have.

        Uses "13 podiums" rather than CP61's actual "3 podiums" — verified
        below (and see `test_tier_1_single_digit_aggregate_number_is_still_
        not_caught`) that `verifier.check` only flags uncited *non-trivial*
        numbers: `_TRIVIAL_NUMBERS` in `agent/verifier.py` excludes single
        digits (0-9), so a draft naming "3" of anything never raises a
        violation and never enters this repair path at all. "13" is not in
        that exclusion set, so it genuinely exercises the mechanism this
        test claims to prove.
        """
        from unittest.mock import patch

        # Arrange: a fake agent whose first attempt calls no tools at all
        # (`_ScriptedAgent` never yields on_tool_start/on_tool_end) and
        # answers with an uncited, non-trivial number — an ungrounded shape
        # like CP61's baseline actually produced — and whose second (repair)
        # attempt produces a properly-cited draft.
        #
        # The ledger carries one real entry, as it would once a repair
        # round's tool call actually fetches the podium count (in
        # production, the repair re-invocation binds the same tools and can
        # call them; `_ScriptedAgent` here only scripts text, not tool
        # execution, so the evidence a real repair call would gather is
        # pre-seeded). The first draft ignores it entirely — the exact
        # "answered from parametric memory instead of the evidence at hand"
        # shape of CP61's bug — and only the repaired draft cites it.
        ledger = EvidenceLedger()
        ledger.append(source="mongo:driver_results/norris/season-2026", data={"podiums": 13})
        rejected_draft = "Norris has had 13 podiums this season."
        repaired_draft = "Norris has had 13 podiums this season [ev_1]."
        agent = _ScriptedAgent([rejected_draft, repaired_draft])

        async def _drive():
            events = []
            with patch.object(graph.config, "api_key", lambda: "fake-key"):
                with patch.object(graph, "build_agent", lambda *a, **k: agent):
                    async for event in graph.astream_answer(
                        "How many podiums has Norris had this season?",
                        thread_id=None,
                        ledger=ledger,
                    ):
                        events.append(event)
            return events

        events = asyncio.run(_drive())

        # Two invocations: the original draft, then one repair.
        self.assertEqual(len(agent.calls), 2)

        verification_events = [e for e in events if e[0] == "verification"]
        self.assertEqual(len(verification_events), 1)
        self.assertTrue(verification_events[0][1])  # passed, after repair

        # The user only ever sees the repaired, cited text — never the
        # rejected, ungrounded first draft.
        streamed_text = "".join(e[1] for e in events if e[0] == "token")
        self.assertEqual(streamed_text, repaired_draft)

    def test_tier_1_single_digit_aggregate_number_is_still_not_caught(self):
        """Honest documentation of a known, pre-existing gap — NOT a
        regression introduced by this task.

        CP67's fix makes tier 1 run the same `verifier.check` + repair path
        as tier 2/3, closing the *general* case of an unverified tier-1
        draft. But `agent/verifier.py`'s `_TRIVIAL_NUMBERS` (0-9) excludes
        single-digit numbers from the "uncited number" check on purpose —
        it was tuned against a real live draft to avoid false positives on
        things like "the top 3" or "P1". That means the exact historical
        CP61 incident — "Norris has had 3 podiums this season." — is still
        NOT caught today: `verifier.check` reports `passed=True` for it, no
        repair fires, and the raw draft streams to the client unmodified.

        Widening `_TRIVIAL_NUMBERS` is out of scope for this task (it's
        shared logic tier 2/3 also depend on and risks new false positives
        elsewhere); this test exists purely to record the gap honestly so a
        future checkpoint can close it deliberately, rather than letting a
        green suite imply it's already fixed.
        """
        from unittest.mock import patch

        ledger = EvidenceLedger()  # empty — zero tool calls, exactly CP61's bug
        rejected_draft = "Norris has had 3 podiums this season."
        agent = _ScriptedAgent([rejected_draft])

        async def _drive():
            events = []
            with patch.object(graph.config, "api_key", lambda: "fake-key"):
                with patch.object(graph, "build_agent", lambda *a, **k: agent):
                    async for event in graph.astream_answer(
                        "How many podiums has Norris had this season?",
                        thread_id=None,
                        ledger=ledger,
                    ):
                        events.append(event)
            return events

        events = asyncio.run(_drive())

        # Only one call — no repair is ever triggered for this draft.
        self.assertEqual(len(agent.calls), 1)

        verification_events = [e for e in events if e[0] == "verification"]
        self.assertEqual(len(verification_events), 1)
        # `verification` reports passed=True even though the draft is an
        # uncited fabrication — the single-digit "3" slips past
        # check_citations' significant-number check entirely.
        self.assertTrue(verification_events[0][1])

        # The raw, ungrounded draft streams straight to the client.
        streamed_text = "".join(e[1] for e in events if e[0] == "token")
        self.assertEqual(streamed_text, rejected_draft)


if __name__ == "__main__":
    unittest.main()
