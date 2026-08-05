# APEX Roadmap

## Vision

APEX is a Formula 1 season hub — the next stretch of work grows it from "when's the next race, who's winning" into deeper race analysis (comparisons, strategy, replay) and a few tightly-grounded GenAI features, per the research report from 2026-07-27. Everything ships read-only, free-tier-sourced, and Mongo-cached; no feature gets added by compromising those constraints.

## How this works

Checkpoints (`CP<n>`) number flatly and continuously across the project's life — they never restart per batch. One branch (`feat/<kebab-case>` or `fix/<kebab-case>`) and one PR per checkpoint; branch off `main`, implement, test (`python -m unittest discover tests` from `backend/`; `npm run build && npm run lint` from `frontend/`), verify in the browser, push, wait for the user's merge confirmation before starting the next checkpoint. Batches are small — 2 to 4 checkpoints — and get built, verified, and deployed before the next batch is planned; nothing here commits to building everything at once. `FEATURES.md` is the source of truth for what's actually shipped (its "Known gaps" section is not restated here). `HANDOFF.md` is the source of truth for session-level working memory and gotchas (also not restated here) — this file only tracks the durable plan: vision, batch history, current batch, and backlog.

**Parallelization check, done at batch-planning time:** before starting a batch, check each checkpoint's expected file footprint. Checkpoints that touch disjoint files with no sequential dependency (e.g. Batch 3's weather tile / nav label / telemetry fix) can be built by parallel subagents, each in its own git worktree, with PRs opened and merged independently. Checkpoints that share files or have a real dependency (e.g. two features both touching the Pitwall page) stay sequential — parallel agents on shared files risk merge conflicts and duplicated helpers instead of saving time.

