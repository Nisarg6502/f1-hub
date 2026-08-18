/**
 * The per-second timing layer behind watch-party mode's tower.
 *
 * `watch-clock.ts` answers "what time is it in this race?". This module answers
 * the other half — **"what does the tower show at elapsed race time `t_ms`?"** —
 * against the real sampled OpenF1 readings in `RaceTiming` rather than the
 * lap-indexed `RaceReplay`. The distinction is the entire feature: a replay lap
 * row changes once every ~90 seconds, so a gap closing from 1.4s to 0.4s across
 * half a lap is invisible in it. The samples here land at a ~3.6s median
 * cadence, and this file fills the space between them.
 *
 * Like `watch-clock.ts` it is deliberately free of React and of the DOM. It is
 * called ~20 times per frame at 60Hz from a component that is otherwise
 * impossible to assert on without watching a screen for two hours, so every
 * rule below (the interpolation guard especially) is driven by a harness
 * instead.
 *
 * ## What is and is not smoothed
 *
 * The design (CP79) rejected inventing intra-lap numbers by interpolating
 * between lap boundaries — every such number would be fabricated, in a mode
 * whose stated premise is refusing to fabricate pacing. What survives is much
 * narrower: interpolation *between two real adjacent measurements taken ~3.6s
 * apart*, which is a reading-of-a-continuous-quantity, not an invention.
 *
 * So:
 *
 * - `position` is **carried forward, never interpolated**. There is no such
 *   thing as being 40% of the way from P5 to P6; the feed says a car was
 *   definitively in one of them, and a fractional position would put a row
 *   visually between two slots at a moment no such state existed.
 * - numeric `interval` / `gap_to_leader` are **linearly interpolated**, because
 *   that is what makes the readout count down (1.4 → 0.9 → 0.4) at 60fps
 *   between samples. Without it the number would step three times a lap and the
 *   feature would not exist.
 */

import type {
  PositionSample,
  RaceTiming,
  TimingSample,
  TimingValue,
} from "./api";

/* -------------------------------- the index -------------------------------- */

/**
 * Columnar per-driver samples.
 *
 * The wire format is an array of tuples; this splits it into parallel arrays so
 * the hot path — a search over timestamps — walks one dense `number[]` instead
 * of dereferencing 22,000 tuple objects. The values stay in their own arrays
 * so a lookup touches only what it needs.
 *
 * `cursor` is mutable state deliberately parked on the index: see `seek`.
 */
interface DriverIndex {
  timingT: number[];
  interval: TimingValue[];
  gap: TimingValue[];
  positionT: number[];
  position: number[];
  /** Search hint for `timingT`, advanced by the last lookup. */
  timingCursor: number;
  /** Search hint for `positionT`. */
  positionCursor: number;
  /**
   * Elapsed time after which this car is no longer in the race, or
   * `Infinity` for one that took the flag.
   *
   * A retired car's samples simply stop, and carrying the last one forward —
   * which is right between line crossings — otherwise holds it in the running
   * order for the rest of the race. With the order rendered as a rank, a ghost
   * sitting in P4 pushes every car behind it down one for an hour.
   */
  outAt: number;
}

/** A precomputed snapshot of the whole field's order at one instant. */
interface OrderSnapshot {
  t: number;
  /** Car numbers, best position first. A stable reference — handed straight to
   * React, where a fresh array every frame would defeat every memo downstream. */
  order: string[];
}

export interface TimingIndex {
  /** Empty when the round has no per-second track, so the caller can fall back
   * to lap data without a separate "is this usable" flag. */
  drivers: Map<string, DriverIndex>;
  /**
   * The field's order at every instant it changed, ascending by `t`.
   *
   * Precomputed rather than derived per frame. Sorting ~20 drivers by their
   * carried-forward position 60 times a second is not expensive in isolation,
   * but it allocates a new array every frame and it repeats work that changes
   * only ~531 times in a whole race. Building the snapshots once costs ~531×20
   * comparisons at load and turns the per-frame cost into one binary search
   * returning a reference that is stable until the order genuinely changes.
   *
   * Empty when no driver reported positions.
   */
  orders: OrderSnapshot[];
  /** Search hint for `orders`. */
  orderCursor: number;
  /** True when there is anything at all to sample. */
  usable: boolean;
}

