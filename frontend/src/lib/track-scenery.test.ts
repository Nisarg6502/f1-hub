import { describe, expect, it } from "vitest";

import type { TrackGeometryPayload } from "./circuit-geometry";
import {
  IMAGERY_TILE_URL,
  IMAGERY_WAYBACK_URL,
  imageryTileUrl,
  makeProjection,
  pickZoom,
  sceneryBounds,
  tileWindow,
  tileX,
  tileY,
} from "./track-scenery";

const SILVERSTONE = { lat: 52.0718241, lon: -1.0163502 };

/** Just the fields `sceneryBounds` reads. */
const lap = (east: number[], north: number[]) =>
  ({
    e_dm: east.map((m) => m * 10),
    n_dm: north.map((m) => m * 10),
  }) as unknown as TrackGeometryPayload;

describe("sceneryBounds", () => {
  it("keeps the whole lap inside, with at least 320 m to spare", () => {
    const bounds = sceneryBounds(lap([-500, 500, 0], [-900, 800, 0]));
    expect(bounds.e_min_m).toBeLessThanOrEqual(-500 - 320);
    expect(bounds.e_max_m).toBeGreaterThanOrEqual(500 + 320);
    expect(bounds.n_min_m).toBeLessThanOrEqual(-900 - 320);
    expect(bounds.n_max_m).toBeGreaterThanOrEqual(800 + 320);
  });

  it("grows the margin with the circuit, not just a fixed strip", () => {
    // A 6 km diagonal: 18% of it is well past the 320 m floor.
    const bounds = sceneryBounds(lap([-2400, 2400], [-1800, 1800]));
    expect(bounds.e_min_m).toBeCloseTo(-2400 - 0.18 * 6000, 6);
  });
});

describe("makeProjection", () => {
  it("is the inverse of scripts/trackgeo/project.py, not a spherical stand-in", () => {
    // enu_scales(52.0718241) from the Python side: metres per radian east and
    // north on the WGS84 ellipsoid. A spherical R = 6371 km disagrees with the
    // north figure by ~0.3%, which is five metres across a circuit.
    const ke = 3928659.82;
    const kn = 6375227.91;
    const projection = makeProjection(SILVERSTONE);
    const dLon = ((projection.toLon(1000) - SILVERSTONE.lon) * Math.PI) / 180;
    const dLat = ((projection.toLat(1000) - SILVERSTONE.lat) * Math.PI) / 180;
    expect(1000 / dLon / ke).toBeCloseTo(1, 4);
    expect(1000 / dLat / kn).toBeCloseTo(1, 4);
  });

  it("returns the origin at zero", () => {
    const projection = makeProjection(SILVERSTONE);
    expect(projection.toLat(0)).toBe(SILVERSTONE.lat);
    expect(projection.toLon(0)).toBe(SILVERSTONE.lon);
  });
});

describe("slippy tiles", () => {
  it("lands on the tile the elevation server actually serves for Silverstone", () => {
    // Fetched by hand while building this: terrarium/15/16291/10813.png.
    expect(Math.floor(tileX(SILVERSTONE.lon, 15))).toBe(16291);
    expect(Math.floor(tileY(SILVERSTONE.lat, 15))).toBe(10813);
  });

  it("runs Y southwards", () => {
    expect(tileY(53, 10)).toBeLessThan(tileY(52, 10));
  });

  it("covers the bounds with whole tiles", () => {
    const bounds = { e_min_m: -900, e_max_m: 850, n_min_m: -1285, n_max_m: 1150 };
    const window = tileWindow(bounds, SILVERSTONE, 17);
    const projection = makeProjection(SILVERSTONE);
    expect(window.x0).toBeLessThanOrEqual(tileX(projection.toLon(bounds.e_min_m), 17));
    expect(window.x1 + 1).toBeGreaterThanOrEqual(tileX(projection.toLon(bounds.e_max_m), 17));
    expect(window.y0).toBeLessThanOrEqual(tileY(projection.toLat(bounds.n_max_m), 17));
    expect(window.y1 + 1).toBeGreaterThanOrEqual(tileY(projection.toLat(bounds.n_min_m), 17));
    expect(window.width).toBe(window.tilesX * 256);
  });
});

describe("pickZoom", () => {
  const bounds = { e_min_m: -900, e_max_m: 850, n_min_m: -1285, n_max_m: 1150 };

  it("never exceeds the texture budget", () => {
    for (const maxPx of [1024, 4096, 8192]) {
      const window = pickZoom(bounds, SILVERSTONE, maxPx, 19);
      expect(Math.max(window.width, window.height)).toBeLessThanOrEqual(maxPx);
    }
  });

  it("gives HD exactly one more zoom level than standard here", () => {
    const standard = pickZoom(bounds, SILVERSTONE, 4096, 19);
    const hd = pickZoom(bounds, SILVERSTONE, 8192, 19);
    expect(standard.zoom).toBe(17);
    expect(hd.zoom).toBe(18);
  });

  it("drops a zoom level for a circuit twice the size", () => {
    const big = { e_min_m: -1800, e_max_m: 1700, n_min_m: -2570, n_max_m: 2300 };
    expect(pickZoom(big, SILVERSTONE, 4096, 19).zoom).toBe(16);
  });
});

describe("imageryTileUrl", () => {
  it("orders the path z/y/x, which is not the usual z/x/y", () => {
    expect(imageryTileUrl(17, 65165, 43288)).toBe(`${IMAGERY_TILE_URL}/17/43288/65165`);
  });

  it("reads a pinned release from Wayback", () => {
    expect(imageryTileUrl(17, 65165, 43288, 64001)).toBe(
      `${IMAGERY_WAYBACK_URL}/64001/17/43288/65165`,
    );
  });

  it("treats a null release as current", () => {
    expect(imageryTileUrl(3, 1, 2, null)).toBe(`${IMAGERY_TILE_URL}/3/2/1`);
  });
});
