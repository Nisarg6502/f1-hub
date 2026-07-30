"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import {
  CylinderGeometry,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  Color as ThreeColor,
  Vector3,
} from "three";

import type { TrackCorner } from "@/lib/circuit-geometry";
import type { TrackFrames } from "./build-ribbon";

/**
 * Named corner labels, pinned above the track on a stalk.
 *
 * drei's `<Html>` rather than sprites or canvas textures: it is a handful of
 * nodes (10 at most, at Spa), and it lets the labels use the app's real glass
 * chips and typography instead of an approximation baked into a texture. That
 * would not hold at 200 markers, but the payload only ever names corners that
 * are famous and unambiguous.
 *
 * Occlusion is raycast-based (`occlude={[ref]}`), NOT `occlude="blending"`.
 * Blending mode renders a real backing `planeGeometry` whose shader writes
 * `vec4(0,0,0,0)` *without* `transparent: true`, so the alpha is discarded and
 * the plane draws as an opaque black quad hanging off every corner. It also
 * sizes that plane by `1/viewport.factor` while the label itself is scaled by
 * `distanceFactor`, so the two disagree and the label gets visibly clipped
 * against terrain. Raycast mode renders no plane at all and resolves visibility
 * per label, which fixes both.
 */

/** Base height of the pin above the tarmac, so labels clear rising terrain. */
function pinHeight(frames: TrackFrames): number {
  return Math.max(20, frames.diagonal / 110);
}

/**
 * Pins are staggered over three heights in track order.
 *
 * Corners that are close together on the map are adjacent in `s_m`, so cycling
 * the height by index separates exactly the labels that would otherwise collide.
 * This is the cheap first pass; `useDeclutter` below resolves whatever still
 * overlaps once the geometry is projected to the screen.
 */
const PIN_STEPS = [1, 1.4, 1.8];

/** Screen-space padding around each chip, in CSS pixels. */
const CHIP_PAD = 3;
/** Declutter cadence. Labels do not need to resolve at frame rate. */
const DECLUTTER_INTERVAL_S = 0.1;
/**
 * Vertical slots a crowded label may be nudged into, as multiples of its own
 * height. Above first, since a label above its pin still reads as belonging to
 * it; only then below.
 */
const NUDGE_SLOTS = [0, -1.25, -2.5, 1.25, -3.75, 2.5];

interface LabelHandle {
  chip: HTMLDivElement | null;
  /** Hidden by terrain, per drei's raycast test. */
  occluded: boolean;
  /** No free slot at all — the only case where a label is dropped outright. */
  crowded: boolean;
  width: number;
  height: number;
  /** Screen-space nudge currently applied, in pixels. */
  offset: number;
  applied: string | null;
}

