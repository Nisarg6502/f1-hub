"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  trackGeometryUrl,
  type TrackGeometryPayload,
} from "@/lib/circuit-geometry";
import {
  buildFrames,
  buildKerbGeometry,
  buildRacelineCurve,
  buildRibbonGeometry,
  buildTerrainGeometry,
  type TrackFrames,
} from "./build-ribbon";

export interface TrackGeometryBundle {
  payload: TrackGeometryPayload;
  frames: TrackFrames;
  ribbon: ReturnType<typeof buildRibbonGeometry>;
  kerbLeft: ReturnType<typeof buildKerbGeometry>;
  kerbRight: ReturnType<typeof buildKerbGeometry>;
  terrain: ReturnType<typeof buildTerrainGeometry>;
  raceline: ReturnType<typeof buildRacelineCurve>;
}

/**
 * Fetch a baked track payload.
 *
 * Client-side rather than read from disk in the server component: the payload is
 * 26-63 KB and would otherwise be inlined into the RSC stream on every
 * navigation, whereas fetched from `public/` the browser and CDN cache it.
 */
export function useTrackPayload(geometryId: string | null) {
  // The loaded id is stored alongside the result rather than being cleared in the
  // effect body. Resetting state synchronously inside an effect triggers a
  // cascading render; deriving staleness during render instead means every
  // setState here happens in an async callback.
  const [state, setState] = useState<{
    id: string | null;
    payload: TrackGeometryPayload | null;
    error: Error | null;
  }>({ id: null, payload: null, error: null });

  useEffect(() => {
    if (!geometryId) return;
    let cancelled = false;

    fetch(trackGeometryUrl(geometryId))
      .then((response) => {
        if (!response.ok) throw new Error(`track geometry ${response.status}`);
        return response.json() as Promise<TrackGeometryPayload>;
      })
      .then((data) => {
        if (!cancelled) setState({ id: geometryId, payload: data, error: null });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            id: geometryId,
            payload: null,
            error: cause instanceof Error ? cause : new Error(String(cause)),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [geometryId]);

  const fresh = state.id === geometryId;
  return {
    payload: fresh ? state.payload : null,
    error: fresh ? state.error : null,
  };
}

/**
 * Derive every GPU buffer from a payload, once.
 *
 * Geometries are disposed when the payload changes — three.js buffers live on the
 * GPU and are not garbage collected, so switching circuits without this leaks
 * until the context is lost.
 */
export function useTrackGeometry(
  payload: TrackGeometryPayload | null,
  widthScale = 1,
): TrackGeometryBundle | null {
  const bundle = useMemo(() => {
    if (!payload) return null;
    const frames = buildFrames(payload, widthScale);
    // Kerbs and the racing line scale with the ribbon so the proportions stay
    // right at any width multiplier.
    return {
      payload,
      frames,
      ribbon: buildRibbonGeometry(frames),
      kerbLeft: buildKerbGeometry(frames, 0.1 * widthScale, 1.1 * widthScale, -1),
      kerbRight: buildKerbGeometry(frames, 0.1 * widthScale, 1.1 * widthScale, 1),
      terrain: buildTerrainGeometry(payload),
      raceline: buildRacelineCurve(payload, frames, 0.25 * widthScale),
    };
  }, [payload, widthScale]);

  const previous = useRef<TrackGeometryBundle | null>(null);
  useEffect(() => {
    const stale = previous.current;
    previous.current = bundle;
    return () => {
      if (stale && stale !== bundle) {
        stale.ribbon.dispose();
        stale.kerbLeft.dispose();
        stale.kerbRight.dispose();
        stale.terrain?.dispose();
      }
    };
  }, [bundle]);

  return bundle;
}

/**
 * Shared scrub position along the lap, in metres.
 *
 * Deliberately a mutable ref plus a subscriber set rather than React state:
 * pointer moves over the elevation strip fire at up to 60 Hz, and putting that in
 * state would re-render the entire 3D tree on every event. `useFrame` reads
 * `current` directly; only discrete UI (labels, active highlight) subscribes.
 */
export class TrackScrubStore {
  current = 0;
  private listeners = new Set<(metres: number) => void>();

  set(metres: number) {
    this.current = metres;
    this.listeners.forEach((listener) => listener(metres));
  }

  subscribe(listener: (metres: number) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function useScrubStore() {
  return useMemo(() => new TrackScrubStore(), []);
}

/** Subscribe to the scrub position as React state, for text and badges only. */
export function useScrubValue(store: TrackScrubStore) {
  const [value, setValue] = useState(store.current);
  useEffect(() => store.subscribe(setValue), [store]);
  return value;
}

/**
 * Matches the `prefers-reduced-motion` gate used by `ember-canvas.tsx`.
 *
 * `useSyncExternalStore` rather than an effect: a media query IS an external
 * store, and subscribing to it this way avoids the cascading render that a
 * synchronous setState inside an effect would cause.
 */
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const query = window.matchMedia?.(REDUCED_MOTION_QUERY);
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false,
    () => false, // server: assume motion is fine, the client corrects on hydrate
  );
}

/**
 * Probe for WebGL2 before mounting a Canvas.
 *
 * A failed context inside r3f throws during render; probing first lets the page
 * fall back to the static outline plus the standalone elevation profile, which is
 * still genuinely informative.
 *
 * The probe is cached at module scope because `getSnapshot` must return a stable
 * value — creating a canvas on every render would both churn and return a new
 * result each time, which sends useSyncExternalStore into an infinite loop.
 */
let webglProbe: boolean | null = null;

function probeWebgl(): boolean {
  if (webglProbe === null) {
    try {
      webglProbe = Boolean(document.createElement("canvas").getContext("webgl2"));
    } catch {
      webglProbe = false;
    }
  }
  return webglProbe;
}

const noopSubscribe = () => () => {};

export function useWebglSupported(): boolean | null {
  return useSyncExternalStore(noopSubscribe, probeWebgl, () => null);
}
