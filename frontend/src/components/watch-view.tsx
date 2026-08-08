"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useReducedMotion } from "motion/react";
import {
  Play,
  Pause,
  RotateCcw,
  Flag,
  Maximize2,
  Minimize2,
  X,
  Lightbulb,
  LightbulbOff,
} from "lucide-react";
import type { RaceReplay, ReplayLap } from "@/lib/api";
import { getTeamColor } from "@/lib/team-colors";
import {
  RealTimeLapClock,
  cumulativeMs,
  formatLapDuration,
  formatRaceClock,
  lapDurations,
} from "@/lib/watch-clock";

/** Shared with `race-replay.tsx` and `tire-stints-chart.tsx` — the same tyre
 * reads the same colour everywhere in the app. */
const COMPOUND_COLORS: Record<string, string> = {
  SOFT: "#FF3333",
  MEDIUM: "#FFE700",
  HARD: "#F0F0F0",
  INTERMEDIATE: "#43B02A",
  WET: "#0067AD",
};

const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";

/* A note on the `[@media(max-height:520px)]:` classes below: a phone in
 * landscape is ~390 CSS pixels tall, and at their comfortable desktop sizes the
 * header, lap bar and control strip leave the tower barely half of that. Since
 * the tower divides its height by twenty, every pixel the chrome gives back is
 * twenty pixels of legibility. They key on viewport *height* rather than a
 * width breakpoint because height is the thing actually in short supply — an
 * 844x390 phone is wide. Written out in full at each use rather than composed
 * from a constant: Tailwind scans source text for complete class names and
 * would not emit a class assembled at runtime. */

/** Same vocabulary as the desk-sized replay; the labels are the ones
 * `race_control_facts.py` emits. */
const EVENT_LABELS: Record<string, string> = {
  penalty: "Penalty",
  penalty_served: "Penalty served",
  investigation: "Under investigation",
  no_further_action: "No further action",
  safety_car_deployed: "Safety car",
  safety_car_ending: "Safety car ending",
  red_flag: "Red flag",
};

const URGENT_EVENT_KINDS = new Set(["penalty", "red_flag", "safety_car_deployed"]);

function eventLabel(kind: string): string {
  return EVENT_LABELS[kind] ?? kind.replace(/_/g, " ");
}

function formatGap(gap: number | null | undefined, isLeader: boolean): string {
  if (isLeader) return "LEADER";
  if (gap === null || gap === undefined) return "—";
  return `+${gap.toFixed(1)}`;
}

/** How far each driver moved since the previous lap, keyed by car number.
 * Positive is places gained. Computed against the previous lap only — a watch
 * party cares about "who just moved", which is a per-lap question. */
function positionDeltas(
  current: ReplayLap | undefined,
  previous: ReplayLap | undefined
): Record<string, number> {
  if (!current || !previous) return {};
  const before: Record<string, number> = {};
  previous.runners.forEach((runner, order) => {
    before[runner.number] = order;
  });
  const deltas: Record<string, number> = {};
  current.runners.forEach((runner, order) => {
    const was = before[runner.number];
    if (was === undefined || was === order) return;
    deltas[runner.number] = was - order;
  });
  return deltas;
}

/**
 * Keeps the screen awake for as long as this component is mounted.
 *
 * A phone propped against a TV will dim and lock partway through a 90-minute
 * race otherwise, which defeats the entire mode. The lock is dropped by the
 * browser whenever the page is hidden and is *not* restored automatically, so
 * it has to be re-requested on `visibilitychange` — a tab-switch and back would
 * otherwise silently leave the screen sleeping again.
 *
 * Unsupported browsers (Safari before 16.4, any non-secure context) simply
 * report false rather than throwing; the UI shows the state instead of
 * claiming a lock it does not hold.
 */
function useWakeLock(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    // Nothing to set here when disabled: `held` is reported through `enabled`
    // below, so the effect never has to write state synchronously to say "off".
    if (!enabled) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const request = async () => {
      if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void lock.release();
          return;
        }
        sentinel = lock;
        setHeld(true);
        lock.addEventListener("release", () => setHeld(false));
      } catch {
        // Denied (battery saver, permissions policy). Not an error worth
        // interrupting the race for — the indicator just stays off.
        setHeld(false);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void request();
    };

    void request();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel?.release().catch(() => {});
      setHeld(false);
    };
  }, [enabled]);

  return enabled && held;
}

