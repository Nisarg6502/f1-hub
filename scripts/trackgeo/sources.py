"""Upstream data sources: circuit centrelines, elevation, track widths.

Three sources, all free and openly licensed:

1. bacinger/f1-circuits (MIT) — geo-referenced GeoJSON LineStrings for every
   circuit on the calendar, derived from OSM. Fetched once as the *combined*
   f1-circuits.geojson and indexed by properties.id, rather than 24 per-file
   requests: fewer calls, and a missing id becomes a loud failure instead of 24
   independent chances at a silent 404.

2. OpenTopoData — DEM elevation. Public API: 100 locations/request, 1 call/sec,
   1000 calls/day. See cache.py for the governor.

3. TUMFTM/racetrack-database — per-metre track widths and an optimal racing
   line, in an arbitrary local metric frame with no lat/lon. Usable only after
   the Procrustes alignment in align.py, and only for the ~15 circuits it
   covers.

THE KEY INVARIANT, and the reason this file separates "query points" from
"geometry": the DEM query set is built from the deduped *raw* polyline resampled
by plain linear interpolation at a fixed spacing. It must never depend on a
smoothing window, a spline parameter, or anything in the curation table, because
those get tuned dozens of times and each change would otherwise miss the cache
and cost another ~150 API calls. Elevation is mapped onto the smoothed geometry
afterwards, in elevation.map_profile_to_geometry.
"""

from __future__ import annotations

import hashlib

import numpy as np

from .cache import Budget, cached_json, cached_text, opentopo_base_url

GEOJSON_URL = (
    "https://raw.githubusercontent.com/bacinger/f1-circuits/master/f1-circuits.geojson"
)
TUMFTM_TRACK_URL = (
    "https://raw.githubusercontent.com/TUMFTM/racetrack-database/master/tracks/{name}.csv"
)
TUMFTM_RACELINE_URL = (
    "https://raw.githubusercontent.com/TUMFTM/racetrack-database/master/racelines/{name}.csv"
)

OPENTOPO_BATCH = 100
DEM_INTERPOLATION = "bilinear"  # explicit; cubic can overshoot near cliff cells


# --------------------------------------------------------------------------
# 1. Centrelines
# --------------------------------------------------------------------------


def fetch_circuit_index(force: bool = False) -> dict[str, dict]:
    """Fetch the combined GeoJSON and index its features by properties.id."""
    payload, _ = cached_json(
        GEOJSON_URL, subdir="geojson", key="f1-circuits", force=force
    )
    index: dict[str, dict] = {}
    for feature in payload.get("features", []):
        circuit_id = (feature.get("properties") or {}).get("id")
        if circuit_id:
            index[str(circuit_id)] = feature
    if not index:
        raise RuntimeError("combined GeoJSON contained no usable features")
    return index


def feature_coords(feature: dict) -> tuple[np.ndarray, np.ndarray]:
    """Extract (lats, lons) from a LineString feature.

    GeoJSON stores positions as [lon, lat]. Getting that backwards yields a
    transposed circuit that still looks plausible, so the latitude range is
    asserted rather than trusted.
    """
    geometry = feature.get("geometry") or {}
    if geometry.get("type") != "LineString":
        raise ValueError(f"expected LineString, got {geometry.get('type')!r}")
    coords = np.asarray(geometry.get("coordinates") or [], dtype=float)
    if coords.ndim != 2 or coords.shape[1] < 2 or len(coords) < 20:
        raise ValueError(f"unusable coordinate array of shape {coords.shape}")
    lons, lats = coords[:, 0], coords[:, 1]
    if np.max(np.abs(lats)) > 90.0:
        raise ValueError("latitude out of range — coordinate order is probably [lat, lon]")
    return lats, lons


def describe_index(index: dict[str, dict]) -> list[tuple[str, str, str, float]]:
    """(id, Location, Name, length_m) for every feature — backs --list-remote."""
    rows = []
    for circuit_id, feature in sorted(index.items()):
        props = feature.get("properties") or {}
        rows.append(
            (
                circuit_id,
                str(props.get("Location", "")),
                str(props.get("Name", "")),
                float(props.get("length") or 0.0),
            )
        )
    return rows


