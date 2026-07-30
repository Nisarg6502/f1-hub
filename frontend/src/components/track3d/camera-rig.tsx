"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import type { TrackFrames } from "./build-ribbon";
import { easeOutApex } from "./track-scene";
import type { TrackScrubStore } from "./use-track-geometry";

export type CameraPresetId = "three-quarter" | "overhead" | "driver" | "profile";

export interface CameraRigHandle {
  goTo(preset: CameraPresetId): void;
  flyHighlight(startM: number, endM: number): void;
  stopFly(): void;
}

interface CameraRigProps {
  frames: TrackFrames;
  exaggeration: number;
  reducedMotion: boolean;
  scrub: TrackScrubStore;
  /**
   * Wheel zoom stays off until the user activates the canvas. A full-width
   * canvas that eats the wheel traps the page — you cannot scroll past the
   * viewer to the elevation profile below it. Same convention embedded maps use.
   */
  enableZoom: boolean;
  handleRef?: Ref<CameraRigHandle>;
  onPresetChange?: (preset: CameraPresetId) => void;
  onFlyStateChange?: (flying: boolean) => void;
}

const TRANSITION_MS = 850;
/** ~200 km/h. Fast enough to feel like a lap, slow enough to read the terrain. */
const FLY_SPEED_MPS = 55;

function presetTarget(
  preset: CameraPresetId,
  frames: TrackFrames,
  exaggeration: number,
  out: { position: Vector3; target: Vector3 },
) {
  const centre = frames.center2d;
  const reach = frames.diagonal;
  const midY = centre.y * exaggeration;

  switch (preset) {
    case "overhead":
      out.position.set(centre.x, midY + reach * 1.15, centre.z + 0.01);
      out.target.set(centre.x, midY, centre.z);
      break;
    case "profile":
      // Side-on and low: the view that makes elevation impossible to miss.
      out.position.set(centre.x + reach * 1.05, midY + reach * 0.12, centre.z);
      out.target.set(centre.x, midY, centre.z);
      break;
    case "driver":
      out.position.set(
        frames.center[0],
        frames.center[1] * exaggeration + 12,
        frames.center[2] + 30,
      );
      out.target.set(
        frames.center[0],
        frames.center[1] * exaggeration,
        frames.center[2],
      );
      break;
    case "three-quarter":
    default:
      out.position.set(
        centre.x - reach * 0.52,
        midY + reach * 0.46,
        centre.z + reach * 0.62,
      );
      out.target.set(centre.x, midY, centre.z);
      break;
  }
}

