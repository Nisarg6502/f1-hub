# CP70 — Chat UX polish

Batch 19, checkpoint 5 of 6 and the final implementation checkpoint (CP67 guardrails, CP68 visual
citations, CP69 feedback loop all ✅ merged). Per `BATCH-19-PLAN.md` §8, this is a grab-bag of small,
independent UI/UX fixes to `frontend/src/components/pitwall-assistant-panel.tsx` — grouped last
because none of them block each other. Per `ROADMAP.md`, `emil-design-eng` must be invoked before
finalizing any visual/interaction work in every task below.

## Context this plan relies on

- **`pitwall-assistant-panel.tsx` is 453 lines and already growing via sibling extraction** —
  CP68/69 pulled `citation-pill.tsx`, `source-card.tsx`, `feedback-controls.tsx` out as the file grew.
  This checkpoint continues that precedent: `ActivityMarker`/`ActivityTimeline`/`StatusFooter` are
  self-contained and unrelated to the new work, and the new auto-scroll/composer-toolbar logic is
  substantial enough to warrant its own files rather than growing this one further.
- **No SSE heartbeat exists.** `sse.comment()` (`backend/agent/sse.py:115-129`) is fully implemented
  but nothing calls it. `main.py`'s `_stream` (starts line ~142) is a single linear async generator
  with no periodic/concurrent emit mechanism to hook into — a heartbeat must be built from scratch,
  racing `_answer`'s next event against a timeout (`asyncio.wait_for` around the iterator's
  `__anext__`, or a background task feeding a queue `_stream` also drains) and yielding
  `sse.comment()` on timeout before continuing. The queue-wait period (lines ~240-266) is just as
  capable of going silent as the model-thinking period and needs the same treatment.
- **The frontend SSE parser already tolerates a heartbeat for free.** `agent-api.ts`'s `parseFrame`
  only extracts frames with an `event:` line; a bare `: heartbeat\n\n` comment has none, so the parse
  loop naturally returns `null` and is skipped with zero client changes needed for the wire format
  itself. Only the elapsed-timer *display* needs new client code, and it's purely local
  (`Date.now()` at submit time, re-rendered every second while running) — it does not need the
  heartbeat to exist at all; the two features are independent even though the batch plan groups them.
- **The raw "Failed to fetch" bug is still reachable today.** `ask`'s network-level `.catch`
  (`panel.tsx:190-196`) sets `error.message` directly from the browser's `Error.message` — for an
  actual network failure that literal string is `"Failed to fetch"`, i.e. the exact live bug fixed
  reactively at the start of this session is still one flaky connection away from recurring, because
  it was fixed at the infra layer (CORS) that one time, not built out of the UI. Everything that
  arrives as a coded SSE `error` event (`AgentErrorCode`: `at_capacity`, `timeout`, `upstream`,
  `bad_request`, `refused`, `internal`) already gets proper handling via `dispatch`'s `onError` — only
  the pre-connection catch-block path is raw. This task fixes the UI-layer gap for good, independent
  of whatever caused this session's original CORS incident.
- **Retry needs the original question text retained on the assistant message.** `Message` currently
  has no back-reference to its paired user question. `ask` already closes over the trimmed question
  text at submit time — the simplest fix is storing `question: trimmed` directly on the assistant
  `Message` object at creation, not threading a second data structure through.
- **Suggested prompts are static and page-blind.** Hardcoded `SUGGESTIONS` array at
  `panel.tsx:79-83`, rendered unconditionally pre-first-message. The actual spec (the batbatch plan's
  own §11 cross-reference is stale/wrong — the real source is `CHAT-AGENT-PLAN.md`'s own §11
  "Frontend" section, one sentence: *"Suggested prompts seeded per page context"*) needs page
  awareness. `usePathname()` from `next/navigation` is already an established pattern in this
  codebase (`nav-links.tsx`) and works cleanly here since `PitwallAssistantPanel` is a client
  component — no new prop plumbing through the server-component `layout.tsx` needed.
- **Thread-per-open is a deliberate, documented design choice, not a bug.** `threadId =
  useRef(crypto.randomUUID())` (`panel.tsx:100`) and `pitwall-assistant-launcher.tsx`'s own docstring
  both explicitly justify "fresh conversation every open" over "indefinitely-growing thread." Per the
  batch plan's own flag, **this task treats it as an explicit decision to confirm, not a silent
  behavior change** — Task 5 below documents the choice rather than assuming persistence should ship.
