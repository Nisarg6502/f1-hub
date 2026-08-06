"""The CP61 single-agent baseline — one `deepagents` graph, all of CP60's tools.

`CHAT-AGENT-PLAN.md` §13 orders this deliberately: CP61 ships *one* agent with
every internal tool bound directly, no subagents and no verifier, so Batch 18
has a measured number to beat rather than an architecture nobody proved was
needed. §4.2 calls the alternative — a model doing nested `task()` dispatch
reliably on a free-tier 30b model — "the single riskiest assumption in this
plan", and `agent/spikes/README.md` §2 is the answer: `nemotron-3-nano:30b`
scored 3/3 on the multi-hop dispatch loop, so the subagent layer is not
cancelled, but that is Batch 18's bet to place, not this checkpoint's.

Three things this module is responsible for, each traceable to a rule
established elsewhere in this codebase rather than invented here:

**Tools are bound per request, to a fresh `EvidenceLedger`.** `agent/ledger.py`
is framework-free on purpose so it can be unit-tested without LangGraph; this
module is the one place that wires it into a LangChain tool call. Building a
new graph per request (rather than one graph shared across requests with a
mutable ledger swapped underneath it) means two overlapping requests — which
the concurrency semaphore already forbids, but a graph should not depend on a
gate elsewhere in the codebase to stay correct — can never see each other's
evidence.

**Only the model's final, tool-call-free message is streamed to the client.**
`model.py`'s docstring already established that reasoning content
(`message.thinking`) must never reach the user because it is not
evidence-backed prose. The same logic extends to a model's provisional,
mid-loop commentary before it calls a tool: `_stream_events` below buffers
each chat-model turn by its LangGraph `run_id` and only flushes it once
`on_chat_model_end` confirms that turn produced no tool calls, i.e. that it
was genuinely the answer and not a step along the way. Streaming raw token
chunks the instant they arrive would occasionally leak "Let me check the
standings..." as if it were the final prose.

**Ollama failures are classified with `model.py`'s existing rules, not
reinvented.** `langchain_ollama.ChatOllama` uses the same `ollama` Python
client this repo's own `agent/model.py` talks to directly, and that client
raises `ollama.ResponseError` for both HTTP-status failures and the
mid-stream `{"error": ...}` objects Ollama Cloud sends when a quota runs out
during generation. `model._classify` / `model._classify_stream_error` already
turn a status code or an error string into the right `ModelError` subtype;
reusing them here means `main.py`'s existing except chain — proven against
the deployed service in CP59 — needs no changes at all.
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any, AsyncIterator

import ollama
from langchain_core.tools import StructuredTool
from langgraph.errors import GraphRecursionError
from pydantic import create_model

from . import config
from . import model as model_seam
from . import router
from . import verifier
from .labels import ACTIVITY_LABELS, SUBAGENT_ACTIVITY_LABELS, activity_label
from .ledger import EvidenceLedger
from .tools import TOOLS

# --- Tool binding ------------------------------------------------------------


def _public_signature(fn: Any) -> inspect.Signature:
    """The signature the model should see — every real args, none of ours.

    Every tool in `agent/tools/` takes keyword-only `ledger` and `db` after
    its real parameters (`agent/tools/base.py`'s `fact_tool` preserves the
    wrapped function's signature via `functools.wraps`, so `inspect.signature`
    resolves to the real one, not `(*args, **kwargs)`). Exposing those to the
    LLM would let it pass its own `ledger` — which could never be a real
    `EvidenceLedger` and would either crash the tool call or, worse, silently
    produce a fact bundle with no ledger entry, i.e. an uncitable claim.
    """
    sig = inspect.signature(fn)
    kept = [p for name, p in sig.parameters.items() if name not in ("ledger", "db")]
    return sig.replace(parameters=kept)


def _args_model(tool_name: str, sig: inspect.Signature) -> type:
    """A pydantic model for the public signature, for the tool's JSON schema."""
    fields: dict[str, tuple[Any, Any]] = {}
    for name, param in sig.parameters.items():
        annotation = param.annotation if param.annotation is not inspect.Parameter.empty else Any
        default = param.default if param.default is not inspect.Parameter.empty else ...
        fields[name] = (annotation, default)
    return create_model(f"{tool_name}_Args", **fields)  # type: ignore[call-overload]


