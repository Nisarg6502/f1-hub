# CP69 — Feedback loop: thumbs up/down, LangSmith feedback, dataset curation

Batch 19, checkpoint 4 of 6 (CP67 guardrails ✅ merged, CP68 visual citations ✅ merged). Closes
`HANDOFF.md`'s CP65 deferral note verbatim: *"LangSmith dataset curation and thumbs-up/down feedback
wiring... are deferred, not built this checkpoint."* Nothing for this exists in the repo yet — no
`/api/feedback` route, no thumbs UI, no curation script. Confirmed by research (see below), not
assumed.

## Context this plan relies on

- **`run_id` is already the real LangSmith run id and already ships on every `done` SSE event**
  (`backend/agent/main.py:215-222`, `sse.py`'s `done` shape) — `tracing.run_id(run)` reads
  `getattr(run, "id", None)` off the object `langsmith.run_helpers.trace(...)` yields. **Caveat**: it
  is `None` whenever a turn is answered from cache (`main.py:192-213` never opens a trace) or when
  LangSmith isn't configured (`config.langsmith_configured()` false — the common local-dev case).
  Both the backend feedback route and the frontend thumbs control must treat a null `run_id` as "no
  feedback possible here", not crash on it.
- **No `langsmith.Client` exists anywhere in this codebase today.** `tracing.py` only ever imports
  `langsmith.run_helpers.trace` (a context-manager helper), lazily, inside a bare-`except Exception`
  wrapper, specifically so a broken LangSmith install degrades to "no trace", never to "no answer"
  (`tracing.py`'s own docstring, line ~13 — this is the "bare-except telemetry rule" the batch plan
  cites). This checkpoint is the first use of `Client.create_feedback(...)`, and must follow the same
  fail-soft discipline: a feedback outage degrades to "not recorded", never a user-visible error.
  `langsmith~=0.10.0` is already pinned in `backend/requirements-agent.txt`, added ahead of time for
  exactly this checkpoint (see that file's own comment).
- **`Client.create_feedback` is synchronous** — the SDK ships no async client for feedback in 0.10.x.
  Calling it from `POST /api/feedback`'s `async def` route body must not block the event loop; wrap
  in `asyncio.to_thread(...)`.
- **`backend/agent/main.py` has exactly two routes** (`GET /health`, `POST /api/chat`), both flat
  top-level, no router-include (unlike the other, non-agent `backend/app/main.py` service — deliberate
  split, don't try to unify them). `ChatRequest` (line ~80) is the only existing Pydantic request
  model, a plain `BaseModel` with `Field(..., description=...)` — the pattern to match for
  `FeedbackRequest`. CORS already permits `POST` (`config.ALLOWED_ORIGINS`, `allow_methods` includes
  `POST`) — no CORS change needed.
- **`agent/golden_set.py`'s two dataclasses have no slot for a mined run** — `GoldenCase` (router
  taxonomy regression: id/taxonomy_class/question/expected_tier/notes) and `KnownHardCase`
  (draft+evidence pair the verifier must judge: id/source/draft/evidence/predictive/subjective/
  expected_pass/notes) are different shapes for different purposes, and every existing entry is
  hand-authored with a long prose `notes=` explaining provenance — there is no loader, no JSON import.
  `curate_goldens.py` **prints a formatted literal for a human to paste in**, matching this file's own
  established voice, rather than editing the file programmatically. This directly implements the
  batch plan's explicit "require human review... automatic promotion is explicitly rejected" line.
- **No `scripts/` precedent for "pull data, propose, require human review"** — the existing root
  `scripts/build_track_geometry.py` establishes the repo's argparse-CLI idiom (`--dry-run`, `--report`
  flags, a companion `scripts/README.md` table) worth mirroring, but is otherwise a different domain
  (geometry build, not LangSmith/Mongo curation). `curate_goldens.py` is the first of its kind.
- **Frontend**: `AgentDone` (`agent-api.ts:37-51`) already carries `run_id: string | null`. The only
  existing POST-fetch pattern in this client is `streamChat`'s own `fetch(..., {method: "POST", ...})`
  (`agent-api.ts:188-208`) against `AGENT_BASE_URL` — `postFeedback()` mirrors that shape exactly,
  minus the SSE reader loop (a feedback POST is not a stream). `MessageBubble`
  (`pitwall-assistant-panel.tsx:278-334`) already has the right insertion point: right after the
  answer block / `StatusFooter` (line ~311-314), before the `SourceCard` list (line ~316) — and
  `StatusFooter` (lines 397-413) is the existing precedent for "small footer keyed off `AgentDone`",
  including its `done.mode === "echo"` suppression check, which thumbs must reuse verbatim (the batch
  plan explicitly says thumbs are suppressed for echo mode — it isn't a real answer to rate).
- Per `ROADMAP.md`'s skill-usage rule, `emil-design-eng` must be invoked before finalizing any new UI
  (the thumbs buttons, the thumbs-down comment popover) — this codebase already has a reusable
  liquid-glass popover pattern (`tire-stints-chart.tsx`/`compare-drivers-panel.tsx`:
  `bg-[rgba(26,22,19,0.98)] border border-white/10`, Framer Motion via the already-installed
  `motion/react`, click-outside+Escape) worth reusing for the thumbs-down comment box rather than
  inventing a new popover component.
- Per `BATCH-19-PLAN.md` §9, CP69 and CP70 are sequential (both edit `pitwall-assistant-panel.tsx`
  substantially) — this plan does not attempt to run frontend work in parallel with CP70.

## Task 1: `POST /api/feedback` — LangSmith feedback, fail-soft

**Files:**
- Modify: `backend/agent/main.py` (new `FeedbackRequest` model, new route)
- Modify: `backend/tests/test_agent_main.py` (or create `backend/tests/test_agent_feedback.py` if
  `main.py`'s existing tests live in a dedicated file per-route — check first, follow that file's
  existing pattern for mocking `tracing`/FastAPI's `TestClient`)

**Interfaces:**
- Produces: `POST /api/feedback` accepting `{"run_id": str, "score": int, "comment": str | None}`,
  returning `{"recorded": bool}` — `200` always (this is telemetry, never a hard failure to the
  client), `recorded: false` whenever LangSmith isn't configured, `run_id` is falsy/malformed, or the
  LangSmith call itself raises.
- `score` is validated to `{-1, 1}` (thumbs down / thumbs up) at the Pydantic layer — reject a
  malformed score with a normal `422`, since that's a genuine client bug, not a telemetry outage.

- [ ] **Step 1: Read `backend/agent/main.py` and `backend/agent/tracing.py` in full** if not already
  done this session, to confirm the exact `ChatRequest`/route/CORS/`_TRACING_LIVE` patterns above are
  still accurate before writing against them.

- [ ] **Step 2: Write the failing test(s)**

Add tests covering: (a) a valid thumbs-up records via a mocked `langsmith.Client.create_feedback` and
returns `{"recorded": true}`; (b) `run_id: null`/missing returns `{"recorded": false}` without
attempting a LangSmith call; (c) LangSmith configured but `create_feedback` raises → `{"recorded":
false}`, no 500; (d) `score` outside `{-1, 1}` → `422`; (e) LangSmith not configured at all
(`_TRACING_LIVE` false) → `{"recorded": false}`, no LangSmith import/call attempted. Use FastAPI's
`TestClient` and mock at the `langsmith.Client` boundary (patch wherever the route imports it from),
following whatever mocking convention `test_agent_main.py`'s existing tests already use for
`tracing`/external calls — read that file's setup before writing new tests, do not invent a new
mocking style.

- [ ] **Step 3: Run to verify the tests fail** (`cd backend && python -m unittest
  tests.test_agent_main -v` or the correct module path once you've confirmed which file).

- [ ] **Step 4: Implement**

```python
class FeedbackRequest(BaseModel):
    run_id: str = Field(..., description="The LangSmith run id from the matching `done` event")
    score: int = Field(..., description="1 for thumbs up, -1 for thumbs down")
    comment: str | None = Field(None, description="Optional free-text, typically on thumbs-down")

    @field_validator("score")
    @classmethod
    def _score_is_a_thumb(cls, v: int) -> int:
        if v not in (-1, 1):
            raise ValueError("score must be 1 or -1")
        return v


@app.post("/api/feedback")
async def feedback(request: FeedbackRequest) -> dict:
    if not _TRACING_LIVE or not request.run_id:
        return {"recorded": False}
    try:
        import langsmith

        client = langsmith.Client()
        await asyncio.to_thread(
            client.create_feedback,
            request.run_id,
            key="user-score",
            score=request.score,
            comment=request.comment,
        )
        return {"recorded": True}
    except Exception as exc:  # telemetry: degrade, never 500 the client — matches tracing.py's rule
        print(f"feedback not recorded: {exc}")
        return {"recorded": False}
```

Add `import asyncio` to `main.py`'s existing import block if not already present. Place the route
directly below `chat()` for locality. Import `langsmith` lazily inside the function body (matching
`tracing.py`'s own lazy-import discipline), not at module top — a broken/absent langsmith install must
not break `/api/chat` or `/health`.

- [ ] **Step 5: Run to verify all tests pass, then the full backend suite**

`cd backend && python -m unittest discover tests` — all PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add backend/agent/main.py backend/tests/test_agent_main.py  # or the actual test file used
git commit -m "feat(agent): CP69 POST /api/feedback forwards to LangSmith, fails soft"
```

---

## Task 2: Frontend thumbs up/down UI

**Files:**
- Modify: `frontend/src/lib/agent-api.ts` (new `postFeedback` helper)
- Modify: `frontend/src/components/pitwall-assistant-panel.tsx` (`Message` type, `MessageBubble`, new
  `FeedbackControls` component)

**Interfaces:**
- Produces: `postFeedback(runId: string, score: 1 | -1, comment?: string): Promise<void>` — fire-and-
  forget from the UI's perspective (optimistic; network failure just means the vote doesn't persist
  server-side, no user-visible error, matching the backend's own fail-soft contract).
- `Message` gains `feedback: 1 | -1 | null` (one vote per message, tracked client-side).

- [ ] **Step 1: Read the current full `MessageBubble` and `Message` type**, and `StatusFooter`
  (lines ~397-413) for the `done.mode === "echo"` suppression precedent, to confirm line numbers
  before editing (CP68's merge may have shifted them slightly from the research report above).

- [ ] **Step 2: Implement `postFeedback` in `agent-api.ts`**

```typescript
export async function postFeedback(
  runId: string,
  score: 1 | -1,
  comment?: string
): Promise<void> {
  try {
    await fetch(new URL("/api/feedback", AGENT_BASE_URL).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId, score, comment: comment ?? null }),
    });
  } catch {
    // Fire-and-forget telemetry — a failed vote is not a user-visible error.
  }
}
```

- [ ] **Step 3: Extend `Message`**

Add `feedback: 1 | -1 | null` to the `Message` type, initialized `null` when a message is created.

- [ ] **Step 4: Build `FeedbackControls`**

A small component (inline in `pitwall-assistant-panel.tsx`, or a new sibling file
`frontend/src/components/feedback-controls.tsx` if this file is already large — check its current
line count and match this codebase's existing threshold for splitting components) taking
`{ runId: string | null; feedback: 1 | -1 | null; onVote: (score: 1 | -1, comment?: string) => void }`.
Renders two icon buttons (thumbs up/down, disabled/highlighted once `feedback` is set — one vote per
message, per the batch plan). Thumbs-down opens a small comment box before submitting — reuse this
codebase's existing liquid-glass popover pattern (`tire-stints-chart.tsx`/`compare-drivers-panel.tsx`:
`bg-[rgba(26,22,19,0.98)] border border-white/10`, `motion/react` for the open/close transition,
click-outside+Escape to dismiss) rather than a new popover implementation. Renders nothing (`null`) if
`runId` is falsy (cached answers) or if `done?.mode === "echo"` — same guard `StatusFooter` already
uses for the latter.

Invoke `emil-design-eng` before finalizing the button hover/press states and the comment popover's
open/close transition — treat the description above as functional requirements, not final Tailwind
classes.

- [ ] **Step 5: Wire into `MessageBubble`**

Insert `<FeedbackControls runId={message.doneRunId} feedback={message.feedback} onVote={...} />`
between the answer block and the `SourceCard` list (per the research report's line ~314-316
insertion point — confirm against the file's actual current state). `onVote` calls `postFeedback`,
then optimistically patches the message's `feedback` field via the same `patch()` helper `onActivity`
already uses (`pitwall-assistant-panel.tsx`'s existing state-update pattern — reuse it, don't invent a
second one).

You will need to store the `run_id` from the `done` event onto the message (check whether `Message`
already has a field for this post-CP68, e.g. from the timestamp work — if not, add
`doneRunId: string | null`, populated in the existing `onDone` handler alongside wherever `mode`/
`tier`/similar `done`-derived fields are already stored).

- [ ] **Step 6: Verify in the browser**

Start the frontend dev server and, if `OLLAMA_API_KEY`/LangSmith creds aren't reachable in this
environment, use the same throwaway-dev-route-with-mocked-`streamChat` fallback CP68's Task 6 used
(delete before committing). Confirm: thumbs render after a real (non-cached, non-echo) answer;
clicking thumbs-up highlights it and is a one-shot (can't double-vote); clicking thumbs-down opens the
comment popover, and submitting (with or without comment) records the vote; thumbs are absent for a
cached or echo-mode answer.

- [ ] **Step 7: `npm run build && npm run lint` from `frontend/`**

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/agent-api.ts frontend/src/components/pitwall-assistant-panel.tsx
# plus frontend/src/components/feedback-controls.tsx if split out
git commit -m "feat(agent-ui): CP69 thumbs up/down feedback controls"
```

---

## Task 3: `scripts/curate_goldens.py` — human-in-the-loop dataset curation

**Files:**
- Create: `scripts/curate_goldens.py`
- Create: `scripts/README.md` entry (extend the existing table if `scripts/README.md` already
  documents `build_track_geometry.py` this way — match its format)
- Modify: `scripts/requirements.txt` (add `langsmith`, pinned to the same `~=0.10.0` version
  `backend/requirements-agent.txt` uses, unless this script is meant to run inside the backend venv
  instead — decide explicitly in Step 1 and note the decision in the script's own docstring, since the
  research for this plan found this is genuinely undecided by the batch plan and needs a call, not an
  assumption)

**Interfaces:**
- Produces: a CLI, `python scripts/curate_goldens.py [--since DAYS] [--limit N] [--dry-run]`, that
  queries LangSmith for runs with a `user-score` feedback entry of `-1` (thumbs-down) in the lookback
  window, and for each one **prints** (never writes automatically) a formatted candidate — either a
  `GoldenCase(...)` or `KnownHardCase(...)` Python literal, matching `agent/golden_set.py`'s existing
  hand-authored style including a `notes=` field crediting the source run id — for a human to review
  and paste into `agent/golden_set.py` themselves.

- [ ] **Step 1: Decide and document the venv question**

Read `scripts/requirements.txt` and `backend/requirements-agent.txt` side by side. If root `scripts/`
already has its own Mongo-connecting convention (per `build_track_geometry.py`), prefer running this
script the same way (root venv, its own `requirements.txt`) for consistency with its sibling script,
rather than requiring the backend's venv. Document the choice in the new script's module docstring in
one sentence, so this isn't left ambiguous for the next person.

- [ ] **Step 2: Write the failing test for the pure logic**

The LangSmith-querying and file-reading parts are I/O and don't need unit tests beyond a manual
smoke-run (per this repo's own established pattern — CLI scripts here are argparse tools verified by
running them, not unit-tested end to end). But the **candidate-formatting logic** (turning a
`{question, answer, evidence, run_id}` dict into a printable `GoldenCase(...)`/`KnownHardCase(...)`
literal string) is pure and testable. Add `scripts/tests/test_curate_goldens.py` (create the
`scripts/tests/` dir if it doesn't exist) with a test asserting the formatter produces syntactically
valid Python (e.g. round-trips through `ast.parse`) and includes the source run id in `notes=`.

- [ ] **Step 3: Run to verify it fails, then implement**

Structure:
1. `argparse` CLI: `--since` (default 7, days), `--limit` (default 20), `--dry-run` (print query
   plan and count only, no formatting output) — follow `build_track_geometry.py`'s existing flag-
   naming and help-text conventions.
2. `fetch_thumbs_down_runs(client, since_days, limit)` — queries LangSmith for runs in the configured
   project with a `-1` `user-score` feedback entry, returns the run's inputs (question), outputs
   (answer text), and any evidence/ledger metadata attached to the run (check what `tracing.py`'s
   `traced_run` actually attaches as run metadata/outputs — the curation script can only surface what
   was actually recorded, so read `traced_run`'s `outputs=`/metadata argument shape before assuming a
   field exists).
3. `format_candidate(run_data) -> str` — the pure, tested function from Step 2. Emits a commented
   block: the original question/answer for human context, then the proposed `GoldenCase(...)` or
   `KnownHardCase(...)` literal (heuristic for which: if the run's evidence ledger was empty and the
   answer asserted a checkable fact, propose a `KnownHardCase` documenting the grounding-guard-relevant
   failure; otherwise propose a `GoldenCase` router-classification regression — state this heuristic
   explicitly in the script's docstring, it's a judgment call the human reviewer can override).
4. Main: fetch → format each → print all to stdout (or `--out FILE` if you want a file-write option,
   defaulting to stdout so nothing is silently written without the human seeing it first) → print a
   summary count. **Never** writes to `agent/golden_set.py` directly — this is the "require human
   review" gate from the batch plan, enforced structurally by the script simply not having a
   file-write-to-golden-set code path at all, not by a flag a future run could accidentally omit.

- [ ] **Step 4: Run the test, then a manual dry-run**

`cd scripts && python -m pytest tests/test_curate_goldens.py -v` (or whatever runner `scripts/` uses —
check for an existing test-running convention there first; if none, add one consistent with the
backend's `unittest discover` if that's simpler than introducing pytest for one new test file).

Manually run `python scripts/curate_goldens.py --dry-run` against real or mocked LangSmith credentials
if reachable in this environment; if not, note in the commit/report that only the pure formatter was
exercised and the LangSmith-querying path is unverified pending real credentials — be honest about
this gap rather than claiming full verification that didn't happen.

- [ ] **Step 5: Commit**

```bash
git add scripts/curate_goldens.py scripts/tests/test_curate_goldens.py scripts/requirements.txt scripts/README.md
git commit -m "feat(scripts): CP69 curate_goldens.py mines thumbs-down runs for human-reviewed golden-set candidates"
```

---

## Task 4: Close the loop — docs and final wiring check

**Files:**
- Modify: `HANDOFF.md` (remove/update the CP65 deferral note this checkpoint closes)
- Modify: `ROADMAP.md` if it tracks CP69 status

- [ ] **Step 1**: Update `HANDOFF.md`'s CP65 section to state feedback wiring and curation are now
  built (CP69), replacing the "deferred" language with a pointer to this plan and the merge commit.
- [ ] **Step 2**: Confirm end-to-end one more time in the browser (or mocked route) per Task 2 Step 6,
  now that all three tasks are merged together in this branch — a thumbs-down with a comment, followed
  by a `curate_goldens.py --dry-run` (if credentials allow) showing that run surfaced.
- [ ] **Step 3**: Commit docs.

```bash
git add HANDOFF.md ROADMAP.md
git commit -m "docs: CP69 closes the CP65 feedback-loop deferral"
```

---

## Self-Review

**1. Spec coverage against `BATCH-19-PLAN.md` §7:**
- `POST /api/feedback` → LangSmith, fails soft — Task 1. ✅
- No new plumbing needed for `run_id` — confirmed already true, Task 1 just consumes it. ✅
- Thumbs UI, optimistic, one vote/message, free-text on thumbs-down, suppressed for echo mode —
  Task 2. ✅
- `curate_goldens.py`, pull thumbs-down, propose candidates, require human review, append to
  `golden_set.py` (**by human, not automatically**) — Task 3. ✅

**2. Known gaps carried forward honestly, not silently:**
- The cached-answer case (`run_id: null`) is real and was found during research, not present in the
  batch plan's own §7 text — Task 2 explicitly handles it (no thumbs render), called out so it isn't
  missed.
- Whether `curate_goldens.py` runs in the root or backend venv is genuinely undecided pending a
  concrete look at both requirements files — Task 3 Step 1 makes this an explicit decision point, not
  a guess baked silently into the plan.
- `Client.create_feedback`'s sync-in-async-route blocking risk is flagged and handled
  (`asyncio.to_thread`) rather than copy-pasted from `tracing.py`'s pattern, which doesn't need it
  since it isn't called from a hot network path.

**3. Sequencing**: Tasks 1→2 are a hard dependency (frontend needs the backend route to exist and its
exact request/response shape to build against) — not parallelizable as written. Task 3 is independent
of Tasks 1-2's code (different files entirely) but is conceptually downstream (curating votes that
Task 1/2 haven't produced any real data for yet) — it can be implemented and tested against
mocked/historical LangSmith data before Tasks 1-2 land, but genuinely will not have real thumbs-down
runs to curate until the first production votes come in after this checkpoint ships. Flagging this
now: **if Task 3 turns out to have no real data to validate against in this environment, that's
expected, not a task failure** — say so plainly in its report rather than treating it as blocked.
