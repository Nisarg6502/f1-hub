# Batch 24 — the second screen, and a round of UI debt

Written 2026-08-18 ~23:30 IST. Like `BATCH-23-PLAN.md`, this is both the batch
plan **and the resumption point**: if a session ends mid-batch, start here.

## Shipped

**CP86 is finally complete** — PR #121, `0fb80dc`, deployed. The pairing backend
had been sitting written-and-tested but unshipped for two batches because it had
no consumer, and six unauthenticated public endpoints with no user-facing value
is attack surface for nothing. This batch built the consumer.

The design's load-bearing decision is what does *not* cross the wire. Both
devices hold the whole race and run the same deterministic clock over the same
lap durations, so what is published is a command and an anchor — "playing, from
lap 25 + 8.4s, as of this server instant". Streaming a playhead at a 1.5s poll
interval would be *worse than no sync*: the follower would snap backwards every
poll to wherever the leader had been a second and a half ago.

Two fields had to be added to the stored state to make that anchor work:

* `lap_elapsed_ms`. The lap index alone is not enough, and the reason is a
  deliberate property of the clock rather than a gap in it: `jumpTo` discards
  sub-lap progress because "40% into lap 30" is meaningless as a *human*
  instruction. A follower is not a human typing a lap number, and landing at the
  lap boundary put it up to a full lap behind the screen it was mirroring.
* `updated_at` in the wire shape, so a device joining late adds the time that has
  actually passed since the write. Both sides of that subtraction are server
  clocks, so a phone with a wrong clock still lands in the right place.

Three consequences worth remembering:

* **`join` deliberately no longer stamps `updated_at`.** A join changes the
  device count, not the state. Stamping it would tell the joining device that a
  stale position was current as of now — so the device most in need of the
  correction would be the one that never got it.
* **`_now()` truncates to milliseconds**, which is what BSON can store. Without
  it `write_state` reported the microsecond instant it stamped while a later poll
  reported the instant Mongo kept, so two responses describing one write
  disagreed by under a millisecond. Nothing to a lap clock, and exactly the kind
  of unexplained discrepancy that costs an hour when something else is wrong.
* **`setPosition` was added to the clock rather than changing `jumpTo`.** The
  manual control's snap-to-lap-start is right for a human and wrong for a
  follower. Both exist; neither is a special case of the other.

### How it was verified, and why that shape

Two **separate** headless Chrome instances, one page each. Two tabs in one
instance would not do: only the foregrounded tab is visible, so the background
one starves `requestAnimationFrame` *and* the poll loop deliberately skips while
hidden — that would have measured the harness rather than the feature. The
driver is `scratchpad/cdp/pair.mjs`.

A hosted, jumped to lap 25, played 8 seconds, *then* B joined:

| moment | A | B | apart |
|---|---|---|---|
| right after B joins | lap 25, 14.05% in | lap 25, 13.63% in | 0.41% |
| 7s later, free-running | 22.20% | 21.77% | 0.43% — no divergence |
| B pressed pause | stopped | stopped | A followed the *joiner* |
| B jumped to lap 40 | lap 40 | lap 40 | A followed |

**Negative control:** dropping the offset and the elapsed-since-write put the two
screens 10.71% of a lap apart — 9.2 seconds of an 86.0s lap — and they never
converged. The check can fail, which is the only reason to trust it passing.

Suite at merge: 1145 passed / 3 skipped, `tsc` and `next build` clean.

## In flight — agents on UI debt (ALL interrupted twice by session limits)

The user reported a batch of UX defects and asked for them in parallel. **The
first dispatch of all three was killed by a session limit mid-edit** and left
partial work in the tree; the second dispatch was told exactly what was broken
and instructed to assess rather than inherit.

| Agent | Scope | Owns |
|---|---|---|
| Standings | column scroll independence, driver portrait cropping, the always-loading teammate battle | `standings/page.tsx`, `drivers/page.tsx`, `standings-view.tsx`, `teammate-battle-panel.tsx`, `title-decider-panel.tsx`, `drivers-grid.tsx`, `driver-modal.tsx`, `compare-drivers-panel.tsx`, `driver-compare-modal.tsx`, `lib/driver-portrait.ts` |
| Teams | per-team information plus the genealogy of how each team came to exist | `teams/page.tsx`, `constructor-genealogy.tsx`, `team-heritage-card.tsx`, `lib/constructor-lineages.ts`, `lib/constructor-profiles.ts`, `lib/season-results.ts`, `lib/api.ts`, `app/constructor_titles.py` + its test |
| Audit | read-only whole-site UX pass against **production**, not the mid-edit local tree | nothing — report only |