def _tool_description(fn: Any, tool_name: str) -> str:
    """The tool's first docstring paragraph — a one-line summary, not the essay.

    Every tool's full docstring carries the post-mortem it defends against
    (§5.1's "why", not just "what"), which is valuable for a human reading the
    source and wasted context for a model choosing among eighteen tools on a
    quota that meters GPU time by request duration.
    """
    doc = (fn.__doc__ or tool_name).strip()
    return doc.split("\n\n")[0].strip() or tool_name


def _bind_tool(tool_name: str, fn: Any, ledger: EvidenceLedger) -> StructuredTool:
    sig = _public_signature(fn)
    args_model = _args_model(tool_name, sig)

    async def _call(**kwargs: Any) -> dict:
        return await fn(**kwargs, ledger=ledger)

    _call.__name__ = tool_name
    return StructuredTool.from_function(
        coroutine=_call,
        name=tool_name,
        description=_tool_description(fn, tool_name),
        args_schema=args_model,
    )


def build_tools(ledger: EvidenceLedger) -> list[StructuredTool]:
    """Bind every CP60 tool to one request's ledger.

    `tools/__init__.py`'s `TOOLS` registry exists precisely so this binding
    step can live here, outside the tool layer — CP60's docstring says so
    directly: "`TOOLS` is the registry CP61 binds." The tool layer stays
    importable and unit-testable without LangChain at all.
    """
    return [_bind_tool(name, fn, ledger) for name, fn in TOOLS.items()]


def build_tool_subset(ledger: EvidenceLedger, names: "tuple[str, ...] | list[str]") -> list[StructuredTool]:
    """Bind a named subset of `TOOLS` — CP63's subagents each see only theirs.

    A `KeyError` here means a subagent's tool list in `subagents.py` names a
    tool that does not exist in the registry — a wiring bug worth failing
    loudly on at startup, not silently dropping the way a tool's own
    `unavailable()` failures do at call time (`tools/base.py`'s contract is
    about *data* being unavailable, not about *code* being wrong).
    """
    return [_bind_tool(name, TOOLS[name], ledger) for name in names]


# --- System prompt -----------------------------------------------------------

# Addresses taxonomy classes 1-7 (`CHAT-AGENT-PLAN.md` §2) — the ones CP61 is
# scoped to answer. Classes 8-9 (web/news, rules-glossary) need CP62's web
# tools and are out of scope; the prompt tells the model to say so rather than
# guess, which is also what class 14 (out-of-domain) and the T6 spike test
# both require: decline, do not tool-call.
SYSTEM_PROMPT = """You are the Pitwall Assistant for F1 Hub, a Formula 1 analysis app.

You answer from TOOL DATA ONLY. Never state a fact you did not just retrieve —
if you did not call a tool for it, you do not know it. This is not a style
preference: a past version of this system invented a teammate relationship
between two drivers on visibly different teams because it reasoned from
correct raw data instead of a pre-computed fact. Every number and every
relationship in your answer must trace back to a tool result from this turn.

Cite every factual claim with the evidence id from the tool result it came
from, in the form [ev_N] — for example "Norris scored 25 points [ev_3]."
Every tool result includes an `evidence_id` field; use it exactly as given,
never invent one. Some answers are automatically fact-checked against these
citations after you write them; an uncited or miscited claim gets sent back
to you once with the specific problem named, so you can fix it.

Ground rules:
- You have NO files and NO filesystem. Ignore the `ls`, `read_file`,
  `write_file`, `edit_file`, `glob` and `grep` tools entirely — there is
  nothing in the filesystem for an F1 question to find, and calling any of
  them before a real data tool only burns the turn's step budget. Go straight
  to the data tool the question actually needs.
- If a question mentions a vague reference ("the last race", "he", a driver's
  nickname, "this season") call `resolve_context` FIRST to turn it into a
  concrete year/round/driver id before calling anything else. Guessing an id
  is exactly the mistake `resolve_context` exists to prevent.
- If a question depends on today's date, or asks about "the next race" or
  "how the season stands", call `get_season_state` — you do not otherwise
  know what today's date is.
- Every tool returns either `{"available": true, "data": ...}` or
  `{"available": false, "reason": ...}`. When a tool reports `available:
  false`, say plainly that the data is not available and why — never fill the
  gap with a guess.
- Tools already compute totals, averages and comparisons. Do not do
  arithmetic yourself on raw rows; if a tool gives you a count, quote it.
- You answer questions about Formula 1 results, standings, drivers,
  constructors, races, strategy, circuits and history (1950-present) using
  this app's own data. You do NOT have web search or news access in this
  build — if a question needs live news, regulation changes, or anything
  outside this app's database, say so plainly rather than answering from
  general knowledge dressed up as fact.
- If a question is not about Formula 1 at all, decline briefly and do not
  call any tool.
- Answer in clear, concise Markdown — a few sentences for a simple lookup,
  more structure (a short list, a small table) only when the question is
  genuinely comparative or multi-part.
- Work efficiently: call only the tools the question actually needs, then
  answer. You are on a metered inference budget; looping between tools
  without converging on an answer is the single most expensive mistake you
  can make here.
"""

