# F1 Hub — Handoff (2026-08-23)

## GA4 — the CSP silently ate the whole feature (2026-08-23)

**Read this before adding any third-party script to the frontend.**

APEX shipped Google Analytics and measured nothing. `next.config.ts` sets a
CSP whose `script-src 'self' 'unsafe-inline'` named no Google host, so
`gtag.js` was refused outright on the deployed site.

**Why it survived a careful verification pass.** A CSP refusal arrives over CDP
as `Network.loadingFailed` with an **empty `errorText`** — only
`params.blockedReason` says `"csp"`. Without reading that field it is
indistinguishable from network-level filtering, and it was diagnosed as exactly
that: twice, and written into the design doc as an environment limitation.

What made it convincing is that *our own code kept working perfectly*. The
inline bootstrap defines `window.gtag` as a `dataLayer.push` shim, so consent
defaults, the config call, the grant and every `page_view` queued into
`dataLayer` in exactly the right order whether or not Google's script ever
loaded. Every check of our instrumentation passed. The only true signal was
`typeof window.google_tag_data`, which stays `"undefined"` until gtag.js
actually executes.

**The rule:** adding a third-party script means adding its hosts to the CSP in
the same change — for GA that is `script-src` (the tag), `connect-src` (the
`/g/collect` beacons, including the cookieless ones a denied visitor still
sends) and `img-src` (the image-beacon fallback). Then confirm *the third party's
own script ran*, not that our code called it.

Two mechanical notes worth keeping:

- `headers()` is evaluated at **build** time and baked into
  `.next/routes-manifest.json`. That is where to verify a CSP change, and it is
  why the builder stage's `ENV` is enough — the runner stage never needs the
  variable.
- The GA hosts are gated on `NEXT_PUBLIC_GA_MEASUREMENT_ID`, so a build without
  analytics keeps the narrower policy. Both variants were checked in the
  manifest.

**Also: never measure event counts against `next dev`.** React Strict Mode
double-invokes effects, so `page_view`, the consent grant and
`backend_unavailable` each fired twice in development and once in production.
That looks precisely like the double-counting the manual `page_view` design
exists to prevent.

Verified on the live deployment: `gtag.js` 200 and executing, EU visitor gets a
banner and **no `_ga`** until they click, non-EU gets `_ga` immediately, one
collector request per view. Design and full verification record in
`docs/superpowers/specs/2026-08-22-google-analytics-design.md`.


## CP82-85 — the chat agent had no rate limiting at all (2026-08-18)

The user asked whether anything protected the assistant from misuse. **Nothing
did.** `/api/chat` and `/api/feedback` were unauthenticated with no per-caller
limit of any kind, and three things that look like protection are not:
`concurrency.py` is a *serialization* gate for Ollama's one-concurrent-model
tier (it makes one caller wait, it does not stop them returning);
`--max-instances=1` bounds requests per second, not per day; CORS is a browser
rule and `curl` does not read it. One shell loop could hold the run slot
indefinitely and burn the whole free-tier allowance.

The user's own framing set the design constraint and was right: **plain IP
limiting is not good enough.** IPs are shared behind CGNAT — blocking one can
block a carrier's worth of users — and are trivially rotated. `rate_limit.py`
is therefore five layers, all of which must pass, and the identity is assumed
weak throughout.

**Cost is charged in cost units, not request counts.** This is the part most
worth carrying forward: an LLM turn's cost varies by more than an order of
magnitude (a cache hit costs a Mongo read and no model call; tier 3 reaches four
or five), so "20 requests/hour" bounds nothing that matters. A unit is roughly
one tier-1 answer or 60s of metered GPU time, and `measured_cost` takes the
larger of the tier estimate and the turn's real model seconds.

**`resolve_client_ip` is the piece most often got wrong, and it is wrong in two
opposite directions.** Reading `request.client.host` on Cloud Run yields
Google's front end, so every user in the world shares one bucket and the service
bans everybody — a self-inflicted outage. Reading the *first* `X-Forwarded-For`
entry reads a value the client wrote, so an attacker mints a fresh identity per
request by incrementing a number. The correct read is a fixed number of hops
**from the right**. `AGENT_TRUSTED_PROXY_HOPS=0` is right for a Cloud Run
service addressed directly on its `*.run.app` URL; **it must be raised the
moment anything is put in front of the service**, or the IP layer silently
becomes spoofable.

All three deployment properties — the kill switch, the daily budget and the hop
count — are `cloudbuild-agent.yaml` substitutions rather than code-only
defaults. The limiter was first written without them, and that was the gap worth
catching before deploy: a limiter whose off switch needs a code change is the one
failure mode here that is worse than the abuse it prevents.

Alongside it, three pieces of verified-open debt:

- **The auto-added `general-purpose` subagent is gone.** deepagents inserts one
  (and therefore `task`) unless told not to, so the *flat* graph — given no
  subagents, with a prompt that never mentions delegation — shipped a `task`
  tool pointed at a clone of itself. This file named the right setting but the
  wrong way to pass it: `create_deep_agent` has **no `profile=` parameter**, so
  the only route in is `register_harness_profile`. And the key is a trap —
  deepagents skips its composite `provider:identifier` probe when the identifier
  already contains a colon, and ours is `nemotron-3-nano:30b`, so it hunts for a
  provider literally called `nemotron-3-nano`. Register under `"ollama"`.
- **The no-filesystem rule is now structural.** `ls`, `glob`, `grep`,
  `edit_file`, `write_file`, `delete` and `execute` are excluded on the profile;
  `read_file` and `task` are deliberately kept. The prompt rules stay as
  documentation but **are no longer the mechanism** — they were written twice
  and failed twice (CP61's baseline burned its step budget in `ls`/`grep`;
  CP63's first live `web-researcher` tried `ls` and `glob`). Note the mechanical
  difference before writing an assertion: disabling the subagent removes `task`
  from the graph entirely, while `excluded_tools` filters at model-request time,
  so exclusions are invisible to a `tools_by_name` check.
- **The tool-argument audit CP73 asked for is done.** One more leak beyond
  `today`: `web_search`'s `max_results`, a Tavily budget knob with nothing
  question-shaped about it. It is now a per-tool `fact_tool(hidden_args=...)`
  rather than a global name ban, and the audit is expressed as a **tool ->
  model-visible-argument map asserted against the real bound schemas**, so a new
  optional parameter fails the suite until someone records a verdict. That is
  the actual fix for how `today` reached production: a test-only parameter was
  automatically a model parameter and nothing had to agree it should be.

**CP84 — the gap and interval columns are now exact at every crossing**, which
positions already were and they were not. `TIMING_VERSION` is **7**; `gaps` and
`intervals` read 100% at a 0.05s tolerance across all 11 rounds.

Two things about it are worth more than the number:

- **Adding it destroyed the independence of the `gaps` check CP81 had just
  added.** Once the payload *is* that arithmetic, scoring it proves plumbing,
  not data. The still-independent measurement was split out as **`fill-gap`** —
  the last *OpenF1* reading before each crossing, crossings excluded — and is
  reported without a threshold. It is byte-identical before and after, which is
  the control confirming the fill itself was untouched.
- **A lapped car's gap reads `"+N LAPS"`, not the numeric truth.** The number is
  real but misinforms (`+1030.86` reads as "17 minutes up the road"; he is a few
  hundred metres up the road, 11 laps down), and OpenF1's fill either side uses
  the string convention — a numeric official sample between two `"+11 LAPS"`
  fill samples would make the column alternate conventions at every crossing.
  Laps-down is *counted* from the archive, not derived by dividing by a lap
  time, which breaks under a safety car; it agrees with OpenF1's independently
  produced strings on 2,794 of 2,809 cases.

**What CP84 did NOT fix, stated plainly because the motivating example implied
otherwise:** a car whose OpenF1 samples stop entirely still shows a stale gap
between crossings. Alonso's round-1 garage stop spans 977 seconds with *zero*
fill samples, so the tower still carries `+63.9` across almost all of it and only
snaps to the true `+11 LAPS` at his crossing. The replay's `pit` flag would have
rendered "PIT" instead, but it is recorded on his *own* lap 13 while the tower
indexes the *leader's* laps, so it does not cover the window. The clean candidate
is extending the pit state across a stop's real `duration_seconds`, which the
replay already carries.

**CP85** gives `/watch` preferences a `storage` listener, so two tabs no longer
diverge and then overwrite each other — watch mode is explicitly a second-screen
feature, so two tabs is a normal thing to do.

`backend/scripts/reap_stale_caches.py` is new and **dry-run by default**. Version
bumps retire cache documents without deleting them, and nothing had ever swept
them: `race_timing` was 71 MB of an 88 MB database with 59 of 70 documents dead.
It refuses to reap a collection whose current version has no documents — sync
first, then reap.

**An operational gotcha found while syncing v7:** rounds 8-11 first came back
"official only" because OpenF1's `/laps` silently returned nothing. `--force`
recovered them. A silent OpenF1 failure produces a structurally valid payload
with no intra-lap fill, and **only the `intra-lap` count reveals it** — every
other check passes.

## CP81 — the Australian GP replay was 84 seconds late (2026-08-18)

**Supersedes CP80 on the race start.** The user reported the watch replay still
wrong on round 1 — Leclerc showing "—" and "0" for timings, data missing
outright. Both were real, and they were two separate defects.

**Ground truth was available all along and nobody had looked for it.** OpenF1
serves `/race_control`, which carries a `SESSION STARTED` message. On the
Australian GP that is `04:03:26.365Z`; `CHEQUERED FLAG` minus the official
winner's race time (1:23:06.801) lands within 0.17s of it. Two independent
sources fixing lights-out to a fifth of a second.

Measured against that, across all eleven synced rounds:

| | round 1 | rounds 2-11 |
|---|---|---|
| uniform lap-1 `date_start` | **+0.000s** | **+0.000s** |
| `race_start_offset` (CP80) | **+83.99s** | +0.42 to +0.77s |

**Defect 1 — the derived start is a lap late on round 1.** `race_start_offset`
pairs OpenF1 lap N's crossing with the official lap N's cumulative time. On this
round OpenF1's `/laps` has *no boundary at the end of racing lap 1*: its lap-1
row spans two official laps (null duration), so its lap N is the official lap
N+1 from then on. Every per-lap estimate is one lap duration too large — **and
they all agree with each other**, so the median endorsed the wrong answer and
the 5s tolerance filter saw a textbook-tight cluster. 0 of 57 estimates were
within a lap of the truth. Consequences: every OpenF1 sample in the opening 84
seconds fell below `t=0` and was dropped (the missing data), and everything
after read a lap later's race beside a correct official position (the "0" — 
Leclerc parked on his P4 grid slot showing `+0.0/+0.0`, which is OpenF1's
*leader* reading from 84s later).

