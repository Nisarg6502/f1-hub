/**
 * The real-pace clock behind watch-party mode.
 *
 * `race-replay.tsx` advances a fixed `BASE_MS_PER_LAP = 560` per lap, which
 * makes its "1×" roughly 150× real time. That is the right clock for scrubbing
 * a race in half a minute and the wrong one for sitting a phone next to a TV.
 * This module is the other clock: **lap N takes as long as lap N really took**,
 * read from CP76's `lap_time_seconds`. Safety-car laps therefore run long and
 * green laps run short, which is the entire point — a fixed tick is least
 * accurate exactly where a companion screen is most useful.
 *
 * It is deliberately free of React and of the DOM: the scheduler and the clock
 * source are injectable, so this file's behaviour (variable durations, the null
 * fallback, jump-to-lap, play/pause, cleanup) can be driven deterministically
 * by a harness instead of verified by watching a screen for two hours.
 */

import type { ReplayLap } from "./api";

/**
 * Used only when a race has *no* usable `lap_time_seconds` anywhere — an
 * un-backfilled round, or one whose timing data never arrived. 90s is a
 * middling modern F1 lap; the point is that the clock still runs (and says so
 * in the UI) rather than dividing by nothing or stalling on lap 1.
 */
export const FALLBACK_LAP_SECONDS = 90;

/**
 * **A very long lap is not capped, and that is a decision, not an omission.**
 *
 * CP77 chose not to cap and asked CP78 to revisit it after real use. Revisited
 * against the backfilled 2026 season, where every round's slowest lap sits
 * 30-60s above its median (round 10's runs to 2:44 against a 1:52 median):
 * keep it uncapped.
 *
 * The reasoning is the mode's whole premise. A cap would make a safety-car lap
 * finish sooner than it did, which is the same failure as the old replay's
 * fixed 560ms tick — just less obvious, and worse for being selective. Someone
 * lining this up against a broadcast would silently drift out of sync at
 * exactly the moment the race got interesting, and would have no way to tell
 * why. The honest alternatives already exist: the lap's real duration is shown
 * while it runs, and jump-to-lap is one tap.
 *
 * Revisit only with a concrete report of it feeling broken in use — not on the
 * general principle that waiting is bad. Waiting is the feature.
 */

/** How a lap's duration was arrived at, so the UI can say which it was rather
 * than quietly presenting an estimate as a measurement. */
export type LapDurationSource = "measured" | "estimated";

export interface LapDurations {
  /** Milliseconds to spend on each lap, index-aligned with `replay.laps`. */
  ms: number[];
  /** `"estimated"` where no runner on that lap reported a lap time. */
  source: LapDurationSource[];
  /** The race's median measured lap, in ms — the fallback actually applied. */
  medianMs: number;
  /** True when the race reported no measured lap at all, so `medianMs` is
   * `FALLBACK_LAP_SECONDS` rather than anything derived from this race. */
  medianIsGeneric: boolean;
  /** Count of laps whose duration is estimated. Surfaced in the UI. */
  estimatedCount: number;
}

/** Positive, finite seconds only. A null, a zero and a NaN are all "no
 * measurement" and must not reach the clock as a duration. */
