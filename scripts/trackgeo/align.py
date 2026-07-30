"""Align TUMFTM's local-frame track data onto our geo-referenced centreline.

TUMFTM/racetrack-database ships per-metre track widths and an optimal racing
line, but its coordinates are in an arbitrary local metric frame with no lat/lon,
so it cannot be joined to a DEM or to the GeoJSON directly. Both its tracks/ and
racelines/ files share one frame, and its centrelines were themselves derived
from OSM — so fitting its centreline to ours yields a transform that can then be
applied to the racing line for free.

The fit is a similarity transform (rotation + uniform scale + translation) solved
by Umeyama/Kabsch. Three search dimensions are required because nothing
guarantees the two datasets agree on any of them:

  cyclic shift  — neither starts at the same point on the lap
  traversal     — reversing the point order changes winding without changing shape
  handedness    — a mirrored frame changes the shape and needs a reflection

Both datasets are in metres, so the recovered scale should be ~1.0; a scale far
from 1 means the match is spurious even if the RMSE looks acceptable.
"""

from __future__ import annotations

import numpy as np

from .clean import arc_length, resample_linear

ALIGN_SAMPLES = 512
SCALE_TOLERANCE = 0.06  # accept 0.94 .. 1.06

# Two gates, because the fit is used for two independent purposes.
#
# Widths and the racing line are per-metre data that must correspond to the
# *current* layout, so they need a tight fit. Zandvoort fails this at 11.26 m
# RMSE (scale 0.997, perimeter within 1%) — the signature of a different layout
# era, since TUMFTM predates the 2020 renovation that reprofiled Turns 3 and 14
# into banked corners. Applying its widths would be applying stale geometry.
#
# Locating the start/finish line only needs to identify one point on a 4+ km lap,
# and the S/F straight did not move in any of these renovations, so a much looser
# fit is sufficient and useful.
MAX_RMSE_M = 8.0  # strict: widths + racing line
MAX_ANCHOR_RMSE_M = 25.0  # tolerant: start/finish anchoring only


def _umeyama_2d(source: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, float, np.ndarray, float]:
    """Least-squares similarity transform mapping source onto target.

    Returns (rotation 2x2, scale, translation 2, rmse). The rotation is forced
    proper (det = +1); reflection is handled by the caller's search so that the
    recovered scale stays interpretable.
    """
    p_mean = source.mean(axis=0)
    q_mean = target.mean(axis=0)
    p = source - p_mean
    q = target - q_mean

    covariance = (p.T @ q) / len(p)
    u, singular, vt = np.linalg.svd(covariance)
    d = np.sign(np.linalg.det(vt.T @ u.T))
    correction = np.diag([1.0, d])
    rotation = vt.T @ correction @ u.T

    variance = float((p**2).sum() / len(p))
    scale = float(np.trace(correction @ np.diag(singular)) / variance) if variance > 0 else 1.0
    translation = q_mean - scale * (rotation @ p_mean)

    fitted = scale * (source @ rotation.T) + translation
    rmse = float(np.sqrt(np.mean(np.sum((fitted - target) ** 2, axis=1))))
    return rotation, scale, translation, rmse


def _resample_ring(points: np.ndarray, count: int) -> np.ndarray:
    """Resample a closed ring to `count` uniform arc-length samples."""
    e, n = resample_linear(points[:, 0], points[:, 1], 1.0, closed=True)
    s = arc_length(e, n, closed=True)
    total = s[-1]
    targets = np.linspace(0.0, total, count, endpoint=False)
    ec = np.append(e, e[0])
    nc = np.append(n, n[0])
    return np.stack([np.interp(targets, s, ec), np.interp(targets, s, nc)], axis=1)


def align_tumftm(
    geo_e: np.ndarray,
    geo_n: np.ndarray,
    tumftm: np.ndarray,
) -> dict | None:
    """Fit TUMFTM's centreline to ours. Returns None if no fit is credible.

    tumftm is the raw [x_m, y_m, w_right_m, w_left_m] array.
    """
    target = _resample_ring(np.stack([geo_e, geo_n], axis=1), ALIGN_SAMPLES)
    source_full = tumftm[:, :2]

    best: dict | None = None
    for reverse in (False, True):
        ordered = source_full[::-1] if reverse else source_full
        for mirror in (False, True):
            candidate = ordered.copy()
            if mirror:
                candidate[:, 1] = -candidate[:, 1]
            resampled = _resample_ring(candidate, ALIGN_SAMPLES)
            for shift in range(ALIGN_SAMPLES):
                rolled = np.roll(resampled, -shift, axis=0)
                rotation, scale, translation, rmse = _umeyama_2d(rolled, target)
                if abs(scale - 1.0) > SCALE_TOLERANCE:
                    continue
                if best is None or rmse < best["rmse"]:
                    best = {
                        "rotation": rotation,
                        "scale": scale,
                        "translation": translation,
                        "rmse": rmse,
                        "reverse": reverse,
                        "mirror": mirror,
                        "shift": shift,
                    }

    if best is None or best["rmse"] > MAX_ANCHOR_RMSE_M:
        return None
    # Good enough to anchor s=0; only a tight fit earns the per-metre data.
    best["widths_ok"] = best["rmse"] <= MAX_RMSE_M
    return best


def start_finish_from_fit(
    geo_e: np.ndarray, geo_n: np.ndarray, tumftm: np.ndarray, fit: dict
) -> tuple[int, float]:
    """Locate the start/finish line on our geometry via TUMFTM's row 0.

    TUMFTM's CSVs are ordered from the start/finish line (the convention for
    racing-line optimisation), which was verified against all three aligned
    circuits: the derived point lands 1.5-2.5 m from our centreline, and with s=0
    set there every expected elevation feature falls where the layout says it
    should — Austin's Turn 1 climb at s 285-675 m (+27.2 m), Interlagos' Senna S
    descent at s 305-565 m, Spa's Eau Rouge low point at s ~1044 m.

    Returns (index on our geometry, residual distance in metres).
    """
    from scipy.spatial import cKDTree

    origin = apply_transform(tumftm[:1, :2], fit)[0]
    tree = cKDTree(np.stack([geo_e, geo_n], axis=1))
    distance, index = tree.query(origin[None, :], k=1)
    return int(index[0]), float(distance[0])


def apply_transform(points: np.ndarray, fit: dict) -> np.ndarray:
    """Map points from the TUMFTM frame into our ENU frame."""
    pts = points.copy()
    if fit["reverse"]:
        pts = pts[::-1]
    if fit["mirror"]:
        pts = pts.copy()
        pts[:, 1] = -pts[:, 1]
    return fit["scale"] * (pts @ fit["rotation"].T) + fit["translation"]


def widths_along(
    geo_e: np.ndarray,
    geo_n: np.ndarray,
    tumftm: np.ndarray,
    fit: dict,
) -> tuple[np.ndarray, np.ndarray]:
    """Nearest-neighbour transfer of TUMFTM half-widths onto our samples.

    Returns (half_width_left_m, half_width_right_m).
    """
    from scipy.spatial import cKDTree

    aligned = apply_transform(tumftm[:, :2], fit)
    right = tumftm[:, 2]
    left = tumftm[:, 3]
    if fit["reverse"]:
        right, left = right[::-1], left[::-1]
    if fit["mirror"]:
        # A mirrored frame swaps which side is which.
        right, left = left, right

    tree = cKDTree(aligned)
    _, idx = tree.query(np.stack([geo_e, geo_n], axis=1), k=1)
    return left[idx], right[idx]
