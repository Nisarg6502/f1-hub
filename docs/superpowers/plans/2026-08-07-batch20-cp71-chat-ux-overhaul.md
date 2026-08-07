# CP71 — Chat UX overhaul: real visual citations, session control, collapsing activity

Batch 20, checkpoint 1. Batch 19 (CP67-70) shipped the *plumbing* for citations, narration and
polish; this checkpoint fixes what that plumbing actually looks and feels like in the user's hands.
The answers are good — the surface around them is not.

## Root causes, confirmed in code before planning

Two of the reported symptoms are the **same bug**, and it is not cosmetic:

**Evidence ids are per-message, but they are rendered into a document-global namespace.**
Every turn builds a fresh `EvidenceLedger` starting at `ev_1`, so `citation()["id"]` is `ev_1` for
the first source of *every* answer. `SourceCard` (`source-card.tsx:41`) renders
`id={`source-${source.id}`}` and `CitationPill` (`citation-pill.tsx:32`) resolves it with
`document.getElementById(`source-${evidenceId}`)`. With three answers on screen there are three
elements with `id="source-ev_1"`; `getElementById` returns the **first in document order** — the
oldest answer. That is exactly the reported "clicking a citation scrolls up to a previous answer."
It also explains the "1 1 1 1" numbering: `n` is the ledger's own per-message counter, so every
answer's citations restart at 1, and a single answer citing `[ev_1]` repeatedly renders `1 1 1 1`.
**Fix: namespace every DOM id and every `href` by message id**, not just evidence id. This is a
correctness fix, not styling, and everything else in this checkpoint depends on it working.

**The activity timeline never collapses.** `ActivityTimeline`
(`pitwall-assistant-panel.tsx:716-740`) renders the full activity list unconditionally, with no
awareness of whether the turn finished. Live production SSE confirms `"Thinking…"` *does* receive its
matching `state: "done"` event, so this is not a missing-event problem — the component simply has no
"the answer is here, get out of the way" state.

**Citations are not inspectable.** `citation()` (`ledger.py:98-142`) exposes `id`/`n`/`kind`/`label`/
`title`/`url`/`as_of` — everything *about* the evidence, and none of the evidence itself. The ledger
holds the actual payload in `Evidence.data`, but nothing ever surfaces it, so there is no way to
build "click the citation and see the fact it rests on." That data needs to reach the client.

## Scope

1. **Correctness**: per-message citation namespacing (kills the wrong-scroll and the `1 1 1 1`).
2. **Inspectable citations**: click a pill → a popover showing the actual supporting evidence, with
   the cited value highlighted, plus source kind, freshness and a real link for web sources.
3. **Source-matched visual identity**: a `data` citation from Mongo, a `web` citation and a
   `wikipedia` citation must be visually distinguishable at a glance — in the pill, the card and the
   popover — driven by one shared source-kind definition, not three divergent copies.
4. **Session control**: a "New chat" / clear-conversation affordance. Note this **reverses CP70's
   documented decision** to keep thread-per-open with no reset affordance — that decision explicitly
   said "revisit only if a future checkpoint has a concrete reason," and the user asking for it is
   that reason. Update `HANDOFF.md`'s note rather than silently contradicting it.
5. **Collapsing activity**: the timeline collapses to a one-line summary once the answer lands,
   expandable on click. No stale "Thinking…" next to a finished answer.
6. **Markdown quality**: `ReactMarkdown` is already wired, but the prose styling is unstyled-default.
   Tables, lists, code, headings and emphasis need to actually look right inside a chat bubble.

## Parallelization

Tasks 1-4 touch **disjoint files** and are dispatched simultaneously. Task 5 wires them together and
is the only one that edits `pitwall-assistant-panel.tsx`, so it runs alone, last. Task 6 is docs.

| Task | Files | Parallel? |
|---|---|---|
| 1 | `backend/agent/ledger.py` + its tests | ✅ backend-only |
| 2 | `frontend/src/lib/source-kind.ts` (new) | ✅ new file |
| 3 | `frontend/src/components/citation-popover.tsx` (new) | ✅ new file |
| 4 | `frontend/src/components/activity-accordion.tsx` (new) | ✅ new file |
| 5 | `pitwall-assistant-panel.tsx`, `citation-pill.tsx`, `source-card.tsx`, `agent-api.ts` | ❌ sequential, last |
| 6 | `HANDOFF.md` | ❌ after 5 |

Every UI task must invoke `emil-design-eng` before finalizing, per `ROADMAP.md`'s standing mandate.

