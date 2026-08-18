# Batch 23 — the three remaining designed features

Written 2026-08-18 14:06 IST, immediately after Batch 22 shipped (`HANDOFF.md`
CP82-85 plus the two follow-up fixes). This document is both the batch plan
**and the resumption point**: if a session ends mid-batch, start here.

## Where Batch 22 finished

Everything is merged and deployed. Three PRs: #116 (rate limiting + three pieces
of verified-open debt), #117 (the session signing key), #118 (the session cookie
scheme). `main` is at `c95a420`, working tree was clean at dispatch time.

Two of those PRs exist because of a chain worth remembering. The rate limiter
shipped correct-looking and was, twice, quietly not doing its job:

1. `AGENT_SESSION_SECRET` was never configured, so cookies were signed with a
   per-process ephemeral key and did not survive a cold start.
2. Once fixed, the cookie itself turned out to be one **no browser would ever
   return** — `Secure` was decided from `request.url.scheme`, which is `"http"`
   inside a Cloud Run container, so it shipped `SameSite=Lax` with no `Secure`.
   `*.run.app` is on the Public Suffix List, making the frontend and the agent
   different sites, so a `Lax` cookie is never sent on the cross-site `fetch`.

Neither was caught by 1065 passing tests, because **both were deployment
configuration, and no test asserted the deployed shape**. `/health` looked
identical in every case. The generalisable lesson, now recorded in
`rate_limit.py`: *a degrade that cannot be observed from outside needs its
configuration asserted, not inspected.*

## The three checkpoints, dispatched as concurrent agents

| CP | Scope | Owns |
|---|---|---|
| CP86 | Watch-party variant 2 (phone-as-remote) **plus** the pit-state duration fix | `backend/app/watch_session.py`, `frontend/src/app/watch/**`, `watch-view.tsx` |
| CP87 | "Ask about this circuit" — scoped retrieval as an agent tool | `backend/agent/tools/**` |
| CP88 | Strategy what-if pit-stop replay | `backend/app/strategy_whatif.py`, Pitwall components |

All three were told: no git commands, strict file ownership, ignore suite
failures in files they do not own, do not deploy.

### CP86 — the two open questions it must answer

The design note
(`docs/superpowers/specs/2026-08-08-watch-party-second-screen-design-note.md`)
leaves these genuinely open, and they are the checkpoint's real content:

- **Q3, the pairing transport.** Shared session id via the backend, or a
  local-network channel? The brief's prior — to be challenged, not accepted — is
  that a local-network channel needs signalling anyway and fails exactly when
  the phone and laptop are on different networks, whereas a Mongo document with
  short polling is boring, works everywhere, and carries state that changes a
  few times a minute. Cloud Run supports WebSockets; this does not obviously
  need them.
- **Q5, the unsynced-race empty state.** The note calls this "the feature's
  first impression" because the most likely moment someone opens this is for the
  race that just ran — precisely the one the scheduled sync may not have filled.

**The pairing code is an unauthenticated capability.** Anyone who guesses one
drives a stranger's screen. Low impact, not zero: enough entropy, a short TTL,
and a rate-limited join endpoint. `agent/rate_limit.py` is the reference for how
this project now thinks about that, though it lives in the *agent* service and
cannot be imported by `f1-backend`.

The bundled pit fix: the tower's `PIT` state is keyed on the driver's *own* lap
while the tower indexes the *leader's* laps, so a long stop loses the flag after
one leader-lap and the stale gap returns. Alonso, round 1: a 972.356s stop, of
which ~16 minutes still read `+63.9`.

### CP88 — the constraint that matters more than the feature

A what-if is inherently modelled, and this repo has a hard rule against numbers
that look like measurements but are not (`race_timing.py`: "**Nothing here is
interpolated.**"; CP76 refused to carry a lap duration forward for exactly this
reason). The estimate must be structurally distinct from the measured tower,
never rendered in the same voice.

The check that decides whether it is trustworthy at all: **move a real stop to
the lap it actually happened on and confirm the model reproduces the real
outcome.** A model that cannot reproduce reality on a no-op cannot be trusted on
a counterfactual.

