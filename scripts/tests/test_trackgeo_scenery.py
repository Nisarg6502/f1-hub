"""Unit tests for the scenery bake (`trackgeo/scenery.py`).

    python -m unittest discover scripts/tests

Hand-built OSM fixtures, no network. Each test is a rule that decides whether
something appears in the 3D view at all, so a regression here is a building
missing from Monaco or a forest missing from Spa rather than an exception.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from trackgeo import scenery  # noqa: E402
from trackgeo.project import to_geo  # noqa: E402

LAT0, LON0 = 52.0718241, -1.0163502


def payload() -> dict:
    """A 1 km square lap about the origin. Bounds come out at +-(500 + 320) m."""
    side = np.linspace(-500.0, 500.0, 21)
    east = np.concatenate([side, np.full(21, 500.0), side[::-1], np.full(21, -500.0)])
    north = np.concatenate([np.full(21, -500.0), side, np.full(21, 500.0), side[::-1]])
    return {
        "id": "test",
        "origin": {"lat": LAT0, "lon": LON0},
        "e_dm": [int(round(v * 10)) for v in east],
        "n_dm": [int(round(v * 10)) for v in north],
    }


class Osm:
    """Tiny builder: place nodes by ENU metres, get the dicts build_scenery wants."""

    def __init__(self) -> None:
        self.nodes: dict[str, tuple[float, float]] = {}
        self.node_tags: dict[str, dict[str, str]] = {}
        self.ways: dict[str, tuple[list[str], dict[str, str]]] = {}
        self.relations: dict[str, tuple[list[tuple[str, str]], dict[str, str]]] = {}

    def node(self, east: float, north: float, tags: dict[str, str] | None = None) -> str:
        lats, lons = to_geo(np.array([east]), np.array([north]), LAT0, LON0)
        node_id = f"n{len(self.nodes)}"
        self.nodes[node_id] = (float(lats[0]), float(lons[0]))
        if tags:
            self.node_tags[node_id] = tags
        return node_id

    def way(self, points: list[tuple[float, float]], tags: dict[str, str], closed: bool = True) -> str:
        refs = [self.node(e, n) for e, n in points]
        if closed:
            refs.append(refs[0])
        way_id = f"w{len(self.ways)}"
        self.ways[way_id] = (refs, tags)
        return way_id

    def build(self) -> dict:
        return scenery.build_scenery(payload(), self.nodes, self.node_tags, self.ways, self.relations)


def square(cx: float, cy: float, half: float) -> list[tuple[float, float]]:
    return [(cx - half, cy - half), (cx + half, cy - half), (cx + half, cy + half), (cx - half, cy + half)]


class HeightTests(unittest.TestCase):
    def test_explicit_height_wins_and_tolerates_units(self):
        self.assertEqual(scenery.parse_height({"building": "yes", "height": "12.5 m"}), (12.5, "tag"))
        self.assertEqual(scenery.parse_height({"building": "yes", "height": "7,5"}), (7.5, "tag"))

    def test_levels_are_converted(self):
        metres, source = scenery.parse_height({"building": "yes", "building:levels": "3"})
        self.assertEqual(source, "levels")
        self.assertAlmostEqual(metres, 3 * scenery.LEVEL_HEIGHT_M + 1.0)

    def test_unparseable_or_absurd_heights_fall_back_to_a_guess(self):
        # A typo must not put a 1.2 km tower beside the pit lane.
        self.assertEqual(scenery.parse_height({"building": "garage", "height": "1200"}), (3.0, "guess"))
        self.assertEqual(scenery.parse_height({"building": "grandstand", "height": "tall"}), (13.0, "guess"))

    def test_bleachers_count_as_a_stand_even_without_a_building_tag(self):
        tags = {"leisure": "bleachers"}
        self.assertTrue(scenery.is_building(tags))
        self.assertEqual(scenery.parse_height(tags), (9.0, "guess"))

    def test_underground_and_negated_buildings_are_not_extruded(self):
        self.assertFalse(scenery.is_building({"building": "no"}))
        self.assertFalse(scenery.is_building({"building": "yes", "location": "underground"}))
        self.assertFalse(scenery.is_building({"building": "parking", "layer": "-1"}))
        self.assertTrue(scenery.is_building({"building": "yes", "layer": "1"}))


class RingAssemblyTests(unittest.TestCase):
    def test_joins_split_ways_in_any_order_and_direction(self):
        rings = scenery.assemble_rings([["a", "b", "c"], ["e", "d", "c"], ["e", "f", "a"]])
        self.assertEqual(len(rings), 1)
        self.assertEqual(rings[0][0], rings[0][-1])
        self.assertEqual(set(rings[0]), {"a", "b", "c", "d", "e", "f"})
        self.assertEqual(len(rings[0]), 7)

    def test_keeps_separate_rings_separate(self):
        rings = scenery.assemble_rings([["a", "b", "c", "a"], ["x", "y"], ["y", "z", "x"]])
        self.assertEqual(sorted(len(r) for r in rings), [4, 4])

    def test_drops_a_chain_that_never_closes(self):
        # The relation runs off the edge of the download: nothing to fill.
        self.assertEqual(scenery.assemble_rings([["a", "b"], ["b", "c"]]), [])


class SimplifyTests(unittest.TestCase):
    def test_removes_collinear_points_and_keeps_corners(self):
        east = np.array([0.0, 5.0, 10.0, 10.0, 10.0, 0.0])
        north = np.array([0.0, 0.0, 0.0, 5.0, 10.0, 10.0])
        e, n = scenery.simplify_ring(east, north, 0.15)
        self.assertEqual(len(e), 4)
        self.assertAlmostEqual(abs(scenery.ring_area(e, n)), 100.0)

    def test_a_ring_never_collapses(self):
        theta = np.linspace(0, 2 * np.pi, 40, endpoint=False)
        e, n = scenery.simplify_ring(30 * np.cos(theta), 30 * np.sin(theta), 2.5)
        self.assertGreaterEqual(len(e), 6)
        self.assertGreater(abs(scenery.ring_area(e, n)), 0.9 * np.pi * 900)


class BuildSceneryTests(unittest.TestCase):
    def test_bounds_contain_the_whole_lap_with_margin(self):
        bounds = scenery.scenery_bounds(payload())
        self.assertLessEqual(bounds["e_min_m"], -500 - scenery.MARGIN_MIN_M)
        self.assertGreaterEqual(bounds["n_max_m"], 500 + scenery.MARGIN_MIN_M)

    def test_building_inside_is_kept_in_the_track_frame(self):
        osm = Osm()
        osm.way(square(100, -200, 10), {"building": "grandstand"})
        result = osm.build()
        self.assertEqual(len(result["buildings"]), 1)
        building = result["buildings"][0]
        self.assertEqual(building["kind"], "grandstand")
        self.assertEqual(building["h_dm"], 130)
        east = building["ring_dm"][0::2]
        north = building["ring_dm"][1::2]
        # Decimetres about the payload origin, to within the quantisation.
        self.assertAlmostEqual(min(east) / 10, 90, delta=0.2)
        self.assertAlmostEqual(max(north) / 10, -190, delta=0.2)
        self.assertEqual(result["height_provenance"], {"tag": 0, "levels": 0, "guess": 1})

    def test_building_straddling_the_edge_is_dropped_whole(self):
        osm = Osm()
        osm.way(square(820, 0, 15), {"building": "yes"})  # bounds end at +820
        self.assertEqual(osm.build()["buildings"], [])

    def test_slivers_are_dropped(self):
        osm = Osm()
        osm.way(square(0, 0, 1), {"building": "yes"})  # 4 m2
        self.assertEqual(osm.build()["buildings"], [])

    def test_multipolygon_building_keeps_its_courtyard_and_is_not_doubled(self):
        osm = Osm()
        outer = osm.way(square(0, 0, 40), {})
        inner = osm.way(square(0, 0, 15), {})
        osm.relations["r1"] = ([(outer, "outer"), (inner, "inner")], {"type": "multipolygon", "building": "stadium"})
        result = osm.build()
        self.assertEqual(len(result["buildings"]), 1)
        self.assertEqual(len(result["buildings"][0]["holes_dm"]), 1)

    def test_a_forest_far_bigger_than_the_circuit_still_counts(self):
        # No vertex of this wood is inside the bounds, yet it covers all of them.
        osm = Osm()
        osm.way(square(0, 0, 5000), {"natural": "wood"})
        self.assertEqual(len(osm.build()["woods_dm"]), 1)

    def test_a_wood_split_across_ways_is_stitched_and_keeps_its_clearing(self):
        osm = Osm()
        a, b, c, d = (osm.node(-300, -300), osm.node(300, -300), osm.node(300, 300), osm.node(-300, 300))
        osm.ways["south"] = ([a, b, c], {})
        osm.ways["north"] = ([a, d, c], {})
        clearing = osm.way(square(0, 0, 50), {})
        osm.relations["r1"] = (
            [("south", "outer"), ("north", "outer"), (clearing, "inner")],
            {"type": "multipolygon", "landuse": "forest"},
        )
        result = osm.build()
        self.assertEqual(len(result["woods_dm"]), 1)
        self.assertEqual(len(result["wood_holes_dm"]), 1)

    def test_only_trees_inside_the_bounds_are_kept(self):
        osm = Osm()
        osm.node(10, 10, {"natural": "tree"})
        osm.node(5000, 10, {"natural": "tree"})
        osm.node(20, 20, {"amenity": "bench"})
        self.assertEqual(len(osm.build()["trees_dm"]), 2)

    def test_imagery_pin_is_carried_through(self):
        result = scenery.build_scenery(payload(), {}, {}, {}, {}, imagery=(64001, "2026-02-26"))
        self.assertEqual((result["imagery_release"], result["imagery_date"]), (64001, "2026-02-26"))
        self.assertIsNone(Osm().build()["imagery_release"])


if __name__ == "__main__":
    unittest.main()
