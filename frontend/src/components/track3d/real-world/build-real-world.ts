/**
 * Pure geometry for the "Real world" mode.
 *
 * Same convention as `build-ribbon.ts`, the one place ENU becomes world space:
 *
 *     world.x =  east
 *     world.y =  up, metres above the payload's `z_ref_m`
 *     world.z = -north
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  ShapeUtils,
  Vector2,
} from "three";

import type { TrackGeometryPayload } from "@/lib/circuit-geometry";
import type { RealWorldData } from "./load-real-world";

/** Target vertex spacing. Finer than the DEM's own ~6 m pixels buys nothing. */
const TERRAIN_STEP_M = 7;
const TERRAIN_MAX_SIDE = 420;
/** How far the slab's sides drop below the lowest ground, in metres. */
const SKIRT_DEPTH_M = 45;

export interface TerrainGeometry {
  surface: BufferGeometry;
  skirt: BufferGeometry;
}

/**
 * The ground: a regular grid over the scenery bounds, lifted by the DEM and
 * UV-mapped into the imagery mosaic.
 *
 * UVs are computed per vertex through the real Mercator maths rather than
 * stretched linearly across the rectangle — Mercator Y is not linear in
 * latitude, and over a few kilometres the linear shortcut drifts the photo by
 * a couple of metres against the track, which is exactly the misalignment you
 * notice.
 */
export function buildTerrain(data: RealWorldData, zRef: number): TerrainGeometry {
  const { bounds, dem, uv } = data;
  const width = bounds.e_max_m - bounds.e_min_m;
  const depth = bounds.n_max_m - bounds.n_min_m;
  const nx = Math.min(TERRAIN_MAX_SIDE, Math.max(2, Math.round(width / TERRAIN_STEP_M) + 1));
  const ny = Math.min(TERRAIN_MAX_SIDE, Math.max(2, Math.round(depth / TERRAIN_STEP_M) + 1));

  const positions = new Float32Array(nx * ny * 3);
  const uvs = new Float32Array(nx * ny * 2);
  let lowest = Infinity;

  for (let row = 0; row < ny; row += 1) {
    const north = bounds.n_min_m + (depth * row) / (ny - 1);
    for (let col = 0; col < nx; col += 1) {
      const east = bounds.e_min_m + (width * col) / (nx - 1);
      const index = row * nx + col;
      const y = dem.sample(east, north) - zRef;
      positions[index * 3] = east;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = -north;
      const [u, v] = uv(east, north);
      uvs[index * 2] = u;
      uvs[index * 2 + 1] = v;
      if (y < lowest) lowest = y;
    }
  }

  const indices = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let o = 0;
  for (let row = 0; row < ny - 1; row += 1) {
    for (let col = 0; col < nx - 1; col += 1) {
      const a = row * nx + col;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices[o] = a;
      indices[o + 1] = b;
      indices[o + 2] = c;
      indices[o + 3] = b;
      indices[o + 4] = d;
      indices[o + 5] = c;
      o += 6;
    }
  }

  const surface = new BufferGeometry();
  surface.setAttribute("position", new BufferAttribute(positions, 3));
  surface.setAttribute("uv", new BufferAttribute(uvs, 2));
  surface.setIndex(new BufferAttribute(indices, 1));
  surface.computeVertexNormals();
  surface.computeBoundingSphere();

  // Skirt: walk the perimeter once and drop a wall from each edge vertex. It
  // turns a sheet floating in the sky into a solid block cut out of the earth.
  const perimeter: number[] = [];
  for (let col = 0; col < nx; col += 1) perimeter.push(col);
  for (let row = 1; row < ny; row += 1) perimeter.push(row * nx + nx - 1);
  for (let col = nx - 2; col >= 0; col -= 1) perimeter.push((ny - 1) * nx + col);
  for (let row = ny - 2; row >= 1; row -= 1) perimeter.push(row * nx);

  const floor = lowest - SKIRT_DEPTH_M;
  const count = perimeter.length;
  const skirtPositions = new Float32Array(count * 2 * 3);
  for (let i = 0; i < count; i += 1) {
    const source = perimeter[i] * 3;
    skirtPositions[i * 6] = positions[source];
    skirtPositions[i * 6 + 1] = positions[source + 1];
    skirtPositions[i * 6 + 2] = positions[source + 2];
    skirtPositions[i * 6 + 3] = positions[source];
    skirtPositions[i * 6 + 4] = floor;
    skirtPositions[i * 6 + 5] = positions[source + 2];
  }
  const skirtIndices = new Uint32Array(count * 6);
  for (let i = 0; i < count; i += 1) {
    const a = i * 2;
    const b = ((i + 1) % count) * 2;
    skirtIndices[i * 6] = a;
    skirtIndices[i * 6 + 1] = a + 1;
    skirtIndices[i * 6 + 2] = b;
    skirtIndices[i * 6 + 3] = b;
    skirtIndices[i * 6 + 4] = a + 1;
    skirtIndices[i * 6 + 5] = b + 1;
  }
  const skirt = new BufferGeometry();
  skirt.setAttribute("position", new BufferAttribute(skirtPositions, 3));
  skirt.setIndex(new BufferAttribute(skirtIndices, 1));
  skirt.computeBoundingSphere();

  return { surface, skirt };
}

