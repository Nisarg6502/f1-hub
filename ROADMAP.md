# APEX Roadmap

## Vision

APEX is a Formula 1 season hub — the next stretch of work grows it from "when's the next race, who's winning" into deeper race analysis (comparisons, strategy, replay) and a few tightly-grounded GenAI features, per the research report from 2026-07-27. Everything ships read-only, free-tier-sourced, and Mongo-cached; no feature gets added by compromising those constraints.

## How this works

Checkpoints (`CP<n>`) number flatly and continuously across the project's life — they never restart per batch. One branch (`feat/<kebab-case>` or `fix/<kebab-case>`) and one PR per checkpoint; branch off `main`, implement, test (`python -m unittest discover tests` from `backend/`; `npm run build && npm run lint` from `frontend/`), verify in the browser, push, wait for the user's merge confirmation before starting the next checkpoint. Batches are small — 2 to 4 checkpoints — and get built, verified, and deployed before the next batch is planned; nothing here commits to building everything at once. `FEATURES.md` is the source of truth for what's actually shipped (its "Known gaps" section is not restated here). `HANDOFF.md` is the source of truth for session-level working memory and gotchas (also not restated here) — this file only tracks the durable plan: vision, batch history, current batch, and backlog.

**Parallelization check, done at batch-planning time:** before starting a batch, check each checkpoint's expected file footprint. Checkpoints that touch disjoint files with no sequential dependency (e.g. Batch 3's weather tile / nav label / telemetry fix) can be built by parallel subagents, each in its own git worktree, with PRs opened and merged independently. Checkpoints that share files or have a real dependency (e.g. two features both touching the Pitwall page) stay sequential — parallel agents on shared files risk merge conflicts and duplicated helpers instead of saving time.

**Skill usage for UI/UX work:** any checkpoint touching visual design, layout, or animation must invoke the `emil-design-eng` skill (animation/interaction polish philosophy — easing, timing, transform-origin, press feedback) before implementing, and `apple-design` when the work involves gesture-driven or physically-feeling interactions. `pick-ui-library` should be invoked before adding any new UI dependency; `review-animations`/`improve-animations`/`find-animation-opportunities` are for auditing existing motion rather than building new UI. These are the only project skills that exist (see `.claude/skills/`) — there is no "ui-ux-pro-max" or "Framer Motion" skill; the app already depends on `motion/react` (Framer Motion) as its animation library, so use it directly rather than introducing a second one. A custom liquid-glass dropdown/popover (`bg-[rgba(26,22,19,0.98)] border border-white/10`, motion-animated open/close, click-outside + Escape handling) already exists in `tire-stints-chart.tsx` and `compare-drivers-panel.tsx` — reuse that pattern instead of a native `<select>`, which does not carry the app's theme.

## Shipped batches

| Batch | Checkpoints | Theme | Status |
|---|---|---|---|
| 1 | CP1-6 | Perf, circuit images, driver crop, driver modal, season selector, team logos | merged |
| 2 | CP7-14 | Circuit lightbox, schedule/home/standings polish, Pitwall CTA prominence, tyre stints re-sourced from FastF1 | merged |
| 2 (ad hoc) | unnumbered | Pit-stop analysis module (Pitwall), driver-bio rate-limit fix (Hamilton championship undercount) — built mid-batch in response to user requests, outside the original CP15-19 plan | merged |
| 3 | CP20-22 | Weather conditions tile, dynamic nav season label, telemetry error-leak fix | merged |
| 4 | CP23-24 | Driver head-to-head compare, teammate battle panel | merged |
| 5 | CP25 | Lap-by-lap position chart (Pitwall "Lap Telemetry"), plus the compare-drivers dropdown redesign | merged |
| 6 | CP26-28 | Pitwall dropdown click-outside/Escape backport, circuit history panel (closest finish/most wins/first year raced), season-aware page metadata | merged |
| 7 | CP29-31 | Gap-to-leader on Pitwall Lap Telemetry, "Add to calendar" for weekend sessions, Championship "Title Decider" calculator | merged |
| 8 | CP32-34 | Functional global search, Pitwall "Race Control" panel, cross-track "Circuit DNA" comparison | merged |
| 8 (ad hoc) | unnumbered | Select all / Clear all on the Pitwall driver-compare dropdown (Tire Stints + Lap Telemetry) — built mid-batch in response to a user request | merged |

The original plan's CP15-19 (driver/team head-to-head compare, championship calculator, lap-by-lap chart, calendar links, global search) were superseded by the ad-hoc work above and never built under those numbers. They're carried forward into the Backlog below rather than left as gaps — checkpoint numbering resumes cleanly at CP20.

## Current batch

