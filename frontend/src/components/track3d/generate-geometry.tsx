"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import TrackMap from "@/components/track-map";
import {
  fetchTrackBuildStatus,
  invalidateClientTrackGeometryAvailability,
  startTrackGeometryBuild,
  type TrackBuildDoc,
} from "@/lib/track-geometry-api";
import { usePrefersReducedMotion } from "./use-track-geometry";
import { track } from "@/lib/analytics";

/**
 * "Generate 3D view" for a circuit that has a curated recipe but no payload yet.
 *
 * The build runs as a Cloud Run Job and takes minutes, not milliseconds, so this
 * is a progress surface rather than a spinner: the job reports a human-readable
 * phase and percentage into Mongo as it works, and this polls for them. The
 * phase text is written by the pipeline and rendered verbatim — it is the only
 * honest signal of what is actually happening.
 */

const POLL_INTERVAL_MS = 2500;
/** Give up polling well after the job's own 30 minute task timeout. */
const POLL_CEILING_MS = 35 * 60 * 1000;

/**
 * Shown before the job has reported anything of its own.
 *
 * Deliberately describes real work rather than inventing progress — the job
 * overwrites all of this as soon as it has something true to say.
 */
const OPENING_MESSAGE = "Starting the build…";

interface GenerateGeometryProps {
  circuitId: string;
  circuitName: string;
  fallbackImage?: string | null;
}

