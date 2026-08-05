# CP59 spikes — measured answers to the plan's open questions

`CHAT-AGENT-PLAN.md` §14 lists three things it deliberately refused to settle by
opinion. These scripts settle them by measurement. Re-run them whenever the
Ollama catalogue changes, the quota resets, or a dependency moves.

```bash
cd backend
python -m agent.spikes.model_spike                     # full battery, all candidates
python -m agent.spikes.model_spike --only T7 --repeat 3  # just the risky one, stability
python -m agent.spikes.checkpointer_spike
```

---

## 1. The catalogue: the plan's primary model does not exist

Probed live on **2026-08-05** via `GET https://ollama.com/api/tags`. The plan
named **`qwen3.5:35b`** as the primary candidate and `qwen3.5:27b` as a cheaper
alternate. **Neither is on Ollama Cloud.** The only Qwen offered is
`qwen3.5:397b` — a level-4 model the plan's own budget logic excludes.

The 18 models actually available:

```
gpt-oss:20b            minimax-m3             mistral-large-3:675b   glm-5.1
deepseek-v4-pro        gemma4:31b             kimi-k2.6              minimax-m2.7
glm-5.2                kimi-k3                gpt-oss:120b           nemotron-3-nano:30b
nemotron-3-ultra       deepseek-v4-flash      deepseek-v4-flash:0731 qwen3.5:397b
nemotron-3-super       kimi-k2.7-code
```

Candidates tested were the level-1/2 models that exist, plus `gpt-oss:120b` as
a known-quantity control — CP38's recaps already run on it, so its quota
behaviour is understood.

## 2. Tool-calling reliability

The battery is in `model_spike.py`; each test's rationale is in its docstring.

| Test | What fails if this fails |
|---|---|
| T1 single tool call | The model cannot drive tools at all |
| T2 argument correctness | `resolve_context` output gets mangled into wrong ids |
| T3 multi-turn continuation | Tool results are ignored and re-fetched |
| T4 selection among 16 | Right question, wrong data source |
| T5 nested `task()` dispatch | The orchestrator invents facts instead of delegating |
| T6 restraint (out of domain) | Every stray question burns quota |
| T7 multi-hop dispatch loop | The delegation loop never converges |

### Round 1 — one-shot battery (T1-T6)

| Model | Score | Total | Notes |
|---|---|---|---|
| `gemma4:31b` | **6/6** | 12.6s | Perfect and fastest |
| `nemotron-3-nano:30b` | **6/6** | 27.7s | Perfect, 2.2× the GPU time |
| `gpt-oss:120b` | 5/6 | 9.1s | Its one failure was an Ollama **HTTP 500**, not a model error — passes on re-run, so effectively 6/6 |
| `gpt-oss:20b` | 4/6 | 26.7s | Emitted `"Qualifying"` against a lowercase enum (T2); picked `get_season_calendar` for a strategy question (T4) |

### Round 2 — the multi-hop loop (T7), 3 runs each

**This inverted the ranking, and it is the whole reason T7 exists.** T5 only
proves a model *chooses* to delegate and formats one call correctly. It says
nothing about whether a nested loop **converges**, which is the actual
deepagents assumption.

| Model | T7 | Detail |
|---|---|---|
| `nemotron-3-nano:30b` | **3/3** | `stats-scout → historian → synthesised and stopped` |
| `gpt-oss:120b` | **3/3** | `stats-scout → historian → synthesised and stopped` |
| `gemma4:31b` | **1/3** | Re-dispatched to a subagent it had already heard back from |

`gemma4:31b` — the model that won every one-shot test — **fails the multi-hop
loop two times in three.** An intermittent delegation loop burns the quota just
as thoroughly as a reliable one, so it is disqualified rather than merely
ranked lower.

### Decision

**Workhorse: `nemotron-3-nano:30b`.** 6/6 one-shot, 3/3 multi-hop, and in the
level-2 class the plan's budget rule requires. Set in `agent/config.py` and in
`cloudbuild-agent.yaml`'s `_AGENT_MODEL`.

**Fallback: `gpt-oss:120b`.** Equally reliable and already proven in production
by CP38's recaps, but a level-3 model — reserve it for tier-3 synthesis if the
quota allows, per the plan's escalation note.

**Consequence for Batch 18: the subagent layer is NOT cancelled.** The plan said
CP63 gets built only if a small model handles nested dispatch reliably. Two
models do, repeatably. CP61 still ships the single-agent baseline first, so the
multi-agent version has a measured number to beat.

### What this does not prove

Stated so it is not over-read later:

- The tools here are **stubs with realistic shapes**, not the real CP60 tools.
  Real payloads are larger and will pressure the context window in ways this
  does not.
- T7 is a **3-turn** loop with hand-fed results. A real deepagents run nests
  deeper and carries a virtual filesystem and summarisation middleware.
- Latency varied widely between runs (`gpt-oss:120b` scored 25.3s then 6.2s on
  the same test). Treat the timings as order-of-magnitude, not as benchmarks.
- Three runs is enough to disqualify `gemma4:31b`, not enough to certify
  `nemotron-3-nano:30b` at any particular reliability rate.

## 3. Checkpointer — usable, but not in the shape the plan expected

`checkpointer_spike.py` resolves the saver's import path across every location
it has plausibly occupied, then does a real write/read round trip against
Atlas — because importing a class proves nothing about whether it works against
a real cluster. Batch 16's #97 was exactly that: code correct against a fake and
rejected by real MongoDB.

Measured **2026-08-05** against `langgraph-checkpoint-mongodb` 0.4.0 /
`langgraph` 1.2.10:

```
[PASS] import: langgraph.checkpoint.mongodb.MongoDBSaver
[PASS] round trip: wrote and read checkpoint 1f19055c-… (cleaned up)
```

The plan's worry was real but resolves differently than it guessed:

- **`AsyncMongoDBSaver` no longer exists.** It was not moved to a new path — it
  was **merged**. The single `MongoDBSaver` class now carries both the sync
  (`put`, `get_tuple`) and async (`aput`, `aget_tuple`, `alist`, `adelete_thread`)
  methods.
- **`from_conn_string` is a *sync* context manager** returning
  `Iterator[MongoDBSaver]`, even though the methods on it are async. Calling it
  with `async with` fails on a bare `__aenter__` AttributeError, which reads
  like a missing dependency rather than a calling-convention mismatch. Use
  `with`, then `await` the methods.

**Verdict: no fallback needed.** CP61 gets real Mongo-backed thread memory; the
hand-rolled thread store the plan held in reserve can stay unbuilt.

## 4. Dependency constraint worth knowing before bumping anything

`langgraph-checkpoint-mongodb` 0.4.0 requires **`pymongo<4.17,>=4.12`**. pymongo
4.17 is out, and pinning to it makes the whole install unsatisfiable with a
resolver error that names only the pin. `requirements-agent.txt` holds
`pymongo[srv]~=4.16.0` for this reason. Check that ceiling before raising it.

(`motor`'s last release is 3.7.1 — it is in maintenance now that pymongo ships
its own async API.)

**Installing the agent stack pulls in `numpy>=2`, which ABI-breaks `pandas`/
`fastf1` in this repo's shared (non-venv) Python install.** `backend/` has no
virtualenv — every checkpoint so far has run against one global Python 3.11
site-packages directory. `pip install -r requirements-agent.txt` upgrades
`numpy` from `1.24.3` to `2.4.6` as a transitive dependency (nothing in
`requirements-agent.txt` pins it directly), and `pandas` compiled against
NumPy 1.x then fails every import with `ValueError: numpy.dtype size
changed, may indicate binary incompatibility` — silently dropping 127 tests
that import `fastf1`/`pandas` transitively (`test_session_results.py` and
four others fail to *load* rather than fail an assertion, so `unittest
discover` reports 444 tests passing and looks green). `pip install "numpy<2"`
immediately afterward restores all 571 pre-CP61 tests. **Anyone installing
`requirements-agent.txt` locally must re-pin `numpy<2` afterward**, or check
`python -m unittest discover tests` reports the full count, not just "OK",
before trusting a green run. This is not yet pinned in
`requirements-agent.txt` itself because the constraint is transitive and
came from *installing* the agent stack, not from any package it lists by
name — worth a follow-up pin if the agent image is ever built without this
repo's exact install order.

## 5. CP61 baseline — the single-agent deep agent, measured

`agent/graph.py` binds all eighteen CP60 tools (the sixteen data tools plus
`resolve_context` and `get_season_state`) directly to one
`create_deep_agent` graph (`nemotron-3-nano:30b`, no subagents, no
verifier). Five real Ollama Cloud calls were spent proving it end to end —
sparingly, per the CP61 brief — through `agent.graph.astream_answer`
directly (not through the deployed Cloud Run service, which was not
redeployed for this checkpoint). Numbers below are wall-clock per turn,
counting each `on_tool_start` as one tool call; every run used exactly one
model round trip cycle per tool call plus one final synthesis call (Ollama
Cloud does not expose a separate token/GPU-time counter per call, so "model
calls" here means LangGraph super-steps through the `model` node, read off
the activity log — see the caveat on this below).

