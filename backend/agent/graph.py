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
from .visuals import VisualBuffer

# --- Tool binding ------------------------------------------------------------

_HIDDEN_ARGS = frozenset({"ledger", "db", "today", "visuals"})
"""Tool parameters the model never sees, whichever tool declares them.

Each of the four is hidden for a different reason (see `_public_signature`),
and `today` is the one added on the strength of a measurement rather than of a
principle. Membership here is by *name*, across every tool, which is only
right for a name that means the same thing everywhere: `ledger`, `db` and
`visuals` are this package's own plumbing, and `today` is the clock on both
tools that take one. A knob that is internal to one tool but would be a
legitimate argument on another belongs in that tool's own
`fact_tool(hidden_args=...)` instead — see `web_search`'s `max_results`.

`visuals` joins on the plumbing criterion, not the measurement one: it is this
turn's `VisualBuffer`, the same object with the same meaning wherever it
appears, and a model that could pass its own would be handing `render_visual`
something that is not a buffer at all."""


def _public_signature(fn: Any) -> inspect.Signature:
    """The signature the model should see — every real args, none of ours.

    Every tool in `agent/tools/` takes keyword-only `ledger` and `db` after
    its real parameters (`agent/tools/base.py`'s `fact_tool` preserves the
    wrapped function's signature via `functools.wraps`, so `inspect.signature`
    resolves to the real one, not `(*args, **kwargs)`). Exposing those to the
    LLM would let it pass its own `ledger` — which could never be a real
    `EvidenceLedger` and would either crash the tool call or, worse, silently
    produce a fact bundle with no ledger entry, i.e. an uncitable claim.

    **CP73 adds `today` to that list, on the strength of a live trace.**
    `resolve_context` and `get_season_state` both take an optional `today`
    that overrides the clock; `tools/context.py`'s docstring is explicit that
    it exists "for tests and for replaying a past conversation". Because it
    was a real parameter it appeared in the tool's JSON schema, and in CP73's
    reproduction of "Compare Norris and Verstappen this year" the model
    supplied one: `get_season_state` came back reporting today as 2025-11-03
    when the real date was 2026-08-07, and the turn then spent four further
    tool calls re-reading the wrong season before exhausting its step budget.
    The clock is the one fact §5.3 says a model demonstrably does not have,
    so letting it assert one is handing back the exact thing the tool was
    built to supply. Removing the parameter from the schema makes that
    impossible rather than forbidden — the CP38/CP41/CP44 rule again, applied
    to an argument instead of to an output.

    **CP73 fixed `today` and stopped there; the audit it asked for is what
    added `hidden_args`.** `ROADMAP.md`'s Batch 20 findings close that bullet
    with "worth auditing other tools for optional arguments the model can see",
    and the audit found one more: `web_search`'s `max_results`. Every other
    optional argument in this package turned out to be a real question-shaped
    choice (`session`, `kind`, `after_round`, `season`, `drivers`, the five
    `get_historical_race_index` filters, `topic`) — the model *should* pick
    those, and the prompts and tool descriptions tell it how. A per-tool set
    beaten into the global name list above would have been the wrong shape:
    `max_results` is internal to `web_search` alone and would be a perfectly
    legitimate argument on a tool that grows one later.
    """
    sig = inspect.signature(fn)
    hidden = _HIDDEN_ARGS | frozenset(getattr(fn, "hidden_args", ()))
    kept = [p for name, p in sig.parameters.items() if name not in hidden]
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


