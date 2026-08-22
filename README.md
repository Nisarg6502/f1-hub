# APEX

A Formula 1 season hub: the calendar, the championships, every driver and
constructor, circuit history back to 1950, a lap-accurate race replay, a 3D
track viewer, and a grounded chat assistant that answers questions about all of
it and cites where each answer came from.

**Live:** https://f1-frontend-1076575666662.asia-south1.run.app

> The GitHub repository and the GCP project are both named `f1-hub`, which was
> the project's original name. The product has been **APEX** since the July 2026
> redesign; if you see "F1 Hub" anywhere outside an infrastructure identifier,
> it is stale.

---

## What's in it

Thirteen navigable routes. The two most interesting things are the last two rows.

| Route | What it is |
| --- | --- |
| `/` | Countdown to the next session, championship leader, last winner, next circuit. During a race weekend, the top three of the most recently classified session. |
| `/schedule` | The season calendar, split into upcoming and completed. |
| `/schedule/[season]/[round]` | One round: every session's classification (FP1–FP3, sprint qualifying, sprint, qualifying, race), weather, circuit detail, and an AI session recap. |
| `/schedule/[season]/[round]/pitwall` | Tyre stints, pit stops, and AI strategy commentary grounded in the stint data. |
| `/standings` | Drivers' and constructors' championships, with the title fight and teammate head-to-heads. |
| `/drivers` | The grid, each driver's season, and a career bio. |
| `/teams` | Every constructor: where it is based, what its lineage has won, and the chain of teams it grew out of — most of the grid is a renamed, resold version of something much older. |
| `/circuits`, `/circuits/[circuitId]` | Circuit gallery and detail, including a **3D WebGL track viewer** built from real geometry. |
| `/telemetry` | Labelled **Live** in the navigation, and currently the weakest page in the app: it detects correctly whether a session is running and counts down to the next one, but it has **never rendered a row of timing data in production** — the paid feed it was built against was never provisioned. See *Known gaps*. |
| `/history` | Every championship race since 1950, as a season-by-season colour barcode, plus a constructor genealogy chart. |
| `/watch`, `/watch/[raceId]` | **Race replay** — a lap-indexed timing tower that plays a finished race back at real pace, with a phone-as-second-screen pairing mode (scan a QR code to drive the replay from another device). |
| *(panel, not a route)* | **The Pitwall Assistant** — a retrieval-grounded chat agent over this app's own data, with a verifier that checks claims before they are shown. |

Two routes exist but are deliberately **not** linked from the navigation:
`/pitwall-chat` and `/agent-check`. Both are debugging surfaces for the agent
and are kept on purpose — each `page.tsx` carries a docblock explaining why.
They are not features.

---

## Architecture

Six deployed units on Google Cloud Platform, plus two managed stores. Every unit
has its own Dockerfile and its own Cloud Build config, one-to-one.

| Unit | Kind | Source | Build config |
| --- | --- | --- | --- |
| `f1-frontend` | Cloud Run service | `frontend/` | `cloudbuild-frontend.yaml` / `Dockerfile.frontend` |
| `f1-backend` | Cloud Run service | `backend/app/` | `cloudbuild-backend.yaml` / `Dockerfile.backend` |
| `f1-agent` | Cloud Run service (port 8100) | `backend/agent/` | `cloudbuild-agent.yaml` / `Dockerfile.agent` |
| `f1-data-sync` | Cloud Run **Job**, hourly via Cloud Scheduler | `backend/app/data_sync.py` | `cloudbuild-sync.yaml` / `Dockerfile.sync` |
| `f1-track-geometry` | Cloud Run **Job**, triggered on demand | `scripts/build_track_geometry.py` | `cloudbuild-trackgeo.yaml` / `Dockerfile.trackgeo` |
| MongoDB Atlas | managed | database `f1_scratch` | — |
| Google Cloud Storage | managed | bucket `f1-scratch-assets` | — |

The agent is a **separate service from the API on purpose**: its dependency tree
(LangChain, LangGraph, deepagents) would roughly double the API image for code
the API never runs. See the header of `backend/requirements-agent.txt`.

