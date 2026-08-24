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
import inspect
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


class ClockArgumentIsHiddenTests(unittest.TestCase):
    """CP73: the model must not be able to tell the tools what day it is.

    In the live reproduction of "Compare Norris and Verstappen this year",
    `resolve_context` returned the real date (2026-08-07) and the model then
    called `get_season_state` with a `today` of its own — the bundle came
    back reporting 2025-11-03 and season 2025, and the turn spent its
    remaining step budget re-reading the wrong season. `today` exists for
    tests and for replaying a past conversation; it was never meant to be a
    model-supplied argument, and the schema is where that is enforced.
    """

    def test_today_is_stripped_from_every_tool_that_takes_one(self):
        from agent.tools import TOOLS

        takers = [
            name
            for name, fn in TOOLS.items()
            if "today" in inspect.signature(fn).parameters
        ]
        # If this ever empties, the tests below are vacuously passing.
        self.assertTrue(takers)

        for name in takers:
            with self.subTest(tool=name):
                sig = graph._public_signature(TOOLS[name])
                self.assertNotIn("today", sig.parameters)

    def test_the_bound_schema_offers_no_clock_to_override(self):
        from agent.tools import TOOLS

        tool = graph._bind_tool(
            "get_season_state", TOOLS["get_season_state"], _SENTINEL_LEDGER
        )
        schema = tool.args_schema.model_json_schema()

        self.assertNotIn("today", schema.get("properties", {}))


class ComparativeToolGuidanceTests(unittest.TestCase):
    """CP73: the prompt half of the comparative fix.

    The prompt is not the fix — `tools/drivers.py` is — but the rule is
    cheap and it names the specific wrong move the trace recorded. Asserted
    so a later prompt edit that drops it is a test failure rather than a
    silent regression, the same discipline the no-filesystem rule already
    gets.
    """

    def test_the_system_prompt_names_the_one_call_comparison_rule(self):
        self.assertIn("get_head_to_head", graph.SYSTEM_PROMPT)
        self.assertIn("get_driver_season_summary", graph.SYSTEM_PROMPT)

    def test_the_system_prompt_tells_the_model_to_stop_when_it_has_the_facts(self):
        self.assertIn("STOP", graph.SYSTEM_PROMPT)


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


