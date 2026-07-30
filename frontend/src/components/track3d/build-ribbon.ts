/**
 * Pure geometry construction from a baked track payload.
 *
 * No React and no three.js scene here beyond BufferGeometry, so this stays
 * testable and cheap to reason about.
 *
 * THE ONE PLACE ENU BECOMES WORLD SPACE. The payload is East / North / Up;
 * three.js is Y-up right-handed. The mapping is:
 *
 *     world.x =  east
 *     world.y =  up          (elevation)
 *     world.z = -north
 *
 * Negating north keeps the frame right-handed, which matters: with a naive
 * `z = +north` the cross products below flip and the ribbon's left and right
 * edges swap, so per-sample widths and banking get applied to the wrong sides.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Vector3,
} from "three";

import type { TrackGeometryPayload } from "@/lib/circuit-geometry";

const WORLD_UP = new Vector3(0, 1, 0);

export interface TrackFrames {
  /** Sample count (not including the duplicated seam vertex). */
  count: number;
  /** Arc length per sample, metres. `s_i = i * spacing`. */
  spacing: number;
  /** Total lap length, metres. */
  length: number;
  /** Centreline in world space, 3 floats per sample. */
  center: Float32Array;
  /** Unit tangents, 3 floats per sample. */
  tangent: Float32Array;
  /** Unit surface normals (after banking roll), 3 floats per sample. */
  normal: Float32Array;
  /** Unit lateral vectors pointing to the racing right-hand side. */
  lateral: Float32Array;
  /** Gradient as a fraction (0.07 == 7%). */
  grade: Float32Array;
  halfWidthLeft: Float32Array;
  halfWidthRight: Float32Array;
  /** Bounding box in world space. */
  min: Vector3;
  max: Vector3;
  center2d: Vector3;
  /** Diagonal of the horizontal bounding box — drives fog and camera framing. */
  diagonal: number;
  elevationRange: number;
}

function vecAt(array: Float32Array, index: number, out: Vector3): Vector3 {
  return out.set(array[index * 3], array[index * 3 + 1], array[index * 3 + 2]);
}

/**
 * Decode the payload and build per-sample coordinate frames.
 *
 * Tangents use a central difference with wrap-around, which is why the payload's
 * ring must not carry a duplicated endpoint — it does not.
 */
export function buildFrames(
  payload: TrackGeometryPayload,
  widthScale = 1,
): TrackFrames {
  const count = payload.e_dm.length;
  const spacing = payload.sample_spacing_m;

  const center = new Float32Array(count * 3);
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);

  for (let i = 0; i < count; i += 1) {
    const x = payload.e_dm[i] / 10;
    const y = payload.u_dm[i] / 10;
    const z = -payload.n_dm[i] / 10;
    center[i * 3] = x;
    center[i * 3 + 1] = y;
    center[i * 3 + 2] = z;
    min.x = Math.min(min.x, x);
    min.y = Math.min(min.y, y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  }

  const tangent = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const lateral = new Float32Array(count * 3);
  const grade = new Float32Array(count);
  const halfWidthLeft = new Float32Array(count);
  const halfWidthRight = new Float32Array(count);

  const previous = new Vector3();
  const next = new Vector3();
  const t = new Vector3();
  const b = new Vector3();
  const n = new Vector3();

  for (let i = 0; i < count; i += 1) {
    vecAt(center, (i - 1 + count) % count, previous);
    vecAt(center, (i + 1) % count, next);
    t.subVectors(next, previous);
    if (t.lengthSq() < 1e-12) t.set(1, 0, 0);
    t.normalize();

    // A racetrack can never be vertical, so T is never parallel to world up —
    // but guard anyway rather than emit NaNs into a vertex buffer.
    b.crossVectors(t, WORLD_UP);
    if (b.lengthSq() < 1e-9) b.crossVectors(t, new Vector3(0, 0, 1));
    b.normalize();
    n.crossVectors(b, t).normalize();

    // Curated banking rolls the lateral and normal vectors about the tangent.
    const bankDeg = payload.bank_ddeg ? payload.bank_ddeg[i] / 10 : 0;
    if (bankDeg !== 0) {
      const angle = (bankDeg * Math.PI) / 180;
      b.applyAxisAngle(t, angle);
      n.applyAxisAngle(t, angle);
    }

    tangent[i * 3] = t.x;
    tangent[i * 3 + 1] = t.y;
    tangent[i * 3 + 2] = t.z;
    lateral[i * 3] = b.x;
    lateral[i * 3 + 1] = b.y;
    lateral[i * 3 + 2] = b.z;
    normal[i * 3] = n.x;
    normal[i * 3 + 1] = n.y;
    normal[i * 3 + 2] = n.z;

    grade[i] = payload.grade_e4[i] / 1e4;
    // widthScale is presentation only. At whole-circuit framing a true 13.5 m
    // track across a 7 km lap is about four pixels wide, so kerbs, banking and
    // the racing line are all invisible until you zoom in. The viewer labels the
    // multiplier and offers a true-width toggle rather than hiding it.
    halfWidthLeft[i] =
      ((payload.half_width_dm_l?.[i] ?? payload.half_width_dm_const) / 10) * widthScale;
    halfWidthRight[i] =
      ((payload.half_width_dm_r?.[i] ?? payload.half_width_dm_const) / 10) * widthScale;
  }

  const center2d = new Vector3(
    (min.x + max.x) / 2,
    (min.y + max.y) / 2,
    (min.z + max.z) / 2,
  );

  return {
    count,
    spacing,
    length: payload.length_m,
    center,
    tangent,
    normal,
    lateral,
    grade,
    halfWidthLeft,
    halfWidthRight,
    min,
    max,
    center2d,
    diagonal: Math.hypot(max.x - min.x, max.z - min.z),
    elevationRange: max.y - min.y,
  };
}

