"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { Play, Pause, SkipBack, Flag } from "lucide-react";
import type { RaceReplay, ReplayLap } from "@/lib/api";
import { getTeamColor } from "@/lib/team-colors";

interface RaceReplayViewProps {
  replay: RaceReplay;
  /** Opens the scrubber straight to this lap — how a `[RC L66]` citation or a
   * `?lap=` deep link lands on the moment it's about, instead of lap 1. A lap
   * with no matching row (out of range, or the round hasn't reached it in the
   * data) is ignored rather than clamped, so an odd link fails quietly to the
   * default start instead of guessing at a nearby lap. */
  initialLap?: number;
}

/** Strong ease-out, matching `--ease-out-apex` and the rest of the app's motion. */
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/** Shared with `tire-stints-chart.tsx` — the same tyre reads the same colour
 * everywhere in the app. */
const COMPOUND_COLORS: Record<string, string> = {
  SOFT: "#FF3333",
  MEDIUM: "#FFE700",
  HARD: "#F0F0F0",
  INTERMEDIATE: "#43B02A",
  WET: "#0067AD",
};

const ROW_HEIGHT = 34;

/** Half the scrub thumb's width. The thumb's travel is inset by this at both
 * ends so it stays fully on the rail at lap 1 and the final lap instead of
 * hanging half off — and `lapFromClientX` insets by the same amount, so the
 * thumb still sits exactly under the pointer. */
const THUMB_INSET = 8;

/** Milliseconds per lap at 1x. Chosen so a 52-lap race replays in ~30s —
 * long enough to read the order changing, short enough to watch end to end. */
const BASE_MS_PER_LAP = 560;
const SPEEDS = [1, 2, 4] as const;

/** Race-control kinds worth a marker on the scrub track. A lap deletion or a
 * "no further action" outcome is real but not something you'd scrub *to*, so
 * the track stays readable rather than showing every event. */
const NOTABLE_EVENT_KINDS = new Set([
  "penalty",
  "red_flag",
  "safety_car_deployed",
]);

/** Readable labels for the `kind` values `race_control_facts.py` emits. A chip
 * showing only a driver name says nothing about what happened to them, so the
 * kind always leads. */
const EVENT_LABELS: Record<string, string> = {
  penalty: "Penalty",
  penalty_served: "Penalty served",
  investigation: "Under investigation",
  no_further_action: "No further action",
  safety_car_deployed: "Safety car",
  safety_car_ending: "Safety car ending",
  red_flag: "Red flag",
};

/** Penalties and stoppages carry the session; an investigation or a cleared
 * incident is context. Tone separates them without a legend. */
const URGENT_EVENT_KINDS = new Set(["penalty", "red_flag", "safety_car_deployed"]);

function eventLabel(kind: string): string {
  return EVENT_LABELS[kind] ?? kind.replace(/_/g, " ");
}

function formatGap(gap: number | null | undefined, isLeader: boolean): string {
  if (isLeader) return "LEADER";
  if (gap === null || gap === undefined) return "—";
  return `+${gap.toFixed(3)}`;
}