export default function CornerMarkers({
  corners,
  frames,
  exaggeration,
  activeName,
  occluders,
  onSelect,
}: {
  corners: TrackCorner[];
  frames: TrackFrames;
  exaggeration: number;
  activeName?: string | null;
  /**
   * Scene objects that may hide a label. A ref to the exaggerated world group
   * covers terrain, ribbon and kerbs in one — and, unlike an array of per-mesh
   * refs, is never momentarily null when a layer is toggled off, which would
   * make drei raycast against `null` and throw.
   */
  occluders: RefObject<Object3D>[];
  onSelect?: (corner: TrackCorner) => void;
}) {
  const baseLift = pinHeight(frames);

  const placed = useMemo(
    () =>
      // Sorted by arc length so the height stagger follows the lap, not whatever
      // order the payload happens to list corners in.
      [...corners]
        .sort((a, b) => a.s_m - b.s_m)
        .map((corner, order) => {
          const lift = baseLift * PIN_STEPS[order % PIN_STEPS.length];
          const index = Math.min(
            frames.count - 1,
            Math.max(0, Math.round(corner.s_m / frames.spacing)),
          );
          // Foot sits just off the tarmac along the surface normal, so it clears
          // banked corners rather than sinking into the ribbon.
          const foot = new Vector3(
            frames.center[index * 3] + frames.normal[index * 3] * 1.5,
            frames.center[index * 3 + 1] * exaggeration +
              frames.normal[index * 3 + 1] * 1.5,
            frames.center[index * 3 + 2] + frames.normal[index * 3 + 2] * 1.5,
          );
          // The stalk rises along world up, not the surface normal: a pin that
          // leans with the camber reads as broken, and vertical is what makes
          // the label's ground position unambiguous.
          const anchor = foot.clone().setY(foot.y + lift);
          return { corner, foot, anchor, lift };
        }),
    [corners, frames, exaggeration, baseLift],
  );

  /**
   * Mutable per-label scratch, keyed by corner name.
   *
   * A ref holding a Map, populated lazily from the children's ref callbacks,
   * rather than an array built during render: entries have to be writable from
   * `onOcclude` and from the declutter pass, and React's compiler lint treats
   * anything produced during render as frozen. Keying by name also means a child
   * that mounts before this parent has finished laying out still finds its slot.
   */
  const handles = useRef<Map<string, LabelHandle>>(new Map());

  const register = useCallback((name: string, chip: HTMLDivElement | null) => {
    const map = handles.current;
    const handle = map.get(name) ?? {
      chip: null,
      occluded: false,
      crowded: false,
      width: 0,
      height: 0,
      offset: 0,
      applied: null,
    };
    handle.chip = chip;
    if (chip) {
      // Measured once: the chip's box never changes (the radius readout fades
      // with opacity, which does not reflow), so this stays off the hot path.
      handle.width = chip.offsetWidth;
      handle.height = chip.offsetHeight;
    }
    map.set(name, handle);
  }, []);

  const setOccluded = useCallback((name: string, occluded: boolean) => {
    const handle = handles.current.get(name);
    if (handle) handle.occluded = occluded;
  }, []);

  useDeclutter(placed, handles, activeName);

  const stalkGeometry = useMemo(() => new CylinderGeometry(1, 1, 1, 6), []);
  const footGeometry = useMemo(() => new SphereGeometry(1, 10, 8), []);
  const radius = Math.max(0.35, frames.diagonal / 1900);

  const idleMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new ThreeColor("#ffae6a"),
        emissive: new ThreeColor("#ff7a3d"),
        emissiveIntensity: 0.5,
        transparent: true,
        opacity: 0.6,
        roughness: 0.6,
      }),
    [],
  );
  const activeMaterial = useMemo(
    () =>
      new MeshStandardMaterial({
        color: new ThreeColor("#ff5a1f"),
        emissive: new ThreeColor("#ff5a1f"),
        emissiveIntensity: 1.6,
        roughness: 0.35,
      }),
    [],
  );

  useEffect(
    () => () => {
      stalkGeometry.dispose();
      footGeometry.dispose();
      idleMaterial.dispose();
      activeMaterial.dispose();
    },
    [stalkGeometry, footGeometry, idleMaterial, activeMaterial],
  );

  return (
    <>
      {placed.map(({ corner, foot, anchor, lift }) => {
        const active = activeName === corner.name;
        const material = active ? activeMaterial : idleMaterial;
        return (
          <group key={corner.name}>
            <mesh
              geometry={stalkGeometry}
              material={material}
              position={[foot.x, foot.y + lift / 2, foot.z]}
              scale={[radius, lift, radius]}
            />
            <mesh
              geometry={footGeometry}
              material={material}
              position={[foot.x, foot.y, foot.z]}
              scale={radius * 3}
            />
            <CornerLabel
              corner={corner}
              anchor={anchor}
              active={active}
              occluders={occluders}
              register={register}
              setOccluded={setOccluded}
              onSelect={onSelect}
            />
          </group>
        );
      })}
    </>
  );
}

/**
 * Hide labels that would overlap each other on screen.
 *
 * Greedy: walk the labels in priority order — the selected corner first, then
 * nearest to the camera — and drop any whose box intersects one already placed.
 * Nearest-first is what makes it feel right rather than arbitrary: when you zoom
 * into a corner sequence, the corner you are looking at is the one that keeps
 * its name.
 *
 * Positions are projected from the anchor rather than read back from the DOM, so
 * this never forces a layout, and it runs at 10 Hz rather than per frame.
 */
