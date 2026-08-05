# F1 Hub — Handoff (2026-08-05)

## Where things stand

Batches 1 through 9 are fully merged (see `ROADMAP.md`'s "Shipped batches" table for the full
history, including ad-hoc additions built mid-batch). A durable roadmap-tracking system exists at
`ROADMAP.md` — **current batch and checkpoint status live there** (see "Current batch"), not in
this file. This file only carries session-specific working memory: recent gotchas, environment
quirks, and the immediate next action.

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

**Not yet done — deploy is CP63's actual done-criterion, same lesson as CP59/61 before it**: pushed
to `feat/agent-subagent-router`, PR opened, **not merged** (this checkpoint follows the normal
wait-for-merge-confirmation convention, unlike the CP59-62 docs-only PR earlier this session which
the user explicitly authorized merging outright). Once merged, re-run the same live check this
session already used twice today: `/health`, a real `/api/chat` SSE call, and this time also confirm
the `done` event's `tier` field is actually populated (a documented-but-unused field since CP59,
first wired to a real value by this checkpoint).

### Batch 18 status after CP63

CP64 (the verifier) is next once CP63 merges and deploys. It is the highest-value remaining
checkpoint given the "who won the last race" grounding finding earlier in this file — it is the
architectural fix, not another prompt rewrite (CP41 already showed restating a rule doesn't work).

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
