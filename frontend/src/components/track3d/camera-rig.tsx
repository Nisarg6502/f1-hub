"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Spherical, Vector3 } from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import type { TrackFrames } from "./build-ribbon";
import { easeOutApex } from "./track-scene";
import type { TrackScrubStore } from "./use-track-geometry";

export type CameraPresetId = "three-quarter" | "overhead" | "driver" | "profile";

export interface CameraRigHandle {
  goTo(preset: CameraPresetId): void;
  /** Fly a stretch of track between two arc lengths. */
  flyHighlight(startM: number, endM: number): void;
  /** Fly the entire lap from the current playhead. */
  flyLap(): void;
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
  /** Whether scrubbing the profile walks the camera along the lap. */
  followScrub: boolean;
  handleRef?: Ref<CameraRigHandle>;
  onPresetChange?: (preset: CameraPresetId) => void;
  onFlyStateChange?: (flying: boolean) => void;
}

const TRANSITION_MS = 850;
/**
 * The camera eases from wherever it is onto the track before the lap starts
 * running. Cutting straight to the trackside pose was the single thing that made
 * corner clicks feel abrupt — you arrived mid-corner with no idea where from.
 */
const APPROACH_MS = 1150;
/** ~200 km/h. Fast enough to feel like a lap, slow enough to read the terrain. */
const FLY_SPEED_MPS = 55;
/** Metres over which the run brakes to a stop at the end of a highlight. */
const BRAKE_M = 220;
/** Ride height and trail distance for the chase camera, in metres. */
const EYE_BACK = 14;
const EYE_UP = 6;
const LOOK_AHEAD = 55;

