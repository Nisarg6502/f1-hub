# Batch 22 — abuse prevention, accumulated debt, and the two designed features

Written 2026-08-18, immediately after CP81 (`HANDOFF.md`) shipped the watch-timing
race-start fix. This document is both the batch plan **and the resumption point**:
if a session ends mid-batch, start here.

## Why this batch exists

Two prompts, one session. The user asked what was left to build, and separately
asked whether the chat agent had any protection against misuse. The second
question turned out to have the more urgent answer, so it leads the batch.

**The chat service has no rate limiting of any kind.** `POST /api/chat` and
`POST /api/feedback` are unauthenticated with no per-caller limits. Three things
are routinely mistaken for protection here and none of them are:

- `agent/concurrency.py` is a per-process semaphore of 1. It is a *serialization*
  gate for Ollama's one-concurrent-model free tier — it decides ordering, not how
  much any one caller may consume.
- `--max-instances=1` bounds throughput per second, not per day.
- CORS `allow_origins` is enforced by browsers. `curl` ignores it entirely.

So a single actor with a shell loop can hold the one concurrency slot
indefinitely and burn the whole free-tier GPU quota — the budget this entire
architecture was shaped around (`CHAT-AGENT-PLAN.md` §4.2).

The user's own framing was right and is worth preserving as the design
constraint: **plain IP limiting is not good enough.** IPs are shared behind
CGNAT, so blocking one can block a mobile carrier's worth of users, and they are
trivially rotated with cheap proxies. Anything built here has to assume the
identity is weak.

## CP82 — layered abuse prevention

Every layer must pass; each is independently useful.

| Layer | What | Why it is not redundant |
|---|---|---|
| 1 | **Global daily budget cap**, Mongo-backed | The only layer that actually bounds spend. Every other layer is a fairness refinement; this one is the backstop, so it must hold even when the others degrade. `CHAT-AGENT-PLAN.md` §4.2 deferred exactly this. |
| 2 | **Per-caller token bucket, cost-weighted**, on a composite identity | Fairness between callers. Identity order: signed HttpOnly session token → client IP → subnet (/24 v4, /64 v6) as a coarser *parallel* bucket, so rotating inside a range does not multiply the allowance. Issuing a token is itself limited, so churning identities costs round trips instead of being free. |
| 3 | **Correct client-IP resolution** | The most commonly botched part, and wrong in both directions: `X-Forwarded-For` is partly client-controlled inbound (a naive first-entry read is spoofable), while `request.client.host` is Google's proxy (which would rate-limit every user as one). |
| 4 | **Abuse signals feed cost** | A caller repeatedly tripping the existing `guardrails/` scope/injection/PII checks pays a steeper multiplier. Reuses what is already there; no new detection. |
| 5 | **Kill switch + deliberate failure mode** | `AGENT_RATE_LIMIT_ENABLED` to disable without a redeploy. Per-caller buckets fail *open* (a Mongo blip must not take the feature down); the global cap keeps an in-process fallback so an outage can never uncap spend. |

**Cost is charged in run-cost units, not request counts.** An LLM endpoint's
per-request cost varies enormously — a cached tier-1 lookup against a tier-3
web-research turn is not the same event — and counting requests is the classic
mistake. The service already knows `router.classify`'s tier and whether the
answer cache hit.

**Wire protocol.** `agent/sse.py` says every failure is an SSE `error` event and
never a 4xx/5xx, but read its reasoning: that holds because those failures happen
*after* the response is committed with 200. Rate limiting rejects *before* the
stream commits, so a real HTTP 429 with `Retry-After` is available and is the
standard, intermediary-legible answer. Whichever is chosen, the frontend must
distinguish "you personally are going too fast" from "the service is out of
budget for today" — they are different messages to a user.

Also folded in: **server-side feedback vote dedupe**, currently an
accepted-but-unproven risk (`HANDOFF.md` CP69 — `uuid.uuid5` on the hope that
LangSmith upserts on id collision, never confirmed).

## CP83 — verified-open agent-service debt

- **The auto-added `general-purpose` subagent.** `graph.py` calls
  `create_deep_agent` without disabling deepagents' default, so the orchestrator
  delegates to a subagent it was never given and re-does work it already had
  direct access to. CP63 measured 125.7s against CP61's 50.9s baseline. Fix in
  code, not in a prompt (the CP38/CP41 rule), and **verify the deepagents API
  actually exists before using it** — this repo has been burned by a
  plausible-but-nonexistent API before (`qwen3.5:35b`).