class ModelVisibleArgumentAuditTests(unittest.TestCase):
    """The audit `ROADMAP.md`'s Batch 20 findings asked for and nobody ran.

    CP73 stripped `get_season_state`'s `today` after a live trace caught the
    model asserting a wrong date with it, and closed the bullet with "worth
    auditing other tools for optional arguments the model can see." Only that
    one tool was fixed. This class is the audit, expressed as an assertion
    instead of a paragraph: the exact set of arguments every tool offers the
    model is written down here, so adding an optional parameter to any tool
    fails this test until someone states, in the map below, that a model is
    the right thing to be choosing it.

    The map is the deliverable, not the mechanism. `today` reached production
    because a parameter added for tests was *automatically* a parameter for
    the model, and nothing anywhere had to agree that it should be.
    """

    # tool name -> the arguments the model is allowed to see, in schema order.
    # Everything optional in here was checked one at a time; the verdict for
    # each is in the corresponding tool's docstring.
    #
    #   session / kind / after_round / season / drivers / topic
    #   and get_historical_race_index's five filters
    #       — question-shaped choices. The model is the only thing that knows
    #         whether it wants qualifying or the race, the constructors' table
    #         or the drivers', a season slice or the whole archive. Kept.
    #   ledger / db  — this package's plumbing (CP61).
    #   today        — the clock, on both tools that take one (CP73).
    #   max_results  — `web_search`'s Tavily budget cap; nothing about an F1
    #                  question bears on it, and `web_extract`'s equivalent was
    #                  already a module constant. Stripped, this checkpoint.
    #   focus        — `get_circuit_dossier`'s facet selector. VERDICT: KEPT,
    #                  model-visible. It passes the same test `topic` passes
    #                  and `max_results` fails: it is question-shaped, not a
    #                  budget knob. "Is it hard to overtake here", "does it
    #                  break cars" and "how many stops" read three different
    #                  collections and only the asker knows which was meant,
    #                  and both `tools/circuit_scope.py` and
    #                  `subagents.STATS_SCOUT_PROMPT` tell the model how to
    #                  choose it. The alternative — returning all three facets
    #                  every call — triples the bundle for a question that
    #                  wanted one third of it, against §5's context-budget
    #                  rule. Its default (`"overtaking"`) is the facet the
    #                  feature was built for, so a model that omits it still
    #                  gets the useful answer rather than an error.
    EXPECTED_PUBLIC_ARGS = {
        "get_circuit_dossier": ("circuit_id", "focus"),
        "get_circuit_history": ("circuit_id",),
        "get_circuit_profile": ("circuit_id",),
        "get_constructor_seasons": ("constructor_id",),
        "get_driver_profile": ("driver_id",),
        "get_driver_season_summary": ("driver_id", "year"),
        "get_head_to_head": ("driver_a", "driver_b", "season"),
        "get_points_progression": ("driver_a", "driver_b", "season"),
        "get_historical_race_index": (
            "season_from",
            "season_to",
            "circuit_id",
            "driver",
            "constructor_key",
        ),
        "get_lap_summary": ("year", "round_number", "drivers"),
        "get_pit_stops": ("year", "round_number"),
        "get_race_control": ("year", "round_number"),
        "get_race_narrative_facts": ("year", "round_number"),
        "get_race_strategy": ("year", "round_number"),
        "get_season_calendar": ("year",),
        "get_season_state": (),
        # `ledger` and `visuals` are both plumbing and both hidden; what the
        # model sees is exactly CHAT-VISUALS-CONTRACT.md §2's signature.
        "render_visual": ("evidence_id", "title", "code", "caption"),
        "get_session_result": ("year", "round_number", "session"),
        "get_standings": ("year", "kind", "after_round"),
        "get_weather": ("year", "round_number"),
        "resolve_context": ("hint",),
        "web_extract": ("urls",),
        "web_search": ("query", "topic"),
        "wikipedia_summary": ("title",),
    }

    @staticmethod
    def _every_bindable_tool():
        """`TOOLS` plus the three web tools, which `subagents.py` binds through
        the same `_bind_tool` but which deliberately live outside the internal
        registry (see `tools/web.py`'s docstring). An audit that read `TOOLS`
        alone would have missed `web_search` — the one tool this audit found.
        """
        from agent.tools import TOOLS, web as web_tools

        bindable = dict(TOOLS)
        for fn in (
            web_tools.web_search,
            web_tools.web_extract,
            web_tools.wikipedia_summary,
        ):
            bindable[fn.tool_name] = fn
        return bindable

    def test_the_map_covers_every_bindable_tool(self):
        """Otherwise a tool added later is audited by omission."""
        self.assertEqual(
            set(self._every_bindable_tool()), set(self.EXPECTED_PUBLIC_ARGS)
        )

    def test_no_tool_offers_the_model_an_argument_outside_the_map(self):
        bindable = self._every_bindable_tool()
        for name, expected in sorted(self.EXPECTED_PUBLIC_ARGS.items()):
            with self.subTest(tool=name):
                tool = graph._bind_tool(name, bindable[name], _SENTINEL_LEDGER)
                schema = tool.args_schema.model_json_schema()
                self.assertEqual(
                    tuple(schema.get("properties", {})), tuple(expected)
                )

    def test_no_tool_leaks_ledger_db_or_today(self):
        """The three global hidden names, asserted across the whole registry
        rather than on the two tools that happened to prompt the rule."""
        bindable = self._every_bindable_tool()
        for name, fn in sorted(bindable.items()):
            with self.subTest(tool=name):
                properties = (
                    graph._bind_tool(name, fn, _SENTINEL_LEDGER)
                    .args_schema.model_json_schema()
                    .get("properties", {})
                )
                for hidden in ("ledger", "db", "today"):
                    self.assertNotIn(hidden, properties)


