# Batch 20, CP72-75 — Claim-level evidence, comparative-answer quality, follow-ups

Batch 20's second design document. CP71 (checkpoint 1) fixed the citation *plumbing* — per-message
namespacing, popovers, a shared source-kind vocabulary, a collapsing activity timeline. Live use
immediately found that the plumbing is not the problem. Four complaints came out of that session,
and three of them share one root cause.

## What was reported, and what is actually wrong

**1. "Compare Norris and Verstappen this year" ran long and returned *at capacity*.**
That string is `main.py:438/447`, raised either by the per-process concurrency gate timing out
(`AGENT_QUEUE_TIMEOUT_SECONDS`, 45s) or by Ollama rejecting on quota. Neither is the bug. The bug is
that a comparative season question takes long enough to hit them: Batch 18 already measured this
exact query class making **ten** redundant round-by-round tool calls and failing to converge in
287s, which is why `router.py` downgraded tier 2 to the flat graph. The downgrade addressed the
routing, never the tool selection. `get_head_to_head` exists (`tools/drivers.py:231`) and answers
this question in one call; the model is not reaching for it. **The error copy is a symptom.**

**2. "Who won the Australian GP?" cited a table containing no mention of the winner.**
`Evidence` binds to a whole **tool bundle**, not a field. `citation()` exposes
`id/n/kind/label/title/url/as_of/snippet`, and `_snippet()` renders the first six top-level scalars
plus the first row of the first list — a fixed, claim-blind excerpt. There is no mechanism by which
a citation can point at *the field that answers the question*, because nothing in the pipeline knows
which field that was. A citation can therefore only ever say "this came from the Australian GP
session result." That is exactly what was observed, and it is by construction.

**3. One citation inline, several listed below.** Same root cause. The inline markers come from
whatever ids the model wrote into its prose; the list below comes from `ledger.citations()`, which
returns **every entry the tools retrieved** whether the answer leaned on it or not. Two different
sets, derived independently, displayed as if they were one. Reconciling the counts would be patching
the symptom; the fix is to derive both from a single set of resolved anchors.

**4. The citation surface itself.** Numbered pills read as academic footnotes and carry no
information until clicked. Design direction chosen (see below): **the fact is the citation.**

## The governing principle, restated

This project has three post-mortems saying the same thing — CP38 (a teammate relationship invented
from correct data), CP41 (a prompt ban violated in ALL CAPS), CP44 (the model not emitting its own
documented format): **do not ask the model to police itself; check it in code.**

The tempting fix for #2 is to ask the model to cite fields — `[ev_3#winner]` instead of `[ev_3]`.
That is the same mistake those three post-mortems record, at a finer granularity, and it would fail
the same way. **CP72 computes anchors in code instead.** The verifier already walks the finished
draft sentence by sentence, extracts significant numbers, and searches each cited entry's data for
them (`verifier.py:72-137`). It is already doing 90% of the work of locating a claim inside its
evidence — it simply discards the location once it has decided pass/fail. CP72 keeps it.

## CP72 — Claim anchors (backend)

**Files:** `backend/agent/ledger.py`, `backend/agent/verifier.py`, `backend/agent/sse.py` and their
tests. No frontend.

`Evidence` grows a `locate(values)` method: given the significant tokens of a claim, walk `data`
and return the path and the surrounding row where they were found — `{"path": "results[0]",
"field": "driver", "value": "Russell", "row": {...}}`. Pure data-structure walking, no model call,
total (a failed locate returns nothing and costs the answer nothing, matching `_snippet()`'s
existing discipline).

The verifier, which already resolves claim → cited entry → matched value, emits an **anchor** per
verified claim rather than throwing the position away. Anchors are what the `sources` SSE event
carries from now on: each one names the claim's text span, the evidence entry, the located field and
its value, and the row to highlight.

Two consequences fall out for free, which is the argument for fixing it here rather than in the UI:

- A citation now points at the field that answers the question, because the anchor was derived *from
  the claim*, not from the bundle's first six keys.
- The below-answer source list is generated from the **same anchor set** as the inline markers, so
  the two cannot disagree. Complaint #3 becomes structurally impossible rather than fixed.

Entries with no anchor — evidence the tools fetched but the answer never used — are no longer listed
as sources at all. They remain in the ledger for the verifier and for tracing.

**Done when:** a unit test asserts that a race-result bundle queried for "who won" produces an anchor
on the P1 driver field; the `sources` event carries anchors; and `ledger.citations()` no longer
drives the user-visible source list. Existing verifier behaviour is unchanged — anchors are a
by-product of checks that already run, never a new gate.

## CP73 — Comparative questions converge (backend)

**Files:** `backend/agent/graph.py` (prompt/tool docs), `backend/agent/tools/drivers.py`,
`backend/agent/router.py`, golden set. Disjoint from CP72 — runs in parallel.

