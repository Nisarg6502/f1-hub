"""CP59 tool-calling reliability spike.

Measures whether a candidate Ollama Cloud model can actually drive this
system's tool layer, instead of inheriting a verdict from a benchmark table.
`CHAT-AGENT-PLAN.md` §4.2 names this as the riskiest assumption in the batch:
a ~30b model doing nested `task()` dispatch. If no candidate passes T5, the
plan says Batch 18's subagent layer is not built and CP61's single-agent
baseline ships instead — so this script's output is a real decision input, not
a formality.

Run it directly (needs `OLLAMA_API_KEY`):

    cd backend && python -m agent.spikes.model_spike
    cd backend && python -m agent.spikes.model_spike --models gemma4:31b

Free-tier constraint: Ollama Cloud allows **1 concurrent model**, so every
call here is strictly sequential. Do not parallelise this file — requests past
the concurrency limit are queued to a fixed depth and then rejected, which
would score a model as broken when it was only unlucky.

The battery is ordered by how much it costs us if it fails:

    T1  single tool call            can the model call a tool at all
    T2  argument correctness        does it fill required params correctly
    T3  multi-turn continuation     does it consume a tool result and stop
    T4  selection among 16 tools    does it pick the right one from a real-size
                                    catalogue, not a plausible neighbour
    T5  nested `task()` dispatch    the deepagents assumption
    T6  restraint (out of domain)   does it decline instead of tool-calling

Scores are pass/fail per test plus wall-clock latency. Latency is recorded
because free-tier usage meters GPU time, not tokens (§4.2), so a slow model is
literally a more expensive model.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

OLLAMA_BASE = "https://ollama.com"

# The catalogue was probed live on 2026-08-05 (`GET /api/tags`). The plan's
# primary candidate `qwen3.5:35b` and its cheaper sibling `qwen3.5:27b` are
# NOT in it — the only Qwen on Ollama Cloud is `qwen3.5:397b`, a level-4 model
# the plan's own budget logic excludes. These are the level-1/2 models that
# actually exist, plus gpt-oss:120b as a known-quantity control (CP38's recaps
# already run on it, so its quota behaviour is understood).
DEFAULT_CANDIDATES = [
    "gemma4:31b",
    "nemotron-3-nano:30b",
    "gpt-oss:20b",
    "gpt-oss:120b",
]


def _load_api_key() -> str:
    key = os.getenv("OLLAMA_API_KEY")
    if key:
        return key
    # Fall back to the repo-root .env, the same place session_recap.py's key
    # comes from in local dev.
    env_path = Path(__file__).resolve().parents[3] / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("OLLAMA_API_KEY="):
                return line.split("=", 1)[1].strip()
    raise SystemExit("OLLAMA_API_KEY is not set and was not found in .env")


def _chat(model: str, messages: list[dict], tools: list[dict] | None, api_key: str,
          timeout: float = 180.0) -> tuple[dict, float]:
    """One non-streaming chat turn. Returns (message, elapsed_seconds).

    Non-streaming on purpose: the spike measures tool-call structure, and a
    buffered response is the simplest correct way to read `tool_calls`.
    """
    payload: dict = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"temperature": 0.0},
    }
    if tools:
        payload["tools"] = tools

    request = urllib.request.Request(
        f"{OLLAMA_BASE}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.load(response)
    return body.get("message") or {}, time.monotonic() - started


def _tool_calls(message: dict) -> list[tuple[str, dict]]:
    """Normalise tool calls to (name, args).

    Ollama returns `arguments` as an object; OpenAI-compatible clients return
    it as a JSON string. CP44's lesson — never build on a *documented* output
    shape — applies to model APIs too, so both are accepted and anything
    unparseable is surfaced as `{}` rather than crashing the spike.
    """
    out: list[tuple[str, dict]] = []
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        name = function.get("name") or ""
        raw = function.get("arguments")
        if isinstance(raw, str):
            try:
                args = json.loads(raw)
            except json.JSONDecodeError:
                args = {}
        elif isinstance(raw, dict):
            args = raw
        else:
            args = {}
        out.append((name, args))
    return out


# --------------------------------------------------------------------------
# Tool definitions. These mirror the real CP60 catalogue's *shape* (fact-bundle
# tools with resolved ids, never raw documents) so the spike measures the model
# against the tools it will actually be given.
# --------------------------------------------------------------------------

def _tool(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


GET_SESSION_RESULT = _tool(
    "get_session_result",
    "Final classification for one session of one race weekend.",
    {
        "year": {"type": "integer", "description": "Season year, e.g. 2026"},
        "round": {"type": "integer", "description": "Round number within the season"},
        "session": {
            "type": "string",
            "enum": ["race", "qualifying", "sprint"],
            "description": "Which session",
        },
    },
    ["year", "round", "session"],
)

GET_STANDINGS = _tool(
    "get_standings",
    "Championship standings table after a given round.",
    {
        "year": {"type": "integer"},
        "kind": {"type": "string", "enum": ["drivers", "constructors"]},
    },
    ["year", "kind"],
)

RESOLVE_CONTEXT = _tool(
    "resolve_context",
    "Resolve a vague reference such as 'the last race' or a driver nickname "
    "into concrete ids. ALWAYS call this before any tool that needs a round "
    "number or driver_id you were not given explicitly.",
    {"hint": {"type": "string", "description": "The phrase to resolve"}},
    ["hint"],
)

# A 16-tool catalogue, matching the real one's size, for T4. Selection pressure
# is the point: a model that picks correctly from 3 tools tells us nothing
# about how it behaves against the catalogue we are actually shipping.
CATALOGUE = [
    GET_SESSION_RESULT,
    GET_STANDINGS,
    RESOLVE_CONTEXT,
    _tool("get_season_calendar", "Rounds, dates and circuits for a season.",
          {"year": {"type": "integer"}}, ["year"]),
    _tool("get_driver_profile", "Biography and career totals for one driver.",
          {"driver_id": {"type": "string"}}, ["driver_id"]),
    _tool("get_driver_season_summary",
          "Wins, podiums, points, average finish and qualifying head-to-head "
          "for one driver in one season.",
          {"driver_id": {"type": "string"}, "year": {"type": "integer"}},
          ["driver_id", "year"]),
    _tool("get_head_to_head", "Computed pairwise comparison of two drivers.",
          {"driver_a": {"type": "string"}, "driver_b": {"type": "string"},
           "scope": {"type": "string"}}, ["driver_a", "driver_b"]),
    _tool("get_race_narrative_facts",
          "Podium, biggest movers, retirements, closest gap and teammate "
          "results for one race.",
          {"year": {"type": "integer"}, "round": {"type": "integer"}},
          ["year", "round"]),
    _tool("get_race_strategy",
          "Tyre stints, pit stops and undercut/overcut resolution for one race.",
          {"year": {"type": "integer"}, "round": {"type": "integer"}},
          ["year", "round"]),
    _tool("get_race_control",
          "Penalties, safety cars and stewards' decisions for one race.",
          {"year": {"type": "integer"}, "round": {"type": "integer"}},
          ["year", "round"]),
    _tool("get_lap_summary", "Downsampled lap-by-lap position and pace summary.",
          {"year": {"type": "integer"}, "round": {"type": "integer"}},
          ["year", "round"]),
    _tool("get_pit_stops", "Pit stop table for one race.",
          {"year": {"type": "integer"}, "round": {"type": "integer"}},
          ["year", "round"]),
    _tool("get_weather", "Track and air conditions for one race weekend.",
          {"year": {"type": "integer"}, "round": {"type": "integer"}},
          ["year", "round"]),
    _tool("get_circuit_profile",
          "Layout, length, corner count and elevation change for one circuit.",
          {"circuit_id": {"type": "string"}}, ["circuit_id"]),
    _tool("get_circuit_history",
          "Past winners, lap records and era spans for one circuit, 1950-2026.",
          {"circuit_id": {"type": "string"}}, ["circuit_id"]),
    _tool("get_historical_race_index",
          "Wins and podiums aggregated across the whole 1950-2026 archive.",
          {"driver_id": {"type": "string"}, "constructor_id": {"type": "string"},
           "circuit_id": {"type": "string"}}, []),
]

TASK_TOOL = _tool(
    "task",
    "Delegate a research job to a specialist subagent. You have NO data tools "
    "of your own — every fact must come back through this. Subagents: "
    "'stats-scout' (current and recent seasons: results, standings, laps, "
    "pits, weather, circuits), 'historian' (the 1950-2026 archive), "
    "'race-analyst' (strategy, comparisons, derived reasoning).",
    {
        "subagent": {
            "type": "string",
            "enum": ["stats-scout", "historian", "race-analyst"],
        },
        "instructions": {
            "type": "string",
            "description": "A self-contained brief for the subagent.",
        },
    },
    ["subagent", "instructions"],
)


# --------------------------------------------------------------------------
# The battery
# --------------------------------------------------------------------------

ORCHESTRATOR_PROMPT = (
    "You are the Pitwall Assistant, an F1 analyst. You answer ONLY from data "
    "returned by tools — never from memory. Call a tool when you need a fact. "
    "If a question is not about Formula 1, say so and do not call any tool."
)


def t1_single_tool_call(model: str, api_key: str) -> tuple[bool, str, float]:
    message, elapsed = _chat(
        model,
        [
            {"role": "system", "content": ORCHESTRATOR_PROMPT},
            {"role": "user", "content": "Who won round 14 of the 2026 season?"},
        ],
        [GET_SESSION_RESULT, GET_STANDINGS],
        api_key,
    )
    calls = _tool_calls(message)
    if not calls:
        return False, "no tool call emitted", elapsed
    name, args = calls[0]
    if name != "get_session_result":
        return False, f"called {name}", elapsed
    return True, f"get_session_result({args})", elapsed


def t2_argument_correctness(model: str, api_key: str) -> tuple[bool, str, float]:
    message, elapsed = _chat(
        model,
        [
            {"role": "system", "content": ORCHESTRATOR_PROMPT},
            {"role": "user",
             "content": "Show me the qualifying classification for round 9 of 2025."},
        ],
        [GET_SESSION_RESULT, GET_STANDINGS],
        api_key,
    )
    calls = _tool_calls(message)
    if not calls:
        return False, "no tool call emitted", elapsed
    name, args = calls[0]
    if name != "get_session_result":
        return False, f"called {name}", elapsed
    expected = {"year": 2025, "round": 9, "session": "qualifying"}
    wrong = {k: args.get(k) for k, v in expected.items() if args.get(k) != v}
    if wrong:
        return False, f"wrong args {wrong} (got {args})", elapsed
    return True, f"exact args {args}", elapsed


def t3_multi_turn_continuation(model: str, api_key: str) -> tuple[bool, str, float]:
    """Feed a tool result back and check the model consumes it and stops.

    The failure this catches is the expensive one on a GPU-time budget: a model
    that re-calls the same tool instead of using the result it already has.
    """
    messages = [
        {"role": "system", "content": ORCHESTRATOR_PROMPT},
        {"role": "user", "content": "Who won round 14 of the 2026 season?"},
    ]
    message, first = _chat(model, messages, [GET_SESSION_RESULT, GET_STANDINGS], api_key)
    calls = _tool_calls(message)
    if not calls:
        return False, "no tool call on turn 1", first

    messages.append({
        "role": "assistant",
        "content": message.get("content") or "",
        "tool_calls": message.get("tool_calls") or [],
    })
    messages.append({
        "role": "tool",
        "content": json.dumps({
            "data": {"winner": "Lando Norris", "team": "McLaren",
                     "margin_s": 3.4, "runner_up": "Max Verstappen"},
            "evidence_id": "ev_1",
            "source": "mongo:race_results/2026-14",
            "as_of": "2026-08-05T09:00:00Z",
        }),
    })
    message2, second = _chat(model, messages, [GET_SESSION_RESULT, GET_STANDINGS], api_key)
    elapsed = first + second

    if _tool_calls(message2):
        return False, "re-called a tool instead of answering", elapsed
    text = (message2.get("content") or "").lower()
    if "norris" not in text:
        return False, f"answer ignored the tool result: {text[:120]!r}", elapsed
    return True, "consumed tool result and answered", elapsed


def t4_selection_among_sixteen(model: str, api_key: str) -> tuple[bool, str, float]:
    message, elapsed = _chat(
        model,
        [
            {"role": "system", "content": ORCHESTRATOR_PROMPT},
            {"role": "user",
             "content": "Why did Ferrari pit so early in round 12 of 2026?"},
        ],
        CATALOGUE,
        api_key,
    )
    calls = _tool_calls(message)
    if not calls:
        return False, "no tool call emitted", elapsed
    names = [name for name, _ in calls]
    # get_race_strategy is the intended pick; get_pit_stops is a defensible
    # neighbour and scores as a pass. Anything else is a selection failure.
    if not ({"get_race_strategy", "get_pit_stops"} & set(names)):
        return False, f"picked {names}", elapsed
    _, args = calls[0]
    if args.get("year") != 2026 or args.get("round") != 12:
        return False, f"right tool {names[0]}, wrong args {args}", elapsed
    return True, f"{names[0]}({args})", elapsed


def t5_nested_dispatch(model: str, api_key: str) -> tuple[bool, str, float]:
    """The deepagents assumption: delegate rather than answer from memory.

    The orchestrator holds no data tools by design (§3, L2), so the only
    correct move is a `task()` dispatch. A model that answers directly here
    would, in production, be inventing facts.
    """
    message, elapsed = _chat(
        model,
        [
            {"role": "system", "content": ORCHESTRATOR_PROMPT + (
                " You are the orchestrator. You hold no data tools. Delegate "
                "every fact-finding job to a subagent with the `task` tool.")},
            {"role": "user",
             "content": "Who has the most wins at Monaco in Formula 1 history?"},
        ],
        [TASK_TOOL],
        api_key,
    )
    calls = _tool_calls(message)
    if not calls:
        return False, "answered without delegating", elapsed
    name, args = calls[0]
    if name != "task":
        return False, f"called {name}", elapsed
    if args.get("subagent") != "historian":
        return False, f"delegated to {args.get('subagent')!r}, expected historian", elapsed
    if not (args.get("instructions") or "").strip():
        return False, "empty instructions", elapsed
    return True, f"task(historian, {str(args.get('instructions'))[:60]!r}…)", elapsed


def t7_multi_hop_dispatch(model: str, api_key: str) -> tuple[bool, str, float]:
    """Three-turn nested loop: dispatch, consume, dispatch again, synthesise.

    T5 only proves the model *chooses* to delegate and formats one call
    correctly. That is not the deepagents assumption. The real question is
    whether a nested loop **converges** — whether the model, handed a partial
    result, fetches the missing half and then stops, rather than re-dispatching
    the job it already has an answer to. A loop that never terminates is the
    expensive failure on a GPU-time budget, and it is invisible to a one-shot
    test.

    The question deliberately needs two different subagents, so a model that
    answers after one dispatch is provably guessing at the other half.
    """
    system = ORCHESTRATOR_PROMPT + (
        " You are the orchestrator. You hold no data tools. Delegate every "
        "fact-finding job to a subagent with the `task` tool. When you have "
        "all the facts you need, answer directly and stop calling tools.")
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": (
            "How many wins did Lando Norris score in 2026, and who holds the "
            "record for most Monaco Grand Prix wins in history?")},
    ]

    # Turn 1 — expect a dispatch to either specialist.
    message, t_a = _chat(model, messages, [TASK_TOOL], api_key)
    calls = _tool_calls(message)
    if not calls or calls[0][0] != "task":
        return False, "turn 1 did not dispatch", t_a
    first_agent = calls[0][1].get("subagent")

    messages.append({
        "role": "assistant",
        "content": message.get("content") or "",
        "tool_calls": message.get("tool_calls") or [],
    })
    # Answer only the half the model actually asked for, so the other half is
    # genuinely still missing rather than merely unstated.
    if first_agent == "historian":
        payload = {"data": {"most_monaco_wins": {"driver": "Ayrton Senna", "wins": 6}},
                   "evidence_id": "ev_1", "source": "mongo:historical_index/monaco"}
    else:
        payload = {"data": {"driver": "Lando Norris", "season": 2026, "wins": 7},
                   "evidence_id": "ev_1", "source": "mongo:session_results/2026"}
    messages.append({"role": "tool", "content": json.dumps(payload)})

    # Turn 2 — expect a dispatch for the *other* half, not a repeat.
    message2, t_b = _chat(model, messages, [TASK_TOOL], api_key)
    calls2 = _tool_calls(message2)
    elapsed = t_a + t_b
    if not calls2:
        return False, f"answered after one dispatch ({first_agent}); the other half was never fetched", elapsed
    second_agent = calls2[0][1].get("subagent")
    if second_agent == first_agent:
        return False, f"re-dispatched to {second_agent} instead of fetching the missing half", elapsed

    messages.append({
        "role": "assistant",
        "content": message2.get("content") or "",
        "tool_calls": message2.get("tool_calls") or [],
    })
    if first_agent == "historian":
        payload2 = {"data": {"driver": "Lando Norris", "season": 2026, "wins": 7},
                    "evidence_id": "ev_2", "source": "mongo:session_results/2026"}
    else:
        payload2 = {"data": {"most_monaco_wins": {"driver": "Ayrton Senna", "wins": 6}},
                    "evidence_id": "ev_2", "source": "mongo:historical_index/monaco"}
    messages.append({"role": "tool", "content": json.dumps(payload2)})

    # Turn 3 — expect termination with both facts present.
    message3, t_c = _chat(model, messages, [TASK_TOOL], api_key)
    elapsed += t_c
    if _tool_calls(message3):
        return False, "did not terminate — dispatched a third time with both facts in hand", elapsed
    text = (message3.get("content") or "").lower()
    missing = [w for w in ("norris", "senna") if w not in text]
    if missing:
        return False, f"final answer dropped {missing}: {text[:120]!r}", elapsed
    return True, f"{first_agent} -> {second_agent} -> synthesised and stopped", elapsed


def t6_restraint(model: str, api_key: str) -> tuple[bool, str, float]:
    message, elapsed = _chat(
        model,
        [
            {"role": "system", "content": ORCHESTRATOR_PROMPT},
            {"role": "user", "content": "What's the weather in Tokyo right now?"},
        ],
        CATALOGUE,
        api_key,
    )
    calls = _tool_calls(message)
    if calls:
        return False, f"tool-called on an out-of-domain question: {calls[0][0]}", elapsed
    return True, "declined without calling a tool", elapsed


BATTERY = [
    ("T1 single tool call", t1_single_tool_call),
    ("T2 argument correctness", t2_argument_correctness),
    ("T3 multi-turn continuation", t3_multi_turn_continuation),
    ("T4 selection among 16", t4_selection_among_sixteen),
    ("T5 nested task() dispatch", t5_nested_dispatch),
    ("T6 restraint (out of domain)", t6_restraint),
    ("T7 multi-hop dispatch loop", t7_multi_hop_dispatch),
]


def run(models: list[str], only: list[str] | None = None, repeat: int = 1) -> dict:
    api_key = _load_api_key()
    report: dict = {}
    battery = [
        (label, test) for label, test in BATTERY
        if not only or any(label.startswith(prefix) for prefix in only)
    ]

    for model in models:
        print(f"\n=== {model} ===", flush=True)
        results = {}
        for label, test in battery:
            # Repeat matters for the dispatch tests specifically: a model that
            # converges once and loops twice is not a model we can ship, and a
            # single run cannot tell those apart. A test counts as passed only
            # if EVERY attempt passes — an intermittent delegation loop burns
            # the quota just as thoroughly as a reliable one.
            attempts = []
            for _ in range(max(1, repeat)):
                try:
                    passed, detail, elapsed = test(model, api_key)
                except urllib.error.HTTPError as error:
                    body = error.read().decode("utf-8", "replace")[:200]
                    passed, detail, elapsed = False, f"HTTP {error.code}: {body}", 0.0
                except Exception as error:  # noqa: BLE001 - a spike must not abort
                    passed, detail, elapsed = False, f"{type(error).__name__}: {error}", 0.0
                attempts.append({"pass": passed, "detail": detail,
                                 "seconds": round(elapsed, 2)})

            wins = sum(1 for a in attempts if a["pass"])
            passed = wins == len(attempts)
            elapsed = sum(a["seconds"] for a in attempts) / len(attempts)
            detail = next(
                (a["detail"] for a in attempts if not a["pass"]), attempts[0]["detail"]
            )
            mark = "PASS" if passed else "FAIL"
            tally = f"{wins}/{len(attempts)}" if len(attempts) > 1 else ""
            print(f"  [{mark}] {label:<30} {elapsed:6.1f}s  {tally:>5} {detail}",
                  flush=True)
            results[label] = {"pass": passed, "detail": detail,
                              "seconds": round(elapsed, 2),
                              "attempts": attempts if len(attempts) > 1 else None}

        passes = sum(1 for r in results.values() if r["pass"])
        total_s = round(sum(r["seconds"] for r in results.values()), 1)
        print(f"  -> {passes}/{len(battery)} passed in {total_s}s total", flush=True)
        report[model] = {
            "results": results,
            "passed": passes,
            "of": len(battery),
            "seconds": total_s,
        }

    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", nargs="*", default=DEFAULT_CANDIDATES,
                        help="Ollama Cloud model tags to test")
    parser.add_argument("--only", nargs="*", default=None,
                        help="Run only these tests, by id prefix, e.g. --only T3 T7")
    parser.add_argument("--repeat", type=int, default=1,
                        help="Run each test N times; it passes only if all N pass")
    parser.add_argument("--json", type=Path, default=None,
                        help="Write the full report to this path")
    args = parser.parse_args()

    report = run(args.models, args.only, args.repeat)

    print("\n=== summary ===")
    ranked = sorted(report.items(), key=lambda kv: (-kv[1]["passed"], kv[1]["seconds"]))
    for model, data in ranked:
        print(f"  {model:<24} {data['passed']}/{data['of']}  {data['seconds']}s")

    if args.json:
        args.json.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
