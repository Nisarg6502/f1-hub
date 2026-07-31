/**
 * Client for the on-demand track-geometry build API (CP57).
 *
 * Three endpoints: ask what already exists, ask for a circuit to be built, and
 * poll how that build is going. The response shapes here mirror the backend's
 * frozen contract exactly — see `backend/app/track_geometry.py`.
 */

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export type TrackBuildStatus = "queued" | "running" | "done" | "failed";

export interface TrackBuildDoc {
  circuit_id: string;
  status: TrackBuildStatus;
  phase: string | null;
  progress_pct: number | null;
  /** User-facing, written by the build job. Rendered verbatim. */
  message: string | null;
  started_at: string | null;
  updated_at: string | null;
  error: string | null;
  ergast_circuit_id?: string | null;
  display_name?: string | null;
  /** Only present once `status === "done"`. */
  url?: string;
}

export interface AvailableCircuit {
  circuit_id: string;
  ergast_circuit_id: string;
  display_name: string;
  url: string;
}

export interface TrackGeometryAvailability {
  circuits: AvailableCircuit[];
  /** Every curated spec — what a Generate button may be offered for. */
  buildable: string[];
  /**
   * The bucket listing failed. The answer is stale or empty, so callers must
   * keep whatever they were already showing rather than hiding tracks.
   */
  degraded: boolean;
}

/**
 * Outcome of asking for a build.
 *
 * A discriminated union rather than throwing on non-2xx: every one of these is
 * an expected, actionable answer the UI has to render differently, not an
 * exception. "Someone else is already building Silverstone" is information.
 */
export type StartBuildResult =
  | { kind: "started"; build: TrackBuildDoc }
  | { kind: "already-built"; build: TrackBuildDoc }
  | {
      kind: "busy";
      circuitId: string | null;
      displayName: string | null;
      /** True when the user re-clicked the circuit that is already building. */
      sameCircuit: boolean;
      message: string;
    }
  | { kind: "unknown-circuit"; message: string }
  | { kind: "error"; message: string };

const GENERIC_ERROR =
  "Could not start the geometry build. Please try again in a moment.";

/**
 * Client-side ceiling on the build request.
 *
 * The backend can genuinely take tens of seconds to answer when Mongo is slow —
 * its driver's server-selection timeout defaults to 30 s and `/build` makes more
 * than one round trip — and a button that sits on "Starting…" indefinitely reads
 * as broken. Abort and say so instead. The build may still have been queued, so
 * the wording never claims it definitely was not.
 */
const START_TIMEOUT_MS = 20_000;

const TIMEOUT_MESSAGE =
  "The server took too long to answer. The build may still have started — reload in a moment to check.";

/**
 * What already exists, and what could be built.
 *
 * Never throws — availability is used to decide what to render, and a failed
 * lookup must degrade to "keep showing what we had" rather than blanking the
 * page. A thrown error here would take down a circuit page whose geometry is
 * perfectly loadable.
 */
export async function fetchTrackGeometryAvailability(
  options?: RequestInit,
): Promise<TrackGeometryAvailability> {
  try {
    const response = await fetch(
      new URL("/api/track_geometry/available", API_BASE_URL).toString(),
      { next: { revalidate: 30 }, ...options },
    );
    if (!response.ok) return { circuits: [], buildable: [], degraded: true };
    const data = (await response.json()) as TrackGeometryAvailability;
    return {
      circuits: Array.isArray(data.circuits) ? data.circuits : [],
      buildable: Array.isArray(data.buildable) ? data.buildable : [],
      degraded: Boolean(data.degraded),
    };
  } catch {
    return { circuits: [], buildable: [], degraded: true };
  }
}