# CP63's multi-agent orchestrator prompt — used only when `router.classify`
# assigns tier 3 (`build_agent(use_subagents=True)`; see `router.Route`'s
# docstring for why tier 2 no longer reaches this path). Deliberately NOT a
# superset of `SYSTEM_PROMPT` above: the tier-1/2 prompt tells the model to
# use data tools directly because that is literally all it has; this prompt
# tells the model to delegate instead, because CP61's baseline (§5 of
# `agent/spikes/README.md`) already measured what happens when one model
# holds 18 tools flat and answers a comparative question — it reached for a
# plausible neighbour (`get_standings`) instead of the tool actually built
# for the question (`get_head_to_head`), which lives behind `race-analyst`
# here. Narrowing what the orchestrator can see is the fix, not asking it to
# choose better among more options.
ORCHESTRATOR_SYSTEM_PROMPT = """You are the orchestrator for F1 Hub's Pitwall Assistant.

You do not answer F1 data questions yourself — you delegate to specialist
subagents via the `task` tool, then synthesise their findings into one
answer. You have exactly two direct tools of your own:

- `resolve_context` — call this FIRST whenever the question has a vague
  reference ("the last race", "he", a nickname, "this season") to turn it
  into a concrete year/round/driver id before delegating. A subagent cannot
  resolve ambiguity you handed it unresolved.
- `get_season_state` — call this when the question depends on today's date
  or "the next race" / "how the season stands".

For everything else, delegate via `task` to the subagent whose description
best matches the question. Read each subagent's description before choosing
— they are not interchangeable, and picking the wrong one wastes a turn.

A subagent's reply already carries [ev_N] citations for what it found —
preserve them EXACTLY in your synthesis; never renumber, merge, or invent a
new one. If you state a fact a subagent reported, keep its citation attached
to it.

Ground rules, same as always:
- You have NO files and NO filesystem. Ignore `ls`, `read_file`, `write_file`,
  `edit_file`, `glob`, `grep`.
- Never state a fact a subagent did not just report to you. Your job is
  synthesis and citation, never derivation — if two subagents' findings
  disagree, say so rather than picking one.
- If a question is not about Formula 1 at all, decline briefly without
  delegating to anything.
- Work efficiently: delegate only to the subagents the question actually
  needs. You are on a metered inference budget; a genuinely simple question
  that could have been answered with one delegation should not fan out to
  three.
- Answer in clear, concise Markdown.
"""


# --- Model + graph construction ----------------------------------------------


def build_model():
    """The workhorse `ChatOllama`, pointed at Ollama Cloud.

    No explicit auth wiring here: the `ollama` Python client this wraps reads
    `OLLAMA_API_KEY` from the environment itself when no `Authorization`
    header is set (`ollama/_client.py`'s `BaseClient.__init__`), which is the
    same env var `agent/config.py.api_key()` reads — one source of truth, two
    readers. `astream_answer` checks `config.api_key()` explicitly before
    ever constructing this, so a missing key fails fast with `ModelUnavailable`
    instead of surfacing as an opaque `ollama.ResponseError` deep in a stream.
    """
    from langchain_ollama import ChatOllama

    return ChatOllama(
        model=config.DEFAULT_MODEL,
        base_url=config.OLLAMA_BASE_URL,
        temperature=config.TEMPERATURE,
    )


