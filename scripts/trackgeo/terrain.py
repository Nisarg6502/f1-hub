"""Coarse DEM terrain grid around the circuit.

This is what turns a floating ribbon into the Spa valley, the Austin hill and the
Interlagos bowl. Two things here are easy to get wrong and very visible:

1. The grid MUST use the same DEM dataset as the track. eudem25m sits on the EVRS
   geoid, SRTM on EGM96, NED on NAVD88 — sampling the track from one and the
   terrain from another offsets them by metres, so the ribbon floats above or
   sinks into the ground across the whole scene.

2. The grid must be blended toward the track near the track. Where the DEM saw
   tree canopy or grandstands beside the road, the raw grid sits metres above the
   cleaned track elevation and the ribbon buries itself in a mound.

Grid resolution is 40x40 = 1600 points = 16 API calls per circuit, chosen so that
all 24 circuits fit inside one day's 1000-call budget (64x64 would be 984 calls
for terrain alone and does not fit).
"""

from __future__ import annotations

import numpy as np
from scipy.spatial import cKDTree

TERRAIN_SIDE = 64
TERRAIN_PAD_M = 300.0
BLEND_INNER_M = 20.0
BLEND_OUTER_M = 90.0
# The blended terrain is placed this far BELOW the track surface near the track.
# Without it the two meshes are coplanar and z-fight, which shows up as sections
# of the track ribbon flickering in and out as the camera moves. It is also
# physically truthful: a circuit sits on a graded road bed above the surrounding
# ground, and this clearance is far below the DEM's own vertical accuracy.
BLEND_CLEARANCE_M = 2.5


def grid_points(
    e: np.ndarray, n: np.ndarray, side: int = TERRAIN_SIDE, pad_m: float = TERRAIN_PAD_M
) -> tuple[dict, np.ndarray, np.ndarray]:
    """Build a square-celled grid covering the circuit bbox plus padding.

    Square cells on both axes (spacing taken from the larger span) — an
    anisotropically stretched terrain mesh looks subtly wrong in a way that is
    hard to diagnose later.
    """
    pad = max(pad_m, 0.20 * max(float(np.ptp(e)), float(np.ptp(n))))
    x0, x1 = float(e.min()) - pad, float(e.max()) + pad
    y0, y1 = float(n.min()) - pad, float(n.max()) + pad
    span = max(x1 - x0, y1 - y0)
    spacing = span / (side - 1)

    nx = int(np.ceil((x1 - x0) / spacing)) + 1
    ny = int(np.ceil((y1 - y0) / spacing)) + 1
    xs = x0 + spacing * np.arange(nx)
    ys = y0 + spacing * np.arange(ny)
    mesh_x, mesh_y = np.meshgrid(xs, ys)  # row-major: row = y, col = x

    meta = {
        "origin_e_m": x0,
        "origin_n_m": y0,
        "spacing_m": spacing,
        "nx": nx,
        "ny": ny,
    }
    return meta, mesh_x.ravel(), mesh_y.ravel()


def smooth_grid(z: np.ndarray, nx: int, ny: int, window: int = 5) -> np.ndarray:
    """Separable low-pass over the grid to suppress per-cell DEM noise."""
    grid = z.reshape(ny, nx)
    # Non-periodic data, so savgol_periodic's wrap is wrong here; use a simple
    # edge-padded moving average instead, applied along each axis.
    kernel = np.ones(window) / window
    for axis in (0, 1):
        grid = np.apply_along_axis(
            lambda row: np.convolve(
                np.pad(row, window // 2, mode="edge"), kernel, mode="valid"
            ),
            axis,
            grid,
        )
    return grid.ravel()


def blend_to_track(
    grid_z: np.ndarray,
    grid_e: np.ndarray,
    grid_n: np.ndarray,
    track_e: np.ndarray,
    track_n: np.ndarray,
    track_z: np.ndarray,
    inner_m: float = BLEND_INNER_M,
    outer_m: float = BLEND_OUTER_M,
    clearance_m: float = BLEND_CLEARANCE_M,
) -> np.ndarray:
    """Pull the grid toward the track elevation near the track.

    Cells within inner_m sit `clearance_m` below the track surface; influence
    fades to zero by outer_m with a smoothstep. Two problems are solved at once:
    where the DEM saw canopy or grandstands the raw grid would otherwise sit
    metres above the road and bury the ribbon, and coplanar surfaces z-fight.
    """
    tree = cKDTree(np.stack([track_e, track_n], axis=1))
    distance, idx = tree.query(np.stack([grid_e, grid_n], axis=1), k=1)
    nearest_z = track_z[idx] - clearance_m

    weight = 1.0 - np.clip((distance - inner_m) / (outer_m - inner_m), 0.0, 1.0)
    weight = weight * weight * (3.0 - 2.0 * weight)  # smoothstep
    return grid_z * (1.0 - weight) + nearest_z * weight
