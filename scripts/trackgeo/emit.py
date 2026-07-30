"""Quantise geometry into the compact JSON the viewer loads.

Design notes:

- Flat integer arrays, not arrays of objects. `n` is implicit from array length
  and `s_i = i * sample_spacing_m` is implicit from the exact uniform resampling,
  so no arc-length array ships at all.

- Field names are e_dm / n_dm / u_dm, deliberately NOT x/y/z: in ENU "y" is
  north, in three.js "y" is up, and that collision is a guaranteed bug. The
  ENU -> world mapping lives in exactly one place on the client.

- No delta encoding and no base64. Delta encoding would cut raw size roughly in
  half but the post-gzip gap is a few KB, bought at the price of a decode loop
  and a payload nobody can read in devtools. The compression is not the
  constraint; readability is worth more.

- curv_e4 ships rather than being derived client-side: the builder has the
  properly-smoothed polyline and one consistent algorithm, whereas deriving
  curvature from 5 m samples in the browser amplifies residual noise and makes
  corner-marker placement jitter between reloads.
"""

from __future__ import annotations

import json
import pathlib

import numpy as np

PAYLOAD_VERSION = 1


def _dm(values: np.ndarray) -> list[int]:
    """Quantise metres to decimetres as plain ints."""
    return np.rint(np.asarray(values, dtype=float) * 10.0).astype(int).tolist()


def _e4(values: np.ndarray) -> list[int]:
    return np.rint(np.asarray(values, dtype=float) * 1e4).astype(int).tolist()


def _ddeg(values: np.ndarray) -> list[int]:
    return np.rint(np.asarray(values, dtype=float) * 10.0).astype(int).tolist()


def build_payload(
    *,
    spec,
    e: np.ndarray,
    n: np.ndarray,
    z: np.ndarray,
    curvature: np.ndarray,
    gradient: np.ndarray,
    half_width_l: np.ndarray | None,
    half_width_r: np.ndarray | None,
    bank_deg: np.ndarray | None,
    raceline: np.ndarray | None,
    terrain: dict | None,
    spacing_m: float,
    length_m: float,
    z_ref_m: float,
    origin: tuple[float, float],
    elevation_stats: dict,
    highlights: list[dict],
    segments: list[dict],
    diagnostics: dict,
    sources: dict,
) -> dict:
    payload: dict = {
        "version": PAYLOAD_VERSION,
        "id": spec.key,
        "ergast_circuit_id": spec.ergast_circuit_id,
        "geojson_id": spec.bacinger_id,
        "name": spec.display_name,
        "country": spec.country,
        "locality": spec.locality,
        "length_m": round(length_m, 1),
        "length_m_published": spec.published_length_m,
        "sample_spacing_m": round(spacing_m, 4),
        "closed": True,
        "origin": {"lat": round(origin[0], 7), "lon": round(origin[1], 7)},
        "z_ref_m": round(z_ref_m, 2),
        "e_dm": _dm(e),
        "n_dm": _dm(n),
        "u_dm": _dm(z - z_ref_m),
        # Gradient ships rather than being derived on the client. u_dm is
        # quantised to 0.1 m over a 5 m spacing, so a client-side difference would
        # step in 2% increments — far too coarse to colour a surface smoothly, and
        # it would need re-smoothing anyway. Shipping it also guarantees the
        # viewer shows exactly the gradient this pipeline validated, over the
        # documented 30 m baseline.
        "grade_e4": _e4(gradient),
        "curv_e4": _e4(curvature),
        "half_width_dm_const": int(round(spec.half_width_m * 10)),
        "half_width_dm_l": _dm(half_width_l) if half_width_l is not None else None,
        "half_width_dm_r": _dm(half_width_r) if half_width_r is not None else None,
        "bank_ddeg": _ddeg(bank_deg) if bank_deg is not None else None,
        "raceline": (
            {"e_dm": _dm(raceline[:, 0]), "n_dm": _dm(raceline[:, 1])}
            if raceline is not None
            else None
        ),
        "terrain": terrain,
        "elevation": elevation_stats,
        "corners": [
            {"s_m": round(s_m, 1), "name": name} for s_m, name in spec.corner_names
        ],
        "highlights": highlights,
        "segments": segments,
        "diagnostics": diagnostics,
        "sources": sources,
        "notes": spec.notes,
    }
    return payload


def write_payload(payload: dict, out_dir: pathlib.Path) -> pathlib.Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{payload['id']}.json"
    # separators without spaces: this is machine-read, and it saves ~15%.
    path.write_text(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def terrain_payload(meta: dict, z: np.ndarray, z_ref_m: float) -> dict:
    """Terrain grid quantised against the same z_ref_m as the track."""
    return {
        "origin_e_m": round(meta["origin_e_m"], 2),
        "origin_n_m": round(meta["origin_n_m"], 2),
        "spacing_m": round(meta["spacing_m"], 3),
        "nx": int(meta["nx"]),
        "ny": int(meta["ny"]),
        "u_dm": _dm(np.asarray(z, dtype=float) - z_ref_m),
    }