---

## Task 1 — Backend: citations carry an inspectable snippet

**Files:** `backend/agent/ledger.py`, `backend/tests/test_agent_ledger.py`

`Evidence.citation()` gains **`snippet: list[dict]`** — a small, ordered list of
`{"label": str, "value": str}` pairs rendered from `self.data`, so the client can show the actual
supporting fact rather than only its provenance.

Rules, all of which need tests:
- **Cap it.** At most 6 pairs, each value truncated to ~120 chars. This ships on every SSE `sources`
  event; an uncapped race payload (1000+ lap rows) would blow the frame.
- **Flatten shallowly.** Top-level scalars become pairs directly. A top-level list of dicts (e.g.
  `results`) contributes its first entry's most useful scalars, prefixed. Nested structures deeper
  than that are summarised (`"12 items"`), never dumped.
- **Humanise keys.** `race_name` → `Race name`. Snake-case to sentence-case, no raw keys leaking.
- **Never crash on shape.** An empty `data`, a `None`, a bare string, a list-at-root: all must return
  a sane (possibly empty) list, never raise. The ledger is on the answer path — a formatting error
  here must not fail an otherwise-good turn.
- Keep `ledger.py` framework-free (no LangChain/LangGraph imports) — the existing hard rule.
- All seven existing citation keys keep their current values byte-for-byte; this is purely additive.

Run `cd backend && python -m unittest discover tests`, all must pass. Commit:
`feat(agent): CP71 citations carry an inspectable evidence snippet`

---

## Task 2 — Shared source-kind visual definition

**Files:** `frontend/src/lib/source-kind.ts` (new)

One module exporting, per kind (`data` | `web` | `wikipedia`), the icon, accent colour, short label
("Database" / "Web" / "Wikipedia") and a compact description. Everything else — pill, card, popover —
imports from here, so the three surfaces cannot visually drift apart.

Use this codebase's existing design tokens (`var(--color-primary)`, `--color-secondary`, the APEX
warm palette in `globals.css`) rather than inventing hex values, and Material Symbols icon names
consistent with `source-card.tsx`'s current usage. Must be a pure module — no JSX, no React import —
so it is trivially importable from anywhere. Export a typed helper `sourceKindStyle(kind)` with a
safe fallback for an unrecognised kind (the union can grow backend-side; the UI must not crash).

Invoke `emil-design-eng` on the accent/icon choices: the three kinds must be distinguishable at
14px, in both light and dark, without relying on colour alone (icon shape carries it too).

Commit: `feat(agent-ui): CP71 shared source-kind visual definitions`

---

## Task 3 — `CitationPopover`

**Files:** `frontend/src/components/citation-popover.tsx` (new)

Renders one citation's full detail: kind badge (from Task 2), human title, the `snippet` pairs from
Task 1 as a compact key/value list, the `as_of` freshness via the existing `LocalDateTime` component
(reuse it — do not rebuild), and, for `web`/`wikipedia`, a real external link.

**Highlighting**: the component accepts an optional `highlight?: string` (the cited value the pill
sits next to) and visually emphasises any snippet value matching it. Match on trimmed,
case-insensitive equality **or** substring containment, and highlight at most the first match — a
naive global highlight of a common short value ("1", "P2") would light up the whole popover and read
as noise.

Reuse this codebase's established liquid-glass popover pattern (`bg-[rgba(26,22,19,0.98)]`,
`border border-white/10`, `motion/react` for enter/exit, click-outside + Escape to dismiss) as used
by `feedback-controls.tsx` and `tire-stints-chart.tsx` — do not introduce a new popover primitive.
Must be keyboard-dismissible and focus-managed, matching what CP70's accessibility work established.

Props are pure data in / callbacks out (`{ source, highlight?, onClose }`) so this task stays
independent of Task 5's wiring. Invoke `emil-design-eng` before finalizing.

Commit: `feat(agent-ui): CP71 CitationPopover shows the evidence behind a citation`

---

## Task 4 — `ActivityAccordion`

**Files:** `frontend/src/components/activity-accordion.tsx` (new)

Replaces the always-expanded timeline. Two states, driven by a `settled: boolean` prop:

- **In flight** (`settled === false`): behaves like today — steps visible as they stream, so the user
  sees progress during a 30-60s answer. This is the part that must *not* regress.
- **Settled** (`settled === true`): collapses to a single summary row — e.g. "Looked at 3 sources ·
  12s" with a chevron — expandable on click to reveal the full step list. Default collapsed.