/** The empty index. Returned for a `null`/unsynced payload so callers never
 * branch on nullability — `sampleAt` and `orderAt` handle it. */
function emptyIndex(): TimingIndex {
  return { drivers: new Map(), orders: [], orderCursor: 0, usable: false };
}

/**
 * Prepare a `RaceTiming` payload for per-frame lookup. Called **once per race**,
 * not per frame or per render.
 *
 * Tolerates a `null` payload, `synced: false`, an absent `drivers` map and a
 * driver with empty arrays, because all of those are routine rather than
 * exceptional: pre-2023 rounds have no per-second track at all, and this runs
 * inside a full-screen view with no error surface to throw into.
 *
 * Samples are **re-sorted defensively** even though the contract states they
 * arrive ascending. The cost is once-per-race and the alternative failure is
 * ugly: an out-of-order sample makes every binary search below return garbage
 * silently, for the rest of the race, with no exception to trace it by.
 */
export function buildTimingIndex(timing: RaceTiming | null | undefined): TimingIndex {
  if (!timing || !timing.synced || !timing.drivers) return emptyIndex();

  const drivers = new Map<string, DriverIndex>();

  for (const [number, driver] of Object.entries(timing.drivers)) {
    const timingRows: TimingSample[] = Array.isArray(driver?.timing) ? driver.timing : [];
    const positionRows: PositionSample[] = Array.isArray(driver?.positions)
      ? driver.positions
      : [];
    if (timingRows.length === 0 && positionRows.length === 0) continue;

    const sortedTiming = [...timingRows].sort((a, b) => a[0] - b[0]);
    const sortedPositions = [...positionRows].sort((a, b) => a[0] - b[0]);

    drivers.set(number, {
      timingT: sortedTiming.map((row) => row[0]),
      interval: sortedTiming.map((row) => row[1]),
      gap: sortedTiming.map((row) => row[2]),
      positionT: sortedPositions.map((row) => row[0]),
      position: sortedPositions.map((row) => row[1]),
      timingCursor: 0,
      positionCursor: 0,
      outAt:
        typeof driver?.out_ms === "number" && Number.isFinite(driver.out_ms)
          ? driver.out_ms
          : Infinity,
    });
  }

  if (drivers.size === 0) return emptyIndex();

  const index: TimingIndex = {
    drivers,
    orders: buildOrderSnapshots(drivers),
    orderCursor: 0,
    usable: true,
  };
  return index;
}

/**
 * Every distinct instant at which *any* driver's position changed, resolved
 * into a full-field ordering.
 *
 * Built by carrying each driver's most recent position forward across the
 * merged set of change instants — the same carry-forward rule `sampleAt` uses,
 * so the precomputed order can never disagree with the per-driver position the
 * row next to it renders.
 *
 * A driver with no position samples at all is omitted from the order rather
 * than sorted to the back. Parking them at P20+ would silently invent a
 * classification for a car the feed says nothing about, and the caller can
 * still render them from lap data.
 */