export interface BuildingGeometry {
  /** Flat tops, UV-mapped into the imagery so each roof wears its own photo. */
  roofs: BufferGeometry;
  /** Vertical faces, vertex-coloured. */
  walls: BufferGeometry;
  count: number;
}

const WALL_TINT: Record<string, string> = {
  grandstand: "#8f969c",
  bleachers: "#8f969c",
  stadium: "#8f969c",
  industrial: "#a7a9a6",
  warehouse: "#a7a9a6",
  commercial: "#c3bdb2",
  hotel: "#c9c2b6",
  apartments: "#cbc4b8",
  garage: "#b3aea5",
  garages: "#b3aea5",
};
const WALL_TINT_DEFAULT = "#bdb7ac";

/** Clearance under anything that crosses the racing line, in metres. */
const SPAN_CLEARANCE_M = 5.5;
const SPAN_MIN_THICKNESS_M = 1.8;

/** Even-odd point-in-polygon on a flat [e, n, ...] decimetre ring. */
export function pointInRing(east: number, north: number, ring: number[]): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const ei = ring[i * 2] / 10;
    const ni = ring[i * 2 + 1] / 10;
    const ej = ring[j * 2] / 10;
    const nj = ring[j * 2 + 1] / 10;
    if (ni > north !== nj > north && east < ((ej - ei) * (north - ni)) / (nj - ni) + ei) {
      inside = !inside;
    }
  }
  return inside;
}

/** Twice the signed area of a flat decimetre ring, in m2. Positive is CCW in ENU. */
function ringArea2(ring: number[]): number {
  let sum = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    sum += (ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1]) / 100;
  }
  return sum;
}

/**
 * Extrude OSM footprints into boxes standing on the DEM.
 *
 * Built by hand rather than with ExtrudeGeometry: one merged buffer for every
 * roof and one for every wall is two draw calls for the whole circuit — which
 * matters in Monaco, where there are a couple of thousand of them — and the
 * roof needs imagery UVs that ExtrudeGeometry has no notion of.
 */
