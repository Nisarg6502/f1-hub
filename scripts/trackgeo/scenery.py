"""OpenStreetMap -> scenery payload, for the 3D viewer's "Real world" mode.

Pure functions over already-parsed OSM data: no network and no files, so every
rule here can be unit-tested with a handful of hand-written nodes. Fetching and
writing live in `scripts/build_track_scenery.py`.

The payload is in the same local ENU frame as the track payload (decimetres
about `payload["origin"]`), which is why the frontend needs no projection code
to place a building: a scenery vertex and a track vertex with the same numbers
are the same place.
"""

from __future__ import annotations

from typing import Callable, Iterable

import numpy as np

from .project import to_enu

SCENERY_VERSION = 2

# Mirrored in frontend/src/lib/track-scenery.ts (`sceneryBounds`). The frontend
# prefers the bounds written into the payload, so the two cannot silently
# disagree, but a circuit with no baked scenery falls back to the frontend's
# copy of this formula — keep them the same.
MARGIN_MIN_M = 320.0
MARGIN_FRACTION = 0.18

# Fallback heights (metres) when a building carries neither `height` nor
# `building:levels`. Guesses, counted as such in `height_provenance`.
DEFAULT_HEIGHT_M = {
    "grandstand": 13.0,
    "stadium": 13.0,
    "bleachers": 9.0,
    "industrial": 9.0,
    "warehouse": 9.0,
    "hangar": 9.0,
    "commercial": 9.0,
    "retail": 7.0,
    "office": 12.0,
    "hotel": 16.0,
    "apartments": 15.0,
    "garage": 3.0,
    "garages": 3.5,
    "shed": 3.0,
    "hut": 3.0,
    "roof": 5.0,
    "house": 6.5,
    "detached": 6.5,
    "residential": 9.0,
    "church": 14.0,
}
FALLBACK_HEIGHT_M = 6.0
LEVEL_HEIGHT_M = 3.3
# Nothing a typo should be able to exceed. The tallest thing beside any F1
# circuit is a Monaco or Singapore tower; 250 m admits those and rejects a
# `height=1200` that was meant to be `12.00`.
MAX_HEIGHT_M = 250.0

MIN_BUILDING_AREA_M2 = 12.0
MIN_WOOD_AREA_M2 = 150.0
# Douglas-Peucker tolerances. A wood's edge is a mapper's sketch of a canopy
# line and survives 2.5 m of simplification with no visible change; a building
# corner does not, so buildings only lose vertices that are genuinely collinear.
WOOD_TOLERANCE_M = 2.5
BUILDING_TOLERANCE_M = 0.15

Tags = dict[str, str]


def scenery_bounds(payload: dict) -> dict:
    """Track bbox plus a margin, in ENU metres. The whole lap is inside by construction."""
    east = np.asarray(payload["e_dm"], dtype=float) / 10.0
    north = np.asarray(payload["n_dm"], dtype=float) / 10.0
    diagonal = float(np.hypot(east.max() - east.min(), north.max() - north.min()))
    margin = max(MARGIN_MIN_M, MARGIN_FRACTION * diagonal)
    return {
        "e_min_m": round(float(east.min()) - margin, 1),
        "e_max_m": round(float(east.max()) + margin, 1),
        "n_min_m": round(float(north.min()) - margin, 1),
        "n_max_m": round(float(north.max()) + margin, 1),
    }


def parse_height(tags: Tags) -> tuple[float, str]:
    """Return (metres, provenance). Provenance is 'tag', 'levels' or 'guess'."""
    raw = tags.get("height") or tags.get("building:height")
    if raw:
        try:
            value = float(raw.lower().replace("m", "").replace(",", ".").strip())
            if 1.0 <= value <= MAX_HEIGHT_M:
                return value, "tag"
        except ValueError:
            pass
    levels = tags.get("building:levels")
    if levels:
        try:
            value = float(levels.replace(",", ".")) * LEVEL_HEIGHT_M + 1.0
            if 1.0 <= value <= MAX_HEIGHT_M:
                return value, "levels"
        except ValueError:
            pass
    return DEFAULT_HEIGHT_M.get(building_kind(tags), FALLBACK_HEIGHT_M), "guess"


def building_kind(tags: Tags) -> str:
    if tags.get("leisure") == "bleachers":
        return "bleachers"
    return tags.get("building", "yes")


def is_building(tags: Tags) -> bool:
    if tags.get("leisure") == "bleachers":
        return True
    value = tags.get("building")
    # `building=no` is a real tag, and underground structures (car parks, the
    # Monaco station) would otherwise be extruded up through the street.
    if not value or value == "no":
        return False
    if tags.get("location") == "underground":
        return False
    try:
        if float(tags.get("layer", "0")) < 0:
            return False
    except ValueError:
        pass
    return True


