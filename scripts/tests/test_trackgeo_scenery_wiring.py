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
import build_track_geometry as geometry  # noqa: E402
from test_trackgeo_cloud import FakeCollection  # noqa: E402

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


class _ExplodingSink(storage.PayloadSink):
    """A destination that cannot be written: a bucket without permission, a full disk."""

    def write(self, payload: dict) -> str:
        raise PermissionError("403 storage.objects.create denied")

    def describe(self) -> str:
        return "exploding"


class TestSceneryNeverFailsTheBuild(unittest.TestCase):
    """bake_scenery() is the one place a scenery error is allowed to stop."""

    CONTRACT = {
        "circuit_id",
        "status",
        "phase",
        "progress_pct",
        "message",
        "started_at",
        "updated_at",
        "error",
    }

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = pathlib.Path(self._tmp.name)
        self.sink = storage.resolve_sink(storage.scenery_destination(str(self.tmp)))
        self.collection = FakeCollection()
        self.progress = storage.BuildProgress("monaco", self.collection)
        self.progress.start()

    def doc(self) -> dict:
        return self.collection.docs["monaco"]

    def bake(self, sink=None) -> tuple[str | None, str]:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
            result = geometry.bake_scenery(
                "monaco", track_payload("monaco"), sink or self.sink, self.progress
            )
        return result, stderr.getvalue()

    def test_an_osm_outage_is_logged_and_the_build_still_finishes_done(self):
        boom = RuntimeError("OSM API kept failing for bbox 7.4,43.7,7.5,43.8")
        with mock.patch.object(scenery_cli, "fetch_osm", side_effect=boom):
            result, stderr = self.bake()
        self.assertIsNone(result)
        self.assertIn("scenery FAILED", stderr)
        self.assertIn("OSM API kept failing", stderr)
        # Not failed: still running, with no error recorded against the build.
        self.assertEqual(self.doc()["status"], "running")
        self.assertIsNone(self.doc()["error"])
        self.progress.done()
        self.assertEqual(self.doc()["status"], "done")
        self.assertEqual(self.doc()["progress_pct"], 100)
        self.assertIsNone(self.doc()["error"])

    def test_a_destination_that_cannot_be_written_is_survivable_too(self):
        with mock.patch.object(scenery_cli, "fetch_osm", return_value=[osm_document()]):
            result, stderr = self.bake(sink=_ExplodingSink())
        self.assertIsNone(result)
        self.assertIn("scenery FAILED", stderr)

    def test_success_returns_where_it_was_written(self):
        with mock.patch.object(scenery_cli, "fetch_osm", return_value=[osm_document()]):
            result, stderr = self.bake()
        self.assertEqual(pathlib.Path(result), self.tmp / "scenery" / "monaco.json")
        self.assertEqual(stderr, "")

    def test_the_phase_is_reported_for_a_person_and_adds_no_field(self):
        with mock.patch.object(scenery_cli, "fetch_osm", return_value=[osm_document()]):
            self.bake()
        doc = dict(self.doc())
        doc.pop("_id")
        self.assertEqual(set(doc), self.CONTRACT)
        self.assertEqual(doc["phase"], "Adding scenery")
        self.assertEqual(doc["message"], "Adding buildings and trees…")
        self.assertEqual(doc["progress_pct"], 94)

    def test_the_bake_is_given_a_deadline_inside_the_time_budget(self):
        fetch = mock.Mock(return_value=[osm_document()])
        before = time.monotonic()
        with mock.patch.object(scenery_cli, "fetch_osm", fetch):
            self.bake()
        deadline = fetch.call_args.kwargs["deadline"]
        self.assertGreater(deadline, before)
        self.assertLessEqual(deadline, time.monotonic() + geometry.SCENERY_TIME_BUDGET_S)

    def test_the_budget_leaves_room_inside_the_job_timeout(self):
        """The job is created with --task-timeout 30m; see scripts/README.md."""
        self.assertLessEqual(geometry.SCENERY_TIME_BUDGET_S, 600)


class TestBuildWritesScenery(unittest.TestCase):
    """main() end to end, with the geometry build and the OSM fetch stubbed."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = pathlib.Path(self._tmp.name)

    def run_main(self, fetch, *extra: str) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            # A self-hosted base URL makes the Budget unlimited, so no quota
            # store (file or Mongo) is touched.
            stack.enter_context(
                mock.patch.dict(os.environ, {"OPENTOPODATA_BASE_URL": "http://localhost:5000"})
            )
            stack.enter_context(mock.patch.object(geometry, "fetch_circuit_index", return_value={}))
            stack.enter_context(
                mock.patch.object(geometry, "build_circuit", return_value=(track_payload("spa"), {}))
            )
            stack.enter_context(mock.patch.object(scenery_cli, "fetch_osm", fetch))
            stack.enter_context(contextlib.redirect_stdout(stdout))
            stack.enter_context(contextlib.redirect_stderr(stderr))
            code = geometry.main(["--only", "spa", "--no-progress", "--out", str(self.tmp), *extra])
        return code, stdout.getvalue(), stderr.getvalue()

    def test_a_build_writes_the_track_and_its_scenery(self):
        code, stdout, _ = self.run_main(mock.Mock(return_value=[osm_document()]))
        self.assertEqual(code, 0)
        self.assertTrue((self.tmp / "spa.json").exists())
        scenery = json.loads((self.tmp / "scenery" / "spa.json").read_text(encoding="utf-8"))
        self.assertEqual(scenery["id"], "spa")
        self.assertEqual(len(scenery["buildings"]), 1)
        self.assertIn("scenery", stdout)

    def test_a_scenery_failure_leaves_the_build_successful(self):
        fetch = mock.Mock(side_effect=RuntimeError("OSM API kept failing"))
        code, _, stderr = self.run_main(fetch)
        self.assertEqual(code, 0)
        self.assertTrue((self.tmp / "spa.json").exists())
        self.assertFalse((self.tmp / "scenery" / "spa.json").exists())
        self.assertIn("scenery FAILED", stderr)

    def test_no_scenery_flag_skips_the_bake(self):
        fetch = mock.Mock(return_value=[osm_document()])
        code, _, _ = self.run_main(fetch, "--no-scenery")
        self.assertEqual(code, 0)
        self.assertTrue((self.tmp / "spa.json").exists())
        self.assertFalse((self.tmp / "scenery").exists())
        fetch.assert_not_called()

    def test_no_write_bakes_nothing(self):
        fetch = mock.Mock(return_value=[osm_document()])
        code, _, _ = self.run_main(fetch, "--no-write")
        self.assertEqual(code, 0)
        self.assertFalse((self.tmp / "spa.json").exists())
        self.assertFalse((self.tmp / "scenery").exists())
        fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