export default function RaceReplayView({ replay, initialLap }: RaceReplayViewProps) {
  const reduce = useReducedMotion();
  const laps = replay.laps;
  const lastLapIndex = Math.max(0, laps.length - 1);

  const initialIndex = useMemo(() => {
    if (initialLap === undefined) return 0;
    const found = laps.findIndex((lap) => lap.lap === initialLap);
    return found >= 0 ? found : 0;
  }, [initialLap, laps]);

  const [lapIndex, setLapIndex] = useState(initialIndex);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [scrubbing, setScrubbing] = useState(false);

  const trackRef = useRef<HTMLDivElement>(null);

  const msPerLap = BASE_MS_PER_LAP / speed;

  // Row movement is capped at 260ms (the app's dropdown-ish range) but shortened
  // further at high speed, so a row still settles before the next lap lands
  // instead of smearing through three positions at 4x.
  const rowTransitionMs = reduce ? 0 : Math.min(260, Math.round(msPerLap * 0.85));

  const current: ReplayLap | undefined = laps[lapIndex];

  /* ----------------------------- playback ----------------------------- */

  // A rAF accumulator rather than setInterval: it's display-synced, and it
  // doesn't drift or queue up missed ticks when the tab is backgrounded.
  useEffect(() => {
    if (!playing || laps.length === 0) return;

    let frame = 0;
    let last = performance.now();
    let accumulated = 0;

    const tick = (now: number) => {
      accumulated += now - last;
      last = now;

      if (accumulated >= msPerLap) {
        const steps = Math.floor(accumulated / msPerLap);
        accumulated -= steps * msPerLap;
        setLapIndex((index) => {
          const next = index + steps;
          if (next >= lastLapIndex) {
            setPlaying(false);
            return lastLapIndex;
          }
          return next;
        });
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, msPerLap, lastLapIndex, laps.length]);

  /* ----------------------------- scrubbing ---------------------------- */

  const lapFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || lastLapIndex === 0) return 0;
      const rect = track.getBoundingClientRect();
      const usable = Math.max(1, rect.width - THUMB_INSET * 2);
      const ratio = (clientX - rect.left - THUMB_INSET) / usable;
      const clamped = Math.min(1, Math.max(0, ratio));
      return Math.round(clamped * lastLapIndex);
    },
    [lastLapIndex]
  );

  // Pointer capture so the scrub keeps tracking when the pointer leaves the
  // track, and the lap updates on pointer *down* rather than on release —
  // feedback during the gesture, not after it.
  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubbing(true);
    setPlaying(false);
    setLapIndex(lapFromClientX(event.clientX));
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    setLapIndex(lapFromClientX(event.clientX));
  };

  const endScrub = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setScrubbing(false);
  };

  // Arrow keys step lap-by-lap. Deliberately unanimated in effect — a
  // keyboard-repeated action shouldn't wait on motion to catch up, which is
  // why row transitions are already short enough not to queue.
  const handleTrackKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setPlaying(false);
      setLapIndex((index) =>
        Math.min(lastLapIndex, Math.max(0, index + (event.key === "ArrowRight" ? 1 : -1)))
      );
    }
  };

  /* ------------------------------ markers ----------------------------- */

  const markers = useMemo(() => {
    const pit: number[] = [];
    const notable: number[] = [];
    laps.forEach((lap, index) => {
      if (lap.runners.some((r) => r.pit)) pit.push(index);
      if (lap.events.some((e) => NOTABLE_EVENT_KINDS.has(e.kind))) notable.push(index);
    });
    return { pit, notable };
  }, [laps]);

  if (!replay.synced || laps.length === 0) {
    return (
      <div className="apex-glass-soft rounded-2xl px-6 py-14 text-center">
        <div className="font-[family-name:var(--font-headline)] font-bold text-xl">
          Replay not available
        </div>
        <p className="font-medium text-sm text-warm-400 mt-2 max-w-md mx-auto">
          This round hasn&apos;t been processed yet. Lap-by-lap data usually appears within a few
          hours of the chequered flag.
        </p>
      </div>
    );
  }

  const progress = lastLapIndex === 0 ? 0 : lapIndex / lastLapIndex;

  /** Marker positions share the thumb's inset travel so a pit tick sits exactly
   * under the thumb when you scrub to that lap. */
  const markerLeft = (index: number) =>
    `calc(${THUMB_INSET}px + ${
      lastLapIndex === 0 ? 0 : index / lastLapIndex
    } * (100% - ${THUMB_INSET * 2}px))`;

  return (
    <div className="apex-glass-soft rounded-2xl p-[22px]">
      <div className="flex items-baseline gap-3 mb-4">
        <span className="font-bold text-[11px] tracking-[0.12em] uppercase text-flame">
          Race replay
        </span>
        <span className="ml-auto font-extrabold text-lg tabular-nums">
          Lap {current?.lap ?? 0}
          <span className="text-warm-500 font-bold text-sm"> / {replay.total_laps}</span>
        </span>
      </div>

      {/* Controls + scrub track sit above the tower: the interactive part of
          the replay is what you reach for first, and it stays put as the
          tower's height changes lap to lap (field size, event chips) instead
          of the controls shifting under your cursor mid-drag. */}
      <div className="flex items-center gap-2 mb-4">
        <button
          type="button"
          onClick={() => {
            if (lapIndex >= lastLapIndex) setLapIndex(0);
            setPlaying((p) => !p);
          }}
          aria-label={playing ? "Pause replay" : "Play replay"}
          className="flex items-center justify-center w-10 h-10 rounded-xl text-[#1a1210] transition-transform duration-150 ease-out active:scale-[0.97]"
          style={{ background: "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))" }}
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </button>

        <button
          type="button"
          onClick={() => {
            setPlaying(false);
            setLapIndex(0);
          }}
          aria-label="Restart replay"
          className="flex items-center justify-center w-10 h-10 rounded-xl bg-veil/6 border border-white/10 text-warm-300 hover:text-primary transition-[color,transform] duration-150 ease-out active:scale-[0.97]"
        >
          <SkipBack size={16} />
        </button>

        <div className="ml-auto flex items-center gap-1">
          {SPEEDS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSpeed(option)}
              aria-pressed={speed === option}
              className={`font-bold text-[11px] px-2.5 py-1.5 rounded-lg transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97] ${
                speed === option
                  ? "bg-primary-container/18 text-primary"
                  : "text-warm-400 hover:text-on-background"
              }`}
            >
              {option}×
            </button>
          ))}
        </div>
      </div>

      {/* Scrub track */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Race lap"
        aria-valuemin={1}
        aria-valuemax={replay.total_laps}
        aria-valuenow={current?.lap ?? 1}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endScrub}
        onPointerCancel={endScrub}
        onKeyDown={handleTrackKeyDown}
        className="relative h-9 mb-5 cursor-pointer touch-none select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-flame rounded-lg"
      >
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-white/[0.08]" />
        <div
          className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-l-full"
          style={{
            left: 0,
            width: `calc(${THUMB_INSET}px + ${progress} * (100% - ${THUMB_INSET * 2}px))`,
            background: "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))",
            // No transition while dragging: the fill must stay glued to the
            // pointer. It only eases when playback moves it.
            transition: scrubbing || !rowTransitionMs ? "none" : `width ${rowTransitionMs}ms linear`,
          }}
        />

        {markers.pit.map((index) => (
          <span
            key={`pit-${index}`}
            className="absolute top-1/2 -translate-y-1/2 w-px h-2.5 bg-white/25 pointer-events-none"
            style={{ left: markerLeft(index) }}
          />
        ))}
        {markers.notable.map((index) => (
          <span
            key={`ev-${index}`}
            className="absolute top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full pointer-events-none"
            style={{ left: markerLeft(index), background: "#FF6B6B" }}
          />
        ))}

        <span
          className="absolute top-1/2 w-4 h-4 rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.5)] pointer-events-none"
          style={{
            left: `calc(${THUMB_INSET}px + ${progress} * (100% - ${THUMB_INSET * 2}px))`,
            transform: `translate(-50%, -50%) scale(${scrubbing ? 1.15 : 1})`,
            transition: scrubbing
              ? "transform 120ms " + EASE_OUT
              : `left ${rowTransitionMs || 0}ms linear, transform 120ms ${EASE_OUT}`,
          }}
        />
      </div>

      {/* Timing tower. Rows are absolutely positioned and moved with transform
          only: 22 rows re-sorting on every lap would thrash layout if they were
          reordered in the DOM, and transform keeps it on the compositor. */}
      <div
        className="relative mb-5"
        style={{ height: (current?.runners.length ?? 0) * ROW_HEIGHT }}
      >
        {current?.runners.map((runner, order) => {
          const driver = replay.drivers[runner.number];
          // `team` is nullable in the replay payload but getTeamColor takes an
          // optional; it already falls back to a neutral colour for unknowns.
          const color = getTeamColor(driver?.team ?? undefined);
          const compound = runner.compound
            ? COMPOUND_COLORS[runner.compound] ?? "var(--color-warm-400)"
            : "var(--color-warm-400)";
          return (
            <div
              key={runner.number}
              className="absolute left-0 right-0 flex items-center gap-3 px-3 rounded-lg"
              style={{
                height: ROW_HEIGHT - 4,
                transform: `translateY(${order * ROW_HEIGHT}px)`,
                // Reduced motion drops the positional travel but keeps the
                // colour fade: the movement is what causes discomfort, and
                // losing the pit/retired highlight's transition would only
                // make the change harder to follow, not gentler.
                transition: rowTransitionMs
                  ? `transform ${rowTransitionMs}ms ${EASE_OUT}, background-color 200ms ease, opacity 200ms ease`
                  : "background-color 200ms ease, opacity 200ms ease",
                background: runner.pit ? "rgb(var(--rgb-primary-container) / 0.14)" : "transparent",
                // A retired car's row is carried forward from its last real
                // lap rather than live — dimmed so it doesn't read as an
                // active, current gap.
                opacity: runner.retired ? 0.5 : 1,
              }}
            >
              <span
                className="font-extrabold text-[13px] tabular-nums w-6 text-right"
                style={{ color: runner.retired ? "var(--color-warm-400)" : order === 0 ? "var(--color-primary)" : "var(--color-warm-400)" }}
              >
                {runner.retired ? "—" : runner.position ?? "—"}
              </span>
              <span
                className="w-[3px] h-5 rounded-hairline flex-none"
                style={{ background: color.hex }}
              />
              <span className="font-bold text-[13px] w-12 flex-none">
                {driver?.code ?? runner.number}
              </span>
              <span className="font-semibold text-[12px] text-warm-300 truncate hidden sm:block flex-1">
                {driver?.name ?? ""}
              </span>
              <span
                className="font-bold text-[10px] tabular-nums px-1.5 py-0.5 rounded flex-none"
                style={{ color: compound, border: `1px solid ${compound}44` }}
                title={runner.retired ? "Tyre at the time of retirement" : runner.compound ?? "Unknown compound"}
              >
                {(runner.compound ?? "?").slice(0, 1)}
                {runner.tyre_age !== null ? ` ${runner.tyre_age}` : ""}
              </span>
              <span
                className="font-semibold text-[12px] tabular-nums w-[76px] text-right flex-none"
                style={{ color: runner.retired ? "#c98a8a" : "#c9c0b4" }}
              >
                {runner.retired ? "RETIRED" : runner.pit ? "IN PIT" : formatGap(runner.gap_seconds, order === 0)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Race-control events for the current lap. Fixed min-height so the
          layout doesn't shift as events come and go while scrubbing. */}
      <div className="min-h-[42px]">
        {current && current.events.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {current.events.map((event, index) => {
              const urgent = URGENT_EVENT_KINDS.has(event.kind);
              return (
                <span
                  key={`${event.kind}-${index}`}
                  className="inline-flex items-center gap-1.5 font-semibold text-[11px] px-2.5 py-1.5 rounded-lg"
                  style={{
                    background: urgent ? "rgba(255,68,68,0.12)" : "rgb(var(--rgb-primary-container)_/_0.1)",
                    border: `1px solid ${urgent ? "rgba(255,68,68,0.3)" : "rgb(var(--rgb-primary-container)_/_0.22)"}`,
                    color: urgent ? "#FF6B6B" : "var(--color-primary)",
                  }}
                  // The full race-control message on hover: the chip is a
                  // summary, and the exact wording is often the real detail.
                  title={event.message}
                >
                  <Flag size={11} className="flex-none" />
                  <span className="font-bold">{eventLabel(event.kind)}</span>
                  {event.drivers.length > 0 && (
                    <span className="text-warm-200 font-medium">
                      · {event.drivers.join(", ")}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