All three: no git commands, strict file ownership, ignore failures in files they
do not own, do not deploy. The teams agent must **not** edit `backend/app/main.py`
— it reports the router lines and they get added here.

### What the first, killed dispatch left (known broken — ALL FIXED, see "Ready to ship" below)

* `standings/page.tsx` + `standings-view.tsx` + `teammate-battle-panel.tsx` — it
  was threading a `teammateBattles` prop from the page through the view into the
  panel and died between the caller and the callee. Two type errors.
* `lib/constructor-profiles.ts` — `node.seasons` does not exist on
  `ResolvedNode`, plus an implicit `any`. Two type errors.

Neither set is mine and neither blocks `main`, which is clean.

### The sourcing constraint on the teams work

Constructor results and season history are computable from the cached
Jolpica/Ergast archive. **Genealogy is editorial** — no API returns "Racing Bulls
used to be Minardi". So the agent was told to record, in a docstring, which
rendered facts are computed and which come from a hand-authored table. Both are
acceptable; presenting the second as if it were the first is not, and a wrong
lineage claim in confident type is exactly the class of defect this project has
had to correct before.

## Shipped: the layout and navigation half of the audit

PR #122, `2e5c7e8`. A read-only production UX audit drove the deployed site at
three viewports; these are the findings that were layout or navigation, each
measured out of the live DOM before and after.

* **The desktop nav turned on at 768px but needs ~900px.** At 768x1024 the page
  scrollWidth was 880 against a clientWidth of 768 — "History" rendered as
  "Histor", the season badge was off-screen, and at 844x390 the Pitwall launcher
  was drawn *on top of* a nav link. Every tablet and every landscape phone lands
  in that band. Moved to `lg`, where GlobalSearch already hid itself. 758 vs 758
  after. **The bottom bar moved with it in the same commit** — those two
  breakpoints are one decision, and splitting them would leave 768-1023 with no
  navigation at all.
* **The bottom bar reached 5 of 9 sections and Watch was not one of them** — the
  second-screen feature, designed for a phone, unreachable from a phone. Now
  six; at 390px each column measures 118px and a seventh would put them under 48.
* **Two watch controls sat past the right edge at 844x390**, the size that view
  designs for: footer scrollWidth 931 in an 844px viewport, the largest item
  being a 220px four-line paragraph. Hidden below 520px height at every density
  now, but its two honesty caveats deliberately are not — "the pacing is not
  real" is carried nowhere else, and hiding it would trade a layout problem for
  a truthfulness one.

Also: `color-scheme` was `normal` on a dark-only app (native selects opened
white); Material Symbols ligatures read aloud as "homeHome"/"eventRaces" (7 -> 0);
no skip link despite ten focusable items before content; no `aria-current`
site-wide; the mobile bar was a `div`; `/history` (2.6s TTFB, 697 KB) had no
`loading.tsx`, so a click held the old page on screen fully interactive with no
skeleton for ten consecutive 250ms samples.

## Shipped: the hydration bug, and it was three bugs

PR #123, `cbe5259`. React #418 was logged on `/`, `/drivers` and `/watch` on
every load in production — not a warning, since React discards the mismatched
subtree and re-renders it.

**The audit inferred one cause and there were three**, which is the lesson worth
keeping from this one:

1. `local-datetime.tsx` formatted in the renderer's zone — UTC on Cloud Run, the
   viewer's in the browser.
2. `countdown-timer.tsx` seeded `useState(() => new Date())` on both the server
   and the hydration pass, seconds apart. Measured as 38 against 39.
3. **The first fix was incomplete and only re-measuring caught it.** With the
   timezone pinned and the locale still `undefined`, the same instant rendered
   `Sun, Aug 23, 13:00` against `Sun, 23 Aug, 13:00` — month-first against
   day-first. The error cleared on two routes and *stood on the one it was
   reported against*. Stopping at "tsc passes and two routes are clean" would
   have shipped a fix that did not fix the page in the report.