# --------------------------------------------------------------------------
# 2. Elevation
# --------------------------------------------------------------------------


def dem_batch_key(dataset: str, interpolation: str, lats: np.ndarray, lons: np.ndarray) -> str:
    """Stable cache key for one DEM batch.

    Hashes the coordinates *as sent*, rounded to 6 decimals (0.11 m), so a
    re-run reproduces the key bit-for-bit.
    """
    body = "|".join(f"{la:.6f},{lo:.6f}" for la, lo in zip(lats, lons))
    digest = hashlib.sha1(f"{dataset}|{interpolation}|{body}".encode("utf-8")).hexdigest()
    return digest[:16]


def _round6(values: np.ndarray) -> np.ndarray:
    return np.round(np.asarray(values, dtype=float), 6)


def dem_call_plan(n_points: int) -> int:
    """Number of API calls a point set will cost."""
    return (n_points + OPENTOPO_BATCH - 1) // OPENTOPO_BATCH


def fetch_dem(
    dataset: str,
    lats: np.ndarray,
    lons: np.ndarray,
    budget: Budget,
    *,
    interpolation: str = DEM_INTERPOLATION,
    force: bool = False,
) -> np.ndarray:
    """Sample a DEM at the given coordinates. Returns elevations in metres.

    Missing samples come back as NaN for the caller to fill — a null is data
    about coverage, not an error to swallow here.
    """
    lats = _round6(lats)
    lons = _round6(lons)
    base = opentopo_base_url()
    out = np.full(len(lats), np.nan, dtype=float)

    for start in range(0, len(lats), OPENTOPO_BATCH):
        stop = min(start + OPENTOPO_BATCH, len(lats))
        blat, blon = lats[start:stop], lons[start:stop]
        locations = "|".join(f"{la:.6f},{lo:.6f}" for la, lo in zip(blat, blon))
        url = (
            f"{base}/v1/{dataset}"
            f"?locations={locations}&interpolation={interpolation}"
        )
        payload, _ = cached_json(
            url,
            subdir=f"dem/{dataset}",
            key=dem_batch_key(dataset, interpolation, blat, blon),
            budget=budget,
            throttled=True,
            force=force,
        )
        if payload.get("status") != "OK":
            raise RuntimeError(f"OpenTopoData error for {dataset}: {payload.get('error')}")
        results = payload.get("results") or []
        if len(results) != stop - start:
            raise RuntimeError(
                f"OpenTopoData returned {len(results)} results for {stop - start} locations"
            )
        for offset, result in enumerate(results):
            elevation = result.get("elevation")
            if elevation is not None:
                out[start + offset] = float(elevation)

    return out


# --------------------------------------------------------------------------
# 3. Widths and racing line
# --------------------------------------------------------------------------


def fetch_tumftm_track(name: str, force: bool = False) -> np.ndarray | None:
    """Load a TUMFTM track CSV as [x_m, y_m, w_tr_right_m, w_tr_left_m].

    Coordinates are in an arbitrary local metric frame — align.py exists to fix
    that. Returns None when the circuit is not in the dataset, which is a
    normal, expected outcome for ~9 of the 24 current circuits.
    """
    return _fetch_tumftm_csv(TUMFTM_TRACK_URL.format(name=name), f"track-{name}.csv", 4, force)


def fetch_tumftm_raceline(name: str, force: bool = False) -> np.ndarray | None:
    """Load a TUMFTM raceline CSV as [x_m, y_m], in the same local frame."""
    return _fetch_tumftm_csv(
        TUMFTM_RACELINE_URL.format(name=name), f"raceline-{name}.csv", 2, force
    )


def _fetch_tumftm_csv(
    url: str, key: str, min_cols: int, force: bool
) -> np.ndarray | None:
    try:
        text, _ = cached_text(url, subdir="tumftm", key=key, force=force)
    except Exception:
        return None
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p for p in line.replace(";", ",").split(",") if p.strip()]
        try:
            values = [float(p) for p in parts]
        except ValueError:
            continue  # header row
        if len(values) >= min_cols:
            rows.append(values[:min_cols])
    if len(rows) < 50:
        return None
    return np.asarray(rows, dtype=float)
