# CP71 — final review fixes

Branch `worktree-cp71-chat-ux-overhaul`, on top of `86ab0d5`.

## C1 — popover stole focus and rebound listeners at token rate

Three changes, all needed:

1. `citation-pill.tsx` — `onClose` is now a `useCallback` (`closePopover`) with a stable
   identity, so `CitationPopover`'s listener effect no longer sees a new dependency every render.
2. `citation-popover.tsx` — the mount-only `closeRef.current?.focus()` was split out into its own
   `useEffect(…, [])`, decoupled from the listener effect. The `useCallback` alone would have left
   `focus()` coupled to any future churn of that effect.
3. `pitwall-assistant-panel.tsx` — `MessageBubble` is wrapped in `memo`. `messages.map` re-renders
   every bubble on every `setMessages` (once per streamed token); only the streaming bubble's props
   actually change, so settled bubbles and any popover they own now stay entirely still.

**Verified** in the browser with two answers on screen and a manually-pumped mock SSE stream
(hidden preview tabs throttle timers to a standstill, so the driver advanced the stream itself):

- Popover open on **answer 1** while 60 tokens of answer 2 streamed:
  `focusSteals: 0`, `pointerdownRebinds: 0` (counted by patching `document.addEventListener`),
  popover `getBoundingClientRect()` byte-identical before and after, `document.activeElement`
  still the close button.
- Popover open on the **actively streaming bubble** (its own pill count grew 19 → 24 during the
  test, so it demonstrably re-rendered many times): again `focusSteals: 0`, `rebinds: 0`, rect
  unchanged.

## I2 — popover was outside the panel's focus trap

**Chosen fix: trap Tab inside the popover itself, in capture phase on `document`.** The alternative
— rendering the popover inside `dialogRef`'s subtree — was rejected: the dialog is a `motion.div`
that animates `x`, so it carries a `transform` and would become the containing block for the
popover's `position: fixed`, breaking the anchoring this checkpoint just fixed. Trapping locally is
also strictly less coupling: the popover already owns its own Escape handling for the same reason.

The panel's trap listens on `window` in the bubble phase; the popover's listener is on `document`
in the capture phase, so it runs first and `stopPropagation()` means the panel's handler never sees
a Tab that originated inside an open popover.

**Verified**: with the web-source popover open, a Tab keydown from the close button is not observed
by a window/bubble-phase listener standing in for the panel's trap (`panelTrapSaw: 0`) — so the
panel can no longer `preventDefault()` and jump focus to the header. The popover's focusables are
`["Close citation", "Open source"]` with `href: https://www.formula1.com/`, and Tab from the last
one wraps back: `activeElement` became `Close citation`.

Note: real CDP key dispatch does not reach the page in this environment (the Browser pane is not
compositing frames — the known preview-pane limitation), so Tab was exercised via synthetic
`KeyboardEvent`s, which do run the actual handlers.

## I3 — close now restores focus

`closePopover` nulls the anchor **and** calls `buttonRef.current?.focus()`.
**Verified**: after clicking the close button, `document.activeElement === thePillThatOpenedIt`
(`isThePill: true`, `isBody: false`). Escape does the same, and leaves the panel open
(`panelStillOpen: true`).

## I4 — popover detached on scroll

The `scrollIntoView` that ran alongside opening the popover is gone. The card flash is kept (it
locates the card when it is already visible and moves nothing).
**Verified**: list `scrollTop` was 0 before and 0 after opening a popover whose source card sits
~3000px down a 3225px scroller — previously this jumped the content out from under the popover.

## I5 — viewport-edge clamping

`left` is clamped at click time to `[8, innerWidth − 288 − 8]` (288 = the popover's `w-72`,
kept in a named `POPOVER_WIDTH` constant next to a note that it must track that class).
**Verified** at a 420px viewport: a pill at `left: 711` produced a popover at `left: 124`,
`right: 400.5` — fully on screen, where unclamped it would have ended at 999.

## I6 — `next` unpinned

`frontend/package.json` and the root entry of `package-lock.json` are back to exact `16.1.6`.
Only that one line changed in the lockfile — a full `npm install --package-lock-only` was tried
first and dragged in ~66 lines of unrelated bundled-dependency churn from a newer npm, so it was
reverted. `npm ls next` resolves cleanly to `next@16.1.6`.

## M11 — vestigial aliases

`CitationSnippetPair` and `CitationPopoverSource` deleted; `AgentSnippetPair` / `AgentSource` are
used directly.

## New feature — citation highlighting

Implemented as the **inverse** match the review proposed. The popover's `highlight?: string` prop
became `answerText?: string`; `findHighlightIndex` became `findHighlightedIndices`, returning a
`Set<number>`. The message's full `message.text` reaches the pill through `CitationContext` (which
gained an `answerText` field) and is handed to the popover, which asks which of its own known
snippet values literally appear in the answer (case-insensitive substring).

Noise guards: values shorter than 3 characters and bare integers (`/^\d+$/`) are skipped. Anything
surviving those is specific enough that several simultaneous hits are informative, so all
qualifying pairs are highlighted rather than only the first — the doc comment records this.

**Verified** against a mocked answer reading "Charles Leclerc won the Monaco Grand Prix for
Scuderia Ferrari [ev_1], by 7.152s [ev_1], per the report [ev_2]":

| Snippet value | Highlighted |
|---|---|
| `Monaco Grand Prix` | yes |
| `Charles Leclerc` | yes |
| `1` (Position) | **no** — bare-integer guard |
| `7.152s` | yes |
| `Scuderia Ferrari` | yes |
| `Leclerc ends home curse` (web source) | **no** — not in the answer |

The last two rows are the important ones: the noisy value the plan warned about stays dark, and a
source whose evidence the answer does not quote highlights nothing at all.

## Results

- `cd backend && python -m unittest discover tests` → **Ran 815 tests, OK (skipped=3)**
- `cd frontend && npm run build` → clean
- `cd frontend && npm run lint` → **8 errors, 3 warnings** — exactly the known baseline
  (circuits/page.tsx, schedule/page.tsx, app/page.tsx, app/layout.tsx, drivers-grid.tsx,
  session-tabs.tsx, standings-view.tsx, openf1.ts). Nothing new.
- The throwaway `frontend/src/app/dev-cp71-verify/` route and a temporary `.claude/launch.json`
  were deleted; `git status` shows only the intended files. A stale `.next` route type from the
  deleted route broke the first post-deletion build — `rm -rf .next` and rebuild is clean.
