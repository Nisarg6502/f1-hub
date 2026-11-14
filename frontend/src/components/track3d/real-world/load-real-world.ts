/**
 * Fetch everything the "Real world" mode needs for one circuit.
 *
 * Three things, all keyed off the track's own bounding box so the whole lap is
 * always covered:
 *
 *   1. baked OSM scenery (buildings, woods, trees) — optional, 404 is fine
 *   2. a satellite imagery mosaic, stitched from XYZ tiles into one canvas
 *   3. a DEM mosaic, decoded from Terrarium tiles into metres
 *
 * No React and no three.js here: it is plain fetch + canvas, so it can be
 * reasoned about (and later moved to a worker) on its own.
 */

import type { TrackGeometryPayload } from "@/lib/circuit-geometry";
import {
  ELEVATION_TILE_URL,
  TILE_PX,
  imageryTileUrl,
  makeProjection,
  pickZoom,
  sceneryBounds,
  tileX,
  tileY,
  trackSceneryUrls,
  type SceneryBounds,
  type TileWindow,
  type TrackSceneryPayload,
} from "@/lib/track-scenery";

export type ImageryQuality = "standard" | "hd";

/**
 * Long-side cap for the imagery mosaic, in pixels.
 *
 * `standard` fits inside every WebGL2 device's texture limit and is ~150 tiles
 * for a typical circuit: right for the overview, soft from the chase camera.
 * `hd` allows one more zoom level — four times the tiles, the download and the
 * GPU memory — which is what it takes for kerbs and grid boxes to survive at
 * ground level. Opt-in for that reason, and still clamped to what the device
 * can actually hold.
 */
const IMAGERY_MAX_PX: Record<ImageryQuality, number> = { standard: 4096, hd: 8192 };
const IMAGERY_MAX_ZOOM = 19;

let textureLimit: number | null = null;

/** The GPU's largest texture side, probed once on a throwaway context. */
function deviceTextureLimit(): number {
  if (textureLimit === null) {
    textureLimit = 4096;
    try {
      const gl = document.createElement("canvas").getContext("webgl2");
      if (gl) {
        textureLimit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
        gl.getExtension("WEBGL_lose_context")?.loseContext();
      }
    } catch {
      // Keep the conservative default.
    }
  }
  return textureLimit;
}
/**
 * z14 is ~6 m/px at mid latitudes. The source data is 2 m lidar at best and
 * 30 m SRTM at worst, so a deeper zoom buys nothing but more tiles.
 */
const ELEVATION_MAX_PX = 1024;
const ELEVATION_MAX_ZOOM = 14;
const CONCURRENCY = 12;

export interface Dem {
  window: TileWindow;
  /** Row-major metres above sea level, `window.width * window.height`. */
  heights: Float32Array;
  min: number;
  max: number;
  /** False when the tiles could not be read and the DEM is a flat stand-in. */
  real: boolean;
  /** Bilinear height in metres above sea level at an ENU position. */
  sample(eastM: number, northM: number): number;
}

export interface RealWorldData {
  geometryId: string;
  quality: ImageryQuality;
  /** Ground size of one imagery pixel at the circuit's latitude. */
  metresPerPixel: number;
  bounds: SceneryBounds;
  origin: { lat: number; lon: number };
  /** The stitched photo. Handed to a CanvasTexture by the scene. */
  imagery: HTMLCanvasElement;
  imageryWindow: TileWindow;
  imageryFailed: number;
  /** ENU metres -> texture UV in the imagery mosaic. */
  uv(eastM: number, northM: number): [number, number];
  dem: Dem;
  scenery: TrackSceneryPayload | null;
  /** The track payload with its elevation re-read from this DEM. */
  draped: TrackGeometryPayload;
}

export interface LoadProgress {
  done: number;
  total: number;
}

async function fetchBitmap(url: string, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetch(url, { signal, mode: "cors" });
  if (!response.ok) throw new Error(`tile ${response.status}`);
  const blob = await response.blob();
  // No colour conversion and no premultiplication: for elevation tiles the RGB
  // bytes ARE the data, and a colour-managed decode would quietly move every
  // height by a few metres.
  return createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
}