**Skill usage for UI/UX work:** any checkpoint touching visual design, layout, or animation must invoke the `emil-design-eng` skill (animation/interaction polish philosophy — easing, timing, transform-origin, press feedback) before implementing, and `apple-design` when the work involves gesture-driven or physically-feeling interactions. `pick-ui-library` should be invoked before adding any new UI dependency; `review-animations`/`improve-animations`/`find-animation-opportunities` are for auditing existing motion rather than building new UI. `dataviz` is relevant to any checkpoint that is itself a data visualisation (charts, colour-by-category encodings, axes/legends) — first used in Batch 14 for the 75-Season Barcode and Constructor Genealogy, both genuinely new territory for this project (every earlier chart-like UI in this app, e.g. the lap-position chart, was built before this skill was in scope for this file). These project-relevant skills exist alongside a broader `ui-ux-pro-max:*` skill family and others available in this environment generally — this paragraph only tracks the ones this project's checkpoints have actually used; it is not an exhaustive list of every skill available in a given session. The app already depends on `motion/react` (Framer Motion) as its animation library — use it directly rather than introducing a second one. A custom liquid-glass dropdown/popover (`bg-[rgba(26,22,19,0.98)] border border-white/10`, motion-animated open/close, click-outside + Escape handling) already exists in `tire-stints-chart.tsx` and `compare-drivers-panel.tsx` — reuse that pattern instead of a native `<select>`, which does not carry the app's theme.

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
| 13 | CP45-46 | GenAI: Pitwall "Strategy Commentary" module (undercut/overcut narrative, PR #75), driver comparison head-to-head narrative on the Drivers compare modal (PR #76) — built as two parallel worktree agents | merged |
| 13 (ad hoc) | unnumbered | Fixed the Teams page's Power units panel showing wrong 2026 supplier data: Alpine mapped to Renault (switched to Mercedes for 2026 — the lookup is now season-aware since the constructor name didn't change), Sauber mapped to Audi (it ran Ferrari its whole modern history; Audi's works supply only starts once the constructor is renamed "Audi" for 2026), and two new 2026 entrants (Audi, Cadillac) were missing entirely. Found via user inspection, not backlog-planned. PR #77 | merged |
| 14 | CP47-49 | F1 Heritage: historical race index + constructor identity foundation (PR #79), "The 75-Season Barcode" — every championship race 1950-2026 as one colour-coded stripe, plus a Home-page teaser (PR #80), Constructor Genealogy — 15 curated team lineages as a horizontal band timeline (PR #81). New top-level `/history` page, 8th nav item. CP48/CP49 built as two parallel worktree agents | merged |
| 16 | CP55-58 | On-demand track geometry: 18 new `CircuitSpec` entries (PR #93), Cloud Run Job with GCS output + Mongo progress/quota (PR #91), trigger/status/available endpoints behind a global build lock (PR #92), and the public "Generate 3D view" button + phased loader (PR #95). CP55-57 built as three parallel worktree agents. Seven follow-ups from live production debugging: metadata token path (#96), Mongo `$set`/`$setOnInsert` conflict (#97), `_id` vs `circuit_id` document split (#98), job auto-deploy trigger (#99) and its missing Cloud Build logging option (#100), completion not revealing the viewer (#101), bucket CORS (#102) | merged |
| 15 | CP50-54 | 3D Elevation Track: offline geometry/elevation pipeline baking four circuits to static JSON (PR #83, #88), WebGL viewer on a new `/circuits/[circuitId]` route (PR #84, #87), named corner markers + keyboard orbit (PR #85), Constructor Genealogy filtered to the current grid with labelled eras and hover (PR #86), and a polish pass on the viewer's tour, scrub and corner labels from user testing (PR #89). First 3D/WebGL work in the project | merged |

The original plan's CP15-19 (driver/team head-to-head compare, championship calculator, lap-by-lap chart, calendar links, global search) were superseded by the ad-hoc work above and never built under those numbers. They're carried forward into the Backlog below rather than left as gaps — checkpoint numbering resumes cleanly at CP20.

## Current batch

**Batch 17 — Agentic chat assistant, foundation (CP59-62). Complete, merged and verified in
production** (re-verified live 2026-08-05 — see `HANDOFF.md`; a prior session's docs were stale
about deployment status because the deploying sandbox had no authenticated `gcloud` and nobody
re-synced local `main` with `origin/main` afterward).

**Batch 18 — CP63 (router tiering + subagents) is merged and deployed** (PR #110), re-verified live
— see `HANDOFF.md` for the full measured result. Short version: built as planned, then a live
measurement showed tier 2 (comparative/causal/strategy/history) performing dramatically worse under
the multi-agent design than CP61's flat baseline (287s+ unconverged vs. 50.9s), so `router.py`'s tier
2 was downgraded to route like tier 1 — only tier 3 (web research, a genuine net-new capability)
actually uses subagents. This is the plan's own "if it does not measurably beat the baseline, we say
so and keep the baseline" clause, exercised for real rather than left as a hypothetical. **CP64 (the
verifier) is next.**

Full architecture in **[`CHAT-AGENT-PLAN.md`](CHAT-AGENT-PLAN.md)** — that document is the source of
truth for this batch and for Batch 18; this section only carries the summary and the checkpoint
list.

A conversational surface ("Pitwall Assistant") that answers open-ended F1 questions by orchestrating
tools over this app's own cached data, reaching the live web only when the answer genuinely is not
in our database. Built on **deepagents** (LangGraph underneath), traced with **LangSmith**, and
gated in CI by **deepeval**.

**It is not a chatbot with a system prompt, and the distinction is the whole design.** Tools return
pre-computed fact bundles rather than raw documents, every tool call appends to an **evidence
ledger**, and a **deterministic verifier node** — not a subagent, so the orchestrator cannot skip it
— checks every claim against that ledger with one repair attempt before the answer streams. That
shape is forced by this project's own post-mortems: CP38 (a teammate relationship invented from
correct data), CP41 (a prompt ban violated even in ALL CAPS, fixed only by a code validator) and
CP44 (the model not emitting its own documented format).

**The budget shapes the architecture.** Inference is Ollama Cloud's **free tier**: 1 concurrent
model, GPU-time metering, level-1/2 models only. So one workhorse model runs every role, and the
agents are separated by prompt, tools and context window rather than by weights. To cut model calls
per answer from ~6 to ~2, the router is rules-first with an LLM fallback only for ambiguous input,
and the verifier's core is string/set operations with LLM entailment reserved for tier-3 answers.
Both became cheaper *and* more deterministic.

**The workhorse is `nemotron-3-nano:30b`, not the `qwen3.5:35b` the plan named — that model does not
exist.** The CP59 spike probed Ollama Cloud's catalogue live and found neither `qwen3.5:35b` nor
`qwen3.5:27b`; the only Qwen offered is the level-4 `qwen3.5:397b`, which the plan's own budget logic
excludes. Full scores in [`backend/agent/spikes/README.md`](backend/agent/spikes/README.md).

| CP | Scope | Done when | Status |
|---|---|---|---|
| CP59 | `f1-agent` Cloud Run service skeleton: Dockerfile, cloudbuild, `/api/chat` SSE, LangSmith tracing, model seam; **tool-calling reliability spike** across 4 candidate models; checkpointer spike | An SSE echo streams from the *deployed* service to the *deployed* frontend and a trace appears in LangSmith | **merged and deployed** (PR #105), re-verified live 2026-08-05 |
| CP60 | Internal tool layer (~16 tools over Mongo), evidence ledger, `resolve_context` — pure Python, unit-tested, no LLM | Every tool has a unit test; `resolve_context` handles "last race" / "next race" / nicknames / ambiguity | **merged** (PR #106) |
| CP61 | **Single-agent baseline**: deep agent + internal tools, no subagents, no verifier; minimal dev-flagged chat UI | Answers taxonomy classes 1-7 end to end, with latency, quota burn and cost recorded as the baseline Batch 18 must beat | **merged and deployed** (PR #108), re-verified live 2026-08-05 — see the fresh grounding finding in `HANDOFF.md` |
| CP62 | Web research: Tavily search/extract, untrusted-content quarantine, prompt-injection tests | Classes 8-9 answered with sources; injection suite passes | **merged and deployed** (PR #107) |

**Deployment-first ordering is deliberate**, straight out of Batch 16's retrospective: CP59 proves
SSE through a real deployed service *before* any agent complexity exists, because that batch's cost
was entirely in the gap between individually-correct systems.

### What CP59 measured

**The risk the plan called its riskiest is retired: a ~30b model *can* drive nested `task()`
dispatch.** Two of four candidates did it repeatably, so Batch 18's CP63 subagent layer is **not**
cancelled. CP61 still ships the single-agent baseline first, so the multi-agent version has a
measured number to beat rather than an assumption to defend.

Three findings worth not re-deriving:

- **The one-shot ranking was the wrong ranking.** `gemma4:31b` scored 6/6 on single-turn tool
  calling — argument correctness, selection from a 16-tool catalogue, restraint on out-of-domain
  questions, all perfect and fastest. It then **failed the multi-hop dispatch loop 2 runs in 3**,
  re-dispatching to a subagent it had already heard back from. A one-shot test cannot see this, and
  an intermittent delegation loop burns quota exactly as fast as a reliable one. `nemotron-3-nano:30b`
  (6/6 and 3/3) is the workhorse; `gpt-oss:120b` (also 3/3, already proven by CP38's recaps) is the
  fallback. **If a future session adds a test to the battery, add it to the multi-turn class** —
  that is where the models actually differ.
- **`AsyncMongoDBSaver` was merged, not moved.** The plan expected the async Mongo checkpointer's
  import path to have shifted in LangGraph 1.0. It is gone entirely: `MongoDBSaver` now carries both
  sync and async methods, and `from_conn_string` is a **sync** context manager holding async methods
  (`async with` fails on a bare `__aenter__` AttributeError that reads like a missing dependency).
  Round-tripped against real Atlas — CP61 gets real thread memory and the hand-rolled fallback stays
  unbuilt.
- **`langgraph-checkpoint-mongodb` 0.4.0 caps `pymongo<4.17`**, and nothing surfaces that until the
  resolver runs and fails naming only the pin. `requirements-agent.txt` holds `~=4.16.0` for this
  reason.

**Still outstanding on CP59, and it is the part that matters:** the checkpoint is only done when SSE
streams from the **deployed** service to the **deployed** frontend and a trace appears in LangSmith.
Locally-verified is explicitly not the bar here — that is the whole lesson Batch 16 paid for. The
Cloud Run service, its four secrets and the build trigger still need creating.

### What CP61 measured

**The single-agent baseline works, but not evenly — and the gap is exactly the one the plan
predicted a verifier would need to close.** `agent/graph.py` binds all eighteen CP60 tools to one
`create_deep_agent` graph, no subagents; `agent/main.py`'s `_answer` now runs it in place of CP59's
bare chat completion, reusing the SSE transport, the run gate and the error vocabulary unchanged.
Full numbers, five real Ollama Cloud calls, in
[`backend/agent/spikes/README.md`](backend/agent/spikes/README.md), §5.

- Point lookup, deep history and out-of-domain restraint all worked correctly in one tool call (or
  zero) and 12-15s.
- A comparative question answered correctly but reached for `get_standings` instead of the
  purpose-built `get_head_to_head`, and silently dropped two failed tool calls rather than retrying
  with corrected arguments.
- **An aggregate/count question got a wrong, ungrounded answer** — zero tool calls, a fabricated
  "3 podiums" from parametric memory. This is CP38's failure mode again, through a different door,
  and it is the concrete argument for CP64's verifier: CP61 shipped without one by design, and this
  is what that costs, measured rather than assumed.
- A real defect, fixed in this checkpoint: deepagents' default filesystem middleware (`ls`, `grep`,
  `glob`, etc.) is always present regardless of whether the system prompt mentions it, and the model
  initially spent three wasted tool calls probing it before answering a data question. The system
  prompt now tells it plainly it has no files.

**Batch 18 (CP63-66), planned but not committed:** router tiering + four subagents, the verifier and
citation contract, the deepeval golden set and CI gate, then the production UI and hardening.

## Batch 16 retrospective — On-demand track geometry (CP55-58)

**Batch 16 (CP55-58) is complete, merged and verified in production.** All four checkpoints landed
(PRs #91, #92, #93, #95), CP55-57 as three parallel worktree agents. 8 of 22 circuits are built and
rendering; the other 14 are curated and one click away, which is the intended steady state rather
than an unfinished edge.

**The plan was right; the deployment was where all the cost was.** Every checkpoint passed its own
tests and review, and the feature still did not work end to end — seven follow-up PRs (#96-#102)
came out of driving the real button on the real site. None were design mistakes. Every one was a
production-only fault that no unit test could have caught, because each lived in the gap between
two systems that were individually correct:

- **#96 — the metadata token path.** `instance/service_account/default/token` instead of
  `instance/service-accounts/default/token`. A swallowed `except Exception: pass` hid the real
  error for a full debugging cycle; replacing it with real logging found the cause in minutes.
  **Never let a credentials path fail silently.**
- **#97 — `$set` and `$setOnInsert` targeting `started_at` together.** Real MongoDB rejects one
  path touched by two operators; the fake collection in tests did not, so the tests passed against
  a database that does not exist. The fake now enforces the conflict rule.
- **#98 — the document split.** The job upserted on `{_id: key}` while the API queried
  `{circuit_id: key}`, so each circuit got *two* documents: one stuck at "queued" that the
  frontend read, one progressing correctly that nothing read. Invisible until #97 was fixed,
  because before that the job's writes failed anyway and masked it.
- **#99/#100 — no auto-deploy trigger for the job, then a trigger that could not run.** Adding
  `--service-account` to a Cloud Build trigger makes `options: logging: CLOUD_LOGGING_ONLY`
  mandatory; `cloudbuild-trackgeo.yaml` was the one config missing it. Reproducing it locally
  required passing the trigger's *exact* service account — a plain submit uses a different default
  and succeeds, proving nothing.
- **#101 — a finished build that hid itself.** Two caches consulted at the one instant the UI acts
  on `done`: Next's `revalidate: 30` served stale-while-revalidate to the completion `router.refresh()`,
  and the backend's own 60 s GCS listing could still omit a circuit it had just reported done. The
  page bounced back to the Generate button for a build that had fully succeeded.
- **#102 — the bucket had no CORS policy at all.** The images beside it load via `<img>` and are
  exempt; the payload is read with `fetch()` and is not. It served perfectly to `curl` and was
  blocked in every browser, and it silently broke the four *previously working* bundled circuits
  the moment CP58 started preferring the bucket URL over the same-origin copy.

**The lesson worth carrying forward: "all checkpoints merged" is not "the feature works."** The
only thing that found any of these was clicking the real button on the deployed site and following
the failure into Cloud Logging, Mongo and GCS. Two of the seven (#98, #102) presented as
*new-circuit* problems and were actually breaking circuits that had worked for weeks — both were
only correctly diagnosed by testing a known-good circuit alongside the new one, which is now the
default move before blaming the change under test.

**Every fix carries a regression test proven by reverting it** — write the test, revert the fix,
watch it fail with the real error shape, restore. #97 and #98 were both cases where the test
initially passed *without* the fix, which is exactly the check that catches a test asserting the
wrong thing.

**Original plan, kept for context.** Batch 16 extended Batch 15's viewer from the four hand-baked
circuits to the whole calendar, with the expensive elevation build triggered by a **public-facing
button** rather than run offline by a maintainer.

**The constraint that shapes everything: a build needs a `CircuitSpec` that already exists.** The
pipeline cannot bake an arbitrary circuit from an id alone. Each spec in `scripts/trackgeo/
curated.py` carries researched data — which upstream GeoJSON feature is the right one (the
`br-1940`/`br-1977` trap from Batch 15), which DEM dataset, rotation direction, and any curated
banking, corner names and highlight windows. Only `sf_lat`/`sf_lon` is derived automatically, from
the TUMFTM alignment. So "a user generates a circuit" means **triggering the elevation build for a
circuit already curated**; the curation itself stays a repo change. CP55 therefore has to land
before the button is useful for anything.

**Two scope decisions, taken deliberately rather than defaulted:**
- **The service is built even though pre-baking is cheaper.** All 18 remaining circuits could be
  baked offline for roughly 415 OpenTopoData calls (~23 each) and about 720 KB of static JSON, with
  no new infrastructure at all. The on-demand service was chosen anyway, for the interaction itself
  and so a changed calendar needs no redeploy. Recorded here because the cheaper option is real and
  a future reader should not have to re-derive it. Circuits stay unbuilt until someone clicks.
- **Curation is deep for marquee circuits only.** Full treatment (corner names, highlight windows,
  banking) for **Monaco, Austria, Japan, Great Britain, Italy, Hungary**; geometry + elevation only
  for the other twelve. A circuit without curated extras still renders correctly — it simply has no
  corner markers or highlight cards, which is much better than a confidently mislabelled corner.

**The 18 pending circuits:** Abu Dhabi, Australia, Austria, Baku, Canada, China, Great Britain,
Hungary, Italy, Japan, Las Vegas, Madrid, Mexico, Miami, Monaco, Qatar, Singapore, Spain. Already
built: Spa (Belgium), Interlagos (Brazil), Zandvoort (Netherlands), Austin (USA).

**Frozen contract — agreed before any checkpoint starts, so all four can be built against it:**
- Output: `gs://f1-scratch-assets/tracks/<key>.json`, served through the existing
  `NEXT_PUBLIC_ASSET_BASE_URL`. This replaces `frontend/public/tracks/`, which is baked into the
  frontend image at build time and so can never show a payload written at runtime.
- Mongo `track_geometry_builds`:
  `{circuit_id, status: queued|running|done|failed, phase, progress_pct, message, started_at, updated_at, error}`
- `POST /api/track_geometry/build {circuit_id}` → `202` with the status doc, or **`409` naming the
  circuit already building**. One build at a time, globally; a second click is told to wait rather
  than queued.
- `GET /api/track_geometry/status?circuit_id=` → the status doc.
- `GET /api/track_geometry/available` → ids that already have a payload, so the frontend stops
  needing a hardcoded list.

| CP | Scope | File footprint |
|---|---|---|
| CP55 | `CircuitSpec` entries for the 18 pending circuits — full curation for the six marquee tracks, geometry + elevation for the rest. Verify each `bacinger_id` against the upstream index rather than guessing it | `scripts/trackgeo/curated.py` only |
| CP56 | Cloud Run Job: containerise the pipeline, write output to GCS, report phase/progress to Mongo as it runs, and **move the daily quota counter from `.cache/trackgeo/quota.json` into Mongo** — a job's local disk is ephemeral, so a per-run counter would let every run believe it has a fresh 900 calls and quietly blow the real limit | `scripts/trackgeo/cache.py`, new `scripts/trackgeo/storage.py`, `scripts/build_track_geometry.py`, new `Dockerfile.trackgeo`, new `cloudbuild-trackgeo.yaml` |
| CP57 | Trigger + status endpoints, the single-build lock behind the 409, and the IAM to let the backend's service account invoke a Cloud Run Job | new `backend/app/track_geometry.py`, `backend/app/main.py` (one-line router registration) |
| CP58 | "Generate 3D view" button, phased loader driven by the status doc, and replacing the static `GEOMETRY_BY_CIRCUIT_ID` map with runtime availability | `frontend/src/lib/circuit-geometry.ts`, `frontend/src/components/circuit-details-modal.tsx`, `frontend/src/app/circuits/[circuitId]/`, new loader component |

**Parallelization check (per the rule at the top of this file): CP55, CP56 and CP57 have genuinely
disjoint footprints and should run as three parallel worktree agents.** CP55 touches only
`curated.py`; CP56 touches `cache.py`/`storage.py`/the Dockerfiles; CP57 is a new backend module.
CP58 can run as a fourth agent against the frozen contract above and be integrated last, since its
only real dependency is the endpoint shape, not the endpoint's existence. The single shared file is
`main.py`'s one-line router registration — the same low-risk additive overlap Batches 13 and 14
both absorbed, and the second PR to open after the first merges should be expected to conflict
there and nowhere else.

**Why this is free on GCP.** Cloud Run Jobs' free tier (180k vCPU-seconds, 360k GiB-seconds per
month) dwarfs a few minutes of occasional building, and 22 payloads under 1 MB total sit well
inside the 5 GB Cloud Storage free tier. The existing `f1-data-sync` job and `f1-scratch-assets`
bucket already prove both paths in this project.

**Sequencing note.** CP55 must merge before the button does anything useful, and CP56's GCS output
path must exist before CP58's viewer stops reading `public/tracks/`. Bake at least one marquee
circuit through the deployed job before CP58 ships, so the frontend is verified against a real
runtime-written payload rather than a file copied by hand.

## Batch 15 retrospective — 3D Elevation Track (CP50-54)

**Batch 15 (CP50-54) is complete and merged.** It was not scoped from the Backlog below — it came
from a direct user request for a 3D elevation view of circuits, and is the first WebGL work in the
project. CP53 (Constructor Genealogy polish) rode along in the same batch as a user-driven
follow-up to Batch 14's CP49 rather than a theme fit.

**The pipeline is offline and the payload is static, deliberately.** *(Superseded by Batch 16 —
the pipeline now also runs as an on-demand Cloud Run Job writing to GCS. It is still never run
inside the API process, and the reasoning below is why.)* `scripts/trackgeo/` bakes each
circuit to a JSON file in `frontend/public/tracks/` and never runs in the API. Elevation comes from
OpenTopoData, which is a courtesy-rate public service — putting it behind a request path would have
been both slow and rude. The frontend fetches the payload client-side rather than having the server
component read it from disk, so the browser and CDN cache it instead of inlining 26-63 KB into the
RSC stream on every navigation.

**Three data lessons from CP50 worth not re-deriving:**
- **Interlagos is `br-1940`, not `br-1977`.** The latter is Jacarepaguá, at sea level. A DEM
  returning 3-11 m ASL for a track that sits at 765 m is what caught it.
- **`confidence` grades data quality, not agreement with a published number.** Austin reads 30.9 m
  against a published 41 m, and that is not a defect: `ned10m` is bare-earth lidar, while the 30 m
  DSM products report 36-37 m because they include the Turn 1 grandstands. Agreement with a
  published scalar is reported separately as `published_ratio`.
- **There is no pit-lane geometry in the source**, and no pit-lane defect either — all 40 features
  are clean closed rings.

**Curated corner names are snapped to detected apexes, not indexed against them.** Raw curvature
peaks and F1's official numbering disagree structurally: Spa detects 30 apexes against 19 numbered
corners, because official numbering merges multi-apex complexes (Eau Rouge/Raidillon is one number,
not three) and ignores gentle kinks. Names are curated by approximate arc length and snapped to the
nearest real apex at build time with a 130 m tolerance, so a bad guess fails loudly at build rather
than quietly labelling a straight.

**CP54 was a polish pass driven entirely by the user actually using the viewer**, and every item in
it was invisible to the checkpoint that shipped it. The most instructive one: corner labels drew
stray opaque black quads and were clipped by terrain, both caused by a single prop. drei's
`<Html occlude="blending">` renders a real backing `planeGeometry` whose shader writes
`vec4(0,0,0,0)` *without* setting `transparent: true` — so the alpha is discarded and it draws as a
solid black plane — and it sizes that plane by `1/viewport.factor` while the label itself is scaled
by `distanceFactor`, so the two disagree and clip the label. Raycast occlusion (`occlude={[ref]}`)
renders no plane at all and resolves visibility per label. **Prefer raycast occlusion for `<Html>`
in this project.** The other CP54 findings: a translucent glass control over a dark bloom-lit 3D
scene is effectively invisible (the flythrough button now gets the only filled treatment in the
viewer); a camera move that cuts straight to its destination reads as broken even when the
destination is right, so corner and highlight runs now ease on over ~1.15 s and ramp from a
standstill; and page copy promised "scrub the profile to move the camera" while nothing was wired
up, which is the kind of gap only a real user hits.

**Performance gating has to distinguish cost from affordance.** `PerformanceMonitor`'s low-power
mode originally dropped corner labels along with terrain, bloom and posts — but the labels are ten
DOM nodes and the only route into a corner flythrough, so weak machines lost the feature entirely
while saving nothing. Gate the expensive layers, never the only way in.

**Verification could not use the usual browser preview.** The Claude_Browser preview pane does not
composite frames for this route, so screenshots time out and an r3f canvas never renders — see
HANDOFF.md. CP54 was verified instead by driving headless Chrome over the DevTools Protocol with a
software GL stack (`--use-angle=swiftshader --enable-unsafe-swiftshader`), scripted with Node 22's
built-in `WebSocket` and no added dependencies. That harness clicked corner markers, ran the lap
tour, dragged the elevation profile and captured staged screenshots across Spa and Zandvoort. It is
the right pattern for any future WebGL checkpoint here.

## Batch 14 retrospective — F1 Heritage: 75-Season Barcode + Constructor Genealogy (CP47-49)

**Batch 14 (CP47-49) is complete and merged** (PRs #79, #80, #81). It came from two user-proposed
ideas rather than the backlog — a data-dense "poster piece" and a genuinely novel visualisation
neither existed anywhere in this app: a barcode of every championship race since 1950 colour-coded
by winning constructor, and a horizontal band timeline of team lineages (Tyrrell→Mercedes,
Jordan→Aston Martin, Sauber→Audi, Minardi→RB, …). Both landed on a new top-level `/history` page,
8th item in the desktop nav.

**Raw Ergast/Jolpica data is not clean enough to render directly, and this batch is the first time
this repo has hit that.** Every earlier checkpoint that reads Ergast (`circuit_history.py`,
`races.py`, `session_results.py`) reads it scoped to one circuit or one season, where the data is
already well-formed. Reading the *entire* 75-year history surfaced five real defects that a
single-season read never would: (1) three 1950s races carry two P1 result rows each because a
driver swapped into a teammate's car mid-race and both were classified 1st (Ergast's own `total`
count is 1163 result rows for 1160 actual races — pagination has to advance by `limit`, not by
`len(page)`, exactly the lesson `circuit_history.py` already encoded but easy to get wrong again
at this scale); (2) the `alfa` constructorId is reused across three unrelated teams 70+ years
apart (the 1950-51 works team, a separate 1979-85 works team, and the rebadged Sauber 2019-23);
(3) Ergast splits one team's chassis/engine combinations into several constructorIds in the early
decades (Lotus alone as `team_lotus`/`lotus-climax`/`lotus-ford`/`lotus-brm`); (4) the 1950-1960
Indianapolis 500 counted toward the World Championship, so four American roadster builders who
never entered a Grand Prix appear as race winners; (5) the active season is partial and needs
deliberate handling rather than just stopping mid-year. All five are fixed once, server-side, in
`backend/app/historical_index.py` — CP48 and CP49 (and anything built on this data later) consume
already-normalised `constructor_key`s and never re-solve any of this.

**A sixth defect, not in the original plan, was caught only by checking live data during CP47
before committing:** the initial normalisation merged `lotus_f1` (Ergast's id for the 2012-15
Räikkönen-era team, chosen because the name looks like a Lotus chassis-era variant) into the same
canonical key as classic 1958-94 Team Lotus. Checking `/constructors/lotus_f1/seasons` directly
showed `[2012, 2013, 2014, 2015]` — that team is genealogically the **Renault**-descended
constructor, briefly renamed, completely unrelated to Colin Chapman's team decades earlier. Fixed
before the first commit, with a regression test (`test_lotus_f1_team_is_not_folded_into_classic_lotus`)
and a code comment flagging the trap for CP49's curated lineages, which reference the same id.
**The general lesson: a plausible-looking id/name match is not proof of genealogical continuity —
verify every non-obvious team-identity claim against the raw per-constructor season list before
trusting it**, the same discipline CP38's "don't trust the model, verify in code" applies just as
much to hand-curated historical facts as to LLM output.

**CP47 store-once-then-top-up strategy, chosen deliberately over both a build-time static file and
a lazy 24h-staleness cache** (all three were presented to the user as options): 1950-2025 is
immutable and will never change again, so `historical_race_index` is backfilled once (measured:
1160 races, ~10s against the real Atlas database) and topped up on every subsequent `data_sync.py`
run by re-fetching only the current season's per-season endpoint (`/2026/results/1/`, cheap — one
call) rather than the full 75-year endpoint. The static-file option was rejected because the
current season would freeze at build time; the lazy-cache option was rejected only because a
brand-new race could be up to a day late, a real (if small) cost the store-once approach avoids
entirely. Verified idempotent: re-running the sync against an already-populated collection produces
0 duplicate `(season, round)` pairs.

**CP48 and CP49 built as two parallel worktree agents off CP47**, per this file's
parallelization-check rule — the same low-risk shared-file overlap pattern as Batch 13 (both add
an import line and replace a different placeholder `<div>` inside `history/page.tsx`). The second
PR to open after the first merged conflicted in exactly that one file and nowhere else, resolved by
rebasing the second branch onto `main` in its own worktree, keeping both sides (merged import list,
kept both `try` blocks), then re-running `npm run build`/`npm run lint` with **both** features
present together before force-pushing — not just re-running each branch's own build in isolation,
which would not have caught a real conflict between the two components' logic even if the text
merge itself were clean.

**Both background agents hit a mid-task API session-limit interruption simultaneously** (unrelated
to their own work — an account-level session cap, not an error in either agent), which surfaced as
a "failed" task notification for both. Both resumed cleanly via `SendMessage` to the same agent ID
with a note explaining the interruption was external and instructing them to continue exactly
where their transcript left off; both picked back up and finished normally. Worth remembering this
failure mode is possible and is not, by itself, evidence anything went wrong with the agent's actual
work — check whether the failure summary names a real code/tool problem before assuming a restart
from scratch is needed.

**CP48's data-accuracy note, found during its own visual verification:** the original brief assumed
the 2009 Brawn season would render as "exactly one stripe." Real data shows Brawn won 8 of that
season's 17 races (interspersed with Red Bull, Ferrari and McLaren wins), so it correctly renders
as several grey stripes clustered only within 2009, never appearing in any other season — the
agent kept this data-accurate rather than forcing the literal one-stripe framing from the brief,
which would have misrepresented the season. The "one season, one team, a handful of races" story
still reads clearly in the rendered barcode; only the exact stripe count differed from the
brief's assumption.

**CP49 scoped down from the brief's suggested ~40 hand-curated edges to ~23**, deliberately: 8 of
the 15 final lineages (Ferrari, McLaren, Williams, Brabham, classic Lotus, Cooper, BRM, Vanwall)
are intentionally one-node lineages for visual contrast against the ones that kept renaming, and
the agent declined to invent additional multi-rename lineages it couldn't fully verify against
Ergast's own per-constructor season data rather than pad the count — consistent with this batch's
central lesson about not trusting plausible-looking but unverified genealogical claims.

## Batch 13 retrospective — GenAI: strategy commentary + driver comparison narrative (CP45-46)

**Batch 13 (CP45-46) is complete and merged** (PRs #75, #76), plus one ad-hoc fix found by direct
user inspection (PR #77, see below). It was scoped from the GenAI backlog, picking the two items
that could reuse `session_recap.py`'s already-proven grounding/streaming/caching pattern most
directly rather than needing new infrastructure (a query bar or RAG chat would have).

**Built as two parallel worktree agents**, per this file's parallelization-check rule: CP45
(`backend/app/strategy_commentary.py` + a new Pitwall module) and CP46
(`backend/app/driver_comparison_recap.py` + an addition to the Drivers compare modal) touch
disjoint feature files, with the only overlap being one-line additive appends to
`backend/app/main.py` (router registration) and `frontend/src/lib/api.ts` (URL helper) — the same
class of low-risk shared-file overlap Batches 6-9 already tolerated. Both agents pushed branches
independently; the second PR opened against `main` after the first had already merged genuinely
conflicted in exactly those two shared files (nothing else), resolved with a straightforward
rebase keeping both sides' additions — worth expecting this exact conflict shape (not a surprise,
not a sign anything went wrong) whenever two parallel checkpoints both add a router/URL-helper.

**Both checkpoints reuse `session_recap.py`'s central lesson rather than reinventing it**: every
relational or comparative fact a recap narrates must be computed in Python, never left for the
model to derive.
- CP45's strategy commentary determines undercut/overcut outcomes by comparing track position
  from `race_laps` just before and a few laps after a pit-stop pair's window, and flags "strategy
  outliers" (a stop count that differs from the field's most common one) by comparing counts
  across the field — both are exactly the kind of cross-driver comparison a model would otherwise
  get subtly wrong. It reuses `race_replay.py`'s `driver_id`↔`driver_number` resolution rather than
  re-deriving that join a third time (`race_replay.py` was the first to solve it, for `pit_stops`
  vs `race_laps`/`race_stints`).
- CP46's driver-comparison narrative ports `compare-drivers-panel.tsx`'s existing client-side
  head-to-head logic (`buildHeadToHead`) into Python verbatim, so the narrative's counts are
  guaranteed to agree with what the modal displays next to it — not just independently accurate,
  but *consistent* with the number the user is already looking at.

**A genuinely new caching problem, distinct from anything CP38-44 hit**: `session_recap.py` and
CP45's strategy commentary both cache forever because a finished race's facts never change. CP46's
inputs (season standings, per-round results) change every time either driver races again, so
"cache forever" would go stale mid-season. The fix folds `rounds_compared` into the Mongo cache
key instead of a TTL: a new shared race result changes that number, which naturally produces a
fresh cache row without a manual purge or a clock-based expiry to manage — a third pattern
alongside `session_recap`'s "cache forever" and `circuit_history_cache`'s "cache with a staleness
timestamp".

**Two background-agent "waiting" self-reports this batch, both checked directly rather than taken
on faith** (the same discipline Batches 6/8/9 already established) — with two different outcomes,
worth recording because they show the check matters both ways:
- CP46's agent first reported "waiting on a background npm install" after a genuinely long
  research/implementation stretch. Checking the worktree directly found real uncommitted work, a
  completed install (`node_modules/.package-lock.json` present, `next --version` ran fine), and no
  npm/node process alive anywhere pointed at that worktree path — the report was stale, same
  lost-track-of-own-state failure mode as Batch 8's CP32 agent. Resumed with the corrected facts
  and it proceeded immediately.
- The same agent later reported "waiting on the frontend dev-server readiness monitor." This time
  the check found a real `next dev` process alive and already answering `curl` with 200 — a
  genuine wait, not a stale one. Resumed with confirmation it was actually ready rather than
  assuming the first stale report meant every report from this agent would be stale.

**Ad-hoc fix (PR #77):** the user directly inspected the Teams page's power-unit tiles and caught
three factual errors at once — Alpine shown as Renault-powered (switched to Mercedes for the 2026
rules reset; the constructor name didn't change, so the existing flat `teamName → engine` map
couldn't represent the mid-history switch, and `getEngineForTeam` had to become season-aware),
Sauber shown as Audi-powered (it ran Ferrari for its entire modern history — the Audi works supply
only begins once the constructor is renamed "Audi" for 2026, a fact easy to get backwards if you
assume the Audi *ownership* announcement and the Audi *engine* supply started at the same time),
and two new 2026 entrants (Audi's own works team, Cadillac as a Ferrari customer) missing from the
map entirely. Verified with a standalone `tsx` script exercising `getEngineForTeam` directly for
every team/year combination, rather than through a browser — the shared dev-server port and
Turbopack lock were both held by another concurrent session at the time, and this being pure data-
mapping logic with no rendering behavior made a direct function-call check just as conclusive as a
screenshot would have been.

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
- Natural-language query bar (a GenAI layer alongside the now-functional keyword nav search) —
  superseded by Batch 17's chat assistant, which subsumes it: a query bar is the same routing and
  grounding problem with a smaller surface, so it is being built as the chat rather than separately
- Race strategy commentary on the Pitwall page (grounded in stint data) — shipped in Batch 13 (CP45)
- Driver comparison narrative (pairs with the head-to-head feature) — shipped in Batch 13 (CP46)
- "Ask about this circuit" scoped chat (RAG over cached circuit history + Wikipedia extract) —
  carried into `CHAT-AGENT-PLAN.md` as a stretch checkpoint (CP67+), where Atlas Vector Search makes
  it additive to the chat rather than a second system: Atlas is already the database, so the RAG
  index adds no new infrastructure
- Pre-race prediction with transparent reasoning (framed as commentary, not a promise) — covered by
  Batch 17/18 as taxonomy class 10, with the "commentary, not a promise" framing enforced by the
  verifier rather than by prompt wording

### Replay & media
- Race replay / session playback shipped in Batch 12 (CP42-44) — a lap-indexed timing tower, not
  cars on track (no GPS/coordinate data exists in this app). Track-position animation would need a
  new coordinate data source before it could be built, not just more UI work on top of this.
- Strategy "what-if" pit-stop replay (drag a stop to a different lap, estimate position impact)

### Other
- Personal "watch party" second-screen mode
- Constructor budget cap tracker (manually updated, no live feed exists)
- Fantasy / prediction game (bigger scope — needs auth + persistence; v2 milestone)
- **AI guardrails — explicitly requested by the user for the batch after Batch 18 (2026-08-05).**
  Not yet scoped in detail; raise this at Batch 18's close rather than letting it get lost. Likely
  overlaps CP64's verifier/framing-contract work (predictive/subjective framing, citation
  enforcement) and CP62's injection quarantine, but the user asked for it as its own explicit item,
  not assumed to be already covered by those.