This is the file's own warning about a feed agreeing with itself, one level up:
the estimates are independent of each other but not of OpenF1's lap numbering.
The fix keeps the median for precision and adds `stated_race_start` as a coarse
anchor — an estimate more than 30s from the stated instant is describing a
different lap and is dropped. The two scales are far apart (0.45s residual vs a
≥64s minimum lap) and nothing lives between them. Rounds 2-11 come out
**identical to the microsecond**; round 1 moves −83.991s.

**The stated lap-1 `date_start` was discarded twice before, and both arguments
are now answered.** It reads as a formation lap only because round 1's lap-1 row
has a null duration and a 182.5s span — that row is *two laps*, not a formation
lap. CP80 then measured it "~90s early" against `race_start_offset`'s own
output, which is 84s late on exactly that round. Comparing two derived numbers
cannot say which is wrong; `/race_control` can.

**Defect 2 — the tower's first paint contradicted itself.** CP79's defect 7
seeded `liveOrder` from `orderAt(index, 0)` so the rows open in grid order. The
*contents* of those rows still rendered from the lap row, whose lap-1 entry is
the state at the **end** of lap 1. The served HTML had the rows in grid order
with Leclerc's row — sitting fourth — labelled **P1** and **+0.0**, Russell's
first and labelled P2, Hamilton's sixth and labelled P3. Every number real, none
describing the instant shown. `initialCells` now seeds the number and both gap
readings from the same `orderAt`/`sampleAt` calls the frame loop makes. Half a
fix is how this survived: order was correct before hydration, contents only
after.

**`verify_race_timing` gained a `gaps` check, and it is the point of this
checkpoint.** Every existing check scores *positions*, which are stamped from
the official record at each crossing and therefore survived the 84s shift
untouched — `boundaries` and `grid` read 100% on a payload whose entire timing
column was a lap out. `gaps` compares `gap_to_leader` at each crossing against
the gap the archive's cumulative times state there: independent, and it reads
**47% (median error 1.13s) on the deployed payload** against **97% (median
0.01s)** after the fix. Scored over numeric readings only — `"+1 LAP"` states a
fact a float comparison cannot.

Measured after: all 11 rounds pass; round 1 gaps 97%, boundaries 100%, grid
20/20, flag-order 17/17. Driven in headless Chrome, the tower opens on the
official grid with every gap `—` (honest: the cars are stationary) and Leclerc
runs P4 → P2 at 10s → the lead at 20s, which the archive independently confirms
he held at the end of lap 1.

`TIMING_VERSION` is **6**. All 11 rounds are already rebuilt and cached, so the
deploy serves them without a refetch. **The backend is not deployed yet.**

Two things worth carrying forward:

- **`/race_control` is an independent clock for any timing work here**, and
  neither this module nor `race_laps` had ever read it. `SESSION STARTED`,
  `CHEQUERED FLAG`, and the safety-car and flag messages are all wall-clock
  stamped and derived from nothing this app builds.
- **The preview pane cannot verify this route** — it hides the tab, which
  starves the rAF-driven replay clock, so the tower never advances and the check
  reads as a hang. Drive it with headless Chrome over CDP. This is a second
  instance of the pane note already recorded for the circuit viewer.

## CP80 — watch timing rebuilt on the official record (2026-08-09)

**Supersedes the CP79 section below wherever they disagree.** The user reported
that lap 2 of the 2026 Australian GP showed Russell ahead of Leclerc. Checked
against Jolpica's official lap-by-lap, the payload had laps 1 *and* 2 exactly
inverted — and `race_laps` agreed with the official record, so the fault was
ours alone. The official times are self-consistent (RUS 177.701s vs LEC 178.141s
at the end of lap 2, a real 0.44s lead).

**Two faults, neither reachable from inside OpenF1:**

- Its `/laps` feed is **missing lap-2 rows for cars 16, 63 and 44** on that
  round — the entire podium fight. The "leader's crossing" for lap 1 came from
  Hadjar in P4.
- The race start read off the uniform lap-1 `date_start` (see CP79 defect 6) is
  the **formation-lap departure, ~90s early**. Lap 1's 182.5s of wall clock was
  then squeezed onto the clock's 91.9s lap, compressing the opening 2:1 so laps
  1 and 2 landed on top of each other. *CP79's defect 6 reasoning is wrong and
  is retained below only as a record of the mistake.*

Correcting the start alone scored **worse** (57% vs 69% against official), which
is what forced the rewrite rather than a sixth patch.

**The architecture now:** the official lap archive (`app/official_laps.py`) is
the spine. Every driver gets an exact position sample at their own crossing, for
every lap; OpenF1 fills between crossings and is corrected at each one. Cumulative
official lap times *are* real elapsed seconds, so the payload ships `lap_ms` and
the clock runs on it — **there is no rescaling anywhere**, which is what removed
the whole class of bug. Aligning OpenF1's wall clock needs one number, measured
as the median of per-lap estimates (`race_start_offset`): stable to 0.2s across a
race, and robust to round 1's 13 bad laps.

Four further defects this rewrite surfaced, all found by measuring, not by eye:

1. **Truncated races cached silently.** Jolpica rate-limits a season sync; keeping
   the pages that arrived cached rounds 9-11 as 28-, 15- and 14-lap races, and a
   prefix of a race passes every consistency check. Now all-or-nothing with backoff.
2. **DNS cars parked on the grid forever.** Piastri and Hulkenberg held P5 and
   P11 all race, duplicating every position behind them — some position was
   duplicated in **19% of round 1**.
3. **Ghosts in the order.** Excluding them from the grid seed was not enough:
   OpenF1 emits rows for cars that never started, so they re-entered through the
   fill and sat in the order with no tower row, punching holes in the rendered
   ranks (`1,2,3,4,6,7,8,9,11,...`). The payload is now restricted to cars the
   official record says took part, and `verify_race_timing` has a `ghosts` check.
4. **Retirements never left.** A retired car's last sample carried forward to the
   flag. The payload now carries `out_ms` per driver.

**The tower renders rank over the live order, not the raw sampled position.**
Positions are stamped at each car's own crossing, so two cars on different laps
routinely report the same number; ranking makes the numbers unique and contiguous
by construction and impossible to disagree with the row order. This is *not* the
renumbering bug fixed earlier — that indexed the rendered rows, this indexes the
order itself.

Measured across all 11 rounds: archive 100%, boundaries 100%, grid 100% of
starters, rendered ranks collide in 0% of every race. `flag-order` is now
reported **without a threshold** — the deviations are post-race penalties, and
asserting on them was scoring the stewards rather than the code.

```
cd backend && python -m scripts.sync_race_timing     # build + cache all rounds
cd backend && python -m scripts.verify_race_timing   # gate the deploy
```

Verify the *page* too, not just the payload — `data-car` on each tower row exists
for that. A stale Next fetch cache made the browser show pre-fix data for two
rounds of debugging; clear `.next` when a UI check disagrees with the payload.

## CP79 — read this first: the verification lesson, not the bug list (2026-08-09)

Seven defects shipped in this checkpoint. **One user, checking one race against
what they remembered, found every category of them.** The unit suite (952 tests),
a real browser, and "we can see intra-lap movement" all passed on a payload whose
timeline was shifted a lap, which discarded the opening 90 seconds of every race,
and which rendered a mid-race order before the race had started.

The single cause: **every check compared the OpenF1 feed against itself.** A feed
always agrees with itself. `backend/scripts/verify_race_timing.py` exists because
of this and should be run after any change to `race_timing.py`:

```
cd backend && python -m scripts.verify_race_timing            # local rebuild
cd backend && python -m scripts.verify_race_timing --deployed # the live service
```

Every assertion in it is against a source the payload is **not** built from — the
official grid and classification from `race_results`, this app's own `race_laps`
positions (same feed, different join, so it disagrees when anchoring is wrong),
and the raw feed's own event count. It exits non-zero, so it can gate a deploy.

Two things it has already taught, both worth keeping:

- **It caught a round-10 "failure" that was the harness's fault, not the code's.**
  Two laps there have no recorded duration; the script treated them as zero and
  drifted its comparison instant 220s, reporting 60% timeline misalignment in a
  correct payload. A harness that models the clock differently from the clock
  invents failures. Fixed in the harness; the code was right.
- **The payload being correct does not mean the page is.** Defect 7 below was
  invisible in every payload check and only appeared when the deployed page was
  driven in a browser *before pressing play*. Check both.

## CP79 — per-second watch timing, shipped and then corrected seven times (2026-08-09)

Two defects beyond the five listed below, both found after the first "it's fixed":

6. **The race start was inferred rather than read, and landed ~90s late.** Lap 1
   opened at `boundaries[1] - lap_1_duration`. The feed states the start outright:
   every driver's lap-1 `date_start` is the *same* timestamp (20 identical values
   on round 1) because it is the start signal, not a per-car measurement. The
   derived instant discarded every position change in the opening — round 1 kept
   253 in-race position events where the feed has 509, and Hamilton showed P7 for
   seventeen minutes after actually running P7→P3 within ten seconds of lights
   out. **The earlier reasoning for discarding that timestamp was careful and
   still wrong**: the row carries `is_pit_out_lap: true` with a null
   `lap_duration` and sits 182.5s before the leader's lap-1 crossing while
   `race_laps` calls lap 1 91.9s, so it read as a formation lap. Lap 1 genuinely
   took 182.5s (starting-procedure investigations; lap 2 took 81.4s), and
   `is_pit_out_lap` is true only because the cars drove out of the pits to the
   grid. A stated fact beats a plausible inference.
7. **The tower rendered a mid-race order before the race started.** `liveOrder`
   began `null`, and null means "fall back to the lap row" — whose lap-1 entry is
   the order at the *end* of lap 1. So opening the page showed Leclerc P1 and
   Hamilton P3 until the clock produced its first frame. Now seeded from
   `orderAt(index, 0)`, which also makes the server-rendered markup correct
   rather than correct-after-hydration.

`TIMING_VERSION` is **4**. Note the pattern in why it kept moving: 3 and 4 both
changed *how the payload is derived* without changing its shape, so stale
documents stayed structurally valid while serving wrong data. Bump on derivation
changes, not only shape changes.

## CP79 — the first five defects (2026-08-09)

`/watch` no longer updates once a lap. `race_timing.py` + `watch-timing.ts` serve real OpenF1
`/intervals` and `/position` samples on a race-elapsed clock; the tower reorders when the feed says
so, the interval counts down between samples, and an INT/GAP toggle picks which number leads.

**The feature shipped wrong and every check I ran said it was right.** The user found it by watching
the Australian GP against the replay: the tower opened with Ferrari 1-2 when Mercedes locked out the
front row. Five defects came out of that one report:

1. **The whole race was shifted a lap.** OpenF1's lap-1 row is the *formation* lap
   (`is_pit_out_lap: true`, `lap_duration: null` on every driver), so `_lap_spans` took its
   "drop lap 1 rather than guess" path on every real round — making `spans[0]` lap 2, so `t_ms = 0`
   meant the start of lap 2. Lap 1's duration now comes from `race_laps`.
2. **`t_ms` summed OpenF1 wall-clock boundaries while `watch-clock.ts` sums `race_laps` durations** —
   two timelines drifting apart over ~58 laps. Wall-clock spans now only classify *which* lap an
   instant falls in; elapsed time is expressed in the clock's own durations.
3. **No starting grid**, so the lookup clamped backwards and showed a mid-race order as the grid.
4. **The position number came from the row index**, so a car with no lap row (Piastri, retired lap 1)
   renumbered everyone behind it.
5. **Gaps on a stationary grid** — every car showed an interval under a second at t=0, lighting the
   closing ring across the whole tower.

**The trap worth carrying forward: `/position` has no instant that reliably means "on the grid."**
Recovering the grid by collapsing pre-race position events to their final state reproduced the
official grid **22/22** — and was wrong. The probe that "confirmed" it used the formation lap's start
as the race start; measured against true lights-out, that state is the order at the *end* of the
formation lap, where cars have shuffled: **1 of 22**. The grid is now read from `race_results`. A
perfect-looking match against a source you also derived is not evidence.

**A fix that made things worse, kept as a recorded score.** OpenF1 emits position events for a car
*after* it finishes, as the cars behind it cross (Monaco walks Gasly P3→P7 in six seconds post-flag).
Cutting each driver's samples at their own crossing sounds obviously right and measured **162/191**
against **167/191** for the race-wide window. Reverted; the number is in the code so the argument
does not get re-run on its plausibility.

**Verification that actually works here:** `race_results` as independent ground truth.
Grid **242/242 exact** across all 11 synced 2026 rounds; classified finishing positions **167/191**.
Both are re-checkable against the deployed service in a few seconds and neither can be satisfied by
the feed agreeing with itself — which is how all five defects passed 943 tests, a real browser, and
observed intra-lap changes.

**Known and accepted, not bugs to chase:** Monaco (round 6) scores 3/15 on finishing order because
its position feed is genuinely unreliable; a duplicate position can show for ~1s during a swap
(the feed updates the two cars at different instants); OpenF1 emits `+0.0` placeholders for some cars
early; and the finish can never reach 191/191 because official classification includes post-race
penalties a position feed cannot express (round 11's Hamilton/Leclerc inversion is a 0.7s time
difference, not a position event).

**`TIMING_VERSION` is 3.** Note *why* it went to 3: the tail fix changed how the payload is derived
without changing its shape, so every v2 document stayed structurally valid while serving the pre-fix
finishing order. Bump on derivation changes, not only shape changes — nothing else surfaces them.

## Batch 21 is COMPLETE, merged, deployed and reviewed (2026-08-08)

CP76, CP77 and CP78 are all on `main` and live. `/watch/2026-11` plays a race at the pace it
actually happened; `/watch/2026-14` (genuinely unsynced) names itself and offers the Hungarian GP.

The whole-branch review found **no Critical issues** and four Important ones, all fixed:

1. Submitting the *empty* jump-to-lap field silently restarted the race at lap 1. The field is
   cleared after every jump, so a second Enter always submitted nothing — and `Number("")` is `0`,
   which passed the `isFinite` guard and clamped to lap 1. Same destructive effect as the labelled
   "Back to lap 1" button, reachable by accident, with no undo.
2. `formatLapDuration` rounded *after* splitting minutes, so it rendered `0:60.0` and `1:60.0` — the
   live readout repaints every frame, so this flashed on **every** lap crossing a minute.
3. **`.apex-glass-*` is declared unlayered**, so it beats every Tailwind utility for a property it
   declares, regardless of specificity. The live victim was the jump-to-lap input, which had
   `outline-none` plus a `ring` that `.apex-glass-soft`'s `box-shadow` swallowed — leaving keyboard
   users **no focus indicator at all**. Now uses `outline`, which no glass class declares.
4. This section itself, which used to say CP78 was unfinished after it had merged.

**The layering finding is the one worth carrying forward.** It had already caused two earlier bugs
(`display: inline` on the citation mark in Batch 20, `position: fixed` on the watch pinner), both of
which were diagnosed as "specificity" and patched with inline styles. The wrong diagnosis is exactly
why it recurred a third time on the focus ring. The full explanation and the practical rules now live
above the glass definitions in `globals.css`.

Known and accepted, recorded rather than fixed: preference caches are per-tab with no `storage`
listener, so two open `/watch` tabs diverge; `findWatchableFallback` can offer a later round than the
one requested (harmless — the offered race is real and watchable); superseded `race_replay` cache
docs from older `REPLAY_VERSION`s are never reaped.

**The long-lap question CP77 deferred is decided: no cap.** The reasoning lives in
`watch-clock.ts` beside `FALLBACK_LAP_SECONDS`. Short version: a cap would make a safety-car lap
finish sooner than it did, which is the fixed-tick failure this batch exists to remove, and anyone
lining the mode up against a broadcast would drift out of sync exactly when the race got interesting.

## Batch 21 — the `race_laps` backfill is DONE (2026-08-08)

Run locally against production Mongo, all 11 synced 2026 rounds. **Do not re-run it** unless a new
round syncs; `sync_race_laps` fills `lap_time_seconds` going forward without help.

Two guards were used and are worth reusing for any future backfill of a live collection: the script
refused to write when a rebuild produced *fewer* rows than were stored, and it compared row counts
before/after. Every round came back byte-identical in row count, and `gap_seconds` remained non-null
on **100%** of rows in every round — the CP76 regression that would have hurt most did not happen.

| Round | rows | durations filled | median lap | max lap |
|---|---|---|---|---|
| 1 | 1004 | 1000 | 85.22s | 132.25s |
| 2 | 919 | 904 | 98.37s | 149.98s |
| 3 | 1106 | 1086 | 95.82s | 149.83s |
| 4 | 1038 | 1033 | 94.72s | 149.96s |
| 5 | 1208 | 1206 | 77.47s | 133.83s |
| 6 | 1448 | 1415 | 79.06s | 149.16s |
| 7 | 1234 | 1233 | 84.18s | 125.26s |
| 8 | 1338 | 1338 | 73.14s | 113.38s |
| 9 | 1111 | 1092 | 95.93s | 149.73s |
| 10 | 871 | 810 | 112.02s | 164.35s |
| 11 | 1430 | 1429 | 86.40s | 140.00s |

**This data is the argument for the feature, not just an input to it.** Medians run 73-112s and vary
by circuit exactly as real lap times should, and every round's maximum is 30-60 seconds *above* its
median — those are safety-car and traffic laps. A fixed 560ms tick renders all of that identical.
Coverage is 93-100%; the nulls are first laps, sparse timing and CP76's deliberately-unfabricated
carried-forward rows, which is why CP77 must have a median fallback rather than assuming the field.

## Batch 20 (CP71-75) — merged; measured numbers below

### Verified in production, 2026-08-08, after deploy

`prompt_version: 3`. One live call to the deployed service with the user's own question
("Compare Norris and Verstappen this year") confirms the whole batch end to end:

- **CP73**: **1 tool call, 41.5s, converged** — against the pre-fix 10 calls / 95.4s / no answer.
- **CP72**: 7 anchors, each resolved to a real field — `Max Verstappen → name`, `109 → points`,
  `11 → rounds_entered` — with real spans. The cited thing is the claimed thing.

**Two production bugs were found by this check that no review or test caught**, both recorded in
`ROADMAP.md`: the answer cache stored the step-budget degrade (so one transient failure answered
that question forever, and it made CP73's fix look broken after deploy), and `PROMPT_VERSION` had
not been bumped despite the prompt and two tool signatures changing.

**Still unverified:** nobody has driven the citation UI in a real browser against the live agent.
The data path is proven and the rendering logic was fuzzed over 200k cases in review, but no one has
watched an underline open a popover in production.

### CP73's before/after, the batch's one hard measurement

Reproduced against the **deployed** service before changing anything, using the user's own wording
("Compare Norris and Verstappen this year"):

| | tool calls | latency | outcome |
|---|---|---|---|
| Before (deployed) | **10** | 95.4s | `get_head_to_head` never called; step budget exhausted, no answer |
| After, run A | **1** | 61.1s | converged, verifier passed, 0 violations |
| After, run B | **2** | 49.1s | converged, correct cited answer |

**The "after" runs are local against the same production Mongo and the same Ollama Cloud model** —
the method CP61 and CP63 used for their own numbers. Latency across the deployed and local paths is
not strictly comparable (different network, different container); the tool-call count and *whether it
converges at all* are, and those are what moved. A post-deploy re-measurement is the one thing this
batch has not done.

Two mechanisms behind the original failure, neither previously named:

1. `get_head_to_head` took opaque Jolpica ids (`max_verstappen`, not "Verstappen") and returned duel
   counts *without* season totals — so even a correct call left a reason to keep calling more tools,
   and CP61's baseline had already recorded calls failing **soft** on id mismatch, which teaches the
   model the tool is useless. It now takes names and returns a bundle that is actually complete.
2. `get_season_state` exposed its optional `today` argument to the model, which asserted 2025-11-03
   (real date 2026-08-07), re-read the wrong season and burned the budget. Now stripped from the
   model-visible signature.

### Follow-up chips were live-checked, and the check found a real gap

The deployed model produced 4 suggestions for "Who won the Australian Grand Prix this year?" and all
4 survived the router guard — the feature works. But probing the guard's *drop* side found that
`route.subjective` never fires on the phrasings a model produces, so CP75's documented opinion drop
was inert. Fixed with a question-side filter owned by the chip surface (the router itself is
deliberately unchanged — widening it would alter how real user questions route). See `ROADMAP.md`'s
Batch 20 section for why this generalises.

### Environment gotcha found this session

**`remark-gfm` is in `frontend/package.json` but was not installed in the main checkout**, so
`npm run build` failed on `main` with `TS2307: Cannot find module 'remark-gfm'` *before* this batch
touched anything. `npm install` fixes it. Worth knowing because it looks exactly like a code
regression introduced by whatever you just merged, and is not.

**Four orphaned worktree directories exist on disk that `git worktree list` does not report** —
`.claude/worktrees/agent-a10134c26331d6528`, `agent-a1895e413d9f9ec8b`, `agent-a822775c575765bfb`,
`agent-abdf58d6442b85630`. This is the exact pattern `ROADMAP.md`'s Batch 6-7 retrospective warns
about. They predate this session and were left alone rather than deleted blind.

## Where things stand

Batches 1 through 9 are fully merged (see `ROADMAP.md`'s "Shipped batches" table for the full
history, including ad-hoc additions built mid-batch). A durable roadmap-tracking system exists at
`ROADMAP.md` — **current batch and checkpoint status live there** (see "Current batch"), not in
this file. This file only carries session-specific working memory: recent gotchas, environment
quirks, and the immediate next action.

### Batch 19 (CP67-70) is fully merged — deploy status below

All four checkpoints (CP67 guardrails, CP68 visual citations, CP69 feedback loop, CP70 chat UX
polish) are merged to `main` as of 2026-08-07. See `ROADMAP.md`'s "Current batch" section for the
summary and `docs/superpowers/plans/` for each checkpoint's implementation plan. Each checkpoint went
through the same process: subagent implementation per task, a final whole-branch review, and a fix
pass where the review found something — two genuine Critical/Important-class bugs were caught this
way before merge: CP69's feedback endpoint had no vote dedupe (mitigated, not fully proven — see the
CP65 section below), and CP70's own SSE heartbeat had broken cancellation propagation, which would
have quietly kept burning inference quota after a user closed the tab. Whether this is deployed live
depends on when this note is read — check the "Where things stand" verification steps below rather
than trusting this paragraph's tense.