class WebSearchBudgetArgumentTests(unittest.TestCase):
    """`web_search.max_results` — the one thing the audit above found.

    Same failure shape as `today`: a knob added for the tool's own callers,
    visible in the model's JSON schema purely because it was a real parameter,
    with nothing in any prompt telling the model when to change it. It caps
    Tavily spend against a 1,000-credit/month free tier and caps how much
    retrieved prose this bundle costs in context — neither of which an F1
    question can inform. `web_extract`'s equivalent cap was already a module
    constant, which is what makes this an inconsistency rather than a design.
    """

    def test_max_results_is_not_in_the_model_visible_schema(self):
        from agent.tools import web as web_tools

        tool = graph._bind_tool("web_search", web_tools.web_search, _SENTINEL_LEDGER)
        properties = tool.args_schema.model_json_schema().get("properties", {})

        self.assertNotIn("max_results", properties)
        # Non-vacuous: the schema is really being built, and the arguments
        # that *are* the model's business survived.
        self.assertIn("query", properties)
        self.assertIn("topic", properties)

    def test_topic_is_deliberately_still_offered(self):
        """The audit's verdicts are not "hide every optional argument".
        `topic="news"` is what makes a time-sensitive question search like
        one, and both `web.py` and `subagents.WEB_RESEARCHER_PROMPT` tell the
        model to choose it. Asserted so a later over-correction that hides it
        is a test failure rather than a silent capability loss.
        """
        from agent.tools import web as web_tools

        self.assertNotIn("topic", web_tools.web_search.hidden_args)
        self.assertIn("max_results", web_tools.web_search.hidden_args)

    def test_the_function_still_takes_max_results_for_its_own_callers(self):
        """Stripped from the schema, not from the function — the same shape
        `today` was left in, so `tests/test_agent_web_tools.py`'s clamping
        test and any future caller keep working."""
        import inspect as _inspect
        from agent.tools import web as web_tools

        self.assertIn(
            "max_results", _inspect.signature(web_tools.web_search).parameters
        )

    def test_hiding_an_argument_the_tool_does_not_have_fails_loudly(self):
        """A `hidden_args` entry that matches nothing hides nothing, and the
        leak it permits is invisible until a live trace catches it. Import
        time is the only place that mistake is cheap to find."""
        from agent.tools.base import fact_tool

        with self.assertRaises(ValueError):

            @fact_tool("typo_tool", hidden_args=("max_reslts",))
            async def _typo_tool(query: str, max_results: int = 5) -> dict:
                return {}