def _bind_tool(
    tool_name: str,
    fn: Any,
    ledger: EvidenceLedger,
    visuals: "VisualBuffer | None" = None,
) -> StructuredTool:
    """Bind one tool to this turn's run state.

    `ledger` goes to every tool unconditionally — every tool in this package
    takes one. `visuals` is passed **only to the tools that declare it**, which
    today is `render_visual` alone. Injecting it unconditionally would break
    every other tool's signature, and adding an ignored `**_` to eighteen
    functions to make one injection uniform is the wrong direction: the
    parameter list is the declaration of what a tool needs, and reading it is
    cheaper than maintaining a second table saying the same thing.
    """
    sig = _public_signature(fn)
    args_model = _args_model(tool_name, sig)
    wants_visuals = "visuals" in inspect.signature(fn).parameters

    async def _call(**kwargs: Any) -> dict:
        if wants_visuals:
            return await fn(**kwargs, ledger=ledger, visuals=visuals)
        return await fn(**kwargs, ledger=ledger)

    _call.__name__ = tool_name
    return StructuredTool.from_function(
        coroutine=_call,
        name=tool_name,
        description=_tool_description(fn, tool_name),
        args_schema=args_model,
    )


def build_tools(
    ledger: EvidenceLedger, visuals: "VisualBuffer | None" = None
) -> list[StructuredTool]:
    """Bind every CP60 tool to one request's ledger.

    `tools/__init__.py`'s `TOOLS` registry exists precisely so this binding
    step can live here, outside the tool layer — CP60's docstring says so
    directly: "`TOOLS` is the registry CP61 binds." The tool layer stays
    importable and unit-testable without LangChain at all.
    """
    return [_bind_tool(name, fn, ledger, visuals) for name, fn in TOOLS.items()]


def build_tool_subset(
    ledger: EvidenceLedger,
    names: "tuple[str, ...] | list[str]",
    visuals: "VisualBuffer | None" = None,
) -> list[StructuredTool]:
    """Bind a named subset of `TOOLS` — CP63's subagents each see only theirs.

    A `KeyError` here means a subagent's tool list in `subagents.py` names a
    tool that does not exist in the registry — a wiring bug worth failing
    loudly on at startup, not silently dropping the way a tool's own
    `unavailable()` failures do at call time (`tools/base.py`'s contract is
    about *data* being unavailable, not about *code* being wrong).
    """
    return [_bind_tool(name, TOOLS[name], ledger, visuals) for name in names]


# --- System prompt -----------------------------------------------------------

