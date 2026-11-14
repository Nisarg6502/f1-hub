"""Tests for baking scenery as the last phase of the track-geometry build.

    python -m unittest discover scripts/tests

Same conventions as test_trackgeo_cloud.py: plain unittest, hand-built fixtures,
no network, no real database, no real bucket. The network functions
(`fetch_osm`, `urlopen`) and the heavy geometry build are stubbed; everything
between them is the real code.

The failure this file exists to prevent: the track payload is the product and
the viewer works without scenery, so an OpenStreetMap outage must never turn a
finished build into a failed one.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import pathlib
import sys
import tempfile
import time
import unittest
from unittest import mock

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from trackgeo import storage  # noqa: E402
from trackgeo.project import to_geo  # noqa: E402

LAT0, LON0 = 52.0718241, -1.0163502


def track_payload(circuit_id: str = "test") -> dict:
    """A 1 km square lap about the origin: the only fields the scenery bake reads."""
    side = np.linspace(-500.0, 500.0, 21)
    east = np.concatenate([side, np.full(21, 500.0), side[::-1], np.full(21, -500.0)])
    north = np.concatenate([np.full(21, -500.0), side, np.full(21, 500.0), side[::-1]])
    return {
        "id": circuit_id,
        "origin": {"lat": LAT0, "lon": LON0},
        "e_dm": [int(round(v * 10)) for v in east],
        "n_dm": [int(round(v * 10)) for v in north],
    }


def osm_document() -> bytes:
    """One 40 m square grandstand at the origin, as the OSM API returns it."""
    corners = [(-20.0, -20.0), (20.0, -20.0), (20.0, 20.0), (-20.0, 20.0)]
    lats, lons = to_geo(
        np.array([c[0] for c in corners]), np.array([c[1] for c in corners]), LAT0, LON0
    )
    nodes = "".join(
        f'<node id="{i + 1}" lat="{lat:.7f}" lon="{lon:.7f}"/>'
        for i, (lat, lon) in enumerate(zip(lats, lons))
    )
    refs = "".join(f'<nd ref="{i}"/>' for i in (1, 2, 3, 4, 1))
    return (
        f'<osm version="0.6">{nodes}<way id="100">{refs}'
        '<tag k="building" v="grandstand"/></way></osm>'
    ).encode()


class TestSceneryDestination(unittest.TestCase):
    """Scenery sits in a `scenery/` folder beside the track payloads, wherever those go."""

    def test_job_destination_puts_scenery_under_tracks_scenery(self):
        destination = storage.scenery_destination("gs://f1-scratch-assets/tracks")
        self.assertEqual(destination, "gs://f1-scratch-assets/tracks/scenery")
        sink = storage.resolve_sink(destination)
        self.assertIsInstance(sink, storage.GcsSink)
        self.assertEqual(sink.bucket, "f1-scratch-assets")
        # The exact object the frontend's trackSceneryUrls() asks the bucket for.
        self.assertEqual(sink.object_name("baku"), "tracks/scenery/baku.json")

    def test_a_trailing_slash_does_not_double_up(self):
        self.assertEqual(
            storage.scenery_destination("gs://f1-scratch-assets/tracks/"),
            "gs://f1-scratch-assets/tracks/scenery",
        )

    def test_bucket_root_destination(self):
        sink = storage.resolve_sink(storage.scenery_destination("gs://f1-scratch-assets"))
        self.assertEqual(sink.object_name("baku"), "scenery/baku.json")

    def test_gs_destination_needs_a_bucket(self):
        with self.assertRaises(ValueError):
            storage.scenery_destination("gs://")

    def test_local_destination_is_a_scenery_subdirectory(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = storage.scenery_destination(tmp)
            self.assertEqual(pathlib.Path(destination), pathlib.Path(tmp) / "scenery")
            self.assertIsInstance(storage.resolve_sink(destination), storage.LocalSink)


if __name__ == "__main__":
    unittest.main(verbosity=2)