- **No focus-trap library exists in this codebase's dependencies.** Implementing keyboard focus
  containment for the dialog needs either a hand-rolled Tab-cycle listener or a new dependency
  decision — this plan defaults to hand-rolling (small, well-understood pattern, avoids a new
  dependency for one feature), but flags the alternative explicitly in Task 6.
- **The existing liquid-glass popover pattern** (`bg-[rgba(26,22,19,0.98)] border border-white/10`,
  `motion/react`-animated, click-outside+Escape — already used by the panel itself and by
  `MessageBubble`'s bubble background) is the right precedent for any new popover this checkpoint
  introduces (e.g. a copy/regenerate button cluster, if given a dropdown treatment rather than inline
  icons).
- Per `BATCH-19-PLAN.md` §9, CP70 is sequential after CP69 (already true — this worktree branches
  from post-CP69-merge `main`) and is **not parallelizable internally against itself in the naive
  sense either**: every task below edits `pitwall-assistant-panel.tsx`. Unlike CP69's Tasks 1/3
  (genuinely disjoint files), CP70's tasks share one file and must be sequential, EXCEPT Task 2's
  backend heartbeat half (`backend/agent/sse.py`/`main.py`) — that is backend-only and touches no
  frontend file, so it can run in parallel with any one frontend-only task.

## Task 1: Auto-scroll while streaming

**Files:**
- Modify: `frontend/src/components/pitwall-assistant-panel.tsx`

**Interfaces:**
- The message-list container gains a ref and a scroll-tracking effect. A new `isAtBottomRef`
  (or state, if re-render-driven behavior is cleaner given this file's existing patterns — check
  whether `patch()`-style state or a ref better fits how scroll position is currently read, since a
  ref avoids re-rendering on every scroll tick) tracks whether the user is following the stream.

- [ ] **Step 1**: Read the current message-list container (`panel.tsx:247` per research, confirm
  live) and the streaming-message update path (`onToken`/`patch` for the in-flight assistant
  message) to find the right effect dependency (new token content length, or a simpler "message
  array reference changed" trigger).
- [ ] **Step 2**: Add a container `ref`. Add a scroll listener setting `isAtBottomRef.current =
  scrollTop + clientHeight >= scrollHeight - THRESHOLD` (pick `THRESHOLD` ~48px, a small forgiving
  band, not exact-pixel equality).
- [ ] **Step 3**: Add an effect keyed on the streaming message's content that calls
  `container.scrollTo({ top: container.scrollHeight, behavior: "smooth" })` (relying on
  `globals.css`'s existing `scroll-behavior: smooth`, already reduced-motion-aware) **only if**
  `isAtBottomRef.current` is true. A user who scrolls up mid-stream stops auto-follow until they
  scroll back to the bottom themselves or send a new message (a new message send should
  unconditionally re-enable follow and scroll to bottom, since the user just took an action implying
  they want to see the response).
- [ ] **Step 4**: Verify in the browser with a mocked long-streaming response (reuse the
  dynamic-import-mocked-`streamChat` throwaway-route pattern CP68/69 established — delete before
  commit): confirm auto-follow during streaming, confirm scrolling up stops it, confirm sending a new
  message resumes it.
- [ ] **Step 5**: `npm run build && npm run lint` from `frontend/`.
- [ ] **Step 6**: Commit: `feat(agent-ui): CP70 auto-scroll follows the stream, stops if the user scrolls up`

---

## Task 2: Elapsed timer + SSE heartbeat

**Files:**
- Modify: `backend/agent/main.py` (heartbeat emission around `_answer`'s loop and the queue-wait
  period)
- Modify: `backend/tests/test_agent_main.py` (or wherever `_stream`'s tests live — confirm)
- Modify: `frontend/src/components/pitwall-assistant-panel.tsx` (elapsed-timer display — purely
  client-side, independent of the backend half)

**Interfaces:**
- Backend: a periodic `sse.comment("heartbeat")` emitted whenever no real event has been produced
  for N seconds (pick N=15s — comfortably under common intermediary idle-timeouts, generous enough
  not to spam a fast turn). Must not alter the SSE event sequence's meaning — comments are already
  invisible to `parseFrame`, so this is purely additive on the wire.
- Frontend: a local elapsed-seconds counter, ticking every second from question-submit until `done`
  fires, rendered somewhere in the assistant message's in-progress area (near `ActivityTimeline` or
  `StatusFooter` — pick whichever placement doesn't crowd the existing layout, confirm visually
  before committing).

- [ ] **Step 1 (backend)**: Read `main.py`'s `_stream` and the `async for event in _answer(...)` loop
  in full. Design the heartbeat as a wrapper: race each `__anext__()` call against
  `asyncio.wait_for(..., timeout=15)`; on `asyncio.TimeoutError`, `yield sse.comment("heartbeat")` and
  retry the same pending iterator call rather than losing the in-flight event. Apply the identical
  pattern to the queue-wait loop. Write this as a small reusable async generator wrapper if it's
  needed in two places, rather than duplicating the timeout logic.
- [ ] **Step 2 (backend)**: Write a test asserting that a slow-to-yield mocked `_answer` (sleeps
  past the heartbeat threshold before yielding its first real event) produces at least one
  `sse.comment` frame before the real event arrives, and that the real event still arrives intact
  afterward (nothing is dropped or reordered). Follow this file's existing mocking pattern for
  `_answer`/the scripted-agent fixture rather than inventing a new one.
- [ ] **Step 3 (backend)**: Implement, run the test, then the full backend suite (`cd backend &&
  python -m unittest discover tests`) — all PASS, no regression to existing `_stream` timing/ordering
  tests.
- [ ] **Step 4 (frontend)**: Add elapsed-seconds tracking: on question submit, record
  `Date.now()`; a `setInterval`/`requestAnimationFrame`-driven tick (prefer `setInterval(1000)` for
  a plain counter, no need for rAF smoothness here) updates a displayed `Xs` counter while the
  turn is in flight, cleared on `done`/`error`. Reuses `AgentDone.elapsed_ms` (already present) for
  the final settled figure once `done` arrives, rather than trusting the client clock past that point.
- [ ] **Step 5**: Verify in the browser (mocked slow-stream route) that the timer increments once per
  second and stops/settles correctly on completion or error.
- [ ] **Step 6**: `npm run build && npm run lint` from `frontend/`.
- [ ] **Step 7**: Commit backend and frontend halves separately (they're independently useful and
  independently revertable): `feat(agent): CP70 SSE heartbeat keeps long-running turns alive` then
  `feat(agent-ui): CP70 elapsed-time indicator while a turn is in flight`.

---

## Task 3: Copy answer, regenerate, retry-on-error with human error copy

**Files:**
- Modify: `frontend/src/components/pitwall-assistant-panel.tsx`
- Modify: `frontend/src/lib/agent-api.ts` (if a shared error-code→copy map belongs there rather than
  inline in the component — check `AgentErrorCode`'s existing location and keep the mapping close to
  the type it maps)

**Interfaces:**
- `Message` gains `question: string | null` on assistant messages (the paired user question text,
  captured at creation for retry).
- A human-readable error-copy map keyed by the existing `AgentErrorCode` union, PLUS a fallback path
  for the raw network-catch case (`error.code === "network"` or similar) that no longer surfaces the
  browser's literal `Error.message`.

- [ ] **Step 1**: Read `ask`'s full implementation (submit → SSE handlers → catch block) and
  `MessageBubble`'s error-rendering branch (`message.error`) to confirm exact current shape.
- [ ] **Step 2**: Write the error-copy map, e.g.:
```typescript
const ERROR_COPY: Record<string, string> = {
  at_capacity: "The assistant is busy right now — try again in a moment.",
  timeout: "That took too long to answer. Try again, or ask something more specific.",
  upstream: "Something went wrong reaching the model. Try again shortly.",
  bad_request: "That request couldn't be processed — try rephrasing your question.",
  refused: "", // refused already carries its own user-facing message from the backend, don't override it
  internal: "Something went wrong on our end. Try again.",
  network: "Couldn't reach the assistant — check your connection and try again.",
};
```
Confirm against the actual current `AgentErrorCode` union and `refused`'s existing message-passthrough
behavior (CP67 added `refused` specifically to carry a real user-facing refusal message — do not
clobber it with generic copy).
- [ ] **Step 3**: Update the network-catch block to set a coded error (`code: "network"`) instead of
  passing the raw `Error.message` through, and update `MessageBubble`'s error rendering to look up
  `ERROR_COPY[message.error.code]` with a sane final fallback string if a code is ever missing from
  the map.
- [ ] **Step 4**: Add a "Retry" action on error messages (`onClick={() => ask(message.question)}`,
  requires `question` to be captured per the Interfaces section) and a "Copy" action on completed
  answer messages (`navigator.clipboard.writeText(message.text)`, with a brief visual
  confirmation — check-mark swap for ~1.5s, following the same transient-feedback pattern
  `CitationPill`'s flash class already established). Add a "Regenerate" action alongside Copy on a
  successful answer, functionally identical to Retry (`ask(message.question)` again).
- [ ] **Step 5**: Invoke `emil-design-eng` for the icon-button cluster's placement, sizing, and hover/
  press states before finalizing.
- [ ] **Step 6**: Verify in the browser: trigger a mocked network failure and a mocked coded error,
  confirm human copy renders (not raw `Error.message`); click Retry, confirm it resubmits the
  original question; click Copy on a real answer, confirm clipboard contents and the transient
  confirmation UI; click Regenerate, confirm a fresh answer request fires.
- [ ] **Step 7**: `npm run build && npm run lint` from `frontend/`.
- [ ] **Step 8**: Commit: `feat(agent-ui): CP70 copy, regenerate, and retry with human-readable error copy`

---

## Task 4: Contextual suggested prompts per page

**Files:**
- Modify: `frontend/src/components/pitwall-assistant-panel.tsx`

**Interfaces:**
- Replace the flat `SUGGESTIONS` array with a `pathname → suggestions[]` lookup, using `usePathname()`
  (already an established pattern via `nav-links.tsx`) with a generic fallback for any unmatched
  route.

- [ ] **Step 1**: Enumerate this app's actual page routes (check `frontend/src/app/` structure —
  race/session pages, driver pages, standings, schedule, circuits, compare) to build a sensible
  `pathname`-pattern → 3-suggestion mapping. Match on route *shape* (e.g. a dynamic race/session
  segment) rather than exact pathnames, since race/driver pages are dynamically routed.
- [ ] **Step 2**: Implement a small `suggestionsForPath(pathname: string): string[]` pure function
  (easy to unit-test if a runner exists per CP68 Task 4's precedent-check; otherwise verify via the
  browser only, matching that same established fallback).
- [ ] **Step 3**: Wire `usePathname()` into `PitwallAssistantPanel`, replacing the static array with
  `suggestionsForPath(pathname)`.
- [ ] **Step 4**: Verify in the browser across at least three different route shapes (home/generic,
  a race page, a driver page) that suggestions actually change.
- [ ] **Step 5**: `npm run build && npm run lint` from `frontend/`.
- [ ] **Step 6**: Commit: `feat(agent-ui): CP70 suggested prompts vary by the current page`

---

## Task 5: Thread persistence — decision, not silent default

**Files:**
- Modify: `docs/superpowers/plans/2026-08-06-batch19-cp70-chat-ux-polish.md` (this file, or a short
  ADR-style note if this codebase has a convention for one — check) recording the decision
- Possibly modify: `frontend/src/components/pitwall-assistant-panel.tsx` /
  `pitwall-assistant-launcher.tsx`, only if the decision is "change it"

- [ ] **Step 1**: This is a product decision, not an engineering one — the plan defaults to
  **keeping current behavior** (fresh thread per open) unless the human running this checkpoint
  overrides that call, since both existing docstrings justify it deliberately and changing it has
  real tradeoffs (an indefinitely-growing thread, unclear "clear conversation" affordance if removed).
  **Do not silently implement persistence** — if executing this task, stop and surface the choice
  explicitly (e.g. via the same means CP68/69 flagged worktree/merge decisions) rather than assuming
  either answer.
- [ ] **Step 2 (only if the decision is "add persistence")**: Store `threadId` in
  `sessionStorage` (survives close/reopen within a tab, not across browser restarts — a deliberately
  conservative middle ground) keyed by a stable constant, read on mount instead of always generating
  fresh. Add an explicit "New conversation" affordance so the user isn't stuck with no way to reset
  once persistence exists.
- [ ] **Step 3**: Document whichever outcome in `HANDOFF.md`'s CP70 section so this isn't silently
  re-litigated in a future checkpoint.

---

## Task 6: Accessibility — `aria-live`, focus trap, open shortcut

**Files:**
- Modify: `frontend/src/components/pitwall-assistant-panel.tsx` (`aria-live`, focus trap)
- Modify: `frontend/src/components/pitwall-assistant-launcher.tsx` (open keyboard shortcut)

**Interfaces:**
- The streaming-answer container gets `aria-live="polite"` (not `"assertive"` — a chat answer
  streaming in shouldn't interrupt whatever the screen reader is currently announcing) and
  `aria-atomic="false"` so incremental token updates are announced incrementally rather than the
  whole block being re-read on every token.
- A hand-rolled focus trap on the dialog (no new dependency, per this plan's default — flag the
  alternative of adding a focus-trap library if the hand-rolled version proves fiddly during
  implementation, and surface that tradeoff rather than silently picking one).
- A global keyboard shortcut (suggest `Cmd/Ctrl+K` or `/`, consistent with other product UIs' common
  convention — pick one and note the choice, since neither is specified by the plan) opens the panel
  from anywhere the launcher is mounted.

- [ ] **Step 1**: Add `aria-live="polite" aria-atomic="false"` to the streaming-text container
  (`panel.tsx`'s answer `<ReactMarkdown>` wrapper).
- [ ] **Step 2**: Implement a focus trap: on dialog open, capture the previously-focused element;
  a keydown listener on Tab (already has an Escape listener at `panel.tsx:104-119` to extend/sit
  alongside) cycles focus between the dialog's first and last focusable elements; on close, restore
  focus to the captured element.
- [ ] **Step 3**: Add a keydown listener in `pitwall-assistant-launcher.tsx` (which owns `open`
  state) for the chosen open-shortcut, guarding against firing while focus is inside a text input/
  textarea elsewhere on the page (standard shortcut-hygiene check — read how, if at all, this
  codebase already guards other global shortcuts, if any exist, before inventing a new guard pattern).
- [ ] **Step 4**: Invoke `emil-design-eng` (and `apple-design` if the shortcut/focus-trap gets any
  motion treatment) before finalizing.
- [ ] **Step 5**: Verify via keyboard-only navigation in the browser: open via shortcut, Tab through
  the dialog confirming focus stays contained, Escape closes and restores focus to the launcher
  button, `aria-live` announces streaming content (verify via the accessibility tree /
  `read_page`, not just visually).
- [ ] **Step 6**: `npm run build && npm run lint` from `frontend/`.
- [ ] **Step 7**: Commit: `feat(agent-ui): CP70 keyboard shortcut, focus trap, and live-region streaming for accessibility`

---

## Self-Review

**1. Spec coverage against `BATCH-19-PLAN.md` §8**: all six bullet items map 1:1 to Tasks 1-6. ✅

**2. Known gaps carried forward honestly:**
- The batch plan's own line-number citations for `sse.py`, `panel.tsx:79`, and its "§11" cross-
  reference were found stale/wrong during research (real locations differ, real spec source is
  `CHAT-AGENT-PLAN.md` not `BATCH-19-PLAN.md`) — corrected here rather than propagated.
- Task 5 (thread persistence) is deliberately **not** a build-it task by default — it's a decision
  gate, matching the batch plan's own "a decision to make, not assumed" flag. Executing this task
  without pausing to confirm the choice would be a scope overstep.
- Task 6's focus-trap approach (hand-rolled vs. new dependency) is a judgment call flagged for the
  implementer to revisit if it proves awkward, not a settled architectural decision.

**3. Sequencing**: Tasks 1, 3, 4, 6 all edit `pitwall-assistant-panel.tsx` and must run sequentially
against each other. Task 2's backend half (`main.py`/`sse.py`) touches no frontend file and can run
in parallel with exactly one frontend-only task at a time (not more, since the frontend tasks
themselves aren't mutually parallel). Task 5 is a short decision-and-document step, cheap to slot in
wherever convenient. Task 2's frontend half depends on nothing from the other frontend tasks and could
be reordered, but is grouped with Task 2's backend half here for commit-message clarity (elapsed timer
+ heartbeat are one conceptual feature even though they're technically independent).
