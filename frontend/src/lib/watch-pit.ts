/**
 * When a car is actually stationary, expressed on the tower's own clock.
 *
 * ## The defect this exists for
 *
 * `race_replay` records a stop on the driver's **own** lap N. The watch tower
 * indexes the **leader's** laps. Those are the same number only for the leader,
 * so `runner.pit` — read out of `laps[leaderLapIndex]` — is a flag that appears
 * and disappears on a clock that has nothing to do with the car it describes.
 *
 * Measured on the 2026 Australian GP (round 1), car 14, lap 13, from the
 * deployed payloads (`race_replay` v4, `race_timing` v7):
 *
 * | quantity | value |
 * |---|---|
 * | `pit.duration_seconds` | 972.356 s |
 * | his OpenF1 timing samples stop | t = 1,222,739 ms → 2,199,970 ms (977.2 s with nothing in it) |
 * | leader's lap 13 | t = 1,053,932 ms → 1,169,110 ms |
 *
 * The leader's lap 13 **ends 53.6 seconds before his samples even stop**, so
 * today's `PIT` state overlaps the real stop by exactly **zero milliseconds**.
 * The tower carries his last reading, `+63.9`, across the whole 977 seconds and
 * only snaps to the truth at his next crossing. That is `HANDOFF.md` CP84's
 * "what CP84 did NOT fix", and it is an alignment defect, not missing data: the
 * duration was in the payload the whole time.
 *
 * ## What a window is anchored to, and the error that leaves
 *
 * `start` is **the driver's own lap start**: the leader's lap-N start plus that
 * driver's gap to the leader at the end of lap N-1. `end` is
 * `start + max(stop duration, that lap's leader duration)`.
 *
 * Three things about that are deliberate.
 *
 * *Why the driver's lap start and not the leader's.* A lapped or delayed car can
 * be a whole lap-time behind where the leader's boundary puts it. Measured by
 * running this module against the deployed payloads for all eleven synced 2026
 * rounds — 28 stops of ≥60 s, whose drivers' timing-sample holes total
 * 36,867.2 s of stationary time — the share of that time the `PIT` state covers:
 *
 * | anchor | covered |
 * |---|---|
 * | today (leader's lap N) | 33,677.1 s — 91.3 % |
 * | leader's lap-N start + duration | 35,844.9 s — 97.2 % |
 * | **driver's lap-N start + duration** | **36,453.2 s — 98.9 %** |
 *
 * **The aggregate understates the defect and the per-stop spread is the real
 * result.** Today, 7 of those 28 stops are under 50 % covered and **three are at
 * exactly zero**: round 1 car 14 (977 s), round 1 car 18 (1,087 s), round 7 car
 * 23 (775 s) — 2,839 seconds during which the tower states a gap for a car that
 * is not moving. Those three are the genuinely long garage stops, i.e. precisely
 * the case, and they read 0 % because the leader's lap has *finished* before the
 * car's samples even stop. After: nothing is below 50 %, the worst is 69 %, and
 * the three zeroes become 90 %, 92 % and 89 %.
 *
 * The price is over-claim: total `PIT` seconds across those stops rises from
 * 37,448.0 s to 39,034.9 s (+4.2 %).
 *
 * *Why `max(duration, lap)` and not the duration alone.* A stop shorter than a
 * lap — 407 of the 435 stops in those rounds, median 19.07 s — would otherwise
 * shrink the state from the whole lap it covers today to twenty seconds
 * somewhere inside it. There is nothing in the payload saying **where** inside
 * the lap the car entered the pits, so a twenty-second window would be placed by
 * guesswork and would usually miss. Taking the longer of the two keeps a sub-lap
 * stop at the length it already has — the window moves, it does not resize — and
 * changes only the case the defect is about. Extending is the safe direction:
 * `PIT` is a refusal to state a gap, so over-covering withholds a number and
 * under-covering invents one.
 *
 * *The residual, stated rather than implied.* Because the entry instant is
 * unknown, the window's head over-claims: on the round-1 stop it reads `PIT` for
 * the 92.3 s of in-lap the car spent driving to the pit entry. That is bounded
 * by roughly one lap, it is the same over-claim today's whole-lap flag already
 * makes on every stop, and it errs toward withholding.
 *
 * ## The gap reading is only trusted *before* the stop
 *
 * `gap_seconds` is a difference of cumulative times summed from FastF1 lap
 * times, and `race_laps._attach_gap_seconds` carries a driver's total forward
 * unchanged across a null `LapTime` rather than inventing one. A long stop is
 * exactly where nulls appear, so the readings after it are understated and can
 * even go negative — car 14's own rows read `+76.507` at the end of lap 12 and
 * `-38.671` at the end of lap 13. So only the lap *before* the stop is read, and
 * only when it is finite and positive; anything else falls back to the leader's
 * boundary, which is where today's flag already sits and therefore cannot be a
 * regression.
 *
 * Deliberately free of React and of the DOM, like `watch-clock.ts` and
 * `watch-timing.ts` beside it, so it can be driven against a real payload
 * instead of watched on a screen.
 */

import type { ReplayLap } from "./api";

/** One stop, placed on the race-elapsed clock. */
export interface PitWindow {
  /** Race-elapsed ms at which the state begins. */
  startMs: number;
  /** Race-elapsed ms at which it ends. Always `> startMs`. */
  endMs: number;
  /** From `pit.stop_number`; `null` when the payload did not carry one. */
  stopNumber: number | null;
  /** The stop's own recorded length in ms, `null` when unrecorded. Kept
   * separate from `endMs - startMs` because those differ whenever the lap was
   * the longer of the two, and a caller must never present the lap's length as
   * a measurement of the stop. */
  durationMs: number | null;
}

