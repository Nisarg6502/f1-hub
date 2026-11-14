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
import build_track_scenery as scenery_cli  # noqa: E402

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


class TestBake(unittest.TestCase):
    """bake() is what the job calls: an in-memory payload in, a written file out."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = pathlib.Path(self._tmp.name)
        self.sink = storage.resolve_sink(storage.scenery_destination(str(self.tmp)))

    def test_writes_scenery_beside_the_track_payload(self):
        with mock.patch.object(scenery_cli, "fetch_osm", return_value=[osm_document()]):
            location = scenery_cli.bake("test", track_payload(), self.sink, log=lambda line: None)
        target = self.tmp / "scenery" / "test.json"
        self.assertEqual(pathlib.Path(location), target)
        written = json.loads(target.read_text(encoding="utf-8"))
        self.assertEqual(written["id"], "test")
        self.assertEqual(written["origin"], {"lat": LAT0, "lon": LON0})
        self.assertEqual(len(written["buildings"]), 1)
        self.assertEqual(written["buildings"][0]["kind"], "grandstand")

    def test_an_osm_failure_propagates_and_writes_nothing(self):
        """bake() raises; deciding that a failure is survivable is the caller's job."""
        boom = RuntimeError("OSM API kept failing")
        with mock.patch.object(scenery_cli, "fetch_osm", side_effect=boom):
            with self.assertRaises(RuntimeError):
                scenery_cli.bake("test", track_payload(), self.sink, log=lambda line: None)
        self.assertFalse((self.tmp / "scenery" / "test.json").exists())

    def test_the_deadline_reaches_the_fetch(self):
        fetch = mock.Mock(return_value=[osm_document()])
        with mock.patch.object(scenery_cli, "fetch_osm", fetch):
            scenery_cli.bake("test", track_payload(), self.sink, log=lambda line: None, deadline=123.0)
        self.assertEqual(fetch.call_args.kwargs["deadline"], 123.0)


class TestFetchDeadline(unittest.TestCase):
    """A slow OSM API must not be able to run the job into its task timeout."""

    BOX = (-1.02, 52.07, -1.01, 52.08)

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        tmp = pathlib.Path(self._tmp.name)
        patcher = mock.patch.object(scenery_cli, "cache_dir", lambda *parts: tmp)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_spent_deadline_raises_before_any_request(self):
        with mock.patch.object(scenery_cli.urllib.request, "urlopen") as urlopen:
            with self.assertRaises(scenery_cli.SceneryDeadline):
                scenery_cli.fetch_osm(*self.BOX, deadline=time.monotonic() - 1.0)
        urlopen.assert_not_called()

    def test_a_cached_box_is_free_even_after_the_deadline(self):
        scenery_cli.osm_cache_path(*self.BOX).write_bytes(b"<osm/>")
        with mock.patch.object(scenery_cli.urllib.request, "urlopen") as urlopen:
            documents = scenery_cli.fetch_osm(*self.BOX, deadline=time.monotonic() - 1.0)
        self.assertEqual(documents, [b"<osm/>"])
        urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