def build_agent(ledger: EvidenceLedger, *, use_subagents: bool = False, checkpointer: Any | None = None):
    """One `create_deep_agent` graph.

    `use_subagents=False` (the default) is CP61's exact proven flat graph —
    every CP60 tool bound directly, no subagents. `use_subagents=True` is
    CP63's addition: a slim two-tool orchestrator (`resolve_context`,
    `get_season_state`) that delegates everything else via `task()` to the
    four subagents in `subagents.py`. `astream_answer` decides which shape to
    build per turn from `router.classify` — this function itself stays
    agnostic to *why*, so it is testable without importing the router.
    """
    from deepagents import create_deep_agent

    if not use_subagents:
        return create_deep_agent(
            model=build_model(),
            tools=build_tools(ledger),
            system_prompt=SYSTEM_PROMPT,
            checkpointer=checkpointer,
        )

    from .subagents import build_subagents

    return create_deep_agent(
        model=build_model(),
        tools=build_tool_subset(ledger, ("resolve_context", "get_season_state")),
        subagents=build_subagents(ledger),
        system_prompt=ORCHESTRATOR_SYSTEM_PROMPT,
        checkpointer=checkpointer,
    )


# --- Error classification -----------------------------------------------------


def _classify_ollama_error(error: "ollama.ResponseError") -> model_seam.ModelError:
    """Route an `ollama.ResponseError` through `model.py`'s existing rules.

    `status_code` is a real HTTP status for a rejected request, and `-1` (the
    client's own default) for an error object Ollama sent *inside* an
    already-200 stream — mid-generation quota exhaustion, OOM, etc. Those two
    shapes are exactly what `model._classify` and `model._classify_stream_error`
    already distinguish for the non-agent path; reusing them here is what lets
    `main.py`'s except chain stay unchanged.
    """
    status = getattr(error, "status_code", None)
    body = getattr(error, "error", None) or str(error)
    if status and status > 0:
        return model_seam._classify(status, body)
    return model_seam._classify_stream_error(body)


# --- Streaming ----------------------------------------------------------------

AgentEvent = tuple[str, ...]
"""`("activity", label, state, detail, kind)` for a tool/agent call —
`detail`/`kind` from `_activity_detail`/CP68's tool-vs-agent split — or the
plain 3-tuple `("activity", label, state)` for the system-level narrations
`_run_turn` doesn't originate (queue waits, "Thinking…", the echo notice);
`main.py`'s `_stream` accepts both shapes. Also `("token", text)`,
`("tier", int, reason)` or `("verification", passed, violation_count)` — what
`main.py` turns into SSE frames / the `done` event's `tier` and
`verification` fields. Kept as a plain tuple rather than a dataclass so this
module has no import surface beyond what `main.py` already needs.
`("draft", text)` is a third internal kind `_run_turn` yields but
`astream_answer` never re-yields outward — see `_run_turn`'s docstring."""


# Tools whose single most-useful argument is worth surfacing verbatim in the
# activity timeline — CP68's answer to "say what it's searching for", scoped
# to the tools where a human-legible detail actually exists in the call
# arguments. Internal data tools (season/round/driver ids) are left
# unlabelled here rather than surfaced as raw ids a user cannot read.
_DETAIL_ARG: dict[str, str] = {
    "web_search": "query",
    "web_extract": "urls",
    "wikipedia_summary": "title",
    "resolve_context": "query",
}


def _activity_detail(tool_name: str, tool_input: dict) -> str | None:
    arg_name = _DETAIL_ARG.get(tool_name)
    if not arg_name:
        return None
    value = tool_input.get(arg_name)
    if isinstance(value, list):
        value = ", ".join(str(v) for v in value)
    if not value:
        return None
    text = str(value)
    return text if len(text) <= 80 else text[:77] + "…"