class GeneralPurposeSubagentTests(unittest.TestCase):
    """The `general-purpose` subagent is gone from the built graph.

    CP63's trace recorded the flat orchestrator delegating to a subagent it
    was never given — `"Delegating to general-purpose"` at 80.3s — which then
    re-ran tool calls the orchestrator already had bound directly.
    `graph._register_harness_profile` turns off deepagents' auto-added default;
    these tests assert the *result* on the compiled graph rather than that the
    registration ran.

    That distinction is `ROADMAP.md`'s Batch 20 lesson, stated there after
    CP75's opinion-drop guard was found merged, documented and inert: "a guard
    delegated to another component's flag needs a test that exercises the
    flag, not just the delegation." Everything below inspects the real graph
    `build_agent` returns.

    No model call is made: `create_deep_agent` only assembles a graph, and
    `_ScriptedAgent` elsewhere in this file covers the parts that would need
    one.
    """

    @staticmethod
    def _tools_by_name(agent):
        """The compiled graph's actual tool registry.

        Reached through the `tools` node's `ToolNode`, unwrapping `bound`
        because LangGraph wraps the node — asserted on rather than the
        `task` tool's presence in some config dict, because this is the
        collection the model's tool calls are dispatched against.
        """
        node = agent.nodes["tools"]
        for _ in range(10):
            if hasattr(node, "tools_by_name"):
                return node.tools_by_name
            node = getattr(node, "bound", None)
            if node is None:
                break
        raise AssertionError("no ToolNode with tools_by_name on the built graph")

    def test_the_deepagents_api_this_fix_depends_on_actually_exists(self):
        """`HANDOFF.md` names `GeneralPurposeSubagentProfile(enabled=False)`.
        This repo has shipped a plausible-but-nonexistent name before (the
        `qwen3.5:35b` model), so the name is checked against the installed
        package, not taken on trust — and checked here so an upgrade that
        renames it fails as a clear import error rather than as a silently
        re-enabled subagent.
        """
        from deepagents import GeneralPurposeSubagentProfile, HarnessProfile

        profile = HarnessProfile(
            general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False)
        )
        self.assertFalse(profile.general_purpose_subagent.enabled)

    def test_the_flat_graph_has_no_task_tool_at_all(self):
        """Tiers 1-2. With the default subagent disabled and no subagents
        passed, deepagents drops `task` entirely — so the flat orchestrator
        cannot delegate to anything, which is what it was always documented
        to be."""
        agent = graph.build_agent(EvidenceLedger())
        tools = self._tools_by_name(agent)

        self.assertNotIn("task", tools)
        # Non-vacuous: the node is populated and the absence above is a real
        # absence, not an empty registry. `ls` is deepagents' always-on
        # filesystem default (see this module's prompt rules), so its presence
        # proves the built-in tool set is there to be searched.
        self.assertIn("ls", tools)

    def test_the_flat_graphs_own_f1_tools_are_still_bound(self):
        """The other half of "not vacuous": disabling the default subagent
        must not have cost the graph the tools the answer is made of."""
        from agent.tools import TOOLS

        tools = self._tools_by_name(graph.build_agent(EvidenceLedger()))
        self.assertTrue(set(TOOLS).issubset(set(tools)))

    def test_the_subagent_graph_keeps_task_but_not_general_purpose(self):
        """Tier 3. `task` is that path's entire point, so it stays; what goes
        is `general-purpose` as a delegation target. The `task` tool's
        description is where deepagents lists the agent types the model may
        name, so it is the model-visible surface to assert on.

        Matched as `"- general-purpose:"`, the shape of one entry in that
        list, rather than as the bare name: deepagents ends every `task`
        description with a fixed block of usage notes that mentions
        general-purpose unconditionally ("When only general-purpose is
        available, use it for..."), whether or not the subagent exists. That
        sentence is boilerplate the harness always emits and is not a
        delegation target; the enumerated list above it is. Asserted this way
        so the test proves the subagent is unavailable rather than proving a
        string is missing from prose we do not own.
        """
        agent = graph.build_agent(EvidenceLedger(), use_subagents=True)
        tools = self._tools_by_name(agent)

        self.assertIn("task", tools)
        description = tools["task"].description
        self.assertNotIn("- general-purpose:", description)
        # Non-vacuous: the four real subagents are offered in exactly that
        # shape, so the missing entry above is the default being off — not a
        # description whose format changed underneath this assertion.
        for name in ("stats-scout", "historian", "web-researcher", "race-analyst"):
            self.assertIn(f"- {name}:", description)


# --------------------------------------------------------------------------
# The tools actually offered to the model, without calling one
# --------------------------------------------------------------------------
# `excluded_tools` does NOT remove a tool from the graph — the handlers stay
# registered and `_ToolExclusionMiddleware` filters them out of each model
# request instead (`wrap_model_call`). So the `tools_by_name` inspection the
# `task` tests above use cannot see it, and reading `_excluded` off the
# middleware would only prove the flag was passed — the precise thing
# `ROADMAP.md`'s Batch 20 lesson says is not enough.
#
# What is asserted instead is the tool list the middleware stack actually hands
# the model, captured by a chat model that records `bind_tools` and answers
# from a script. Real graph, real middleware, zero network — the same "stub the
# model seam" rule this file's module docstring states, applied to the tool
# surface rather than to the prose.

_RECORDED_TOOL_LISTS: list = []
_MODEL_SCRIPT: list = []


def _recording_model():
    """A `ChatOllama` that records what it is bound and never leaves the process.

    Subclasses the real thing rather than a generic fake so the model the graph
    sees is byte-for-byte the class `build_model` returns; only `bind_tools` and
    the two generate hooks are overridden. State lives at module level because
    `ChatOllama` is a pydantic model and will not take stray instance attributes.
    """
    from langchain_core.messages import AIMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_ollama import ChatOllama

    class _Recorder(ChatOllama):
        def bind_tools(self, tools, **kwargs):
            _RECORDED_TOOL_LISTS.append(
                sorted(
                    name
                    for name in (
                        getattr(t, "name", None)
                        or (t.get("name") if isinstance(t, dict) else None)
                        for t in tools
                    )
                    if name
                )
            )
            return self

        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            message = _MODEL_SCRIPT.pop(0) if _MODEL_SCRIPT else AIMessage(content="ok")
            return ChatResult(generations=[ChatGeneration(message=message)])

        async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
            return self._generate(messages)

    return _Recorder(
        model=graph.config.DEFAULT_MODEL,
        base_url=graph.config.OLLAMA_BASE_URL,
        temperature=graph.config.TEMPERATURE,
    )