Takes `{ activity, settled, elapsedLabel? }` and renders the same tool/agent/system marker
distinction CP70 established (import or re-implement consistently — check `pitwall-assistant-panel`'s
current `ActivityMarker` and keep the visual language identical; if it is cleanly extractable, prefer
moving it here over duplicating it).

The collapse must animate (height/opacity via `motion/react`, already a dependency) rather than
snapping, and must respect `prefers-reduced-motion` — `globals.css` already has a reduced-motion
block to follow. Invoke `emil-design-eng` (and `animate` if useful) on the collapse timing/easing.

Commit: `feat(agent-ui): CP71 ActivityAccordion collapses the timeline once an answer lands`

---

## Task 5 — Wire it together, and fix the citation namespace bug

**Files:** `pitwall-assistant-panel.tsx`, `citation-pill.tsx`, `source-card.tsx`, `agent-api.ts`
**Runs alone, after Tasks 1-4 land.**

**5a — The namespace fix (do this first, it is the correctness item).**
`rewriteCitations(text)` becomes `rewriteCitations(text, messageId)`, emitting
`[N](#cite-<messageId>-ev_N)`. `CitationPill` parses the message-scoped id and resolves
`source-<messageId>-ev_N`; `SourceCard` renders that same id. Result: clicking a citation in answer 3
can no longer scroll to answer 1. Verify explicitly with **at least three answers on screen** — this
bug is invisible with one.

Also fix the visible numbering: render each source card with its **position within that message's
source list** so a reader sees 1, 2, 3 down the card list rather than a repeated ledger id. Keep the
pill's number tied to the evidence it actually cites (a genuinely repeated citation of the same
evidence *should* show the same number — that is correct behaviour, not the bug; the bug was every
answer restarting at 1 in a shared namespace).

**5b — Wire Tasks 1-4.** `AgentSource` gains `snippet`. Pills open the `CitationPopover` (Task 3)
instead of only scrolling. `SourceCard` and the pill both pull their visuals from `source-kind.ts`
(Task 2). `ActivityTimeline` is replaced by `ActivityAccordion` (Task 4), with `settled` derived from
`message.done || message.error`.

**5c — New chat.** A "New chat" control in the panel header that clears `messages` and regenerates
`threadId`. Confirm before discarding a non-empty conversation (a one-tap wipe of a long thread with
no undo is a bad trade); no confirmation needed when the thread is already empty. This reverses
CP70's thread-per-open decision — Task 6 records that.

**5d — Markdown.** Style the `ReactMarkdown` output properly inside the bubble: tables (scrollable on
overflow, not bleeding the panel width), ordered/unordered lists, `code`/```code blocks```,
headings, bold/italic, blockquotes, and links (which must keep routing through `CitationPill`'s
non-citation fallback branch). Verify with an answer containing a table and a list.

Verify in the browser: three-answer citation cross-linking, popover open/highlight/dismiss, accordion
collapse after completion, new-chat clear, markdown table/list rendering. Use the established
throwaway-mocked-route pattern if a live backend is not reachable, and delete it before committing.
`npm run build && npm run lint` clean against the known baseline.

Commit: `feat(agent-ui): CP71 message-scoped citations, popovers, accordion, new chat, markdown`

---

## Task 6 — Record the reversed decision

**Files:** `HANDOFF.md`

CP70 recorded "thread-per-open, kept as-is, revisit only with a concrete reason." CP71 supplies the
reason (direct user request) and adds an explicit reset affordance. Update that note so the next
reader sees a decision that *changed* with its trigger, not two docs contradicting each other.

Commit: `docs: CP71 reverses CP70's thread-persistence decision, with the reason`

---

## Self-review

**Scope coverage against the request:** visual citations with click-to-inspect + highlights (Tasks
1/3/5b) ✅; source-matched visuals (Task 2) ✅; `1 1 1 1` + wrong-scroll (Task 5a — root-caused, not
guessed) ✅; clear/new chat (Task 5c) ✅; thinking-collapses-after-answer (Task 4) ✅; markdown
(Task 5d) ✅.

**Honest gaps:** "great chat experience" is open-ended — this checkpoint targets the six concrete
defects named. Anything surfaced during implementation that is *not* one of those (e.g. message
grouping, retry affordance placement) should be reported, not silently absorbed into scope.

**Risk:** Task 5 is large and touches the most-churned file in the project. Tasks 1-4 landing first
as independently-reviewable units is what keeps it tractable — if Task 5 needs to be split during
implementation, split it rather than shipping one unreviewable commit.