### CP87 — establish feasibility before building

Atlas Vector Search may or may not be usable on this cluster, and creating an
index generally needs Admin API or UI access. The brief is explicit that a
well-scoped *structured* retrieval that ships beats a vector design that cannot
be created — `circuit_history.py` already caches full result history back to
1950. Also: an embedding call per query spends the same metered GPU quota that
answers questions.

It must land as a **tool in the existing agent**, not a second system, and it
must add its entry to the tool → model-visible-argument map in
`test_agent_graph.py` or the suite fails — which is that map working as intended.

## Resumption state

**If you are reading this to resume:** run `git status` first. Uncommitted
changes are the three agents' work in an unknown state of completeness. Verify
each against its section above before trusting or committing it. Do not merge
anything verified only by the code's own tests — every Batch 22 defect passed
those.

Baselines at dispatch: **1070 backend tests pass**; `cd frontend && npx tsc
--noEmit && npm run build` clean. One pre-existing `react-hooks/immutability`
eslint error in `watch-view.tsx` is on `main` and expected — that file's
deliberate imperative-DOM-write design.

Deploy is `gh pr merge --squash` onto `main`; four Cloud Build triggers fire on
push and take roughly 6-10 minutes. Verify the agent service afterwards with
`/health` and the abuse probe in the session scratchpad; verify watch timing with
`cd backend && python -m scripts.verify_race_timing --deployed`.

## STATE AS OF 2026-08-18 ~14:40 IST — read this before touching anything

All three agents were killed mid-work by a session limit (reset 18:10 IST). What
they left is uncommitted and in an **unknown state of completeness**. One piece
was separable, verified and shipped; the rest was deliberately left alone.

### Shipped

**The pit-duration fix (CP86 task 1) is merged and deployed** — PR #119,
`5b4b9d2`. It was fully separable: `watch-view.tsx` imports only
`frontend/src/lib/watch-pit.ts` and touches nothing about pairing. Verified
independently against the deployed payloads: car 14's stationary window goes
from 0% covered to 90.1%, and no driver is marked in-pit at t=0.

### Left uncommitted, and exactly why

**CP86 pairing — `backend/app/watch_session.py`, `backend/tests/test_watch_session.py`.**
Three of its own tests fail. One is a test bug; two are not obviously either:

- `test_normalise_strips_symbols_that_are_not_in_the_alphabet` — expects
  `normalise_code("<script>") == "CRP"`, gets `"SCRPT"`. **The implementation is
  right and the test is wrong**: `CODE_ALPHABET` is
  `"23456789ABCDEFGHJKMNPQRSTVWXYZ"`, which excludes I/L/O/U but keeps S and T.
  Fix the expectation, not the code.
- `test_rotating_within_a_subnet_does_not_multiply_the_allowance` — allowed 39,
  limit 40. An off-by-one; could be either side.
- `test_sustained_window_bounds_a_patient_guesser` — allowed 120, ip sustained
  limit 60. **Exactly 2×, which is the signature of the fixed-window seam** that
  `agent/rate_limit.py` documents as its known cost (a window boundary permits
  up to 2× across the seam). So this is plausibly the test not accounting for a
  real, documented property — but it is a rate limiter on an unauthenticated
  pairing endpoint, so **do not guess**: read both sides and decide deliberately.

**CP88 what-if — `backend/app/strategy_whatif.py`.** No test file exists, so it
is incomplete by this repo's standards. Its last words were about a caution
period over-extending on an unmatched deployment, i.e. it was still fixing the
model. **The no-op reproduction check has not been reported and is the gate**: a
model that cannot reproduce a real stop moved to its own real lap cannot be
trusted on a counterfactual.

**CP87 circuit tool — `backend/agent/tools/circuit_scope.py`,
`backend/app/circuit_character.py`, `backend/tests/test_agent_tools_circuit_scope.py`,
plus edits to `subagents.py`, `tools/__init__.py`, `test_agent_graph.py`.** Its
tests pass. It died just before "one live end-to-end call to prove grounding
reaches the answer", so **the grounding claim is unverified** — which is the
whole point of the feature. Do not merge it on a green suite alone; that is
exactly the mistake `HANDOFF.md` exists to prevent.

