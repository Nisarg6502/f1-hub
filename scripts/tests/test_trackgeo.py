"""Unit tests for the track-geometry pipeline.

Run from the repo root:

    python -m unittest discover scripts/tests

Follows the backend's convention: plain unittest, hand-built fixtures, no
network. Every test here targets a failure mode that actually bit during
development, or one that would ship silently.
"""

from __future__ import annotations

import pathlib
import sys
import unittest

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from trackgeo import align, clean, elevation as elev  # noqa: E402
from trackgeo.project import centroid, enu_scales, to_enu, to_geo  # noqa: E402


def circle(radius: float, count: int, ccw: bool = True) -> tuple[np.ndarray, np.ndarray]:
    theta = np.linspace(0.0, 2.0 * np.pi, count, endpoint=False)
    if not ccw:
        theta = -theta
    return radius * np.cos(theta), radius * np.sin(theta)


class TestProjection(unittest.TestCase):
    def test_round_trip_is_sub_millimetre(self):
        lats = np.array([50.4370, 50.4400, 50.4450])
        lons = np.array([5.9650, 5.9700, 5.9750])
        lat0, lon0 = centroid(lats, lons)
        e, n = to_enu(lats, lons, lat0, lon0)
        rlat, rlon = to_geo(e, n, lat0, lon0)
        np.testing.assert_allclose(rlat, lats, atol=1e-9)
        np.testing.assert_allclose(rlon, lons, atol=1e-9)

    def test_scales_shrink_east_with_latitude(self):
        ke_equator, _ = enu_scales(0.0)
        ke_spa, _ = enu_scales(50.44)
        self.assertGreater(ke_equator, ke_spa)
        # Close to cos(lat) but NOT equal to it: the prime vertical radius grows
        # with latitude on an ellipsoid, so the ratio is N(lat)/a * cos(lat),
        # about 0.2% above the spherical value. That 0.2% is exactly the error
        # using a spherical R would introduce.
        spherical = np.cos(np.radians(50.44))
        self.assertAlmostEqual(ke_spa / ke_equator, spherical, places=2)
        self.assertGreater(ke_spa / ke_equator, spherical)

    def test_known_distance(self):
        """One degree of latitude is ~111 km."""
        lats = np.array([0.0, 1.0])
        lons = np.array([0.0, 0.0])
        e, n = to_enu(lats, lons, 0.0, 0.0)
        self.assertAlmostEqual(float(n[1]), 110574.0, delta=200.0)


class TestCleaning(unittest.TestCase):
    def test_shoelace_sign_detects_winding(self):
        e, n = circle(100.0, 64, ccw=True)
        self.assertGreater(clean.shoelace_area(e, n), 0.0)
        e, n = circle(100.0, 64, ccw=False)
        self.assertLess(clean.shoelace_area(e, n), 0.0)

    def test_dedupe_drops_near_duplicates(self):
        e = np.array([0.0, 0.1, 5.0, 5.05, 10.0])
        n = np.zeros(5)
        de, dn = clean.dedupe(e, n, min_step_m=1.0)
        self.assertEqual(len(de), 3)

    def test_close_ring_trims_stray_tail(self):
        """The real defect shape: 1-2 stray points after the ring closes.

        Four features in the source carry these (de-1927, mc-1929, nl-1948,
        pt-2008); they must be trimmed, not treated as a pit lane.
        """
        e, n = circle(300.0, 200)
        e = np.append(e, [e[0], e[0] + 3.0])
        n = np.append(n, [n[0], n[0] + 3.0])
        ce, cn, diag = clean.close_ring(e, n)
        self.assertEqual(len(ce), 200)
        self.assertGreaterEqual(diag["trimmed_points"], 1)
        self.assertLess(diag["tail_length_m"], clean.MIN_TAIL_LENGTH_M)

    def test_close_ring_refuses_a_huge_gap(self):
        """Never stitch a phantom straight across a circuit."""
        e = np.linspace(0.0, 3000.0, 200)
        n = np.zeros(200)
        with self.assertRaises(ValueError):
            clean.close_ring(e, n)

    def test_resample_gives_uniform_arc_length(self):
        """The payload's implicit s_i = i * spacing depends on this exactly.

        Note the invariant holds in ARC length, not chord length — chords are
        legitimately shorter through a corner.
        """
        e, n = circle(500.0, 90)
        re, rn = clean.resample_linear(e, n, 5.0, closed=True)
        s = clean.arc_length(re, rn, closed=True)
        spacing = s[-1] / len(re)
        # Uniform to within a few millimetres. Not exact, because these are the
        # CHORDS of the output polyline while the parameterisation is uniform in
        # arc length along the input — the two differ slightly wherever the path
        # curves. Millimetres are irrelevant against ~3-5 m source accuracy.
        np.testing.assert_allclose(np.diff(s), spacing, atol=0.01)

    def test_catmull_rom_preserves_a_circle(self):
        """Centripetal Catmull-Rom must not shrink or distort a known shape."""
        e, n = circle(400.0, 40)
        re, rn = clean.resample_catmull_rom(e, n, 5.0)
        radii = np.hypot(re, rn)
        self.assertAlmostEqual(float(radii.mean()), 400.0, delta=1.0)
        self.assertLess(float(radii.std()), 0.5)

    def test_catmull_rom_survives_very_uneven_spacing(self):
        """The real data has an 18:1 spread between median and max step.

        Uniform parameterisation produces cusps here; centripetal must not.
        """
        theta = np.concatenate([
            np.linspace(0.0, np.pi, 40),          # densely digitised half
            np.linspace(np.pi, 2 * np.pi, 5)[1:],  # sparsely digitised half
        ])
        e, n = 300.0 * np.cos(theta), 300.0 * np.sin(theta)
        re, rn = clean.resample_catmull_rom(e, n, 5.0)
        self.assertTrue(np.all(np.isfinite(re)))
        # No cusp: consecutive heading changes stay modest.
        heading = np.unwrap(np.arctan2(np.diff(rn), np.diff(re)))
        self.assertLess(float(np.abs(np.diff(heading)).max()), 0.5)

    def test_normalize_start_rolls_to_the_seed(self):
        e, n = circle(200.0, 120, ccw=True)
        target = 30
        re, rn, diag = clean.normalize_start_and_direction(
            e, n, float(e[target]), float(n[target]), want_ccw=True
        )
        self.assertEqual(diag["start_index"], target)
        self.assertAlmostEqual(float(re[0]), float(e[target]), places=6)
        self.assertFalse(diag["reversed"])

    def test_normalize_reverses_wrong_winding(self):
        """The silent failure: a reversed lap runs flythroughs backwards."""
        e, n = circle(200.0, 120, ccw=True)
        re, rn, diag = clean.normalize_start_and_direction(
            e, n, float(e[0]), float(n[0]), want_ccw=False
        )
        self.assertTrue(diag["reversed"])
        self.assertLess(clean.shoelace_area(re, rn), 0.0)
        # Index 0 must still sit on the seed after the flip.
        self.assertAlmostEqual(float(re[0]), float(e[0]), places=6)