function buildOrderSnapshots(drivers: Map<string, DriverIndex>): OrderSnapshot[] {
  const instants = new Set<number>();
  for (const driver of drivers.values()) {
    for (const t of driver.positionT) instants.add(t);
  }
  if (instants.size === 0) return [];

  const sorted = [...instants].sort((a, b) => a - b);
  const snapshots: OrderSnapshot[] = [];
  let previous: string[] | null = null;

  for (const t of sorted) {
    const entries: Array<{ number: string; position: number }> = [];
    for (const [number, driver] of drivers) {
      if (driver.positionT.length === 0) continue;
      // Out of the race: stop carrying them forward, or they hold a slot in the
      // order — and therefore a rank — until the flag.
      if (t > driver.outAt) continue;
      const i = lastAtOrBefore(driver.positionT, t);
      // Before this driver's own first sample, use their first known position:
      // the alternative is a hole in the order on lap 1 for anyone whose first
      // position event lands late.
      entries.push({ number, position: driver.position[i < 0 ? 0 : i] });
    }
    entries.sort((a, b) => a.position - b.position || Number(a.number) - Number(b.number));
    const order = entries.map((entry) => entry.number);

    // Collapse instants where several drivers' events resolve to the same
    // ordering (a swap reported twice, a position confirmed unchanged). Keeping
    // them would hand React a new array reference for an order that did not
    // change, which is exactly the identity churn the snapshots exist to avoid.
    if (previous && sameOrder(previous, order)) continue;
    snapshots.push({ t, order });
    previous = order;
  }

  return snapshots;
}

function sameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* -------------------------------- searching -------------------------------- */

/**
 * Index of the last entry at or before `t`, or `-1` if `t` precedes them all.
 * Plain binary search, used where there is no useful cursor (index build).
 */