/** cubic-bezier(0.65, 0, 0.35, 1) — symmetric, for arrivals rather than reveals. */
function easeInOutApex(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Sample index for an arc length, wrapped into the lap. */
function indexAt(frames: TrackFrames, distance: number): number {
  const total = frames.length;
  const wrapped = (((distance % total) + total) % total) / frames.spacing;
  return Math.min(frames.count - 1, Math.max(0, Math.round(wrapped)));
}

/** Centreline point at an arc length, with vertical exaggeration applied. */
function pointAt(
  frames: TrackFrames,
  exaggeration: number,
  distance: number,
  out: Vector3,
): Vector3 {
  const i = indexAt(frames, distance);
  return out.set(
    frames.center[i * 3],
    frames.center[i * 3 + 1] * exaggeration,
    frames.center[i * 3 + 2],
  );
}

/** The trackside chase pose at an arc length: eye behind, look ahead. */
function flyPose(
  frames: TrackFrames,
  exaggeration: number,
  distance: number,
  eye: Vector3,
  look: Vector3,
) {
  const i = indexAt(frames, distance);
  eye.set(
    frames.center[i * 3] - frames.tangent[i * 3] * EYE_BACK,
    frames.center[i * 3 + 1] * exaggeration + EYE_UP,
    frames.center[i * 3 + 2] - frames.tangent[i * 3 + 2] * EYE_BACK,
  );
  pointAt(frames, exaggeration, distance + LOOK_AHEAD, look);
  look.y += 1.5;
}

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

interface FlyRun {
  distance: number;
  from: number;
  to: number;
  /** Current speed in m/s. Ramps from 0 so the lap never starts with a jerk. */
  speed: number;
  /** A full-lap tour runs at pace throughout; a highlight brakes at its end. */
  brake: boolean;
}

export default function CameraRig({
  frames,
  exaggeration,
  reducedMotion,
  scrub,
  enableZoom,
  followScrub,
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
    ease: (t: number) => number;
    after?: () => void;
  } | null>(null);

  const fly = useRef<FlyRun | null>(null);
  /** Set during the approach tween, promoted to `fly` when it lands. */
  const pending = useRef<FlyRun | null>(null);
  /** Arc length the camera is walking towards because the user scrubbed. */
  const chase = useRef<number | null>(null);
  const slot = useRef({ position: new Vector3(), target: new Vector3() });

  const cancelMotion = useCallback(() => {
    tween.current = null;
    chase.current = null;
    if (fly.current || pending.current) {
      fly.current = null;
      pending.current = null;
      onFlyStateChange?.(false);
    }
  }, [onFlyStateChange]);

  const goTo = useCallback(
    (preset: CameraPresetId, instant = false) => {
      const controls = controlsRef.current;
      if (!controls) return;
      cancelMotion();
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
        ease: easeOutApex,
      };
    },
    [camera, frames, exaggeration, reducedMotion, onPresetChange, cancelMotion],
  );

  const eye = useRef(new Vector3());
  const look = useRef(new Vector3());
  const offset = useRef(new Vector3());

  /**
   * Start a run. The camera first eases onto the track at `from` over
   * APPROACH_MS, and only then begins moving along it — so a corner click reads
   * as "the camera travels to the corner and drives it", not as a hard cut into
   * the middle of a flythrough.
   */
  const startRun = useCallback(
    (from: number, to: number, brake: boolean) => {
      const controls = controlsRef.current;
      if (!controls) return;

      const run: FlyRun = { distance: from, from, to, speed: 0, brake };
      flyPose(frames, exaggeration, from, eye.current, look.current);
      onFlyStateChange?.(true);
      scrub.set(from, "fly");

      if (reducedMotion) {
        camera.position.copy(eye.current);
        controls.target.copy(look.current);
        controls.update();
        fly.current = run;
        pending.current = null;
        return;
      }

      chase.current = null;
      pending.current = run;
      tween.current = {
        fromPos: camera.position.clone(),
        toPos: eye.current.clone(),
        fromTarget: controls.target.clone(),
        toTarget: look.current.clone(),
        elapsed: 0,
        duration: APPROACH_MS,
        ease: easeInOutApex,
        after: () => {
          fly.current = pending.current;
          pending.current = null;
        },
      };
    },
    [camera, frames, exaggeration, reducedMotion, scrub, onFlyStateChange],
  );

  const flyHighlight = useCallback(
    (startM: number, endM: number) => {
      // Lead in and run out so the corner is not the first or last thing seen.
      startRun(Math.max(0, startM - 140), endM + 180, true);
    },
    [startRun],
  );

  const flyLap = useCallback(() => {
    const from = scrub.current || 0;
    startRun(from, from + frames.length, false);
  }, [startRun, scrub, frames.length]);

  useImperativeHandle(
    handleRef,
    () => ({
      goTo: (preset: CameraPresetId) => goTo(preset),
      flyHighlight,
      flyLap,
      stopFly: cancelMotion,
    }),
    [goTo, flyHighlight, flyLap, cancelMotion],
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
      ease: easeOutApex,
    };
  }, [camera, frames, exaggeration, reducedMotion]);

  // A drag must always win over an in-flight animation.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.addEventListener("start", cancelMotion);
    return () => controls.removeEventListener("start", cancelMotion);
  }, [cancelMotion]);

  /**
   * Scrubbing the profile walks the camera along the lap.
   *
   * Only the orbit *target* is driven; the camera keeps its current offset from
   * it. That preserves whatever viewing angle and zoom the user set up — the
   * circuit slides underneath them rather than the view being reset — and it is
   * why this can coexist with free orbiting instead of overriding it.
   */
  useEffect(() => {
    if (!followScrub) return;
    return scrub.subscribe((metres, origin) => {
      if (origin !== "user") return;
      // A flythrough outranks a hover; only an explicit scrub interrupts one.
      if (fly.current || pending.current) return;
      tween.current = null;
      chase.current = metres;
    });
  }, [scrub, followScrub]);

  useEffect(() => {
    if (!followScrub) chase.current = null;
  }, [followScrub]);

  useFrame((_, delta) => {
    const controls = controlsRef.current;
    if (!controls) return;

    // Clamp: a backgrounded tab resumes with a huge delta, which would otherwise
    // teleport a flythrough hundreds of metres down the road in one frame.
    const step = Math.min(delta, 0.05);

    if (tween.current) {
      const t = tween.current;
      t.elapsed += step * 1000;
      const k = t.ease(t.elapsed / t.duration);
      camera.position.lerpVectors(t.fromPos, t.toPos, k);
      controls.target.lerpVectors(t.fromTarget, t.toTarget, k);
      controls.update();
      if (t.elapsed >= t.duration) {
        tween.current = null;
        t.after?.();
      }
      return;
    }

    if (fly.current) {
      const state = fly.current;

      // Ease in from a standstill, and ease back out over the last stretch, so a
      // highlight run arrives at rest instead of being cut off mid-corner.
      const remaining = state.to - state.distance;
      const brake = state.brake ? Math.min(1, remaining / BRAKE_M) : 1;
      const targetSpeed = FLY_SPEED_MPS * (0.12 + 0.88 * easeOutApex(brake));
      state.speed += (targetSpeed - state.speed) * (1 - Math.exp(-1.9 * step));
      state.distance += state.speed * step;

      if (state.distance >= state.to) {
        fly.current = null;
        onFlyStateChange?.(false);
        return;
      }
      scrub.set(state.distance, "fly");

      flyPose(frames, exaggeration, state.distance, eye.current, look.current);

      // Critically damped follow. Snapping straight to the sample would jitter on
      // residual DEM noise and read as cheap.
      const damp = 1 - Math.exp(-8 * step);
      camera.position.lerp(eye.current, damp);
      controls.target.lerp(look.current, damp);
      controls.update();
      return;
    }

    if (chase.current !== null) {
      pointAt(frames, exaggeration, chase.current, look.current);
      offset.current.copy(camera.position).sub(controls.target);
      const damp = 1 - Math.exp(-7 * step);
      controls.target.lerp(look.current, damp);
      camera.position.copy(controls.target).add(offset.current);
      controls.update();
      // Settled: stop running the follow so an idle viewer costs nothing.
      if (controls.target.distanceToSquared(look.current) < 0.25) {
        chase.current = null;
      }
    }
  });

  const reach = frames.diagonal;

  // OrbitControls' built-in `keys` binds arrows to PAN, which fights the
  // canvas-level Escape/preset handling and is not what "arrow keys orbit"
  // means for this viewer. Rotation is driven manually via a spherical offset
  // around the current target — OrbitControls' own rotateLeft/rotateUp are
  // internal to three-stdlib and not part of its public type, so this uses only
  // documented Object3D/Spherical API. A keypress cancels any in-flight tween
  // exactly like a drag does.
  const spherical = useRef(new Spherical());
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const rotateStep = 0.06;
    const zoomStep = 1.06;
    const handler = (event: KeyboardEvent) => {
      const offsetVec = camera.position.clone().sub(controls.target);
      spherical.current.setFromVector3(offsetVec);

      switch (event.key) {
        case "ArrowLeft":
          cancelMotion();
          spherical.current.theta -= rotateStep;
          break;
        case "ArrowRight":
          cancelMotion();
          spherical.current.theta += rotateStep;
          break;
        case "ArrowUp":
          cancelMotion();
          spherical.current.phi = Math.max(0.05, spherical.current.phi - rotateStep);
          break;
        case "ArrowDown":
          cancelMotion();
          spherical.current.phi = Math.min(
            Math.PI / 2 - 0.035,
            spherical.current.phi + rotateStep,
          );
          break;
        case "+":
        case "=":
          spherical.current.radius /= zoomStep;
          break;
        case "-":
        case "_":
          spherical.current.radius *= zoomStep;
          break;
        default:
          return;
      }
      event.preventDefault();
      offsetVec.setFromSpherical(spherical.current);
      camera.position.copy(controls.target).add(offsetVec);
      controls.update();
    };
    // Scoped to the canvas's focusable wrapper, not window — this must not
    // steal arrow keys from the rest of the page.
    const host = controls.domElement?.closest('[role="application"]');
    host?.addEventListener("keydown", handler as EventListener);
    return () => host?.removeEventListener("keydown", handler as EventListener);
  }, [cancelMotion, camera]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      enableDamping
      dampingFactor={reducedMotion ? 0.2 : 0.08}
      // No `keys`/`keyEvents` prop is set, so OrbitControls' own keyboard
      // handling never attaches — arrow keys are handled entirely by the
      // effect above instead.
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