None of it reproduces locally: **in UTC the server and the client agree by
accident.** It was found by overriding the browser timezone to Asia/Kolkata,
which is the condition every non-UTC reader is already in. Any future work on
SSR'd time or locale should be checked the same way.

The two components take deliberately opposite treatments. The countdown uses
`suppressHydrationWarning` — it keeps the server's text, and the interval
replaces it within 1000ms. The datetime must not: suppressing there leaves a
reader in Melbourne on a UTC time that never corrects itself.

Also shipped in #123: `/history` said "77 Seasons" and "The 75-Season Barcode"
on one screen (now derived; the static metadata drops the count entirely,
because an export evaluated before any fetch cannot honestly claim a number that
grows), and three of the five heading-less routes gained a real `h1`.

## Ready to ship, verified, NOT yet committed

The three held agents' work was finished and the keyboard half of the audit
went with it. Everything below is in the working tree; nothing is committed,
because the deploy step is the user's call.

**The one blocker nobody had spotted: `constructor_titles.router` was never
registered.** The teams agent was correctly told not to touch `main.py` and to
report the router lines instead — and the report was never acted on. So the
whole heritage feature (three agents' worth of work, a 1229-line-adjacent
backend module and its 14 tests) was shipping against a 404. Two lines in
`main.py`; `/api/constructor_titles` is now in the OpenAPI paths.

What was finished from the held work:

* **`profileIsCurrent` was never passed** — the heritage card declared the prop
  and `teams/page.tsx` did not supply it, the last type error in the tree. Now
  `year === activeSeason`, which is what the prop's own docstring describes.
* **Global search's keyboard support was half-written**: `activeIndex`,
  `listboxId`, `optionId` and `listboxRef` were all declared and *none* of them
  reached the markup — no arrow keys, no `aria-activedescendant`, no owning
  combobox. Finished, and rewritten to track the active option **by result key
  rather than by index**: an index survives a keystroke and comes to mean a
  different row, so Enter would open something the user never highlighted. A
  key that has left the list resolves to -1 on its own.
* Two pre-existing lint errors in that held work: `Math.random()` called inside
  a component body (the jittered backoff, now hoisted to module scope) and a
  dead `maxDriverPts`.

And the audit findings that were open:

* **Modal focus containment** — the four portal modals now share
  `use-modal-dialog.ts`. Measured, not assumed (below).
* **`/standings` and `/teams` have an `h1`** — the last two routes without one.
* **`/history` no longer ships its curation error to readers.** The finding was
  right about the symptom and the fix needed one more turn than "hide it":
  `invalid` is set both by a genuine curation error *and* by a soft-failed
  fetch, and `⚠ no data for "williams"` was the second kind presented as the
  first. Gated on `NODE_ENV`, so it still fires loudly in `next dev` where it
  was useful. A second edit went with it: `filterToCurrentGrid` deliberately
  keeps an all-invalid lineage so the warning has something to hang off, and
  with the warning hidden that degraded to a team name against an empty band —
  "Williams has no history" instead of "this load got no data". Those rows are
  dropped in production only.
* **Driver rows on `/standings` open the driver card**, as identical rows do
  everywhere else. `role="button"` + Enter/Space, matching `tilt-card.tsx`.

### How it was verified

Headless Chrome over CDP against the local stack (dev server + backend with
`MONGODB_URI` exported), driving real `Input.dispatchKeyEvent` keystrokes and
reading `document.activeElement` back out. Scripts in this session's scratchpad
(`cdp/a11y.mjs`, `cdp/circuits.mjs`). **18/18 checks**, including:

| check | measured |
|---|---|
| 10 Tabs with the driver dialog open | 10/10 landed inside it |
| Shift+Tab past the first control | wraps to the last, stays inside |
| Escape | dialog closes, focus returns to the exact row that opened it, `body.overflow` released |
| circuit modal's 8 Tabs | all inside; none entered the closed lightbox (`inert` holds) |
| type "ver", ArrowDown ×2, ArrowUp | `aria-activedescendant` = option-0, exactly one `aria-selected`, focus never left the input |
| Enter | opened the Max Verstappen dialog; Escape put focus back in the search field |

