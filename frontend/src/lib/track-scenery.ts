/**
 * Real-world scenery for the 3D viewer's "Real world" mode.
 *
 * The technique is MapNG's (github.com/nikkiluzader/mapng, MIT): satellite
 * imagery draped over a DEM, with OpenStreetMap buildings and trees stood on
 * top. None of MapNG's code is used — it is a Vue/TresJS app whose 3D preview
 * is welded to a BeamNG export pipeline — but the data sources are the same
 * ones it reads, and both tile servers send `Access-Control-Allow-Origin: *`:
 *
 *   imagery    Esri World Imagery        server.arcgisonline.com
 *   elevation  Terrarium tiles on AWS    s3.amazonaws.com/elevation-tiles-prod
 *   vectors    OpenStreetMap, baked offline by `scripts/build_track_scenery.py`
 *
 * Everything here is in the track payload's own ENU frame (metres about
 * `payload.origin`), so a scenery vertex and a track vertex with the same
 * numbers are the same place.
 */

import type { TrackGeometryPayload } from "@/lib/circuit-geometry";

export interface SceneryBounds {
  e_min_m: number;
  e_max_m: number;
  n_min_m: number;
  n_max_m: number;
}

export interface SceneryBuilding {
  kind: string;
  /** Height above its base, decimetres. Mostly a per-kind guess — see `height_provenance`. */
  h_dm: number;
  /** Flat [e, n, e, n, ...] ring in decimetres, last vertex not repeated. */
  ring_dm: number[];
  /** Courtyards: rings cut out of the footprint. Absent on almost everything. */
  holes_dm?: number[][];
}

export interface TrackSceneryPayload {
  version: number;
  id: string;
  origin: { lat: number; lon: number };
  bounds: SceneryBounds;
  buildings: SceneryBuilding[];
  woods_dm: number[][];
  /** Clearings: no tree is planted inside any of these, whichever wood it cuts. */
  wood_holes_dm?: number[][];
  /** Flat [e, n, ...] of individually mapped trees, decimetres. */
  trees_dm: number[];
  height_provenance: Record<string, number>;
  /**
   * Esri Wayback release to read imagery from, when the current mosaic is not
   * the best one (cloud over the circuit). Null means current.
   */
  imagery_release?: number | null;
  imagery_date?: string | null;
  attribution: string;
}

export const IMAGERY_TILE_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile";
export const IMAGERY_WAYBACK_URL =
  "https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile";
export const ELEVATION_TILE_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";

/** One imagery tile. Both services order the path z/y/x, not z/x/y. */
export function imageryTileUrl(
  zoom: number,
  x: number,
  y: number,
  release?: number | null,
): string {
  return release
    ? `${IMAGERY_WAYBACK_URL}/${release}/${zoom}/${y}/${x}`
    : `${IMAGERY_TILE_URL}/${zoom}/${y}/${x}`;
}

export const IMAGERY_ATTRIBUTION = "Imagery © Esri, Maxar, Earthstar Geographics";
export const ELEVATION_ATTRIBUTION = "Elevation: Mapzen Terrain Tiles";

const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE_URL ?? "";

/**
 * Where a circuit's baked scenery may live, in the order to try.
 *
 * The copy under `public/tracks/scenery/` comes first so local development and
 * the baked set work with no bucket at all; the asset bucket is the fallback
 * for anything generated after the frontend image was built. A circuit with
 * neither still gets the photo and the terrain — just no buildings.
 */
export function trackSceneryUrls(geometryId: string): string[] {
  const urls = [`/tracks/scenery/${geometryId}.json`];
  if (ASSET_BASE) urls.push(`${ASSET_BASE}/tracks/scenery/${geometryId}.json`);
  return urls;
}

// Mirrors MARGIN_MIN_M / MARGIN_FRACTION in scripts/trackgeo/scenery.py.
const MARGIN_MIN_M = 320;
const MARGIN_FRACTION = 0.18;

/**
 * The area the scenery covers: the track's bounding box plus a margin.
 *
 * Derived from the lap itself rather than picked as a square around a centre
 * point — which is how a hand-placed map selection ends up slicing off Stowe.
 * The whole circuit is inside by construction, with at least 320 m to spare on
 * every side.
 */
