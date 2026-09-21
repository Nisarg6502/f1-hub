"use client";

import { useEffect, useState, type RefObject } from "react";
import { useReducedMotion } from "motion/react";

/**
 * `DeviceOrientationEvent.requestPermission` is iOS 13+ Safari only and is
 * not in the standard DOM lib types. Declared narrowly here rather than
 * reaching for `any`, so the feature-detection below stays type-safe.
 */
interface IOSDeviceOrientationEventConstructor {
  requestPermission?: () => Promise<"granted" | "denied">;
}

type PermissionState = "unnecessary" | "unknown" | "granted" | "denied";

function getConstructor(): IOSDeviceOrientationEventConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window as unknown as {
      DeviceOrientationEvent?: IOSDeviceOrientationEventConstructor;
    }
  ).DeviceOrientationEvent;
}

/** True on iOS 13+ Safari, where reading the sensor is gated behind a prompt. */
function needsExplicitPermission(): boolean {
  return typeof getConstructor()?.requestPermission === "function";
}

/** True wherever the event exists at all — including desktop browsers that
 *  expose the constructor but never fire it, which is exactly why this alone
 *  is not treated as "tilt is happening": see `active` below. */
function isSupported(): boolean {
  return typeof window !== "undefined" && "DeviceOrientationEvent" in window;
}

/**
 * One permission prompt per site visit, not one per mounted card.
 *
 * WebKit only honours `requestPermission()` when it is called synchronously
 * from inside a user-gesture handler, and it shows a native dialog. A grid
 * has a dozen-plus tilt-enabled cards, each running its own instance of this
 * hook; without this module-level singleton, the first tap would fire that
 * many concurrent `requestPermission()` calls; instead every hook instance
 * awaits the same promise and reacts to the one real outcome.
 */
let permissionState: PermissionState = needsExplicitPermission()
  ? "unknown"
  : "unnecessary";
let permissionPromise: Promise<PermissionState> | null = null;
let gestureListenerAttached = false;
const subscribers = new Set<() => void>();

function notifySubscribers() {
  subscribers.forEach((fn) => fn());
}

function requestPermissionOnce(): Promise<PermissionState> {
  if (permissionPromise) return permissionPromise;
  permissionPromise = (async () => {
    try {
      const result = await getConstructor()?.requestPermission?.();
      permissionState = result === "granted" ? "granted" : "denied";
    } catch {
      permissionState = "denied";
    }
    notifySubscribers();
    return permissionState;
  })();
  return permissionPromise;
}

/** Piggybacks the request on the first tap/click anywhere on the page —
 *  the "necessary first interaction" the task calls for, with no separate
 *  "enable tilt" button cluttering the UI. Capture phase + `once` so it
 *  never interferes with the tap's own handler (card navigation, a modal
 *  opening, etc.) and cleans itself up automatically. */
function attachGestureListenerOnce() {
  if (gestureListenerAttached || typeof document === "undefined") return;
  gestureListenerAttached = true;
  document.addEventListener("pointerdown", () => requestPermissionOnce(), {
    capture: true,
    once: true,
  });
}

/** Compensates for the phone being held in landscape, where `beta`/`gamma`
 *  swap roles. `screen.orientation` is preferred; the numeric `window.orientation`
 *  is the older iOS fallback for browsers that still ship without the former. */
function orientationAngle(): number {
  const modern = window.screen?.orientation?.angle;
  if (typeof modern === "number") return modern;
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === "number" ? legacy : 0;
}

export interface UseDeviceTiltOptions {
  /** Clamp applied to the final rotation, in degrees. Keep this small — this
   *  is meant to read as a premium touch, not a gimmick. */
  maxTilt?: number;
  /** 0-1 exponential-moving-average factor applied on every reading; lower
   *  is smoother (and laggier). */
  damping?: number;
  /** Forward "lift" applied to the same element while tilt is active. */
  translateZ?: number;
  /** Escape hatch for callers that already have their own gate. */
  disabled?: boolean;
}

