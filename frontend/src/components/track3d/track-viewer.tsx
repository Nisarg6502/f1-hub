"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";

import TrackMap from "@/components/track-map";
import type {
  TrackCorner,
  TrackGeometryPayload,
  TrackHighlight,
} from "@/lib/circuit-geometry";
import CameraRig, { type CameraPresetId, type CameraRigHandle } from "./camera-rig";
import ElevationProfile from "./elevation-profile";
import TrackScene from "./track-scene";
import type { TrackColorMode } from "./track-shader";
import {
  usePrefersReducedMotion,
  useScrubStore,
  useTrackGeometry,
  useTrackPayload,
  useWebglSupported,
  type TrackScrubStore,
} from "./use-track-geometry";

const PRESETS: { id: CameraPresetId; label: string; hint: string }[] = [
  { id: "three-quarter", label: "Three-quarter", hint: "1" },
  { id: "overhead", label: "Overhead", hint: "2" },
  { id: "profile", label: "Profile", hint: "3" },
  { id: "driver", label: "Driver eye", hint: "4" },
];

const COLOR_MODES: { id: TrackColorMode; label: string }[] = [
  { id: "gradient", label: "Gradient" },
  { id: "elevation", label: "Elevation" },
  { id: "plain", label: "Plain" },
];

interface TrackViewerProps {
  geometryId: string;
  /**
   * Absolute payload URL reported by the availability endpoint. Present for
   * anything generated on demand; null for the bundled circuits, which resolve
   * to their committed copy under `public/tracks/`.
   */
  payloadUrl?: string | null;
  /** Static outline, used for the no-WebGL fallback. */
  fallbackImage?: string | null;
  circuitName: string;
}