/** Run `task` over `items` with bounded parallelism. Failures resolve to null. */
async function pool<T, R>(
  items: T[],
  task: (item: T) => Promise<R>,
  onSettle: () => void,
): Promise<(R | null)[]> {
  const results = new Array<R | null>(items.length).fill(null);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await task(items[index]);
      } catch (cause) {
        if ((cause as Error)?.name === "AbortError") throw cause;
        results[index] = null;
      }
      onSettle();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

interface TileRef {
  x: number;
  y: number;
}

function tilesOf(window: TileWindow): TileRef[] {
  const tiles: TileRef[] = [];
  for (let y = window.y0; y <= window.y1; y += 1) {
    for (let x = window.x0; x <= window.x1; x += 1) tiles.push({ x, y });
  }
  return tiles;
}

function makeDem(
  window: TileWindow,
  heights: Float32Array,
  origin: { lat: number; lon: number },
  real: boolean,
): Dem {
  const projection = makeProjection(origin);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < heights.length; i += 1) {
    if (heights[i] < min) min = heights[i];
    if (heights[i] > max) max = heights[i];
  }
  const { width, height, zoom, x0, y0 } = window;
  return {
    window,
    heights,
    min,
    max,
    real,
    sample(eastM, northM) {
      // Pixel centres sit at +0.5, hence the half-pixel shift before the lerp.
      const px = (tileX(projection.toLon(eastM), zoom) - x0) * TILE_PX - 0.5;
      const py = (tileY(projection.toLat(northM), zoom) - y0) * TILE_PX - 0.5;
      const cx = Math.min(width - 1.001, Math.max(0, px));
      const cy = Math.min(height - 1.001, Math.max(0, py));
      const ix = Math.floor(cx);
      const iy = Math.floor(cy);
      const fx = cx - ix;
      const fy = cy - iy;
      const a = heights[iy * width + ix];
      const b = heights[iy * width + ix + 1];
      const c = heights[(iy + 1) * width + ix];
      const d = heights[(iy + 1) * width + ix + 1];
      return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    },
  };
}

/**
 * Re-read the lap's elevation from the scenery DEM.
 *
 * The payload's own profile comes from a different dataset (EU-DEM via
 * OpenTopoData) and has been filtered for the elevation chart. Drawn over this
 * DEM it would hover above the ground in one place and sink through it in
 * another. Sampling the same surface the terrain mesh is built from makes the
 * two agree everywhere, by construction. The chart keeps the original payload.
 */
function drape(payload: TrackGeometryPayload, dem: Dem): TrackGeometryPayload {
  const count = payload.e_dm.length;
  const raw = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    raw[i] = dem.sample(payload.e_dm[i] / 10, payload.n_dm[i] / 10) - payload.z_ref_m;
  }
  // A short circular mean: a 2 m lidar DEM carries kerb- and drain-sized ripple
  // that the chase camera would otherwise ride over like cobbles.
  const half = Math.max(1, Math.round(15 / payload.sample_spacing_m));
  const u_dm = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    for (let k = -half; k <= half; k += 1) sum += raw[(i + k + count) % count];
    u_dm[i] = Math.round((sum / (2 * half + 1)) * 10);
  }
  return { ...payload, u_dm, terrain: null, bank_ddeg: null };
}

