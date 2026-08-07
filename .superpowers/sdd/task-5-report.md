# CP71 Task 5 — Wire it together, and fix the citation namespace bug

## 5a — Message-scoped citation namespace (the correctness item)

- `rewriteCitations(text, messageId)` now emits `[N](#cite-<messageId>-ev_N)`.
- New `parseCitationHref(href)` inverts it with `/^#cite-(.+)-(ev_\d+)$/` — the
  message segment is greedy and the evidence segment is anchored to the end, so
  it survives message ids containing hyphens (uuids). Today's ids are `m1`,
  `m2`… from the panel's own counter, but a naive `split("-")` would have been a
  latent break the day that changes.
- New `citationAnchorId(messageId, evidenceId)` is the single definition of the
  DOM id; `SourceCard` renders it, `CitationPill` resolves it.
- `SourceCard` gained `position` — its 1-based place in *that message's* source
  list — and shows that number on the card. The pill keeps the evidence's own
  number, so a repeated citation of the same evidence still repeats its number
  (correct behaviour, not the bug).

## 5b — Wiring Tasks 1-4

- `AgentSource` gained `snippet?: AgentSnippetPair[] | null`;
  `citation-popover.tsx`'s local widening collapsed to a re-export.
- Clicking a pill opens `CitationPopover` **and** flashes the matching card.
  The popover is portaled to `document.body`: a `<div role="dialog">` inside a
  markdown `<p>` is invalid HTML (React reported it as a hydration error during
  verification), and the message list is an `overflow-y-auto` scroller that
  would clip an in-flow popover.
- **`highlight` is deliberately not passed.** A pill's `children` is just its
  number; the cited value lives in neighbouring prose, and recovering it from a
  react-markdown child node is guesswork ("P2" in the sentence may not be the
  fact this evidence supports). A wrong highlight is worse than none, so none is
  passed. The prop remains for a call site that genuinely knows.
- Pill and card both take icon/accent/tint from `source-kind.ts`;
  `source-card.tsx`'s local `KIND_ICON` map is gone.
- `ActivityTimeline` and the panel's copy of `ActivityMarker` are **deleted**;
  `ActivityAccordion` replaces them with `settled = Boolean(done || error)`.
  `ElapsedIndicator` now hides its settled branch when the accordion is showing
  (its summary already carries "· 12s") to avoid printing the time twice.

## 5c — New chat

Icon button in the header (34px, matching the close button). Regenerates
`threadId` as well as clearing `messages` — clearing the client alone would be a
lie, since the backend checkpointer keys memory on `thread_id`. A non-empty
thread gets an inline confirmation bar (not `window.confirm`, which would steal
focus out of the dialog's focus trap and be the only unstyled surface in the
panel); an empty thread clears immediately.

## 5d — Markdown

Added `remark-gfm` (a new dependency — `react-markdown` does not parse tables
without it, so 5d was otherwise unimplementable). Prose styling lives in one
`ANSWER_PROSE` constant of descendant variants; tables are wrapped by a
`MarkdownTable` component whose own `overflow-x-auto` container holds the
overflow, plus `min-w-0` on the bubble so the flex child can actually shrink.
Links still route through `CitationPill`'s non-citation fallback branch.

## Verification (headless Chrome, throwaway `/dev-cp71` route, since deleted)

Three answers on screen, each with two sources:

- Card ids: `source-m2-ev_1, source-m2-ev_2, source-m4-ev_1, source-m4-ev_2,
  source-m6-ev_1, source-m6-ev_2` — duplicates: **false**. Before the fix all
  three answers rendered `source-ev_1`/`source-ev_2`.
- Clicking the **third** answer's `ev_1` pill flashed `source-m6-ev_1` (the
  third answer's own card), not `source-m2-ev_1`. That is the reported bug,
  reproduced-by-construction and now closed.
- Card position labels read `1, 2` per message (not the repeated ledger id).
- Popover opened with the real snippet (`Race name / Winner / Results /
  Results · Position`), Escape dismissed the popover only — the panel stayed
  open. No React hydration or console errors.
- Accordions collapsed to "Worked through 2 steps · 12s"; expanding revealed
  "Thinking — routed tier 2 | Queried results".
- New chat: confirmation shown for a non-empty thread, messages cleared on
  confirm, no confirmation on an already-empty thread.
- Markdown: 1 table, 2 `<ol>` items, 2 `<ul>` items, inline code, blockquote,
  external link intact. With cells forced wide (table 1141px inside a 336px
  bubble) the wrapper scrolled and neither the bubble, the message list, nor
  the panel developed horizontal overflow.

`emil-design-eng` pass added an animated (and faster, 120ms vs 180ms) exit for
the confirmation bar and press feedback on its "Keep" button.

## Build + lint

`npm run build` clean. `npm run lint`: 8 errors / 3 warnings, all pre-existing
baseline files (circuits, schedule, app/page, app/layout, drivers-grid,
session-tabs, standings-view, openf1) — nothing new.

## Notes for the next reader

- The repo-root `.claude/launch.json` gained a `cp71-chat-ux-overhaul-frontend`
  entry (port 3133), matching the cp69/cp70 precedent. It is outside the
  worktree and therefore not part of this commit.
- Task 6 (`HANDOFF.md`, recording that 5c reverses CP70's thread-per-open
  decision) is still outstanding.
