# Track geometry build (CP50)

Bakes the 3D circuit geometry that the Elevation Track viewer loads from
`frontend/public/tracks/<key>.json`. Offline, run by hand, never at request time.

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
run after it is free and offline. A daily counter lives in
`.cache/trackgeo/quota.json`; exhausting it exits cleanly with everything already
fetched still on disk.

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