Batch 8 is complete and merged (CP32 global search PR #50, CP33 Pitwall Race Control PR #47, CP34
Circuit DNA comparison PR #49), plus the ad-hoc select-all/clear-all fix (PR #48).

**Batch 9 (CP35-37)** is in flight — pulls from two Backlog themes ("Race weekend enrichment" and
the Known-gaps cleanup implied by `FEATURES.md`'s Known Gaps section), built as three parallel
worktree agents on disjoint files, each opening an independent PR, same pattern as Batches 6-8:

- **CP35 — Circuit/team image coverage.** Fill gaps in `circuit-images.ts` (circuits missing an
  outline mapping) and re-check whether Ferrari/Red Bull/Racing Bulls logos have gained a
  freely-licensed source since `team-images.ts` was last touched. Files: `frontend/src/lib/circuit-images.ts`,
  `frontend/src/lib/team-images.ts`, new assets uploaded to `gs://f1-scratch-assets/`.
- **CP36 — Footer links.** The footer (`frontend/src/app/layout.tsx`, inline `<footer>` block) is
  two lines of unclickable text — give it real links (repo/GitHub, attribution) rather than dead
  text. Touches only the footer block in `layout.tsx`.
- **CP37 — Surface `/telemetry` in nav.** It already has a friendly "not available in this
  environment yet" fallback when `NEXT_PUBLIC_RAPIDAPI_KEY` is unset, so linking it no longer risks
  a broken-looking page for most visitors — add it to the desktop nav (`frontend/src/components/nav-links.tsx`,
  `navItems`/`NavLinks`). Leave the mobile bottom bar as-is (already at its 5-item ceiling per
  `FEATURES.md`).

Built the same way as Batches 6-7: three parallel worktree agents on disjoint files
(navbar/search, Pitwall, circuits page), each opening an independent PR. Two things worth
recording from this batch:

- **A background agent can report "finished" without actually finishing.** CP32's agent twice
  ended a turn with a status update ("waiting for a background build/install to finish") instead
  of a real completion report, and both times the harness reported it as completed with no live
  children. Checking its worktree directly showed real, uncommitted work each time — the agent
  had lost track of its own execution state, not silently failed. The fix was the same as the
  stray-process pattern documented below: check the worktree and process list directly (`git
  status`, `git log`, `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match
  '<worktree-path>' }`), correct the agent's understanding of what's actually running (once it
  was a genuinely stale `next dev` process left over from its own verification step, not a build
  at all), and resume with explicit synchronous steps rather than trusting its self-report.
- Lap Telemetry was separately found showing "not processed yet" for every completed race —
  turned out `race_laps` (FastF1-sourced, unrelated to the OpenF1 paywall) had simply never been
  locally synced since the feature shipped. Fixed by running `data_sync.py` locally to backfill
  it, then manually re-triggering the `f1-frontend` Cloud Build trigger to bust the 1-hour
  `revalidate` cache on `getRaceLaps` so the fix was visible immediately. No code change was
  needed for this one — pure operational gap.

Batch 7 was built the same way as Batch 6: three parallel worktree agents (CP29, CP30, CP31),
each touching disjoint files, all opening independent PRs. The worktree-cleanup discipline from
Batch 6 held for two of the three, but CP29's agent hit a different problem worth recording:
its `npm install` kept getting corrupted mid-run because a stray `npm install` process from an
earlier resume was still running in the background and racing against a fresh `rm -rf
node_modules && npm install` attempt, deleting/rewriting the same files concurrently. Resuming a
paused agent doesn't kill whatever background job it was waiting on — if an agent reports the
same "still installing" status across several resumes, check for a duplicate/stray process
before just prompting it to continue again; it may be worth running the install yourself outside
the agent (in its worktree path) and telling it node_modules is already good, rather than letting
it retry indefinitely.

## Backlog (unscheduled)

### Race weekend enrichment
- F1DB circuit-layout SVGs / team logos to replace incomplete asset host coverage

### GenAI features
- "Explain this session" auto-recap after a race/quali/sprint syncs
- Natural-language query bar (a GenAI layer alongside the now-functional keyword nav search)
- Race strategy commentary on the Pitwall page (grounded in stint data)
- Driver comparison narrative (pairs with the head-to-head feature)
- "Ask about this circuit" scoped chat (RAG over cached circuit history + Wikipedia extract)
- Pre-race prediction with transparent reasoning (framed as commentary, not a promise)

### Replay & media
- Race replay / session playback (lap-by-lap scrub, timing tower, track status flags)
- Strategy "what-if" pit-stop replay (drag a stop to a different lap, estimate position impact)

### Other
- Personal "watch party" second-screen mode
- Constructor budget cap tracker (manually updated, no live feed exists)
- Fantasy / prediction game (bigger scope — needs auth + persistence; v2 milestone)