def _tool_lists_offered(*, use_subagents=False, script=()):
    """Run one turn of the real graph and return every tool list bound.

    With `use_subagents=True` and a scripted `task` call, the subagent's own
    `bind_tools` is recorded too — which is the only way to prove the exclusion
    reached the four subagents rather than just the orchestrator.
    """
    from unittest.mock import patch

    _RECORDED_TOOL_LISTS.clear()
    _MODEL_SCRIPT[:] = list(script)
    with patch.object(graph, "build_model", _recording_model):
        agent = graph.build_agent(EvidenceLedger(), use_subagents=use_subagents)
        asyncio.run(agent.ainvoke({"messages": [("user", "hi")]}))
    return [set(names) for names in _RECORDED_TOOL_LISTS]


def _delegate_to(subagent_type):
    """A scripted first turn that calls `task` — forces a real subagent run."""
    from langchain_core.messages import AIMessage

    return [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "task",
                    "id": "call_1",
                    "args": {"description": "go", "subagent_type": subagent_type},
                }
            ],
        )
    ]


class FilesystemToolExclusionTests(unittest.TestCase):
    """The no-filesystem rule is structural now, not a sentence in a prompt.

    `HANDOFF.md` records the prompt version of this rule being written twice
    and failing twice: CP61's baseline wandered into `ls`/`grep` and burned its
    step budget, and CP63's first live `web-researcher` test called
    `web_search`, got an empty result, then tried `ls` and `glob` before giving
    up. Both were patched by adding prose — the "ask the model nicely" shape
    CP38/CP41 rejected for *output*, applied here to tool availability.

    The prompt rules are deliberately still there (`SYSTEM_PROMPT`,
    `ORCHESTRATOR_SYSTEM_PROMPT`, `subagents._NO_FILESYSTEM_RULE`) — they cost
    nothing and they document intent — but they are no longer what enforces
    this, and `_register_harness_profile`'s docstring says so.
    """

    FORBIDDEN = ("ls", "glob", "grep", "write_file", "edit_file", "delete")

    def test_the_flat_graph_offers_the_model_no_way_to_explore_a_filesystem(self):
        from agent.tools import TOOLS

        offered = _tool_lists_offered()[-1]
        for name in self.FORBIDDEN:
            with self.subTest(tool=name):
                self.assertNotIn(name, offered)
        # Non-vacuous: this is a real, populated tool list — every F1 tool the
        # answer is made of survived the exclusion.
        self.assertTrue(set(TOOLS).issubset(offered))

    def test_read_file_is_deliberately_kept(self):
        """Not an oversight — the one built-in that stays, for two reasons
        checked in the installed deepagents source.

        `SummarizationMiddleware` (unconditional in both the main and every
        subagent stack) offloads evicted history to
        `/conversation_history/{thread_id}.md` and embeds that path in the
        summary "so the agent can re-open it via `read_file`"; and
        `FilesystemMiddleware` refuses a tool allowlist that omits `read_file`
        at all ("required by FilesystemMiddleware"). Excluding it would trade a
        real recovery path for nothing, because *reading* is not what went
        wrong in either incident — discovery was. With `ls`, `glob` and `grep`
        gone the model can only read a path it was handed.
        """
        self.assertNotIn("read_file", graph.EXCLUDED_BUILTIN_TOOLS)
        self.assertIn("read_file", _tool_lists_offered()[-1])

    def test_every_excluded_name_is_a_tool_the_harness_really_binds(self):
        """deepagents does not validate `excluded_tools` names — a typo is a
        silent no-op, and the leak it permits looks exactly like a working
        exclusion. Checked against the graph's own tool registry, which is
        where the handlers live whether or not the model is offered them.
        """
        registry = set(
            GeneralPurposeSubagentTests._tools_by_name(graph.build_agent(EvidenceLedger()))
        )
        self.assertTrue(graph.EXCLUDED_BUILTIN_TOOLS)
        self.assertTrue(graph.EXCLUDED_BUILTIN_TOOLS.issubset(registry))

    def test_task_is_not_among_the_exclusions(self):
        """Tier 3 is built on `task`; excluding it here would break that path
        while the tier-1 tests above stayed green. The general-purpose subagent
        is switched off one level up instead."""
        self.assertNotIn("task", graph.EXCLUDED_BUILTIN_TOOLS)

    def test_the_subagents_lose_the_filesystem_tools_too(self):
        """CP63's actual incident, made impossible.

        A subagent's `system_prompt` inherits nothing, which is how
        `web-researcher` shipped without the rule the orchestrator had. It does
        inherit the *model*, though — and therefore this harness profile — so
        the exclusion reaches all four with no change to `subagents.py`. Driven
        by scripting a real `task` call so the subagent genuinely runs and
        binds its own tools.
        """
        lists = _tool_lists_offered(
            use_subagents=True, script=_delegate_to("web-researcher")
        )
        subagent = next(
            (names for names in lists if "web_search" in names), None
        )
        self.assertIsNotNone(subagent, "the web-researcher subagent never ran")

        for name in self.FORBIDDEN:
            with self.subTest(tool=name):
                self.assertNotIn(name, subagent)
        # Non-vacuous: it is the real web-researcher, with all three CP62 tools.
        self.assertTrue(
            {"web_search", "web_extract", "wikipedia_summary"}.issubset(subagent)
        )

    def test_the_orchestrator_keeps_task_and_its_own_two_tools(self):
        """The other half of non-vacuity for tier 3: the exclusion must not
        have cost the orchestrator the ability to delegate at all."""
        orchestrator = _tool_lists_offered(
            use_subagents=True, script=_delegate_to("stats-scout")
        )[0]

        self.assertIn("task", orchestrator)
        self.assertIn("resolve_context", orchestrator)
        self.assertIn("get_season_state", orchestrator)
        for name in self.FORBIDDEN:
            with self.subTest(tool=name):
                self.assertNotIn(name, orchestrator)


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