**The harness can fail, which is the only reason the passes mean anything.** It
did, twice: the search checks failed 3/3 on the first run (typed before the
client-side fetch landed — 0 options), and a deliberate negative control
confirms that with no modal open, 6 Tabs walk 6 *different* controls, so the
containment check is measuring containment rather than a stuck focus.

Both `complete` branches of `/api/constructor_titles` were exercised on purpose.
Cold, it resolved 34/76 seasons and the card printed *"Championship totals
unavailable — a partial count would understate it"*. Warmed to 76/76, the same
card printed Constructors' 10 (8 as Mercedes) and Drivers' 10 (7 as Mercedes) —
Tyrrell 1971 + Brawn 2009 + Mercedes 2014-21, and Stewart ×2 + Button + Hamilton
×6 + Rosberg. The guard is not theoretical; it fires on a cold Cloud Run build.

Suite: **1159 passed / 3 skipped** (was 1145 — the 14 new
`test_constructor_titles` cases), `tsc` clean, `next build` clean, ESLint clean
on every changed file. Ten ESLint errors remain repo-wide in files this work did
not touch (`watch-view.tsx`, `openf1.ts`, `session-tabs.tsx`,
`local-datetime.tsx`); they are on `main` already and `next build` does not gate
on them.

## Open audit findings, still unassigned

* `/telemetry` is ~85% empty in its most common state.
* Three routes carry sub-40px touch targets.

## Still held, unchanged from Batch 23

**CP88 what-if** — `backend/app/strategy_whatif.py`, 1229 lines, **no test file
and no frontend**. The gate set in its brief — move a real stop to the lap it
actually happened on and confirm the model reproduces reality — has never been
run or reported. Its last words were about a caution period over-extending, i.e.
the model was still wrong when it died. Do not ship it on the strength of it
existing.

## Raised by the user, not yet decided

**A first-run tutorial**, with a button to replay it. The user explicitly asked
for this to be *noted for discussion* rather than built: "need to discuss if
needed or not and how it will add value".

The case against building it as asked: a step-by-step overlay is the usual
answer to a navigation problem, and it is a poor one — it is shown exactly once,
at the moment a new visitor has the least context to attach it to, and it delays
the thing they came for. If a page needs a tour, the tour is usually treating a
symptom.

The case for something: this app genuinely has features nobody would guess exist
— watch mode's real-pace clock, the second screen, the Pitwall assistant,
circuit DNA comparison. That is a *discovery* problem, not an onboarding one, and
discovery is better served in place: a short honest line where the feature lives,
and a "what is this?" affordance on the two or three genuinely non-obvious
controls. The whole-site audit above is deliberately looking for exactly those
unexplained controls, so **its findings should inform this decision rather than
the other way round.** Decide after it reports.

## Still not started, and why

- **Golden set from real LangSmith traces** — blocked on a `LANGSMITH_API_KEY`
  that is not in the local `.env`. Tracing is live in production, so the traces
  almost certainly exist; this needs the credential, not effort.
- **Track-position animation** — needs a coordinate data source this app does not
  have. Blocked, not deferred.
- **Ferrari / Red Bull / Racing Bulls logos** — no freely-licensed source
  (re-verified at CP35). A standing licensing constraint.
- **Fantasy / prediction game** — dropped at the user's explicit instruction.

## Operational notes worth keeping

* **`load_dotenv()` finds `backend/.env`, which has no Mongo keys.** It walks up
  from the *calling file*, not the cwd, so running the backend locally needs
  `MONGODB_URI` exported from the repo-root `.env` (key `mongodburi`) first.
  Without it every Mongo-backed endpoint 500s after a 30s server-selection
  timeout, which looks like a broken feature and is not.
* **A shell heredoc mangles backslashes on this machine.** CDP driver scripts
  must be written with the Write tool and use forward slashes; a Windows Chrome
  path written through a heredoc arrives with every separator stripped.
* Deploy is `gh pr merge --squash` onto `main`; four Cloud Build triggers fire on
  push and take roughly 6-10 minutes.