### Batch 17 (CP59-62) is fully merged AND deployed — this section was stale

A prior session's local sandbox had no authenticated `gcloud` and left this file saying "deploy
outstanding." **That is no longer true.** CP61 (PR #108) and CP62 (PR #107) are both merged to
`main`, and the deployed `f1-agent` Cloud Run service was re-verified live in this session
(2026-08-05):

- `GET https://f1-agent-2w5wydk2ca-el.a.run.app/health` → `{"status":"ok","model":"nemotron-3-nano:30b","langsmith_tracing":true,...}`.
- A real `/api/chat` SSE call produced **33 separate `token` events** (not one chunk — see the
  `/agent-check` warning below, this is the exact check it exists for) plus `activity`, `sources`
  and a terminal `done` event carrying a `run_id`. Streaming and tracing both work end to end in
  production.
- `https://f1-frontend-1076575666662.asia-south1.run.app/pitwall-chat` and `/agent-check` both
  return 200.

**A fresh finding from that same live verification, worth carrying into Batch 18 rather than
treating as a new bug:** asking the deployed agent "Who won the last race?" answered **"the 2025
Abu Dhabi Grand Prix," which is wrong** — the real last-completed race as of 2026-08-05 is Round 11,
the Hungarian GP (Norris). Confirmed the underlying data is fine (Atlas `f1_scratch.races` has all
23 dated 2026 rounds; `race_results` has real results through round 11 — checked directly against
Atlas from this sandbox), so this is **not** a data-sync gap. It is a fresh instance of exactly the
failure `backend/agent/spikes/README.md` §5 already measured and named the reason for CP64: the
model is not reliably grounding its answer in the tool data it fetched, and CP61 shipped
deliberately without a verifier to catch it. Nothing to fix here — it is corroborating evidence, not
a new root cause to chase.

**Installing `backend/requirements-agent.txt` in this sandbox's shared (non-venv) Python breaks
`pandas`/`fastf1` until you re-pin `numpy<2` afterward** — the agent stack pulls in `numpy>=2`
transitively, which ABI-breaks `pandas` and silently drops ~127 tests from `unittest discover`
(it reports "OK" on 444 tests instead of the real 571+, because five test *modules* fail to import
rather than fail an assertion). `pip install "numpy<2"` immediately after fixes it. Not an issue in
the actual deployed image — `Dockerfile.agent` never installs `pandas`/`fastf1` at all — only in this
local sandbox where every checkpoint shares one global site-packages directory. Full detail in
`backend/agent/spikes/README.md` §4.

### CP63 (router + subagents) is code-complete on `feat/agent-subagent-router`, deploy outstanding

Built and measured live this session — three real findings, in the order they were found, each
worth reading before touching `agent/router.py` or `agent/subagents.py` again:

1. **Every subagent needs its own "no filesystem" rule — it does not inherit the orchestrator's.**
   The first live test of `web-researcher` (tier 3, "what's the latest F1 news?") called `web_search`
   correctly, got an empty result (placeholder `TAVILY_API_KEY`), then called `ls` and `glob` before
   giving up — the exact filesystem-probing failure CP61's baseline already hit once
   (`agent/spikes/README.md` §5) and fixed with an explicit prompt rule. That rule lived only in
   `graph.py`'s `SYSTEM_PROMPT`/`ORCHESTRATOR_SYSTEM_PROMPT`; a subagent's `system_prompt` is a
   wholly separate string with nothing inherited, and `subagents.py`'s four prompts did not carry it
   the first time they were written. Fixed by appending a shared `_NO_FILESYSTEM_RULE` to all four —
   re-verified clean (no filesystem calls) afterward.