async def _run_turn(
    agent: Any, inputs: dict, run_config: dict
) -> AsyncIterator[AgentEvent]:
    """One full pass through the agent graph.

    Always yields `("activity", ...)` events as tool calls happen, and always
    yields a final `("draft", full_text)` once the run completes — an async
    generator has no other channel to hand a caller its accumulated result,
    since `return value` inside one is not observable through `async for`.

    Model tokens are buffered into `parts` as they arrive but never yielded
    live — every tier now takes the same path (CP67 removed tier 1's earlier
    live-yield special case: nothing calls this with the streamed-as-generated
    behaviour anymore). The buffered text is only surfaced once the caller,
    `astream_answer`, has run it through `verifier.check` and decided it is
    safe to show — via `_chunk_draft`'s replay, not from here. This is the
    same trade `session_recap.py`'s `SESSION_VALIDATORS` already made and
    documented: "the text has to be complete before it can be checked, and a
    violation must not have already reached the reader."
    """
    pending: dict[str, list[str]] = {}
    parts: list[str] = []

    async for event in agent.astream_events(inputs, version="v2", config=run_config):
        kind = event.get("event")
        name = event.get("name") or ""

        if kind == "on_chat_model_stream":
            run_id = event.get("run_id")
            chunk = (event.get("data") or {}).get("chunk")
            text = getattr(chunk, "content", None)
            if run_id and isinstance(text, str) and text:
                pending.setdefault(run_id, []).append(text)

        elif kind == "on_chat_model_end":
            run_id = event.get("run_id")
            buffered = pending.pop(run_id, []) if run_id else []
            if not buffered:
                continue
            output = (event.get("data") or {}).get("output")
            tool_calls = getattr(output, "tool_calls", None) or []
            if not tool_calls:
                parts.extend(buffered)

        elif kind == "on_tool_start" and name:
            tool_input = (event.get("data") or {}).get("input") or {}
            subagent_type = tool_input.get("subagent_type")
            activity_kind = "agent" if name == "task" and subagent_type else "tool"
            yield (
                "activity",
                activity_label(name, subagent_type=subagent_type),
                "start",
                _activity_detail(name, tool_input),
                activity_kind,
            )

        elif kind == "on_tool_end" and name:
            tool_input = (event.get("data") or {}).get("input") or {}
            subagent_type = tool_input.get("subagent_type")
            activity_kind = "agent" if name == "task" and subagent_type else "tool"
            yield (
                "activity",
                activity_label(name, subagent_type=subagent_type),
                "done",
                _activity_detail(name, tool_input),
                activity_kind,
            )

    yield ("draft", "".join(parts))


_CHUNK_WORDS = 6
"""Words per emitted token event when replaying a verified/repaired draft.
Coarser than the model's own per-token granularity (a live tier-1 turn emits
far smaller pieces), but the point of chunking at all is only to preserve
some streaming feel for a text that is, by construction, already fully
formed by the time it is emitted — see `_run_turn`'s docstring."""


def _chunk_draft(text: str) -> list[str]:
    words = (text or "").split(" ")
    chunks = []
    for i in range(0, len(words), _CHUNK_WORDS):
        piece = " ".join(words[i : i + _CHUNK_WORDS])
        if i + _CHUNK_WORDS < len(words):
            piece += " "
        chunks.append(piece)
    return chunks