function lastAtOrBefore(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The hot-path search: `lastAtOrBefore`, but starting from where the previous
 * lookup finished.
 *
 * **Cursor first, binary search as the fallback — not one or the other.** A
 * pure cursor is the obvious choice for playback, where `tMs` advances
 * monotonically and consecutive frames land in the same bracket or the next
 * one, making the common case O(1) across ~22,000 samples. But `jumpTo` exists
 * (it is watch mode's only catch-up control), and a race can also be restarted
 * from the end, so `tMs` genuinely moves backwards and by hours. A cursor that
 * assumed monotonicity would scan linearly backwards over the whole race on
 * every jump, inside a frame. A pure binary search would instead pay ~15
 * comparisons × 20 drivers × 2 arrays every frame forever, for a bracket it
 * almost always already knew.
 *
 * So: try to confirm the cached bracket in two comparisons, take one step
 * forward if the clock ticked past it, and only then fall back to the full
 * search. This keeps the cursor's O(1) playback path *and* a jump's O(log n)
 * one, with no correctness dependence on the direction of time.
 */
function seek(times: number[], t: number, cursor: number): number {
  const n = times.length;
  if (n === 0) return -1;
  if (t < times[0]) return -1;

  const c = cursor >= 0 && cursor < n ? cursor : 0;
  // Cached bracket still holds.
  if (times[c] <= t && (c + 1 >= n || times[c + 1] > t)) return c;
  // Advanced by exactly one sample, the single most common transition.
  if (c + 1 < n && times[c + 1] <= t && (c + 2 >= n || times[c + 2] > t)) return c + 1;

  return lastAtOrBefore(times, t);
}

/* -------------------------------- sampling -------------------------------- */

export interface TimingSnapshot {
  interval: TimingValue;
  gapToLeader: TimingValue;
  /** `null` when this driver has no position samples — the caller falls back to
   * the lap-indexed position rather than showing a guess. */
  position: number | null;
}

/** What an unknown driver reads as. A module-level constant so the miss path
 * returns a stable reference too. */
const ABSENT: TimingSnapshot = { interval: null, gapToLeader: null, position: null };

/**
 * Interpolate one value between two bracketing samples — or refuse to.
 *
 * **This is the single most important correctness rule in this file.**
 * `interval` and `gap_to_leader` are `number | string | null`, and a string is a
 * lapped car (`"+1 LAP"`). Arithmetic on it is not merely wrong, it is
 * *silently* wrong: `Number("+1 LAP")` is `NaN`, `NaN` propagates through the
 * lerp untouched, and the tower renders `+NaN` — on roughly a fifth of the
 * `gap_to_leader` column, since only 79.2% of real readings are numeric.
 *
 * There is also no meaning to interpolate *toward*. A car 0.8s behind on one
 * sample and `"+1 LAP"` on the next did not travel through 0.8 → 30 → 60
 * seconds; it got lapped at one instant. And `null` is "not reported", not
 * zero, so a bracket containing one has nothing to blend with.
 *
 * In every non-numeric case the answer is **carry the most recent value
 * forward** — the reading stands until a new one replaces it, which is exactly
 * how a broadcast tower behaves.
 *
 * **Since `TIMING_VERSION` 7 the backend is a second producer of those
 * strings**, not just a passthrough for OpenF1's: it stamps the exact gap at
 * every line crossing from the official lap archive, and serves `"+N LAP(S)"`
 * there for a car the archive says is laps down — deliberately, so this
 * function never sees one source claim `"+11 LAPS"` and the other `1030.86`
 * across the same bracket. Nothing here changed for it, which was the point.
 * Measured across the eleven synced 2026 rounds: numeric brackets swinging
 * more than 5s went from 1,787 of 492,420 (0.36%) to 1,926 of 514,977 (0.37%),
 * so the added samples introduce no new sweeping.
 */
function blend(from: TimingValue, to: TimingValue, ratio: number): TimingValue {
  if (typeof from !== "number" || typeof to !== "number") return from;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return from;
  return from + (to - from) * ratio;
}

/**
 * The state of one driver at elapsed race time `tMs`.
 *
 * Never returns `undefined`, and never throws, for any input — it runs every
 * frame inside a full-screen view. Outside the sample range it clamps to the
 * nearest end rather than reporting nothing: before the first sample the race
 * has a real grid order and a real gap, and after the last one the field has
 * finished in an order that should stay on screen.
 */
export function sampleAt(
  index: TimingIndex,
  driverNumber: string,
  tMs: number
): TimingSnapshot {
  const driver = index.drivers.get(driverNumber);
  if (!driver) return ABSENT;

  const t = Number.isFinite(tMs) ? tMs : 0;

  let interval: TimingValue = null;
  let gapToLeader: TimingValue = null;

  const times = driver.timingT;
  if (times.length > 0) {
    const i = seek(times, t, driver.timingCursor);
    if (i < 0) {
      // **Before the first measurement, report nothing — do not clamp.**
      //
      // The first reading is not a statement about this instant, and treating
      // it as one is the same mistake that put the wrong starting order on
      // screen: the tower showed every car an interval like `+0.3` while the
      // field was still stationary on the grid, and since those are all under a
      // second, the closing-attack ring lit up almost the whole tower at
      // lights out.
      //
      // A gap only exists once cars are running, so `null` (rendered `—`) is
      // the honest answer and `isClosing` correctly declines to highlight it.
      // Positions are unaffected: they are seeded from the starting grid at
      // t=0, so there is always a real sample to carry forward from.
      interval = null;
      gapToLeader = null;
    } else {
      driver.timingCursor = i;
      const last = times.length - 1;
      if (i >= last) {
        interval = driver.interval[last];
        gapToLeader = driver.gap[last];
      } else {
        const span = times[i + 1] - times[i];
        // A zero or negative span would divide by nothing; two samples at the
        // same instant carry forward rather than blowing up.
        const ratio = span > 0 ? Math.min(1, Math.max(0, (t - times[i]) / span)) : 0;
        interval = blend(driver.interval[i], driver.interval[i + 1], ratio);
        gapToLeader = blend(driver.gap[i], driver.gap[i + 1], ratio);
      }
    }
  }

  let position: number | null = null;
  const pTimes = driver.positionT;
  if (pTimes.length > 0) {
    const i = seek(pTimes, t, driver.positionCursor);
    if (i < 0) {
      position = driver.position[0];
    } else {
      driver.positionCursor = i;
      // Carried forward, never interpolated — there is no fractional position.
      position = driver.position[i];
    }
  }

  return { interval, gapToLeader, position };
}

/**
 * The whole field in position order at `tMs`, or `null` when positions are
 * unavailable.
 *
 * `null` rather than an empty array, and rather than a best-effort partial
 * order, because the two are different instructions to the caller: an empty
 * array says "the field is empty at this instant", `null` says "this layer
 * cannot answer — use the lap-boundary order you already have". Watch mode
 * degrades to a lap-stepped tower on rounds with timing but no position feed,
 * and this is the flag it degrades on.
 *
 * The returned array is a stable reference for as long as the order holds, so
 * a consumer may compare it by identity to decide whether rows need to move.
 */
export function orderAt(index: TimingIndex, tMs: number): string[] | null {
  const snapshots = index.orders;
  if (snapshots.length === 0) return null;

  const t = Number.isFinite(tMs) ? tMs : 0;

  const n = snapshots.length;
  const c = index.orderCursor >= 0 && index.orderCursor < n ? index.orderCursor : 0;
  if (snapshots[c].t <= t && (c + 1 >= n || snapshots[c + 1].t > t)) {
    return snapshots[c].order;
  }
  if (c + 1 < n && snapshots[c + 1].t <= t && (c + 2 >= n || snapshots[c + 2].t > t)) {
    index.orderCursor = c + 1;
    return snapshots[c + 1].order;
  }

  let lo = 0;
  let hi = n - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (snapshots[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Before the first recorded change the field was in *some* order, and the
  // first snapshot is the only evidence of what it was — clamping there beats
  // returning null, which the caller would read as "no position data at all".
  const at = found < 0 ? 0 : found;
  index.orderCursor = at;
  return snapshots[at].order;
}

/* ------------------------------- formatting ------------------------------- */

/**
 * The one place the `number | string | null` union is allowed to become text.
 *
 * Centralised on purpose: the union has four branches, three of them are easy
 * to forget, and the cost of forgetting one is `+NaN` or `+undefined` on a
 * screen someone is watching across a room. Anything that renders a
 * `TimingValue` calls this rather than reimplementing `.toFixed(1)`.
 *
 * The numeric and null branches mirror `formatGap` in `watch-view.tsx` exactly
 * (`+1.4`, `—`, `LEADER`) so a per-second row and a lap-stepped row are
 * visually indistinguishable — the tower must not visibly change character when
 * a round happens to lack per-second data.
 *
 * A string is emitted **verbatim**. It already carries its own `+` and its own
 * units (`"+1 LAP"`); reformatting it would either double the sign or lose the
 * plural.
 */
export function formatTimingValue(value: TimingValue, isLeader: boolean): string {
  if (isLeader) return "LEADER";
  if (typeof value === "string") return value;
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `+${value.toFixed(1)}`;
}

/** Under a second and closing — the threshold the design picked for
 * highlighting a car about to attack.
 *
 * Numeric only, and that is not a formality: a lapped car's `"+1 LAP"` is by
 * definition the *opposite* of an imminent attack, yet `"+1 LAP" < 1.0` is
 * `false` only by luck of JavaScript's string-to-number coercion rules, and
 * `null < 1.0` is `true` — a null interval would light up the whole tower. The
 * `typeof` guard is what makes this safe.
 *
 * **The comparison is made on the value as *displayed*, not as measured.**
 * `formatTimingValue` rounds to one decimal, so a raw 0.96 renders as `+1.0`;
 * testing the raw number would ring that row while it reads "+1.0", which is a
 * self-contradiction on screen — caught in a real browser, where exactly one
 * row of twenty was doing it. Rounding first means the ring and the number can
 * never disagree: every ringed row reads +0.9 or less. The cost is that a car
 * at 0.96 is not highlighted, which is the right side to err on — the threshold
 * was always an arbitrary round number, whereas a highlight that contradicts
 * the figure beside it is a bug the viewer can actually see. */
export function isClosing(interval: TimingValue): boolean {
  if (typeof interval !== "number" || !Number.isFinite(interval)) return false;
  return Math.round(interval * 10) / 10 < 1.0;
}
