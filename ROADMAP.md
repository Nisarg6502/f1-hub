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
| 10 | CP38 | "AI Recap" on the race-detail page — an LLM-generated, streamed race summary grounded in cached classification data (Ollama Cloud), generated once per race and cached forever | merged |
| 10 (ad hoc) | unnumbered | Accuracy overhaul of CP38 after a user caught a hallucinated teammate claim: pre-compute relational facts in code, add OpenF1 race-control events (penalties, VSC, stewards' decisions), upgrade to `gpt-oss:120b`, add inline citations and Markdown rendering. Also discovered OpenF1's current-season paywall has lifted. PR #60 | merged |
| 11 | CP39-41 | Corrected the stale OpenF1 paywall claims across docs and user-facing copy (PR #64), self-healed `race_stints`/`race_laps` from OpenF1 with FastF1 as fallback (PR #65), extended AI recaps to Qualifying and Sprint (PR #66) | merged |
| 12 | CP42-44 | Race replay: lap-indexed `/api/race_replay` endpoint (PR #68), timing tower + lap scrubber component (PR #69), Pitwall integration with `?lap=N` deep-linking from race-control citations (PR #70) | merged |
| 12 (ad hoc) | unnumbered | Two fixes from live user testing against the Hungarian GP: moved play/pause + scrub track above the timing tower, and fixed the field visibly shrinking near the end of the race — first for lapped classified finishers (`race_laps` has no row for a car that finished fewer laps than the winner) PR #72, then for genuine retirees, who were dropped entirely rather than shown as retired PR #73. `REPLAY_VERSION` bumped twice (2, then 3) for the underlying data-shape fixes | merged |

The original plan's CP15-19 (driver/team head-to-head compare, championship calculator, lap-by-lap chart, calendar links, global search) were superseded by the ad-hoc work above and never built under those numbers. They're carried forward into the Backlog below rather than left as gaps — checkpoint numbering resumes cleanly at CP20.

## Current batch

No batch is currently planned — Batch 12 and its ad-hoc follow-up fixes are shipped and merged
(PRs #68, #69, #70, #72, #73); the next batch has not been scoped yet. See Backlog below for
candidates.

## Batch 12 retrospective — Race replay (CP42-44)

**Batch 12 (CP42-44) is complete and merged** (PRs #68, #69, #70). It was the backlog's "race
replay / session playback" item, made buildable by CP40's self-heal work: before it, `race_laps`/
`race_stints` only ever populated when someone ran `data_sync.py` locally, so a replay would have
been empty in production for most rounds.

**Two ad-hoc fixes followed from live user testing against the Hungarian GP** (PRs #72, #73), both
the same underlying shape of bug: the timing tower's field visibly thinned out over the last few
laps, reading as a wave of retirements when most of the missing cars had actually finished.
`race_laps` simply has no row for a car once it stops being tracked — for a classified finisher
who's a lap down, that's *before* the winner's actual final lap (it took the flag on an earlier
lap, so it never raced the winner's last one); for a genuine retiree, that's whenever it left the
track. `build_replay()` now carries every driver's last known row forward through to the winner's
final lap, tagging a genuine retirement `retired: true` (frozen gap, sorted below every actively
racing car, shown as "RETIRED" rather than a live number) so the two cases render distinctly rather
than both just vanishing. `REPLAY_VERSION` bumped twice (2, then 3) so cached rounds rebuilt with
each fix. The controls + scrub track also moved above the timing tower per direct feedback, so the
scrubber doesn't shift under the cursor as the tower's height changes lap to lap.

**Verification gotcha worth remembering:** after the retirement fix, a backend restart plus a
frontend dev-server restart still served the pre-fix payload. The culprit was Next.js's Turbopack
dev cache under `.next/dev/cache`, which persists fetch responses across dev-server restarts —
clearing `.next/cache/fetch-cache` alone did nothing; only `rm -rf .next` actually busted it. If a
backend fix doesn't seem to show up in the browser after restarting both servers, suspect this
before suspecting the fix itself.

**What the cached data actually supports** (verified against the 2026 British GP, round 9):

| Source | Row shape | Rows |
|---|---|---|
| `race_laps` | `{driver_number, lap_number, position, gap_seconds}` | 1111 (22 drivers × 52 laps) |
| `race_stints` | `{driver_number, stint_number, lap_start, lap_end, compound, tyre_age_at_start}` | 73 |
| `pit_stops` | `{driver_id, lap, stop, duration_seconds}` | 51 |
| `race_control` | lap-tagged events, already distilled by `race_control_facts.py` | ~80 raw |

Everything keys by lap, so a lap-indexed replay is well supported. Two constraints shape the scope:

1. **There is no GPS or coordinate data anywhere in this app.** `track-map.tsx` is a static circuit
   outline image. So this is a *timing-tower* replay — running order, gaps, tyres, flags, scrubbed
   by lap — **not** cars animating around a circuit. Worth stating plainly, because "race replay"
   invites the wrong mental image and would set up an impossible-to-meet expectation.
2. **`pit_stops` keys on `driver_id` (`"albon"`), while `race_laps`/`race_stints` key on
   `driver_number` (`23`).** A join written without noticing that silently drops every pit marker
   with no error — the same *plausible-but-wrong* failure shape as the circuit-history bug below.
   `race_results` carries both fields and is the bridge.

- **CP42 — `/api/race_replay` endpoint.** One lap-indexed payload joining laps, stints, pit stops
  and race control, resolving `driver_id`↔`driver_number` **once, server-side**. This is CP38's
  precompute lesson applied to a join rather than a prompt: the client should never re-derive a key
  mapping that has a silent failure mode. Cached like the other collections.
- **CP43 — Timing tower + lap scrubber.** Lap slider, running order at the scrubbed lap with
  position/gap/tyre compound, pit and flag markers on the scrub track, play/pause with a speed
  control. Per this file's own skill rule, `emil-design-eng` and `apple-design` must be invoked
  before implementing — a scrubber is exactly the gesture-driven, physically-feeling interaction
  that rule exists for.
- **CP44 — Pitwall integration and deep-linking.** Surface it as a Pitwall module with `?lap=N`
  deep links, so a recap citation like `[RC L8]` can eventually jump straight to that moment.

**CP44 found the same instruction-drift failure class CP41 documented, this time in citation
formatting rather than vocabulary.** `session_recap.py`'s prompt documents the race-control
citation format as `[RC L66]`, but live recaps were observed emitting bare `[RC 5]`, `[RC 18]`,
etc. — no `L`. Generalizing CP41's lesson further: **a prompt rule describing an output *format*
is just as unreliable under generation as a rule describing forbidden *vocabulary* or a
*constraint to remember while writing*.** This time the fix stayed on the display side rather than
adding another code-side validator to `session_recap.py` — the frontend's lap-extraction regex
(`session-recap-card.tsx`) was made tolerant of both forms, since the lap number is unambiguous
either way and turning a citation into a working link is a rendering concern, not a generation
one. Worth remembering before adding another citation-style feature: verify the *actual* emitted
format against a live cached recap, not the prompt's documented example.

**Parallelization: none — this batch is sequential.** Unlike Batches 6-9, CP43 consumes CP42's
payload shape and CP44 consumes CP43's component. Running these as parallel worktree agents would
have each guessing at the payload contract and produce three incompatible answers.

**Batch 11 (CP39-41) is complete and merged** (PRs #64, #65, #66). It was scoped around a single
discovery: **OpenF1's current-season paywall has fully lifted.**

CP41 (Qualifying/Sprint recaps) is worth reading before the next GenAI checkpoint, because it
found the limit of prompt-based grounding. Two rules the model broke under live testing:

- It called a `gap_to_cutoff` value *"the closest margin of the segment"* — a ranked comparison the
  data never makes. Those arrays hold individually-true numbers that are not sorted against each
  other, and the prompt now says so explicitly.
- It wrote *"completed the podium in third"* in a **qualifying** recap, despite "podium" being
  banned twice in that prompt including an ALL-CAPS block. **Restating a rule more forcefully did
  not work; a second restatement did not work either.** The fix was to stop trusting the prompt:
  `SESSION_VALIDATORS` checks the assembled qualifying text in Python and regenerates once with a
  corrective message. Generalized — CP38 showed a model will confabulate a *fact* it was asked to
  derive; CP41 shows it will also break a *constraint* it was asked to remember while writing.
  Anything that must be true of the output belongs in code, not only in the prompt.
- Third, smaller lesson: the first fix for the ranking problem was written too broadly ("do not
  compare gaps"), and the model over-corrected into reciting every driver's time and gap in turn,
  blowing the word limit and reproducing the classification table in prose. A rule that forbids a
  behaviour should say what to do *instead* — rule 16 ("select, do not enumerate") restored it.

The validator costs the qualifying recap its token-by-token streaming: the text must be complete
before it can be checked, and a violation must not reach the reader first. Only the first viewer of
a session pays that wait, since every one after replays from cache — the same trade the 120b model
was chosen under. Race and Sprint still stream.

**The original Batch 11 scope, for reference:** Not just `/race_control` (found during CP38's overhaul) — `/stints`, `/laps` and
`/pit` all return 200 for 2026 as well, verified 2026-07-29. This invalidates a constraint that has
shaped the architecture since Batch 2 and is asserted in many places across the docs and code.

- **CP39 — Correct the stale paywall claims.** Docs and code comments across `FEATURES.md`,
  `HANDOFF.md`, `pit_stops.py`, `race_stints.py`, `openf1.ts` and `pitwall/page.tsx` still assert a
  hard 401. Most urgent: `pitwall/page.tsx`'s Race Control empty state renders copy telling users
  OpenF1 "currently paywalls real-time data" — user-facing text that is now simply false. (Race
  Control itself already works in production with no code change; verified real messages in the
  server-rendered HTML.) Docs/copy only, no behaviour change.
- **CP40 — Self-heal `race_stints`/`race_laps` from OpenF1.** These are FastF1-sourced, and FastF1
  is IP-blocked from Cloud Run, so their self-heal path can *never* succeed in production — the
  cache is only ever filled by someone running `data_sync.py` locally. That is the root cause of
  the CP25-to-Batch-8 gap where Lap Telemetry was empty for every race. OpenF1 is reachable from
  Cloud Run, so: **try OpenF1 first on a cache miss, keep the existing FastF1 rebuild as fallback.**
  Deliberately additive — nothing currently working may regress, and historical seasons keep
  whatever path already serves them. Verify field parity before trusting it (notably that lap data
  still supports the gap-to-leader chart from CP29).
- **CP41 — Extend recaps to Qualifying and Sprint.** The Race-only recap shipped in CP38; the
  grounding, streaming, caching and fact-precomputation patterns are all reusable. Follow CP38's
  hard-won rule: precompute every relational/derived fact in Python, never let the model infer one.

**Parallelization:** CP39 (docs + one copy string), CP40 (backend `race_stints.py`/`race_laps.py`)
and CP41 (backend `session_recap.py` + a frontend card) touch disjoint files with no sequential
dependency, so all three can run as parallel worktree agents. CP39 and CP40 both mention
`pitwall/page.tsx`/`race_stints.py` in passing — CP39 owns comment/copy edits there, CP40 owns
logic, and they must not cross.

**Deployment note for anything using a new backend env var:** `cloudbuild-backend.yaml` deploys the
image but does not set env vars, so a new one (`OLLAMA_API_KEY`) has to be added to the Cloud Run
service separately or the feature silently no-ops in production while working perfectly locally —
which is exactly what happened on CP38's first deploy. Worse, an env var set as a *pin* can later
become a *downgrade*: `OLLAMA_MODEL=gpt-oss:20b` was set when 20b was the default, and after the
code default moved to 120b that same var would have kept production on the model that hallucinated.
Re-check existing env vars whenever a code-level default changes.

**Credentials go in Secret Manager, not `--update-env-vars`.** `OLLAMA_API_KEY` shipped as a
plaintext env var and was migrated to a `secretKeyRef` to match how `MONGODB_URI` was already
handled; a plaintext value is readable by anyone with project access and is echoed by
`gcloud run services describe`. See `README.md` for the exact commands. Note that migrating does
*not* scrub the value from previously-deployed revision configs — Cloud Run retains those for
rollback — so a key that was ever set in plaintext should be rotated to be fully clean.

**CP38's accuracy overhaul is the most important lesson in this file for anyone building the next GenAI feature.** The first version handed the model a bare classification list and asked it to find "the story." It produced fluent, confident prose that claimed Andrea Kimi Antonelli (Mercedes) was Max Verstappen's (Red Bull) teammate — with both drivers' correct, different team names sitting right there in the data it was given. Generalized: **an LLM asked to *derive* a relational or comparative fact will confabulate it even when the underlying fields are present and correct.** The fix was not a sterner prompt alone; it was moving every derivable fact out of the model's job and into Python:

- `_teammates()` emits explicit pairings, so "teammate" is a lookup, never an inference.
- `_biggest_movers()`/`positions_gained` pre-compute grid-to-finish deltas, so the model never does arithmetic.
- `_retirements()` classifies status strings (note: "Lapped" and "+1 Lap" are *finishers*, not retirements — an easy and initially-made mistake).
- The model's remaining job is narrating already-true statements. Prompt rules then forbid the specific failure classes observed in testing: inventing sporting regulations (it claimed a fastest-lap bonus point that doesn't exist in 2026), asserting an event did/didn't affect the outcome, and applying unsupported labels ("front-running" for cars that started 21st and 22nd).

Two supporting changes: `gpt-oss:120b` replaced `20b` (the smaller model was the one that hallucinated; at one generation per race, cached forever, the latency cost is irrelevant), and `temperature: 0.2`, since sampling variance is pure downside on a factual summarization task. Inline citations (`[P3]`, `[FL]`, `[RC 66]`) were added not just for the reader but as a forcing function — a claim that cannot cite a data row is visibly unsupported.

**`PROMPT_VERSION` is part of the cache key.** Because recaps cache forever, a prompt change would otherwise keep serving output generated under the old contract indefinitely. Bump it whenever the prompt or fact-bundle shape changes; old rows stop matching and regenerate on next view.

**OpenF1's current-season paywall has lifted** (verified 2026-07-29: `GET /v1/sessions?year=2026` and `/race_control` both return 200, 80 messages for the Hungarian GP). Several docs described this as a hard blocker — they were correct when written and are now stale. This is what made grounded penalty/safety-car narration possible, and it also means the Pitwall Race Control module (CP33) should now populate for current-season rounds. Worth re-testing any other feature that was shelved because of that 401.

**Batch 10 (CP38)** is the first GenAI feature: "Explain this session" (Race only, per the Backlog
item below), built and live-verified against a real Ollama Cloud key and real cached race data
before opening its PR — not just unit-tested. Notes for whoever builds the next GenAI checkpoint
(the query bar, driver-comparison narrative, etc. — see Backlog):

- **`gpt-oss:20b` (and presumably its sibling reasoning models on Ollama Cloud) stream a `thinking`
  field separately from `content`** in `/api/chat`'s streamed response — the model's chain-of-thought
  comes through as `message.thinking` deltas with `message.content` staying empty, then `content`
  starts populating once the model commits to its actual answer. Only forward `content` to the
  client; forwarding `thinking` too would leak raw reasoning traces into a "recap," not user-facing
  commentary. This also means the *first* visible token can take a while — the CP38 test saw ~13s
  of pure thinking before content started on a 3-word toy prompt, and the full race-recap call took
  ~44s end-to-end — which is exactly why this had to stream rather than block.
- **Cache whatever's genuinely immutable, forever, keyed by the natural identity** (here:
  season+round+session, matching how `race_results`/`race_stints` are already keyed) — a finished
  race's facts don't change, so there's no staleness window to manage, unlike `circuit_history_cache`
  (Batch 9 ad hoc), which does need one since Ergast's answer for "most wins at this circuit" changes
  every time a new race happens there.
- **A streaming response needs a client component fetching directly against the backend**, not the
  server-component `fetchJson` pattern every other endpoint in `lib/api.ts` uses — Next.js server
  components can't progressively forward a fetch's `ReadableStream` to the browser the way a client
  component reading `response.body.getReader()` can. `NEXT_PUBLIC_API_BASE_URL` is already exposed
  to the client bundle (the driver-bio "Career" block already fetches it client-side on modal open),
  so this isn't a new pattern for the app, just the first one that streams rather than waiting for a
  full JSON body.

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
- Natural-language query bar (a GenAI layer alongside the now-functional keyword nav search)
- Race strategy commentary on the Pitwall page (grounded in stint data)
- Driver comparison narrative (pairs with the head-to-head feature)
- "Ask about this circuit" scoped chat (RAG over cached circuit history + Wikipedia extract)
- Pre-race prediction with transparent reasoning (framed as commentary, not a promise)

### Replay & media
- Race replay / session playback shipped in Batch 12 (CP42-44) — a lap-indexed timing tower, not
  cars on track (no GPS/coordinate data exists in this app). Track-position animation would need a
  new coordinate data source before it could be built, not just more UI work on top of this.
- Strategy "what-if" pit-stop replay (drag a stop to a different lap, estimate position impact)

### Other
- Personal "watch party" second-screen mode
- Constructor budget cap tracker (manually updated, no live feed exists)
- Fantasy / prediction game (bigger scope — needs auth + persistence; v2 milestone)