GCS is not only a CDN. It serves driver images, team logos, car renders and
flags, and it is also the **write target** of the track-geometry job, which
publishes built 3D payloads to `gs://f1-scratch-assets/tracks/<key>.json`.

### Where the data comes from

| Source | Used for |
| --- | --- |
| **Jolpica** (`api.jolpi.ca`) | Schedule, standings, race/qualifying/sprint results. This is the maintained mirror of the Ergast API — **Ergast itself is retired**, and nothing here calls it. |
| **FastF1** | Practice and sprint-qualifying classification, tyre stints, circuit details, lap data. |
| **OpenF1** | Lap times, positions, intervals, tyre stints and race-control messages — what the race replay and the Pitwall are built on. |
| **RapidAPI** (`f1-live-pulse`) | Intended feed for `/telemetry`. Not subscribed — see *Known gaps*. |
| **Tavily** | The chat agent's web search tool. |
| **Ollama Cloud** | The LLM behind session recaps, strategy commentary, driver-comparison narratives, and the agent. |

Everything session-scoped is cached into MongoDB by the sync job, so the app
serves its own database rather than an upstream on every request.

---

## Tech stack

**Frontend** — Next.js 16.1.6 (App Router) · React 19.2.3 · TypeScript ·
Tailwind CSS v4 · Framer Motion (`motion`) for animation · Three.js with
`@react-three/fiber` / `drei` / `postprocessing` for the 3D track viewer ·
Recharts · `react-markdown` + `remark-gfm` · `qrcode` · `lucide-react`.

**Backend API** — FastAPI · Motor (async MongoDB) · PyMongo · FastF1 · pandas ·
httpx. Eighteen routers, all mounted in `backend/app/main.py`.

**Agent service** — deepagents on LangGraph · LangChain · `langchain-ollama` ·
`langchain-tavily` · `langgraph-checkpoint-mongodb` for thread memory ·
LangSmith for tracing. Versions are pinned with `~=` deliberately; the file
explains why.

**Infrastructure** — Cloud Run (services and jobs) · Cloud Build · Cloud
Scheduler · Cloud Storage · Secret Manager · Google Container Registry · Docker.

---

## Repository layout

```
.
├── backend/
│   ├── app/                     # FastAPI API — 18 routers, plus data_sync.py
│   ├── agent/                   # The chat agent service (separate deployable)
│   │   ├── guardrails/          #   injection / PII / scope checks
│   │   └── tools/               #   the agent's grounded data tools
│   ├── tests/                   # 42 test files
│   ├── requirements.txt         # API dependencies
│   └── requirements-agent.txt   # agent dependencies (deliberately separate)
├── frontend/
│   ├── src/app/                 # App Router routes
│   ├── src/components/          # UI, incl. track3d/ for the WebGL viewer
│   ├── src/lib/                 # API client, data shaping, design tokens
│   └── public/
├── scripts/                     # Track-geometry pipeline, golden-set curation
├── docs/superpowers/            # Design specs and implementation plans
├── Dockerfile.{frontend,backend,agent,sync,trackgeo}
└── cloudbuild-{frontend,backend,agent,sync,trackgeo}.yaml
```

---

## Local development

**Prerequisites:** Node.js 20+, Python 3.11+, Docker (only for building images),
`gcloud` CLI (only for deploying).

```bash
git clone https://github.com/Nisarg6502/f1-hub.git
cd f1-hub
```

### 1. Backend API

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

`backend/.env`:

```env
MONGODB_URI=your_mongodb_connection_string

# Enables the AI session recaps, the Pitwall strategy commentary, and the
# driver-comparison narrative. Without it those three cards simply don't
# render — no error.
OLLAMA_API_KEY=your_ollama_cloud_api_key
OLLAMA_MODEL=gpt-oss:120b
```

Interactive API docs are at `http://localhost:8000/docs`, and `/health` is a
liveness probe.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

`frontend/.env.local` — **all five matter**; the last three are the difference
between a working app and one where the Live page and the assistant are dead:

```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
NEXT_PUBLIC_ASSET_BASE_URL=https://storage.googleapis.com/f1-scratch-assets
NEXT_PUBLIC_AGENT_BASE_URL=http://localhost:8100
NEXT_PUBLIC_RAPIDAPI_KEY=your_rapidapi_key
NEXT_PUBLIC_RAPIDAPI_HOST=f1-live-pulse.p.rapidapi.com
```

The app runs at `http://localhost:3000`. Pointing `NEXT_PUBLIC_API_BASE_URL` at
the deployed backend is a legitimate shortcut if you only want to work on the
frontend.

### 3. Agent service

The Pitwall Assistant is a **separate process** and will not start with the API.

```bash
cd backend
pip install -r requirements-agent.txt
python -m uvicorn agent.main:app --port 8100 --reload
```

It reads `MONGODB_URI`, `OLLAMA_API_KEY` and `AGENT_MODEL`, plus
`TAVILY_API_KEY` for web search and `LANGSMITH_API_KEY` / `LANGSMITH_TRACING` /
`LANGSMITH_PROJECT` for tracing. `AGENT_SESSION_SECRET` is not optional in any
deployment reachable from the internet — without it the rate limiter cannot
bind a session and silently stops limiting.

### 4. Data sync

```bash
cd backend
MONGODB_URI="mongodb+srv://..." python -m app.data_sync
```

Use `python -m app.data_sync`, not `python app/data_sync.py` — the module uses
package-relative imports and running it as a script raises `ImportError`.
`SYNC_YEARS="2025,2026"` scopes it; `FORCE_RESYNC=1` refetches sessions that
are already stored.

Running it locally is also the documented remedy when a round is missing data:
FastF1's upstream intermittently refuses Google Cloud Run IP ranges and fails
*soft* (empty streams, no error), so a scheduled run cannot be relied on for
any specific round.

### 5. Tests

```bash
cd backend && python -m unittest discover tests
cd frontend && npm run build && npm run lint
```

---

## Deployment

Cloud Build triggers fire on pushes to `main`; each config can also be run by
hand. A full deploy takes roughly 6–10 minutes.

```bash
gcloud builds submit --config cloudbuild-frontend.yaml .
gcloud builds submit --config cloudbuild-backend.yaml .
gcloud builds submit --config cloudbuild-agent.yaml .
gcloud builds submit --config cloudbuild-trackgeo.yaml .
```

Three things that have each caused a real incident:

**`cloudbuild-sync.yaml` has no deploy step.** It builds and pushes the image
and stops there. A Cloud Run Job pins its image at *job-update* time, so
`gcloud builds submit` alone leaves the hourly job running the old code. Follow
it with:

```bash
gcloud builds submit --config cloudbuild-sync.yaml .
gcloud run jobs update f1-data-sync --region asia-south1 \
  --image gcr.io/f1-dashboard-493015/f1-data-sync:latest
```

**The frontend bakes its config in at build time.** Every `NEXT_PUBLIC_*` value
is a Docker build arg, so changing one means rebuilding, not restarting. The
RapidAPI key is deliberately not committed — pass it per build:

```bash
gcloud builds submit --config cloudbuild-frontend.yaml . \
  --substitutions=_NEXT_PUBLIC_RAPIDAPI_KEY=<key>
```

**`cloudbuild-backend.yaml` deploys the image but sets no environment
variables.** Anything new has to be added to the Cloud Run service separately,
or the feature silently no-ops in production. Credentials go in Secret Manager,
never as a plaintext env var:

```bash
printf "%s" "$YOUR_KEY" | gcloud secrets create OLLAMA_API_KEY \
  --data-file=- --replication-policy=automatic
gcloud secrets add-iam-policy-binding OLLAMA_API_KEY \
  --member="serviceAccount:<project-number>-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
gcloud run services update f1-backend --region asia-south1 \
  --update-secrets "OLLAMA_API_KEY=OLLAMA_API_KEY:latest"
```

Non-secret config such as `OLLAMA_MODEL` can stay a plain `--update-env-vars`.