| # | Class | Question | Latency | Tool calls | Evidence | Result |
|---|---|---|---|---|---|---|
| 1 | Point lookup | "Who won the 2024 Monaco Grand Prix?" | 14.2s | 1 (`get_season_calendar`) | 1, cited | Correct. Notable: picked the calendar tool over `get_session_result` — a defensible neighbour (the calendar carries each round's winner) but not the tool a router would likely pick. |
| 6 | Deep history | "Who has the most wins at Monaco in F1 history?" | 12.8s | 1 (`get_circuit_history`) | 1, cited | Correct (Senna, 6) and grounded. |
| 4 | Comparative | "Compare Verstappen and Norris in the 2026 season." | 50.9s | 3 (`get_driver_season_summary`, `get_driver_profile`, `get_standings`) | 1, cited | Answer correct and grounded, but two of three tool calls returned `available: false` (driver-id mismatch) and were silently dropped rather than retried with the resolved id — the model recovered by falling back to `get_standings`, but never called `get_head_to_head`, the tool actually built for this question. |
| 14 | Out-of-domain | "What's the weather in Tokyo right now?" | 12.5s | 0 | 0 | Correct — declined without tool-calling, exactly the T6 spike behaviour. |
| 2 | Aggregate | "How many podiums has Norris had in the 2026 season?" | 13.1s | **0** | **0** | **Wrong in the most important way.** No tool call at all — the model answered "3 podiums" from parametric memory. See below. |

### The one finding that matters most: an ungrounded answer on a tier-2 aggregate, with no verifier to catch it

The class-2 run above is CP61's central result. On the *first* attempt at
this exact question, the model instead spent three tool calls
(`ls`, `grep`, `glob` — deepagents' default filesystem tools, always present
whether or not the system prompt mentions them) probing a virtual filesystem
that holds nothing for an F1 question, taking 64s before finally calling
`get_driver_season_summary` and answering correctly. The system prompt was
then tightened with an explicit "you have no files, ignore `ls`/`grep`/
`glob`/`read_file`/`write_file`/`edit_file`" rule (now in
`graph.py`'s `SYSTEM_PROMPT`) — and on the *second* attempt, the model
stopped calling the filesystem tools, but also stopped calling **any** tool
at all, and answered "3 podiums" outright from memory. Zero evidence
entries, zero citations, a fluent and plausible-sounding number with no
tool call behind it.

This is CP38's exact failure mode — a confident, ungrounded claim — arriving
through a different door than the one CP38 originally found it through. It
is also the strongest evidence in this batch for why CP64's verifier is on
the roadmap and not optional: CP61 was explicitly scoped to ship *without*
one, and this is what "without one" costs in practice, measured rather than
assumed. A prompt rewrite is not the fix — CP41 already established that a
prompt rule can fail even restated in ALL CAPS, and this finding is that
lesson recurring for a different rule ("answer from tool data only") rather
than evidence the rule needs one more sentence. The fix is architectural: a
deterministic check that a claim carrying a number has a matching evidence
entry, which is precisely CP64's job.

### Cost caveat, stated honestly

The GPU-time figures above are wall-clock only — Ollama Cloud's `/api/chat`
response does not surface a per-request GPU-second or dollar figure, so
"cost" here is a proxy (call count × latency), not a metered number. A
production deployment reading real quota burn needs either Ollama's account
usage dashboard or a Cloud Run request-duration metric keyed by model, and
building that is future work, not something five manual runs can produce.

### What CP61 answers about the "real question" — does a ~30b model hold 18 tools in one context?

**Partially, and unevenly by question class.** Point lookups, single-entity
history queries and out-of-domain restraint all worked correctly and cheaply
(1 tool call or 0, one synthesis pass, 12-15s). Comparative questions work
but wander to a plausible-neighbour tool instead of the one actually built
for the question (`get_standings` instead of `get_head_to_head`) and drop
failed tool calls silently rather than recovering with corrected arguments.
Aggregate/count questions are the weak point: the same model that handled
five other questions correctly skipped tool-calling entirely on this one and
fabricated a number. `agent/spikes/README.md` §2's T7 multi-hop score (3/3)
proved the model **can** chain dispatches correctly under controlled,
hand-fed conditions; this checkpoint's finding is that "correctly" is not
"always," and CP61 shipping without a verifier means nothing in production
would have caught the one wrong answer among five. That is the number Batch
18 has to beat: not "does the model work," but "does removing the verifier's
safety net actually cost visible correctness" — measured here as yes, on a
one-in-five sample too small to generalize a rate from, but not too small to
prove the failure mode is real and reachable on ordinary phrasing.