export async function loadRealWorld(
  payload: TrackGeometryPayload,
  quality: ImageryQuality,
  signal: AbortSignal,
  onProgress: (progress: LoadProgress) => void,
): Promise<RealWorldData> {
  // Scenery first: when it exists its bounds are authoritative, so the baked
  // buildings and the fetched tiles cover exactly the same rectangle.
  let scenery: TrackSceneryPayload | null = null;
  for (const url of trackSceneryUrls(payload.id)) {
    try {
      const response = await fetch(url, { signal });
      if (!response.ok) continue;
      scenery = (await response.json()) as TrackSceneryPayload;
      break;
    } catch (cause) {
      if ((cause as Error)?.name === "AbortError") throw cause;
      // A malformed or blocked copy is the same as a missing one: try the next.
    }
  }

  const origin = payload.origin;
  const bounds = scenery?.bounds ?? sceneryBounds(payload);
  const projection = makeProjection(origin);

  const imageryWindow = pickZoom(
    bounds,
    origin,
    Math.min(IMAGERY_MAX_PX[quality], deviceTextureLimit()),
    IMAGERY_MAX_ZOOM,
  );
  const demWindow = pickZoom(bounds, origin, ELEVATION_MAX_PX, ELEVATION_MAX_ZOOM);
  const imageryTiles = tilesOf(imageryWindow);
  const demTiles = tilesOf(demWindow);

  const total = imageryTiles.length + demTiles.length;
  let done = 0;
  const tick = () => {
    done += 1;
    onProgress({ done, total });
  };
  onProgress({ done, total });

  // --- elevation -----------------------------------------------------------
  const demCanvas = document.createElement("canvas");
  demCanvas.width = demWindow.width;
  demCanvas.height = demWindow.height;
  const demContext = demCanvas.getContext("2d", { willReadFrequently: true });
  if (!demContext) throw new Error("2d canvas unavailable");

  const demBitmaps = await pool(
    demTiles,
    (tile) =>
      fetchBitmap(`${ELEVATION_TILE_URL}/${demWindow.zoom}/${tile.x}/${tile.y}.png`, signal),
    tick,
  );
  const demComplete = demBitmaps.every(Boolean);
  demBitmaps.forEach((bitmap, index) => {
    if (!bitmap) return;
    const tile = demTiles[index];
    demContext.drawImage(
      bitmap,
      (tile.x - demWindow.x0) * TILE_PX,
      (tile.y - demWindow.y0) * TILE_PX,
    );
    bitmap.close();
  });

  const heights = new Float32Array(demWindow.width * demWindow.height);
  if (demComplete) {
    const pixels = demContext.getImageData(0, 0, demWindow.width, demWindow.height).data;
    for (let i = 0; i < heights.length; i += 1) {
      // Terrarium encoding: metres = R * 256 + G + B / 256 - 32768.
      heights[i] = pixels[i * 4] * 256 + pixels[i * 4 + 1] + pixels[i * 4 + 2] / 256 - 32768;
    }
  } else {
    // A partial DEM would put cliffs at the tile seams. Flat at the track's own
    // datum is honest and still a usable picture.
    heights.fill(payload.z_ref_m);
  }
  const dem = makeDem(demWindow, heights, origin, demComplete);

  // --- imagery -------------------------------------------------------------
  const imagery = document.createElement("canvas");
  imagery.width = imageryWindow.width;
  imagery.height = imageryWindow.height;
  const imageryContext = imagery.getContext("2d");
  if (!imageryContext) throw new Error("2d canvas unavailable");
  // Neutral ground for any tile that fails, rather than a black hole.
  imageryContext.fillStyle = "#5b5f52";
  imageryContext.fillRect(0, 0, imagery.width, imagery.height);

  let imageryFailed = 0;
  await pool(
    imageryTiles,
    async (tile) => {
      const bitmap = await fetchBitmap(
        imageryTileUrl(imageryWindow.zoom, tile.x, tile.y, scenery?.imagery_release),
        signal,
      );
      imageryContext.drawImage(
        bitmap,
        (tile.x - imageryWindow.x0) * TILE_PX,
        (tile.y - imageryWindow.y0) * TILE_PX,
      );
      bitmap.close();
      return true;
    },
    tick,
  ).then((results) => {
    imageryFailed = results.filter((ok) => !ok).length;
  });

  const uv = (eastM: number, northM: number): [number, number] => {
    const px = (tileX(projection.toLon(eastM), imageryWindow.zoom) - imageryWindow.x0) * TILE_PX;
    const py = (tileY(projection.toLat(northM), imageryWindow.zoom) - imageryWindow.y0) * TILE_PX;
    // CanvasTexture flips Y, so the canvas's top row is v = 1.
    return [px / imageryWindow.width, 1 - py / imageryWindow.height];
  };

  return {
    geometryId: payload.id,
    quality,
    metresPerPixel:
      (156543.03392 * Math.cos((origin.lat * Math.PI) / 180)) / 2 ** imageryWindow.zoom,
    bounds,
    origin,
    imagery,
    imageryWindow,
    imageryFailed,
    uv,
    dem,
    scenery,
    draped: drape(payload, dem),
  };
}