One more, worth knowing before you write a new page: **Next.js data pages must
set `export const dynamic = "force-dynamic"`.** Cloud Run scales to zero, and a
cold container serves the *build-time* prerender — which freezes a countdown at
a race that has already happened. `revalidate` does not fix it.

---

## Where the rest of the documentation lives

| File | What it holds |
| --- | --- |
| `FEATURES.md` | The inventory of what has actually shipped, and its known gaps. |
| `ROADMAP.md` | Vision, batch-by-batch history, and the unscheduled backlog. |
| `HANDOFF.md` | Session-level working memory: the gotchas, incidents and dead ends, at length. |
| `CHAT-AGENT-PLAN.md` | The design of the Pitwall Assistant. |
| `BATCH-*-PLAN.md` | Per-batch plans and their resumption state. |
| `docs/superpowers/` | Design specs and implementation plans. |
| `scripts/README.md` | The track-geometry build pipeline. |

`DESIGN-CONTEXT.md` is **stale** — it describes an obsolete cyan/magenta theme
that the July 2026 APEX redesign replaced. Do not build against it.

---

## Analytics

APEX runs **Google Analytics 4**, added 2026-08-22. It is loaded consent-first:
Consent Mode v2 defaults to denied for everyone before `gtag.js` is requested,
visitors outside the EEA/UK are granted on mount, and EU/UK visitors get a
banner and stay denied until they answer. Region comes from the browser's IANA
timezone, because a bare `run.app` URL has no geo headers to read.

Eight named events sit alongside page views, each chosen to answer a question
this README could not: whether `/telemetry` is ever clicked, whether the
second-screen pairing is ever used, whether the mobile navigation's six-item cap
is a real problem, and where the traffic comes from. **Nothing a user types is
ever sent** — the chat event is a count, the search event carries the result
kind rather than the query.

`_NEXT_PUBLIC_GA_MEASUREMENT_ID` is a Cloud Build substitution and is inlined at
build time, so **creating or changing the property requires a frontend rebuild**.
Left empty, the analytics components render nothing and the CSP keeps its
narrower pre-analytics form. `frontend/src/app/(info)/privacy/page.tsx` is the
user-facing statement of what is collected; the design and the verification
record are in `docs/superpowers/specs/2026-08-22-google-analytics-design.md`.

---

## Known gaps

Recorded here rather than left to be discovered:

- **`/telemetry` does not work, and never has.** It calls a paid RapidAPI feed
  directly from the browser, and `_NEXT_PUBLIC_RAPIDAPI_KEY` defaults to `''`
  so builds do not fail. Because Next inlines `NEXT_PUBLIC_*` at build time,
  the deployed bundle contains the *dead-code-eliminated* stub — the fetch is
  not in the shipped JavaScript at all, so setting the variable at runtime
  would change nothing. Roughly three-quarters of the page is empty
  background, and its idle message ("polling is paused") implies a feed that
  resumes; it does not. The route is also excluded from the mobile navigation.
- **Session windows are guessed, not sourced.** `frontend/src/lib/sessions.ts`
  assumes fixed durations, and some are wrong — a sprint is given 30 minutes
  against a real 60 — so a live session can be treated as over halfway
  through. Red-flagged sessions overrun the assumption entirely.
- **FastF1's upstream intermittently refuses Cloud Run IP ranges** and fails
  soft, returning empty streams rather than an error. Practice and
  sprint-qualifying classification can therefore be missing for a given round
  until the sync is run from a local machine.
- **`backend/app/strategy_whatif.py` is experimental and fails its own
  accuracy gate.** It is not routed and is not a feature.
- **No Ferrari, Red Bull or Racing Bulls logos** — no freely-licensed source
  exists. Those cards fall back to a coloured monogram.

`FEATURES.md` carries the full list; this is the short version.

---

## Status

A personal project, built and deployed for real rather than as a demo, and
still under active development. It is not affiliated with, endorsed by, or
connected to Formula 1, the FIA, or any team. Team logos and car renders belong
to their respective owners and are used for editorial illustration only;
individual attributions appear in the UI where required.

No licence has been chosen yet, so default copyright applies — all rights
reserved.
