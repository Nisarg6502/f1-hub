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

## In flight — three concurrent agents on UI debt

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

### What the first, killed dispatch left (known broken)

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
