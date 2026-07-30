"""Centreline cleaning: dedupe, close, resample, smooth, orient.

Empirical notes from auditing all 40 features in bacinger/f1-circuits, because
several of these choices only make sense against the real data:

- Every circuit is already a clean closed ring: the closure gap |P_last - P_0| is
  0.0 m for all 40. So closure detection is a cheap assertion, not a repair.
- No circuit carries an appended pit lane. Four features (de-1927, mc-1929,
  nl-1948, pt-2008) have 1-2 stray points after the closure index, which is
  digitisation noise and gets trimmed. There is no pit-lane geometry in this
  source at all.
- Point spacing is *extremely* uneven — Spa's median step is 21 m but its max is
  377 m, an 18:1 ratio, because long straights are single segments while corners
  are densely digitised. This is why the resampler is centripetal Catmull-Rom:
  uniform parameterisation on knots this uneven produces cusps and
  self-intersections exactly at the tight corners that matter most.
- properties.altitude is NOT trustworthy (br-1977/Interlagos reports 3 m against
  a true ~760 m; br-1940 reports 765 m — the two Brazil entries have swapped
  values). Absolute elevation comes from the DEM, never from here.
"""

from __future__ import annotations

import numpy as np
from scipy.signal import savgol_filter

CLOSURE_EPS_M = 20.0
MIN_TAIL_LENGTH_M = 120.0
MAX_CLOSURE_GAP_M = 200.0
MIN_DEDUPE_STEP_M = 1.0
CLOSURE_ARC_GUARD_M = 1000.0


def shoelace_area(e: np.ndarray, n: np.ndarray) -> float:
    """Signed area of the closed ring. Positive means counter-clockwise in ENU."""
    return 0.5 * float(np.sum(e * np.roll(n, -1) - np.roll(e, -1) * n))


def arc_length(e: np.ndarray, n: np.ndarray, closed: bool = False) -> np.ndarray:
    """Cumulative arc length, starting at 0. Length is len(e) (+1 if closed)."""
    de, dn = np.diff(e), np.diff(n)
    steps = np.hypot(de, dn)
    if closed:
        steps = np.append(steps, np.hypot(e[0] - e[-1], n[0] - n[-1]))
    return np.concatenate([[0.0], np.cumsum(steps)])


def dedupe(
    e: np.ndarray, n: np.ndarray, min_step_m: float = MIN_DEDUPE_STEP_M
) -> tuple[np.ndarray, np.ndarray]:
    """Drop points closer than min_step_m to their predecessor."""
    keep = [0]
    for i in range(1, len(e)):
        if np.hypot(e[i] - e[keep[-1]], n[i] - n[keep[-1]]) >= min_step_m:
            keep.append(i)
    idx = np.asarray(keep, dtype=int)
    return e[idx], n[idx]


def close_ring(e: np.ndarray, n: np.ndarray) -> tuple[np.ndarray, np.ndarray, dict]:
    """Trim to a closed ring with no duplicated endpoint.

    Finds the first index past CLOSURE_ARC_GUARD_M of arc length that returns
    within CLOSURE_EPS_M of the start. Anything after it is either digitisation
    noise (short — dropped) or an appended polyline (long — reported, so it is
    never silently discarded, though no circuit in the current source has one).

    Returns (e, n, diagnostics). The returned ring excludes the duplicate
    closing point: index 0 and the implicit wrap are the same location, which is
    what makes the elevation profile continuous across s=0 for free.
    """
    s = arc_length(e, n)
    d0 = np.hypot(e - e[0], n - n[0])
    candidates = np.where((d0 < CLOSURE_EPS_M) & (s > CLOSURE_ARC_GUARD_M))[0]

    if len(candidates) == 0:
        gap = float(d0[-1])
        if gap > MAX_CLOSURE_GAP_M:
            raise ValueError(
                f"polyline does not close: gap {gap:.0f} m exceeds "
                f"{MAX_CLOSURE_GAP_M:.0f} m. Refusing to stitch a phantom straight "
                "across the circuit."
            )
        return e, n, {"closure_gap_m": gap, "trimmed_points": 0, "tail_length_m": 0.0}

    # Take the *nearest* point in the first contiguous run of candidates, not the
    # first one. CLOSURE_EPS_M (20 m) is larger than the point spacing on most
    # circuits (medians run 12-38 m), so several trailing points qualify and
    # picking the first would trim one or two legitimate samples off the ring.
    run_end = 0
    while run_end + 1 < len(candidates) and candidates[run_end + 1] == candidates[run_end] + 1:
        run_end += 1
    first_run = candidates[: run_end + 1]
    j = int(first_run[int(np.argmin(d0[first_run]))])

    tail_len = float(s[-1] - s[j])
    trimmed = len(e) - j - 1
    diagnostics = {
        "closure_gap_m": float(d0[j]),
        "trimmed_points": trimmed,
        "tail_length_m": tail_len,
    }
    if tail_len >= MIN_TAIL_LENGTH_M:
        # No circuit in the current source hits this, but if one ever does we
        # want it in the report rather than silently thrown away.
        diagnostics["tail_kept_for_review"] = True
    # Drop the closing duplicate at j as well as anything past it.
    return e[:j], n[:j], diagnostics


# --------------------------------------------------------------------------
# Resampling
# --------------------------------------------------------------------------


def resample_linear(
    e: np.ndarray, n: np.ndarray, spacing_m: float, closed: bool = True
) -> tuple[np.ndarray, np.ndarray]:
    """Uniform resample by straight-line interpolation along the polyline.

    Used for the DEM query set, and deliberately dumb: it depends only on the
    source geometry and the spacing, never on a smoothing parameter, so the DEM
    cache survives every bit of downstream tuning.
    """
    ec = np.append(e, e[0]) if closed else e
    nc = np.append(n, n[0]) if closed else n
    s = arc_length(ec, nc)
    total = float(s[-1])
    count = max(2, int(round(total / spacing_m)))
    targets = np.linspace(0.0, total, count, endpoint=not closed)
    return np.interp(targets, s, ec), np.interp(targets, s, nc)