export default function WatchView({ replay }: { replay: RaceReplay }) {
  const reduce = useReducedMotion();
  const laps = replay.laps;

  const durations = useMemo(() => lapDurations(laps), [laps]);
  const cumulative = useMemo(() => cumulativeMs(durations.ms), [durations]);
  const totalMs = cumulative[cumulative.length - 1] ?? 0;

  const [lapIndex, setLapIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [keepAwake, setKeepAwake] = useState(true);
  const wakeLockHeld = useWakeLock(keepAwake);

  const clockRef = useRef<RealTimeLapClock | null>(null);
  // Sub-lap progress is written straight to the DOM rather than into React
  // state: it changes every frame, and re-rendering twenty tower rows at 60Hz
  // to move one progress bar is exactly the kind of work that makes a
  // full-screen view stutter. The lap *index* stays in state, because that is
  // a rare change that genuinely re-renders the tower.
  const lapFillRef = useRef<HTMLDivElement>(null);
  const lapTimerRef = useRef<HTMLSpanElement>(null);
  const raceClockRef = useRef<HTMLSpanElement>(null);

  const paintProgress = useCallback(
    (index: number, elapsedMs: number) => {
      const lapMs = durations.ms[index] ?? 0;
      const fraction = lapMs > 0 ? Math.min(1, elapsedMs / lapMs) : 0;
      if (lapFillRef.current) {
        lapFillRef.current.style.width = `${fraction * 100}%`;
      }
      if (lapTimerRef.current) {
        lapTimerRef.current.textContent = formatLapDuration(elapsedMs);
      }
      if (raceClockRef.current) {
        raceClockRef.current.textContent = formatRaceClock(
          (cumulative[index] ?? 0) + elapsedMs
        );
      }
    },
    [cumulative, durations]
  );

  // One clock for the life of the view. It is created in an effect (not in
  // render) so React strict-mode's double-invoke disposes the first one rather
  // than leaking a second rAF loop over the same race.
  useEffect(() => {
    const clock = new RealTimeLapClock({
      durationsMs: durations.ms,
      onLapChange: setLapIndex,
      onFrame: paintProgress,
      onEnd: () => setPlaying(false),
    });
    clockRef.current = clock;
    return () => {
      clock.dispose();
      clockRef.current = null;
    };
  }, [durations, paintProgress]);

  const toggle = useCallback(() => {
    const clock = clockRef.current;
    if (!clock) return;
    clock.toggle();
    setLapIndex(clock.lapIndex);
    setPlaying(clock.playing);
  }, []);

  /** The catch-up control. An instant snap, never a fast-forward: exactly one
   * clock runs, so it is never ambiguous whether what is on screen is real pace
   * or a scrub. */
  const jumpTo = useCallback((index: number) => {
    const clock = clockRef.current;
    if (!clock) return;
    clock.jumpTo(index);
    setLapIndex(clock.lapIndex);
  }, []);

  const restart = useCallback(() => {
    const clock = clockRef.current;
    if (!clock) return;
    clock.pause();
    clock.jumpTo(0);
    setLapIndex(0);
    setPlaying(false);
  }, []);

  /* ------------------------- fullscreen + keys ------------------------- */

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // Refused (iOS Safari has no element fullscreen on phones). The route is
      // already chrome-free, so this is a nicety, not a requirement.
    }
  }, []);

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Typing a lap number into the jump field must not also toggle playback.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.isContentEditable)) return;
      if (event.key === " ") {
        event.preventDefault();
        toggle();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        jumpTo((clockRef.current?.lapIndex ?? 0) + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        jumpTo((clockRef.current?.lapIndex ?? 0) - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, jumpTo]);

  /* ------------------------------ derived ------------------------------ */

  const current = laps[lapIndex];
  const deltas = useMemo(
    () => positionDeltas(current, laps[lapIndex - 1]),
    [current, laps, lapIndex]
  );

  /** Race control up to and including the current lap, newest first — the lap
   * an event was issued on is part of the event, so it leads each row. Events
   * from laps that have not happened yet are withheld: a watch-party screen
   * that spoils the red flag four laps early is worse than useless. */
  const feed = useMemo(() => {
    const rows: Array<{ lap: number; kind: string; drivers: string[]; message: string }> = [];
    for (let index = lapIndex; index >= 0 && rows.length < 40; index -= 1) {
      const lap = laps[index];
      if (!lap) continue;
      for (const event of lap.events) rows.push({ lap: lap.lap, ...event });
    }
    return rows;
  }, [laps, lapIndex]);

  const currentLapMs = durations.ms[lapIndex] ?? 0;
  const currentIsEstimated = durations.source[lapIndex] === "estimated";

  // Rows are sized off the measured tower height so a full field fills a
  // landscape screen instead of being sized for a desk. Measured rather than
  // computed from a viewport unit because the header and control bar wrap
  // differently at different widths, and guessing their height is how a tower
  // ends up scrolling on exactly one device.
  const towerRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(44);
  const runnerCount = current?.runners.length ?? 20;

  useEffect(() => {
    const node = towerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const available = entry.contentRect.height;
      if (available <= 0) return;
      // There is deliberately **no lower bound**. An earlier version floored
      // this at a comfortable 30px, and on a 720p window that asked for 600px
      // of a 440px column — the last five cars were simply off the bottom of
      // the screen. Measured, not guessed. A whole field that is smaller than
      // ideal beats a large field with P16-P20 missing, and the tall screens
      // this mode is really for hit the 72px ceiling instead. CP78's
      // compact/expanded densities are where the cramped end gets a real
      // answer.
      setRowHeight(Math.min(72, available / Math.max(1, runnerCount)));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [runnerCount]);

  const rowTransitionMs = reduce ? 0 : 420;

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden bg-[#070605] text-on-background select-none">
      {/* ------------------------------ header ------------------------------ */}
      <header className="flex items-center gap-4 px-4 md:px-6 py-2.5 [@media(max-height:520px)]:py-1 border-b border-white/[0.07] flex-none">
        <Link
          href="/watch"
          aria-label="Leave watch mode"
          className="flex items-center justify-center w-9 h-9 rounded-xl text-warm-400 hover:text-on-background transition-colors flex-none"
        >
          <X size={18} />
        </Link>

        <div className="min-w-0">
          <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-lg md:text-2xl [@media(max-height:520px)]:text-base leading-none truncate">
            {replay.race_name ?? `Round ${replay.round}`}
          </h1>
          {/* The framing, stated where it cannot be missed. This app has no
              live feed and this mode must never imply one. */}
          <p className="font-semibold text-[10px] md:text-[11px] tracking-[0.12em] uppercase text-warm-500 mt-1">
            Replay · paced from recorded lap times · not live
          </p>
        </div>

        <div className="ml-auto flex items-baseline gap-4 md:gap-7 flex-none">
          <div className="text-right">
            <span
              ref={raceClockRef}
              className="font-[family-name:var(--font-headline)] font-extrabold text-xl md:text-3xl [@media(max-height:520px)]:text-lg tabular-nums block leading-none"
            >
              {formatRaceClock(cumulative[lapIndex] ?? 0)}
            </span>
            <span className="font-semibold text-[9px] tracking-[0.12em] uppercase text-warm-500">
              of {formatRaceClock(totalMs)}
            </span>
          </div>
          <div className="text-right">
            <span className="font-[family-name:var(--font-headline)] font-extrabold text-2xl md:text-4xl [@media(max-height:520px)]:text-xl tabular-nums leading-none block">
              {current?.lap ?? 0}
              <span className="text-warm-500 text-base md:text-2xl"> / {replay.total_laps}</span>
            </span>
            <span className="font-semibold text-[9px] tracking-[0.12em] uppercase text-warm-500">
              Lap
            </span>
          </div>
        </div>
      </header>

      {/* --------------------------- lap progress --------------------------- */}
      <div className="flex-none px-4 md:px-6 pt-2.5 [@media(max-height:520px)]:pt-1">
        <div className="flex items-baseline gap-2 mb-1.5">
          <span className="font-bold text-[10px] tracking-[0.12em] uppercase text-[#FF7A3D]">
            This lap
          </span>
          <span
            ref={lapTimerRef}
            className="font-bold text-xs md:text-sm tabular-nums text-warm-200"
          >
            0:00.0
          </span>
          <span className="font-semibold text-xs md:text-sm tabular-nums text-warm-500">
            of {formatLapDuration(currentLapMs)}
          </span>
          {currentIsEstimated && (
            // Named on the lap it applies to, not buried in a legend: this lap
            // is running on an estimate and the viewer should know while it is
            // the lap on screen.
            <span
              className="font-bold text-[9px] tracking-[0.1em] uppercase px-1.5 py-0.5 rounded text-warm-300 border border-white/15"
              title="No lap time was recorded for this lap. It runs for this race's median lap instead, so the clock keeps moving."
            >
              estimated
            </span>
          )}
        </div>
        {/* A real progressbar rather than a decorative bar: it is the only
            indication of how far through a 90-second lap the clock is, so a
            screen reader should be able to say so too. `aria-valuetext` gives
            the useful answer ("1:31.9 lap") instead of a bare percentage. */}
        <div
          className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden"
          role="progressbar"
          aria-label="Progress through this lap"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`Lap ${current?.lap ?? 0} of ${formatLapDuration(currentLapMs)}`}
        >
          <div
            ref={lapFillRef}
            className="h-full rounded-full"
            style={{ width: "0%", background: "linear-gradient(90deg,#FFAE6A,#FF5A1F)" }}
          />
        </div>
      </div>

      {/* ------------------------------ body ------------------------------ */}
      {/* Split on *orientation*, not width. A phone held landscape is 844x390:
          wide enough that a width breakpoint would stack race control on top
          of the tower and eat a quarter of the 390px the tower has to work
          with. Orientation is the property that actually decides whether there
          is room beside the tower or above it. */}
      <div className="flex-1 min-h-0 flex flex-col landscape:flex-row gap-3 px-4 md:px-6 py-3 [@media(max-height:520px)]:py-1.5">
        {/* Timing tower. Rows are absolutely positioned and moved with
            transform only — twenty rows reordering in the DOM every lap would
            thrash layout, and transform keeps the movement on the compositor.
            Same approach as race-replay.tsx, at watch-party scale. */}
        <div ref={towerRef} className="relative flex-1 min-h-0 overflow-hidden">
          {current?.runners.map((runner, order) => {
            const driver = replay.drivers[runner.number];
            const color = getTeamColor(driver?.team ?? undefined);
            const compound = runner.compound
              ? COMPOUND_COLORS[runner.compound] ?? "#8f867a"
              : "#8f867a";
            const delta = deltas[runner.number] ?? 0;
            return (
              <div
                key={runner.number}
                className="absolute left-0 right-0 flex items-center gap-2 md:gap-4 px-2 md:px-3 rounded-lg"
                style={{
                  height: rowHeight - 3,
                  transform: `translateY(${order * rowHeight}px)`,
                  transition: rowTransitionMs
                    ? `transform ${rowTransitionMs}ms ${EASE_OUT}, background-color 300ms ease, opacity 300ms ease`
                    : "background-color 300ms ease, opacity 300ms ease",
                  background: runner.pit
                    ? "rgba(255,90,31,0.16)"
                    : order % 2 === 0
                    ? "rgba(255,255,255,0.025)"
                    : "transparent",
                  // A retired car's row is carried forward from its last real
                  // lap, not live — dimmed so it never reads as a current gap.
                  opacity: runner.retired ? 0.42 : 1,
                  // Everything inside the row is sized in `em` off this, so
                  // one number scales the whole tower from a phone to a TV.
                  // The 9px floor is a legibility backstop for the shortest
                  // screens; the row height itself is never floored, because
                  // that is what pushes cars off-screen.
                  fontSize: Math.max(9, rowHeight * 0.42),
                }}
              >
                <span
                  className="font-extrabold tabular-nums w-[1.6em] text-right flex-none"
                  style={{
                    color: runner.retired ? "#8f867a" : order === 0 ? "#FFAE6A" : "#f6f1ea",
                  }}
                >
                  {runner.retired ? "—" : runner.position ?? "—"}
                </span>

                {/* Position change on this lap, marked as it happens. */}
                <span
                  className="font-bold tabular-nums w-[1.9em] text-center flex-none"
                  style={{
                    fontSize: "0.6em",
                    color: delta > 0 ? "#7BD88F" : delta < 0 ? "#FF8A7A" : "transparent",
                  }}
                  aria-hidden={delta === 0}
                >
                  {delta > 0 ? `▲${delta}` : delta < 0 ? `▼${-delta}` : ""}
                </span>

                <span
                  className="w-[4px] rounded-[2px] flex-none"
                  style={{ background: color.hex, height: "1.3em" }}
                />

                <span className="font-extrabold flex-none w-[2.8em] tracking-[-0.01em]">
                  {driver?.code ?? runner.number}
                </span>

                <span
                  className="font-semibold text-warm-300 truncate hidden md:block flex-1"
                  style={{ fontSize: "0.72em" }}
                >
                  {driver?.name ?? ""}
                </span>

                <span
                  className="font-bold tabular-nums px-1.5 py-0.5 rounded flex-none ml-auto md:ml-0"
                  style={{
                    fontSize: "0.62em",
                    color: compound,
                    border: `1px solid ${compound}44`,
                  }}
                  title={
                    runner.retired
                      ? "Tyre at the time of retirement"
                      : runner.compound ?? "Unknown compound"
                  }
                >
                  {(runner.compound ?? "?").slice(0, 1)}
                  {runner.tyre_age !== null ? ` ${runner.tyre_age}` : ""}
                </span>

                <span
                  className="font-bold tabular-nums text-right flex-none w-[4.6em]"
                  style={{ color: runner.retired ? "#c98a8a" : "#c9c0b4" }}
                >
                  {runner.retired
                    ? "OUT"
                    : runner.pit
                    ? "PIT"
                    : formatGap(runner.gap_seconds, order === 0)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Race control. On a landscape screen it lives beside the tower; on a
            phone held upright it drops below and keeps only the newest few. */}
        <aside className="landscape:w-[34%] lg:w-[330px] xl:w-[380px] flex-none flex flex-col min-h-0 max-h-[26%] landscape:max-h-none">
          <h2 className="font-bold text-[10px] tracking-[0.14em] uppercase text-warm-500 mb-2 flex-none">
            Race control
          </h2>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2 pr-1">
            {feed.length === 0 && (
              <p className="font-semibold text-xs text-warm-600">
                Nothing reported yet this race.
              </p>
            )}
            {feed.map((event, index) => {
              const urgent = URGENT_EVENT_KINDS.has(event.kind);
              const fresh = event.lap === current?.lap;
              return (
                <div
                  key={`${event.lap}-${event.kind}-${index}`}
                  className="rounded-xl px-3 py-2 flex-none"
                  style={{
                    background: urgent ? "rgba(255,68,68,0.10)" : "rgba(255,255,255,0.035)",
                    border: `1px solid ${
                      fresh
                        ? urgent
                          ? "rgba(255,68,68,0.55)"
                          : "rgba(255,138,61,0.5)"
                        : "rgba(255,255,255,0.07)"
                    }`,
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Flag
                      size={12}
                      className="flex-none"
                      style={{ color: urgent ? "#FF6B6B" : "#FFAE6A" }}
                    />
                    <span
                      className="font-extrabold text-[12px] md:text-[13px]"
                      style={{ color: urgent ? "#FF6B6B" : "#FFAE6A" }}
                    >
                      {eventLabel(event.kind)}
                    </span>
                    <span className="ml-auto font-bold text-[10px] tabular-nums text-warm-500">
                      L{event.lap}
                    </span>
                  </div>
                  {event.drivers.length > 0 && (
                    <p className="font-semibold text-[11px] md:text-xs text-warm-200 mt-0.5">
                      {event.drivers.join(", ")}
                    </p>
                  )}
                  <p className="font-medium text-[10px] md:text-[11px] text-warm-500 mt-0.5 leading-snug">
                    {event.message}
                  </p>
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      {/* ----------------------------- controls ----------------------------- */}
      <footer className="flex-none flex flex-wrap items-center gap-2 md:gap-3 px-4 md:px-6 py-2.5 [@media(max-height:520px)]:py-1.5 [@media(max-height:520px)]:gap-1.5 border-t border-white/[0.07]">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play at race pace"}
          className="flex items-center justify-center w-11 h-11 [@media(max-height:520px)]:w-9 [@media(max-height:520px)]:h-9 rounded-xl text-[#1a1210] transition-transform duration-150 ease-out active:scale-[0.97] flex-none"
          style={{ background: "linear-gradient(90deg,#FFAE6A,#FF5A1F)" }}
        >
          {playing ? <Pause size={19} /> : <Play size={19} />}
        </button>

        <button
          type="button"
          onClick={restart}
          aria-label="Back to lap 1"
          className="flex items-center justify-center w-11 h-11 [@media(max-height:520px)]:w-9 [@media(max-height:520px)]:h-9 rounded-xl apex-glass-soft text-warm-300 hover:text-[#FFAE6A] transition-[color,transform] duration-150 active:scale-[0.97] flex-none"
        >
          <RotateCcw size={17} />
        </button>

        {/* Catch-up. Typed rather than scrubbed, because the number the viewer
            has is the one on their TV. */}
        <form
          className="flex items-center gap-2 flex-none"
          onSubmit={(event) => {
            event.preventDefault();
            const target = Number(jumpValue);
            if (!Number.isFinite(target)) return;
            const found = laps.findIndex((lap) => lap.lap === Math.round(target));
            jumpTo(found >= 0 ? found : Math.round(target) - 1);
            setJumpValue("");
          }}
        >
          <label className="font-bold text-[10px] tracking-[0.12em] uppercase text-warm-500 hidden sm:block">
            Jump to lap
          </label>
          <input
            type="number"
            min={1}
            max={replay.total_laps}
            value={jumpValue}
            onChange={(event) => setJumpValue(event.target.value)}
            placeholder={String(current?.lap ?? 1)}
            aria-label="Jump to lap"
            className="w-[74px] h-11 [@media(max-height:520px)]:h-9 rounded-xl apex-glass-soft px-3 font-bold text-sm tabular-nums text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-[#FF7A3D]"
          />
          <button
            type="submit"
            className="h-11 [@media(max-height:520px)]:h-9 px-4 rounded-xl apex-glass-soft font-bold text-xs hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-95"
          >
            Go
          </button>
        </form>

        {/* Copy carries the honest bits rather than a tooltip: what this clock
            is, and what it does when a lap has no recorded time. */}
        <p className="font-medium text-[10px] md:text-[11px] text-warm-500 leading-snug flex-1 min-w-[220px]">
          Every lap runs for as long as it really did — safety-car laps take
          longer than green ones. Catching up jumps straight to the lap; nothing
          fast-forwards.
          {durations.estimatedCount > 0 && (
            <>
              {" "}
              {durations.estimatedCount} of {durations.ms.length} laps have no
              recorded time and run for this race&apos;s median lap (
              {formatLapDuration(durations.medianMs)}).
            </>
          )}
          {durations.medianIsGeneric && (
            <>
              {" "}
              This round has no recorded lap times at all, so every lap runs for
              a nominal {formatLapDuration(durations.medianMs)} — the order is
              real, the pacing is not.
            </>
          )}
        </p>

        <button
          type="button"
          onClick={() => setKeepAwake((value) => !value)}
          aria-pressed={keepAwake}
          title={
            keepAwake
              ? wakeLockHeld
                ? "Screen is being kept awake"
                : "Keeping the screen awake isn't supported here"
              : "Let the screen sleep normally"
          }
          className="flex items-center justify-center w-11 h-11 [@media(max-height:520px)]:w-9 [@media(max-height:520px)]:h-9 rounded-xl apex-glass-soft transition-[color,transform] duration-150 active:scale-[0.97] flex-none"
          style={{ color: keepAwake && wakeLockHeld ? "#FFAE6A" : "#8f867a" }}
        >
          {keepAwake && wakeLockHeld ? <Lightbulb size={17} /> : <LightbulbOff size={17} />}
        </button>

        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          aria-label={fullscreen ? "Leave fullscreen" : "Go fullscreen"}
          className="flex items-center justify-center w-11 h-11 [@media(max-height:520px)]:w-9 [@media(max-height:520px)]:h-9 rounded-xl apex-glass-soft text-warm-300 hover:text-[#FFAE6A] transition-[color,transform] duration-150 active:scale-[0.97] flex-none"
        >
          {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
      </footer>
    </div>
  );
}
