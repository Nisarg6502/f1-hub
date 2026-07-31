# Track geometry build (CP50, CP56)

Bakes the 3D circuit geometry the Elevation Track viewer loads. Runs in two
places, and never at request time in the API:

- **locally**, writing `frontend/public/tracks/<key>.json` — the CP50 workflow,
  unchanged;
- **as the `f1-track-geometry` Cloud Run Job**, writing
  `gs://f1-scratch-assets/tracks/<key>.json` and reporting progress to Mongo —
  see [Running as a Cloud Run Job](#running-as-a-cloud-run-job).

```bash
pip install -r scripts/requirements.txt
python scripts/build_track_geometry.py --terrain --report
```

Useful flags:

| flag | what it does |
|---|---|
| `--report` | full validation table per circuit — the thing to actually read |
| `--dry-run` | print the API-call plan and stop |
| `--list-remote` | dump every circuit id in the upstream GeoJSON |
| `--only spa,americas` | build a subset |
| `--terrain` | include the surrounding DEM terrain grid |
| `--no-write` | build and validate without writing JSON |
| `--out <dir\|gs://bucket/prefix>` | where the payload goes (default `$TRACKGEO_OUT`, else `frontend/public/tracks`) |
| `--no-progress` | never write `track_geometry_builds` documents |

Environment:

| var | effect |
|---|---|
| `TRACKGEO_OUT` | default for `--out`. Set to the GCS destination in the job image |
| `TRACKGEO_CIRCUIT` | default for `--only`. `--only` wins if both are given |
| `TRACKGEO_CACHE_DIR` | where the HTTP cache lives (default `<repo>/.cache/trackgeo`) |
| `MONGODB_URI` | when set, the daily quota counter and build progress go to Mongo |
| `OPENTOPODATA_BASE_URL` | point at a self-hosted instance to remove the daily limit |

Tests: `python -m unittest discover scripts/tests`

## Data sources

| what | source | licence |
|---|---|---|
| Centrelines | [`bacinger/f1-circuits`](https://github.com/bacinger/f1-circuits) | MIT |
| Elevation | [OpenTopoData](https://www.opentopodata.org/) — `eudem25m`, `ned10m`, `srtm30m` | per-dataset; EU-DEM © European Union, NED public domain (USGS) |
| Track widths + racing line | [`TUMFTM/racetrack-database`](https://github.com/TUMFTM/racetrack-database) | see repo |
| Banking, corner names, blurbs | curated in `trackgeo/curated.py` | — |

## The quota, and why re-running is free

OpenTopoData's public API allows **1000 calls/day, 1 call/sec, 100 locations per
call**. Every response is cached under `.cache/trackgeo/` (gitignored) keyed by a
hash of the coordinates actually sent, so the first run spends quota and every
run after it is free and offline. Exhausting the daily budget (900 of the 1000,
leaving retry headroom) exits cleanly with everything already fetched still on
disk — it is a resumable stop, not a crash.

**Where the daily counter lives matters more than it looks.** It is
`.cache/trackgeo/quota.json` for a local run, and a `track_geometry_quota`
document in Mongo whenever `MONGODB_URI` is set. That is not a preference: a
Cloud Run Job's local disk is created fresh for every execution, so a file-backed
counter would read 0 at the start of every run, each run would believe it had all
900 calls available, and the real published 1000/day limit would be blown
silently — nothing on our side would ever observe the overspend. The Mongo store
increments with a single atomic `$inc`, so two executions racing cannot each read
the same starting value. With no Mongo configured it falls straight back to the
file, which is why the CLI still works with no infrastructure at all.

**The one structural decision that makes iteration free:** the DEM query set is
built from the *deduped raw* polyline resampled by plain linear interpolation at a
fixed 10 m spacing — never from the smoothed spline. So changing a smoothing
window, a filter constant, or anything in the curation table costs **zero API
calls**. Only adding a circuit or changing `DEM_SPACING_M` spends quota.

Current cost: **~23 calls** for the four circuits' centrelines, ~50 more with
terrain grids. All 24 circuits would be roughly 550.

To remove the limit entirely, run OpenTopoData locally and set
`OPENTOPODATA_BASE_URL=http://localhost:5000` — the budget check is skipped for
any non-public host. Note the honest cost: the global SRTM tile set is ~15 GB.

## Running as a Cloud Run Job

`Dockerfile.trackgeo` + `cloudbuild-trackgeo.yaml` package the same pipeline as
`f1-track-geometry`, a Cloud Run Job in `f1-dashboard-493015` / `asia-south1`.
It mirrors the existing `f1-data-sync` job: a batch process that exits, not a
server. Two things about the cloud context are not preferences and are worth
understanding before changing them.

**Output goes to GCS, not to `frontend/public/tracks/`.** That directory is
copied into the frontend Docker image at *build* time. A payload written there
at *run* time lands on the job's own disk, which nothing serves and which is
deleted when the execution ends — the running frontend container still holds the
image's copy. So the job writes `gs://f1-scratch-assets/tracks/<key>.json`, the
bucket that already serves driver, team and flag images through
`NEXT_PUBLIC_ASSET_BASE_URL`. The local directory is still a first-class
destination for CLI use; this is an added sink, not a replacement.

**The quota counter goes to Mongo.** See the section above — a per-execution
counter on ephemeral disk silently blows the real daily limit.

### Build and deploy

```bash
# 1. Build and push the image (mirrors cloudbuild-sync.yaml).
gcloud builds submit --config cloudbuild-trackgeo.yaml .

# 2. Create the job, once. MONGODB_URI comes from Secret Manager, the same way
#    the backend service and f1-data-sync take it.
gcloud run jobs create f1-track-geometry \
  --image gcr.io/f1-dashboard-493015/f1-track-geometry \
  --region asia-south1 \
  --set-secrets "MONGODB_URI=MONGODB_URI:latest" \
  --task-timeout 30m \
  --max-retries 0 \
  --memory 1Gi

# Later image updates need nothing but step 1 plus:
gcloud run jobs update f1-track-geometry --region asia-south1 \
  --image gcr.io/f1-dashboard-493015/f1-track-geometry
```

`--max-retries 0` is deliberate. A retry would re-spend OpenTopoData quota on a
build that already failed for a reason a retry will not fix (a bad spec, a
missing GeoJSON id), and the shared quota counter makes that cost real rather
than local. `--task-timeout 30m` covers the worst case comfortably: the pipeline
is rate-limited to 1 call/sec, so ~23 calls for a centreline plus ~40 for a
terrain grid is a couple of minutes, not thirty.

### The execution interface

**The circuit key is passed as an argument override at execution time.** The
image's `ENTRYPOINT` is the build script, so `--args` appends flags to it:

```bash
gcloud run jobs execute f1-track-geometry --region asia-south1 \
  --args="--only=monaco,--terrain,--report"
```

Use the `--only=monaco` form, not `--only monaco`: gcloud splits `--args` on
commas, and the two-token form would arrive as two separate arguments in a list
that also uses commas as its separator.

The equivalent env-var override also works, for a caller that finds it easier:

```bash
gcloud run jobs execute f1-track-geometry --region asia-south1 \
  --update-env-vars TRACKGEO_CIRCUIT=monaco
```

An execution with **no** override runs the image's default `CMD`, which is
`--dry-run` — it prints the call plan and exits 0. That default is a fail-safe:
the script's own default is "build every curated spec", which is ~500
OpenTopoData calls, and a forgotten `--args` should not be able to spend over
half the daily limit.

### Progress reporting

While it runs, the job upserts one document per circuit into
`track_geometry_builds`:

```js
{
  circuit_id: "monaco",
  status: "queued" | "running" | "done" | "failed",
  phase: "Sampling elevation",              // shown to the user verbatim
  progress_pct: 30,
  message: "Sampling elevation data…",      // shown to the user verbatim
  started_at: ISODate, updated_at: ISODate,
  error: null
}
```

`phase` and `message` are rendered by the frontend loader as-is, so they are
written as sentences for a person, never as log lines. Percentages are weighted
by wall-clock cost rather than spread evenly across stages — elevation sampling
is ~23 rate-limited HTTP calls and dominates everything else, so it owns 15→55
and is ticked once per real API call. A fully cached rebuild jumps straight to
the top of that range, which is honest: there is genuinely no waiting to report.

The document is keyed `_id: <circuit_id>` as well as carrying `circuit_id` as a
field, so there is exactly one row per circuit and either can be queried. The job
itself only ever writes `running` / `done` / `failed`; `queued` belongs to the
trigger endpoint, which creates the row when it accepts a request and before an
execution actually starts.

A reporting failure never fails a build. Losing a progress row is cosmetic;
aborting a build that has already spent scarce quota is not.

### Service account IAM

The job runs as the default compute service account
(`<project-number>-compute@developer.gserviceaccount.com`) unless
`--service-account` is passed. Whichever identity it uses needs:

| grant | why |
|---|---|
| `roles/storage.objectAdmin` on `gs://f1-scratch-assets` | write `tracks/<key>.json`. `objectCreator` alone is not enough — rebuilding a circuit **overwrites** an existing object, which needs delete as well as create |
| `roles/secretmanager.secretAccessor` on the `MONGODB_URI` secret | read the connection string at start-up |
| Mongo Atlas network access for the egress IP | Atlas is outside GCP IAM. Either allow `0.0.0.0/0` (as the existing services already do) or attach a VPC connector with a static NAT IP and allowlist that |

```bash
PROJECT_NUMBER=$(gcloud projects describe f1-dashboard-493015 --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud storage buckets add-iam-policy-binding gs://f1-scratch-assets \
  --member="serviceAccount:${SA}" --role="roles/storage.objectAdmin"

gcloud secrets add-iam-policy-binding MONGODB_URI \
  --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor"
```

Objects must also be publicly readable to be served through
`NEXT_PUBLIC_ASSET_BASE_URL`. The bucket already grants `allUsers`
`roles/storage.objectViewer` for the existing image assets, so a newly written
`tracks/` object inherits that and needs no per-object ACL.

CP57's backend service account additionally needs `roles/run.invoker` on this
job to trigger it — that grant belongs with the backend and is documented there.

### Running one build by hand

```bash
# Free and offline against the existing cache — the four CP50 circuits are
# already fully cached, so rebuilding one of those costs zero API calls.
python scripts/build_track_geometry.py --only spa --terrain --report --no-write

# Straight to the bucket from a workstation, using your own gcloud credentials.
MONGODB_URI="mongodb+srv://..." \
  python scripts/build_track_geometry.py --only monaco --terrain \
  --out gs://f1-scratch-assets/tracks
```

## Pipeline

```
GeoJSON LineString
  -> dedupe, close ring, trim stray points          clean.py
  -> [DEM path]  linear resample @10 m -> OpenTopoData
                 fill nulls -> Hampel despike -> bidirectional slope limit
                 -> Savitzky-Golay low-pass -> closure safety net   elevation.py
  -> [geom path] centripetal Catmull-Rom @5 m -> SG plan smooth
                 -> exact uniform re-resample       clean.py
  -> TUMFTM Procrustes fit (rotation+scale+shift+reflection)   align.py
  -> orient: s=0 onto start/finish, winding into racing direction
  -> map DEM profile onto geometry by nearest-point projection
  -> curvature, gradient, segments, highlights, banking
  -> terrain grid (same dataset, blended to track)   terrain.py
  -> quantise to integer decimetres -> JSON          emit.py
```

## Things that are non-obvious, and cost time to rediscover

- **Interlagos is `br-1940`, not `br-1977`.** Interlagos opened 1940, is 4309 m,
  and sits at ~765 m ASL. `br-1977` is Jacarepaguá (Rio) — 5031 m at sea level,
  officially "Autódromo Internacional Nelson Piquet". A DEM returning 3–11 m for a
  track at 765 m is how this was caught.

- **TUMFTM's CSVs start at the start/finish line**, which is how `s=0` is set.
  Verified on all three aligned circuits: the derived point lands 1.5–2.5 m from
  our centreline, and every expected elevation feature then falls where the layout
  says. Hand-guessed coordinates were up to 185 m out, which put `s=0` nearly a
  kilometre from the real line and silently mislabelled every highlight.

- **Two fit gates, for two purposes.** Widths and the racing line need a tight fit
  (< 8 m RMSE) because they are per-metre data for the *current* layout. Locating
  one point needs far less (< 25 m). Zandvoort fits at 11.2 m — TUMFTM predates
  the 2020 renovation that reprofiled Turns 3 and 14 — so it is used for `s=0`
  only and its widths are refused.

- **There is no pit-lane geometry in the source, and no pit-lane defect.** All 40
  features are clean closed rings (0.0 m closure gap). Four carry 1–2 stray points
  after closure, which get trimmed.

- **`properties.altitude` is fine; distrust your circuit mapping instead.**
  Absolute elevation still comes from the DEM.

- **Closure is almost free.** The ring keeps one shared sample at `s=0`, so `s=0`
  and `s=L` are the same coordinate and the DEM returns the same value; and every
  filter uses circular padding. `enforce_closure` is a safety net, not a stage.
  This is also why the profile is *not* derived by integrating a gradient array —
  that design accumulates real drift.

- **Highlights are measured over windows of the feature's physical length**, not
  over whole monotone runs. Spa's climb from the Eau Rouge compression to Les
  Combes is one continuous 64.8 m ascent, so taking the full run reports Eau Rouge
  as "+64.8 m at 5.8%" — true of the climb, wrong about the corner.

- **`MAX_GRADIENT = 0.22` is not a fudge factor.** Spa's −22.5% descent is real
  terrain: the raw DEM falls smoothly 452.1 → 436.0 m over 80 m with zero Hampel
  flags. Lowering the cap to 0.18 *increases* the count of >15% samples from 27 to
  34, because clamping redistributes.

- **Plan-smoothing window 7, not 11.** Window 11 inflates Interlagos' minimum
  corner radius by 18% (22.1 → 25.9 m) — corner flattening.

- **Terrain must use the same DEM dataset as the track.** Different vertical datums
  (EVRS / EGM96 / NAVD88) offset the ribbon from the ground across the whole scene.

## Current results

| circuit | dataset | measured Δ | published | ratio | quality |
|---|---|---|---|---|---|
| Spa | `eudem25m` | 107.2 m | 102.2 m | 1.05 | high |
| Interlagos | `srtm30m` | 43.5 m | 43 m | 1.01 | high |
| Austin | `ned10m` | 30.9 m | 41 m | 0.75 | high data, see below |
| Zandvoort | `eudem25m` | 5.1 m | unverified | — | medium |

`confidence` grades **data quality** — noise, outliers, closure drift, null
coverage, inter-dataset spread. Agreement with a published figure is reported
separately as `published_ratio` and deliberately does not dominate it.

Austin is the case that forced that split: `ned10m` is 10 m bare-earth lidar and
reports 30.9 m, while the 30 m DSM products report 36–37 m because they include
the Turn 1 grandstands and tower. The bare-earth number is the racing surface, so
it is kept — clean data that disagrees with a published scalar is still clean
data, and the UI should show both.

## Adding a circuit

1. `--list-remote` to find its GeoJSON id. **Check the length and name**, do not
   assume from the country code.
2. Add a `CircuitSpec` to `trackgeo/curated.py`: ids, `want_ccw` (the shoelace
   sign of the racing direction), `dem_dataset`, published figures, highlights
   with `expect_dz_m` and `expect_len_m`.
3. `--only <key> --report --no-write` and read the table. Highlights outside
   expectation almost always mean a wrong `want_ccw` (sign flipped) or a wrong
   `s=0` (right magnitude, wrong place).
4. Street circuits will fail. A 25 m DEM pixel over Monaco, Singapore or Vegas
   samples buildings, tunnels and overpasses, not tarmac — and Monaco's tunnel is
   topologically unrepresentable in a single-valued heightfield at all. Those need
   a curated profile and must render with an explicit low-confidence badge, never
   silently.