export default function CameraRig({
  frames,
  exaggeration,
  reducedMotion,
  scrub,
  enableZoom,
  handleRef,
  onPresetChange,
  onFlyStateChange,
}: CameraRigProps) {
  const { camera } = useThree();
  const controlsRef = useRef<OrbitControlsImpl>(null);

  const tween = useRef<{
    fromPos: Vector3;
    toPos: Vector3;
    fromTarget: Vector3;
    toTarget: Vector3;
    elapsed: number;
    duration: number;
  } | null>(null);

  const fly = useRef<{ distance: number; from: number; to: number } | null>(null);
  const slot = useRef({ position: new Vector3(), target: new Vector3() });

  const cancelMotion = useCallback(() => {
    tween.current = null;
    if (fly.current) {
      fly.current = null;
      onFlyStateChange?.(false);
    }
  }, [onFlyStateChange]);

  const goTo = useCallback(
    (preset: CameraPresetId, instant = false) => {
      const controls = controlsRef.current;
      if (!controls) return;
      presetTarget(preset, frames, exaggeration, slot.current);
      onPresetChange?.(preset);

      if (instant || reducedMotion) {
        camera.position.copy(slot.current.position);
        controls.target.copy(slot.current.target);
        controls.update();
        return;
      }
      tween.current = {
        fromPos: camera.position.clone(),
        toPos: slot.current.position.clone(),
        fromTarget: controls.target.clone(),
        toTarget: slot.current.target.clone(),
        elapsed: 0,
        duration: TRANSITION_MS,
      };
    },
    [camera, frames, exaggeration, reducedMotion, onPresetChange],
  );

  const flyHighlight = useCallback(
    (startM: number, endM: number) => {
      tween.current = null;
      // Lead in and run out so the corner is not the first or last thing seen.
      fly.current = {
        distance: Math.max(0, startM - 140),
        from: Math.max(0, startM - 140),
        to: endM + 180,
      };
      onFlyStateChange?.(true);
    },
    [onFlyStateChange],
  );

  useImperativeHandle(
    handleRef,
    () => ({
      goTo: (preset: CameraPresetId) => goTo(preset),
      flyHighlight,
      stopFly: cancelMotion,
    }),
    [goTo, flyHighlight, cancelMotion],
  );

  // Frame the circuit on mount. The intro flight starts wide and settles into the
  // three-quarter view; under reduced motion it just arrives there.
  const introRef = useRef(false);
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls || introRef.current) return;
    introRef.current = true;

    presetTarget("three-quarter", frames, exaggeration, slot.current);
    controls.target.copy(slot.current.target);

    if (reducedMotion) {
      camera.position.copy(slot.current.position);
      controls.update();
      return;
    }

    // Start pulled back and higher, then ease in. Never from nothing — the
    // circuit is already visible, the camera just closes on it.
    const wide = slot.current.position
      .clone()
      .sub(slot.current.target)
      .multiplyScalar(1.85)
      .add(slot.current.target);
    wide.y = slot.current.target.y + frames.diagonal * 0.95;
    camera.position.copy(wide);
    controls.update();

    tween.current = {
      fromPos: wide.clone(),
      toPos: slot.current.position.clone(),
      fromTarget: slot.current.target.clone(),
      toTarget: slot.current.target.clone(),
      elapsed: 0,
      duration: 1650,
    };
  }, [camera, frames, exaggeration, reducedMotion]);

  // A drag must always win over an in-flight animation.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.addEventListener("start", cancelMotion);
    return () => controls.removeEventListener("start", cancelMotion);
  }, [cancelMotion]);

  const eye = useRef(new Vector3());
  const look = useRef(new Vector3());

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (tween.current) {
      const t = tween.current;
      t.elapsed += delta * 1000;
      const k = easeOutApex(t.elapsed / t.duration);
      camera.position.lerpVectors(t.fromPos, t.toPos, k);
      controls.target.lerpVectors(t.fromTarget, t.toTarget, k);
      controls.update();
      if (t.elapsed >= t.duration) tween.current = null;
      return;
    }

    if (fly.current) {
      const state = fly.current;
      state.distance += FLY_SPEED_MPS * delta;
      if (state.distance >= state.to) {
        fly.current = null;
        onFlyStateChange?.(false);
        return;
      }
      scrub.set(state.distance);

      const i = Math.min(
        frames.count - 1,
        Math.round((state.distance % frames.length) / frames.spacing),
      );
      const ahead = Math.min(
        frames.count - 1,
        Math.round(((state.distance + 45) % frames.length) / frames.spacing),
      );

      eye.current.set(
        frames.center[i * 3] - frames.tangent[i * 3] * 12,
        frames.center[i * 3 + 1] * exaggeration + 5.5,
        frames.center[i * 3 + 2] - frames.tangent[i * 3 + 2] * 12,
      );
      look.current.set(
        frames.center[ahead * 3],
        frames.center[ahead * 3 + 1] * exaggeration + 1.5,
        frames.center[ahead * 3 + 2],
      );

      // Critically damped follow. Snapping straight to the sample would jitter on
      // residual DEM noise and read as cheap.
      const damp = 1 - Math.exp(-8 * delta);
      camera.position.lerp(eye.current, damp);
      controls.target.lerp(look.current, damp);
      controls.update();
    }
  });

  const reach = frames.diagonal;

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={reducedMotion ? 0.2 : 0.08}
      // Never let the camera go under the terrain.
      maxPolarAngle={Math.PI / 2 - 0.035}
      minDistance={reach * 0.05}
      maxDistance={reach * 2.4}
      enablePan
      enableZoom={enableZoom}
      zoomSpeed={0.8}
      rotateSpeed={0.7}
    />
  );
}
