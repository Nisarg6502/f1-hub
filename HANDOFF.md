# F1 Hub — Handoff (2026-07-28)

## Where things stand

Batches 1 through 7 are fully merged (see `ROADMAP.md`'s "Shipped batches" table for the full
history, including two ad-hoc Batch 2 additions built mid-batch). A durable roadmap-tracking
system exists at `ROADMAP.md` — **current batch and checkpoint status live there** (see "Current
batch"), not in this file. This file only carries session-specific working memory: recent
gotchas, environment quirks, and the immediate next action.

### Immediate next action

Batch 7 (CP29-31) is complete and merged. Batch 8 is not yet planned — see `ROADMAP.md`'s Backlog
section for candidates when starting the next batch-planning pass.

### Worktree cleanup can hang on orphaned dev servers

A parallel-worktree batch's agents can leave a `next dev` process running in their worktree after
finishing verification, which holds file locks and makes `git worktree remove --force` hang for
minutes rather than fail outright. If a post-batch worktree cleanup seems stuck, check for
orphaned `node.exe` processes whose command line still points at that worktree's path
(PowerShell: `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'worktrees' }`)
and kill them before assuming the removal itself is broken.

### Resuming a paused agent doesn't kill its background jobs

When a background agent pauses mid-task (e.g. "waiting for npm install to finish") and gets
resumed with a follow-up message, the resume does **not** kill whatever background job it was
actually waiting on — if the agent then starts a *new* attempt at the same operation (e.g. another
`npm install`) without realizing one is already running, the two collide and corrupt shared state
(this happened to a CP29 agent: two `rm -rf node_modules && npm install` runs raced on the same
directory across several resumes, deleting/rewriting the same files concurrently and leaving a
broken install each time). If an agent reports the same "still waiting" status across several
resumes, check for a duplicate/stray process for that worktree path before just prompting it to
continue again — killing the stray and, if needed, running the operation yourself directly in the
agent's worktree path (then telling the agent it's already done and not to repeat it) is more
reliable than resuming indefinitely.

## Things learned this batch that will bite you again

- **`gh` CLI is NOT installed** in this environment and no `GH_TOKEN`/`GITHUB_TOKEN` is set, so
  PRs cannot be opened programmatically. Push the branch, then give the user the
  `https://github.com/Nisarg6502/f1-hub/pull/new/<branch>` link and wait for them to merge.
- **Two modals were rendering under the navbar** — root cause is that `<main>` in
  `frontend/src/app/layout.tsx` has `relative z-10`, which creates a stacking context, so any
  descendant's `z-[80]`/`z-[90]` is still compared as `z-10` against the nav's `z-50`. Both
  `circuit-details-modal.tsx` and `driver-modal.tsx` are now fixed with `createPortal(...,
  document.body)`. **Any new full-viewport overlay must be portaled too** or it will repeat this.
- **Driver-image crop math**: the drivers-grid card container is ~2.17:1 (wide/short) but the
  source cutouts are ~0.35:1 (tall/narrow, e.g. 440×1265), so `object-cover` only reveals a
  ~16%-tall horizontal slice. `object-[50%_0%]` puts that slice on the head; the old
  `object-[50%_10%]` cut into the forehead/chin. Don't "fix" head cropping by changing the
  container — change the object-position.
- **OpenF1 now paywalls the entire current season**, not just the live window: verified live that
  `GET /v1/sessions?year=2026` itself returns 401. Their docs say historical (2023+) is free and
  "real-time requires a paid subscription", but in practice the whole 2026 season reads as
  real-time. That's why checkpoint 14 re-sources tyre stints from **FastF1** (`session.laps` has
  `Stint`/`Compound`/`TyreLife`/`LapNumber`) via the existing Mongo-first self-heal pattern,
  rather than just prettifying the error state.
- **Pre-existing lint failures on `main`** (do not try to "fix" these as part of a checkpoint;
  confirm with a `git stash` compare if unsure): `react/jsx-no-comment-textnodes` in `page.tsx`,
  `drivers-grid.tsx`, `session-tabs.tsx`; `react-hooks/purity` on `Date.now()` in
  `schedule/page.tsx` and `circuits/page.tsx`; several `no-explicit-any` in `openf1.ts` and
  `tire-stints-chart.tsx`; unused vars `leaderColor`, `maxDriverPts`.
- **`frontend/next-env.d.ts` churns by itself** between dev and build runs (`./.next/types/` vs
  `./.next/dev/types/`). Always `git checkout -- frontend/next-env.d.ts` before committing.

## How to verify work in this environment

**MongoDB is not reachable here** (`localhost:27017` refused), so no page that hits the backend
will render real data. The **public asset bucket IS reachable**
(`https://storage.googleapis.com/f1-scratch-assets/...`), so real driver/circuit images work.

The pattern that worked all batch, use it again:

1. Write a throwaway route at `frontend/src/app/dev-test-<thing>/page.tsx` that renders the
   component directly with hardcoded mock props. For components calling `useParams()`, make it a
   dynamic route (`dev-test-x/[season]/[round]/page.tsx`).
2. To exercise an interaction headlessly, add a `useEffect` that `setTimeout`s a
   `document.querySelector('[aria-label="..."]')?.click()`.
3. **Warm the route first** — `curl -s -o /dev/null -w "%{http_code}" http://localhost:3113/<route>`
   with a generous `--max-time`. Cold Turbopack compiles take 20s+ and will silently blow past
   Chrome's `--virtual-time-budget`, producing a blank/failed screenshot.
4. Screenshot: `"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new
   --disable-gpu --hide-scrollbars --window-size=W,H --virtual-time-budget=4000
   --screenshot=<path> <url>`
5. **Delete the throwaway route before committing.**

The in-app Claude_Browser preview pane keeps its tab `document.hidden === true` **permanently**
— even after `tabs_select` fronts it — which starves `requestAnimationFrame` entirely (a bare
rAF call never fires, confirmed with a 3s timeout probe). This doesn't just make `computer
{action:"screenshot"}` time out on Framer-Motion UI; it can make an entire route look
**permanently broken**. Any route with its own `loading.tsx` gets an automatic Suspense
boundary, and React's App Router reveal (the `$RC`/`$RV`/`window.$RB` streaming swap that
replaces the fallback with the real content) is gated on rAF with no fallback unless a
slow-connection marker is present — so in this preview pane that swap queues up and then never
fires, and the page sits on the `loading.tsx` skeleton forever even though the server's HTML
already contains the fully-resolved content. (Root-caused for `/standings`, the only route with
a `loading.tsx` as of 2026-07-28 — see `f1hub-preview-pane-raf-stall.md` in auto-memory.) Before
concluding a route is stuck when tested in this pane, check `document.hidden` via
`javascript_tool` and whether the route has a `loading.tsx`; if both are true, don't trust the
pane for that route — verify instead with the headless-Chrome screenshot method above
(a real, non-backgrounded process), which is authoritative. The preview pane's *text* tools
(`get_page_text`, `javascript_tool`) still work fine and are great for asserting DOM
state/tooltip copy that doesn't depend on the rAF-gated reveal.
The dev server (`preview_start` name `apex-frontend`, port 3113) also died several times mid-
session; just `preview_start` again.

## Batch 1 conventions (still in force)

- **PR-per-checkpoint**: branch off `main`, implement, test (backend `python -m unittest discover
  tests` from `backend/`, frontend `npm run build` + `npm run lint`), verify in browser, push,
  give the user the PR link, **wait for their merge confirmation before starting the next one.**
- **Backend self-heal pattern**: Mongo-first read → on miss, fetch live from Ergast/Jolpica
  (`https://api.jolpi.ca/ergast/f1`) or FastF1 → upsert back so the next request is cached. Used
  by `session_results.py`, `circuit_info.py`, `championship_standings.py`, `races.py`,
  `driver_bio.py`. Checkpoint 14 should follow it exactly.
- **`data_sync.py` only syncs the current season by default** (`SYNC_YEARS` overrides) — that's
  *why* the self-heal exists. Don't assume historical seasons are pre-populated.
- **FastF1 cannot be fetched from Cloud Run** — `livetiming.formula1.com` 403s datacenter IPs and
  fails *soft* (empty streams, no error). Anything FastF1-sourced must be synced from the local
  machine: `cd backend && MONGODB_URI=... python -m app.data_sync`. Relevant to checkpoint 14.
- **Assets never go in git**: staged locally, uploaded with `gcloud storage cp` to
  `gs://f1-scratch-assets/<folder>/`, served via `NEXT_PUBLIC_ASSET_BASE_URL`. Resolvers
  (`driver-images.ts`, `circuit-images.ts`, `team-images.ts`) return `null` when unmapped and
  every caller has a graceful fallback — never a broken `<img>`.
- Use `gcloud storage` not `gsutil` (gsutil needs a `python3.11` that isn't on PATH here).

## Reusable pieces added this batch

- `frontend/src/components/tooltip.tsx` — hover/focus/tap tooltip on `motion/react`,
  reduced-motion aware, `aria-describedby` wired. There was no tooltip primitive before; reuse
  this rather than adding another one (checkpoints 15–17 will likely want it).
- `_attach_winners()` in `backend/app/races.py` — bulk-joins winners onto the season's races in
  one query. Reuse rather than N+1-ing `/api/race_results`.

## Stale docs warning

`DESIGN-CONTEXT.md` at the repo root describes a **"KINETIC VELOCITY" cyan/magenta** theme. That
is obsolete — the app was reskinned to the warm-orange "APEX" glassmorphism system in an earlier
session (see `f1hub-apex-design-system.md` in auto-memory). Its §10 UX backlog is still partly
useful, but ignore all of its colour/branding claims. It also lists the nav search input and
footer links as dead controls — the search input is checkpoint 19.