export default function TrackViewer({
  geometryId,
  payloadUrl,
  fallbackImage,
  circuitName,
}: TrackViewerProps) {
  const { payload, error } = useTrackPayload(geometryId, payloadUrl);
  const [widthScale, setWidthScale] = useState(3);
  const bundle = useTrackGeometry(payload, widthScale);
  const scrub = useScrubStore();
  const reducedMotion = usePrefersReducedMotion();
  const webgl = useWebglSupported();

  const rig = useRef<CameraRigHandle>(null);
  const [exaggeration, setExaggeration] = useState(2);
  const [colorMode, setColorMode] = useState<TrackColorMode>("gradient");
  const [preset, setPreset] = useState<CameraPresetId>("three-quarter");
  const [flying, setFlying] = useState(false);
  const [activeHighlight, setActiveHighlight] = useState<string | null>(null);
  const [activeCorner, setActiveCorner] = useState<string | null>(null);
  const [activated, setActivated] = useState(false);
  const [showTerrain, setShowTerrain] = useState(true);
  const [showRaceline, setShowRaceline] = useState(true);
  const [showCorners, setShowCorners] = useState(true);
  const [lowPower, setLowPower] = useState(false);
  const [followScrub, setFollowScrub] = useState(true);

  const selectHighlight = useCallback((highlight: TrackHighlight) => {
    setActiveHighlight(highlight.id);
    setActiveCorner(null);
    rig.current?.flyHighlight(highlight.s_start_m, highlight.s_end_m);
  }, []);

  const selectCorner = useCallback((corner: TrackCorner) => {
    setActiveCorner(corner.name);
    setActiveHighlight(null);
    // A named corner is a point, not a range — frame roughly 90 m either side
    // so the flythrough shows the entry and exit, not just the apex.
    rig.current?.flyHighlight(corner.s_m - 90, corner.s_m + 90);
  }, []);

  const toggleLap = useCallback(() => {
    if (flying) {
      rig.current?.stopFly();
      return;
    }
    setActiveHighlight(null);
    setActiveCorner(null);
    rig.current?.flyLap();
  }, [flying]);

  // Hovering the ribbon drives the profile playhead the same way scrubbing the
  // strip does — both write through the same store, so neither view has to
  // know which one is the source of truth. Tagged `hover` so it moves the
  // playhead without dragging the camera along with the pointer.
  const handleHoverDistance = useCallback(
    (metres: number | null) => {
      if (metres !== null) scrub.set(metres, "hover");
    },
    [scrub],
  );

  const choosePreset = useCallback((id: CameraPresetId) => {
    // Side-on view auto-boosts exaggeration: at 1:1 a 100 m rise over a 7 km lap
    // is a 1.5% slope and the whole point of the view is lost.
    if (id === "profile") setExaggeration((current) => Math.max(current, 4));
    rig.current?.goTo(id);
  }, []);

  if (error) {
    return (
      <div className="apex-glass-soft rounded-panel p-8 text-center">
        <p className="font-semibold text-sm text-warm-200">
          Track geometry unavailable
        </p>
        <p className="font-medium text-[12px] text-warm-500 mt-1">
          {circuitName} could not be loaded. The static outline is shown instead.
        </p>
        <TrackMap
          src={fallbackImage ?? null}
          alt={circuitName}
          containerClassName="relative w-full h-[280px] mt-4"
          imgClassName="object-contain"
        />
      </div>
    );
  }

  if (!payload || !bundle || webgl === null) {
    return (
      <div className="apex-glass-soft rounded-panel h-[540px] animate-pulse" />
    );
  }

  const stats = payload.elevation;

  // No WebGL: the static outline plus a fully working profile strip. The user
  // still learns that Eau Rouge climbs 47 m.
  if (webgl === false) {
    return (
      <div className="apex-glass-strong apex-sheen rounded-panel p-6">
        <p className="font-semibold text-[11px] tracking-[0.14em] uppercase text-warm-500 mb-4">
          3D unavailable in this browser — showing the elevation profile
        </p>
        <TrackMap
          src={fallbackImage ?? null}
          alt={circuitName}
          containerClassName="relative w-full h-[260px] mb-6"
          imgClassName="object-contain"
        />
        <ElevationProfile payload={payload} interactive={false} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="apex-glass-strong apex-sheen rounded-panel overflow-hidden relative">
        <div
          className="h-[clamp(360px,58vh,660px)] w-full outline-none"
          tabIndex={0}
          onPointerDown={() => setActivated(true)}
          onFocus={() => setActivated(true)}
          role="application"
          aria-label={`Interactive 3D elevation model of ${circuitName}. Arrow keys orbit, plus and minus zoom, keys 1 to 4 change view, F flies a lap, space stops a flythrough.`}
          onKeyDown={(event) => {
            const index = ["1", "2", "3", "4"].indexOf(event.key);
            if (index >= 0) {
              event.preventDefault();
              choosePreset(PRESETS[index].id);
            }
            if (event.key === "f" || event.key === "F") {
              event.preventDefault();
              toggleLap();
            }
            if (event.key === " " && flying) {
              event.preventDefault();
              rig.current?.stopFly();
            }
          }}
        >
          <Canvas
            // Matches the DPR cap in ember-canvas.tsx.
            dpr={[1, Math.min(2, typeof window === "undefined" ? 1 : window.devicePixelRatio || 1)]}
            camera={{ fov: 42, near: 1, far: bundle.frames.diagonal * 6 }}
            gl={{ antialias: !lowPower, powerPreference: "high-performance" }}
            onCreated={({ gl }) => gl.setClearColor("#0a0908")}
          >
            <PerformanceMonitor
              onDecline={() => setLowPower(true)}
              onIncline={() => setLowPower(false)}
            />
            <TrackScene
              bundle={bundle}
              exaggeration={exaggeration}
              widthScale={widthScale}
              colorMode={colorMode}
              showTerrain={showTerrain && !lowPower}
              showRaceline={showRaceline}
              showPosts={!lowPower}
              // Corner labels are NOT dropped under load. They are ten DOM nodes
              // and the only way to reach a corner flythrough — dropping them
              // takes the feature away on exactly the machines that most need a
              // guided tour, while saving nothing next to terrain and bloom.
              showCorners={showCorners}
              activeCornerName={activeCorner}
              onSelectCorner={selectCorner}
              onHoverDistance={handleHoverDistance}
              reducedMotion={reducedMotion}
              scrub={scrub}
            />
            <CameraRig
              frames={bundle.frames}
              exaggeration={exaggeration}
              reducedMotion={reducedMotion}
              scrub={scrub}
              enableZoom={activated}
              followScrub={followScrub}
              handleRef={rig}
              onPresetChange={setPreset}
              onFlyStateChange={setFlying}
            />

            {/*
              Bloom is decorative only — it is switched off under sustained load
              by PerformanceMonitor, so the scene has to read correctly without
              it. The threshold sits above the tarmac's self-illumination floor
              so only the gradient glow and kerbs bloom, not the whole surface.
            */}
            {!lowPower && (
              <EffectComposer>
                <Bloom
                  intensity={0.85}
                  luminanceThreshold={0.32}
                  luminanceSmoothing={0.35}
                  mipmapBlur
                />
                <Vignette offset={0.28} darkness={0.62} />
              </EffectComposer>
            )}
          </Canvas>
        </div>

        {/* Exaggeration readout is always visible — never show scaled terrain
            without saying by how much. Wraps rather than running under the
            flythrough control on narrow viewports. */}
        <div className="absolute top-4 left-4 right-4 flex flex-wrap items-center gap-2">
          <span
            className={`apex-glass-soft rounded-lg px-2.5 py-1.5 font-bold text-[10px] tracking-[0.12em] uppercase ${
              exaggeration === 1 ? "text-[#ffae6a]" : "text-warm-300"
            }`}
          >
            {exaggeration === 1 ? "True scale" : `${exaggeration.toFixed(1)}× vertical`}
          </span>
          {widthScale !== 1 && (
            <span className="apex-glass-soft rounded-lg px-2.5 py-1.5 font-medium text-[10px] tracking-[0.12em] uppercase text-warm-400">
              {widthScale}× width
            </span>
          )}
          <span className="apex-glass-soft rounded-lg px-2.5 py-1.5 font-medium text-[10px] tracking-[0.06em] uppercase text-warm-500">
            {stats.source} · {stats.confidence}
          </span>
        </div>

        {/*
          The flythrough control is a solid, opaque button rather than another
          glass chip. Every other overlay here is translucent, and over a dark
          scene with bloom the previous glass "Stop flythrough" pill in the top
          corner disappeared into the terrain behind it. This is the one control
          that must always be findable, so it gets the only filled treatment in
          the viewer and a fixed seat in the bottom bar.
        */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 p-4 flex flex-wrap items-end justify-between gap-3">
          <div className="pointer-events-auto flex items-center gap-2.5">
            <button
              type="button"
              onClick={toggleLap}
              aria-pressed={flying}
              className={`rounded-xl px-4 py-2.5 font-bold text-[11px] tracking-[0.1em] uppercase border transition-transform duration-150 active:scale-[0.97] ${
                flying
                  ? "bg-[#181310] border-[rgba(255,174,106,0.5)] text-[#ffae6a] shadow-[0_6px_20px_rgba(0,0,0,0.6)]"
                  : "bg-[#ff5a1f] border-[rgba(255,174,106,0.8)] text-[#160b04] shadow-[0_6px_22px_rgba(255,90,31,0.42)] hover:bg-[#ff6f36]"
              }`}
            >
              {flying ? "Stop tour" : "Fly the lap"}
            </button>
            {flying && (
              <LapProgress payload={payload} scrub={scrub} />
            )}
          </div>

          {!activated && (
            <span className="apex-glass-soft rounded-lg px-3 py-1.5 font-medium text-[11px] text-warm-400">
              Click to orbit · scroll to zoom once active
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="apex-glass apex-sheen rounded-card p-4 flex flex-wrap items-center gap-x-6 gap-y-4">
        <ControlGroup label="View">
          {PRESETS.map((item) => (
            <Chip
              key={item.id}
              active={preset === item.id}
              onClick={() => choosePreset(item.id)}
            >
              {item.label}
            </Chip>
          ))}
        </ControlGroup>

        <ControlGroup label="Colour">
          {COLOR_MODES.map((item) => (
            <Chip
              key={item.id}
              active={colorMode === item.id}
              onClick={() => setColorMode(item.id)}
            >
              {item.label}
            </Chip>
          ))}
        </ControlGroup>

        <ControlGroup label={`Vertical ${exaggeration.toFixed(1)}×`}>
          <input
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={exaggeration}
            onChange={(event) => setExaggeration(Number(event.target.value))}
            aria-label="Vertical exaggeration"
            className="w-32 accent-[#ff5a1f]"
          />
          <Chip active={exaggeration === 1} onClick={() => setExaggeration(1)}>
            1:1
          </Chip>
        </ControlGroup>

        <ControlGroup label="Track width">
          <Chip active={widthScale === 3} onClick={() => setWidthScale(3)}>
            Readable
          </Chip>
          <Chip active={widthScale === 1} onClick={() => setWidthScale(1)}>
            True width
          </Chip>
        </ControlGroup>

        <ControlGroup label="Layers">
          <Chip active={showTerrain} onClick={() => setShowTerrain((v) => !v)}>
            Terrain
          </Chip>
          <Chip
            active={showRaceline}
            onClick={() => setShowRaceline((v) => !v)}
            disabled={!bundle.raceline}
          >
            Racing line
          </Chip>
          <Chip
            active={showCorners}
            onClick={() => setShowCorners((v) => !v)}
            disabled={payload.corners.length === 0}
          >
            Corners
          </Chip>
        </ControlGroup>

        <ControlGroup label="Camera">
          <Chip active={followScrub} onClick={() => setFollowScrub((v) => !v)}>
            Follow scrub
          </Chip>
        </ControlGroup>
      </div>

      {/* Elevation profile + highlights */}
      <div className="apex-glass apex-sheen rounded-card p-5">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="font-[family-name:var(--font-headline)] font-bold text-[15px]">
            Elevation profile
          </h2>
          <span className="font-medium text-[11px] text-warm-500 tabular-nums">
            {stats.total_change_m.toFixed(0)} m change · {stats.max_gradient_pct.toFixed(1)}%
            max climb over {stats.gradient_baseline_m.toFixed(0)} m
          </span>
        </div>

        <ElevationProfile
          payload={payload}
          scrub={scrub}
          activeHighlightId={activeHighlight}
          onSelectHighlight={selectHighlight}
        />

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-5">
          {payload.highlights.map((highlight) => (
            <button
              key={highlight.id}
              type="button"
              onClick={() => selectHighlight(highlight)}
              className={`apex-glass-soft rounded-tile p-4 text-left transition-transform duration-150 active:scale-[0.98] ${
                activeHighlight === highlight.id ? "ring-1 ring-[rgba(255,174,106,0.5)]" : ""
              }`}
            >
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <span className="font-semibold text-[13px] text-warm-100">
                  {highlight.name}
                </span>
                <span
                  className={`font-bold text-[13px] tabular-nums ${
                    highlight.delta_z_m >= 0 ? "text-[#ffae6a]" : "text-[#ff9b8a]"
                  }`}
                >
                  {highlight.delta_z_m > 0 ? "+" : ""}
                  {highlight.delta_z_m.toFixed(0)} m
                </span>
              </div>
              <p className="font-medium text-[11px] text-warm-500 mb-2 tabular-nums">
                {highlight.gradient_pct.toFixed(1)}% over {highlight.run_m.toFixed(0)} m
              </p>
              <p className="font-medium text-[12px] text-warm-400 leading-snug">
                {highlight.blurb}
              </p>
            </button>
          ))}
        </div>

        {/* Screen readers get the information, not the canvas. */}
        <p className="sr-only">
          {circuitName} has {stats.total_change_m.toFixed(0)} metres of elevation
          change, from {(stats.min_m).toFixed(0)} to {(stats.max_m).toFixed(0)} metres
          above sea level, with a maximum climb of {stats.max_gradient_pct.toFixed(1)}
          percent and a maximum descent of {Math.abs(stats.min_gradient_pct).toFixed(1)}
          percent measured over {stats.gradient_baseline_m.toFixed(0)} metre baselines.
          {payload.highlights.map(
            (h) =>
              ` ${h.name}: ${h.delta_z_m > 0 ? "climbs" : "descends"} ${Math.abs(
                h.delta_z_m,
              ).toFixed(0)} metres over ${h.run_m.toFixed(0)} metres.`,
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * Live lap position during a flythrough.
 *
 * Subscribes to the scrub store and writes to the DOM through refs rather than
 * holding the position in React state: the store ticks every frame while flying,
 * and re-rendering the viewer (and therefore the Canvas subtree) at 60 Hz to
 * update a progress bar would be self-defeating.
 */
function LapProgress({
  payload,
  scrub,
}: {
  payload: TrackGeometryPayload;
  scrub: TrackScrubStore;
}) {
  const barRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const paint = (metres: number) => {
      const total = payload.length_m;
      const wrapped = ((metres % total) + total) % total;
      if (barRef.current) {
        barRef.current.style.transform = `scaleX(${(wrapped / total).toFixed(4)})`;
      }
      if (labelRef.current) {
        // Nearest named corner behind the camera, so the readout says where you
        // are in words and not only in metres.
        let nearest: string | null = null;
        let best = Infinity;
        for (const corner of payload.corners) {
          const gap = wrapped - corner.s_m;
          if (gap >= -40 && gap < best) {
            best = gap;
            nearest = corner.name;
          }
        }
        labelRef.current.textContent = nearest
          ? `${nearest} · ${(wrapped / 1000).toFixed(2)} km`
          : `${(wrapped / 1000).toFixed(2)} km`;
      }
    };
    paint(scrub.current);
    return scrub.subscribe(paint);
  }, [scrub, payload]);

  // Solid, not glass: a flythrough runs low over brightly lit tarmac, and a
  // translucent panel there is unreadable at exactly the moment it matters.
  return (
    <span className="rounded-lg px-3 py-2 flex flex-col gap-1.5 min-w-[150px] bg-[#181310] border border-white/12 shadow-[0_6px_20px_rgba(0,0,0,0.6)]">
      <span
        ref={labelRef}
        className="font-semibold text-[10px] tracking-[0.06em] uppercase text-warm-200 tabular-nums"
      />
      <span className="block h-[3px] w-full rounded-full bg-white/15 overflow-hidden">
        <span
          ref={barRef}
          className="block h-full w-full origin-left rounded-full bg-[#ff7a3d]"
          style={{ transform: "scaleX(0)" }}
        />
      </span>
    </span>
  );
}

function ControlGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-semibold text-[9px] tracking-[0.14em] uppercase text-warm-600">
        {label}
      </span>
      <div className="flex items-center gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  disabled,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-lg px-2.5 py-1.5 font-semibold text-[11px] border transition-transform duration-150 active:scale-[0.97] disabled:opacity-35 disabled:pointer-events-none ${
        active
          ? "bg-[rgba(255,90,31,0.18)] border-[rgba(255,174,106,0.45)] text-[#ffae6a]"
          : "bg-[rgba(40,32,26,0.4)] border-white/10 text-warm-300 hover:text-warm-100"
      }`}
    >
      {children}
    </button>
  );
}
