"""Elevation: DEM sampling, robust filtering, and mapping onto track geometry.

This is where the quality of the whole feature is decided. A raw DEM trace along
a circuit is not usable as-is: it carries tree canopy, grandstand roofs, bridge
decks and per-sample noise, any of which renders as a spike or a strobing
gradient in 3D.

The chain, in order, and why each step is the shape it is:

  fill_nulls      short coverage gaps are interpolated; long ones are a dataset
                  problem, not a filtering problem
  hampel          asymmetric median/MAD despike — kills canopy and roofs
  slope_limit     bidirectional physical gradient cap — kills bridge decks and
                  overpass steps, which the median follows and Hampel misses
  lowpass         Savitzky-Golay order 2 — noise floor without flattening crests
  enforce_closure a safety net, not a stage (see below)
  gradient        SG deriv=1, never np.diff

On closure: it is *almost free* here by construction. The ring from clean.py has
no duplicated endpoint, so s=0 and s=L are literally the same coordinate and the
DEM returns the identical value; and every filter above uses circular padding,
so the output is continuous across s=0 anyway. Drift only appears if a mask or
offset straddles s=0. This is also why the profile is NOT derived by integrating
a gradient array — that design does accumulate drift and would need real
correction.
"""

from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

from .clean import savgol_periodic

# Filter constants. Windows are in samples; the metre equivalents assume the
# DEM query spacing (10 m) for the profile filters.
HAMPEL_WINDOW = 15  # +-70 m
HAMPEL_K_UP = 2.5  # aggressive upward: DSM error from canopy/structures is positive
HAMPEL_K_DOWN = 4.0  # permissive downward: protect real compressions
HAMPEL_MAD_FLOOR_M = 0.25  # flat terrain has MAD ~ 0
PROFILE_SG_WINDOW = 11  # +-50 m
PROFILE_SG_ORDER = 2
GRADIENT_SG_WINDOW = 7  # 30 m baseline at 5 m geometry spacing
GRADIENT_BASELINE_M = 30.0
MAX_GRADIENT = 0.22  # 22%; Raidillon is ~17-18%
MAX_NULL_RUN = 5  # 50 m at 10 m spacing
CLOSURE_WARN_M = 8.0


def fill_nulls(z: np.ndarray, max_run: int = MAX_NULL_RUN) -> tuple[np.ndarray, int, int]:
    """Linearly interpolate NaN runs up to max_run long, periodically.

    Returns (filled, n_filled, longest_run). A run longer than max_run is still
    filled so downstream code sees no NaN, but the caller is expected to treat a
    long run as a reason to retry on another dataset.
    """
    z = np.asarray(z, dtype=float).copy()
    bad = np.isnan(z)
    if not bad.any():
        return z, 0, 0

    # Longest contiguous run, accounting for wrap-around.
    runs, current = [], 0
    for flag in np.concatenate([bad, bad]):  # doubled to catch a wrapped run
        if flag:
            current += 1
        else:
            runs.append(current)
            current = 0
    runs.append(current)
    longest = min(max(runs), int(bad.sum()))

    good = np.where(~bad)[0]
    if len(good) < 2:
        raise ValueError("DEM returned almost no valid samples")
    # Periodic interpolation: extend the good samples one period each way.
    xp = np.concatenate([good - len(z), good, good + len(z)])
    fp = np.concatenate([z[good], z[good], z[good]])
    z[bad] = np.interp(np.where(bad)[0], xp, fp)
    return z, int(bad.sum()), longest


def hampel(
    z: np.ndarray,
    window: int = HAMPEL_WINDOW,
    k_up: float = HAMPEL_K_UP,
    k_down: float = HAMPEL_K_DOWN,
) -> tuple[np.ndarray, np.ndarray]:
    """Asymmetric Hampel identifier. Returns (cleaned, outlier_mask).

    Median/MAD rather than mean/sigma: canopy and building hits are clustered
    multi-sample outliers whose amplitude inflates the mean and sigma enough to
    hide themselves from a z-score test. Median/MAD has a 50% breakdown point.

    KNOWN LIMITATION, and the reason the curation ladder exists: a wall running
    alongside 300 m of track is ~30 consecutive bad samples — a majority of any
    150 m window — so the median *is* the building and this function will
    confidently accept it. Street circuits fail here by construction, not by
    tuning.
    """
    z = np.asarray(z, dtype=float)
    half = window // 2
    padded = np.concatenate([z[-half:], z, z[:half]])
    view = np.lib.stride_tricks.sliding_window_view(padded, window)
    median = np.median(view, axis=1)
    mad = 1.4826 * np.median(np.abs(view - median[:, None]), axis=1)
    mad = np.maximum(mad, HAMPEL_MAD_FLOOR_M)

    residual = z - median
    bad = np.where(residual > 0, residual > k_up * mad, -residual > k_down * mad)
    out = z.copy()
    out[bad] = median[bad]
    return out, bad


