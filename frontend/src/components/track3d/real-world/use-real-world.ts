"use client";

import { useEffect, useState } from "react";

import type { TrackGeometryPayload } from "@/lib/circuit-geometry";
import {
  loadRealWorld,
  type ImageryQuality,
  type RealWorldData,
} from "./load-real-world";

interface RealWorldState {
  id: string | null;
  /** The most recent successful load for `id`, at whatever quality it was. */
  data: RealWorldData | null;
  /** The quality whose load failed, so it is not retried in a loop. */
  failed: ImageryQuality | null;
  error: Error | null;
  /** 0..1 across every imagery and elevation tile of the load in flight. */
  progress: number;
  /** Which load `progress` describes, so a finished one never leaks into the next. */
  progressFor: ImageryQuality | null;
}

/**
 * Load the real-world scenery for a circuit, the first time it is asked for.
 *
 * Nothing is fetched until `enabled` goes true: this is ~150 map tiles (several
 * hundred at HD), and a visitor who never leaves the schematic view should not
 * pay for them. Once loaded the result is kept, so flipping modes is instant.
 *
 * Changing `quality` keeps the scene that is already on screen and swaps it
 * when the sharper mosaic has landed, rather than blanking the canvas for it.
 *
 * The loaded id is stored alongside the result and staleness is derived during
 * render, the same shape as `useTrackPayload` — every setState here happens in
 * an async callback, never synchronously in the effect body.
 */
export function useRealWorld(
  payload: TrackGeometryPayload | null,
  enabled: boolean,
  quality: ImageryQuality,
) {
  const [state, setState] = useState<RealWorldState>({
    id: null,
    data: null,
    failed: null,
    error: null,
    progress: 0,
    progressFor: null,
  });

  const payloadId = payload?.id ?? null;
  const fresh = state.id === payloadId;
  const settled =
    fresh && (state.data?.quality === quality || state.failed === quality);

  useEffect(() => {
    if (!enabled || !payload || settled) return;
    const controller = new AbortController();
    let lastStep = -1;

    loadRealWorld(payload, quality, controller.signal, ({ done, total }) => {
      // Tiles settle a dozen at a time; re-rendering the viewer (and with it
      // the whole Canvas subtree) for each one would be most of the load time.
      const step = Math.floor((done / Math.max(1, total)) * 20);
      if (step === lastStep) return;
      lastStep = step;
      setState((current) => ({
        id: payload.id,
        data: current.id === payload.id ? current.data : null,
        failed: null,
        error: null,
        progress: step / 20,
        progressFor: quality,
      }));
    })
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({
          id: payload.id,
          data,
          failed: null,
          error: null,
          progress: 1,
          progressFor: quality,
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({
          id: payload.id,
          data: current.id === payload.id ? current.data : null,
          failed: quality,
          error: cause instanceof Error ? cause : new Error(String(cause)),
          progress: 0,
          progressFor: quality,
        }));
      });

    return () => controller.abort();
  }, [enabled, payload, quality, settled]);

  return {
    data: fresh ? state.data : null,
    error: fresh ? state.error : null,
    progress: fresh && state.progressFor === quality ? state.progress : 0,
    /** True while a load is in flight, including an upgrade over existing data. */
    loading: enabled && payload !== null && !settled,
  };
}