export function buildBuildings(data: RealWorldData, zRef: number): BuildingGeometry | null {
  const buildings = data.scenery?.buildings ?? [];
  if (buildings.length === 0) return null;

  const roofPositions: number[] = [];
  const roofUvs: number[] = [];
  const roofIndices: number[] = [];
  const wallPositions: number[] = [];
  const wallNormals: number[] = [];
  const wallColors: number[] = [];
  const wallIndices: number[] = [];
  const tint = new Color();
  let built = 0;
  const { bounds } = data;
  const track = data.draped;

  /** One ring's vertical faces. `facing` is +1 where the ring's left is solid. */
  const addWalls = (ring: number[], facing: number, base: number, top: number) => {
    const n = ring.length / 2;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      const ei = ring[i * 2] / 10;
      const ni = ring[i * 2 + 1] / 10;
      const ej = ring[j * 2] / 10;
      const nj = ring[j * 2 + 1] / 10;
      const de = ej - ei;
      const dn = nj - ni;
      const length = Math.hypot(de, dn);
      if (length < 0.05) continue;
      // Outward normal in ENU is (dn, -de) for a CCW ring; world z is -north.
      const nx = (facing * dn) / length;
      const nz = (facing * de) / length;
      const start = wallPositions.length / 3;
      wallPositions.push(ei, base, -ni, ej, base, -nj, ej, top, -nj, ei, top, -ni);
      for (let k = 0; k < 4; k += 1) wallNormals.push(nx, 0, nz);
      // Darker at the foot: a cheap stand-in for ambient occlusion that keeps
      // the boxes from looking like they were pasted onto the photo.
      const foot = 0.62;
      wallColors.push(
        tint.r * foot, tint.g * foot, tint.b * foot,
        tint.r * foot, tint.g * foot, tint.b * foot,
        tint.r, tint.g, tint.b,
        tint.r, tint.g, tint.b,
      );
      wallIndices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  };

  for (const building of buildings) {
    const ring = building.ring_dm;
    const n = ring.length / 2;
    if (n < 3) continue;
    const holes = building.holes_dm ?? [];

    let groundLow = Infinity;
    let groundHigh = -Infinity;
    let eMin = Infinity;
    let eMax = -Infinity;
    let nMin = Infinity;
    let nMax = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const east = ring[i * 2] / 10;
      const north = ring[i * 2 + 1] / 10;
      const ground = data.dem.sample(east, north) - zRef;
      if (ground < groundLow) groundLow = ground;
      if (ground > groundHigh) groundHigh = ground;
      if (east < eMin) eMin = east;
      if (east > eMax) eMax = east;
      if (north < nMin) nMin = north;
      if (north > nMax) nMax = north;
    }
    // The bake already drops footprints that straddle the edge of the slab;
    // this is the same rule for a payload baked against different bounds.
    if (
      eMin < bounds.e_min_m ||
      eMax > bounds.e_max_m ||
      nMin < bounds.n_min_m ||
      nMax > bounds.n_max_m
    ) {
      continue;
    }
    const area2 = ringArea2(ring);
    // Slivers and mapping debris: nothing under ~4 m2 reads as a building.
    if (Math.abs(area2) < 8) continue;

    // Anything whose footprint covers the racing line stands over it, whatever
    // it is tagged — a footbridge, the Fairmont above the Monaco tunnel, a
    // grandstand drawn a little too generously. Extruded from the ground like a
    // shed it becomes a wall across the circuit, so it is lifted clear instead
    // and the lap passes underneath. A courtyard (hole) does not count: the
    // track running through the middle of a stadium is not under its roof.
    let spanOver = -Infinity;
    for (let i = 0; i < track.e_dm.length; i += 1) {
      const e = track.e_dm[i] / 10;
      const nn = track.n_dm[i] / 10;
      if (e < eMin || e > eMax || nn < nMin || nn > nMax) continue;
      if (!pointInRing(e, nn, ring)) continue;
      if (holes.some((hole) => pointInRing(e, nn, hole))) continue;
      spanOver = Math.max(spanOver, track.u_dm[i] / 10);
    }
    const isSpan = spanOver > -Infinity;

    // The base is sunk to the lowest corner so nothing floats on a slope; the
    // roof is measured from the highest so the uphill wall still has height.
    const base = isSpan ? spanOver + SPAN_CLEARANCE_M : groundLow - 0.5;
    const top = isSpan
      ? Math.max(groundHigh + building.h_dm / 10, base + SPAN_MIN_THICKNESS_M)
      : groundHigh + building.h_dm / 10;

    const roofStart = roofPositions.length / 3;
    const contour: Vector2[] = [];
    const holeContours: Vector2[][] = [];
    const pushRoofRing = (source: number[], into: Vector2[]) => {
      for (let i = 0; i < source.length / 2; i += 1) {
        const east = source[i * 2] / 10;
        const north = source[i * 2 + 1] / 10;
        roofPositions.push(east, top, -north);
        const [u, v] = data.uv(east, north);
        roofUvs.push(u, v);
        into.push(new Vector2(east, north));
      }
    };
    pushRoofRing(ring, contour);
    for (const hole of holes) {
      const into: Vector2[] = [];
      pushRoofRing(hole, into);
      holeContours.push(into);
    }
    // Faces index into contour followed by each hole, the order just pushed.
    for (const face of ShapeUtils.triangulateShape(contour, holeContours)) {
      roofIndices.push(roofStart + face[0], roofStart + face[1], roofStart + face[2]);
    }

    tint.set(WALL_TINT[building.kind] ?? WALL_TINT_DEFAULT);
    addWalls(ring, area2 > 0 ? 1 : -1, base, top);
    // A hole's walls face into the hole, the opposite sense to an outer ring.
    for (const hole of holes) addWalls(hole, ringArea2(hole) > 0 ? -1 : 1, base, top);
    built += 1;
  }

  if (built === 0) return null;

  const roofs = new BufferGeometry();
  roofs.setAttribute("position", new BufferAttribute(new Float32Array(roofPositions), 3));
  roofs.setAttribute("uv", new BufferAttribute(new Float32Array(roofUvs), 2));
  roofs.setIndex(roofIndices);
  // Every roof is flat, so the normal is known; computing it would depend on
  // the triangulation's winding.
  const roofNormals = new Float32Array(roofPositions.length);
  for (let i = 1; i < roofNormals.length; i += 3) roofNormals[i] = 1;
  roofs.setAttribute("normal", new BufferAttribute(roofNormals, 3));
  roofs.computeBoundingSphere();

  const walls = new BufferGeometry();
  walls.setAttribute("position", new BufferAttribute(new Float32Array(wallPositions), 3));
  walls.setAttribute("normal", new BufferAttribute(new Float32Array(wallNormals), 3));
  walls.setAttribute("color", new BufferAttribute(new Float32Array(wallColors), 3));
  walls.setIndex(wallIndices);
  walls.computeBoundingSphere();

  return { roofs, walls, count: built };
}