- **Audit every tool for model-visible optional arguments.** Batch 20 found
  `get_season_state` exposing its internal `today`, which the model asserted
  wrongly (2025-11-03 against a real 2026-08-07), read the wrong season, and
  burned the entire step budget. Only that one tool was fixed; the audit it
  called for was never done.

Both need tests that exercise the behaviour, not the delegation — Batch 20's
lesson, learned when CP75's documented guard turned out to be inert.

## CP84 — the gap column becomes exact at every crossing

The module's stated architecture is that the official record is exact at each
crossing and OpenF1's fill is corrected there. **That is true for positions
only.** The gap and interval columns come from OpenF1 alone and are never
corrected, so a carried-forward sample goes stale during long stops and
safety-car periods. Measured on round 1: Alonso's lap 13 genuinely took 1069.5s
(17.8 minutes in the garage), and the tower showed his gap frozen at `+63.90`
against a true `+1030.86`.

The archive states every driver's cumulative time at every lap, so both columns
are exact arithmetic at each crossing. The open judgement is what a car a lap or
more down should read: the archive gives a real number of seconds, but `"+1 LAP"`
is the broadcast semantic and about 20% of real `gap_to_leader` values carry it.

Derivation change ⇒ `TIMING_VERSION` bump, per that constant's own rule.

## CP85 — cross-tab watch preferences

Recorded as known-and-accepted rather than fixed: preference caches are per-tab
with no `storage` listener, so two open `/watch` tabs diverge and then overwrite
each other. Watch mode is explicitly a second-screen feature, so two tabs is a
realistic thing for a user to do.

## Doc corrections (not a checkpoint — just wrong today)

- `ROADMAP.md`'s Batch 21 table says CP77 "in progress" and CP78 "not started".
  Both are merged and deployed; the batch is closed.
- `ROADMAP.md` credits CP67 with a **`grounding_guard`** module. No such module
  exists. The gap it names *is* closed — CP67 made tier 1 run the same
  `verifier.check` path as tiers 2-3 (`graph.py:516`), and the checkpoint's own
  plan records that the separate module "resolved to" that change. But anyone
  grepping for the name concludes the feature is missing.

## Deliberately not in this batch

- **Fantasy / prediction game** — dropped at the user's explicit instruction.
- **Watch-party variant 2** (phone-as-remote pairing). Designed
  (`docs/superpowers/specs/2026-08-08-watch-party-second-screen-design-note.md`),
  and the strongest feature candidate now that the replay underneath it is
  trustworthy. Its open question is pairing — a shared session id via the backend
  or a local network channel — which is the only part of the watch-party idea
  needing backend state, and why it was split out of Batch 21 rather than built
  alongside it. Multi-day; not started.
- **"Ask about this circuit"** scoped RAG over cached circuit history via Atlas
  Vector Search (additive — Atlas is already the database). Multi-day; not
  started.
- **Strategy "what-if" pit-stop replay.** Multi-day; not started.
- **Golden set mined from real traces + a deepeval CI gate.** CP65 shipped 24
  *authored* cases and said plainly that the plan requires real traces, of which
  there were none. If `/watch` and the assistant now have real usage, this is
  unblocked — but it depends on traffic existing, which must be checked in
  LangSmith first rather than assumed.
- **Blocked, not deferred:** track-position animation needs a coordinate data
  source this app does not have; Ferrari / Red Bull / Racing Bulls logos have no
  freely-licensed source (re-verified at CP35).

## Resumption state

CP81 is merged (PR #115, `3d823e9`) and deployed — all four Cloud Build triggers
green, `verify_race_timing --deployed` passes all 11 rounds.

CP82-85 were dispatched as four concurrent agents into one shared working tree
with strict file ownership and no git access, on 2026-08-18. **If this document
is being read to resume work, check `git status` first**: uncommitted changes in
the tree are that work, in an unknown state of completeness. Verify each against
its section above before trusting or committing it, and run the full suite —
`cd backend && python -m unittest discover tests` (961 tests passed at CP81) plus
`cd frontend && npx tsc --noEmit && npm run build`.

One pre-existing eslint error in `frontend/src/components/watch-view.tsx` (a
`react-hooks/immutability` error on the `cell.primary.textContent` line) is on
`main` and expected — it is that file's deliberate imperative-DOM-write design.
