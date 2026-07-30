"""Hand-curated per-circuit data, kept separate so it stays diffable.

Everything here is either (a) not derivable from the sources, or (b) a
validation expectation used to catch silent failures.

On start/finish coordinates: bacinger's f1-locations.json carries only
3-decimal venue-centring points (~100 m, intended for map zoom), so the sf_lat /
sf_lon values below are curated estimates accurate to roughly 50-150 m. They
affect *only* where s=0 sits, and therefore how arc-length ranges are labelled —
the geometry and the elevation profile are unaffected. Because of that
uncertainty, named highlights are matched against *auto-detected* elevation
features (see elevation features in build_track_geometry.py) using a generous
window plus a required gradient sign, rather than hardcoded arc-length ranges
that would quietly drift with the S/F estimate.

Winding direction (want_ccw) is verified: the shoelace sign of the source
geometry already matches the real racing direction for all four circuits — Spa
CW, Austin CCW, Interlagos CCW, Zandvoort CW.
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
)

BY_KEY: dict[str, CircuitSpec] = {spec.key: spec for spec in SPECS}


def get(key: str) -> CircuitSpec:
    if key not in BY_KEY:
        raise KeyError(f"unknown circuit key {key!r}; known: {sorted(BY_KEY)}")
    return BY_KEY[key]