_VISUAL_RULE = """
Drawing a chart — the `render_visual` tool:

You may draw ONE picture (at most two) per answer with `render_visual`. You
write the drawing code; the backend attaches the numbers from the evidence
bundle you name, so a chart can only ever show data you actually retrieved.

Default to offering one. If the evidence bundle you retrieved has more than
one comparable value in it — a ranking, a set of rounds, a series across laps
or seasons, a head-to-head, anything with more than one row or point — draw
it. The picture and the prose are not alternatives; give both. Answer the
question in words first, the way you always do, and let the chart follow: it
renders asynchronously below your answer, so it is fine for it to still be
loading when your prose is already on the screen — that is the normal case,
not a problem to avoid.

The two real reasons to skip the chart: the bundle is a single scalar with
nothing to compare it to (one lap time, one fact, one status — there is no
second point to plot), or you already drew two pictures for this answer.
"The prose already answers it" is not a reason — that is true of every
chart-worthy answer too, and answering in words is not a substitute for
showing the shape of the data behind that answer.

A small Markdown table is still worth adding ALONGSIDE a chart, or instead of
one, when the reader is likely to want to read off exact values row by row —
a table and a picture answer different questions about the same data, and
either or both may be worth giving.

Call it only AFTER the tool call whose data you want to draw, and pass that
result's `evidence_id`. Never invent an id, and never put numbers in your code
— read everything from the `data` argument. If you write a number as a literal
it is not evidence-backed and it does not belong in the picture.

`code` is an ES module with one default export:

    export default function render({ data, apex, mount, width }) { ... }

`data` is the evidence bundle's data, verbatim. `mount` is an empty <div>
already on the page. `width` is the frame's content width in CSS pixels.
`render` is called on load and again on every resize, so clear or rebuild
`mount` each time.

`apex` is a ready-made runtime — you have no imports and no network, so
everything you need is on it:
- `apex.tokens` — the site's colours and fonts (`primary`, `ember`, `flame`,
  `warm100`…`warm600`, `veil`, `background`, `error`, radii, font stacks)
- `apex.teamColor(name)` — `{hex, glow}` for an F1 team
- `apex.scaleLinear({domain, range})`, `apex.scaleBand({domain, range, padding})`
- `apex.ticks(min, max, count)` — nice tick values
- `apex.el(tag, attrs, children)`, `apex.svg(tag, attrs, children)`
- `apex.axis({...})`, `apex.gridlines({...})`
- `apex.legend(items)`, `apex.tooltip(...)`
- `apex.fmt.lapTime / gap / delta / ordinal / points / date`
- `apex.animate(el, keyframes, opts)` — respects reduced-motion
- `apex.panel(...)`, `apex.caption(...)` — the glass surface and caption chrome

Rules your code must follow:
- No `import` and no `require` — everything is on `apex`.
- No network calls, no timer longer than 5 seconds, no `while (true)`.
- Render something for EVERY shape `data` can take, including empty or
  `available: false`. Guard before you index — a thrown error shows the reader
  a failure box instead of a chart.
- Respect `width` and reflow with it. No fixed pixel width above 640.
- Use `apex.tokens` colours for all text, so it stays legible on a dark ground.

The tool replies `{"ok": true, "visual_id": ...}` when it worked — that means
the picture is on its way, so do not call it again for the same chart. If it
replies `{"ok": false, "reason": ...}`, fix what the reason names or drop the
chart and answer in prose. Never mention the tool, the chart or its absence in
your answer text; the picture appears under the answer on its own.
"""
"""The `render_visual` half of the prompt — `CHAT-VISUALS-CONTRACT.md` §2/§3.

Appended to both `SYSTEM_PROMPT` and `ORCHESTRATOR_SYSTEM_PROMPT` rather than
written into each, for `subagents._NO_FILESYSTEM_RULE`'s reason: a rule that
must be identical on two prompts drifts the moment it is stated twice.

Two things in here are prompt-only and cannot be enforced in code, which is
why they are stated so plainly. §7's second row is explicit that a model
writing data *literals* instead of reading `data` "cannot be prevented" — the
guarantee this feature offers is that anything read out of `data` is the
ledger's, not that every pixel is. And "do not mention the chart in your
answer" exists because the visual is placed below the prose (§5), so an answer
that says "as the chart above shows" is wrong about its own layout — an
inline-marker scheme is deliberately out of scope for this slice (§8)."""

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
- To compare TWO drivers over a season, call `get_head_to_head` ONCE. It
  takes their names and defaults to the current season, and it returns the
  whole comparison — both drivers' standings, points, wins, podiums and
  finishing records plus the race and qualifying duel counts. Never build
  that comparison out of two `get_driver_season_summary` calls, and never
  follow a successful `get_head_to_head` with another tool call to
  "check" it.
- When a tool has already returned the facts the question asked for, STOP
  and write the answer. Re-reading the same season through a different tool
  does not make an answer more certain; it spends the step budget that would
  have let you finish.
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
""" + _VISUAL_RULE

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
answer. You have exactly two data tools of your own:

- `resolve_context` — call this FIRST whenever the question has a vague
  reference ("the last race", "he", a nickname, "this season") to turn it
  into a concrete year/round/driver id before delegating. A subagent cannot
  resolve ambiguity you handed it unresolved.
- `get_season_state` — call this when the question depends on today's date
  or "the next race" / "how the season stands".

You also hold `render_visual` (below), because you are the one that writes
the answer — a subagent returns findings, not prose to illustrate.

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
""" + _VISUAL_RULE