def slope_limit(
    z: np.ndarray, spacing_m: float, max_grad: float = MAX_GRADIENT
) -> np.ndarray:
    """Clamp to a physically possible along-track gradient, both directions.

    Catches what Hampel cannot: a sustained *step* rather than a bump — a bridge
    deck or an overpass, where the DEM returns the structure and the rolling
    median follows it. No F1 circuit exceeds ~18% gradient, so a jump beyond 22%
    over one sample is data, not terrain.

    Run forward and backward and average: a single forward pass drags the whole
    downstream profile from the first violation, a directional bias that shows up
    as the back half of the lap sitting metres low.
    """
    cap = max_grad * spacing_m
    forward = np.asarray(z, dtype=float).copy()
    for i in range(1, len(forward)):
        forward[i] = min(max(forward[i], forward[i - 1] - cap), forward[i - 1] + cap)
    backward = np.asarray(z, dtype=float).copy()
    for i in range(len(backward) - 2, -1, -1):
        backward[i] = min(max(backward[i], backward[i + 1] - cap), backward[i + 1] + cap)
    return 0.5 * (forward + backward)


def lowpass(
    z: np.ndarray, window: int = PROFILE_SG_WINDOW, order: int = PROFILE_SG_ORDER
) -> np.ndarray:
    """Savitzky-Golay low-pass along arc length.

    Window sized from both ends: DEM noise is ~1-3 m RMS and averaging 11 samples
    cuts white noise ~3.3x to sub-metre, while the shortest *real* feature that
    matters has a 150-400 m wavelength, comfortably inside a 110 m aperture. A
    quadratic fit is exact on a ramp, so Eau Rouge's ~40 m climb passes with zero
    amplitude loss and only its basal knee rounds over ~100 m.
    """
    return savgol_periodic(z, window, order)


def enforce_closure(
    z: np.ndarray, s: np.ndarray, mode: str = "gradient_weighted"
) -> tuple[np.ndarray, float]:
    """Remove any residual start-to-end elevation drift. Usually a no-op.

    Weighted by cumulative |dz| rather than linearly: a linear detrend spreads
    the correction across long straights, the very places we are most confident
    are flat, whereas the error physically accumulates on the slopes where the
    DEM is noisiest.
    """
    z = np.asarray(z, dtype=float)
    # Drift measured across the wrap, since the ring has no duplicated endpoint.
    drift = float(z[-1] - z[0])
    if abs(drift) < 0.05:
        return z, drift

    dz = np.abs(np.diff(z, prepend=z[0]))
    total = float(dz.sum())
    if mode == "gradient_weighted" and total > 1.0:
        weight = np.cumsum(dz) / total
    else:
        weight = s[: len(z)] / max(s[len(z) - 1], 1e-9)
    return z - drift * weight, drift


def gradient(
    z: np.ndarray, spacing_m: float, window: int = GRADIENT_SG_WINDOW
) -> np.ndarray:
    """Along-track gradient as a fraction (0.07 == 7%), via SG deriv=1.

    Differentiating the fitted polynomial smooths and differentiates in one pass.
    np.diff(z)/spacing amplifies residual noise by the 1/spacing factor and makes
    a dead-flat straight read as +-4% gradient, which the shader would render as
    strobing orange.
    """
    return savgol_periodic(z, window, 2, deriv=1, delta=spacing_m)


def map_profile_to_geometry(
    geom_e: np.ndarray,
    geom_n: np.ndarray,
    dem_e: np.ndarray,
    dem_n: np.ndarray,
    dem_z: np.ndarray,
) -> np.ndarray:
    """Transfer the filtered DEM profile onto the smoothed geometry samples.

    By nearest-point projection, NOT by fractional arc length. The DEM profile
    lives on the raw 10 m polyline; the geometry lives on the smoothed 5 m
    spline, and smoothing changes the path length. Mapping by s/L looks fine and
    is wrong — a 0.5% parameterisation difference is ~35 m of along-track shift
    on Spa, enough to slide Eau Rouge's compression past the corner it belongs
    to.

    Interpolates between the two nearest DEM samples along the DEM polyline so
    the result is smooth rather than stair-stepped at 10 m.
    """
    tree = cKDTree(np.stack([dem_e, dem_n], axis=1))
    query = np.stack([geom_e, geom_n], axis=1)
    # Two nearest DEM samples, then inverse-distance blend between them.
    distances, indices = tree.query(query, k=2)
    weights = 1.0 / np.maximum(distances, 1e-6)
    weights /= weights.sum(axis=1, keepdims=True)
    return np.sum(dem_z[indices] * weights, axis=1)


def summarize(
    z: np.ndarray, grad: np.ndarray, spacing_m: float
) -> dict:
    """Derived elevation statistics for the payload."""
    dz = np.diff(z, append=z[0])  # wrap: closed loop
    return {
        "min_m": float(z.min()),
        "max_m": float(z.max()),
        "total_change_m": float(z.max() - z.min()),
        "cumulative_ascent_m": float(np.clip(dz, 0.0, None).sum()),
        "cumulative_descent_m": float(-np.clip(dz, None, 0.0).sum()),
        "max_gradient_pct": float(grad.max() * 100.0),
        "min_gradient_pct": float(grad.min() * 100.0),
        "gradient_baseline_m": GRADIENT_BASELINE_M,
    }
