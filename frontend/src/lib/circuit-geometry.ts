/**
 * Types and lookup for the baked 3D track geometry.
 *
 * The payloads are static files under `public/tracks/`, produced offline by
 * `scripts/build_track_geometry.py` from openly-licensed sources (centrelines
 * from bacinger/f1-circuits, elevation from OpenTopoData, widths and racing line
 * from TUMFTM/racetrack-database). They never change per race weekend, so they
 * are not served through the backend like everything else in `lib/api.ts` — see
 * `scripts/README.md`.
 *
 * Coordinates are quantised integers in a local ENU frame:
 *   e_dm  east, decimetres
 *   n_dm  north, decimetres
 *   u_dm  up, decimetres above `z_ref_m`
 *
 * Deliberately NOT named x/y/z: in ENU "y" is north, in three.js "y" is up, and
 * conflating the two is a guaranteed bug. The single ENU -> world conversion
 * lives in `components/track3d/build-ribbon.ts` and nowhere else.
 */

export interface TrackHighlight {
  id: string;
  name: string;
  kind: "climb" | "descent" | "compression" | "crest" | "banking";
  s_start_m: number;
  s_end_m: number;
  run_m: number;
  delta_z_m: number;
  gradient_pct: number;
  blurb: string;
  expected_dz_m?: [number, number];
  within_expectation?: boolean;
}

export interface TrackCorner {
  name: string;
  s_m: number;
  /** Apex radius in metres — smaller is tighter. */
  radius_m: number;
  direction: "left" | "right";
}

export interface TrackSegment {
  s_start_m: number;
  s_end_m: number;
  delta_z_m: number;
  gradient_pct: number;
  kind: "climb" | "descent";
}

export interface TrackElevationStats {
  min_m: number;
  max_m: number;
  total_change_m: number;
  cumulative_ascent_m: number;
  cumulative_descent_m: number;
  max_gradient_pct: number;
  min_gradient_pct: number;
  /** Gradients are measured over this baseline, so quote it rather than implying per-metre. */
  gradient_baseline_m: number;
  /**
   * Grades the elevation DATA (noise, outliers, closure drift, inter-dataset
   * spread) — not agreement with a published figure, which is reported
   * separately as `published_ratio`. Clean data that disagrees with a published
   * scalar is still clean data.
   */
  confidence: "high" | "medium" | "low" | "curated";
  confidence_reasons: string[];
  source: string;
  published_change_m: number | null;
  published_ratio: number | null;
  published_source: string;
}

export interface TrackTerrain {
  origin_e_m: number;
  origin_n_m: number;
  spacing_m: number;
  nx: number;
  ny: number;
  /** Row-major (row = north index), decimetres above `z_ref_m`. */
  u_dm: number[];
}

export interface TrackGeometryPayload {
  version: number;
  id: string;
  ergast_circuit_id: string;
  geojson_id: string;
  name: string;
  country: string;
  locality: string;
  length_m: number;
  length_m_published: number | null;
  /** Arc length per sample. `s_i = i * sample_spacing_m` exactly, so no `s` array ships. */
  sample_spacing_m: number;
  closed: boolean;
  origin: { lat: number; lon: number };
  /** Absolute metres above sea level corresponding to `u_dm === 0`. */
  z_ref_m: number;
  e_dm: number[];
  n_dm: number[];
  u_dm: number[];
  /** Along-track gradient x 1e4, so 700 means +7.00%. */
  grade_e4: number[];
  /** Signed curvature x 1e4, in 1/m. */
  curv_e4: number[];
  half_width_dm_const: number;
  half_width_dm_l: number[] | null;
  half_width_dm_r: number[] | null;
  /** Curated banking in tenths of a degree, or null where none is known. */
  bank_ddeg: number[] | null;
  raceline: { e_dm: number[]; n_dm: number[] } | null;
  terrain: TrackTerrain | null;
  elevation: TrackElevationStats;
  /**
   * Named corners, snapped to detected curvature apexes.
   *
   * Only famous, unambiguous corners are named — this is not an attempt to
   * reproduce official corner numbering, which merges multi-apex complexes and
   * does not correspond to raw curvature peaks.
   */
  corners: TrackCorner[];
  highlights: TrackHighlight[];
  segments: TrackSegment[];
  diagnostics: Record<string, unknown>;
  sources: Record<string, string | null>;
  notes: string;
}

/**
 * Ergast `circuitId` -> geometry file id, for the circuits baked offline in
 * Batch 15 and committed to `frontend/public/tracks/`.
 *
 * This is NO LONGER the list of what the viewer can show — that is now runtime
 * state, since a payload can be generated on demand into GCS (see
 * `lib/track-geometry-api.ts`). It survives as a **safety net**: these four
 * ship inside the frontend image, so they must stay reachable even if the
 * bucket listing fails or the payloads have not been uploaded to GCS yet.
 * Without it, a degraded `/available` response would make four working circuits
 * silently disappear.
 */
const BUNDLED_GEOMETRY_BY_CIRCUIT_ID: Record<string, string> = {
  spa: "spa",
  americas: "americas",
  interlagos: "interlagos",
  zandvoort: "zandvoort",
};

/** Only the circuits whose payload is committed to the frontend image. */
export function getBundledTrackGeometryId(
  circuitId?: string | null,
): string | null {
  if (!circuitId) return null;
  return BUNDLED_GEOMETRY_BY_CIRCUIT_ID[circuitId.toLowerCase()] ?? null;
}

/**
 * @deprecated Bundled payloads only — it cannot see anything generated on
 * demand. Prefer `resolveTrackGeometry` in `lib/track-geometry.ts`, which
 * combines this with live availability.
 */
export function getTrackGeometryId(circuitId?: string | null): string | null {
  return getBundledTrackGeometryId(circuitId);
}

const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE_URL ?? "";

/**
 * Where to fetch a payload from.
 *
 * `explicitUrl` is the absolute URL the availability endpoint reported for a
 * circuit and always wins — it is the authoritative location of a payload that
 * actually exists. Everything else falls back to the bundled copy under
 * `public/tracks/`, which is what keeps local development working with no
 * bucket and no backend configured at all.
 */
export function trackGeometryUrl(
  geometryId: string,
  explicitUrl?: string | null,
): string {
  if (explicitUrl) return explicitUrl;
  if (getBundledTrackGeometryId(geometryId)) return `/tracks/${geometryId}.json`;
  return ASSET_BASE
    ? `${ASSET_BASE}/tracks/${geometryId}.json`
    : `/tracks/${geometryId}.json`;
}

/** Circuits whose payload ships in the frontend image. */
export function listTrackGeometryIds(): string[] {
  return Object.values(BUNDLED_GEOMETRY_BY_CIRCUIT_ID);
}

/** Human-readable label for the confidence badge. */
export function describeConfidence(stats: TrackElevationStats): string {
  const dataset = stats.source;
  if (stats.confidence === "curated") return `Profile curated · ${dataset}`;
  return `${dataset} · confidence ${stats.confidence}`;
}