ORCHESTRATOR_TOOLS = ("resolve_context", "get_season_state", "render_visual")
"""The tier-3 orchestrator's own direct tools.

The first two are CP63's; `render_visual` is the third and it belongs here
rather than in a subagent's list. Drawing is a *presentation* decision about
the finished answer, and on this path the orchestrator is the only thing that
sees one — a subagent returns findings, not the answer. It works because the
ledger is shared across the whole turn (`build_subagents(ledger)`), so an
`[ev_N]` a subagent retrieved and quoted back is an id the orchestrator can
hand straight to `render_visual` and have resolve.

Named as a constant rather than written inline in `build_agent` so
`test_agent_subagents.py`'s "every grouping names a real tool" check and any
future audit can read it the same way they read the subagent groupings."""


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


HARNESS_PROFILE_KEY = "ollama"
"""The registry key `_register_harness_profile` writes under. See its docstring
for why this is the provider and not `config.DEFAULT_MODEL`."""

EXCLUDED_BUILTIN_TOOLS = frozenset(
    {"ls", "glob", "grep", "write_file", "edit_file", "delete", "execute"}
)
"""deepagents' filesystem built-ins, withheld from every model request.

**`read_file` is deliberately absent from this set — it is the one built-in
kept.** Two independent reasons, both checked in the installed 0.7.4 source
rather than assumed:

1. `SummarizationMiddleware` (added unconditionally to the main stack *and* to
   every subagent stack, `deepagents/graph.py`'s "Build main agent middleware
   stack" and the subagent loop above it) offloads evicted conversation history
   to `/conversation_history/{thread_id}.md` and embeds that path in the summary
   "so the agent can re-open it via `read_file`". Excluding it would delete the
   only recovery path for a long turn's evicted context.
2. `FilesystemMiddleware` rejects a tool allowlist that omits `read_file`
   outright — "read_file must be included in tools; it is required by
   `FilesystemMiddleware`". deepagents treats it as scaffolding, not as a
   convenience.

**Keeping it costs nothing, because reading is not what went wrong.** Both
recorded incidents were *discovery* — CP61's baseline probing with `ls`/`grep`,
and CP63's `web-researcher` reaching for `ls` then `glob` after an empty search.
`read_file` alone cannot enumerate anything: with `ls`, `glob` and `grep` gone
the model can only read a path it was explicitly handed, which in this
configuration is the summarization path and nothing else. The default backend
is `StateBackend` — an in-state virtual filesystem — and `build_agent`
constructs a fresh graph per request, so at the start of every turn there is
genuinely nothing there.

`execute` is listed and is currently redundant: it is gated on the backend
implementing `SandboxBackendProtocol`, which `StateBackend` does not, so
deepagents already withholds it (confirmed by inspecting the tools actually
bound to the model — `execute` is registered as a handler but never offered).
It is named anyway so that swapping the backend later cannot silently hand this
agent a shell. `task` is *not* listed: tier 3 is built on it, and it is already
handled correctly one level up by disabling the general-purpose subagent."""

_harness_profile_registered = False