/**
 * Build the track surface as a two-vertices-per-sample ribbon.
 *
 * The seam sample is duplicated so `uv.x` runs a clean 0 -> 1 instead of wrapping
 * back to 0 across the start/finish line. Without that the shader's
 * reveal-by-distance would tear open a one-quad gap exactly where the intro
 * camera is pointed.
 */
export function buildRibbonGeometry(frames: TrackFrames): BufferGeometry {
  const { count, spacing } = frames;
  const rows = count + 1; // duplicated seam
  const vertexCount = rows * 2;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const dist = new Float32Array(vertexCount);
  const grade = new Float32Array(vertexCount);
  const side = new Float32Array(vertexCount);

  const p = new Vector3();
  const lat = new Vector3();
  const nrm = new Vector3();

  for (let row = 0; row < rows; row += 1) {
    const i = row % count;
    vecAt(frames.center, i, p);
    vecAt(frames.lateral, i, lat);
    vecAt(frames.normal, i, nrm);

    const s = row * spacing;
    const u = row / count;

    for (let edge = 0; edge < 2; edge += 1) {
      // edge 0 = racing left, edge 1 = racing right
      const width = edge === 0 ? -frames.halfWidthLeft[i] : frames.halfWidthRight[i];
      const v = row * 2 + edge;
      positions[v * 3] = p.x + lat.x * width;
      positions[v * 3 + 1] = p.y + lat.y * width;
      positions[v * 3 + 2] = p.z + lat.z * width;
      normals[v * 3] = nrm.x;
      normals[v * 3 + 1] = nrm.y;
      normals[v * 3 + 2] = nrm.z;
      uvs[v * 2] = u;
      uvs[v * 2 + 1] = edge;
      dist[v] = s;
      grade[v] = frames.grade[i];
      side[v] = edge === 0 ? -1 : 1;
    }
  }

  const indices = new Uint32Array(count * 6);
  for (let row = 0; row < count; row += 1) {
    const a = row * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    const o = row * 6;
    indices[o] = a;
    indices[o + 1] = c;
    indices[o + 2] = b;
    indices[o + 3] = b;
    indices[o + 4] = c;
    indices[o + 5] = d;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setAttribute("aDist", new BufferAttribute(dist, 1));
  geometry.setAttribute("aGrade", new BufferAttribute(grade, 1));
  geometry.setAttribute("aSide", new BufferAttribute(side, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Kerb strips: thin ribbons hugging each edge, offset outboard.
 *
 * Returned as one geometry per side so the stripe phase can differ, which is what
 * stops the two sides looking mirror-symmetric and fake.
 */
export function buildKerbGeometry(
  frames: TrackFrames,
  outboard: number,
  width: number,
  edge: -1 | 1,
): BufferGeometry {
  const { count, spacing } = frames;
  const rows = count + 1;
  const positions = new Float32Array(rows * 2 * 3);
  const normals = new Float32Array(rows * 2 * 3);
  const uvs = new Float32Array(rows * 2 * 2);
  const dist = new Float32Array(rows * 2);

  const p = new Vector3();
  const lat = new Vector3();
  const nrm = new Vector3();

  for (let row = 0; row < rows; row += 1) {
    const i = row % count;
    vecAt(frames.center, i, p);
    vecAt(frames.lateral, i, lat);
    vecAt(frames.normal, i, nrm);
    const half = edge === -1 ? frames.halfWidthLeft[i] : frames.halfWidthRight[i];
    const inner = edge * (half + outboard);
    const outer = edge * (half + outboard + width);

    for (let k = 0; k < 2; k += 1) {
      const offset = k === 0 ? inner : outer;
      const v = row * 2 + k;
      // Kerbs sit a few centimetres above the surface to avoid z-fighting.
      positions[v * 3] = p.x + lat.x * offset + nrm.x * 0.04;
      positions[v * 3 + 1] = p.y + lat.y * offset + nrm.y * 0.04;
      positions[v * 3 + 2] = p.z + lat.z * offset + nrm.z * 0.04;
      normals[v * 3] = nrm.x;
      normals[v * 3 + 1] = nrm.y;
      normals[v * 3 + 2] = nrm.z;
      uvs[v * 2] = row / count;
      uvs[v * 2 + 1] = k;
      dist[v] = row * spacing;
    }
  }

  const indices = new Uint32Array(count * 6);
  for (let row = 0; row < count; row += 1) {
    const a = row * 2;
    const o = row * 6;
    indices[o] = a;
    indices[o + 1] = a + 2;
    indices[o + 2] = a + 1;
    indices[o + 3] = a + 1;
    indices[o + 4] = a + 2;
    indices[o + 5] = a + 3;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setAttribute("aDist", new BufferAttribute(dist, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Terrain mesh from the DEM grid.
 *
 * The grid is row-major with row = north index, and world z is -north, so rows
 * are emitted in reverse to keep triangle winding consistent with the ribbon.
 */
export function buildTerrainGeometry(payload: TrackGeometryPayload): BufferGeometry | null {
  const terrain = payload.terrain;
  if (!terrain) return null;

  const { nx, ny, spacing_m: step, origin_e_m: originE, origin_n_m: originN } = terrain;
  const positions = new Float32Array(nx * ny * 3);

  for (let row = 0; row < ny; row += 1) {
    for (let col = 0; col < nx; col += 1) {
      const index = row * nx + col;
      positions[index * 3] = originE + col * step;
      positions[index * 3 + 1] = terrain.u_dm[index] / 10;
      positions[index * 3 + 2] = -(originN + row * step);
    }
  }

  const quads = (nx - 1) * (ny - 1);
  const indices = new Uint32Array(quads * 6);
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

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Racing line as a closed curve, lifted onto the track surface.
 *
 * The payload carries only e/n for the racing line, so elevation is sampled from
 * the nearest centreline point rather than shipped twice.
 */
export function buildRacelineCurve(
  payload: TrackGeometryPayload,
  frames: TrackFrames,
  lift = 0.25,
): CatmullRomCurve3 | null {
  if (!payload.raceline) return null;
  const { e_dm: eastDm, n_dm: northDm } = payload.raceline;
  const points: Vector3[] = [];
  const probe = new Vector3();

  for (let i = 0; i < eastDm.length; i += 1) {
    const x = eastDm[i] / 10;
    const z = -northDm[i] / 10;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let j = 0; j < frames.count; j += 1) {
      const dx = frames.center[j * 3] - x;
      const dz = frames.center[j * 3 + 2] - z;
      const d = dx * dx + dz * dz;
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = j;
      }
    }
    vecAt(frames.normal, bestIndex, probe);
    points.push(
      new Vector3(
        x + probe.x * lift,
        frames.center[bestIndex * 3 + 1] + probe.y * lift,
        z + probe.z * lift,
      ),
    );
  }

  return new CatmullRomCurve3(points, true, "centripetal", 0.5);
}

/** Sample index for an arc-length position, wrapping the lap. */
export function indexForDistance(frames: TrackFrames, metres: number): number {
  const wrapped = ((metres % frames.length) + frames.length) % frames.length;
  return Math.min(frames.count - 1, Math.round(wrapped / frames.spacing));
}
