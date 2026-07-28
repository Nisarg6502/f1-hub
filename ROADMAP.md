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
| 9 | CP35-37 | Circuit/team image coverage (Bahrain + Saudi Arabia outlines added) PR #55, footer GitHub link PR #54, `/telemetry` surfaced in desktop nav PR #53 | merged |
| 9 (ad hoc) | unnumbered | Fixed the Circuit history panel (CP27) reporting wrong "first raced" years, e.g. "2024" for Silverstone (on the calendar since 1950) — it aggregated only over whichever seasons this app's own sync job happened to have cached, not full circuit history. Re-sourced `/api/circuit_history` from Ergast/Jolpica's circuit-scoped endpoints (full result history back to 1950), cached in a new `circuit_history_cache` collection. Found via a user bug report on `/circuits`, not backlog-planned. PR #57 | merged |

The original plan's CP15-19 (driver/team head-to-head compare, championship calculator, lap-by-lap chart, calendar links, global search) were superseded by the ad-hoc work above and never built under those numbers. They're carried forward into the Backlog below rather than left as gaps — checkpoint numbering resumes cleanly at CP20.

## Current batch

Batch 9 is complete and merged: CP35 circuit/team image coverage (PR #55), CP36 footer GitHub link
(PR #54), CP37 `/telemetry` surfaced in desktop nav (PR #53), plus the ad-hoc circuit-history fix
(PR #57). Batch 10 is not yet planned — see Backlog below for candidates.

**Any cross-season aggregation must be checked against what "cached" actually means before it
ships.** The circuit-history ad-hoc fix's root cause (`first_year_raced`/`most_wins`/
`closest_finish` silently scanning only the handful of seasons this app's own sync job has synced,
then presenting the result as if it were the real historical record) is the same shape of bug as
the earlier `race_laps`-empty-collection issue from Batch 8, just one level more subtle: that one
made a module look *entirely broken* (obviously wrong), this one made stats look *plausible but
wrong* (confidently, silently wrong) — worse, because nothing about the empty state prompts you to
double-check it. Any future feature that aggregates "across all X" from `races`/`race_results`
directly, rather than from a live full-history source, should be treated as suspect by default —
cross-check a well-known answer (a circuit that's been racing since the 1950s, a driver with an
obviously large win count) against real-world knowledge before shipping it, the same way this bug
was caught by a user noticing "first raced 2024" was obviously wrong for granted knowledge, not by
a test.

Batch 9 was built as three parallel worktree agents on disjoint files (`circuit-images.ts`/`team-images.ts`,
the `layout.tsx` footer block, `nav-links.tsx`), each opening an independent PR — same pattern as
Batches 6-8. Two things worth recording:

- **CP35's research turned up real, previously-unnoticed gaps**, not just "re-check the two
  known-blocked team logos": diffing the resolver against the live 2025/2026 Ergast calendar (not
  just eyeballing the map) found Bahrain and Saudi Arabia had no circuit-outline mapping at all —
  they'd been silently falling back to the hatch placeholder. Sourcing simple CC-licensed line-art
  outlines from Wikimedia Commons (not the existing bucket's elaborate custom "official-style"
  graphics, which have no free equivalent) was a reasonable trade — worth remembering that asset
  parity with the existing bucket art isn't achievable for every circuit, and a simpler substitute
  beats a placeholder. Also worth remembering: SVGs pulled from Commons often have black
  strokes/text meant for a light page background and are invisible against this app's dark theme —
  check a rendered composite against the actual dark background, not just the source file, before
  calling an asset done. And when converting to AVIF for transparency, `ffmpeg`'s `libaom-av1`
  silently drops the alpha channel (produces an opaque background) — use `sharp` instead when the
  asset needs real transparency.
- **Leftover worktree directories accumulate across batches, independent of `git worktree
  remove`.** Cleaning up after this batch found *three* stale `.claude/worktrees/agent-*`
  directories from batches before this one, still sitting on disk despite no longer being
  registered with `git worktree list` (they'd been `prune`d or force-removed at the git level in
  an earlier session, but the directory itself — likely mid-delete when a dev-server file lock was
  still held — never actually got deleted). `git worktree remove --force` can report success (or
  get git's bookkeeping to a clean state) while the directory itself survives; periodically check
  `.claude/worktrees/` directly for orphaned folders rather than trusting `git worktree list`
  alone, and be ready for the `rm -rf` itself to take a while / need to run in the background on a
  deep `node_modules` tree.

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
- Circuit outline coverage is now complete for the current calendar (Batch 9 CP35 closed the
  Bahrain/Saudi Arabia gap). Ferrari, Red Bull, and Racing Bulls logos remain unresolved — no
  freely-licensed source exists on Wikimedia Commons as of this check (re-verified in CP35); this
  is a standing licensing constraint, not a to-do, and is unlikely to change without a new source
  appearing.

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