class _ToolCallingAgent:
    """Yields a single tool start/end pair, then a draft — for CP68's
    `detail`/`kind` regression tests, which need `on_tool_start`/
    `on_tool_end` events `_ScriptedAgent` never produces."""

    def __init__(self, tool_name: str, tool_input: dict, draft: str = "done"):
        self._tool_name = tool_name
        self._tool_input = tool_input
        self._draft = draft

    async def astream_events(self, inputs, version, config):
        yield {
            "event": "on_tool_start",
            "name": self._tool_name,
            "data": {"input": self._tool_input},
        }
        yield {
            "event": "on_tool_end",
            "name": self._tool_name,
            "data": {"input": self._tool_input},
        }
        yield {
            "event": "on_chat_model_stream",
            "run_id": "run-1",
            "data": {"chunk": _FakeChunk(self._draft)},
        }
        yield {
            "event": "on_chat_model_end",
            "run_id": "run-1",
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

    def test_web_search_tool_call_yields_detail_matching_the_query(self):
        # CP68: a `web_search` call's activity event should surface the query
        # verbatim as `detail`, and be tagged `kind == "tool"` since it is a
        # direct tool call, not a delegated subagent.
        agent = _ToolCallingAgent("web_search", {"query": "2027 engine regulations"})

        async def _drive():
            events = []
            async for event in graph._run_turn(agent, {}, {}):
                events.append(event)
            return events

        events = asyncio.run(_drive())
        activity_events = [e for e in events if e[0] == "activity"]
        self.assertEqual(len(activity_events), 2)  # start, done
        for event in activity_events:
            _, _label, _state, detail, kind = event
            self.assertEqual(detail, "2027 engine regulations")
            self.assertEqual(kind, "tool")

    def test_task_tool_call_with_subagent_type_yields_agent_kind(self):
        # CP68: delegating via `task` with a `subagent_type` should be tagged
        # `kind == "agent"`, distinguishing it from a direct tool call.
        agent = _ToolCallingAgent("task", {"subagent_type": "race-analyst"})

        async def _drive():
            events = []
            async for event in graph._run_turn(agent, {}, {}):
                events.append(event)
            return events

        events = asyncio.run(_drive())
        activity_events = [e for e in events if e[0] == "activity"]
        self.assertEqual(len(activity_events), 2)  # start, done
        for event in activity_events:
            _, _label, _state, _detail, kind = event
            self.assertEqual(kind, "agent")


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