def _register_harness_profile() -> None:
    """Turn off deepagents' auto-added `general-purpose` subagent and its
    filesystem built-ins, once.

    **The defect.** `create_deep_agent` inserts a default `general-purpose`
    subagent — and therefore the `task` tool — whenever the caller has not
    supplied one (`deepagents/graph.py`'s "Auto-add the default general-purpose
    subagent" branch). Neither CP61 nor CP63 disabled it, so the *flat* graph,
    which is given no subagents at all and whose prompt never mentions
    delegation, still shipped a `task` tool pointed at a clone of itself.
    CP63's trace of "Compare Norris and Verstappen this season" caught it being
    used: `"Delegating to general-purpose"` at 80.3s, after which the clone
    re-ran `resolve_context` and `get_driver_season_summary` — calls the
    orchestrator already had bound directly. That run took 125.7s against
    CP61's 50.9s baseline for the same question. (Both numbers are CP63's, in
    `HANDOFF.md`; nothing here re-measures latency.)

    **The API is real, but it is not a `create_deep_agent` argument.** The
    setting `HANDOFF.md` names —
    `general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False)` —
    exists verbatim in the installed deepagents (0.7.4) and is exported from
    the package root. What does not exist is a `profile=` parameter to pass it
    through: `create_deep_agent` resolves its profile from a process-global
    registry keyed by model (`_harness_profile_for_model`), so the only way to
    set it is `register_harness_profile`. This is checked against the installed
    source rather than assumed, per the `qwen3.5:35b` lesson.

    **Why the key is `"ollama"` and not the model name.** For a pre-built model
    instance (which `build_model` returns), deepagents derives the lookup key
    itself, and it deliberately *skips* the composite `provider:identifier`
    probe when the identifier already contains a colon — to avoid building a
    double-colon key. Our identifier is `nemotron-3-nano:30b`, which contains
    one, so deepagents instead reads that string as a `provider:model` pair and
    looks for a provider called `nemotron-3-nano` before falling through to the
    real provider, `ollama`. A registration under `config.DEFAULT_MODEL` would
    also match today, but the provider key is the one that survives `AGENT_MODEL`
    being repointed, and a model-specific profile registered later merges *over*
    a provider-level one field-wise rather than replacing it, so this stays in
    force unless something explicitly sets `enabled=True`.

    **What this does and does not remove.** On the flat path (no subagents) the
    `task` tool disappears entirely — deepagents drops it when no synchronous
    subagent remains. On the tier-3 path the four subagents in `subagents.py`
    keep `task` alive, which is the point of that path; what goes is
    `general-purpose` as a delegation target, so the orchestrator can no longer
    hand a question to an unnamed clone of itself. `test_agent_graph.py` asserts
    both by inspecting the built graph, not by checking that this ran.

    **The no-filesystem rule is now structural, and the prompts keep saying it
    anyway.** `SYSTEM_PROMPT`, `ORCHESTRATOR_SYSTEM_PROMPT` and
    `subagents._NO_FILESYSTEM_RULE` all still tell the model to ignore `ls`,
    `glob` and the rest. **Those sentences are no longer the mechanism** — this
    registration is, and `EXCLUDED_BUILTIN_TOOLS` is where the list lives.
    They are kept because they cost nothing and they document the intent for a
    reader, but nobody should read them as the enforcement: `HANDOFF.md`
    records the prompt rule being written twice and failing twice (CP61's
    baseline wandered into `ls`/`grep` and burned its step budget; CP63's first
    live `web-researcher` test called `web_search`, got an empty result, then
    tried `ls` and `glob`), which is the CP38/CP41 "don't ask the model nicely"
    lesson landing on tool *availability* rather than on output.

    **The exclusion reaches the subagents for free, which is the half CP63
    needed.** A subagent spec that does not set its own `"model"` inherits the
    orchestrator's (`spec.get("model", model)`), and its profile is then
    resolved from that same model — so all four of `subagents.py`'s specs
    resolve to this registration and each gets its own
    `_ToolExclusionMiddleware`. Nothing in `subagents.py` had to change.

    Registration is global process state, hence the once-only flag: it is
    additive/merging rather than idempotent-by-assignment, and there is no
    reason to redo the merge on every request.

    **One mechanical difference between the two settings, worth knowing before
    writing an assertion about either.** Disabling the general-purpose subagent
    removes `task` from the graph *entirely* — it is absent from the `tools`
    node's registry. `excluded_tools` works later and differently: the tool
    handlers stay registered, and `_ToolExclusionMiddleware` filters them out
    of every model request (`wrap_model_call`). So the filesystem exclusions are
    invisible to a `tools_by_name` check and only show up in the tool list
    actually bound to the model, which is what `test_agent_graph.py` inspects.
    """
    global _harness_profile_registered
    if _harness_profile_registered:
        return

    from deepagents import (
        GeneralPurposeSubagentProfile,
        HarnessProfile,
        register_harness_profile,
    )

    register_harness_profile(
        HARNESS_PROFILE_KEY,
        HarnessProfile(
            general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False),
            excluded_tools=EXCLUDED_BUILTIN_TOOLS,
        ),
    )
    _harness_profile_registered = True