async def astream_answer(
    message: str,
    *,
    thread_id: str | None,
    ledger: EvidenceLedger,
    checkpointer: Any | None = None,
) -> AsyncIterator[AgentEvent]:
    """Run one turn of the deep agent, yielding tier, activity, token and
    verification events.

    Raises the same typed errors `model.stream_chat` does
    (`ModelUnavailable` / `ModelAtCapacity` / `ModelTimeout` / `ModelError`),
    so `main.py`'s existing except chain handles this path without change —
    that chain is the thing CP59 proved against the deployed service, and
    CP61's whole point is to inherit it rather than rebuild it.

    CP63 adds one decision before any of that: `router.classify(message)`
    picks a tier from pattern rules alone (no model call — see `router.py`'s
    docstring for why), and that tier decides whether `build_agent` gets
    CP61's flat graph or CP63's subagent-delegating one. The tier is yielded
    first, as its own event, so `main.py` can attach it to the `done` payload
    — the field `sse.py`'s docstring has documented since CP59 but nothing
    populated until now.

    CP64 added a verify-and-repair step for tier 2 and 3 only; tier 1 streamed
    live and skipped it. CP67 closes that gap after it produced a real,
    measured failure: CP61's baseline answered an aggregate question with a
    fabricated "3 podiums" from zero tool calls, and nothing caught it. Every
    tier now runs the identical buffer → `verifier.check` → one-shot-repair
    path below. The repair re-invocation still uses a scratch
    `<thread>--repair` thread_id, unchanged from CP64.
    """
    if not config.api_key():
        raise model_seam.ModelUnavailable("OLLAMA_API_KEY is not configured")

    route = router.classify(message)
    yield ("tier", route.tier, route.reason)

    agent = build_agent(ledger, use_subagents=route.use_subagents, checkpointer=checkpointer)
    run_config = {
        "configurable": {"thread_id": thread_id or "anonymous"},
        # §4.2's cost-control rule made concrete: a super-step is roughly one
        # model call or one batch of tool calls, so this bounds how many
        # round trips one answer can spend before the graph refuses to
        # continue, rather than looping until the free-tier quota notices.
        "recursion_limit": config.AGENT_MAX_STEPS,
    }
    inputs = {"messages": [{"role": "user", "content": message}]}

    try:
        async with asyncio.timeout(config.REQUEST_TIMEOUT_SECONDS):
            draft = ""
            async for event in _run_turn(agent, inputs, run_config):
                if event[0] == "draft":
                    draft = event[1]
                else:
                    yield event

            result = verifier.check(
                draft, ledger, predictive=route.predictive, subjective=route.subjective
            )

            if not result.passed:
                repair_config = dict(run_config)
                repair_config["configurable"] = {
                    **run_config["configurable"],
                    "thread_id": f"{run_config['configurable']['thread_id']}--repair",
                }
                repair_inputs = {
                    "messages": [
                        {"role": "user", "content": message},
                        {"role": "assistant", "content": draft},
                        {"role": "user", "content": result.repair_message()},
                    ]
                }
                repaired = ""
                async for event in _run_turn(agent, repair_inputs, repair_config):
                    if event[0] == "draft":
                        repaired = event[1]
                    else:
                        yield event
                # Kept even if it still fails one violation-free rewrite is
                # not guaranteed on one attempt — the same call
                # `session_recap.py`'s validator already makes: a repaired
                # answer that still has one flaw beats discarding it and
                # emitting nothing.
                if repaired:
                    draft = repaired
                    result = verifier.check(
                        draft, ledger, predictive=route.predictive, subjective=route.subjective
                    )

            yield ("verification", result.passed, len(result.violations))
            for piece in _chunk_draft(draft):
                yield ("token", piece)

    except asyncio.TimeoutError as error:
        raise model_seam.ModelTimeout(
            f"agent turn exceeded {config.REQUEST_TIMEOUT_SECONDS:.0f}s"
        ) from error
    except ollama.ResponseError as error:
        raise _classify_ollama_error(error) from error
    except GraphRecursionError:
        # A real operating mode on a free-tier step budget (a genuinely hard
        # multi-hop question can legitimately need more calls than
        # `AGENT_MAX_STEPS` allows), not a bug — so it degrades to a plain,
        # honest answer instead of an SSE `error` event. See failure mode 6b
        # in the plan: "at capacity" must never read as a stack trace, and
        # exhausting the step budget is that same failure reached a
        # different way.
        for text in _budget_exhausted_answer():
            yield ("token", text)
        return
    except Exception as error:  # noqa: BLE001 - see below
        # Every other exception type is funnelled here deliberately —
        # `main.py`'s `except Exception` handler already exists to turn an
        # unexpected failure into a clean `internal` SSE event rather than a
        # dropped connection, and duplicating that classification here would
        # only create a second place for it to drift out of sync.
        raise model_seam.ModelError(f"agent run failed: {error}") from error


def _budget_exhausted_answer() -> list[str]:
    """The degrade-don't-lie answer for a run that hit `AGENT_MAX_STEPS`.

    Failure mode 6b in the plan: a free-tier quota running out mid-demo must
    read as "the assistant is at capacity", never as a stack trace. Hitting
    the step budget is the same failure mode reached a different way — too
    many round trips rather than too little quota — so it gets the same
    honest, usable degrade rather than an SSE `error` event.
    """
    return [
        "I wasn't able to reach a confident answer within this turn's step "
        "budget — that usually means the question needs more tool calls "
        "than a single turn allows on the current inference plan. Try "
        "breaking it into a more specific question."
    ]
