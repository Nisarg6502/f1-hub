"use client";

import { useMemo } from "react";
import { Html } from "@react-three/drei";
import { Vector3 } from "three";

import type { TrackCorner } from "@/lib/circuit-geometry";
import type { TrackFrames } from "./build-ribbon";

/**
 * Named corner labels pinned to the track surface.
 *
 * drei's `<Html>` rather than sprites or canvas textures: it is a handful of
 * nodes (10 at most, at Spa), and it lets the labels use the app's real glass
 * chips and typography instead of an approximation baked into a texture. That
 * would not hold at 200 markers, but the payload only ever names corners that
 * are famous and unambiguous.
 *
 * `occlude="blending"` hides labels behind terrain, which matters a lot here:
 * without it, Blanchimont's label floats over the Ardennes hillside that is
 * physically in front of it and the depth of the scene falls apart.
 */
export default function CornerMarkers({
  corners,
  frames,
  exaggeration,
  activeName,
  onSelect,
}: {
  corners: TrackCorner[];
  frames: TrackFrames;
  exaggeration: number;
  activeName?: string | null;
  onSelect?: (corner: TrackCorner) => void;
}) {
  const placed = useMemo(
    () =>
      corners.map((corner) => {
        const index = Math.min(
          frames.count - 1,
          Math.max(0, Math.round(corner.s_m / frames.spacing)),
        );
        // Lift along the surface normal so the label clears banked corners
        // rather than sinking into the ribbon.
        const lift = Math.max(6, frames.diagonal / 320);
        const position = new Vector3(
          frames.center[index * 3] + frames.normal[index * 3] * lift,
          frames.center[index * 3 + 1] * exaggeration +
            frames.normal[index * 3 + 1] * lift,
          frames.center[index * 3 + 2] + frames.normal[index * 3 + 2] * lift,
        );
        return { corner, position };
      }),
    [corners, frames, exaggeration],
  );

  return (
    <>
      {placed.map(({ corner, position }) => {
        const active = activeName === corner.name;
        return (
          <Html
            key={corner.name}
            position={position}
            center
            occlude="blending"
            // Labels shrink with distance but never vanish entirely.
            distanceFactor={frames.diagonal / 3.2}
            zIndexRange={[20, 0]}
            style={{ pointerEvents: "auto" }}
          >
            <button
              type="button"
              onClick={() => onSelect?.(corner)}
              className={`whitespace-nowrap rounded-lg px-2 py-1 font-semibold text-[11px] leading-none border transition-transform duration-150 active:scale-[0.97] ${
                active
                  ? "bg-[rgba(255,90,31,0.9)] border-[rgba(255,174,106,0.8)] text-[#0a0908]"
                  : "bg-[rgba(10,9,8,0.72)] border-white/15 text-warm-200 hover:text-warm-100 hover:border-[rgba(255,174,106,0.5)]"
              }`}
            >
              {corner.name}
              <span className="ml-1.5 font-medium text-[9px] opacity-60 tabular-nums">
                {corner.radius_m < 1000 ? `${corner.radius_m.toFixed(0)}m` : ""}
              </span>
            </button>
          </Html>
        );
      })}
    </>
  );
}
