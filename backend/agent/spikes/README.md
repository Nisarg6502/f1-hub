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