/** Car number -> that car's stops, ascending and non-overlapping. */
export type PitWindows = Map<string, PitWindow[]>;

function finitePositive(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

/**
 * Every stop in the replay, placed on the clock `cumulative` describes.
 *
 * `cumulative` is `cumulativeMs(durations.ms)` from `watch-clock.ts` — the
 * *same* array the tower's frame loop adds its sub-lap elapsed time to. Passing
 * it in rather than recomputing it is the point: watch mode has had two separate
 * defects caused by one part of the view running on a timeline another part was
 * not (`HANDOFF.md` CP80 and CP81), and a pit window computed against a
 * second-hand timeline would be a third.
 *
 * Tolerates a short or absent `cumulative` (a lap with no entry is skipped
 * rather than placed at zero) and a `pit` object with nothing usable in it.
 * Both are routine on an old cached payload, and this runs inside a full-screen
 * view with no error surface to throw into.
 */
export function buildPitWindows(
  laps: ReplayLap[],
  cumulative: number[]
): PitWindows {
  const byDriver = new Map<string, PitWindow[]>();

  for (let index = 0; index < laps.length; index += 1) {
    const lapStart = cumulative[index];
    const lapEnd = cumulative[index + 1];
    if (!Number.isFinite(lapStart)) continue;
    const lapSpan = Number.isFinite(lapEnd) ? Math.max(0, lapEnd - lapStart) : 0;

    // The gap standing at the end of the previous lap — i.e. as this lap began.
    // Built per lap rather than as a whole-race map because only the pit laps
    // ever need it, and a race has ~40 stops against ~1,200 lap rows.
    const previous = laps[index - 1];

    for (const runner of laps[index].runners) {
      const stop = runner.pit;
      if (!stop) continue;

      let start = lapStart;
      if (previous) {
        const before = previous.runners.find(
          (candidate) => candidate.number === runner.number
        );
        const gap = finitePositive(before?.gap_seconds);
        if (gap !== null) start = lapStart + gap * 1000;
      }

      // Seconds on the wire, milliseconds on this clock. Converted here rather
      // than at the comparison below because the first version of this file did
      // the `Math.max` in mixed units — 972.356 lost to a 115,178 ms lap and the
      // longest stop of the season came out one lap long, which is the exact
      // defect this module exists to fix, silently reintroduced.
      const durationMs = (finitePositive(stop.duration_seconds) ?? 0) * 1000 || null;
      const span = Math.max(durationMs ?? 0, lapSpan);
      // A payload with neither a duration nor a usable lap span would otherwise
      // produce a zero-width window, which is a state no clock can ever be
      // inside — indistinguishable from having dropped the stop. One second is
      // the smallest thing that is still a window.
      const end = start + (span > 0 ? span : 1000);

      const list = byDriver.get(runner.number);
      const window: PitWindow = {
        startMs: start,
        endMs: end,
        stopNumber: stop.stop_number ?? null,
        durationMs,
      };
      if (list) list.push(window);
      else byDriver.set(runner.number, [window]);
    }
  }

  for (const [number, windows] of byDriver) {
    byDriver.set(number, mergeOverlapping(windows));
  }
  return byDriver;
}

/**
 * Sort and coalesce, so a driver's windows can be scanned in order and a clock
 * is never inside two of them.
 *
 * Overlap is a real case, not defensive tidying: a stop long enough to run into
 * the following lap can meet the stop recorded on that lap (a red-flagged race
 * records a stop on consecutive laps for the same car), and two `PIT` states
 * with a one-frame gap between them would flicker the row.
 */
function mergeOverlapping(windows: PitWindow[]): PitWindow[] {
  const sorted = [...windows].sort((a, b) => a.startMs - b.startMs);
  const merged: PitWindow[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.startMs <= last.endMs) {
      // The earlier stop keeps its identity — it is the one whose start the
      // merged window is anchored to — and only the end is extended. Summing
      // the durations would state a stop length that never happened.
      last.endMs = Math.max(last.endMs, window.endMs);
      continue;
    }
    merged.push({ ...window });
  }
  return merged;
}

/**
 * The stop this driver is in at `tMs`, or `null`.
 *
 * A linear scan, deliberately. A driver has at most a handful of stops, so this
 * is a handful of comparisons per driver per frame against a binary search's
 * setup cost — and unlike `watch-timing.ts`'s sampling there is no cursor to
 * invalidate when `jumpTo` moves the clock backwards.
 */
export function pitWindowAt(
  windows: PitWindows,
  driverNumber: string,
  tMs: number
): PitWindow | null {
  const list = windows.get(driverNumber);
  if (!list) return null;
  for (const window of list) {
    if (tMs < window.startMs) return null; // ascending: nothing later can match
    if (tMs < window.endMs) return window;
  }
  return null;
}

/**
 * Every car stationary at `tMs`, as a set of car numbers.
 *
 * Returned as a set rather than looked up per row because the caller holds this
 * in React state: the membership changes ~64 times in a whole race (twice per
 * stop), which makes it one of the two genuinely discrete things in this view —
 * the same class as the running order, and emphatically not something to write
 * to the DOM at 60Hz.
 */
export function pitSetAt(windows: PitWindows, tMs: number): Set<string> {
  const out = new Set<string>();
  for (const [number, list] of windows) {
    for (const window of list) {
      if (tMs < window.startMs) break;
      if (tMs < window.endMs) {
        out.add(number);
        break;
      }
    }
  }
  return out;
}

/** Whether two pit sets describe the same field state. The frame loop compares
 * before writing React state — without this the loop would hand React a fresh
 * `Set` 60 times a second and re-render the whole tower for a value that had
 * not changed. */
export function samePitSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