export default function GenerateGeometry({
  circuitId,
  circuitName,
  fallbackImage,
}: GenerateGeometryProps) {
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();

  const [build, setBuild] = useState<TrackBuildDoc | null>(null);
  const [busyNotice, setBusyNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [watching, setWatching] = useState(false);

  const finish = useCallback(() => {
    // The payload now exists but this page was server-rendered when it did not.
    // Drop the cached availability and re-render so the viewer takes over.
    invalidateClientTrackGeometryAvailability();
    router.refresh();
  }, [router]);

  /**
   * Poll while a build is in flight.
   *
   * An effect keyed on `watching` rather than a self-scheduling callback: a
   * `useCallback` that re-arms itself by name closes over its own stale
   * identity, and the cleanup here is what guarantees the timer dies with the
   * component instead of polling a page nobody is looking at.
   */
  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();

    const tick = async () => {
      if (cancelled) return;

      if (Date.now() - startedAt > POLL_CEILING_MS) {
        setError(
          "The build is taking longer than expected. It may still finish — reload this page in a few minutes.",
        );
        setWatching(false);
        return;
      }

      const doc = await fetchTrackBuildStatus(circuitId);
      if (cancelled) return;

      // A null result is a transient read failure, not a finished build. Keep
      // showing the last known state and try again rather than flashing an
      // error at someone whose build is fine.
      if (doc) {
        setBuild(doc);
        if (doc.status === "done") {
          setWatching(false);
          finish();
          return;
        }
        if (doc.status === "failed") {
          setError(
            doc.error ??
              "The build failed. You can try again, or pick a different circuit.",
          );
          setWatching(false);
          return;
        }
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [watching, circuitId, finish]);

  const start = useCallback(async () => {
    track("circuit_3d_generate", { circuit_id: circuitId });
    setStarting(true);
    setError(null);
    setBusyNotice(null);

    const result = await startTrackGeometryBuild(circuitId);
    setStarting(false);

    switch (result.kind) {
      case "started":
        setBuild(result.build);
        setWatching(true);
        break;
      case "already-built":
        finish();
        break;
      case "busy":
        // Someone else's build holds the lock. Only watch if it is this circuit
        // — otherwise there is nothing here to wait for.
        setBusyNotice(result.message);
        if (result.sameCircuit) setWatching(true);
        break;
      case "unknown-circuit":
      case "error":
        setError(result.message);
        break;
    }
  }, [circuitId, finish]);

  const running =
    watching && (build?.status === "queued" || build?.status === "running");
  const percent = Math.min(100, Math.max(0, build?.progress_pct ?? 0));

  return (
    <div className="apex-glass-strong apex-sheen rounded-panel p-6 md:p-8">
      <div className="grid md:grid-cols-[minmax(0,1fr)_260px] gap-8 items-center">
        <div>
          <span className="inline-block font-bold text-[10px] tracking-[0.12em] uppercase px-2.5 py-1.5 rounded-lg bg-[rgba(255,90,31,0.16)] text-[#FFAE6A] mb-4">
            Not generated yet
          </span>

          <h2 className="font-[family-name:var(--font-headline)] font-extrabold text-2xl md:text-[28px] tracking-[-0.5px] leading-[1.05] mb-3">
            {running || busyNotice
              ? `Building ${circuitName}`
              : `See ${circuitName} in 3D`}
          </h2>

          {!running && !busyNotice && (
            <p className="font-medium text-[13px] text-warm-400 leading-relaxed max-w-xl mb-6">
              This circuit&apos;s elevation model has not been built yet. Generating
              it samples a real elevation dataset along the track and bakes the
              3D geometry — it takes a couple of minutes, and only ever has to
              happen once. After that it loads instantly for everyone.
            </p>
          )}

          {running && (
            <div className="max-w-xl mb-6" role="status" aria-live="polite">
              <div className="flex items-baseline justify-between gap-3 mb-2">
                <span className="font-semibold text-[13px] text-warm-100">
                  {build?.message || build?.phase || OPENING_MESSAGE}
                </span>
                <span className="font-bold text-[13px] tabular-nums text-[#ffae6a]">
                  {percent}%
                </span>
              </div>
              <div className="h-[6px] w-full rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#ff5a1f] to-[#ffae6a]"
                  style={{
                    width: `${percent}%`,
                    transition: reducedMotion
                      ? "none"
                      : "width 600ms var(--ease-out-apex, ease-out)",
                  }}
                />
              </div>
              <p className="font-medium text-[11px] text-warm-500 mt-2">
                Sampling a public elevation service, which is rate-limited to one
                request a second — this is the slow part, and it is why the
                result is stored permanently.
              </p>
            </div>
          )}

          {busyNotice && (
            <div
              className="max-w-xl mb-6 rounded-tile px-4 py-3 bg-[rgba(255,174,106,0.10)] border border-[rgba(255,174,106,0.30)]"
              role="status"
              aria-live="polite"
            >
              <p className="font-semibold text-[13px] text-[#ffae6a]">
                {busyNotice}
              </p>
              <p className="font-medium text-[11px] text-warm-400 mt-1">
                Only one circuit is generated at a time, so the elevation service
                is never hit by two builds at once.
              </p>
            </div>
          )}

          {error && (
            <div
              className="max-w-xl mb-6 rounded-tile px-4 py-3 bg-[rgba(255,90,31,0.10)] border border-[rgba(255,120,90,0.35)]"
              role="alert"
            >
              <p className="font-semibold text-[13px] text-[#ff9b8a]">{error}</p>
            </div>
          )}

          {!running && (
            <button
              type="button"
              onClick={start}
              disabled={starting}
              className="rounded-xl px-5 py-3 font-bold text-[12px] tracking-[0.1em] uppercase bg-[#ff5a1f] border border-[rgba(255,174,106,0.8)] text-[#160b04] shadow-[0_6px_22px_rgba(255,90,31,0.42)] hover:bg-[#ff6f36] transition-transform duration-150 active:scale-[0.97] disabled:opacity-60 disabled:pointer-events-none"
            >
              {starting
                ? "Starting…"
                : busyNotice || error
                  ? "Try again"
                  : "Generate 3D view"}
            </button>
          )}
        </div>

        <TrackMap
          src={fallbackImage ?? null}
          alt={circuitName}
          containerClassName="relative w-full h-[200px] opacity-70"
          imgClassName="object-contain"
        />
      </div>
    </div>
  );
}
