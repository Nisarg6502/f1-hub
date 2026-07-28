# F1 Hub — Handoff (2026-07-28)

## Where things stand

Batches 1 through 9 are fully merged (see `ROADMAP.md`'s "Shipped batches" table for the full
history, including ad-hoc additions built mid-batch). A durable roadmap-tracking system exists at
`ROADMAP.md` — **current batch and checkpoint status live there** (see "Current batch"), not in
this file. This file only carries session-specific working memory: recent gotchas, environment
quirks, and the immediate next action.

### Immediate next action

Batch 9 (CP35-37) is complete and merged, plus an ad-hoc fix for the Circuit history panel showing
wrong "first raced" years (see `ROADMAP.md`'s Current batch section for the root cause — it's a bug
shape worth knowing about before building anything else that aggregates "across all X"). Batch 10
is not yet planned — see `ROADMAP.md`'s Backlog section for candidates when starting the next
batch-planning pass.

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
- **OpenF1 now paywalls the entire current season**, not just the live window: verified live that
  `GET /v1/sessions?year=2026` returns 401. There is no FastF1 equivalent for race-control
  messages (unlike tyre stints, which were re-sourced to FastF1) — Pitwall Race Control (CP33)
  will show its empty state for the current season until a round ages into OpenF1's free
  historical window.
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

## Stale docs warning

`DESIGN-CONTEXT.md` at the repo root describes a **"KINETIC VELOCITY" cyan/magenta** theme. That
is obsolete — the app was reskinned to the warm-orange "APEX" glassmorphism system in an earlier
session (see `f1hub-apex-design-system.md` in auto-memory). Its §10 UX backlog is still partly
useful, but ignore all of its colour/branding claims. It also lists the nav search input and
footer links as dead controls — the search input shipped in CP32; the footer is still genuinely
dead.
