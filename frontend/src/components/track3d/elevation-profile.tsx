"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TrackGeometryPayload, TrackHighlight } from "@/lib/circuit-geometry";
import type { TrackScrubStore } from "./use-track-geometry";

/**
 * The elevation profile strip.
 *
 * Hand-rolled SVG rather than Recharts: this needs a gradient-filled area, a
 * draggable playhead, highlight bands and 60 Hz scrub linkage to a 3D camera,
 * which Recharts cannot do cleanly. Follows the same hand-authored-SVG precedent
 * as `animated-ring.tsx`.
 *
 * Also renders standalone with no WebGL, which is what makes the no-WebGL
 * fallback genuinely informative rather than an apology — the elevation numbers
 * are the content; the 3D scene is the presentation.
 */

const VIEW_W = 1000;
const VIEW_H = 190;
const PAD_TOP = 18;
const PAD_BOTTOM = 26;

interface ElevationProfileProps {
  payload: TrackGeometryPayload;
  scrub?: TrackScrubStore;
  activeHighlightId?: string | null;
  onSelectHighlight?: (highlight: TrackHighlight) => void;
  /** Hide the playhead when there is no 3D scene to drive. */
  interactive?: boolean;
}

export default function ElevationProfile({
  payload,
  scrub,
  activeHighlightId,
  onSelectHighlight,
  interactive = true,
}: ElevationProfileProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const playheadRef = useRef<SVGGElement>(null);
  const [readout, setReadout] = useState<{ s: number; z: number } | null>(null);
  const dragging = useRef(false);

  const { path, area, minZ, maxZ, length } = useMemo(() => {
    const spacing = payload.sample_spacing_m;
    const zs = payload.u_dm;
    const lo = Math.min(...zs);
    const hi = Math.max(...zs);
    const span = Math.max(1, hi - lo);
    const total = payload.length_m;
    const usable = VIEW_H - PAD_TOP - PAD_BOTTOM;

    // Decimate: 1399 samples into ~500 points is visually identical and keeps the
    // path string small enough not to bloat the DOM.
    const stride = Math.max(1, Math.floor(zs.length / 500));
    const points: string[] = [];
    for (let i = 0; i < zs.length; i += stride) {
      const x = ((i * spacing) / total) * VIEW_W;
      const y = PAD_TOP + usable * (1 - (zs[i] - lo) / span);
      points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const lastY = PAD_TOP + usable * (1 - (zs[zs.length - 1] - lo) / span);
    points.push(`${VIEW_W},${lastY.toFixed(1)}`);

    const line = `M${points.join("L")}`;
    return {
      path: line,
      area: `${line}L${VIEW_W},${VIEW_H - PAD_BOTTOM}L0,${VIEW_H - PAD_BOTTOM}Z`,
      minZ: lo / 10,
      maxZ: hi / 10,
      length: total,
    };
  }, [payload]);

  const zAt = useCallback(
    (metres: number) => {
      const i = Math.min(
        payload.u_dm.length - 1,
        Math.max(0, Math.round(metres / payload.sample_spacing_m)),
      );
      return payload.u_dm[i] / 10;
    },
    [payload],
  );

  const yFor = useCallback(
    (zMetres: number) => {
      const span = Math.max(1, maxZ - minZ);
      const usable = VIEW_H - PAD_TOP - PAD_BOTTOM;
      return PAD_TOP + usable * (1 - (zMetres - minZ) / span);
    },
    [minZ, maxZ],
  );

  /**
   * The playhead is moved by writing transform directly, never through React
   * state — a 60 Hz pointer move through state would re-render the whole 3D tree.
   */
  const paint = useCallback(
    (metres: number) => {
      const node = playheadRef.current;
      if (!node) return;
      const x = (metres / length) * VIEW_W;
      node.setAttribute("transform", `translate(${x.toFixed(1)} 0)`);
      const dot = node.querySelector("circle");
      dot?.setAttribute("cy", yFor(zAt(metres)).toFixed(1));
    },
    [length, yFor, zAt],
  );

  useEffect(() => {
    if (!scrub) return;
    paint(scrub.current);
    return scrub.subscribe(paint);
  }, [scrub, paint]);

  const metresFromEvent = useCallback(
    (clientX: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * length;
    },
    [length],
  );

  const handleMove = useCallback(
    (clientX: number) => {
      const metres = metresFromEvent(clientX);
      scrub?.set(metres);
      paint(metres);
      setReadout({ s: metres, z: zAt(metres) });
    },
    [metresFromEvent, scrub, paint, zAt],
  );

  const highlightBands = payload.highlights.filter((h) => h.run_m > 0);

  return (
    <div className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="w-full h-[190px] touch-none select-none"
        role="img"
        aria-label={`Elevation profile of ${payload.name}: ${payload.elevation.total_change_m.toFixed(
          0,
        )} metres of elevation change over ${(length / 1000).toFixed(2)} kilometres`}
        onPointerDown={
          interactive
            ? (event) => {
                dragging.current = true;
                event.currentTarget.setPointerCapture(event.pointerId);
                handleMove(event.clientX);
              }
            : undefined
        }
        onPointerMove={
          interactive
            ? (event) => {
                if (!dragging.current && event.pointerType === "touch") return;
                handleMove(event.clientX);
              }
            : undefined
        }
        onPointerUp={
          interactive
            ? (event) => {
                dragging.current = false;
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            : undefined
        }
        onPointerLeave={interactive ? () => setReadout(null) : undefined}
      >
        <defs>
          <linearGradient id="apex-elev-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff7a3d" stopOpacity="0.42" />
            <stop offset="60%" stopColor="#ff5a1f" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#ff5a1f" stopOpacity="0" />
          </linearGradient>
        </defs>

        {highlightBands.map((h) => {
          const x0 = (Math.min(h.s_start_m, h.s_end_m) / length) * VIEW_W;
          const x1 = (Math.max(h.s_start_m, h.s_end_m) / length) * VIEW_W;
          const active = activeHighlightId === h.id;
          return (
            <g key={h.id}>
              <rect
                x={x0}
                y={PAD_TOP - 8}
                width={Math.max(2, x1 - x0)}
                height={VIEW_H - PAD_TOP - PAD_BOTTOM + 8}
                fill={active ? "rgba(255,90,31,0.20)" : "rgba(255,174,106,0.07)"}
                stroke={active ? "rgba(255,174,106,0.55)" : "transparent"}
                strokeWidth="1"
                className="cursor-pointer transition-[fill] duration-200"
                onPointerDown={(event) => {
                  event.stopPropagation();
                  onSelectHighlight?.(h);
                }}
              />
            </g>
          );
        })}

        <path d={area} fill="url(#apex-elev-fill)" />
        <path
          d={path}
          fill="none"
          stroke="#ffae6a"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
        <line
          x1="0"
          y1={VIEW_H - PAD_BOTTOM}
          x2={VIEW_W}
          y2={VIEW_H - PAD_BOTTOM}
          stroke="rgba(255,255,255,0.10)"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />

        {interactive && (
          <g ref={playheadRef}>
            <line
              x1="0"
              y1={PAD_TOP - 10}
              x2="0"
              y2={VIEW_H - PAD_BOTTOM}
              stroke="#f6f1ea"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              opacity="0.75"
            />
            <circle cx="0" cy={VIEW_H / 2} r="4" fill="#ffae6a" />
          </g>
        )}
      </svg>

      <div className="flex items-center justify-between mt-1.5 font-medium text-[10px] tracking-[0.08em] uppercase text-warm-500">
        <span>Start / finish</span>
        <span className="text-warm-400 tabular-nums">
          {readout
            ? `${(readout.s / 1000).toFixed(2)} km · ${(
                readout.z + payload.z_ref_m
              ).toFixed(0)} m ASL`
            : `${(minZ + payload.z_ref_m).toFixed(0)}–${(maxZ + payload.z_ref_m).toFixed(
                0,
              )} m ASL`}
        </span>
        <span>{(length / 1000).toFixed(2)} km</span>
      </div>
    </div>
  );
}