def build_agent(
    ledger: EvidenceLedger,
    *,
    use_subagents: bool = False,
    checkpointer: Any | None = None,
    visuals: VisualBuffer | None = None,
):
    """One `create_deep_agent` graph.

    `use_subagents=False` (the default) is CP61's exact proven flat graph —
    every CP60 tool bound directly, no subagents. `use_subagents=True` is
    CP63's addition: a slim orchestrator holding only `ORCHESTRATOR_TOOLS`
    that delegates everything else via `task()` to the four subagents in
    `subagents.py`. `astream_answer` decides which shape to
    build per turn from `router.classify` — this function itself stays
    agnostic to *why*, so it is testable without importing the router.

    `_register_harness_profile` runs first on both paths — it is what removes
    the default `general-purpose` subagent and withholds the filesystem
    built-ins from every model request, on the orchestrator and on all four
    subagents alike (see its docstring). Registering here rather than at module
    import keeps `deepagents` a lazy import: `tools/` and this module's
    tool-binding half stay testable without a LangGraph import at all.
    """
    from deepagents import create_deep_agent

    _register_harness_profile()

    if not use_subagents:
        return create_deep_agent(
            model=build_model(),
            tools=build_tools(ledger, visuals),
            system_prompt=SYSTEM_PROMPT,
            checkpointer=checkpointer,
        )

    from .subagents import build_subagents

    return create_deep_agent(
        model=build_model(),
        tools=build_tool_subset(ledger, ORCHESTRATOR_TOOLS, visuals),
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
`("visual", payload)` — one `sse.visual` payload, yielded after the last token
and before the generator ends, so `main.py` puts it on the wire between the
answer and `sources` exactly as `CHAT-VISUALS-CONTRACT.md` §4 requires —
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
    "resolve_context": "hint",
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

    # One buffer per turn, created here beside the ledger and for the same
    # reason `main.py` creates the ledger per turn: two overlapping requests
    # must never see each other's state, and a turn's visuals are as
    # request-scoped as its evidence. Created here rather than in `main.py`
    # because nothing outside this function needs to hold it — the frames go
    # out as ordinary `AgentEvent`s below, so `main.py` learns about visuals
    # the same way it learns about tokens.
    visuals = VisualBuffer()
    agent = build_agent(
        ledger,
        use_subagents=route.use_subagents,
        checkpointer=checkpointer,
        visuals=visuals,
    )
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

            # `CHAT-VISUALS-CONTRACT.md` §4: after the last `token`, before
            # `sources`. Draining here rather than at the point of the tool
            # call is what makes that ordering structural — `main.py` turns
            # these into frames in the order it receives them, and `sources`
            # is only assembled once this generator is exhausted, so there is
            # no sequencing rule for a future edit to get wrong.
            #
            # Drained after the repair loop, so a visual survives a rewrite of
            # the prose. That is the right call for this feature specifically:
            # a visual is a function of `(code, data)` and never of the draft,
            # so a redrafted answer does not invalidate a chart drawn from
            # evidence the redraft still cites. The cap counts across both
            # runs, so a repair cannot smuggle in a third.
            for payload in visuals.frames():
                yield ("visual", payload)

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
        # Announced before the tokens so `main.py` knows this turn produced a
        # degrade rather than an answer *before* it decides whether to cache.
        # Found in production: this path streams as ordinary tokens, so the
        # cache could not tell it apart from a real answer and stored it under
        # the question's key — turning one transient step-budget exhaustion
        # into a permanent wrong answer. CP73 fixed the underlying stall for
        # comparative questions and the fix was invisible in production,
        # because the failed pre-fix answer was still being replayed from
        # cache. A failure is not an answer and must never be cached.
        yield ("degraded", "budget_exhausted")
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