**Reproduce first, fix second.** Run the failing question against the deployed service and record
the actual tool-call sequence from the LangSmith trace before changing anything. The fix depends on
what that shows, and the plausible causes need different fixes:

- The model does not recognise `get_head_to_head` as the right tool → its description and the
  orchestrator prompt's tool guidance are wrong, not the tool.
- The tool exists but does not cover a *season* comparison (only race-scoped) → it needs a season
  fact bundle, matching the "tools return pre-computed fact bundles" rule the whole design rests on.
- The router sends this class somewhere that cannot reach the tool → routing fix.

Whichever it is, the checkpoint's contract is the same: **the comparative question answers in one or
two tool calls, well inside the timeout**, with the before/after latency recorded in `HANDOFF.md` the
way Batch 18 recorded its own measurement. If it does not measurably improve, we say so and keep the
baseline — the same clause Batch 18 exercised for real on tier 2.

Separately and regardless: the `at_capacity` copy is misleading when the true cause is a slow answer
rather than contention. Distinguish "busy" from "this question took too long" so the message names
what happened.

**Done when:** the recorded trace shows convergence in ≤2 tool calls; a golden-set case covers the
comparative class; the timeout and capacity messages are distinguishable.

## CP74 — Direction A: the fact is the citation (frontend)

**Files:** `frontend/src/components/` citation components, `frontend/src/lib/source-kind.ts`,
`pitwall-assistant-panel.tsx`. Depends on CP72's anchors.

Numbered pills are removed entirely. The **cited value in the prose** — `George Russell`, `4.812` —
is itself the citation: underlined in its source-kind colour (reusing CP71's shared source-kind
definitions rather than inventing a second vocabulary). Hover or tap opens the evidence with the
located row highlighted and the rest of the record shown around it for context, so the reader sees
the fact in situ rather than as a stripped excerpt. Source kind, freshness (`as_of`) and a real link
for web sources stay, since CP71 established them and they work.

Below the answer, the bibliography becomes a compact source strip — which records were used, not a
numbered list — derived from the same anchors.

Accessibility is not optional here and is the main risk of direction A: an underline that only opens
on hover is unusable by keyboard and invisible to a screen reader. Every anchor is a real focusable
control with an accessible name naming the source, following the keyboard/focus-trap work CP70 and
CP71 already did in this panel.

**Done when:** clicking any cited value opens its own evidence with the proving row highlighted;
no numbered pills remain; inline and below-answer counts cannot diverge; keyboard and screen-reader
paths work.

## CP75 — Follow-up question chips (frontend + backend)

**Files:** `backend/agent/graph.py` or a small dedicated module, `sse.py`, `pitwall-assistant-panel.tsx`.
Runs after CP74 — both edit the panel.

Three to four suggested follow-ups render under a finished answer; clicking one sends it as a user
message. **Model-generated** — the user's explicit choice, made knowing the alternative was
code-derived suggestions at zero inference cost.

One guard is non-negotiable, and it is the reason this is not purely a frontend checkpoint: a
suggested question the tools cannot answer is a promise the app breaks the moment it is clicked.
Every generated suggestion is checked against the existing rules-first router before it renders, and
unroutable ones are dropped rather than shown. Fewer chips is an acceptable outcome; a dead-end chip
is not.

Generation rides on the turn that is already running rather than costing a second round trip, and
suggestions arrive on their own SSE event after `done` so they can never delay the answer. If
generation fails or returns nothing usable, no chips render — the feature is additive and fails
silent, like every other optional surface in this panel.

**Done when:** chips render after an answer, clicking one sends it, unroutable suggestions are
dropped, and a failed generation degrades to no chips rather than a broken turn.

## Sequencing

CP72 and CP73 touch disjoint files and are built in parallel. CP74 depends on CP72's anchors. CP75
follows CP74 because both edit `pitwall-assistant-panel.tsx`.

## Explicitly out of scope

- **Constructor budget-cap tracker.** Investigated and dropped for this batch: no feed exists. The
  FIA publishes cost-cap compliance once a year in arrears as a press release; Jolpica-Ergast,
  OpenF1 and FastF1 all carry zero financial data. It would be a hand-maintained JSON that goes
  stale silently, in an app where every other number is traceable to a synced source. If it is ever
  built it should be framed as a static "cost cap explained" panel, not a *tracker*.
- **Watch-party / second-screen mode.** Under active discussion for a later batch, not this one. One
  finding from that discussion is recorded here because it is easy to lose: the existing race replay
  is not real-time and cannot be made so with a speed slider. `race-replay.tsx:42` sets
  `BASE_MS_PER_LAP = 560`, so its "1×" is roughly **150× real time** (a 58-lap race in ~33s) and its
  2×/4× buttons move further from reality, not toward it. A watch-party mode needs a different
  clock, advancing on each lap's own actual duration from `race_laps` — including the slow laps
  behind a safety car, which is when a companion screen is most useful. That makes it real work, not
  a re-skin of the replay.