export interface TreeInstances {
  count: number;
  /** Per tree: x, groundY, z, canopy radius, canopy height. */
  transforms: Float32Array;
  /** Per tree: r, g, b in linear space. */
  colors: Float32Array;
}

/** Deterministic PRNG so the same circuit grows the same wood on every load. */
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_TREES = 9000;
const TREE_PITCH_M = 9;
const TREE_PITCH_MAX_M = 60;

interface RingBox {
  ring: number[];
  eMin: number;
  eMax: number;
  nMin: number;
  nMax: number;
}

function boxOf(ring: number[]): RingBox {
  let eMin = Infinity;
  let eMax = -Infinity;
  let nMin = Infinity;
  let nMax = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    eMin = Math.min(eMin, ring[i] / 10);
    eMax = Math.max(eMax, ring[i] / 10);
    nMin = Math.min(nMin, ring[i + 1] / 10);
    nMax = Math.max(nMax, ring[i + 1] / 10);
  }
  return { ring, eMin, eMax, nMin, nMax };
}

const inBox = (east: number, north: number, box: RingBox) =>
  east >= box.eMin && east <= box.eMax && north >= box.nMin && north <= box.nMax;

/**
 * Trees: one per mapped `natural=tree`, plus a jittered grid filling each wood.
 *
 * The photo already shows the canopy from above; these give it height, so a
 * wood reads as a wood from the chase camera instead of a green stain.
 */
