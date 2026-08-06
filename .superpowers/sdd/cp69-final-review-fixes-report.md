# CP69 whole-branch review — fixes report

Branch: `worktree-cp69-feedback-loop`, base commit `044a9f4`.

## Important #1 + #2 — no server-side dedupe on `/api/feedback`, double-click race

**Change:** `backend/agent/main.py` now derives a deterministic `feedback_id` from
`run_id` via `uuid.uuid5(_FEEDBACK_NAMESPACE, f"{run_id}:user-score")` and passes it to
`client.create_feedback(..., feedback_id=feedback_id)`. `_FEEDBACK_NAMESPACE` is a fixed,
arbitrary UUID constant (not `uuid.NAMESPACE_DNS`).

**Which parameter name:** checked the installed SDK directly —
`python -c "import langsmith; print(langsmith.__version__)"` → `0.10.15`, and
`inspect.signature(langsmith.Client.create_feedback)` confirms the keyword is
**`feedback_id`** (not `id=`).

**Is this a real fix or documented risk acceptance — be honest:** I could not confirm the
upsert claim, so this is applied as **defense-in-depth, not a proven fix**, and is
documented as an accepted risk in `HANDOFF.md`. Specifically:

- `Client.create_feedback`'s docstring (read via `inspect.getsource`) describes
  `feedback_id` only as "The ID of the feedback to create. If not provided, a random UUID
  will be generated." — it does **not** state that POSTing a second time with the same id
  updates the existing record.
- Reading the method body: the non-multipart path does a plain `POST /feedback` with the
  id in the body; whether the LangSmith backend treats a repeated id as an upsert or an
  error/duplicate is server-side behavior the SDK source doesn't reveal.
  A web search on this specifically found no confirmation either, and surfaced that "the
  feedback endpoint is actually two routes — one for creating... the other for updating."
- The SDK also ships a **separate** `Client.update_feedback(feedback_id, ...)` method
  (confirmed via `inspect.signature`), which is evidence `create_feedback` and updating an
  existing feedback record are treated as distinct operations, not the same call upserting
  on id collision.

Given that, I did not claim in `HANDOFF.md` or code comments that this closes the dedupe
gap. Instead: the deterministic id is applied because it's a plausible, free win if the
backend does dedupe on id (and is harmless if it doesn't — worst case, LangSmith just
accepts a second POST with the same id as it always did with a random one), and
`HANDOFF.md`'s CP69 paragraph now explicitly says server-side vote dedupe remains an
**accepted risk**, appropriate for a telemetry-only, fail-soft, already-unauthenticated
endpoint — matching the task's fallback path rather than the "real fix" path.

**Tests added** in `backend/tests/test_agent_feedback.py`:
- `test_valid_thumbs_up_records_via_langsmith` now also asserts `feedback_id` is passed
  and matches the expected `uuid5` derivation.
- New `FeedbackIdIsDeterministicTests`: `test_same_run_id_always_derives_the_same_feedback_id`
  (two calls with the same `run_id` produce identical `feedback_id`s, checked against the
  mocked `create_feedback` call args) and `test_different_run_ids_derive_different_feedback_ids`.

No frontend change was made (no ref-based synchronous "disabled" guard added to
`feedback-controls.tsx`) — the task's specified fix for both Important findings was the
single server-side `feedback_id` derivation, which the double-click race motivates but
does not require a separate client-side change.

## Minor #1 — dead `.get("answer", "")` in `scripts/curate_goldens.py`

Added a comment above line 112 (now ~114) explaining `traced_run`'s outputs
(`tracing.end(run, {...})` in `main.py`) never include an `"answer"` key today — only
`mode`, `chars`, `evidence`, `tier`, `verification`, `verification_violations` — so this
lookup always returns `""` currently. Marked as defensive/aspirational for a future
`traced_run` shape change, not a live bug. No behavior change.

## Minor #2 — undocumented reasoning for `FeedbackRequest.run_id` being required

Added a comment on `run_id` in `FeedbackRequest` (`backend/agent/main.py`) explaining it's
deliberately required (not `Optional[str]`): null/missing gets a 422, not a soft
`{"recorded": false}`, because `FeedbackControls` never renders/submits without a truthy
`run_id`, so a null caller is a client bug worth surfacing. Explicitly references
`test_agent_feedback.py`'s `test_null_run_id_is_a_pydantic_422_and_calls_nothing`, whose
docstring carries the same reasoning — matched rather than reinvented.

## Documentation gap — HANDOFF.md

Added a paragraph to the CP69 section of `HANDOFF.md` (after the paragraph closing the
CP65 deferral) stating plainly that server-side vote dedupe remains an accepted risk, not
a proven fix, and summarizing why (SDK docstring silent on upsert-by-id, separate
`update_feedback` method as evidence create/update are distinct operations), plus why it's
acceptable for this endpoint (telemetry-only, fail-soft, unauthenticated).

## Verification

- `cd backend && python -m unittest discover tests` → `Ran 791 tests in 1.910s / OK (skipped=3)`
- `cd scripts && python -m unittest discover tests` → `Ran 56 tests in 1.257s / OK`
- `cd frontend && npm run build` → compiled successfully, all routes generated
- `cd frontend && npm run lint` → 8 errors / 3 warnings, all in files this branch does not
  touch (`circuits/page.tsx`, `layout.tsx`, `page.tsx`, `schedule/page.tsx`,
  `drivers-grid.tsx`, `session-tabs.tsx`, `standings-view.tsx`, `lib/openf1.ts`) — matches
  the stated pre-existing baseline exactly, no new errors introduced.

## Files changed

- `backend/agent/main.py`
- `backend/tests/test_agent_feedback.py`
- `scripts/curate_goldens.py`
- `HANDOFF.md`