class TestElevation(unittest.TestCase):
    def test_despike_removes_a_spike_but_keeps_a_ramp(self):
        """The test that matters: a 40 m spike is noise, a 40 m ramp is Eau Rouge."""
        base = np.concatenate([
            np.zeros(60),
            np.linspace(0.0, 40.0, 60),   # a genuine 40 m climb
            np.full(60, 40.0),
            np.linspace(40.0, 0.0, 60),
        ])
        spiked = base.copy()
        spiked[15] += 40.0  # canopy hit
        cleaned, mask = elev.hampel(spiked)
        self.assertTrue(bool(mask[15]))
        self.assertLess(abs(float(cleaned[15]) - 0.0), 2.0)
        # The ramp survives with its amplitude intact.
        self.assertAlmostEqual(float(cleaned.max() - cleaned.min()), 40.0, delta=1.5)
        self.assertLess(int(mask.sum()), 6)

    def test_despike_is_asymmetric(self):
        """DSM error from canopy/structures is positive, so be permissive down.

        The baseline must carry real variation. On perfectly flat synthetic data
        the MAD collapses to zero, the 0.25 m floor takes over, and *both*
        thresholds become tiny — so the asymmetry only shows up where MAD is
        meaningful, which is everywhere in real terrain.

        Rather than pick one amplitude near the threshold (MAD over a 15-sample
        window is too noisy for that to be stable), find the smallest excursion
        that trips the detector in each direction and compare them. The ratio
        should track k_down / k_up = 4.0 / 2.5 = 1.6.
        """
        base = np.linspace(0.0, 20.0, 240)  # a gentle, deterministic climb
        target = 120

        def threshold(sign: int) -> float | None:
            for amplitude in np.arange(0.25, 12.0, 0.25):
                probe = base.copy()
                probe[target] = base[target] + sign * amplitude
                _, mask = elev.hampel(probe)
                if bool(mask[target]):
                    return float(amplitude)
            return None

        up_threshold = threshold(+1)
        down_threshold = threshold(-1)
        self.assertIsNotNone(up_threshold)
        self.assertIsNotNone(down_threshold)
        self.assertGreater(
            down_threshold,
            up_threshold * 1.3,
            f"a downward excursion should need a bigger amplitude to be despiked "
            f"(up {up_threshold}, down {down_threshold})",
        )

    def test_slope_limit_clamps_a_bridge_step(self):
        z = np.zeros(100)
        z[50:] += 9.0  # an overpass deck: 9 m in one 10 m sample
        limited = elev.slope_limit(z, 10.0, max_grad=0.22)
        self.assertLess(float(np.abs(np.diff(limited)).max()), 2.3)

    def test_slope_limit_is_symmetric(self):
        """A one-directional pass drags the whole downstream profile."""
        z = np.zeros(100)
        z[50:] += 9.0
        limited = elev.slope_limit(z, 10.0)
        # The correction stays local rather than biasing either end.
        self.assertAlmostEqual(float(limited[:20].mean()), 0.0, delta=0.6)
        self.assertAlmostEqual(float(limited[80:].mean()), 9.0, delta=0.6)

    def test_closure_removes_drift_exactly(self):
        s = np.linspace(0.0, 1000.0, 201)
        z = np.linspace(0.0, 6.0, 201)  # 6 m of pure drift
        closed, drift = elev.enforce_closure(z, s)
        self.assertAlmostEqual(drift, 6.0, places=6)
        self.assertAlmostEqual(float(closed[-1] - closed[0]), 0.0, places=6)

    def test_closure_leaves_flat_straights_flat(self):
        """Gradient-weighted, not linear: the fix belongs on the slopes."""
        s = np.linspace(0.0, 2000.0, 401)
        z = np.concatenate([np.zeros(200), np.linspace(0.0, 4.0, 201)])
        closed, _ = elev.enforce_closure(z, s)
        np.testing.assert_allclose(closed[:180], 0.0, atol=1e-9)

    def test_gradient_does_not_amplify_noise(self):
        """np.diff would render a flat straight as strobing orange."""
        rng = np.random.default_rng(7)
        z = rng.normal(0.0, 0.4, 400)  # flat, noisy
        grad = elev.gradient(z, 5.0)
        naive = np.diff(z, append=z[0]) / 5.0
        self.assertLess(float(np.abs(grad).max()), float(np.abs(naive).max()))
        self.assertLess(float(np.abs(grad).max()), 0.10)

    def test_fill_nulls_interpolates_short_runs(self):
        z = np.linspace(0.0, 100.0, 101)
        z[50:53] = np.nan
        filled, count, longest = elev.fill_nulls(z)
        self.assertEqual(count, 3)
        self.assertEqual(longest, 3)
        self.assertFalse(bool(np.isnan(filled).any()))
        np.testing.assert_allclose(filled[50:53], [50.0, 51.0, 52.0], atol=1e-6)

    def test_map_profile_uses_position_not_fraction(self):
        """Mapping by s/L slides features ~35 m along the lap at Spa."""
        e, n = circle(500.0, 300)
        z = np.where(np.arange(300) < 150, 0.0, 20.0).astype(float)
        ge, gn = circle(500.0, 600)
        mapped = elev.map_profile_to_geometry(ge, gn, e, n, z)
        self.assertLess(abs(float(mapped[10]) - 0.0), 1.0)
        self.assertLess(abs(float(mapped[400]) - 20.0), 1.0)