**`backend/app/main.py`** carries router registrations for *both*
`strategy_whatif` and `watch_session`. Committing either feature means taking
only its own line.

### Suite state

1148 tests, 3 failures — all three in `test_watch_session`. Everything else
passes. `npx tsc --noEmit` and `npm run build` are clean.

## STATE AS OF 2026-08-18 ~18:50 IST — after the scheduled resume

### Shipped

**CP86 task 1, the pit-duration fix** — PR #119, deployed. See the earlier
section; verified 0% -> 90.1% coverage of car 14's real stationary window.

**CP87, the circuit dossier tool** — PR #120, `9deaaad`, deployed. Grounding is
proven at both ends:

* *Offline*, by calling the tool against production Mongo: Monaco ranks **1 of
  24** for least position change (0.846 gains/lap) and Monza **22** (3.123).
  That ordering reproduces a well-known fact about the sport from nothing but
  cached lap rows — an external check, not the data agreeing with itself.
* *Live*, with one call to the deployed agent ("Why is it so hard to overtake at
  Monaco?"). The model called `get_circuit_dossier`, cited `[ev_1]` on every
  claim, resolved to `mongo:circuit_character_cache/monaco-overtaking`, and
  quoted `rank_least_position_change: 1` and `0.846` — the exact values the tool
  returns. It framed them as "in the sample" and "the races analysed", i.e. it
  respected the bundle's own confidence caveat rather than generalising.

**Three test bugs in `test_watch_session` were fixed** (they are part of the
held CP86 work and remain uncommitted with it). All three were the *tests* being
wrong, not the limiter — and two of them could not have caught a broken limiter
at all:

* `normalise_code("<script>")` expected `"CRP"`; the alphabet keeps S and T.
* The subnet test looped 39 times against a limit of 40 and asserted 40. It
  never made a 41st attempt, so it would have passed with no cap at all.
* The sustained test spread attempts over two hours and asserted 60. 3600s is
  one window, so two hours is two fresh allowances and 120 was correct. Fixing
  it also required **aligning to a window start** — `1_700_000_000` sits 2800s
  into a window, so an unaligned hour-long loop straddles the boundary and
  measures rollover rather than the cap.

A negative control confirms the corrected tests bite: stubbing the limiter's
refusal branch fails 6 of them.

### Still held, and why

**CP86 pairing** — `backend/app/watch_session.py` (6 endpoints, 43 passing
tests) has **no frontend whatsoever**. Nothing under `frontend/src` references
it. Shipping six unauthenticated public endpoints with no consumer is attack
surface for zero user value, so it waits for the UI. Note `backend/app/main.py`
must regain its `watch_session` router line when it ships — that file was
reverted to keep #120 clean.

**CP88 what-if** — `backend/app/strategy_whatif.py` is 1229 lines with **no test
file and no frontend**. The gate set in its brief, the no-op reproduction check
(move a real stop to the lap it actually happened on and confirm the model
reproduces reality), was never run or reported. Its last words were about a
caution period over-extending on an unmatched deployment, i.e. the model was
still wrong when it died. Do not ship this on the strength of it existing.

### Suite state

**1105 tests pass** on `main`. With the two held features' files present in the
working tree the count is 1148 and 19 fail — all of them `watch_session` tests
that need the router line reverted out of `main.py`. That is expected, not a
regression.

## Still not started, and why

- **Golden set from real LangSmith traces** — blocked on a `LANGSMITH_API_KEY`
  that is not in the local `.env`. Tracing is live in production, so the traces
  almost certainly exist; this needs the credential, not effort.
- **Track-position animation** — needs a coordinate data source this app does
  not have. Blocked, not deferred.
- **Ferrari / Red Bull / Racing Bulls logos** — no freely-licensed source
  (re-verified at CP35). A standing licensing constraint.
- **Fantasy / prediction game** — dropped at the user's explicit instruction.