2. **Tier 2 was downgraded from "uses subagents" to "flat graph, same as tier 1" — a live
   measurement, not a design change made in the abstract.** The original design routed comparative/
   causal/strategy/history questions (tier 2) to the multi-agent graph. Live-tested against "Compare
   Verstappen and Norris this season" — the same taxonomy class CP61's own baseline answered
   correctly in 50.9s (`agent/spikes/README.md` §5, run #4) — `stats-scout` made **ten** redundant
   tool calls (seven `get_session_result`, three `get_driver_season_summary`) trying to assemble a
   season comparison one round at a time, and still had not converged after 287 seconds
   (`AGENT_REQUEST_TIMEOUT_SECONDS` raised to 280 for the diagnostic run; production's real 180s
   would have hit `ModelTimeout` even sooner). CP63's own done-criterion says exactly what to do with
   this: "multi-agent measurably beats CP61's baseline... if it does not, we say so and keep the
   baseline." It does not, for tier 2, so `router.Route.use_subagents` is now `tier >= 3`, not
   `tier >= 2`. Tier 2 keeps its own classification label (useful telemetry for CP65's golden set)
   but routes exactly like tier 1. Tier 3 is unaffected — it is a genuine net-new capability (web
   access) with no CP61 equivalent to lose a comparison to.
3. **A residual inefficiency, left as a known follow-up rather than chased further this checkpoint:**
   re-tested after the downgrade, the same comparative question now converges in 125.7s with a
   correct answer (5 evidence entries) — no timeout, real improvement over 287s+, but still short of
   CP61's 50.9s. The activity trace shows the flat orchestrator briefly delegating to a
   `general-purpose` subagent it was never given (`"Delegating to general-purpose"` at 80.3s), which
   then re-did `resolve_context` and `get_driver_season_summary` calls the orchestrator already had
   direct access to. This is **not new to CP63** — `deepagents.create_deep_agent` auto-adds a default
   `general-purpose` subagent (and therefore the `task` tool) unless explicitly disabled via a
   `general_purpose_subagent=GeneralPurposeSubagentProfile(enabled=False)` harness-profile setting
   that neither CP61 nor CP63 configured; CP61's own spike notes already documented that default
   filesystem tools are "always present whether or not the system prompt mentions them," and this is
   the same class of always-on default, just for `task()` instead of `ls`. Worth fixing in a future
   checkpoint (disable the harness-profile default rather than prompting around it, per this repo's
   own "check it in code, not by asking nicely" rule), not blocking CP63's merge.

**What's actually new and working**: `agent/router.py` (pure-Python tier classifier, no model call,
15 unit tests), `agent/subagents.py` (four `SubAgent` specs — `stats-scout`, `historian`,
`web-researcher`, `race-analyst` — assembled from CP60's existing tools plus CP62's web tools, wired
into a live conversation for the first time, 11 unit tests), and `graph.py`'s `build_agent` gaining a
`use_subagents` branch that preserves CP61's exact flat path unchanged for tiers 1-2. 671 backend
tests pass (670 + 1 net-new since the last count, after adding and later trimming test files). Tier 1
(unchanged), tier 2 (downgraded, now flat, 125.7s), and tier 3 (subagent-delegating, correct
quarantine/no-filesystem behavior, honest degrade with the placeholder `TAVILY_API_KEY`) were all
live-verified locally against real Ollama Cloud calls.

**CP63 is merged and deployed** (PR #110) — the user explicitly authorized merging without waiting
for review this session ("keep merging the pr don't wait for me, keep continuing until this batch is
done"), a standing instruction for the rest of Batch 18, not a one-off. `f1-agent-deploy`'s Cloud
Build trigger fires on push to `main` and was confirmed `SUCCESS`; the redeployed service was
re-verified live: `/health` unchanged, and a real `/api/chat` call against "Who won the 2026
Hungarian Grand Prix?" returned the correct answer (Lando Norris) with `"tier": 1` in the `done`
event — the first time that documented-but-unused field (present since CP59) has actually carried a
value.

**Also confirmed live: `gcloud` is authenticated in this sandbox and Cloud Build triggers can be
watched/polled directly** (`gcloud builds list`, `gcloud builds describe <id> --format="value(status)"`)
— another HANDOFF claim ("no authenticated gcloud") that was stale by the time this session ran.
`gcloud builds log --stream` does not work for this project's builds specifically because
`cloudbuild-agent.yaml` (like every trigger here) carries the mandatory `options: logging:
CLOUD_LOGGING_ONLY` — use `gcloud builds describe --format="value(status)"` in a poll loop instead,
or `gcloud beta builds log --stream` for the Cloud Logging equivalent.

### Batch 18 status after CP63

CP64 (the verifier) is next once CP63 merges and deploys. It is the highest-value remaining
checkpoint given the "who won the last race" grounding finding earlier in this file — it is the
architectural fix, not another prompt rewrite (CP41 already showed restating a rule doesn't work).

### CP64 — the verifier, done and deployed

`agent/verifier.py` is the deterministic core of §7's design: `[ev_N]` citation parsing, a check that
every cited id exists in the turn's `EvidenceLedger`, a check that every number in a cited sentence
actually appears in that evidence entry's data, and the two framing contracts (predictive answers
must hedge; subjective answers must not deliver a verdict). Deliberately **not** the full five-stage
pipeline the plan describes — no LLM claim-extraction call, no LLM entailment pass. Those are left for
a future checkpoint once this deterministic core has production data showing whether it's enough on
its own, the same "measure before adding the expensive part" discipline CP63 just re-learned.

**The citation format needed adding to six prompts, not one — a design detail only visible once you
trace where a subagent's tool-call evidence actually goes.** `graph.SYSTEM_PROMPT` and
`ORCHESTRATOR_SYSTEM_PROMPT` now instruct `[ev_N]` citation, but the four subagent prompts
(`subagents.py`) needed the *same* instruction for a non-obvious reason: a subagent's own tool calls
populate the shared ledger, but the orchestrator only ever sees the subagent's final **text** reply
through the `task` tool, never its raw tool calls. If a subagent doesn't cite in its own reply, the
citation is lost before the orchestrator ever has a chance to attach one — the verifier would then
reject a perfectly-grounded synthesis for an uncited claim that was never the orchestrator's fault.
Fixed by adding a `_CITATION_RULE` to all four subagent prompts (mirroring `_NO_FILESYSTEM_RULE`'s
shape) and telling the orchestrator to preserve a subagent's citations exactly rather than renumber
them.

**Live-verified, with the citation contract working end-to-end on a real model call**: "Who has the
most wins at Monaco in F1 history?" (tier 2, routed flat per CP63's downgrade) converged in 18.7s with
one tool call, answered "Ayrton Senna... 6 victories **[ev_1]**", and `verifier.check` passed with
zero violations — the first real proof the `[ev_N]` format the prompts ask for is actually what the
model produces, not just what was requested (the CP41/CP44 discipline this repo already holds every
prompted format to).

**Two live attempts that did NOT converge, worth recording honestly rather than treated as a CP64
bug**: a harder comparative question ("Compare Verstappen and Norris this season") hit
`AGENT_MAX_STEPS` and degraded to the existing, already-correct "step budget exceeded" message
(`GraphRecursionError`'s handler, unchanged from CP61) — the activity trace shows it wandering into
`grep`/`ls` and re-resolving context twice before running out of steps, the same category of
intermittent tool-call unreliability CP61's own baseline measured once already ("the same model that
handled five other questions correctly skipped tool-calling entirely on this one"). A web-research
question hit the raw 180s `ModelTimeout` with no visibility into what happened first. Neither is new:
CP63's own retrospective already named "a ~30b model doing nested `task()` dispatch reliably" as *the*
architectural risk in this whole plan, and both failure shapes degrade honestly (a plain apologetic
message, or a clean SSE `error` event) rather than crashing or fabricating — which is exactly what the
degrade paths CP59/61 already built are for. Not chased further with additional live calls given the
free-tier quota; worth a future checkpoint if it recurs at real user volume (candidates: raise
`AGENT_REQUEST_TIMEOUT_SECONDS` for tier 2/3 specifically, or revisit whether `stats-scout`'s tool set
is too broad for one delegation).

**Repair loop proven mechanically via a stubbed agent, not a live call** (`test_agent_graph.py`'s
`RepairLoopTests`) — mirrors `test_agent_chat.py`'s existing pattern of proving the SSE transport
without a real model behind it: a scripted agent returns an uncited draft first, a cited draft second,
and the test asserts exactly two invocations, the repair message naming the real rejected draft and
violation, and that the user-visible token stream only ever contains the *repaired* text, never the
rejected first attempt.

**`sse.py`'s `done` event gained a `verification` field** (`"passed"` / `"verification_failed"` /
`None` — `None` for tier 1, which CP64 skips entirely, and for the echo fallback), populated for the
first time by this checkpoint the same way CP63 first populated the long-documented-but-unused `tier`
field.

### CP65 — golden set + deterministic CI gate, scoped down from the plan on purpose

`agent/golden_set.py` (24 cases, not the plan's ~60) and `tests/test_agent_golden_set.py` are the
actual shipped scope. Two deliberate reductions from `CHAT-AGENT-PLAN.md` §9, both worth stating
plainly rather than discovering later that "the golden set" quietly means less than advertised:

- **24 cases, authored, not mined from real traces.** The plan's own words: "the golden set must come
  from real traces, not from questions we invented." At Batch 18 there is no production traffic yet —
  `/pitwall-chat` is still a dev-flagged route — so there are no real traces to mine. Grow this set
  from real `LangSmith` traces once there is real usage, per §8's "curated datasets" pipeline (bad run
  found in a trace → promoted into the dataset). Recorded as a todo, not silently left implicit.
- **`deepeval`'s own metrics are not wired into a live CI gate.** `ToolCorrectnessMetric` and everything
  like it need an actual agent run's `tools_called` to compare against — there is no way to produce
  that without a real Ollama call, and running ~24 live calls on every PR would spend real free-tier
  quota this whole architecture exists to conserve (§4.2). This is the plan's own §9 caveat
  ("LLM-judge metrics... cost GPU time we do not have") stretched to its logical end: even a
  *deterministic* metric needs a live trace. What actually ships instead: every golden case's expected
  tier/predictive/subjective flags checked against `router.classify` (free, deterministic, runs on
  every `unittest discover` — this genuinely is "gates every PR"), five hand-built cases proving
  `verifier.check` behaves as documented against fixed drafts (no live call needed either), and a
  `deepeval`-based smoke test (`EvalDatasetSmokeTests`) proving the package's own metric wiring works
  against a **fabricated** matching/mismatching trace — real infrastructure, not a live-model gate.

**One gap recorded rather than hidden: CP61's own measured failure — an ungrounded tier-1 aggregate
answered from parametric memory — is still not caught by anything.** CP64's verifier explicitly skips
tier 1 ("tier 1 streams live and skips verification"), and the router still classifies that exact
question as tier 1 today. `test_tier_1_aggregate_question_is_not_verified_at_all` asserts this stays
true rather than silently passing if it ever changes — a real, open item for a future checkpoint
(likely: either verify tier 1 too, at the cost this batch has been trying to avoid, or add a
zero-tool-call-answer guard specifically, which is cheaper than full verification).

**`deepeval` itself is deliberately not installed in this shared sandbox.** It lives in a new
`backend/requirements-agent-eval.txt`, never referenced by `Dockerfile.agent` (the deployed service
never needs it — offline CI tooling only, per §9) and never installed into this sandbox's shared
Python — the same numpy/pandas ABI-break incident already documented for `requirements-agent.txt`
is a real risk `deepeval`'s own large dependency tree could repeat. `test_agent_golden_set.py`'s
`deepeval`-dependent tests skip cleanly (`@unittest.skipUnless(HAS_DEEPEVAL, ...)`) when it is absent,
so the rest of the 710-test suite is unaffected either way.

**LangSmith dataset curation and thumbs-up/down feedback wiring — named in the plan's CP65 row —
were deferred at CP65, and are now built, as of CP69.** See
`docs/superpowers/plans/2026-08-06-batch19-cp69-feedback-loop.md` for the full plan: `POST
/api/feedback` forwards thumbs up/down to LangSmith and fails soft (commit `1b9aa34`),
`scripts/curate_goldens.py` mines thumbs-down runs into human-reviewed golden-set candidates (commit
`f2bbc5f`), and the frontend thumbs UI on `/pitwall-chat`'s assistant panel wires both together
(commit `394deaa`). This closes the deferral recorded below verbatim.

**Server-side vote dedupe on `POST /api/feedback` remains an accepted risk, not a proven fix.**
A whole-branch review flagged that a rapid double-click or a devtools/curl replay could post the
same `run_id` twice with nothing stopping it server-side. The mitigation applied: `feedback_id` is
now derived deterministically from `run_id` via `uuid.uuid5` against a fixed namespace, so repeats
of the same `run_id` always produce the same `feedback_id` instead of a fresh random one. Whether
this actually dedupes depends on whether the LangSmith backend treats a repeated `feedback_id` as
an upsert — the installed `langsmith` SDK (0.10.15) does not document that behavior in
`Client.create_feedback`'s docstring, and it ships a separate `Client.update_feedback(feedback_id,
...)` method, which suggests create and update are distinct server-side operations rather than the
same POST upserting on id collision. Applied as defense-in-depth on the (plausible but unconfirmed)
chance the backend does dedupe on id, not relied on as a proven fix. Acceptable given the endpoint
is telemetry-only, fail-soft, and already unauthenticated — a duplicate vote in LangSmith is not a
user-facing failure.

**No deploy needed for CP65** — pure test/CI infrastructure, no runtime code in `agent/graph.py`,
`agent/main.py` or any other file the deployed service actually imports.

**CP70's thread-persistence item was decided, not silently skipped: kept as-is.** The batch plan
flagged "thread id regenerates on every panel open" as a decision to make, not a bug to fix — a fresh
`crypto.randomUUID()` thread per open, discarding the conversation on close, is documented as
deliberate in both `pitwall-assistant-panel.tsx`'s and `pitwall-assistant-launcher.tsx`'s own
comments (avoids an indefinitely-growing thread; each open is a genuinely fresh mount). CP70 confirms
that reasoning still holds and makes no change. Revisit only if a future checkpoint has a concrete
reason to add cross-session persistence (e.g. a "conversation history" feature), at which point it
should ship with an explicit "New conversation" affordance, not as a silent default.

**CP71 supplied that concrete reason and partially reversed this — read the two notes together.**
The user asked directly for a way to clear the conversation, so CP71 added a **"New chat" control**
in the panel header (clears `messages`, regenerates `threadId`, confirms first when the thread is
non-empty). Note what did *and did not* change: thread-per-open is **still** the behaviour — closing
and reopening the panel still starts fresh, and nothing is persisted across mounts. What CP71 added
is the explicit reset affordance CP70's own note said should accompany any change here, so a user
can now clear a long thread *without* closing the panel. Cross-session persistence remains
unbuilt and still needs its own decision if it is ever wanted.

### CP66 — production UI + answer cache, scoped tightly given session time

**Shipped:** the portaled Pitwall Assistant panel (`pitwall-assistant-panel.tsx` +
`pitwall-assistant-launcher.tsx`), reachable from every page via a nav trigger, replacing
`/pitwall-chat` (CP61's dev preview, kept unlinked for isolated debugging, same precedent as
`/agent-check`). Follows the app's own established portal/glass pattern exactly
(`createPortal(..., document.body)`, `apex-glass-strong`, the same spring transition shape as
`driver-modal.tsx`) rather than inventing a new one. Adds a real activity **timeline** (every step in
order, not just the in-progress ones the dev page showed) and renders the `tier`/`verification` fields
CP63/64 added as a plain, honest badge when verification failed — never hidden.

**Backend answer cache** (`agent/answer_cache.py`), the plan's own §4.2 architecture decision
("caching is load-bearing, not an optimisation"), scoped down to exact-question-text + `PROMPT_VERSION`
keying rather than the plan's fuller "resolved entities" design — a real simplification, not a hidden
one, see the module's own docstring. **Never caches a `verification_failed` answer** — caching a known-
flagged draft forever would repeat that exact failure to every future asker. Gated behind
`config.mongodb_uri()` the same way `checkpointer.open_saver` already degrades without one; this
mattered in practice, not just in theory — wiring it in without the gate made every existing
`test_agent_chat.py` case attempt a real (hanging, not failing-fast) Mongo connection the first time
`_stream` ran, since those tests mock `graph.astream_answer` but the cache check now runs *before* that
mock is ever reached.

**Deferred, explicitly, given remaining session time:** full "budget caps" (a real product-policy
decision — daily/session limits — better made from actual usage data than guessed now) and a genuine
load test (would spend real free-tier quota; the existing global concurrency semaphore already
serializes concurrent requests correctly, proven in CP59, and re-proving it under synthetic load adds
little without real traffic to calibrate against). Both are real Batch-19-or-later candidates, not
silently dropped.

Two stale-local-branch traps worth knowing about, found while syncing this session: this repo
accumulates many now-merged local feature branches (`feat/agent-web-research`,
`feat/agent-single-baseline`, `feat/agent-tool-layer`, `feat/agent-service-skeleton`, etc.) whose
work already landed on `main` under a different (squash-merged) commit hash. **Always `git fetch
origin` and diff local `main` against `origin/main` before assuming a local branch's uncommitted or
unpushed-looking work is real outstanding work** — in this session, an apparently-unmerged local
commit (`bb10f98`, "web research tools + injection quarantine") turned out to be byte-identical to
the already-merged `origin/main` commit `f70e08b` (PR #107). Also: local `main` itself was two
commits behind `origin/main` (missing CP61/CP62) purely because nobody had pulled after merging —
check this before trusting this file's or `ROADMAP.md`'s "not yet deployed" language at face value.

`LANGSMITH_TRACING` defaults to `true` in `cloudbuild-agent.yaml`, but `tracing.py` fails soft: with
no API key the service runs untraced rather than erroring, and `/health` reports
`langsmith_tracing: false`. So a missing trace is a configuration answer, not a debugging mystery —
check `/health` first.

**[`CHAT-AGENT-PLAN.md`](CHAT-AGENT-PLAN.md) is the source of truth** for the architecture, the
agent roster, the tool catalogue, the question taxonomy and the evaluation strategy — but see the
correction below: it has already been wrong about one load-bearing fact.

Three things that are easy to get wrong on a first read:

- **The plan's primary model does not exist, and the *shape* of that mistake matters more than the
  fact.** `qwen3.5:35b` and `qwen3.5:27b` are not on Ollama Cloud (the only Qwen is the level-4
  `qwen3.5:397b`). The measured replacement is `nemotron-3-nano:30b`. Treat the plan's other
  specific claims — version numbers, model names, API shapes — as hypotheses to verify rather than
  facts, the same discipline the Ergast team-identity notes below demand. Re-run
  `python -m agent.spikes.model_spike` when the catalogue changes.
- **The inference budget is Ollama Cloud's *free* tier, and it is an architectural constraint rather
  than a billing note.** 1 concurrent model, GPU-time metering, level-1/2 models only. Hence one
  workhorse model for every role, a rules-first router, a deterministic verifier core, sequential
  subagent dispatch, an in-process semaphore of 1, and `--max-instances=1` on the new service.
  **The semaphore and the instance cap are one mechanism, not two** — raising `--max-instances`
  gives each instance its own semaphore of 1 while they share one quota, silently disabling the
  gate. Do not "improve" this by assigning a different model per agent either; that design was
  written and then removed for exactly this reason.
- **The verifier is a deterministic LangGraph node, not a subagent** — precisely so the orchestrator
  cannot decide to skip it. It is the CP38/CP41 "don't trust the model to self-police, check it in
  code" lesson promoted from a validator function to an architectural stage.

### The agent's SSE contract lives in code, and errors never use HTTP status

`backend/agent/sse.py` defines the event vocabulary (`activity`, `token`, `sources`, `done`,
`error`) and `backend/tests/test_agent_sse.py` asserts the literal wire bytes, not the helper
return values — CP44's lesson applied to our own output: a documented format is not evidence of the
produced one. Two consequences worth knowing before touching it:

- **Every failure is an SSE `error` event with a code from a closed set, never a 4xx/5xx.** By the
  time anything can fail the response is already committed with 200, so a status code cannot carry
  it. An unknown code degrades to `internal` rather than raising, because raising inside a committed
  stream truncates it with no terminal event at all.
- **`X-Accel-Buffering: no` is load-bearing.** Without it Cloud Run buffers the whole response and
  the client gets one chunk at the end — streaming "works" perfectly on localhost and silently does
  not in production.

The frontend client (`frontend/src/lib/agent-api.ts`) deliberately does **not** use `EventSource`:
it only speaks GET, and it silently reconnects on a drop, which for an agent turn would re-run the
whole thing and double-charge a quota we are already rationing.

**Testing ASGI streaming: a test harness whose `receive()` returns `http.disconnect` will cancel the
stream mid-flight.** Starlette runs a disconnect listener concurrently with the response and tears
it down the moment `receive()` reports a disconnect, so the harness must block instead. This cost
real time in CP59 and presented as the endpoint dropping its terminal events. Relatedly, a fake
model stream that never `await`s hides the whole class of bug — it runs to completion before any
concurrent task is scheduled.

Batch 16 (CP55-58, on-demand track geometry generation) is complete, merged and **verified in
production** — PRs #91-#95 for the checkpoints, #96-#102 for the seven production fixes that
followed.

**Track geometry is live and self-service.** 8 of 22 circuits are built; the rest are curated and
generate on click, which is the designed steady state, not a backlog item. Full post-mortem of the
seven fixes is in `ROADMAP.md`'s Batch 16 retrospective. The three that will cost the most time if
re-derived:

- **The GCS bucket needs a CORS policy, and nothing in the repo reveals that.** Payloads are read
  with `fetch()`; the image assets beside them use `<img>` and are exempt. Without CORS the JSON
  serves fine to `curl` and is blocked in every browser, presenting as "Track geometry
  unavailable" for a payload that is verifiably present and 200-ing. Applied as `origin: ["*"]`,
  GET/HEAD. Check it with
  `gcloud storage buckets describe gs://f1-scratch-assets --format="value(cors_config)"` — an
  empty result means every circuit page is broken.
- **The job and the API must agree on the Mongo document key.** Both write
  `track_geometry_builds` keyed by `{_id: circuit_id}`. Filtering on the `circuit_id` *field*
  instead silently creates a second document per circuit and the two sides stop seeing each other.
- **`cloudbuild-*.yaml` needs `options: logging: CLOUD_LOGGING_ONLY` whenever its trigger sets
  `--service-account`.** To reproduce a trigger failure locally you must pass that same service
  account explicitly; a plain `gcloud builds submit` uses a different default and succeeds,
  proving nothing.

**Verifying the deployed viewer:** the Claude_Browser preview pane cannot composite this route (see
the rAF stall note below) — drive it with headless Chrome over CDP instead. When a circuit misbehaves,
**load a known-good circuit the same way before blaming the change under test**: two of the seven
fixes presented as new-circuit bugs and were actually breaking circuits that had worked for weeks.

**Raw Ergast/Jolpica data is not clean enough to render across full history — read this before
touching `historical_index.py` or reading any Ergast endpoint beyond a single season/circuit
scope again.** Full writeup in `ROADMAP.md`'s Batch 14 retrospective, but the durable facts:
- Ergast's pagination `total` counts *result rows*, not races — a handful of 1950s races carry two
  P1 rows each (shared drives; a driver swapped into a teammate's car mid-race and both were
  classified 1st), so `total` (1163) exceeds the real race count (1160). Always advance pagination
  offset by `limit`, never by `len(page)` — `circuit_history.py`'s `_fetch_all_races` already did
  this correctly; `historical_index.py` mirrors it.
- The `alfa` constructorId is reused across three unrelated teams 70+ years apart (1950-51 works
  team, a separate 1979-85 works team, and the rebadged Sauber 2019-23) — split by era in
  `historical_index.canonical_key`, not just left as one identity.
- Ergast splits one team's chassis/engine combinations into several constructorIds in the early
  decades (Lotus alone as `team_lotus`/`lotus-climax`/`lotus-ford`/`lotus-brm`) — collapsed via
  `historical_index.CONSTRUCTOR_ALIASES`.
- **A name that looks like a chassis-era variant is not proof it's the same team** — `lotus_f1`
  (Ergast's id for the 2012-15 Räikkönen-era team) looks like another Lotus variant but is
  genealogically the Renault-descended constructor, confirmed by checking
  `/constructors/lotus_f1/seasons` directly (`[2012,2013,2014,2015]`, nowhere near classic Lotus's
  1958-94 span) before committing a merge that would have been wrong. Verify any non-obvious
  team-identity claim against the raw per-constructor season list before trusting it, the same
  "don't trust it, verify in code" discipline CP38 established for LLM output.
- The 1950-1960 Indianapolis 500 counted toward the World Championship — four American roadster
  builders (`kurtis_kraft`, `epperly`, `kuzma`, `watson`) appear as race winners despite never
  entering a Grand Prix; keep them but flag `indy500: true` rather than silently colouring them
  like an ordinary GP win.

**Two parallel-checkpoint lessons worth reading before running the next multi-agent batch** (full
writeup in `ROADMAP.md`'s Batch 13 retrospective, reconfirmed by Batch 14):
- When two parallel worktree agents both edit the same file for unrelated reasons (Batch 13: a
  router registration + URL helper; Batch 14: two different `<section>` placeholders in the same
  page component), the second PR to open against `main` after the first merges **will** conflict
  in exactly that file — this is expected, not a sign of a bad parallelization call. Resolve by
  rebasing the second branch onto `main` and keeping both sides' additions; do this directly in
  the agent's own worktree if it still exists, run the test suite + build afterward with **both**
  changes present together (not just each branch individually — a clean text merge doesn't prove
  the two components' logic actually works side by side), then force-push.
- A background agent's "waiting on X" self-report needs the same direct-verification discipline
  every time, in both directions. Batch 13: one agent's first "waiting on npm install" was stale
  (no process alive, install had already finished) — resumed with corrected facts; its very next
  "waiting on the dev-server readiness monitor" was genuinely real. Batch 14 added a new variant of
  this same lesson: both parallel agents hit an account-level API session-limit interruption
  simultaneously, which surfaced as a "failed" task notification for both — that failure summary
  named the real cause (an external session cap, not a code/tool problem), so both were resumed
  via `SendMessage` to continue from their transcript rather than restarted from scratch. Read what
  the failure notification actually says before assuming a full restart is needed.

**When the Claude_Browser preview pane is unusable** (port/lock held by another concurrent
session, or the rAF-stall issue below) **and the change is pure logic with no rendering
behavior**, a standalone `npx tsx some-script.mjs` run from `frontend/` that imports the changed
module directly and exercises it with representative inputs is just as conclusive as a screenshot
— used to verify the Teams-page power-unit fix (`getEngineForTeam`) end-to-end without a browser at
all. Write the script inside `frontend/` (not the OS temp dir) so relative imports resolve, and
delete it before committing.

**The ad-hoc fixes (PRs #72, #73) are worth reading before touching `race_replay.py` again.** Both
were the same shape of bug found via live user testing, not planned work: the timing tower's field
visibly thinned near the end of a race, reading as a wave of retirements when most of the missing
cars had actually finished — first for classified finishers who are a lap down (`race_laps` has no
row for a car once it stops being tracked, and a lapped car stops being tracked *before* the
winner's actual final lap), then for genuine retirees (dropped entirely rather than shown as
retired). `build_replay()` now carries every driver's last row forward to the winner's final lap,
tagging a genuine retirement `retired: true` so the frontend can render it distinctly (dimmed,
sorted last, "RETIRED" instead of a live gap) rather than both cases just vanishing identically.
Full writeup in `ROADMAP.md`'s Batch 12 retrospective.

**Verification gotcha from PR #73, worth remembering for any backend fix:** after restarting both
the backend (`uvicorn`) and the frontend dev server, the browser kept showing the pre-fix data.
The cause was Next.js's Turbopack dev cache under `frontend/.next/dev/cache`, which persists fetch
responses **across dev-server restarts** — clearing `.next/cache/fetch-cache` did nothing;
`rm -rf frontend/.next` (the whole directory, not just that one subfolder) was needed to actually
bust it. If a backend change doesn't seem to show up in the browser after restarting both servers,
suspect this cache before suspecting the fix.

**CP44 extended CP41's finding to a third failure class: output *format*, not just vocabulary.**
`session_recap.py`'s prompt documents race-control citations as `[RC L66]`, but live recaps emit
bare `[RC 5]`, `[RC 18]` — no `L`. Unlike CP41 (fixed with a code-side validator + regenerate),
this one was fixed on the display side: `session-recap-card.tsx`'s lap-extraction regex was made
tolerant of both forms, since the lap number is unambiguous either way. **Before building on top of
any documented prompt-output format, check what a live cached recap actually contains** — the
prompt's example is not proof of what the model reliably produces. See `ROADMAP.md`'s Batch 12
retrospective for the full writeup.

**CP41's finding matters for any future GenAI checkpoint:** a prompt rule that tells the model what
NOT to do can fail even after being restated twice (the qualifying recap kept writing "podium"
despite an explicit ban including an ALL-CAPS block). `SESSION_VALIDATORS` in `session_recap.py`
now checks the assembled qualifying text in code and regenerates once on a violation — the same
"don't trust the model to self-police, verify in code" lesson CP38 established for *facts*, now
shown to also apply to *vocabulary constraints* (and, per CP44 above, to *format*). See
`ROADMAP.md`'s Batch 11 section for the full writeup, including a second lesson: a rule that
forbids a behaviour without saying what to do instead can cause a worse regression (banning
comparative gap language made the model recite every driver's time in turn, blowing the word
limit).

### NEVER run `taskkill /F /IM chrome.exe` — it closes the user's own browser

Done during Batch 15 to clear strays between headless test runs, and it shut the user's real Chrome
session mid-work. `/IM` matches on image name, so it kills every Chrome process on the machine,
not just spawned ones. Kill a test browser by its own PID or via the child process handle
(`child.kill()`), and give it an isolated `--user-data-dir` so it can never touch the real profile.
The same applies to any `/IM`-style sweep — `node.exe`, `python.exe` — on a developer's workstation.

### For WebGL or multi-step interaction, drive headless Chrome over CDP rather than `--screenshot`

Extends the headless-Chrome recipe in "How to verify work in this environment" below. The
one-shot `--screenshot` flag is fine for a static render, but the 3D viewer needed a *sequence*
(click a corner marker, wait, sample the camera mid-flight, drag the elevation profile). The
preview pane cannot do this at all — it never composites frames and starves `requestAnimationFrame`,
so an r3f canvas never renders there; see the rAF-stall note below.

No npm dependencies are needed: Node 22 has a global `WebSocket`, so a plain `.mjs` script can
spawn Chrome with `--remote-debugging-port`, poll `http://127.0.0.1:<port>/json/list` for the page
target, connect to its `webSocketDebuggerUrl`, and drive `Page.navigate`, `Runtime.evaluate`,
`Input.dispatchMouseEvent` and `Page.captureScreenshot` directly. Subscribe to
`Runtime.consoleAPICalled` and `Runtime.exceptionThrown` to assert a clean run.

Four traps, all of which cost real time in Batch 15:
- **`--user-data-dir` must be an absolute path.** Chrome silently refuses to start on a relative
  one and the only symptom is DevTools never coming up. Give it an isolated directory anyway, so
  the test browser can never touch the real profile.
- **WebGL needs `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`**, otherwise
  WebGL2 is unavailable and the viewer renders its no-WebGL fallback instead of the scene.
- **Under swiftshader, `PerformanceMonitor` drops to low-power within seconds**, so terrain, bloom
  and posts vanish from screenshots. That is correct behaviour reading as a regression — check
  whether what's missing is perf-gated before chasing it.
- **Elements below the fold need an explicit `scrollIntoView`** before `Input.dispatchMouseEvent`,
  or the synthetic drag lands outside the viewport and does nothing at all. This produced two
  byte-identical before/after screenshots that looked like a broken feature and were actually a
  broken test.

### OpenF1's current-season paywall has lifted — several docs are stale on this

Verified 2026-07-29: `GET /v1/sessions?year=2026` and `/race_control` both return 200 (80 messages
for the Hungarian GP, including penalties and VSC periods). Multiple places in this repo describe a
hard 401 for the whole current season — accurate when written, no longer true. CP38's recap now
depends on this working. Anything else that was shelved or degraded because of that 401 (notably
the Pitwall Race Control module, CP33) is worth re-testing.

### Verify against a *freshly started* local server, not one you think you restarted

Cost real time this batch: a `uvicorn` from earlier in the session was still holding port 8000, so
every "restart" silently failed to bind and died, and the old process kept serving **stale code**.
The recap under test looked like it had regressed badly when in fact the new code was never
running. `uvicorn`'s bind error goes to the log, not the terminal, so it's invisible unless checked.
Confirm the running process's start time (`Get-CimInstance Win32_Process | Select ProcessId,
CreationDate, CommandLine`) against when you restarted, and check the log for
`error while attempting to bind`. The same applies to `next build`/`next dev` holding
`.next/lock` — and note Git Bash's `ps -p <pid>` cannot see native Windows PIDs, so use
`tasklist //FI "PID eq <pid>"` when waiting on one.

### `MONGODB_URI` from the root `.env` can drive a real local backend against Atlas

Ran `cd backend && MONGODB_URI=$(grep ... .env) python -m uvicorn app.main:app --port 8000` to
verify the circuit-history fix end-to-end — this spins up the actual FastAPI app against the real
production database, not a mock. Combined with pointing the frontend dev server at it
(`NEXT_PUBLIC_API_BASE_URL=http://localhost:8000 npm run dev -- -p <port>`), this is a stronger
verification path than the throwaway-`dev-test-*`-route pattern below for anything that's a pure
backend logic/data fix rather than a UI change — reach for it first when the bug is "the numbers
are wrong," not "the component doesn't render right." One snag: a `next dev` process from another
session can be holding the default port 3113 and/or the `.next/dev/lock` file for this exact
worktree; if so, pick a different `-p` port rather than fighting the lock.

### Stray worktree directories can survive `git worktree remove --force`

Cleaning up after Batch 9 found three `.claude/worktrees/agent-*` directories left over from
sessions before this one — no longer registered in `git worktree list` (git's own bookkeeping was
already clean, likely via an earlier `prune` or force-remove), but the directories themselves were
still on disk. Check `.claude/worktrees/` directly, not just `git worktree list`, when doing
post-batch cleanup; `rm -rf` on a leftover directory with a full `node_modules` tree can take
several minutes and is worth running with `run_in_background`. Relatedly, killing an orphaned
`next dev` process (see the pattern below) is sometimes a precondition for `git worktree remove`
to succeed at all, not just for it to run quickly — it errored outright (`Invalid argument`) with
the process still alive, not just timed out.

### MongoDB Atlas IS reachable from this sandbox — only bare localhost:27017 isn't

Earlier sessions concluded "MongoDB is not reachable here" from a bare TCP probe to
`localhost:27017` (which times out — there's no local `mongod`). That's true, but it led to an
overly broad assumption. The **real** database is MongoDB Atlas (`mongodburi` in the root `.env`,
an `mongodb+srv://...mongodb.net` connection string, cluster `f1-hub`) — the same database
`f1-backend` on Cloud Run reads from — and it **is** network-reachable from this sandbox. Running
`cd backend && python -m app.data_sync` with `MONGODB_URI` exported from that value worked
end-to-end (synced real races/laps/pit-stops) directly from here. `motor`/`pymongo` were missing
from this Python install and needed `pip install -r requirements.txt` first, but that's a one-time
setup cost, not a connectivity block. This means a future session could point the local backend
dev server at the same Atlas URI for **real-data verification** instead of always mocking through
a throwaway `dev-test-*` route — worth trying before defaulting to the mock-data pattern below.

### Backend cache collections need an actual local sync run, not just correct code

`race_laps` sat empty for every round from CP25 (when Lap Telemetry shipped) all the way through
this batch, even though the endpoint code was correct — nobody had run `data_sync.py` locally
since. Every completed race showed a generic "hasn't been processed yet" empty state that looked
like a per-race bug but was actually "the whole collection is empty." If a FastF1-backed Pitwall
module looks broken for every race regardless of which GP, suspect the cache is simply unpopulated
before suspecting the code — check row counts / run `data_sync.py` before debugging logic.

### Frontend `fetch` calls carry their own Next.js data-cache `revalidate`, independent of `force-dynamic`

`export const dynamic = "force-dynamic"` on a page does **not** bypass a `next: { revalidate: N }`
option on that page's own `fetch()` calls (see `getRaceLaps`/`getRaceStints` in
`frontend/src/lib/api.ts` — 3600s and similar). After a manual out-of-band backfill (see above),
the already-cached "empty" response kept serving for up to that window. In normal operation this
is fine — the hourly `f1-data-sync-hourly` Cloud Run Job keeps data fresher than the cache window
ever matters — but if you need a fix to show up on the live site *immediately* after a manual
backfill, you need to force a fresh Cloud Run revision (re-run the existing Cloud Build trigger,
e.g. `gcloud builds triggers run <trigger-name> --branch=main`), not just wait or re-request.

**Locally, this same cache is backed by disk under Turbopack, not just memory, and survives a dev
server restart.** Verifying the race-replay retirement fix (PR #73), restarting both `uvicorn` and
`next dev` still served the pre-fix payload — the fetch response was cached on disk under
`frontend/.next/dev/cache`, and clearing the more obviously-named `.next/cache/fetch-cache` did
nothing. Only `rm -rf frontend/.next` (the whole directory) actually busted it. If a backend fix
doesn't show up in the browser after restarting both servers, suspect this before suspecting the
fix — check `.next/dev/cache` exists, don't just assume a restart cleared it.

### A background agent's "waiting on X" report can be stale — verify against the worktree directly

A CP32 agent twice ended its turn reporting it was waiting on a background build/install, and both
times the task-runner reported it "completed" with no live children — i.e. the agent had lost
track of its own execution state, it hadn't silently failed. Checking its worktree directly
(`git status`, `git log`) showed real, uncommitted work each time. Once it was a genuinely stale
`next dev` process left over from the agent's own earlier verification step (not a build at all).
Don't just re-prompt "continue" on faith — check the worktree and process list yourself
(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '<worktree-path>' }`),
correct the agent's factual understanding of what's actually running, and give it explicit
synchronous steps rather than trusting a self-report of "still waiting."

### Worktree cleanup can hang on orphaned dev servers

A parallel-worktree batch's agents can leave a `next dev` process running in their worktree after
finishing verification, which holds file locks and makes `git worktree remove --force` hang for
minutes rather than fail outright. If a post-batch worktree cleanup seems stuck, check for
orphaned `node.exe` processes whose command line still points at that worktree's path
(PowerShell: `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'worktrees' }`)
and kill them before assuming the removal itself is broken. Sometimes the cleanup finishes on its
own between checks (observed this batch) — check current state with `git worktree list` before
assuming it's actually stuck.

### Duplicated components mean duplicated fixes

`tire-stints-chart.tsx` and `lap-position-chart.tsx` both have their own copy-pasted
compare-drivers dropdown (same markup, same `selectedDrivers`/`toggleDriver` state shape). A
change to that dropdown (e.g. adding Select all / Clear all) has to be applied to both files
identically — there's no shared component yet. Worth extracting if a third copy ever appears.

## Things learned in earlier batches that still apply

- **`gh` CLI is NOT installed** in this environment and no `GH_TOKEN`/`GITHUB_TOKEN` is set, so
  PRs cannot be opened programmatically. Push the branch, then give the user the
  `https://github.com/Nisarg6502/f1-hub/pull/new/<branch>` link and wait for them to merge.
- **Full-viewport overlays must be portaled** — `<main>` in `frontend/src/app/layout.tsx` has
  `relative z-10`, which creates a stacking context, so any descendant's high z-index is still
  compared as `z-10` against the nav's `z-50`. `circuit-details-modal.tsx`, `driver-modal.tsx`,
  and `circuit-compare-modal.tsx` (CP34) all use `createPortal(..., document.body)` — any new
  modal/overlay must too, or it repeats this bug.
- **Driver-image crop math**: the drivers-grid card container is ~2.17:1 (wide/short) but the
  source cutouts are ~0.35:1 (tall/narrow, e.g. 440×1265), so `object-cover` only reveals a
  ~16%-tall horizontal slice. `object-[50%_0%]` puts that slice on the head; don't "fix" head
  cropping by changing the container — change the object-position.
- **OpenF1 paywalled the entire current season for a stretch in 2026 — that has since lifted.**
  It was real (a `GET /v1/sessions?year=2026` 401), and it is why tyre stints were re-sourced to
  FastF1 and why there is no OpenF1-backed fallback for anything else. Re-verified 2026-07-29:
  `/sessions`, `/race_control`, `/stints`, `/laps` and `/pit` all return 200 for 2026, and Pitwall
  Race Control (CP33) populates with real messages for the current season. The 401 handling in
  `frontend/src/lib/openf1.ts` is kept as a defensive fail-soft in case the gate returns.
- **Pre-existing lint failures on `main`** (do not try to "fix" these as part of a checkpoint;
  confirm with a `git stash` compare if unsure): `react/jsx-no-comment-textnodes` in `page.tsx`,
  `drivers-grid.tsx`, `session-tabs.tsx`; `react-hooks/purity` on `Date.now()` in
  `schedule/page.tsx` and `circuits/page.tsx`; several `no-explicit-any` in `openf1.ts`; unused
  vars `leaderColor`, `maxDriverPts`.
- **`frontend/next-env.d.ts` churns by itself** between dev and build runs (`./.next/types/` vs
  `./.next/dev/types/`). Always `git checkout -- frontend/next-env.d.ts` before committing.

## How to verify work in this environment

The pattern that's worked across batches:

1. Write a throwaway route at `frontend/src/app/dev-test-<thing>/page.tsx` that renders the
   component directly with hardcoded mock props (or mocked `fetch`). For components calling
   `useParams()`, make it a dynamic route (`dev-test-x/[season]/[round]/page.tsx`).
2. To exercise an interaction headlessly, either add a `useEffect` that `setTimeout`s a
   `document.querySelector(...)?.click()`, or drive it directly via `javascript_tool` DOM calls
   (`element.click()`, wrapped in an async IIFE with a short `setTimeout` wait) — the latter is
   more reliable than the in-app `computer` click tool against the preview pane, see below.
3. **Warm the route first** — `curl -s -o /dev/null -w "%{http_code}" http://localhost:3113/<route>`
   with a generous `--max-time`. Cold Turbopack compiles take 20s+ and will silently blow past
   Chrome's `--virtual-time-budget`, producing a blank/failed screenshot.
4. Screenshot: `"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new
   --disable-gpu --hide-scrollbars --window-size=W,H --virtual-time-budget=4000
   --screenshot=<path> <url>`
5. **Delete the throwaway route before committing.**

Worth trying first, per the Atlas-reachability note above: point the local backend dev server at
the same `mongodburi` Atlas connection string and verify against **real** data instead of mocks,
where that's practical.

The in-app Claude_Browser preview pane keeps its tab `document.hidden === true` **permanently**
— even after `tabs_select` fronts it — which starves `requestAnimationFrame` entirely. This
doesn't just make `computer {action:"screenshot"}` time out on Framer-Motion UI; it can make an
entire route look **permanently broken** if it has its own `loading.tsx` (the App Router's
streaming reveal is rAF-gated). It also means `computer` clicks on the preview pane can silently
land on the wrong tab if the tab wasn't freshly fronted with `tabs_select` first, or the click can
appear to do nothing even when correctly targeted — `javascript_tool` DOM manipulation
(`element.click()` + `document.querySelector` checks) is more reliable for verifying
interactions in this pane than the `computer` click action. The preview pane's *text* tools
(`get_page_text`, `read_page`, `javascript_tool`) work fine regardless and are great for
asserting DOM state that doesn't depend on the rAF-gated reveal or on screenshot compositing.
Before concluding a route is stuck, check `document.hidden` via `javascript_tool` and whether the
route has a `loading.tsx`; if both are true, verify instead with the headless-Chrome screenshot
method above.

The dev server (`preview_start` name `apex-frontend`, port 3113) also died several times across
sessions; just `preview_start` again.

## Batch 1 conventions (still in force)

- **PR-per-checkpoint**: branch off `main`, implement, test (backend `python -m unittest discover
  tests` from `backend/`, frontend `npm run build` + `npm run lint`), verify in browser, push,
  give the user the PR link, **wait for their merge confirmation before starting the next one.**
- **Backend self-heal pattern**: Mongo-first read → on miss, fetch live from Ergast/Jolpica
  (`https://api.jolpi.ca/ergast/f1`) or FastF1 → upsert back so the next request is cached. Used
  by `session_results.py`, `circuit_info.py`, `championship_standings.py`, `races.py`,
  `driver_bio.py`, `race_laps.py`, `race_stints.py`.
- **`data_sync.py` only syncs the current season by default** (`SYNC_YEARS` overrides) — that's
  *why* the self-heal exists. Don't assume historical seasons are pre-populated, and don't assume
  the current season is either (see the `race_laps` gap above) — check, don't assume.
- **FastF1 cannot be fetched from Cloud Run** — `livetiming.formula1.com` 403s datacenter IPs and
  fails *soft* (empty streams, no error). Anything FastF1-sourced must be synced from a local
  machine (or this sandbox, now that Atlas connectivity is confirmed — see above):
  `cd backend && MONGODB_URI=... python -m app.data_sync`.
- **Assets never go in git**: staged locally, uploaded with `gcloud storage cp` to
  `gs://f1-scratch-assets/<folder>/`, served via `NEXT_PUBLIC_ASSET_BASE_URL`. Resolvers
  (`driver-images.ts`, `circuit-images.ts`, `team-images.ts`) return `null` when unmapped and
  every caller has a graceful fallback — never a broken `<img>`.
- Use `gcloud storage` not `gsutil` (gsutil needs a `python3.11` that isn't on PATH here).

## Reusable pieces added so far

- `frontend/src/components/tooltip.tsx` — hover/focus/tap tooltip on `motion/react`,
  reduced-motion aware, `aria-describedby` wired.
- `_attach_winners()` in `backend/app/races.py` — bulk-joins winners onto the season's races in
  one query. Reuse rather than N+1-ing `/api/race_results`.
- The liquid-glass dropdown/popover pattern (`bg-[rgba(26,22,19,0.98)] border border-white/10`,
  motion-animated, click-outside + Escape) now appears in `tire-stints-chart.tsx`,
  `lap-position-chart.tsx`, `compare-drivers-panel.tsx`, `global-search.tsx` (CP32), and
  `circuit-dna-compare.tsx` (CP34) — reuse it rather than a native `<select>`.
- `frontend/src/components/track3d/` — the WebGL stack (three + @react-three/fiber + drei +
  postprocessing), behind a `next/dynamic({ssr:false})` boundary in `track-viewer-mount.tsx` so no
  other route pays for it. `three` is pinned exactly; r3f and drei track specific revisions.
  `build-ribbon.ts` is the one place ENU becomes world space. Two rules learned the hard way in
  CP54: **use `occlude={[ref]}` (raycast), never `occlude="blending"`, on drei `<Html>`** — the
  blending path renders an opaque black backing plane and clips the label (full explanation in
  `ROADMAP.md`'s Batch 15 retrospective); and React's compiler lint treats anything produced during
  render as frozen, so per-frame mutable scratch must live in a `useRef` (or a JSX material mutated
  through a ref, as `atmosphere.tsx` already does), not in a `useMemo`.

## Stale docs warning

`DESIGN-CONTEXT.md` at the repo root describes a **"KINETIC VELOCITY" cyan/magenta** theme. That
is obsolete — the app was reskinned to the warm-orange "APEX" glassmorphism system in an earlier
session (see `f1hub-apex-design-system.md` in auto-memory). Its §10 UX backlog is still partly
useful, but ignore all of its colour/branding claims. It also lists the nav search input and
footer links as dead controls — the search input shipped in CP32; the footer is still genuinely
dead.