export interface UseDeviceTiltResult {
  /** `DeviceOrientationEvent` exists in this browser at all. True on many
   *  desktops that have the constructor but no sensor, so this alone does not
   *  mean the effect is doing anything — see `active`. */
  supported: boolean;
  /** Live orientation readings are currently driving the transform. */
  active: boolean;
}

/**
 * Smoothed device-orientation tilt, applied as an imperative style mutation
 * (the same pattern `<TiltCard>`'s mouse-driven tilt already uses) rather
 * than React state, so a whole grid of cards can each track the gyroscope
 * without a re-render on every ~60Hz sensor tick.
 *
 * Takes the target element's `ref` as an argument, created by the caller
 * with a plain `useRef`, instead of handing back a ref of its own: React's
 * static analysis (the `react-hooks/refs` rule) flags a ref-writing callback
 * that round-trips through a custom hook's return value and back into JSX as
 * an unsafe "ref access during render", even though nothing here actually
 * touches `.current` outside an effect. Accepting the caller's ref sidesteps
 * that false positive and is the more conventional shape besides.
 */
export function useDeviceTilt(
  elRef: RefObject<HTMLElement | null>,
  options: UseDeviceTiltOptions = {}
): UseDeviceTiltResult {
  const { maxTilt = 7, damping = 0.14, translateZ = 10, disabled = false } = options;
  const reduce = useReducedMotion();
  const [supported] = useState(isSupported);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const node = elRef.current;
    if (reduce || disabled || !supported || !node) return;

    let cancelled = false;
    let frame: number | null = null;
    let listening = false;
    let announcedActive = false;

    let smoothX = 0;
    let smoothY = 0;
    let target = { x: 0, y: 0 };
    // Wherever the phone happens to be held when the first reading arrives
    // becomes "flat" — tilting is relative to that, not to beta/gamma's own
    // zero, which is a phone lying face-up on a table.
    let baseline: { x: number; y: number } | null = null;

    const clamp = (v: number) => Math.max(-maxTilt, Math.min(maxTilt, v));

    const render = () => {
      frame = null;
      if (cancelled) return;
      smoothX += (target.x - smoothX) * damping;
      smoothY += (target.y - smoothY) * damping;
      node.style.transition = "none";
      node.style.transform = `perspective(900px) rotateX(${(-smoothY).toFixed(
        2
      )}deg) rotateY(${smoothX.toFixed(2)}deg) translateZ(${translateZ}px)`;
      if (
        Math.abs(target.x - smoothX) > 0.02 ||
        Math.abs(target.y - smoothY) > 0.02
      ) {
        frame = requestAnimationFrame(render);
      }
    };

    const scheduleFrame = () => {
      if (frame === null) frame = requestAnimationFrame(render);
    };

    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      let x = e.gamma;
      let y = e.beta;
      switch (orientationAngle()) {
        case 90:
          x = -e.beta;
          y = e.gamma;
          break;
        case -90:
        case 270:
          x = e.beta;
          y = -e.gamma;
          break;
        case 180:
          x = -e.gamma;
          y = -e.beta;
          break;
        default:
          break;
      }
      if (!baseline) baseline = { x, y };
      target = { x: clamp((x - baseline.x) * 0.35), y: clamp((y - baseline.y) * 0.35) };
      if (!announcedActive) {
        announcedActive = true;
        setActive(true);
      }
      scheduleFrame();
    };

    const start = () => {
      if (listening || cancelled) return;
      listening = true;
      window.addEventListener("deviceorientation", onOrientation);
    };

    const onPermissionChange = () => {
      if (!cancelled && permissionState === "granted") start();
    };

    if (permissionState === "unnecessary" || permissionState === "granted") {
      start();
    } else if (permissionState === "unknown") {
      subscribers.add(onPermissionChange);
      attachGestureListenerOnce();
    }

    return () => {
      cancelled = true;
      subscribers.delete(onPermissionChange);
      if (frame !== null) cancelAnimationFrame(frame);
      if (listening) window.removeEventListener("deviceorientation", onOrientation);
      node.style.transform = "";
      node.style.transition = "";
    };
  }, [reduce, disabled, supported, maxTilt, damping, translateZ, elRef]);

  return { supported, active };
}