def _catmull_rom_dense(
    e: np.ndarray, n: np.ndarray, alpha: float = 0.5, per_segment: int = 24
) -> tuple[np.ndarray, np.ndarray]:
    """Densely evaluate a closed centripetal Catmull-Rom spline through the points.

    Implemented as a cubic Hermite spline on centripetal knots (t_i spaced by
    |dP|^alpha), which is the standard formulation. alpha=0.5 is centripetal and
    is provably free of cusps and self-intersections; alpha=0 (uniform) is not,
    and fails on exactly this data's 18:1 spacing spread.
    """
    count = len(e)
    points = np.stack([e, n], axis=1)

    # Centripetal knots over the wrapped ring.
    steps = np.hypot(*(np.roll(points, -1, axis=0) - points).T)
    dt = np.power(np.maximum(steps, 1e-9), alpha)

    out_e: list[np.ndarray] = []
    out_n: list[np.ndarray] = []
    u = np.linspace(0.0, 1.0, per_segment, endpoint=False)
    h00 = 2 * u**3 - 3 * u**2 + 1
    h10 = u**3 - 2 * u**2 + u
    h01 = -2 * u**3 + 3 * u**2
    h11 = u**3 - u**2

    for i in range(count):
        i_prev, i_next, i_next2 = (i - 1) % count, (i + 1) % count, (i + 2) % count
        p1, p2 = points[i], points[i_next]
        # Tangents on non-uniform knots: central difference divided by the
        # spanned parameter interval.
        m1 = (points[i_next] - points[i_prev]) / (dt[i_prev] + dt[i])
        m2 = (points[i_next2] - points[i]) / (dt[i] + dt[i_next])
        h = dt[i]
        seg = (
            h00[:, None] * p1
            + h10[:, None] * (h * m1)
            + h01[:, None] * p2
            + h11[:, None] * (h * m2)
        )
        out_e.append(seg[:, 0])
        out_n.append(seg[:, 1])

    return np.concatenate(out_e), np.concatenate(out_n)


def resample_catmull_rom(
    e: np.ndarray, n: np.ndarray, spacing_m: float, alpha: float = 0.5
) -> tuple[np.ndarray, np.ndarray]:
    """Resample a closed ring to uniform arc-length spacing via a smooth spline."""
    dense_e, dense_n = _catmull_rom_dense(e, n, alpha=alpha)
    return resample_linear(dense_e, dense_n, spacing_m, closed=True)


def savgol_periodic(
    y: np.ndarray, window: int, order: int = 2, deriv: int = 0, delta: float = 1.0
) -> np.ndarray:
    """Savitzky-Golay filter with wrap-around padding, for closed-loop data.

    Order 2 by default: a circular arc is locally quadratic to second order, so
    a quadratic fit is unbiased on curvature to leading order. A moving average
    biases radius by ~w^2/(8R), which on a 10 m hairpin is a ~15 m error.

    With deriv=1 this differentiates the fitted polynomial, which is the right
    way to get gradient — np.diff amplifies residual noise by the 1/delta factor
    and makes a flat straight read as +-4% gradient.
    """
    window = int(window)
    if window % 2 == 0:
        window += 1
    if window <= order or len(y) < window:
        return np.gradient(y, delta) if deriv == 1 else np.asarray(y, dtype=float)
    return savgol_filter(
        np.asarray(y, dtype=float),
        window_length=window,
        polyorder=order,
        deriv=deriv,
        delta=delta,
        mode="wrap",
    )


def smooth_plan(
    e: np.ndarray, n: np.ndarray, window: int = 7, order: int = 2
) -> tuple[np.ndarray, np.ndarray]:
    """Low-pass the plan shape to remove OSM lateral jitter (~1-3 m)."""
    return (
        savgol_periodic(e, window, order),
        savgol_periodic(n, window, order),
    )


# --------------------------------------------------------------------------
# Orientation
# --------------------------------------------------------------------------


def normalize_start_and_direction(
    e: np.ndarray,
    n: np.ndarray,
    sf_e: float,
    sf_n: float,
    want_ccw: bool,
) -> tuple[np.ndarray, np.ndarray, dict]:
    """Roll index 0 onto the start/finish line and fix the winding direction.

    This is the failure that ships silently. bacinger's LineString starts
    wherever the OSM way starts — not the start/finish line — and its winding is
    not necessarily the racing direction. Skip this and nothing crashes: every
    highlight's arc-length range is offset by an arbitrary amount, uProgress
    draws the track from a random point, and a flythrough runs backwards down
    the hill.

    Direction is decided by the shoelace sign against one curated boolean, which
    is what makes it hand-verifiable against a track map in seconds.
    """
    k = int(np.argmin((e - sf_e) ** 2 + (n - sf_n) ** 2))
    sf_distance = float(np.hypot(e[k] - sf_e, n[k] - sf_n))
    e, n = np.roll(e, -k), np.roll(n, -k)

    area = shoelace_area(e, n)
    reversed_ = (area > 0) != want_ccw
    if reversed_:
        # Reverse, then roll by 1 so index 0 stays on the start/finish line
        # (reversing an array sends index 0 to the end).
        e, n = e[::-1].copy(), n[::-1].copy()
        e, n = np.roll(e, 1), np.roll(n, 1)

    return e, n, {
        "start_index": k,
        "sf_distance_m": sf_distance,
        "reversed": bool(reversed_),
        "signed_area_m2": area,
    }