export function sceneryBounds(payload: TrackGeometryPayload): SceneryBounds {
  let eMin = Infinity;
  let eMax = -Infinity;
  let nMin = Infinity;
  let nMax = -Infinity;
  for (let i = 0; i < payload.e_dm.length; i += 1) {
    const e = payload.e_dm[i] / 10;
    const n = payload.n_dm[i] / 10;
    if (e < eMin) eMin = e;
    if (e > eMax) eMax = e;
    if (n < nMin) nMin = n;
    if (n > nMax) nMax = n;
  }
  const margin = Math.max(
    MARGIN_MIN_M,
    MARGIN_FRACTION * Math.hypot(eMax - eMin, nMax - nMin),
  );
  return {
    e_min_m: eMin - margin,
    e_max_m: eMax + margin,
    n_min_m: nMin - margin,
    n_max_m: nMax + margin,
  };
}

const A_WGS84 = 6378137.0;
const E2_WGS84 = 6.69437999014e-3;

/**
 * ENU metres <-> WGS84 degrees, the exact inverse of `scripts/trackgeo/project.py`.
 *
 * It has to be the same equirectangular projection with the same ellipsoidal
 * radii, not a "close enough" spherical one: imagery is positioned through this
 * function and the track through that one, so any difference between them shows
 * up as the tarmac in the photo sliding out from under the ribbon.
 */
export function makeProjection(origin: { lat: number; lon: number }) {
  const lat0 = (origin.lat * Math.PI) / 180;
  const sin2 = Math.sin(lat0) ** 2;
  const primeVertical = A_WGS84 / Math.sqrt(1 - E2_WGS84 * sin2);
  const meridional = (A_WGS84 * (1 - E2_WGS84)) / (1 - E2_WGS84 * sin2) ** 1.5;
  const ke = primeVertical * Math.cos(lat0);
  const kn = meridional;
  return {
    toLat: (northM: number) => origin.lat + ((northM / kn) * 180) / Math.PI,
    toLon: (eastM: number) => origin.lon + ((eastM / ke) * 180) / Math.PI,
  };
}

/** Fractional slippy-map tile X for a longitude. */
export function tileX(lonDeg: number, zoom: number): number {
  return ((lonDeg + 180) / 360) * 2 ** zoom;
}

/** Fractional slippy-map tile Y for a latitude (Web Mercator). */
export function tileY(latDeg: number, zoom: number): number {
  const phi = (latDeg * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2) * 2 ** zoom;
}

export interface TileWindow {
  zoom: number;
  /** Integer tile range, inclusive. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  tilesX: number;
  tilesY: number;
  /** Mosaic size in pixels. */
  width: number;
  height: number;
}

export const TILE_PX = 256;

/** The tiles covering `bounds` at one zoom. */
export function tileWindow(
  bounds: SceneryBounds,
  origin: { lat: number; lon: number },
  zoom: number,
): TileWindow {
  const projection = makeProjection(origin);
  const x0 = Math.floor(tileX(projection.toLon(bounds.e_min_m), zoom));
  const x1 = Math.floor(tileX(projection.toLon(bounds.e_max_m), zoom));
  // Tile Y grows southwards, so the north edge is the smaller index.
  const y0 = Math.floor(tileY(projection.toLat(bounds.n_max_m), zoom));
  const y1 = Math.floor(tileY(projection.toLat(bounds.n_min_m), zoom));
  const tilesX = x1 - x0 + 1;
  const tilesY = y1 - y0 + 1;
  return {
    zoom,
    x0,
    y0,
    x1,
    y1,
    tilesX,
    tilesY,
    width: tilesX * TILE_PX,
    height: tilesY * TILE_PX,
  };
}

/**
 * The sharpest zoom whose mosaic still fits in `maxPx` on its long side.
 *
 * Fixed zooms do not survive contact with circuit sizes: z17 is ~0.75 m/px,
 * right for Silverstone, but the same zoom over Spa would be a 60-megapixel
 * texture. Solving for it keeps every circuit inside one GPU-safe texture.
 */
export function pickZoom(
  bounds: SceneryBounds,
  origin: { lat: number; lon: number },
  maxPx: number,
  maxZoom: number,
): TileWindow {
  for (let zoom = maxZoom; zoom > 1; zoom -= 1) {
    const window = tileWindow(bounds, origin, zoom);
    if (Math.max(window.width, window.height) <= maxPx) return window;
  }
  return tileWindow(bounds, origin, 1);
}
