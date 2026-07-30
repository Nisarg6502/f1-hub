"""Local ENU projection about a circuit centroid.

Equirectangular scaling, not UTM. Justification, since "just use pyproj" is the
reflex: the dominant error is that the east scale cos(lat) is evaluated once at
lat0 rather than per point. At Spa (lat 50.44) the north half-extent is ~1.2 km
= 1.88e-4 rad, so the relative east-scale error at the bbox edge is
tan(lat0) * dlat = 1.211 * 1.88e-4 = 2.3e-4. Across the 2.3 km east extent that
is ~0.5 m of differential distortion — and it is a smooth trapezoidal shear of
the whole shape, not per-point noise, so it does not move a corner relative to
its neighbours. Lap-length error is <0.03% (~2 m on 7004 m); heading error is
~0.013 deg. All of that sits an order of magnitude below the +-3-5 m absolute
accuracy of the underlying OSM digitisation.

UTM would buy sub-metre accuracy we cannot use, add a dependency, and introduce
zone-boundary special cases (Spa sits near the 31/32 boundary).

Using the true WGS84 prime-vertical and meridional radii instead of a spherical
R = 6371000 costs one line and removes a further ~0.3% scale error, so there is
no reason not to.
"""

from __future__ import annotations

import math

import numpy as np

A_WGS84 = 6378137.0
E2_WGS84 = 6.69437999014e-3


def enu_scales(lat0_deg: float) -> tuple[float, float]:
    """Return (metres per radian east, metres per radian north) at lat0."""
    sin2 = math.sin(math.radians(lat0_deg)) ** 2
    # Prime vertical radius of curvature (east-west).
    n_rad = A_WGS84 / math.sqrt(1.0 - E2_WGS84 * sin2)
    # Meridional radius of curvature (north-south).
    m_rad = A_WGS84 * (1.0 - E2_WGS84) / (1.0 - E2_WGS84 * sin2) ** 1.5
    return n_rad * math.cos(math.radians(lat0_deg)), m_rad


def to_enu(
    lats: np.ndarray, lons: np.ndarray, lat0: float, lon0: float
) -> tuple[np.ndarray, np.ndarray]:
    """Project WGS84 degrees to local ENU metres about (lat0, lon0).

    Returns (east, north) in metres.
    """
    ke, kn = enu_scales(lat0)
    east = np.radians(np.asarray(lons, dtype=float) - lon0) * ke
    north = np.radians(np.asarray(lats, dtype=float) - lat0) * kn
    return east, north


def to_geo(
    east: np.ndarray, north: np.ndarray, lat0: float, lon0: float
) -> tuple[np.ndarray, np.ndarray]:
    """Inverse of to_enu. Returns (lat, lon) in degrees."""
    ke, kn = enu_scales(lat0)
    lats = lat0 + np.degrees(np.asarray(north, dtype=float) / kn)
    lons = lon0 + np.degrees(np.asarray(east, dtype=float) / ke)
    return lats, lons


def centroid(lats: np.ndarray, lons: np.ndarray) -> tuple[float, float]:
    """Arithmetic mean of the coordinates.

    The mean rather than the bbox centre: it sits closer to the mass of the
    track, which is what makes the distortion bound above symmetric.
    """
    return float(np.mean(lats)), float(np.mean(lons))