function useDeclutter(
  placed: { corner: TrackCorner; anchor: Vector3 }[],
  handles: RefObject<Map<string, LabelHandle>>,
  activeName?: string | null,
) {
  const { camera, size } = useThree();
  const clock = useRef(0);
  const projected = useRef(new Vector3());

  useFrame((_, delta) => {
    clock.current += delta;
    if (clock.current < DECLUTTER_INTERVAL_S) return;
    clock.current = 0;

    const list = handles.current;
    if (!list) return;

    const entries: {
      handle: LabelHandle;
      left: number;
      top: number;
      right: number;
      bottom: number;
      behind: boolean;
      priority: number;
      distance: number;
    }[] = [];

    for (const item of placed) {
      const handle = list.get(item.corner.name);
      if (!handle?.chip) continue;
      projected.current.copy(item.anchor).project(camera);
      const behind = projected.current.z > 1;
      const x = (projected.current.x * 0.5 + 0.5) * size.width;
      const y = (-projected.current.y * 0.5 + 0.5) * size.height;
      const w = handle.width || 80;
      const h = handle.height || 20;
      entries.push({
        handle,
        // Matches the chip's own placement: centred on the anchor, then nudged
        // up by 60% of its height so it sits above the pin.
        left: x - w / 2 - CHIP_PAD,
        right: x + w / 2 + CHIP_PAD,
        top: y - h * 1.1 - CHIP_PAD,
        bottom: y - h * 0.1 + CHIP_PAD,
        behind,
        priority: item.corner.name === activeName ? 0 : 1,
        distance: camera.position.distanceToSquared(item.anchor),
      });
    }

    entries.sort((a, b) => a.priority - b.priority || a.distance - b.distance);

    const taken: { left: number; right: number; top: number; bottom: number }[] =
      [];
    for (const entry of entries) {
      const { handle } = entry;
      const height = handle.height || 20;

      // Try the natural position first, then progressively further from the pin.
      // Nudging rather than hiding keeps every corner named — the stalk still
      // marks the true ground position, so a label a row higher is unambiguous,
      // whereas a dropped label is information simply lost.
      let chosen: number | null = null;
      if (!entry.behind) {
        for (const slot of NUDGE_SLOTS) {
          const dy = slot * height;
          const box = {
            left: entry.left,
            right: entry.right,
            top: entry.top + dy,
            bottom: entry.bottom + dy,
          };
          const collides = taken.some(
            (other) =>
              box.left < other.right &&
              box.right > other.left &&
              box.top < other.bottom &&
              box.bottom > other.top,
          );
          if (!collides) {
            chosen = dy;
            taken.push(box);
            break;
          }
        }
      }

      handle.crowded = chosen === null;
      handle.offset = chosen ?? 0;

      // Write to the DOM only on a change: at 10 Hz across 10 labels an
      // unconditional write would dirty style on every pass for no reason.
      const visible = !handle.occluded && !handle.crowded;
      const next = visible ? `${handle.offset.toFixed(0)}` : "hidden";
      if (handle.applied === next) continue;
      handle.applied = next;
      handle.chip!.style.opacity = visible ? "1" : "0";
      handle.chip!.style.pointerEvents = visible ? "auto" : "none";
      handle.chip!.style.transform = `translateY(calc(-60% + ${handle.offset.toFixed(0)}px))`;
    }
  });
}

function CornerLabel({
  corner,
  anchor,
  active,
  occluders,
  register,
  setOccluded,
  onSelect,
}: {
  corner: TrackCorner;
  anchor: Vector3;
  active: boolean;
  occluders: RefObject<Object3D>[];
  register: (name: string, chip: HTMLDivElement | null) => void;
  setOccluded: (name: string, occluded: boolean) => void;
  onSelect?: (corner: TrackCorner) => void;
}) {
  const name = corner.name;
  const attach = useCallback(
    (node: HTMLDivElement | null) => register(name, node),
    [register, name],
  );

  return (
    <Html
      position={anchor}
      center
      occlude={occluders}
      // Handled here rather than left to drei, whose default is a hard
      // `display: none` toggle — labels popping as the camera orbits. This also
      // has to compose with the declutter pass, which owns the same opacity.
      onOcclude={(hidden) => setOccluded(name, hidden)}
      // No distanceFactor: corner names are labels on a map, and a label that
      // shrinks with distance stops being readable exactly when the wide shot
      // needs it most.
      zIndexRange={[20, 0]}
      style={{ pointerEvents: "auto" }}
    >
      <div
        ref={attach}
        // `center` puts the chip's midpoint on the anchor, which buries the pin's
        // top half behind it. Nudging up by 60% seats the chip just above the pin
        // so the stalk reads as pointing at the corner.
        style={{
          transform: "translateY(-60%)",
          // Transform is transitioned too: the declutter pass re-slots labels as
          // the camera moves, and snapping between rows would read as jitter.
          transition:
            "opacity 200ms var(--ease-out-apex, ease-out), transform 220ms var(--ease-out-apex, ease-out)",
        }}
      >
        <button
          type="button"
          onClick={() => onSelect?.(corner)}
          title={`Fly ${corner.name}`}
          className={`group flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 font-semibold text-[10px] leading-none border shadow-[0_2px_10px_rgba(0,0,0,0.55)] transition-transform duration-150 active:scale-[0.97] ${
            active
              ? "bg-[rgba(255,90,31,0.94)] border-[rgba(255,174,106,0.85)] text-[#0a0908]"
              : "bg-[rgba(10,9,8,0.86)] border-white/20 text-warm-200 hover:text-warm-100 hover:border-[rgba(255,174,106,0.6)]"
          }`}
        >
          {corner.name}
          {corner.radius_m < 1000 && (
            <span
              className={`font-medium text-[9px] tabular-nums ${
                active ? "opacity-70" : "opacity-0 group-hover:opacity-60"
              } transition-opacity duration-150`}
            >
              R{corner.radius_m.toFixed(0)}
            </span>
          )}
        </button>
      </div>
    </Html>
  );
}