export async function startTrackGeometryBuild(
  circuitId: string,
): Promise<StartBuildResult> {
  let response: Response;
  try {
    response = await fetch(
      new URL("/api/track_geometry/build", API_BASE_URL).toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ circuit_id: circuitId }),
        signal: AbortSignal.timeout(START_TIMEOUT_MS),
      },
    );
  } catch (cause) {
    const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
    return { kind: "error", message: timedOut ? TIMEOUT_MESSAGE : GENERIC_ERROR };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Fall through — status code alone still tells us what happened.
  }

  const build = body.build as TrackBuildDoc | undefined;

  if (response.status === 202 && build) return { kind: "started", build };
  if (response.status === 200 && build) return { kind: "already-built", build };

  if (response.status === 409) {
    return {
      kind: "busy",
      circuitId: (body.circuit_id as string) ?? null,
      displayName: (body.display_name as string) ?? null,
      sameCircuit: Boolean(body.same_circuit),
      message:
        (body.message as string) ??
        "Another circuit is being generated right now. Try again once it finishes.",
    };
  }

  if (response.status === 404) {
    return {
      kind: "unknown-circuit",
      message:
        (body.message as string) ??
        "This circuit cannot be generated — no geometry recipe exists for it yet.",
    };
  }

  return { kind: "error", message: (body.message as string) ?? GENERIC_ERROR };
}

export type TrackGeometryState =
  /** A payload exists and the viewer can load it now. */
  | "ready"
  /** No payload yet, but a curated recipe exists — offer to generate it. */
  | "buildable"
  /** No recipe. Nothing to show and nothing to offer. */
  | "unavailable";

export interface ResolvedTrackGeometry {
  state: TrackGeometryState;
  /** The build key, which is also the payload filename. */
  geometryId: string | null;
  /** Absolute payload URL when `state === "ready"`. */
  url: string | null;
  displayName: string | null;
}

/**
 * Decide what a circuit page should show.
 *
 * Live availability wins, but a bundled payload is always treated as ready even
 * when the API says otherwise. The four Batch 15 circuits ship inside the
 * frontend image and were never uploaded to the bucket, so trusting the bucket
 * listing alone would take four working circuits offline the moment this
 * shipped — and would do it again any time the listing degraded.
 */
export function resolveTrackGeometry(
  circuitId: string,
  availability: TrackGeometryAvailability,
  bundledId: string | null,
): ResolvedTrackGeometry {
  const wanted = circuitId.toLowerCase();
  const match = availability.circuits.find(
    (entry) =>
      entry.ergast_circuit_id?.toLowerCase() === wanted ||
      entry.circuit_id?.toLowerCase() === wanted,
  );

  if (match) {
    return {
      state: "ready",
      geometryId: match.circuit_id,
      url: match.url,
      displayName: match.display_name ?? null,
    };
  }

  if (bundledId) {
    return {
      state: "ready",
      geometryId: bundledId,
      url: null, // let trackGeometryUrl fall back to the bundled path
      displayName: null,
    };
  }

  if (availability.buildable.some((key) => key.toLowerCase() === wanted)) {
    return { state: "buildable", geometryId: wanted, url: null, displayName: null };
  }

  return { state: "unavailable", geometryId: null, url: null, displayName: null };
}

/**
 * Availability for client components, fetched at most once per page load.
 *
 * The circuit gallery renders a modal per card; each asking the backend
 * independently would be a burst of identical requests for a value that cannot
 * change between them.
 */
let clientAvailability: Promise<TrackGeometryAvailability> | null = null;

export function getClientTrackGeometryAvailability(): Promise<TrackGeometryAvailability> {
  clientAvailability ??= fetchTrackGeometryAvailability({ cache: "no-store" });
  return clientAvailability;
}

/** Drop the cache after a build finishes, so the new payload is picked up. */
export function invalidateClientTrackGeometryAvailability(): void {
  clientAvailability = null;
}

/** Current build state, or null if this circuit has never been queued. */
export async function fetchTrackBuildStatus(
  circuitId: string,
): Promise<TrackBuildDoc | null> {
  try {
    const url = new URL("/api/track_geometry/status", API_BASE_URL);
    url.searchParams.set("circuit_id", circuitId);
    const response = await fetch(url.toString(), { cache: "no-store" });
    if (!response.ok) return null;
    const data = (await response.json()) as { build?: TrackBuildDoc };
    return data.build ?? null;
  } catch {
    return null;
  }
}