class TestAlign(unittest.TestCase):
    def _fit_recovers(self, rotation_deg, scale, reverse, mirror):
        e, n = circle(400.0, 240)
        # Build a "TUMFTM" copy in an arbitrary frame.
        pts = np.stack([e, n], axis=1)
        if mirror:
            pts = pts * np.array([1.0, -1.0])
        if reverse:
            pts = pts[::-1]
        pts = np.roll(pts, 57, axis=0)
        theta = np.radians(rotation_deg)
        rot = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])
        moved = scale * (pts @ rot.T) + np.array([1234.0, -567.0])
        source = np.column_stack([moved, np.full(len(moved), 5.0), np.full(len(moved), 5.0)])
        fit = align.align_tumftm(e, n, source)
        self.assertIsNotNone(fit, "expected a fit to be found")
        self.assertLess(fit["rmse"], 2.0)
        back = align.apply_transform(source[:, :2], fit)
        # Every transformed point should land on the target ring.
        self.assertLess(float(np.abs(np.hypot(back[:, 0], back[:, 1]) - 400.0).max()), 3.0)

    def test_recovers_rotation_and_shift(self):
        self._fit_recovers(37.0, 1.0, reverse=False, mirror=False)

    def test_recovers_reversed_traversal(self):
        self._fit_recovers(-120.0, 1.0, reverse=True, mirror=False)

    def test_recovers_mirrored_frame(self):
        self._fit_recovers(15.0, 1.0, reverse=False, mirror=True)

    def test_rejects_a_different_shape(self):
        """A wrong-layout dataset must not pass the per-metre gate.

        This is the Zandvoort case: TUMFTM predates the 2020 banking renovation,
        fits at 11.3 m RMSE, and its widths must be refused.
        """
        e, n = circle(400.0, 240)
        se, sn = circle(400.0, 240)
        se = se + 40.0 * np.sin(np.linspace(0.0, 6.0 * np.pi, 240))  # deform it
        source = np.column_stack([se, sn, np.full(240, 5.0), np.full(240, 5.0)])
        fit = align.align_tumftm(e, n, source)
        if fit is not None:
            self.assertFalse(fit["widths_ok"], "deformed shape must fail the strict gate")


if __name__ == "__main__":
    unittest.main(verbosity=2)
