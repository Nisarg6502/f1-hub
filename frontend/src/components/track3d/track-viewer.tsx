"use client";

import { useCallback, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";

import TrackMap from "@/components/track-map";
import type { TrackHighlight } from "@/lib/circuit-geometry";
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
  /** Static outline, used for the no-WebGL fallback. */
  fallbackImage?: string | null;
  circuitName: string;
}

export default function TrackViewer({
  geometryId,
  fallbackImage,
  circuitName,
}: TrackViewerProps) {
  const { payload, error } = useTrackPayload(geometryId);
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
  const [activated, setActivated] = useState(false);
  const [showTerrain, setShowTerrain] = useState(true);
  const [showRaceline, setShowRaceline] = useState(true);
  const [lowPower, setLowPower] = useState(false);

  const selectHighlight = useCallback((highlight: TrackHighlight) => {
    setActiveHighlight(highlight.id);
    rig.current?.flyHighlight(highlight.s_start_m, highlight.s_end_m);
  }, []);

  const choosePreset = useCallback((id: CameraPresetId) => {
    // Side-on view auto-boosts exaggeration: at 1:1 a 100 m rise over a 7 km lap
    // is a 1.5% slope and the whole point of the view is lost.
    if (id === "profile") setExaggeration((current) => Math.max(current, 4));
    rig.current?.goTo(id);
  }, []);

  if (error) {
    return (
      <div className="apex-glass-soft rounded-[22px] p-8 text-center">
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
      <div className="apex-glass-soft rounded-[22px] h-[540px] animate-pulse" />
    );
  }

  const stats = payload.elevation;

  // No WebGL: the static outline plus a fully working profile strip. The user
  // still learns that Eau Rouge climbs 47 m.
  if (webgl === false) {
    return (
      <div className="apex-glass-strong apex-sheen rounded-[22px] p-6">
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
      <div className="apex-glass-strong apex-sheen rounded-[22px] overflow-hidden relative">
        <div
          className="h-[clamp(360px,58vh,660px)] w-full outline-none"
          tabIndex={0}
          onPointerDown={() => setActivated(true)}
          onFocus={() => setActivated(true)}
          role="application"
          aria-label={`Interactive 3D elevation model of ${circuitName}. Arrow keys orbit, plus and minus zoom, keys 1 to 4 change view.`}
          onKeyDown={(event) => {
            const index = ["1", "2", "3", "4"].indexOf(event.key);
            if (index >= 0) {
              event.preventDefault();
              choosePreset(PRESETS[index].id);
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
              reducedMotion={reducedMotion}
            />
            <CameraRig
              frames={bundle.frames}
              exaggeration={exaggeration}
              reducedMotion={reducedMotion}
              scrub={scrub}
              enableZoom={activated}
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
            without saying by how much. */}
        <div className="absolute top-4 left-4 flex items-center gap-2">
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

        {!activated && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
            <span className="apex-glass-soft rounded-lg px-3 py-1.5 font-medium text-[11px] text-warm-400">
              Click to orbit · scroll to zoom once active
            </span>
          </div>
        )}

        {flying && (
          <button
            type="button"
            onClick={() => rig.current?.stopFly()}
            className="absolute top-4 right-4 apex-glass-soft rounded-lg px-3 py-1.5 font-semibold text-[11px] text-warm-200 transition-transform duration-150 active:scale-[0.97]"
          >
            Stop flythrough
          </button>
        )}
      </div>

      {/* Controls */}
      <div className="apex-glass apex-sheen rounded-[18px] p-4 flex flex-wrap items-center gap-x-6 gap-y-4">
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
        </ControlGroup>
      </div>

      {/* Elevation profile + highlights */}
      <div className="apex-glass apex-sheen rounded-[18px] p-5">
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
              className={`apex-glass-soft rounded-[14px] p-4 text-left transition-transform duration-150 active:scale-[0.98] ${
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