def is_wood(tags: Tags) -> bool:
    return tags.get("natural") == "wood" or tags.get("landuse") == "forest"


def assemble_rings(ways: Iterable[list[str]]) -> list[list[str]]:
    """Stitch member ways into closed rings of node ids.

    A multipolygon's outer boundary is routinely split across several ways that
    only close when joined end to end — every large forest is mapped that way.
    Ways are joined greedily by shared endpoints, reversing where needed. Chains
    that never close (the relation runs off the edge of the download) are
    dropped: an open ring cannot be filled.

    Returned rings repeat their first node as their last, like a closed way.
    """
    pending = [list(way) for way in ways if len(way) >= 2]
    rings: list[list[str]] = []
    while pending:
        chain = pending.pop()
        while chain[0] != chain[-1]:
            for index, way in enumerate(pending):
                if way[0] == chain[-1]:
                    chain.extend(way[1:])
                elif way[-1] == chain[-1]:
                    chain.extend(reversed(way[:-1]))
                elif way[-1] == chain[0]:
                    chain[:0] = way[:-1]
                elif way[0] == chain[0]:
                    chain[:0] = list(reversed(way[1:]))
                else:
                    continue
                pending.pop(index)
                break
            else:
                break  # nothing joins: an open chain
        if chain[0] == chain[-1] and len(chain) >= 4:
            rings.append(chain)
    return rings


def ring_area(east: np.ndarray, north: np.ndarray) -> float:
    """Signed shoelace area in m2. Positive is counter-clockwise in ENU."""
    return 0.5 * float(np.sum(east * np.roll(north, -1) - np.roll(east, -1) * north))


def simplify_ring(east: np.ndarray, north: np.ndarray, tolerance: float) -> tuple[np.ndarray, np.ndarray]:
    """Douglas-Peucker on a closed ring (first vertex not repeated).

    The ring is split at its two mutually farthest-apart-ish vertices (index 0
    and the vertex farthest from it) so both halves have distinct endpoints —
    running the classic open-line algorithm on a ring whose ends coincide
    collapses it to a point.
    """
    count = len(east)
    if count <= 4 or tolerance <= 0:
        return east, north
    points = np.column_stack([east, north])
    far = int(np.argmax(np.hypot(*(points - points[0]).T)))
    if far == 0:
        return east, north

    keep = np.zeros(count, dtype=bool)
    keep[0] = keep[far] = True

    def reduce(indices: list[int]) -> None:
        stack = [(0, len(indices) - 1)]
        while stack:
            lo, hi = stack.pop()
            if hi - lo < 2:
                continue
            a = points[indices[lo]]
            b = points[indices[hi]]
            span = b - a
            length = float(np.hypot(*span))
            inner = points[indices[lo + 1 : hi]]
            if length < 1e-9:
                distance = np.hypot(*(inner - a).T)
            else:
                distance = np.abs(span[0] * (inner[:, 1] - a[1]) - span[1] * (inner[:, 0] - a[0])) / length
            worst = int(np.argmax(distance))
            if distance[worst] > tolerance:
                split = lo + 1 + worst
                keep[indices[split]] = True
                stack.append((lo, split))
                stack.append((split, hi))

    reduce(list(range(0, far + 1)))
    reduce(list(range(far, count)) + [0])
    if int(keep.sum()) < 3:
        return east, north
    return east[keep], north[keep]


def _flat_dm(east: np.ndarray, north: np.ndarray) -> list[int]:
    flat: list[int] = []
    for e, n in zip(east, north):
        flat.extend((int(round(float(e) * 10)), int(round(float(n) * 10))))
    return flat


