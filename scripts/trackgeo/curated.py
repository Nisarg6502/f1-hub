"""Hand-curated per-circuit data, kept separate so it stays diffable.

Everything here is either (a) not derivable from the sources, or (b) a
validation expectation used to catch silent failures.

On start/finish coordinates: bacinger's f1-locations.json carries only
3-decimal venue-centring points (~100 m, intended for map zoom), so a
hand-guessed sf_lat / sf_lon is worth roughly 50-150 m — and was measured at
185 m out on Spa, which put s=0 nearly a kilometre from the real line and
silently mislabelled every highlight. **Nothing below is hand-guessed.** Every
sf_lat / sf_lon is derived, by fitting a ring whose row 0 is known to be the
start/finish line onto our own centreline (align.align_tumftm) and reading back
the lat/lon of the nearest sample. Two such rings exist:

  1. TUMFTM/racetrack-database's track CSV, ordered from the start/finish line
     in the racing direction. Covers 15 of the 22 circuits here.
  2. FastF1's fastest-lap position telemetry, whose row 0 is the start/finish
     crossing and whose row order is likewise the racing direction. Covers every
     circuit that has actually been raced, which is what fills the 6 street
     circuits TUMFTM has never included.

Route 2 was validated against route 1 before being trusted: on Spa the two
independently derived S/F points are 30 m apart and on the Hungaroring 15 m
apart, both an order of magnitude better than the hand-guessed coordinate that
motivated all of this and far inside snap_corner_names' 130 m tolerance. The
residual is just position-telemetry sampling — a 220 ms sample at 300 km/h is
18 m of track. Both fits recover scale 1.000-1.001 at 3-6 m RMSE, the RMSE being
the racing line's offset from the centreline rather than a bad match.

The one circuit where neither route exists is Madrid (`madring`): it is new for
2026 and has never been raced, so there is no telemetry, no TUMFTM entry and no
OSM raceway way. See its spec for what was done instead.

Winding direction (want_ccw) is likewise derived rather than recalled: the same
two rings are ordered in the racing direction, so transforming one into our ENU
frame *while preserving its original row order* and taking the shoelace sign
gives the racing direction directly. All four original circuits reproduce (Spa
CW, Austin CCW, Interlagos CCW, Zandvoort CW), which is what earns the method
trust for the other 18.

**bacinger's own winding matches the racing direction on 20 of 21 circuits — and
Singapore is the one that does not.** Its LineString winds clockwise while
Marina Bay is raced anti-clockwise. That single counterexample is the entire
justification for want_ccw existing as an explicit curated boolean instead of
being inferred from the source, and it is why the Madrid entry (where the rule
is all there is) is flagged as unverified rather than quietly assumed correct.

On `key`: it is deliberately identical to `ergast_circuit_id` for every spec.
The payload filename, the frontend's circuit lookup and Batch 16's
`/api/track_geometry/*` contract all key off the Ergast circuitId, so any spec
whose key diverged from it would build fine and then be unreachable from the app.

On published elevation change: left None almost everywhere on purpose. A
marketing scalar that cannot be traced to the circuit's own published figures is
not a validation input, and inventing one would poison `published_ratio` — the
one number in the payload whose whole job is to disagree honestly with the
measurement (see Austin). Zandvoort already set this precedent.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Highlight:
    """A named elevation set piece.

    expect_dz_m is a validation range, not a source of data — rise and gradient
    are always measured. A negative measured value where a positive is expected
    means want_ccw is inverted; a right magnitude at the wrong place means the
    S/F coordinate is off. One assert, both bugs caught.
    """

    id: str
    name: str
    kind: str  # climb | descent | compression | crest | banking
    expect_s_m: float | None  # approximate arc length from S/F, or None
    expect_dz_m: tuple[float, float] | None
    # Physical length of the feature, in metres. The measurement searches windows
    # of roughly this length rather than taking the whole monotone run — without
    # it, Eau Rouge gets lumped together with the entire Kemmel climb and reports
    # +64.8 m at a diluted 5.8% instead of the steep ~40 m core.
    expect_len_m: float = 350.0
    blurb: str = ""
    search_window_m: float = 400.0


@dataclass(frozen=True)
class CircuitSpec:
    key: str  # our own stable key, also the JSON filename
    ergast_circuit_id: str  # joins to race.Circuit.circuitId in the app
    bacinger_id: str
    display_name: str
    country: str
    locality: str
    sf_lat: float
    sf_lon: float
    want_ccw: bool
    dem_dataset: str
    dem_fallbacks: tuple[str, ...] = ("srtm30m", "mapzen")
    tumftm_name: str | None = None
    half_width_m: float = 6.0
    published_length_m: float | None = None
    published_elevation_change_m: float | None = None
    published_source: str = ""
    # Ratio between the largest and smallest total elevation change reported by
    # the candidate DEM datasets, when they were compared by hand. A wide spread
    # means the terrain is near the datasets' noise floor and no single answer is
    # authoritative, so it caps confidence. Left None where not measured.
    dataset_spread_ratio: float | None = None
    # Banking is below DEM resolution (a 25 m pixel cannot resolve camber across
    # a 15 m road), so it is curated and labelled as such in the payload.
    banking_ranges: tuple[tuple[float, float, float], ...] = ()
    highlights: tuple[Highlight, ...] = ()
    want_terrain: bool = True
    notes: str = ""
    # (approximate arc length from S/F, name). Snapped to the nearest detected
    # curvature apex at build time, so the label lands on real geometry and a
    # wrong guess fails loudly rather than sitting on a straight. Positions were
    # read off the detected layout, not recalled — only corners that are both
    # famous and unambiguous in the geometry are named, because a confidently
    # mislabelled corner is worse than an unlabelled one.
    corner_names: tuple[tuple[float, str], ...] = ()


SPECS: tuple[CircuitSpec, ...] = (
    CircuitSpec(
        key="spa",
        ergast_circuit_id="spa",
        bacinger_id="be-1925",
        display_name="Circuit de Spa-Francorchamps",
        country="Belgium",
        locality="Spa",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 2.4 m.
        sf_lat=50.44312,
        sf_lon=5.96603,
        want_ccw=False,
        dem_dataset="eudem25m",
        tumftm_name="Spa",
        published_length_m=7004.0,
        published_elevation_change_m=102.2,
        published_source="circuit",
        highlights=(
            Highlight(
                id="eau-rouge",
                name="Eau Rouge / Raidillon",
                kind="climb",
                # The lap descends 40 m from the line to the Eau Rouge compression
                # at s ~1044 m, then climbs 64.8 m all the way to Les Combes. The
                # Raidillon itself is the steep first third of that climb.
                expect_s_m=1250.0,
                expect_dz_m=(28.0, 50.0),
                expect_len_m=380.0,
                search_window_m=800.0,
                blurb=(
                    "The corner a 2D map cannot show you. The track drops into a "
                    "compression at Eau Rouge, then climbs the Raidillon in a "
                    "blind left-right-left — flat out, uphill, with no sight of "
                    "the exit."
                ),
            ),
            Highlight(
                id="les-combes-descent",
                name="Les Combes to Stavelot",
                kind="descent",
                # Measured at -72.7 m over 850 m (-8.6%). This is the whole
                # descent, which is the more striking feature than isolating
                # Pouhon alone — the circuit gives back two thirds of its total
                # elevation range in one continuous run.
                expect_s_m=3650.0,
                expect_dz_m=(-85.0, -45.0),
                expect_len_m=800.0,
                search_window_m=1000.0,
                blurb=(
                    "From the high point at Les Combes the circuit gives back "
                    "everything it climbed — a long, sustained downhill run to the "
                    "lowest point on the lap."
                ),
            ),
            Highlight(
                id="kemmel-climb",
                name="Raidillon to Les Combes",
                kind="climb",
                # The full monotone climb, for contrast with the steep core above.
                expect_s_m=1600.0,
                expect_dz_m=(45.0, 75.0),
                expect_len_m=1100.0,
                search_window_m=1400.0,
                blurb=(
                    "The whole climb, end to end: 65 m of altitude gained between "
                    "the bottom of Eau Rouge and the crest at Les Combes."
                ),
            ),
        ),
        # Read off the detected apexes: La Source is the 12 m hairpin at s~385,
        # the Bus Stop is the 14 m chicane at s~6742, and Eau Rouge/Raidillon is
        # the L-R-L at s~1050-1274 that opens the big climb.
        corner_names=(
            (385.0, "La Source"),
            (1050.0, "Eau Rouge"),
            (1274.0, "Raidillon"),
            (2424.0, "Les Combes"),
            (3274.0, "Rivage"),
            (3788.0, "Pouhon"),
            (4483.0, "Fagnes"),
            (4923.0, "Stavelot"),
            (5943.0, "Blanchimont"),
            (6742.0, "Bus Stop"),
        ),
        notes="Validated: 107.2 m measured against 102.2 m published (ratio 1.05).",
    ),
    CircuitSpec(
        key="americas",
        ergast_circuit_id="americas",
        bacinger_id="us-2012",
        display_name="Circuit of the Americas",
        country="USA",
        locality="Austin",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 1.5 m.
        sf_lat=30.13356,
        sf_lon=-97.64231,
        want_ccw=True,
        dem_dataset="ned10m",  # 10 m bare-earth lidar; see notes
        tumftm_name="Austin",
        published_length_m=5514.0,
        published_elevation_change_m=41.0,
        published_source="circuit",
        highlights=(
            Highlight(
                id="turn-1-climb",
                name="Turn 1 climb",
                kind="climb",
                # Measured at +27.2 m over s 285-675 m (7.0%), and the global
                # elevation maximum sits at s ~350 m, right after the start.
                expect_s_m=480.0,
                expect_dz_m=(18.0, 42.0),
                expect_len_m=390.0,
                search_window_m=700.0,
                blurb=(
                    "A blind uphill braking zone. The run to Turn 1 climbs hard "
                    "enough that drivers cannot see the apex until they are "
                    "committed to the corner."
                ),
            ),
            Highlight(
                id="esses-descent",
                name="Descent through the esses",
                kind="descent",
                expect_s_m=825.0,
                expect_dz_m=(-28.0, -8.0),
                expect_len_m=300.0,
                search_window_m=600.0,
                blurb=(
                    "Everything gained at Turn 1 is given straight back, dropping "
                    "away through the fast esses that follow."
                ),
            ),
        ),
        # Only Turn 1 is named: it is the 13 m uphill left at s~665, unambiguous
        # in the geometry and corroborated by the Turn 1 climb highlight ending
        # at s=675. COTA's remaining corners are mostly unnamed in common usage
        # and its numbering does not map cleanly onto detected apexes.
        corner_names=((665.0, "Turn 1"),),
        notes=(
            "ned10m (10 m bare-earth lidar) measures 30.9 m; the 30 m DSM products "
            "report 36-37 m because they include the Turn 1 grandstands and tower. "
            "The bare-earth figure is the racing surface, so it is kept despite "
            "disagreeing with the published 41 m."
        ),
    ),
    CircuitSpec(
        key="interlagos",
        ergast_circuit_id="interlagos",
        # NOT br-1977 — that is Jacarepagua (Nelson Piquet), 5031 m at sea level.
        # Interlagos opened 1940, is 4309 m, and sits at ~765 m ASL.
        bacinger_id="br-1940",
        display_name="Autódromo José Carlos Pace",
        country="Brazil",
        locality="São Paulo",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 2.5 m.
        sf_lat=-23.70344,
        sf_lon=-46.69999,
        want_ccw=True,
        dem_dataset="srtm30m",
        tumftm_name="SaoPaulo",
        published_length_m=4309.0,
        published_elevation_change_m=43.0,
        published_source="circuit",
        highlights=(
            Highlight(
                id="senna-s",
                name="Senna S descent",
                kind="descent",
                # Measured at -13.1 m over s 305-565 m; the global elevation
                # maximum is at s ~180 m, so the lap starts near its high point.
                expect_s_m=435.0,
                expect_dz_m=(-25.0, -5.0),
                expect_len_m=260.0,
                search_window_m=600.0,
                blurb=(
                    "The track falls away downhill through the Senna S into the "
                    "lowest point of the circuit — you brake, turn and drop all at "
                    "once."
                ),
            ),
            Highlight(
                id="subida",
                name="Subida dos Boxes",
                kind="climb",
                # Measured at +22.4 m over s 3385-3715 m (6.8%).
                expect_s_m=3550.0,
                expect_dz_m=(10.0, 32.0),
                expect_len_m=330.0,
                search_window_m=800.0,
                blurb=(
                    "The climb back out of the bowl to the finish line — a long, "
                    "full-throttle uphill drag that decides whether a slipstream "
                    "becomes an overtake."
                ),
            ),
        ),
        # Senna S is the left-right at s~345-455 opening the lap; Juncao is the
        # tight left at s~3245 that begins the climb back to the line — which the
        # Subida highlight independently places starting at s=3165.
        corner_names=(
            (345.0, "Senna S"),
            (580.0, "Curva do Sol"),
            (1420.0, "Descida do Lago"),
            (2755.0, "Bico de Pato"),
            (3245.0, "Junção"),
        ),
        notes="Validated: 43.5 m measured against 43 m published (ratio 1.01).",
    ),
    CircuitSpec(
        key="zandvoort",
        ergast_circuit_id="zandvoort",
        bacinger_id="nl-1948",
        display_name="Circuit Zandvoort",
        country="Netherlands",
        locality="Zandvoort",
        # Curated: the pit straight before Tarzanbocht.
        sf_lat=52.3888,
        sf_lon=4.5409,
        want_ccw=False,
        dem_dataset="eudem25m",
        tumftm_name="Zandvoort",
        published_length_m=4259.0,
        published_elevation_change_m=None,  # not verified — do not invent one
        published_source="",
        # eudem25m 5.1 m vs srtm30m/mapzen 8.8 m vs aster30m 12.5 m.
        dataset_spread_ratio=12.5 / 5.1,
        # Zandvoort's story is camber, not gross elevation. Both banked corners
        # are ~18 degrees; ranges are in metres from the S/F line and get a
        # smoothstep ramp in and out.
        banking_ranges=(
            (620.0, 760.0, 18.0),  # Hugenholtzbocht
            (3950.0, 4120.0, 18.0),  # Arie Luyendykbocht
        ),
        highlights=(
            Highlight(
                id="hugenholtz",
                name="Hugenholtzbocht",
                kind="banking",
                expect_s_m=690.0,
                expect_dz_m=None,
                search_window_m=300.0,
                blurb=(
                    "A banked corner steep enough to drive two cars side by side "
                    "through it. The camber is curated from published figures — a "
                    "25 m elevation grid cannot resolve camber across a 15 m road."
                ),
            ),
        ),
        # Tarzanbocht is the 30 m banked right at s~360 closing the pit straight;
        # Hugenholtzbocht is the wide banked left at s~610, which the banking
        # range and the detected highlight both independently place there.
        corner_names=(
            (360.0, "Tarzanbocht"),
            (610.0, "Hugenholtzbocht"),
            (3925.0, "Arie Luyendykbocht"),
        ),
        want_terrain=True,
        notes=(
            "Weakest of the four for gross elevation: eudem25m measures 5.1 m while "
            "srtm30m/mapzen report 8.8 m and aster30m 12.5 m — a 2.5x spread, so "
            "confidence is capped at medium. eudem25m is kept as the cleanest "
            "(0% outliers). The banking is the real story here."
        ),
    ),
    # ----------------------------------------------------------------------
    # CP55 — the remaining calendar.
    #
    # Curation depth is deliberately uneven. Six circuits (Monaco, Red Bull
    # Ring, Suzuka, Silverstone, Monza, Hungaroring) carry corner names and
    # highlight windows; the other twelve carry geometry and elevation only.
    # A circuit with no curated extras still renders correctly — it simply has
    # no corner markers and no highlight cards — whereas a confidently
    # mislabelled corner is a factual error shown to the user. Where a circuit
    # has no corner names in common usage (Hungaroring) or no named elevation
    # feature (Silverstone, Monza — both effectively flat), the corresponding
    # field is left empty rather than padded.
    #
    # Corner arc lengths are NOT recalled. They are FastF1's official corner
    # `Distance` values (metres from the start/finish line), rescaled by
    # our_centreline_length / reference_lap_length because FastF1 measures along
    # a driven racing line that is 0.5-1% shorter than the centreline. Names are
    # then attached to those official corner *numbers*, and every one is
    # re-checked offline against detect_corners' apexes (radius and direction)
    # before shipping — that check costs no API quota, because corner snapping
    # depends on plan curvature only and never touches the DEM.
    # ----------------------------------------------------------------------
    CircuitSpec(
        key="albert_park",
        ergast_circuit_id="albert_park",
        bacinger_id="au-1953",
        display_name="Albert Park Circuit",
        country="Australia",
        locality="Melbourne",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 3.4 m.
        sf_lat=-37.85008,
        sf_lon=144.96904,
        want_ccw=False,
        dem_dataset="srtm30m",
        tumftm_name="Melbourne",
        published_length_m=5278.0,
        notes=(
            "TUMFTM fits at 10.3 m RMSE — over the 8 m gate, so its widths are "
            "refused and the fit is used for start/finish anchoring only. Same "
            "cause as Zandvoort: TUMFTM predates the 2022 reprofiling that "
            "removed the old Turn 9/10 chicane and widened several corners."
        ),
    ),
    CircuitSpec(
        key="baku",
        ergast_circuit_id="baku",
        bacinger_id="az-2016",
        display_name="Baku City Circuit",
        country="Azerbaijan",
        locality="Baku",
        # Derived from FastF1 fastest-lap telemetry (row 0 == start/finish),
        # residual 3.0 m, fit RMSE 5.8 m at scale 1.0011. No TUMFTM entry.
        sf_lat=40.37229,
        sf_lon=49.85200,
        want_ccw=True,
        # Azerbaijan is outside EU-DEM's EEA39 footprint, so srtm30m despite
        # being geographically European.
        dem_dataset="srtm30m",
        published_length_m=6003.0,
        notes=(
            "Street circuit: a 30 m DEM pixel over the old city samples the "
            "castle-section buildings rather than the road surface, so the "
            "elevation profile is expected to grade low. No highlights are "
            "curated for it — see scripts/README.md."
        ),
    ),
    CircuitSpec(
        key="catalunya",
        ergast_circuit_id="catalunya",
        bacinger_id="es-1991",
        display_name="Circuit de Barcelona-Catalunya",
        country="Spain",
        locality="Barcelona",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 1.3 m.
        sf_lat=41.57098,
        sf_lon=2.26203,
        want_ccw=False,
        dem_dataset="eudem25m",
        tumftm_name="Catalunya",
        published_length_m=4657.0,
        notes=(
            "TUMFTM fits at 11.3 m RMSE, over the widths gate: it carries the "
            "2007-2022 layout with the final chicane, which was removed for 2023. "
            "Anchoring only."
        ),
    ),
    CircuitSpec(
        key="hungaroring",
        ergast_circuit_id="hungaroring",
        bacinger_id="hu-1986",
        display_name="Hungaroring",
        country="Hungary",
        locality="Budapest",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 2.6 m.
        sf_lat=47.57872,
        sf_lon=19.24875,
        want_ccw=False,
        dem_dataset="eudem25m",
        tumftm_name="Budapest",
        published_length_m=4381.0,
        highlights=(
            Highlight(
                id="turn-1-descent",
                name="Downhill to Turn 1",
                kind="descent",
                # The Hungaroring is cut into a shallow valley and the pit
                # straight falls away into the Turn 1 braking zone. expect_dz_m
                # is wide on purpose: the *sign* is what is being asserted, and
                # a run that turned out to be uphill would produce a best
                # "descent" window of a metre or two and fail loudly.
                expect_s_m=400.0,
                expect_dz_m=(4.0, 40.0),
                expect_len_m=450.0,
                search_window_m=900.0,
                blurb=(
                    "The lap starts by falling away. The main straight runs "
                    "downhill into the Turn 1 braking zone, at the bottom of the "
                    "shallow valley the whole circuit is cut into."
                ),
            ),
        ),
        # No corner_names: the Hungaroring genuinely has no named corners in
        # common usage. Numbering them T1..T14 would add nothing the geometry
        # does not already show, so nothing is curated rather than padding the
        # table with labels no commentator uses.
        notes=(
            "Fully curated for highlights, deliberately not for corner names — "
            "the circuit has no named corners."
        ),
    ),
    CircuitSpec(
        key="losail",
        ergast_circuit_id="losail",
        bacinger_id="qa-2004",
        display_name="Lusail International Circuit",
        country="Qatar",
        locality="Lusail",
        # Derived from FastF1 fastest-lap telemetry, residual 2.4 m, fit RMSE
        # 3.2 m at scale 0.9994 — the cleanest of the six telemetry fits. No
        # TUMFTM entry.
        sf_lat=25.48706,
        sf_lon=51.45090,
        want_ccw=False,
        dem_dataset="srtm30m",
        published_length_m=5419.0,
        notes="Desert circuit, essentially flat; srtm30m is the only option here.",
    ),
    CircuitSpec(
        key="madring",
        ergast_circuit_id="madring",
        bacinger_id="es-2026",
        display_name="Madring",
        country="Spain",
        locality="Madrid",
        # THE ONE UNVERIFIED ENTRY IN THIS FILE. Madrid is new for 2026 and has
        # never been raced, so there is no FastF1 telemetry, no TUMFTM CSV and
        # no OSM raceway way to derive anything from. This is not a hand-guessed
        # coordinate either: it is Jolpica/Ergast's own `madring` circuit point
        # (40.46528, -3.61528) snapped onto the nearest centreline sample, which
        # moved it 12 m — i.e. Ergast's point already sits essentially on the
        # track, which is the only independent evidence available that it is
        # near the pit complex rather than at an arbitrary venue centroid.
        sf_lat=40.46539,
        sf_lon=-3.61532,
        # Inferred from bacinger's own winding, which matches the racing
        # direction on 20 of the 21 circuits where it could be checked. Singapore
        # is the counterexample, so this is a rule with a known failure mode, not
        # a fact. Re-derive from telemetry once the 2026 Madrid GP has run.
        want_ccw=False,
        dem_dataset="eudem25m",
        published_length_m=5474.0,
        notes=(
            "s=0 and racing direction are the only unverified values in the "
            "curation table: the circuit has never been raced, so neither of the "
            "two derivation routes exists yet. Both must be re-derived from "
            "FastF1 telemetry after the first Madrid Grand Prix. Nothing that "
            "depends on s=0 (corner names, highlights) is curated until then."
        ),
    ),
    CircuitSpec(
        key="marina_bay",
        ergast_circuit_id="marina_bay",
        bacinger_id="sg-2008",
        display_name="Marina Bay Street Circuit",
        country="Singapore",
        locality="Marina Bay",
        # Derived from FastF1 fastest-lap telemetry, residual 4.5 m, fit RMSE
        # 8.7 m at scale 0.9975. No TUMFTM entry.
        sf_lat=1.29079,
        sf_lon=103.86427,
        # THE ONE CIRCUIT WHERE bacinger's WINDING IS WRONG. Its LineString winds
        # clockwise; Marina Bay is raced anti-clockwise, confirmed independently
        # by the row order of the 2025 race's fastest-lap telemetry. Every other
        # circuit checked (20 of 21) agrees with the source, which is exactly why
        # this boolean is curated instead of inferred.
        want_ccw=True,
        dem_dataset="srtm30m",
        published_length_m=4940.0,
        notes=(
            "Street circuit at sea level between high-rises — a 30 m DEM pixel "
            "here is buildings, not tarmac, so expect a low elevation-confidence "
            "grade. Geometry is the current (2023-on) layout: 4932 m measured "
            "against 4940 m published, and the 2025 telemetry fits it at 8.7 m."
        ),
    ),
    CircuitSpec(
        key="miami",
        ergast_circuit_id="miami",
        bacinger_id="us-2022",
        display_name="Miami International Autodrome",
        country="USA",
        locality="Miami",
        # Derived from FastF1 fastest-lap telemetry, residual 0.9 m, fit RMSE
        # 7.8 m at scale 1.0042. No TUMFTM entry.
        sf_lat=25.95974,
        sf_lon=-80.23851,
        want_ccw=True,
        dem_dataset="ned10m",  # 10 m bare-earth lidar, as at Austin
        published_length_m=5412.0,
        notes=(
            "Temporary circuit around the Hard Rock Stadium campus. ned10m is "
            "bare-earth, so the stadium itself does not leak into the profile the "
            "way it would with a 30 m DSM — the same reason Austin uses it."
        ),
    ),
    CircuitSpec(
        key="monaco",
        ergast_circuit_id="monaco",
        bacinger_id="mc-1929",
        display_name="Circuit de Monaco",
        country="Monaco",
        locality="Monte Carlo",
        # Derived from FastF1 fastest-lap telemetry, residual 0.7 m, fit RMSE
        # 6.0 m at scale 1.0013. No TUMFTM entry — TUMFTM has never included a
        # street circuit — so this is the marquee circuit that route 2 exists for.
        sf_lat=43.73528,
        sf_lon=7.42123,
        want_ccw=False,
        dem_dataset="eudem25m",
        published_length_m=3337.0,
        # Monaco is genuinely ~7-9 m wide, half of the 12 m default, and the
        # narrowness is the whole character of the place.
        half_width_m=4.5,
        highlights=(
            Highlight(
                id="beau-rivage",
                name="Sainte Dévote to Casino Square",
                kind="climb",
                # From the Sainte Dévote apex (s~189) up Beau Rivage, through
                # Massenet, to Casino (s~883). Range is wide by design: the sign
                # is what is asserted, not the magnitude, because the DEM here is
                # rooftops as much as road (see notes).
                expect_s_m=540.0,
                expect_dz_m=(8.0, 70.0),
                expect_len_m=600.0,
                search_window_m=900.0,
                blurb=(
                    "The climb the television camera flattens completely. From "
                    "Sainte Dévote the track hauls itself up Beau Rivage to "
                    "Casino Square, the highest point of the lap, in a few "
                    "hundred metres."
                ),
            ),
            Highlight(
                id="casino-to-portier",
                name="Casino to Portier",
                kind="descent",
                # Casino (s~883) down through Mirabeau, the Grand Hotel Hairpin
                # and Mirabeau Bas to Portier (s~1405), where the lap rejoins sea
                # level at the tunnel mouth.
                expect_s_m=1140.0,
                expect_dz_m=(-70.0, -8.0),
                expect_len_m=500.0,
                search_window_m=800.0,
                blurb=(
                    "Everything gained on Beau Rivage is given back in one "
                    "plunge — down past Mirabeau, round the slowest corner in "
                    "Formula 1, and back to the waterfront at Portier."
                ),
            ),
        ),
        # Positions are FastF1's official corner distances rescaled to our
        # centreline. The Grand Hotel Hairpin is the cross-check that validates
        # the whole numbering: it must snap to the tightest apex on the lap, and
        # it does — 7.4 m radius, against 11.4 m for the next tightest.
        #
        # La Rascasse is the one entry NOT taken from the official numbering.
        # Mapping it to the turn number it is usually quoted as put it on a
        # 146 m-radius LEFT, which cannot be a corner described as the second
        # slowest in Formula 1. The geometry is unambiguous about where it
        # actually is: the run to the line ends left(146 m) - right(11.4 m) -
        # right(15.8 m) - right(89 m), and only the 11.4 m right can be
        # La Rascasse, with Anthony Noghès the 15.8 m right after it (which the
        # official numbering independently agrees with). Named from the geometry,
        # not from the number.
        #
        # Turns 2, 11 and the Swimming Pool's second half are deliberately
        # unnamed — halves of complexes already named at their entry, or kinks.
        corner_names=(
            (188.6, "Sainte Dévote"),
            (752.5, "Massenet"),
            (883.0, "Casino"),
            (1115.1, "Mirabeau Haute"),
            (1236.6, "Grand Hotel Hairpin"),
            (1318.8, "Mirabeau Bas"),
            (1405.3, "Portier"),
            (1734.1, "Tunnel"),
            (2070.8, "Nouvelle Chicane"),
            (2352.8, "Tabac"),
            (2514.2, "Swimming Pool"),
            (2896.0, "La Rascasse"),
            (2983.1, "Anthony Noghès"),
        ),
        notes=(
            "The hardest circuit on the calendar for this pipeline, and the "
            "profile should be read with that in mind. A 25 m EU-DEM pixel over "
            "Monte Carlo samples apartment rooftops, terraces and the harbour "
            "wall as readily as the road, and the tunnel is topologically "
            "impossible to represent in a single-valued heightfield at all — the "
            "surface there is the rock above the road. The plan geometry and the "
            "corner names are solid; the elevation is indicative, and the "
            "confidence grade the build assigns should be shown, not hidden."
        ),
    ),
    CircuitSpec(
        key="monza",
        ergast_circuit_id="monza",
        # NOT it-1914 (Mugello) and NOT it-1953 (Imola) — three Italian circuits
        # share the country prefix and only one of them is Monza.
        bacinger_id="it-1922",
        display_name="Autodromo Nazionale Monza",
        country="Italy",
        locality="Monza",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 3.4 m.
        sf_lat=45.61620,
        sf_lon=9.28079,
        want_ccw=False,
        dem_dataset="eudem25m",
        tumftm_name="Monza",
        published_length_m=5793.0,
        # No highlights: Monza is flat to within a few metres over the whole lap.
        # derive_segments still reports whatever sustained runs exist, which is
        # the honest way to show "there is nothing here" without inventing a
        # named set piece.
        corner_names=(
            (886.5, "Variante del Rettifilo"),
            (1475.9, "Curva Grande"),
            (2113.6, "Variante della Roggia"),
            (2528.2, "Lesmo 1"),
            (2856.6, "Lesmo 2"),
            (3923.6, "Variante Ascari"),
            (5230.6, "Parabolica"),
        ),
        notes=(
            "Fully curated for corner names, deliberately not for highlights: "
            "Monza is flat, and the banked 1955 oval is a separate, disused "
            "layout that is not part of this centreline."
        ),
    ),
    CircuitSpec(
        key="red_bull_ring",
        ergast_circuit_id="red_bull_ring",
        bacinger_id="at-1969",
        display_name="Red Bull Ring",
        country="Austria",
        locality="Spielberg",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 0.9 m.
        sf_lat=47.22032,
        sf_lon=14.76671,
        want_ccw=False,
        dem_dataset="eudem25m",
        tumftm_name="Spielberg",
        published_length_m=4318.0,
        highlights=(
            Highlight(
                id="climb-to-remus",
                name="Climb to Remus",
                kind="climb",
                # Turn 1 sits at s~425 and the Remus hairpin at the top of the
                # hill at s~1367. The whole first sector is one climb.
                expect_s_m=900.0,
                expect_dz_m=(12.0, 90.0),
                expect_len_m=900.0,
                search_window_m=1500.0,
                blurb=(
                    "A short lap that spends its first sector climbing. From the "
                    "line the track rises through Turn 1 and keeps rising all the "
                    "way to the Remus hairpin at the top of the hill."
                ),
            ),
            Highlight(
                id="remus-descent",
                name="Remus to the valley floor",
                kind="descent",
                # Back down from the hairpin through Turns 4-6, s~1400 to ~2700.
                expect_s_m=2050.0,
                expect_dz_m=(-90.0, -12.0),
                expect_len_m=1100.0,
                search_window_m=1600.0,
                blurb=(
                    "Off the top of the hill the circuit falls away for most of a "
                    "kilometre — a fast, downhill run that gives back everything "
                    "the first sector climbed."
                ),
            ),
        ),
        # Only the two enduring names. The Red Bull Ring's other corners carry
        # sponsor names that are re-sold every few seasons, so curating them
        # would date the payload rather than describe the circuit.
        corner_names=(
            (424.9, "Niki Lauda Kurve"),
            (1367.3, "Remus"),
        ),
        notes=(
            "The one circuit in this batch actually built against the DEM, to "
            "prove the curation end to end rather than only on paper: 4314 m "
            "measured (-0.08% of published), 69.6 m of elevation change between "
            "679 and 748 m ASL, HIGH confidence with 0% outliers and 0.26 m "
            "closure drift, TUMFTM widths accepted at 2.86 m RMSE, both "
            "highlights inside expectation and both corner names snapped. "
            "published_elevation_change_m is still left None: the measurement is "
            "ours, and pairing it with a figure recalled rather than sourced "
            "would make published_ratio meaningless."
        ),
    ),
    CircuitSpec(
        key="rodriguez",
        ergast_circuit_id="rodriguez",
        bacinger_id="mx-1962",
        display_name="Autódromo Hermanos Rodríguez",
        country="Mexico",
        locality="Mexico City",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 2.1 m.
        sf_lat=19.40602,
        sf_lon=-99.09278,
        want_ccw=False,
        dem_dataset="srtm30m",
        tumftm_name="MexicoCity",
        published_length_m=4304.0,
        notes=(
            "Sits at ~2230 m ASL, by far the highest circuit on the calendar — a "
            "useful sanity check on the DEM, since a profile that comes back near "
            "sea level would mean the wrong feature was matched (the trap that "
            "caught br-1977 for Interlagos)."
        ),
    ),
    CircuitSpec(
        key="shanghai",
        ergast_circuit_id="shanghai",
        bacinger_id="cn-2004",
        display_name="Shanghai International Circuit",
        country="China",
        locality="Shanghai",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 1.7 m.
        sf_lat=31.33768,
        sf_lon=121.22252,
        want_ccw=False,
        dem_dataset="srtm30m",
        tumftm_name="Shanghai",
        published_length_m=5451.0,
    ),
    CircuitSpec(
        key="silverstone",
        ergast_circuit_id="silverstone",
        bacinger_id="gb-1948",
        display_name="Silverstone Circuit",
        country="United Kingdom",
        locality="Silverstone",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 3.2 m.
        sf_lat=52.06836,
        sf_lon=-1.02335,
        want_ccw=False,
        dem_dataset="eudem25m",
        tumftm_name="Silverstone",
        published_length_m=5891.0,
        # No highlights: Silverstone is a wartime airfield and is close to flat.
        # Naming an elevation set piece here would be inventing one.
        corner_names=(
            (450.7, "Abbey"),
            (877.2, "Village"),
            (1042.6, "The Loop"),
            (1979.1, "Brooklands"),
            (2203.7, "Luffield"),
            (2563.1, "Woodcote"),
            (3081.6, "Copse"),
            (3651.0, "Maggotts"),
            (3737.7, "Becketts"),
            (4179.9, "Chapel"),
            (5048.3, "Stowe"),
            (5501.5, "Vale"),
            (5594.2, "Club"),
        ),
        notes=(
            "Fully curated for corner names, deliberately not for highlights: "
            "Silverstone is a former airfield and effectively flat."
        ),
    ),
    CircuitSpec(
        key="suzuka",
        ergast_circuit_id="suzuka",
        bacinger_id="jp-1962",
        display_name="Suzuka International Racing Course",
        country="Japan",
        locality="Suzuka",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 0.8 m.
        sf_lat=34.84498,
        sf_lon=136.53865,
        # Suzuka is the one circuit where the shoelace test is structurally
        # weak: it is a figure of eight, so its two lobes wind in opposite
        # directions and largely cancel. The signed area is 123k m2 against
        # 350k-1.5M for every other circuit here. The sign is still correct
        # (clockwise, confirmed by the TUMFTM row order) but it is a much
        # smaller margin than it looks, so do not "simplify" this to a
        # magnitude-free heuristic.
        want_ccw=False,
        dem_dataset="srtm30m",
        tumftm_name="Suzuka",
        published_length_m=5807.0,
        highlights=(
            Highlight(
                id="esses-climb",
                name="Climb through the Esses",
                kind="climb",
                # Turn 1 at s~697, the S Curves from s~1089, Dunlop at s~1857.
                # The circuit climbs continuously through the whole sequence.
                expect_s_m=1300.0,
                expect_dz_m=(6.0, 55.0),
                expect_len_m=900.0,
                search_window_m=1400.0,
                blurb=(
                    "The Esses are not just a rhythm section — they climb. The "
                    "track rises the whole way from Turn 1 through the S Curves to "
                    "Dunlop, which is why the sequence rewards commitment more "
                    "than the plan view suggests."
                ),
            ),
            Highlight(
                id="degner-descent",
                name="Degner to the Hairpin",
                kind="descent",
                # Degner 1 at s~2279, Degner 2 at s~2431, the Hairpin at s~2902.
                expect_s_m=2600.0,
                expect_dz_m=(-45.0, -5.0),
                expect_len_m=500.0,
                search_window_m=900.0,
                blurb=(
                    "Off the high point the lap drops away through both Degner "
                    "corners and keeps falling to the Hairpin, the slowest corner "
                    "on the circuit."
                ),
            ),
        ),
        corner_names=(
            (1089.4, "S Curves"),
            (1856.6, "Dunlop Curve"),
            (2279.2, "Degner 1"),
            (2431.3, "Degner 2"),
            (2902.2, "Hairpin"),
            (3803.2, "Spoon Curve"),
            (4997.1, "130R"),
            (5399.7, "Casio Triangle"),
        ),
    ),
    CircuitSpec(
        key="vegas",
        ergast_circuit_id="vegas",
        bacinger_id="us-2023",
        display_name="Las Vegas Strip Circuit",
        country="USA",
        locality="Las Vegas",
        # Derived from FastF1 fastest-lap telemetry, residual 4.5 m, fit RMSE
        # 11.4 m at scale 1.0005 — the loosest of the six telemetry fits, which
        # is expected on a circuit made almost entirely of long public-road
        # straights where a cyclic-shift search has little shape to lock onto.
        # Still an order of magnitude inside the 130 m that would matter.
        sf_lat=36.10886,
        sf_lon=-115.16234,
        want_ccw=True,
        dem_dataset="ned10m",
        published_length_m=6201.0,
        notes=(
            "Street circuit on public roads; ned10m bare-earth keeps the Strip's "
            "hotel towers out of the profile. Flat by design."
        ),
    ),
    CircuitSpec(
        key="villeneuve",
        ergast_circuit_id="villeneuve",
        bacinger_id="ca-1978",
        display_name="Circuit Gilles-Villeneuve",
        country="Canada",
        locality="Montreal",
        # Derived from the TUMFTM alignment (row 0 == start/finish), residual 0.3 m
        # — the tightest anchor of the whole set.
        sf_lat=45.50010,
        sf_lon=-73.52272,
        want_ccw=False,
        # Canada is outside NED's US-only footprint, so srtm30m rather than the
        # ned10m used for the three American circuits.
        dem_dataset="srtm30m",
        tumftm_name="Montreal",
        published_length_m=4361.0,
        notes="Île Notre-Dame is flat and at river level; expect almost no relief.",
    ),
    CircuitSpec(
        key="yas_marina",
        ergast_circuit_id="yas_marina",
        bacinger_id="ae-2009",
        display_name="Yas Marina Circuit",
        country="UAE",
        locality="Abu Dhabi",
        # Derived from the TUMFTM alignment, residual 2.6 m — but see notes: this
        # is the weakest anchor in the file.
        sf_lat=24.46979,
        sf_lon=54.60405,
        want_ccw=True,
        dem_dataset="srtm30m",
        tumftm_name="YasMarina",
        published_length_m=5281.0,
        notes=(
            "Weakest start/finish anchor here. TUMFTM fits at 23.0 m RMSE and "
            "scale 0.967 — only just inside the 25 m anchor gate — because it "
            "carries the pre-2021 layout, before the north hairpin was opened out "
            "and the marina section reshaped. The pit straight itself did not "
            "move in that renovation, which is why the anchor is still usable, "
            "but nothing that depends on precise arc length is curated for this "
            "circuit and the widths are refused."
        ),
    ),
)

BY_KEY: dict[str, CircuitSpec] = {spec.key: spec for spec in SPECS}


def get(key: str) -> CircuitSpec:
    if key not in BY_KEY:
        raise KeyError(f"unknown circuit key {key!r}; known: {sorted(BY_KEY)}")
    return BY_KEY[key]
