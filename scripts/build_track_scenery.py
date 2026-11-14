"""Bake the real-world scenery layer for the 3D viewer's "Real world" mode.

That mode drapes satellite imagery over a DEM and stands OpenStreetMap buildings
and trees on it — the technique MapNG (github.com/nikkiluzader/mapng, MIT) uses
for its 3D preview. Imagery and elevation are fetched by the browser as ordinary
map tiles; this script bakes the one part that cannot sensibly be fetched at
view time, the OSM vectors, into `<out>/<id>.json`.

Why bake OSM instead of asking Overpass from the browser: every public Overpass
instance timed out or returned 502 while this was being written, and MapNG's own
README records the same experience (they ended up hosting a copy of the planet).
A viewer that depends on Overpass being up is a viewer that is often empty.

    python scripts/build_track_scenery.py --all
    python scripts/build_track_scenery.py --only silverstone,spa

A circuit needs its track payload first (`build_track_geometry.py`): the scenery
rectangle is derived from the lap. Raw OSM responses are cached under
`.cache/trackgeo/osm/`, so a re-run costs no requests.

Data: © OpenStreetMap contributors, ODbL. The viewer shows that credit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from trackgeo import curated  # noqa: E402
from trackgeo.cache import cache_dir  # noqa: E402
from trackgeo.project import to_geo  # noqa: E402
from trackgeo.scenery import build_scenery, scenery_bounds  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
ASSET_BASE = "https://storage.googleapis.com/f1-scratch-assets"
OSM_API = "https://api.openstreetmap.org/api/0.6/map"
USER_AGENT = "apex-track-scenery/1 (offline bake; a few requests per circuit)"

# Esri World Imagery "Wayback" release to read the photo from, per circuit:
# (release id, release date). Absent means "whatever is current".
#
# Current is not always best. Esri's mosaic is whichever capture they rate
# highest, and that is sometimes one with cloud parked on the circuit. There is
# no cloud flag in the tile metadata, so this is curated by eye against a
# contact sheet of releases, like the corner names. When re-checking a circuit,
# pick the NEWEST clear release: older ones predate layout changes.
IMAGERY_RELEASE: dict[str, tuple[int, str]] = {
    # From 2026-04-30 onwards: cloud over Copse, Maggotts and half the infield.
    "silverstone": (64001, "2026-02-26"),
}


def load_payload(circuit_id: str) -> dict | None:
    """The track payload, from the bundled copy or the asset bucket. None if neither has it."""
    local = REPO / "frontend" / "public" / "tracks" / f"{circuit_id}.json"
    if local.exists():
        return json.loads(local.read_text(encoding="utf-8"))
    request = urllib.request.Request(
        f"{ASSET_BASE}/tracks/{circuit_id}.json", headers={"User-Agent": USER_AGENT}
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        if error.code in (403, 404):
            return None
        raise


def fetch_osm(west: float, south: float, east: float, north: float, depth: int = 0) -> list[bytes]:
    """Fetch a bbox from the OSM API as raw XML, quartering it if it is too big.

    The API refuses more than 50,000 nodes per call with a 400. A circuit in open
    country fits in one request; Monaco or Montreal does not.
    """
    key = hashlib.sha1(f"{west:.6f},{south:.6f},{east:.6f},{north:.6f}".encode()).hexdigest()[:20]
    cached = cache_dir("osm") / f"{key}.xml"
    if cached.exists():
        return [cached.read_bytes()]

    url = f"{OSM_API}?bbox={west:.6f},{south:.6f},{east:.6f},{north:.6f}"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                raw = response.read()
            cached.write_bytes(raw)
            time.sleep(1.0)  # be a polite client of a shared, donated API
            return [raw]
        except urllib.error.HTTPError as error:
            if error.code == 400 and depth < 4:
                break  # too many nodes: split below
            if error.code in (429, 509) or error.code >= 500:
                time.sleep(15 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(10 * (attempt + 1))
    else:
        raise RuntimeError(f"OSM API kept failing for bbox {west},{south},{east},{north}")

    mid_lon = (west + east) / 2
    mid_lat = (south + north) / 2
    parts: list[bytes] = []
    for box in (
        (west, south, mid_lon, mid_lat),
        (mid_lon, south, east, mid_lat),
        (west, mid_lat, mid_lon, north),
        (mid_lon, mid_lat, east, north),
    ):
        parts.extend(fetch_osm(*box, depth=depth + 1))
    return parts


def parse_osm(documents: list[bytes]):
    """Merge OSM XML documents into id-keyed dicts. Quartered fetches overlap; ids dedupe them."""
    nodes: dict[str, tuple[float, float]] = {}
    node_tags: dict[str, dict[str, str]] = {}
    ways: dict[str, tuple[list[str], dict[str, str]]] = {}
    relations: dict[str, tuple[list[tuple[str, str]], dict[str, str]]] = {}
    for document in documents:
        root = ET.fromstring(document)
        for node in root.iter("node"):
            nodes[node.get("id")] = (float(node.get("lat")), float(node.get("lon")))
            tags = {t.get("k"): t.get("v") for t in node.findall("tag")}
            if tags:
                node_tags[node.get("id")] = tags
        for way in root.iter("way"):
            refs = [nd.get("ref") for nd in way.findall("nd")]
            ways[way.get("id")] = (refs, {t.get("k"): t.get("v") for t in way.findall("tag")})
        for relation in root.iter("relation"):
            members = [
                (m.get("ref"), m.get("role") or "")
                for m in relation.findall("member")
                if m.get("type") == "way"
            ]
            relations[relation.get("id")] = (
                members,
                {t.get("k"): t.get("v") for t in relation.findall("tag")},
            )
    return nodes, node_tags, ways, relations


def build(circuit_id: str, payload: dict) -> dict:
    bounds = scenery_bounds(payload)
    lats, lons = to_geo(
        np.array([bounds["e_min_m"], bounds["e_max_m"]]),
        np.array([bounds["n_min_m"], bounds["n_max_m"]]),
        payload["origin"]["lat"],
        payload["origin"]["lon"],
    )
    documents = fetch_osm(float(lons[0]), float(lats[0]), float(lons[1]), float(lats[1]))
    return build_scenery(
        payload,
        *parse_osm(documents),
        imagery=IMAGERY_RELEASE.get(circuit_id),
        log=lambda line: print(f"  {line}"),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--only", help="circuit id(s), comma separated")
    group.add_argument(
        "--all",
        action="store_true",
        help="every curated circuit that already has a track payload",
    )
    parser.add_argument(
        "--out",
        default=str(REPO / "frontend" / "public" / "tracks" / "scenery"),
        help="output directory",
    )
    args = parser.parse_args(argv)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    wanted = (
        sorted(curated.BY_KEY)
        if args.all
        else [item.strip() for item in args.only.split(",") if item.strip()]
    )

    failures = 0
    for circuit_id in wanted:
        payload = load_payload(circuit_id)
        if payload is None:
            print(f"{circuit_id}: no track payload yet — skipped")
            continue
        print(f"{circuit_id}:")
        try:
            scenery = build(circuit_id, payload)
        except Exception as error:  # noqa: BLE001 - one circuit must not sink the batch
            failures += 1
            print(f"  FAILED: {error!r}")
            continue
        target = out_dir / f"{circuit_id}.json"
        target.write_text(json.dumps(scenery, separators=(",", ":")), encoding="utf-8")
        b = scenery["bounds"]
        print(
            f"  area {b['e_max_m'] - b['e_min_m']:.0f} x {b['n_max_m'] - b['n_min_m']:.0f} m, "
            f"{target.stat().st_size / 1024:.0f} KB -> {target.relative_to(REPO)}"
        )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