def build_scenery(
    payload: dict,
    nodes: dict[str, tuple[float, float]],
    node_tags: dict[str, Tags],
    ways: dict[str, tuple[list[str], Tags]],
    relations: dict[str, tuple[list[tuple[str, str]], Tags]],
    *,
    imagery: tuple[int, str] | None = None,
    log: Callable[[str], None] | None = None,
) -> dict:
    """Turn parsed OSM into the scenery payload for one circuit.

    `nodes` maps id -> (lat, lon); `ways` maps id -> (node ids, tags);
    `relations` maps id -> ([(way id, role)], tags).
    """
    lat0 = payload["origin"]["lat"]
    lon0 = payload["origin"]["lon"]
    bounds = scenery_bounds(payload)

    def project(refs: list[str], tolerance: float) -> tuple[np.ndarray, np.ndarray] | None:
        """Closed node-id ring -> simplified ENU arrays, or None if unusable."""
        if len(refs) < 4 or refs[0] != refs[-1]:
            return None
        coords = [nodes[ref] for ref in refs[:-1] if ref in nodes]
        if len(coords) < 3:
            return None
        east, north = to_enu(
            np.array([c[0] for c in coords]), np.array([c[1] for c in coords]), lat0, lon0
        )
        east, north = simplify_ring(east, north, tolerance)
        return (east, north) if len(east) >= 3 else None

    def touches_bounds(east: np.ndarray, north: np.ndarray) -> bool:
        """Bbox overlap, not vertex containment: a forest far larger than the
        scenery rectangle has no vertex inside it and still covers all of it."""
        return not (
            east.max() < bounds["e_min_m"]
            or east.min() > bounds["e_max_m"]
            or north.max() < bounds["n_min_m"]
            or north.min() > bounds["n_max_m"]
        )

    def within_bounds(east: np.ndarray, north: np.ndarray) -> bool:
        return bool(
            east.min() >= bounds["e_min_m"]
            and east.max() <= bounds["e_max_m"]
            and north.min() >= bounds["n_min_m"]
            and north.max() <= bounds["n_max_m"]
        )

    buildings: list[dict] = []
    woods: list[list[int]] = []
    wood_holes: list[list[int]] = []
    provenance = {"tag": 0, "levels": 0, "guess": 0}

    def add_building(outer: list[str], inners: list[list[str]], tags: Tags) -> None:
        ring = project(outer, BUILDING_TOLERANCE_M)
        if ring is None:
            return
        east, north = ring
        # Whole buildings only: one that straddles the edge of the slab would
        # hang in mid-air beyond it.
        if not within_bounds(east, north) or abs(ring_area(east, north)) < MIN_BUILDING_AREA_M2:
            return
        height, source = parse_height(tags)
        provenance[source] += 1
        entry: dict = {
            "kind": building_kind(tags),
            "h_dm": int(round(height * 10)),
            "ring_dm": _flat_dm(east, north),
        }
        holes = []
        for inner in inners:
            hole = project(inner, BUILDING_TOLERANCE_M)
            if hole is not None and abs(ring_area(*hole)) >= MIN_BUILDING_AREA_M2:
                holes.append(_flat_dm(*hole))
        if holes:
            entry["holes_dm"] = holes
        buildings.append(entry)

    def add_wood(outer: list[str], inners: list[list[str]]) -> None:
        ring = project(outer, WOOD_TOLERANCE_M)
        if ring is None:
            return
        east, north = ring
        if not touches_bounds(east, north) or abs(ring_area(east, north)) < MIN_WOOD_AREA_M2:
            return
        woods.append(_flat_dm(east, north))
        for inner in inners:
            hole = project(inner, WOOD_TOLERANCE_M)
            if hole is not None and touches_bounds(*hole):
                wood_holes.append(_flat_dm(*hole))

    # Ways that are members of a building/wood multipolygon are that relation's
    # geometry; drawing them again as standalone ways would double every wall.
    claimed: set[str] = set()
    for members, tags in relations.values():
        if tags.get("type") != "multipolygon" or not (is_building(tags) or is_wood(tags)):
            continue
        outers = assemble_rings(ways[ref][0] for ref, role in members if role != "inner" and ref in ways)
        inners = assemble_rings(ways[ref][0] for ref, role in members if role == "inner" and ref in ways)
        claimed.update(ref for ref, role in members if role != "inner")
        for outer in outers:
            # Inner rings are not matched to a particular outer. For buildings
            # that is exact in practice (one outer per relation, almost always);
            # for woods the holes go into one flat list the frontend tests
            # every tree against, so no matching is needed at all.
            if is_building(tags):
                add_building(outer, inners if len(outers) == 1 else [], tags)
            else:
                add_wood(outer, inners)

    for way_id, (refs, tags) in ways.items():
        if way_id in claimed:
            continue
        if is_building(tags):
            add_building(refs, [], tags)
        elif is_wood(tags):
            add_wood(refs, [])

    trees: list[int] = []
    for node_id, tags in node_tags.items():
        if tags.get("natural") != "tree" or node_id not in nodes:
            continue
        lat, lon = nodes[node_id]
        east, north = to_enu(np.array([lat]), np.array([lon]), lat0, lon0)
        e, n = float(east[0]), float(north[0])
        if bounds["e_min_m"] <= e <= bounds["e_max_m"] and bounds["n_min_m"] <= n <= bounds["n_max_m"]:
            trees.extend((int(round(e * 10)), int(round(n * 10))))

    if log:
        log(
            f"{len(buildings)} buildings (heights {provenance}), {len(woods)} woods "
            f"with {len(wood_holes)} clearings, {len(trees) // 2} trees"
        )

    return {
        "version": SCENERY_VERSION,
        "id": payload["id"],
        "origin": payload["origin"],
        "bounds": bounds,
        "buildings": buildings,
        "woods_dm": woods,
        "wood_holes_dm": wood_holes,
        "trees_dm": trees,
        "height_provenance": provenance,
        "imagery_release": imagery[0] if imagery else None,
        "imagery_date": imagery[1] if imagery else None,
        "attribution": "© OpenStreetMap contributors (ODbL)",
    }