export function buildTrees(
  data: RealWorldData,
  payload: TrackGeometryPayload,
  zRef: number,
): TreeInstances | null {
  const scenery = data.scenery;
  if (!scenery) return null;
  const { bounds, dem } = data;
  const random = mulberry32(payload.e_dm.length * 7919 + scenery.buildings.length);

  // Keep the racing surface and its verges clear even where a wood polygon is
  // drawn loosely — at Spa the forest relation simply contains the circuit.
  const clearance = payload.half_width_dm_const / 10 + 12;
  const clearance2 = clearance * clearance;
  // Bucket the lap into a coarse grid so each candidate tree checks a handful
  // of samples instead of all of them: nine thousand trees against two thousand
  // samples is otherwise the slowest thing in the whole build.
  const cell = Math.max(clearance, 20);
  const grid = new Map<string, number[]>();
  for (let i = 0; i < payload.e_dm.length; i += 1) {
    const key = `${Math.floor(payload.e_dm[i] / 10 / cell)},${Math.floor(payload.n_dm[i] / 10 / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  }
  const nearTrack = (east: number, north: number) => {
    const cx = Math.floor(east / cell);
    const cy = Math.floor(north / cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const i of bucket) {
          const de = payload.e_dm[i] / 10 - east;
          const dn = payload.n_dm[i] / 10 - north;
          if (de * de + dn * dn < clearance2) return true;
        }
      }
    }
    return false;
  };

  const buildingBoxes = scenery.buildings.map((building) => boxOf(building.ring_dm));
  const holeBoxes = (scenery.wood_holes_dm ?? []).map(boxOf);
  const blocked = (east: number, north: number) => {
    if (east < bounds.e_min_m + 4 || east > bounds.e_max_m - 4) return true;
    if (north < bounds.n_min_m + 4 || north > bounds.n_max_m - 4) return true;
    if (nearTrack(east, north)) return true;
    // No trees growing through roofs, and none in mapped clearings.
    for (const box of buildingBoxes) {
      if (inBox(east, north, box) && pointInRing(east, north, box.ring)) return true;
    }
    for (const box of holeBoxes) {
      if (inBox(east, north, box) && pointInRing(east, north, box.ring)) return true;
    }
    return false;
  };

  const single: [number, number][] = [];
  for (let i = 0; i < scenery.trees_dm.length; i += 2) {
    const east = scenery.trees_dm[i] / 10;
    const north = scenery.trees_dm[i + 1] / 10;
    if (!blocked(east, north)) single.push([east, north]);
  }

  // A wood can be far bigger than the scenery rectangle; only the part inside
  // it is ever planted, so a 30 km forest costs no more than a copse.
  const woods = scenery.woods_dm.map(boxOf).map((box) => ({
    ...box,
    eMin: Math.max(box.eMin, bounds.e_min_m),
    eMax: Math.min(box.eMax, bounds.e_max_m),
    nMin: Math.max(box.nMin, bounds.n_min_m),
    nMax: Math.min(box.nMax, bounds.n_max_m),
  }));
  const woodArea = woods.reduce(
    (sum, box) => sum + Math.max(0, box.eMax - box.eMin) * Math.max(0, box.nMax - box.nMin),
    0,
  );
  // Choose the planting pitch from the area up front, so a forest circuit is
  // thinned evenly everywhere rather than planted densely until the budget
  // runs out and left bare beyond that point.
  const budget = Math.max(0, MAX_TREES - single.length);
  const pitch = Math.min(
    TREE_PITCH_MAX_M,
    Math.max(TREE_PITCH_M, Math.sqrt(woodArea / Math.max(1, budget))),
  );

  const planted: [number, number][] = [];
  for (const box of woods) {
    for (let north = box.nMin; north <= box.nMax; north += pitch) {
      for (let east = box.eMin; east <= box.eMax; east += pitch) {
        const e = east + (random() - 0.5) * pitch * 0.9;
        const n = north + (random() - 0.5) * pitch * 0.9;
        if (pointInRing(e, n, box.ring) && !blocked(e, n)) planted.push([e, n]);
      }
    }
  }

  const spots = single.concat(planted).slice(0, MAX_TREES);
  const count = spots.length;
  if (count === 0) return null;

  // Sparser planting means each tree stands for more canopy, so it grows —
  // a little. Scaled all the way up to cover the gap, a thinned forest turns
  // into a field of green boulders the size of the grandstands.
  const spread = Math.min(1.35, pitch / TREE_PITCH_M);
  const transforms = new Float32Array(count * 5);
  const colors = new Float32Array(count * 3);
  const leaf = new Color();
  for (let i = 0; i < count; i += 1) {
    const [east, north] = spots[i];
    const height = 7 + random() * 7;
    transforms[i * 5] = east;
    transforms[i * 5 + 1] = dem.sample(east, north) - zRef;
    transforms[i * 5 + 2] = -north;
    transforms[i * 5 + 3] = (2.6 + random() * 2.4) * (i < single.length ? 1 : spread);
    transforms[i * 5 + 4] = height * (i < single.length ? 1 : Math.sqrt(spread));
    // Dark, slightly desaturated greens — matched to how woodland photographs
    // from above, not to how a tree looks from the ground.
    leaf.setHSL(0.27 + random() * 0.06, 0.32 + random() * 0.14, 0.15 + random() * 0.08);
    colors[i * 3] = leaf.r;
    colors[i * 3 + 1] = leaf.g;
    colors[i * 3 + 2] = leaf.b;
  }
  return { count, transforms, colors };
}