function usableSeconds(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Lower median (element at floor(n/2) of the sorted list) — no interpolation,
 * because the fallback wants a lap that actually happened, not an average of
 * two that did. */
export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Turn a replay into a per-lap duration in milliseconds.
 *
 * The wall clock of a race follows the *leader* — the lap counter ticks when
 * the leader crosses the line — so each lap takes the first usable
 * `lap_time_seconds` in runner order, and `race_replay.py` already sorts
 * runners with the leader first. Reading down the order rather than insisting
 * on P1 matters because nulls are routine: a driver's opening lap has no
 * measured duration, sparse timing data drops rows, and CP76 deliberately
 * reports carried-forward rows (retirements, lapped finishers) as null rather
 * than fabricating a duration. Roughly one row in seven is null in production.
 *
 * A lap where *every* runner is null falls back to the race's own median
 * measured lap. The alternative — waiting on a duration that will never
 * arrive — is a companion screen that freezes, which is strictly worse than one
 * that is approximate for a lap and admits it.
 */
export function lapDurations(laps: ReplayLap[]): LapDurations {
  const measured: Array<number | null> = laps.map((lap) => {
    for (const runner of lap.runners) {
      const seconds = usableSeconds(runner.lap_time_seconds);
      if (seconds !== null) return seconds;
    }
    return null;
  });

  const known = measured.filter((value): value is number => value !== null);
  const median = medianOf(known);
  const medianIsGeneric = median === null;
  const medianMs = (median ?? FALLBACK_LAP_SECONDS) * 1000;

  const source: LapDurationSource[] = measured.map((value) =>
    value === null ? "estimated" : "measured"
  );

  return {
    ms: measured.map((value) => (value === null ? medianMs : value * 1000)),
    source,
    medianMs,
    medianIsGeneric,
    estimatedCount: source.filter((s) => s === "estimated").length,
  };
}

/** Running total of elapsed race time at the *start* of each lap, plus one
 * trailing entry for the end of the race. Used for the race clock readout and
 * for the progress rail, both of which need "how far in are we" rather than
 * "which lap is it". */
export function cumulativeMs(durations: number[]): number[] {
  const out: number[] = [0];
  let total = 0;
  for (const value of durations) {
    total += value;
    out.push(total);
  }
  return out;
}

export interface RealTimeLapClockOptions {
  /** Per-lap durations in ms, from `lapDurations().ms`. */
  durationsMs: number[];
  /** Fired whenever the lap index changes — including from `jumpTo`. */
  onLapChange: (lapIndex: number) => void;
  /** Fired once when the final lap's own duration has elapsed. */
  onEnd?: () => void;
  /**
   * Optional progress callback, fired every frame while playing. Separate from
   * `onLapChange` because a React consumer wants the lap in state (rare, cheap)
   * and the sub-lap progress out of it (60Hz, expensive to re-render on).
   */
  onFrame?: (lapIndex: number, elapsedInLapMs: number) => void;
  startIndex?: number;
  /** Injectable for tests. Defaults to `requestAnimationFrame`. */
  schedule?: (callback: (timestamp: number) => void) => number;
  cancel?: (handle: number) => void;
}

/**
 * Plays a lap index forward at each lap's own duration.
 *
 * An accumulator driven by `requestAnimationFrame`, following the existing
 * replay's approach for the same reason: it is display-synced, and a
 * backgrounded tab that stops delivering frames simply stops advancing rather
 * than queueing up hundreds of missed `setInterval` ticks and lurching when it
 * returns.
 *
 * **Catch-up is `jumpTo`, never a faster rate.** That was decided with the user
 * up front: exactly one clock runs, so it is never ambiguous whether what is on
 * screen is real pace or a fast-forward. There is deliberately no speed
 * control on this class.
 */
export class RealTimeLapClock {
  private readonly durations: number[];
  private readonly onLapChange: (lapIndex: number) => void;
  private readonly onEnd?: () => void;
  private readonly onFrame?: (lapIndex: number, elapsedInLapMs: number) => void;
  private readonly schedule: (callback: (timestamp: number) => void) => number;
  private readonly cancelFrame: (handle: number) => void;

  private index: number;
  private elapsed = 0;
  private running = false;
  private handle: number | null = null;
  private last = 0;
  private disposed = false;

  constructor(options: RealTimeLapClockOptions) {
    this.durations = options.durationsMs;
    this.onLapChange = options.onLapChange;
    this.onEnd = options.onEnd;
    this.onFrame = options.onFrame;
    this.schedule =
      options.schedule ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancel ?? ((handle) => cancelAnimationFrame(handle));
    this.index = this.clamp(options.startIndex ?? 0);
  }

  get lapIndex(): number {
    return this.index;
  }

  get elapsedInLapMs(): number {
    return this.elapsed;
  }

  get playing(): boolean {
    return this.running;
  }

  /** The duration governing the lap currently on screen, in ms. */
  get currentLapMs(): number {
    return this.durations[this.index] ?? 0;
  }

  private clamp(index: number): number {
    if (!Number.isFinite(index)) return 0;
    return Math.min(Math.max(0, Math.round(index)), Math.max(0, this.durations.length - 1));
  }

  play(): void {
    if (this.disposed || this.running || this.durations.length === 0) return;
    // Replaying from a finished race restarts rather than sitting on a clock
    // with nowhere to go.
    if (this.atEnd()) this.jumpTo(0);
    this.running = true;
    this.last = 0;
    this.handle = this.schedule(this.frame);
  }

  pause(): void {
    if (!this.running) return;
    this.running = false;
    if (this.handle !== null) {
      this.cancelFrame(this.handle);
      this.handle = null;
    }
  }

  toggle(): void {
    if (this.running) this.pause();
    else this.play();
  }

  /**
   * The catch-up control: snap to a lap and resume the real clock from its
   * start. Sub-lap progress is discarded rather than scaled, because there is
   * no meaning to "40% into lap 30" when the user's intent was "show me lap 30".
   */
  jumpTo(index: number): void {
    if (this.disposed) return;
    const next = this.clamp(index);
    this.elapsed = 0;
    // `last` is zeroed so the first frame after a jump measures from itself
    // rather than charging the jump's wall-clock cost to the new lap.
    this.last = 0;
    if (next !== this.index) {
      this.index = next;
      this.onLapChange(next);
    }
    this.onFrame?.(this.index, 0);
  }

  /** True once the final lap's own duration has run out. */
  private atEnd(): boolean {
    const lastIndex = this.durations.length - 1;
    return this.index >= lastIndex && this.elapsed >= (this.durations[lastIndex] ?? 0);
  }

  private frame = (timestamp: number): void => {
    if (!this.running) return;

    // The first frame of a run establishes the baseline; charging it a delta
    // measured from an earlier play/pause cycle would jump the clock forward by
    // however long the user spent paused.
    if (this.last === 0) {
      this.last = timestamp;
      this.handle = this.schedule(this.frame);
      return;
    }

    this.elapsed += Math.max(0, timestamp - this.last);
    this.last = timestamp;

    const lastIndex = this.durations.length - 1;
    let index = this.index;

    // A loop, not a single step: a stalled or throttled frame can legitimately
    // cover more than one lap, and stepping once per frame would silently run
    // the race slower than real time after any hitch.
    while (index < lastIndex) {
      const duration = this.durations[index];
      // Defensive: a non-positive duration can't be consumed and would spin
      // this loop forever. `lapDurations` never produces one, but this class
      // takes an arbitrary array.
      if (!(duration > 0)) {
        index += 1;
        continue;
      }
      if (this.elapsed < duration) break;
      this.elapsed -= duration;
      index += 1;
    }

    if (index !== this.index) {
      this.index = index;
      this.onLapChange(index);
    }

    if (this.atEnd()) {
      this.elapsed = this.durations[lastIndex] ?? 0;
      this.onFrame?.(this.index, this.elapsed);
      this.pause();
      this.onEnd?.();
      return;
    }

    this.onFrame?.(this.index, this.elapsed);
    this.handle = this.schedule(this.frame);
  };

  /** Stops the loop permanently. Called from React cleanup — a leaked rAF loop
   * holding a closure over unmounted state is the classic way this kind of
   * component keeps a tab busy after the user has navigated away. */
  dispose(): void {
    this.pause();
    this.disposed = true;
  }
}

/** `5432100` -> `1:30:32`. The race clock readout, which routinely passes an
 * hour, so hours are shown only once there are any. */
export function formatRaceClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(hours > 0 ? 2 : 1, "0");
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${String(seconds).padStart(2, "0")}`;
}

/** `91.929` -> `1:31.9`. A lap duration, the number that makes the safety car
 * visible without needing a caption. */
export function formatLapDuration(ms: number): string {
  // Round to tenths FIRST, then split off minutes. Doing it the other way
  // rounds after the split, so 59.95s-59.99s formats as "0:60.0" — a string
  // that is not a time. This is not an edge case: the live readout is
  // repainted every frame, so at 60Hz roughly three frames land in that 50ms
  // band and "0:60.0" visibly flashes on *every* lap as it crosses a minute,
  // and again at "1:60.0" on any lap over two. A lap whose real duration falls
  // in the band is labelled that way permanently, and the backfilled season
  // has rounds with maximum laps at 149-150s, squarely inside it.
  const tenths = Math.round(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths - minutes * 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}
