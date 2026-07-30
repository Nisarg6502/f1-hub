#!/usr/bin/env python
"""Build baked 3D track geometry for the Elevation Track viewer.

    python scripts/build_track_geometry.py --report
    python scripts/build_track_geometry.py --only spa --terrain --report
    python scripts/build_track_geometry.py --dry-run
    python scripts/build_track_geometry.py --list-remote

Writes frontend/public/tracks/<key>.json. See scripts/README.md for the data
sources, the OpenTopoData quota rules, and why re-running is free.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from trackgeo import align, clean, curated, elevation as elev, emit, terrain as terr
from trackgeo.cache import CACHE_ROOT, Budget, QuotaExhausted, opentopo_base_url
from trackgeo.project import centroid, to_enu, to_geo
from trackgeo.sources import (
    dem_call_plan,
    describe_index,
    feature_coords,
    fetch_circuit_index,
    fetch_dem,
    fetch_tumftm_raceline,
    fetch_tumftm_track,
)

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "frontend" / "public" / "tracks"

GEOM_SPACING_M = 5.0
DEM_SPACING_M = 10.0
PLAN_SMOOTH_WINDOW = 7
LENGTH_WARN_PCT = 4.0


# --------------------------------------------------------------------------
# Derived features
# --------------------------------------------------------------------------


def curvature(e: np.ndarray, n: np.ndarray, spacing_m: float) -> np.ndarray:
    """Signed curvature (1/m) from SG first and second derivatives."""
    de = clean.savgol_periodic(e, 7, 2, deriv=1, delta=spacing_m)
    dn = clean.savgol_periodic(n, 7, 2, deriv=1, delta=spacing_m)
    dde = clean.savgol_periodic(e, 7, 2, deriv=2, delta=spacing_m)
    ddn = clean.savgol_periodic(n, 7, 2, deriv=2, delta=spacing_m)
    denominator = np.power(de * de + dn * dn, 1.5)
    return (de * ddn - dn * dde) / np.maximum(denominator, 1e-12)


def detect_corners(
    curvature_values: np.ndarray,
    s: np.ndarray,
    spacing_m: float,
    min_radius_m: float = 250.0,
    min_gap_m: float = 80.0,
) -> list[dict]:
    """Find corner apexes as local maxima of |curvature|.

    Deliberately NOT an attempt to reproduce official corner numbering. Raw
    curvature peaks and F1's numbering do not agree: Spa detects 30 apexes
    against 19 numbered corners, because the official scheme merges multi-apex
    complexes (Eau Rouge/Raidillon is one number, not three) and ignores gentle
    kinks. Matching curated names to detected peaks by index would therefore be
    wrong for most of the lap.

    Instead this returns every apex with its radius and direction, and the
    curation table names them by approximate arc length (see snap_corner_names).
    """
    magnitude = np.abs(curvature_values)
    threshold = 1.0 / min_radius_m
    gap = max(1, int(round(min_gap_m / spacing_m)))
    count = len(magnitude)

    taken = np.zeros(count, dtype=bool)
    peaks: list[int] = []
    for index in np.argsort(-magnitude):
        if magnitude[index] < threshold:
            break
        window = np.arange(index - gap, index + gap + 1) % count
        if taken[window].any():
            continue
        taken[index] = True
        peaks.append(int(index))

    return [
        {
            "s_m": round(float(s[i]), 1),
            "radius_m": round(float(1.0 / max(magnitude[i], 1e-9)), 1),
            "direction": "left" if curvature_values[i] > 0 else "right",
        }
        for i in sorted(peaks)
    ]


def snap_corner_names(
    corners: list[dict],
    named: tuple[tuple[float, str], ...],
    tolerance_m: float = 130.0,
) -> tuple[list[dict], list[str]]:
    """Attach curated names to the nearest detected apex.

    Snapping rather than trusting the curated arc length directly: the name then
    lands on real geometry, and a curated position that drifts (or was simply
    wrong) fails loudly instead of quietly placing a label on a straight.
    """
    warnings: list[str] = []
    if not corners:
        return [], warnings

    positions = np.array([c["s_m"] for c in corners], dtype=float)
    out: list[dict] = []
    for approx_s, name in named:
        distances = np.abs(positions - approx_s)
        best = int(np.argmin(distances))
        if distances[best] > tolerance_m:
            warnings.append(
                f"corner {name!r}: no apex within {tolerance_m:.0f} m of "
                f"s={approx_s:.0f} m (nearest is {distances[best]:.0f} m away)"
            )
            continue
        entry = dict(corners[best])
        entry["name"] = name
        out.append(entry)

    out.sort(key=lambda c: c["s_m"])
    return out, warnings


def banking_profile(
    s: np.ndarray, ranges: tuple[tuple[float, float, float], ...]
) -> np.ndarray | None:
    """Curated banking as degrees per sample, ramped in and out with smoothstep."""
    if not ranges:
        return None
    bank = np.zeros_like(s)
    for start, end, peak in ranges:
        span = end - start
        if span <= 0:
            continue
        inside = (s >= start) & (s <= end)
        t = (s[inside] - start) / span
        # Ramp up over the first 25% and down over the last 25%.
        ramp = np.clip(np.minimum(t / 0.25, (1.0 - t) / 0.25), 0.0, 1.0)
        bank[inside] = np.maximum(bank[inside], peak * ramp * ramp * (3.0 - 2.0 * ramp))
    return bank


def measure_highlight(
    highlight, s: np.ndarray, z: np.ndarray, spacing_m: float
) -> dict | None:
    """Measure a named elevation feature near its expected position.

    Highlights are *measured*, never curated: expect_dz_m only validates.

    The search is over windows of roughly the feature's physical length rather
    than over the whole monotone run. That distinction matters: Spa's climb from
    the Eau Rouge compression to Les Combes is one continuous 64.8 m ascent, so
    taking the full run reports Eau Rouge as "+64.8 m at 5.8%" — technically true
    of the whole climb, and completely wrong about the corner. Constraining the
    window to ~380 m isolates the steep core instead.

    Everything is done on rolled (contiguous) arrays so a window spanning s=0
    works. The earlier index-mask version silently produced spans like
    "s 470-5514" because np.where returns a non-contiguous index set when the
    window wraps.
    """
    total = float(s[-1]) + spacing_m if len(s) else 0.0
    count = len(z)
    if highlight.expect_s_m is None or total <= 0 or count < 10:
        return None

    half_search = highlight.search_window_m / 2.0
    start_s = highlight.expect_s_m - half_search
    roll = int(round(start_s / spacing_m))
    span = int(round(highlight.search_window_m / spacing_m))
    span = min(span, count - 1)
    if span < 4:
        return None

    zr = np.roll(z, -roll)[: span + 1]
    base_s = roll * spacing_m

    # Window lengths bracketing the expected physical length.
    lo_len = max(2, int(round(0.6 * highlight.expect_len_m / spacing_m)))
    hi_len = max(lo_len + 1, int(round(1.6 * highlight.expect_len_m / spacing_m)))
    hi_len = min(hi_len, span)

    want_climb = highlight.kind != "descent"
    best: tuple[float, int, int] | None = None
    for width in range(lo_len, hi_len + 1):
        deltas = zr[width:] - zr[:-width]
        if not len(deltas):
            continue
        idx = int(np.argmax(deltas) if want_climb else np.argmin(deltas))
        score = float(deltas[idx] if want_climb else -deltas[idx])
        if best is None or score > best[0]:
            best = (score, idx, idx + width)

    if best is None:
        return None
    _, a, b = best
    delta_z = float(zr[b] - zr[a])
    run = float((b - a) * spacing_m)
    s0 = (base_s + a * spacing_m) % total
    s1 = (base_s + b * spacing_m) % total

    result = {
        "id": highlight.id,
        "name": highlight.name,
        "kind": highlight.kind,
        "s_start_m": round(s0, 1),
        "s_end_m": round(s1, 1),
        "run_m": round(run, 1),
        "delta_z_m": round(delta_z, 1),
        "gradient_pct": round(100.0 * delta_z / run, 1) if run > 0 else 0.0,
        "blurb": highlight.blurb,
    }
    if highlight.expect_dz_m is not None:
        low, high = highlight.expect_dz_m
        result["expected_dz_m"] = [low, high]
        result["within_expectation"] = bool(low <= delta_z <= high)
    return result


def derive_segments(
    s: np.ndarray, z: np.ndarray, min_len_m: float = 120.0, min_dz_m: float = 4.0
) -> list[dict]:
    """Split the lap into sustained climb / descent / flat runs."""
    if len(s) < 10:
        return []
    dz = np.diff(z, append=z[0])
    sign = np.sign(np.where(np.abs(dz) < 1e-6, 0.0, dz))
    segments: list[dict] = []
    start = 0
    for i in range(1, len(sign) + 1):
        if i == len(sign) or sign[i] != sign[start]:
            run = float(s[min(i, len(s) - 1)] - s[start])
            delta = float(z[min(i, len(z) - 1)] - z[start])
            if run >= min_len_m and abs(delta) >= min_dz_m:
                segments.append(
                    {
                        "s_start_m": round(float(s[start]), 1),
                        "s_end_m": round(float(s[min(i, len(s) - 1)]), 1),
                        "delta_z_m": round(delta, 1),
                        "gradient_pct": round(100.0 * delta / run, 1),
                        "kind": "climb" if delta > 0 else "descent",
                    }
                )
            start = i
    return segments


def grade_confidence(diagnostics: dict) -> tuple[str, list[str]]:
    """Grade the elevation DATA quality. Agreement with a published scalar is
    reported separately and deliberately does not dominate this.

    A clean, smooth, zero-outlier profile that disagrees with a marketing figure
    is good data, not bad data (see Austin: 10 m bare-earth lidar vs a published
    number that includes grandstands).
    """
    reasons: list[str] = []
    level = 0  # 0 high, 1 medium, 2 low

    def demote(to: int, why: str) -> None:
        nonlocal level
        if to > level:
            level = to
        reasons.append(why)

    outliers = diagnostics.get("despiked_fraction", 0.0)
    if outliers >= 0.15:
        demote(2, f"{outliers:.0%} of DEM samples were outliers")
    elif outliers >= 0.05:
        demote(1, f"{outliers:.0%} of DEM samples were outliers")

    drift = abs(diagnostics.get("closure_drift_m", 0.0))
    if drift >= 8.0:
        demote(2, f"closure drift {drift:.1f} m indicates a structural problem")
    elif drift >= 1.0:
        demote(1, f"closure drift {drift:.1f} m")

    noisy = diagnostics.get("steep_fraction", 0.0)
    if noisy >= 0.05:
        demote(2, f"{noisy:.1%} of samples exceed 15% gradient")
    elif noisy >= 0.02:
        demote(1, f"{noisy:.1%} of samples exceed 15% gradient")

    nulls = diagnostics.get("null_fraction", 0.0)
    if nulls > 0.02:
        demote(1, f"{nulls:.1%} of DEM samples were missing")

    spread = diagnostics.get("dataset_spread_ratio")
    if spread is not None and spread >= 2.0:
        demote(1, f"datasets disagree by {spread:.1f}x on total elevation change")

    return ("high", "medium", "low")[level], reasons


# --------------------------------------------------------------------------
# Build one circuit
# --------------------------------------------------------------------------


def build_circuit(
    spec, index: dict, budget: Budget, want_terrain: bool
) -> tuple[dict, dict]:
    feature = index.get(spec.bacinger_id)
    if feature is None:
        raise KeyError(
            f"{spec.key}: bacinger id {spec.bacinger_id!r} not present in the "
            "combined GeoJSON — refusing to fall back and silently drop a circuit"
        )

    lats, lons = feature_coords(feature)
    lat0, lon0 = centroid(lats, lons)
    e_raw, n_raw = to_enu(lats, lons, lat0, lon0)
    e_raw, n_raw = clean.dedupe(e_raw, n_raw)
    e_raw, n_raw, ring_diag = clean.close_ring(e_raw, n_raw)

    # --- DEM query set: raw polyline, linear, fixed spacing. Never depends on
    # any smoothing parameter, so the cache survives all downstream tuning.
    dem_e, dem_n = clean.resample_linear(e_raw, n_raw, DEM_SPACING_M, closed=True)
    dem_lat, dem_lon = to_geo(dem_e, dem_n, lat0, lon0)
    dem_s = clean.arc_length(dem_e, dem_n, closed=True)
    dem_spacing = float(dem_s[-1] / len(dem_e))

    raw_z = fetch_dem(spec.dem_dataset, dem_lat, dem_lon, budget)
    filled, n_null, longest_null = elev.fill_nulls(raw_z)
    despiked, outlier_mask = elev.hampel(filled)
    limited = elev.slope_limit(despiked, dem_spacing)
    smoothed = elev.lowpass(limited)
    profile_z, drift = elev.enforce_closure(smoothed, dem_s)

    # --- Geometry: spline resample -> plan smooth -> exact uniform resample
    geo_e, geo_n = clean.resample_catmull_rom(e_raw, n_raw, GEOM_SPACING_M)
    geo_e, geo_n = clean.smooth_plan(geo_e, geo_n, window=PLAN_SMOOTH_WINDOW)
    geo_e, geo_n = clean.resample_linear(geo_e, geo_n, GEOM_SPACING_M, closed=True)

    # --- TUMFTM fit, done BEFORE orientation because it also locates the S/F line
    track_csv = fetch_tumftm_track(spec.tumftm_name) if spec.tumftm_name else None
    fit = align.align_tumftm(geo_e, geo_n, track_csv) if track_csv is not None else None

    # --- Orientation: index 0 onto the S/F line, winding into racing direction.
    # Prefer the TUMFTM-derived start/finish: its CSVs are ordered from the S/F
    # line, and the derived point lands 1.5-2.5 m from our centreline, versus a
    # hand-curated coordinate that was 185 m out on Spa and put s=0 nearly a
    # kilometre from the real line.
    sf_source = "curated"
    if fit is not None:
        sf_index, sf_residual = align.start_finish_from_fit(geo_e, geo_n, track_csv, fit)
        sf_e_val, sf_n_val = float(geo_e[sf_index]), float(geo_n[sf_index])
        sf_source = f"tumftm (residual {sf_residual:.1f} m)"
    else:
        sf_enu_e, sf_enu_n = to_enu(
            np.array([spec.sf_lat]), np.array([spec.sf_lon]), lat0, lon0
        )
        sf_e_val, sf_n_val = float(sf_enu_e[0]), float(sf_enu_n[0])

    geo_e, geo_n, orient = clean.normalize_start_and_direction(
        geo_e, geo_n, sf_e_val, sf_n_val, spec.want_ccw
    )

    geo_s_full = clean.arc_length(geo_e, geo_n, closed=True)
    length_m = float(geo_s_full[-1])
    spacing_m = length_m / len(geo_e)
    s = geo_s_full[: len(geo_e)]

    z = elev.map_profile_to_geometry(geo_e, geo_n, dem_e, dem_n, profile_z)
    grad = elev.gradient(z, spacing_m)
    curv = curvature(geo_e, geo_n, spacing_m)
    bank = banking_profile(s, spec.banking_ranges)

    # --- TUMFTM widths + racing line, only under the STRICT fit gate.
    # A loose fit is fine for locating one point (the S/F line) but not for
    # per-metre data: Zandvoort fits at 11.26 m RMSE because TUMFTM predates the
    # 2020 renovation, and its widths belong to a layout that no longer exists.
    half_l = half_r = None
    raceline = None
    if fit is not None and fit["widths_ok"]:
        half_l, half_r = align.widths_along(geo_e, geo_n, track_csv, fit)
        raceline_csv = fetch_tumftm_raceline(spec.tumftm_name)
        if raceline_csv is not None:
            raceline = align.apply_transform(raceline_csv[:, :2], fit)

    # --- Terrain
    terrain_json = None
    z_ref_m = float(np.floor(z.min()))
    if want_terrain and spec.want_terrain:
        meta, grid_e, grid_n = terr.grid_points(geo_e, geo_n)
        grid_lat, grid_lon = to_geo(grid_e, grid_n, lat0, lon0)
        grid_raw = fetch_dem(spec.dem_dataset, grid_lat, grid_lon, budget)
        grid_z, _, _ = elev.fill_nulls(grid_raw)
        grid_z = terr.smooth_grid(grid_z, meta["nx"], meta["ny"])
        grid_z = terr.blend_to_track(grid_z, grid_e, grid_n, geo_e, geo_n, z)
        z_ref_m = float(np.floor(min(z.min(), grid_z.min())))
        terrain_json = emit.terrain_payload(meta, grid_z, z_ref_m)

    # --- Stats, highlights, validation
    stats = elev.summarize(z, grad, spacing_m)
    steep_fraction = float(np.mean(np.abs(grad) > 0.15))
    diagnostics = {
        "dem_dataset": spec.dem_dataset,
        "dem_samples": int(len(dem_e)),
        "dem_spacing_m": round(dem_spacing, 3),
        "geometry_samples": int(len(geo_e)),
        "despiked_fraction": round(float(outlier_mask.mean()), 4),
        "null_fraction": round(n_null / max(len(raw_z), 1), 4),
        "longest_null_run": int(longest_null),
        "closure_drift_m": round(float(drift), 3),
        "steep_fraction": round(steep_fraction, 4),
        "ring_closure_gap_m": round(float(ring_diag["closure_gap_m"]), 2),
        "ring_trimmed_points": int(ring_diag["trimmed_points"]),
        "start_index_rolled": int(orient["start_index"]),
        "sf_seed_distance_m": round(float(orient["sf_distance_m"]), 1),
        "winding_reversed": bool(orient["reversed"]),
        "tumftm_rmse_m": round(float(fit["rmse"]), 2) if fit else None,
        "tumftm_scale": round(float(fit["scale"]), 4) if fit else None,
        "tumftm_widths_used": bool(fit and fit["widths_ok"]),
        "start_finish_source": sf_source,
        "dataset_spread_ratio": (
            round(spec.dataset_spread_ratio, 2) if spec.dataset_spread_ratio else None
        ),
    }
    if fit is not None and not fit["widths_ok"]:
        diagnostics["tumftm_rejected_reason"] = (
            f"fit RMSE {fit['rmse']:.1f} m exceeds the {align.MAX_RMSE_M:.0f} m gate "
            "for per-metre data — most likely a different layout era. Used for "
            "start/finish anchoring only."
        )

    length_error_pct = (
        100.0 * (length_m - spec.published_length_m) / spec.published_length_m
        if spec.published_length_m
        else None
    )
    if length_error_pct is not None and abs(length_error_pct) > LENGTH_WARN_PCT:
        raise ValueError(
            f"{spec.key}: computed length {length_m:.0f} m differs from published "
            f"{spec.published_length_m:.0f} m by {length_error_pct:+.1f}% — the "
            "source probably digitises a different layout era"
        )
    diagnostics["length_error_pct"] = (
        round(length_error_pct, 2) if length_error_pct is not None else None
    )

    if orient["sf_distance_m"] > 200.0:
        diagnostics["sf_seed_warning"] = (
            f"curated start/finish coordinate is {orient['sf_distance_m']:.0f} m "
            "from the nearest track sample"
        )

    confidence, reasons = grade_confidence(diagnostics)
    published = spec.published_elevation_change_m
    stats.update(
        {
            "confidence": confidence,
            "confidence_reasons": reasons,
            "source": spec.dem_dataset,
            "published_change_m": published,
            "published_ratio": (
                round(stats["total_change_m"] / published, 3) if published else None
            ),
            "published_source": spec.published_source,
        }
    )
    for key in ("min_m", "max_m", "total_change_m", "cumulative_ascent_m",
                "cumulative_descent_m", "max_gradient_pct", "min_gradient_pct"):
        stats[key] = round(stats[key], 2)

    highlights = [
        h for h in (measure_highlight(hl, s, z, spacing_m) for hl in spec.highlights) if h
    ]

    apexes = detect_corners(curv, s, spacing_m)
    corners, corner_warnings = snap_corner_names(apexes, spec.corner_names)
    diagnostics["apexes_detected"] = len(apexes)
    diagnostics["corners_named"] = len(corners)
    if corner_warnings:
        diagnostics["corner_warnings"] = corner_warnings

    sources = {
        "centerline": "bacinger/f1-circuits (MIT)",
        "elevation": f"{spec.dem_dataset} via OpenTopoData",
        "width": (
            "TUMFTM/racetrack-database"
            if half_l is not None
            else f"constant {spec.half_width_m} m"
        ),
        "raceline": "TUMFTM/racetrack-database" if raceline is not None else None,
        "banking": "curated" if bank is not None else None,
    }

    payload = emit.build_payload(
        spec=spec,
        e=geo_e,
        n=geo_n,
        z=z,
        curvature=curv,
        gradient=grad,
        half_width_l=half_l,
        half_width_r=half_r,
        bank_deg=bank,
        raceline=raceline,
        terrain=terrain_json,
        spacing_m=spacing_m,
        length_m=length_m,
        z_ref_m=z_ref_m,
        origin=(lat0, lon0),
        elevation_stats=stats,
        corners=corners,
        highlights=highlights,
        segments=derive_segments(s, z),
        diagnostics=diagnostics,
        sources=sources,
    )
    return payload, diagnostics


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def print_report(payload: dict) -> None:
    stats = payload["elevation"]
    diag = payload["diagnostics"]
    ratio = stats["published_ratio"]
    print(f"\n=== {payload['name']} ({payload['id']}) ===")
    print(
        f"  length      {payload['length_m']:.0f} m "
        f"(published {payload['length_m_published']}, "
        f"{diag['length_error_pct']:+.2f}%)   {diag['geometry_samples']} samples "
        f"@ {payload['sample_spacing_m']:.3f} m"
    )
    print(
        f"  elevation   {stats['total_change_m']:.1f} m change   "
        f"{stats['min_m'] :.0f}..{stats['max_m']:.0f} m ASL   "
        f"published {stats['published_change_m']}"
        + (f" (ratio {ratio:.2f})" if ratio else "")
    )
    print(
        f"  gradient    {stats['min_gradient_pct']:+.1f}% .. "
        f"{stats['max_gradient_pct']:+.1f}% over "
        f"{stats['gradient_baseline_m']:.0f} m   "
        f"ascent {stats['cumulative_ascent_m']:.0f} m"
    )
    print(
        f"  quality     {stats['confidence'].upper()}   "
        f"outliers {diag['despiked_fraction']:.1%}   "
        f"drift {diag['closure_drift_m']:+.2f} m   "
        f"steep {diag['steep_fraction']:.2%}   "
        f"dataset {diag['dem_dataset']}"
    )
    for reason in stats["confidence_reasons"]:
        print(f"                - {reason}")
    tum = f"rmse {diag['tumftm_rmse_m']} m scale {diag['tumftm_scale']}" if diag["tumftm_rmse_m"] else "no fit"
    print(
        f"  tumftm      {tum}   widths "
        f"{'per-sample' if payload['half_width_dm_l'] else 'constant'}   "
        f"raceline {'yes' if payload['raceline'] else 'no'}"
    )
    if "tumftm_rejected_reason" in diag:
        print(f"              {diag['tumftm_rejected_reason']}")
    print(
        f"  orientation s=0 from {diag['start_finish_source']}, "
        f"rolled {diag['start_index_rolled']} samples, "
        f"reversed={diag['winding_reversed']}"
    )
    if "sf_seed_warning" in diag:
        print(f"              WARNING: {diag['sf_seed_warning']}")
    print(
        f"  corners     {diag['corners_named']} named of "
        f"{diag['apexes_detected']} apexes detected"
        + (
            "   " + ", ".join(f"{c['name']} @ {c['s_m']:.0f} m" for c in payload["corners"])
            if payload["corners"]
            else ""
        )
    )
    for warning in diag.get("corner_warnings", []):
        print(f"              WARNING: {warning}")
    for h in payload["highlights"]:
        ok = h.get("within_expectation")
        mark = "" if ok is None else ("  OK" if ok else "  <<< OUTSIDE EXPECTATION")
        print(
            f"  highlight   {h['name']:<28s} s {h['s_start_m']:6.0f}-{h['s_end_m']:6.0f} m "
            f"({h['run_m']:5.0f} m)  dz {h['delta_z_m']:+6.1f} m  "
            f"{h['gradient_pct']:+5.1f}%{mark}"
        )
    if payload["terrain"]:
        t = payload["terrain"]
        print(f"  terrain     {t['nx']}x{t['ny']} @ {t['spacing_m']:.0f} m spacing")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="comma-separated circuit keys")
    parser.add_argument("--terrain", action="store_true", help="include the DEM terrain grid")
    parser.add_argument("--dry-run", action="store_true", help="print the quota plan and stop")
    parser.add_argument("--list-remote", action="store_true", help="dump every GeoJSON feature id")
    parser.add_argument("--report", action="store_true", help="print the validation report")
    parser.add_argument("--no-write", action="store_true", help="build but do not write JSON")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="output directory")
    args = parser.parse_args(argv)

    index = fetch_circuit_index()

    if args.list_remote:
        print(f"{'id':12s} {'len_m':>6s}  {'location':<24s} name")
        for cid, location, name, length in describe_index(index):
            print(f"{cid:12s} {length:6.0f}  {location:<24s} {name}")
        return 0

    keys = (
        [k.strip() for k in args.only.split(",") if k.strip()]
        if args.only
        else [s.key for s in curated.SPECS]
    )
    specs = [curated.get(k) for k in keys]
    budget = Budget.load(opentopo_base_url())

    if args.dry_run:
        print(f"base {opentopo_base_url()}  used today {budget.calls}/{budget.limit}")
        total = 0
        for spec in specs:
            feature = index.get(spec.bacinger_id)
            if feature is None:
                print(f"  {spec.key:12s} MISSING geojson id {spec.bacinger_id}")
                continue
            lats, lons = feature_coords(feature)
            lat0, lon0 = centroid(lats, lons)
            e, n = to_enu(lats, lons, lat0, lon0)
            e, n = clean.dedupe(e, n)
            e, n, _ = clean.close_ring(e, n)
            de, _ = clean.resample_linear(e, n, DEM_SPACING_M, closed=True)
            track_calls = dem_call_plan(len(de))
            grid_calls = dem_call_plan(terr.TERRAIN_SIDE**2) if args.terrain else 0
            total += track_calls + grid_calls
            print(
                f"  {spec.key:12s} {len(de):5d} track pts ({track_calls} calls)"
                + (f" + {terr.TERRAIN_SIDE**2} terrain pts ({grid_calls} calls)" if args.terrain else "")
            )
        print(f"  TOTAL {total} calls (cached batches cost nothing)")
        return 0

    out_dir = pathlib.Path(args.out)
    failures = 0
    for spec in specs:
        try:
            payload, _ = build_circuit(spec, index, budget, args.terrain)
        except QuotaExhausted as exc:
            print(f"\n{spec.key}: {exc}")
            return 2
        except Exception as exc:  # noqa: BLE001 - one bad circuit must not stop the run
            print(f"\n{spec.key}: FAILED — {exc}")
            failures += 1
            continue
        if not args.no_write:
            path = emit.write_payload(payload, out_dir)
            size_kb = path.stat().st_size / 1024.0
            payload_note = f"  -> {path.relative_to(REPO_ROOT)} ({size_kb:.0f} KB)"
        else:
            payload_note = "  (not written)"
        if args.report:
            print_report(payload)
            print(payload_note)
        else:
            print(f"{spec.key}: ok{payload_note}")

    print(f"\nDEM calls used today: {budget.calls}/{budget.limit}  cache: {CACHE_ROOT}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
