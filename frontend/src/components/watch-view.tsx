"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import PairQr from "./pair-qr";
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
  Pin,
  Rows3,
  Rows2,
  Smartphone,
  RefreshCw,
  Check,
  Radio,
  RadioOff,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import type { RaceRadio, RaceReplay, RaceTiming, ReplayLap, ReplayRunner } from "@/lib/api";
import RadioPopup from "./radio-popup";
import { getTeamColor } from "@/lib/team-colors";
import {
  RealTimeLapClock,
  cumulativeMs,
  formatLapDuration,
  formatRaceClock,
  lapDurations,
} from "@/lib/watch-clock";
import {
  buildTimingIndex,
  formatTimingValue,
  isClosing,
  orderAt,
  sampleAt,
} from "@/lib/watch-timing";
import { buildPitWindows, pitSetAt, samePitSet } from "@/lib/watch-pit";
import { toRaceId } from "@/lib/watch-races";
import {
  groupCode,
  useWatchParty,
  type WatchPairEvent,
  type WatchPosition,
} from "@/lib/watch-session";
import {
  advanceRadio,
  createRadioState,
  schedulableClips,
  type RadioCue,
} from "@/lib/watch-radio";
import {
  densityServerSnapshot,
  densitySnapshot,
  orderRunners,
  pinnedServerSnapshot,
  pinnedSnapshot,
  radioCaptionsServerSnapshot,
  radioCaptionsSnapshot,
  setDensityPreference,
  setPinnedPreference,
  setRadioCaptionsPreference,
  setTimingModePreference,
  subscribePreferences,
  timingModeServerSnapshot,
  timingModeSnapshot,
  towerLayout,
} from "@/lib/watch-preferences";
import { track } from "@/lib/analytics";

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
 * Positive is places gained.
 *
 * This is the fallback used only when a round has no per-second position track.
 * Where one exists, `recentDeltas` below answers the same question over a time
 * window instead — see its comment for why a per-lap comparison stops meaning
 * anything once the tower reorders continuously. */
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
 * How long a "▲2" marker stands after the move that earned it, in ms.
 *
 * The lap-indexed tower could compare against the previous lap because a lap
 * was the only thing that ever changed. Once positions move the instant the
 * feed reports them, "since the previous lap" is no longer a meaningful window:
 * a car that gained a place early in a long safety-car lap would wear its
 * marker for two minutes, and one that gained a place moments before the line
 * would lose it almost immediately — the same event marked for wildly
 * different durations depending on when in the lap it happened.
 *
 * A fixed wall-clock window makes every overtake read the same. 30s is long
 * enough to still be on screen when a viewer looks up at the tower after
 * watching the move on the broadcast, and short enough that the tower isn't
 * permanently speckled with arrows.
 */
const DELTA_WINDOW_MS = 30_000;

/** Places gained per car between two orderings, positive for a gain. Both
 * arguments are the stable arrays `orderAt` returns, so this runs only when the
 * order actually changed rather than every frame. */
function recentDeltas(now: string[], before: string[]): Record<string, number> {
  const was = new Map<string, number>();
  before.forEach((number, order) => was.set(number, order));
  const deltas: Record<string, number> = {};
  now.forEach((number, order) => {
    const previous = was.get(number);
    if (previous === undefined || previous === order) return;
    deltas[number] = previous - order;
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

/** `location.origin` cannot change without a navigation, so this store has
 * nothing to subscribe to. Hoisted to module scope so the identity is
 * stable — an inline arrow would resubscribe on every render. */
const NEVER_CHANGES = () => () => {};

/** How long the pairing confirmation stays up. Long enough to be read after
 * looking up from a phone camera, short enough not to sit over the tower. */
const PAIRED_TOAST_MS = 4200;

/**
 * "It worked" — on whichever screen just did the working.
 *
 * Deliberately not inside the pairing popover. On the host the popover is
 * frequently closed by the time the phone gets scanned (you open it, show the
 * code, put the laptop down), and on the phone the popover has only just been
 * opened by the auto-join and competes with the QR panel behind it. A screen
 * that has to be *open* to report success reports nothing in the common case.
 *
 * Portalled to `document.body` for the same reason every other overlay in this
 * file is: the header and footer are both flex-none clipping contexts, and the
 * body is `overflow-hidden`, so anything fixed-positioned inside the tree is
 * one layout change from being cut off. `role="status"` rather than `alert` —
 * this is a confirmation of something the user just did, not an interruption,
 * and `alert` would preempt whatever a screen reader was mid-sentence on.
 */
function PairedToast({
  event,
  onDone,
}: {
  event: WatchPairEvent | null;
  onDone: () => void;
}) {
  const reduce = useReducedMotion();

  // Keyed on `event.id`, not on the object: a second pairing while the first
  // toast is still up has to restart the timer rather than inherit the
  // remainder of the old one.
  const eventId = event?.id ?? null;
  useEffect(() => {
    if (eventId === null) return;
    const handle = setTimeout(onDone, PAIRED_TOAST_MS);
    return () => clearTimeout(handle);
  }, [eventId, onDone]);

  // No `mounted` guard: `event` is null on the server and null on the client's
  // first render (it can only be set by a fetch resolving), so both renders
  // agree on nothing and `document.body` is never touched during SSR. Same
  // shape as the pairing popover's portal below.
  if (!event) return null;

  const joined = event.kind === "joined";
  const others = Math.max(1, event.devices - 1);

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed z-[60] flex items-center gap-3 pl-3 pr-4 py-3 rounded-2xl pointer-events-none"
      style={{
        top: "max(0.75rem, env(safe-area-inset-top, 0px) + 0.75rem)",
        left: "50%",
        // Centring lives in the transform, and so does the entrance, so the two
        // cannot be split across a Tailwind utility and a keyframe — the
        // animation would win and the toast would jump to the left edge for its
        // whole duration. `apex-toast-in` carries the -50% itself.
        transform: "translateX(-50%)",
        width: "min(calc(100vw - 1.5rem), 340px)",
        // Opaque, not glass. This lands on top of a moving timing tower, and a
        // translucent panel over twenty rows of shifting numbers is the one
        // place where the house style actively costs legibility.
        background: "linear-gradient(180deg,#241a13,#191210)",
        border: "1px solid rgb(var(--rgb-flame-bright) / 0.45)",
        boxShadow: "0 20px 50px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.10)",
        animation: reduce ? undefined : "apex-toast-in 320ms var(--ease-out-apex) both",
      }}
    >
      <span
        className="flex items-center justify-center w-8 h-8 rounded-full flex-none"
        style={{ background: "linear-gradient(140deg,var(--color-primary),var(--color-primary-container))", color: "#1a1210" }}
      >
        <Check size={17} strokeWidth={3} />
      </span>
      <div className="min-w-0">
        <p className="font-extrabold text-[13px] text-primary leading-tight">
          {joined ? "Paired with the other screen" : "Second screen paired"}
        </p>
        <p className="font-medium text-[11px] text-warm-400 leading-snug mt-0.5">
          {joined
            ? "This device now follows the same replay. Play, pause or jump here and the other screen follows too."
            : `${event.devices} screens in step — ${others} other ${
                others === 1 ? "device is" : "devices are"
              } following this replay.`}
        </p>
      </div>
    </div>,
    document.body
  );
}

export default function WatchView({
  replay,
  timing = null,
  radio = null,
}: {
  replay: RaceReplay;
  /** The per-second track. Optional and nullable on purpose: a pre-2023 round,
   * or one OpenF1 does not cover, has none, and the tower falls back to the
   * lap-stepped behaviour it had before CP79 rather than failing. */
  timing?: RaceTiming | null;
  /** Team radio for this session. Nullable on the same terms as `timing`, and
   * empty far more often than it is populated: F1 published no radio at all for
   * the first eight race and sprint sessions of 2026, and none for any session
   * before 2023. Absent means the captions never appear — never an error state,
   * and never an empty box. */
  radio?: RaceRadio | null;
}) {
  const reduce = useReducedMotion();
  const laps = replay.laps;

  /** Built once per race, not per render or per frame. */
  const timingIndex = useMemo(() => buildTimingIndex(timing), [timing]);
  const perSecond = timingIndex.usable;

  /**
   * The clock runs on the timing feed's own lap durations wherever they exist.
   *
   * **This is a correctness requirement, not an optimisation.** Every `t_ms` in
   * the timing feed is elapsed time on the official lap archive's timeline;
   * `lapDurations(laps)` builds a *different* timeline by summing per-lap
   * minima out of `race_replay`. Running the clock on one while drawing samples
   * stamped on the other is precisely the bug that shipped the 2026 Australian
   * GP with laps 1 and 2 inverted — the two disagree most in the opening
   * minutes, where the race is at its busiest.
   *
   * `lapDurations` remains the fallback, and keeps its `source`/`medianMs`
   * reporting for the "N laps have no measured time" note: an unsynced round
   * still needs a clock, and its honesty about estimated laps is unchanged.
   */
  const replayDurations = useMemo(() => lapDurations(laps), [laps]);
  const durations = useMemo(() => {
    const fromTiming = timing?.lap_ms;
    if (!fromTiming || fromTiming.length === 0) return replayDurations;
    // Index-aligned to `replay.laps`, which is what the clock and every readout
    // below assume. A timing feed covering more or fewer laps than the replay
    // is trimmed or topped up rather than silently shifting the alignment.
    const ms = replayDurations.ms.map(
      (fallback, index) => fromTiming[index] ?? fallback
    );
    return {
      ...replayDurations,
      ms,
      // Every lap the feed covers is a real measurement from the official
      // archive, so it is no longer estimated whatever the replay thought.
      source: replayDurations.source.map((value, index) =>
        index < fromTiming.length ? ("measured" as const) : value
      ),
      estimatedCount: replayDurations.source.filter(
        (value, index) => value === "estimated" && index >= fromTiming.length
      ).length,
    };
  }, [replayDurations, timing]);
  const cumulative = useMemo(() => cumulativeMs(durations.ms), [durations]);
  const totalMs = cumulative[cumulative.length - 1] ?? 0;

  /**
   * When each car is stationary, on the same race-elapsed clock the tower runs.
   *
   * **`runner.pit` is not usable directly and that is the whole point of this.**
   * It is recorded on the driver's own lap N, while `current` is the *leader's*
   * lap N, so the flag appears and disappears on a clock that has nothing to do
   * with the car — on round 1 the leader's lap 13 is over 53.6 seconds before
   * car 14's samples even stop, so his 972-second garage stop never rendered
   * `PIT` for a single millisecond of itself. See `watch-pit.ts` for the
   * measurements and for what the window is anchored to.
   *
   * Built from the same `cumulative` the frame loop adds its elapsed time to,
   * deliberately: two of this view's shipped defects were one part of it running
   * on a timeline another part was not.
   */
  const pitWindows = useMemo(
    () => buildPitWindows(laps, cumulative),
    [laps, cumulative]
  );

  const [lapIndex, setLapIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [jumpValue, setJumpValue] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [keepAwake, setKeepAwake] = useState(true);
  const wakeLockHeld = useWakeLock(keepAwake);

  // Persisted viewer preferences. Read through `useSyncExternalStore` rather
  // than an effect: this view is server-rendered, so the server tree has to be
  // the default and the stored value has to arrive at hydration without a
  // mismatch — which is exactly the swap that hook performs.
  const density = useSyncExternalStore(
    subscribePreferences,
    densitySnapshot,
    densityServerSnapshot
  );
  const pinnedList = useSyncExternalStore(
    subscribePreferences,
    pinnedSnapshot,
    pinnedServerSnapshot
  );
  const pinned = useMemo(() => new Set(pinnedList), [pinnedList]);
  const [pinnerOpen, setPinnerOpen] = useState(false);
  const timingMode = useSyncExternalStore(
    subscribePreferences,
    timingModeSnapshot,
    timingModeServerSnapshot
  );
  const radioCaptions = useSyncExternalStore(
    subscribePreferences,
    radioCaptionsSnapshot,
    radioCaptionsServerSnapshot
  );

  /* ----------------------------- team radio ----------------------------- */

  /** Placed, in-race, transcribed clips, sorted once per race rather than per
   * frame. A session with none of those leaves this empty and the whole feature
   * costs one array read per frame. */
  const radioClips = useMemo(() => schedulableClips(radio?.clips), [radio]);

  /** The scheduler's state is a ref, not state: `advanceRadio` is called from
   * inside the frame loop, where allocating a new object sixty times a second
   * would be the expensive part of this feature. React only hears about it when
   * the cue's *identity* changes — the same discipline `orderRef` applies to the
   * running order. */
  const radioStateRef = useRef(createRadioState());
  const radioCueIdRef = useRef<string | null>(null);
  const [radioCue, setRadioCue] = useState<RadioCue | null>(null);

  // Read inside the frame loop through refs so `paintProgress` does not gain
  // dependencies that rebuild it — and, through `paintRef`, the clock — every
  // time the viewer flips a switch. Toggling a caption preference must not
  // restart the race, which is the bug `paintRef` exists to prevent.
  const radioClipsRef = useRef(radioClips);
  const radioEnabledRef = useRef(radioCaptions);
  useEffect(() => {
    radioClipsRef.current = radioClips;
  }, [radioClips]);
  useEffect(() => {
    radioEnabledRef.current = radioCaptions;
    if (!radioCaptions) {
      radioCueIdRef.current = null;
      setRadioCue(null);
    }
  }, [radioCaptions]);

  const togglePinned = useCallback(
    (number: string) => {
      setPinnedPreference(
        pinnedList.includes(number)
          ? pinnedList.filter((value) => value !== number)
          : [...pinnedList, number]
      );
    },
    [pinnedList]
  );

  const clockRef = useRef<RealTimeLapClock | null>(null);
  // Sub-lap progress is written straight to the DOM rather than into React
  // state: it changes every frame, and re-rendering twenty tower rows at 60Hz
  // to move one progress bar is exactly the kind of work that makes a
  // full-screen view stutter. The lap *index* stays in state, because that is
  // a rare change that genuinely re-renders the tower.
  const lapFillRef = useRef<HTMLDivElement>(null);
  const lapTimerRef = useRef<HTMLSpanElement>(null);
  const raceClockRef = useRef<HTMLSpanElement>(null);

  /**
   * Per-row timing cells, addressed by car number.
   *
   * Registered by callback ref rather than looked up from the DOM: these are
   * written every frame, and a `querySelector` per driver per frame is the kind
   * of cost that only shows up on the phone this mode is built for. Entries are
   * deleted on unmount so a driver dropped from the field cannot leak a
   * detached node for the rest of the race.
   */
  const cellRefs = useRef(
    new Map<
      string,
      {
        primary: HTMLElement | null;
        secondary: HTMLElement | null;
        row: HTMLElement | null;
        position: HTMLElement | null;
      }
    >()
  );

  const registerCell = useCallback(
    (number: string, key: "primary" | "secondary" | "row" | "position") =>
      (node: HTMLElement | null) => {
        const map = cellRefs.current;
        const entry =
          map.get(number) ?? { primary: null, secondary: null, row: null, position: null };
        entry[key] = node;
        if (!entry.primary && !entry.secondary && !entry.row && !entry.position) {
          map.delete(number);
        } else {
          map.set(number, entry);
        }
      },
    []
  );

  /** The live field order, and the deltas that go with it. Held in state
   * because the tower genuinely has to re-render to reorder — but written only
   * when the order *changes* (~531 times in a whole race), never per frame. */
  /**
   * Seeded with the order at t=0 rather than starting `null`.
   *
   * `null` means "fall back to the lap row", and the lap row for lap 1 is the
   * order at the *end* of lap 1 — so the tower rendered a mid-race order until
   * the first painted frame replaced it. On the Australian GP that put Leclerc
   * P1 and Hamilton P3 on screen before the race had started, which is exactly
   * the wrong-looking state a viewer sees when they open the page and have not
   * pressed play yet.
   *
   * Seeding also makes the server-rendered markup correct on its own, instead of
   * correct-after-hydration.
   */
  const [liveOrder, setLiveOrder] = useState<string[] | null>(() =>
    orderAt(timingIndex, 0)
  );
  const [liveDeltas, setLiveDeltas] = useState<Record<string, number>>({});
  const orderRef = useRef<string[] | null>(liveOrder);

  /**
   * Which cars are in the pits right now.
   *
   * React state, not a per-frame DOM write, and the distinction is the same one
   * `liveOrder` is held to: membership changes twice per stop (~64 times in a
   * whole race), so this is one of the genuinely discrete things in this view.
   * It also has to change what React *renders* — a stationary car's row shows
   * `PIT` instead of a timing cell, so the cell is not in the tree at all — and
   * that is not something the frame loop can express by writing text into a
   * node.
   *
   * Seeded at t=0 so the server-rendered markup is already right, for the same
   * reason `liveOrder` and `initialCells` are.
   */
  const [inPit, setInPit] = useState<Set<string>>(() => pitSetAt(pitWindows, 0));
  const pitRef = useRef(inPit);

  /** The live order as a `{car number -> rank}` map, cached against the order's
   * identity so the frame loop does a map hit instead of a linear scan per row. */
  const ranksRef = useRef<{ order: string[] | null; ranks: Map<string, number> }>({
    order: null,
    ranks: new Map(),
  });

  /**
   * One frame of the clock: the lap readouts, then every driver's timing cell.
   *
   * **The tower's numbers are written straight to the DOM, not into state.** An
   * interval counting down from 1.4 to 0.4 changes on every one of 60 frames a
   * second, and routing that through React would re-render up to 22 rows at
   * 60Hz to move text inside them — precisely the work CP77 removed to stop
   * this view stuttering, and the reason `lapFillRef` already exists. State is
   * reserved for the two things that are genuinely discrete: which lap it is,
   * and what order the field is in.
   */
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
      const raceMs = (cumulative[index] ?? 0) + elapsedMs;
      if (raceClockRef.current) {
        raceClockRef.current.textContent = formatRaceClock(raceMs);
      }

      // Above the `perSecond` gate on purpose, and for the same reason pit
      // windows are: a radio clip is placed against the measured race start,
      // not against the per-second feed, so a round with no per-second track
      // still gets its captions at the right moment.
      //
      // `playing` is read off the clock rather than from React state because
      // this callback also runs once while paused (to repaint after a jump),
      // and a caption must not fire on a stopped clock.
      const cue = advanceRadio(
        radioStateRef.current,
        radioClipsRef.current,
        raceMs,
        {
          playing: clockRef.current?.playing ?? false,
          enabled: radioEnabledRef.current,
        }
      );
      const cueId = cue?.clip.id ?? null;
      if (cueId !== radioCueIdRef.current) {
        // Identity, not value: `advanceRadio` returns the same cue object for
        // every frame a caption is on screen, and comparing objects here would
        // re-render the whole view at 60Hz for the six seconds it is up.
        radioCueIdRef.current = cueId;
        setRadioCue(cue);
      }

      const pits = pitSetAt(pitWindows, raceMs);
      if (!samePitSet(pits, pitRef.current)) {
        pitRef.current = pits;
        setInPit(pits);
      }

      if (!perSecond) return;

      const order = orderAt(timingIndex, raceMs);
      if (order && order !== orderRef.current) {
        // `orderAt` returns a stable reference until the order genuinely
        // changes, so this identity check is the whole gate on re-rendering.
        orderRef.current = order;
        setLiveOrder(order);
        // Deltas are recomputed only here, against the order as it stood
        // `DELTA_WINDOW_MS` ago — cheap at ~531 times a race, and impossible to
        // keep consistent if computed per frame from mutable cursors.
        const past = orderAt(timingIndex, raceMs - DELTA_WINDOW_MS);
        setLiveDeltas(past && past !== order ? recentDeltas(order, past) : {});
      }

      // Rebuilt only when the order's identity changes (~531 times a race, not
      // 60 times a second), so the per-cell lookup below stays a map hit rather
      // than a linear scan inside the frame loop.
      if (order && ranksRef.current.order !== order) {
        const ranks = new Map<string, number>();
        order.forEach((number, position) => ranks.set(number, position + 1));
        ranksRef.current = { order, ranks };
      }
      const ranks = order ? ranksRef.current.ranks : null;

      const leader = order?.[0];
      for (const [number, cell] of cellRefs.current) {
        const snapshot = sampleAt(timingIndex, number, raceMs);
        const isLeader = number === leader;
        const primaryValue =
          timingMode === "interval" ? snapshot.interval : snapshot.gapToLeader;
        const secondaryValue =
          timingMode === "interval" ? snapshot.gapToLeader : snapshot.interval;
        if (cell.primary) {
          // Direct DOM writes are the point of `cellRefs` (see the docstring
          // above `paintProgress`): routing this through state would
          // re-render up to 22 rows at 60Hz, which is exactly what this
          // imperative escape hatch exists to avoid.
          // eslint-disable-next-line react-hooks/immutability
          cell.primary.textContent = formatTimingValue(primaryValue, isLeader);
        }
        if (cell.secondary) {
          // The leader has no meaningful secondary reading — "LEADER" beside
          // "LEADER" is noise, so the cell empties rather than repeating it.
          cell.secondary.textContent = isLeader
            ? ""
            : formatTimingValue(secondaryValue, false);
        }
        if (cell.position) {
          // **The number is the car's rank in the live order, not its raw
          // sampled position.** Those differ, and the raw value is not
          // renderable: each car's position is stamped at its own line crossing
          // and carried forward, so two cars on different laps routinely report
          // the same number. Measured on round 1, some position was duplicated
          // in 19% of the race — the tower showed two P18s and no P16 at all.
          //
          // Ranking the order the rows are already sorted by makes the numbers
          // unique and contiguous by construction, and makes it impossible for
          // the number and the row's place to disagree.
          //
          // **This is not the renumbering bug that was fixed before.** That one
          // indexed the *rendered rows*, so a car in the live order with no lap
          // row (a lap-1 retirement) left a hole that shifted everyone behind
          // it — the grid read NOR 5, HAM 6 against an official 6th and 7th.
          // This indexes the live order itself, which is exactly the set the
          // positions describe, and cars that leave the race are dropped from
          // it via `out_ms` rather than lingering as ghosts.
          const rank = ranks?.get(number);
          if (rank !== undefined) cell.position.textContent = String(rank);
          else if (snapshot.position !== null) {
            cell.position.textContent = String(snapshot.position);
          }
        }
        if (cell.row) {
          // The closing highlight is the release valve for the design's "the
          // gap carries the tension" decision: it fires off the *interval*
          // regardless of which mode is displayed, because whether a car is
          // about to be attacked does not depend on what the viewer chose to
          // read.
          cell.row.style.setProperty(
            "--closing",
            isClosing(snapshot.interval) && !isLeader ? "1" : "0"
          );
        }
      }
    },
    [cumulative, durations, perSecond, pitWindows, timingIndex, timingMode]
  );

  /**
   * The frame painter, reached through a ref rather than closed over.
   *
   * `paintProgress` now depends on the timing mode (it decides which value each
   * cell shows), and the clock effect below depends on its `onFrame`. Wiring
   * them together directly means toggling INT/GAP rebuilds `RealTimeLapClock`
   * — which **restarts the race at lap 1**, mid-watch-party, on a control that
   * is supposed to change nothing but a label. Found by tracing the dependency
   * chain rather than by watching it happen, which is exactly the kind of bug
   * that only reproduces 40 minutes into a session.
   *
   * The indirection keeps the clock's identity tied to the durations alone,
   * which is the only thing that genuinely invalidates it.
   */
  const paintRef = useRef(paintProgress);
  useEffect(() => {
    paintRef.current = paintProgress;
  }, [paintProgress]);

  // One clock for the life of the view. It is created in an effect (not in
  // render) so React strict-mode's double-invoke disposes the first one rather
  // than leaking a second rAF loop over the same race.
  useEffect(() => {
    const clock = new RealTimeLapClock({
      durationsMs: durations.ms,
      onLapChange: setLapIndex,
      onFrame: (index, elapsedMs) => paintRef.current(index, elapsedMs),
      onEnd: () => setPlaying(false),
    });
    clockRef.current = clock;
    return () => {
      clock.dispose();
      clockRef.current = null;
    };
  }, [durations]);


  /* ------------------------- the paired second screen ------------------------- */

  const router = useRouter();
  const searchParams = useSearchParams();
  const raceId = toRaceId(replay.year, replay.round);
  const [partyOpen, setPartyOpen] = useState(false);
  /**
   * The deep link the QR encodes, resolved in the browser.
   *
   * `window.location.origin` rather than a configured base URL on purpose: the
   * phone has to reach the exact host the laptop is already on, and that
   * differs per environment (a LAN address in development, the Cloud Run
   * hostname in production, a preview URL in between). A build-time constant
   * would be right in exactly one of those.
   *
   * Null on the server so the two renders agree — reading `location` during
   * render is the same hydration-mismatch class `local-datetime` and the
   * countdown had to be fixed for. `useSyncExternalStore` is the SSR-safe way
   * to read a browser value: it takes an explicit server snapshot, and it
   * needs no state to set and therefore no effect to set it in.
   */
  const origin = useSyncExternalStore(
    NEVER_CHANGES,
    () => window.location.origin,
    () => null
  );
  const [joinCode, setJoinCode] = useState("");

  /**
   * This device's position, read at the moment of publishing rather than held
   * in state.
   *
   * The clock is the only thing that knows where the race actually is — the
   * sub-lap offset never enters React state, because it changes sixty times a
   * second and re-rendering the tower for it is the cost CP77 removed. So this
   * asks the clock directly. Reading `lapIndex` from state instead would publish
   * a value that is correct but stale by up to a frame, and reading elapsed from
   * state is not possible at all.
   */
  const readPartyState = useCallback(() => {
    const clock = clockRef.current;
    return {
      lap_index: clock?.lapIndex ?? 0,
      lap_elapsed_ms: Math.max(0, Math.round(clock?.elapsedInLapMs ?? 0)),
      playing: clock?.playing ?? false,
      timing_mode: timingMode,
    };
  }, [timingMode]);

  /**
   * Put this device where the other screen says it is.
   *
   * `setPosition`, not `jumpTo`: the offset within the lap is the whole point of
   * the sync, and `jumpTo` deliberately discards it. See the note on
   * `RealTimeLapClock.setPosition`.
   *
   * Play state is applied by comparison rather than by calling `play()`/`pause()`
   * unconditionally — `play()` on an already-running clock is a no-op, but
   * `pause()` on a paused one is too and the guard costs nothing, while calling
   * `play()` when the clock has run to the end silently restarts the race at lap
   * 1. Better to only touch the clock when the state genuinely differs.
   */
  const applyPartyState = useCallback((position: WatchPosition) => {
    const clock = clockRef.current;
    if (!clock) return;
    clock.setPosition(position.lapIndex, position.elapsedMs);
    if (position.playing !== clock.playing) {
      if (position.playing) clock.play();
      else clock.pause();
    }
    setLapIndex(clock.lapIndex);
    setPlaying(clock.playing);
    // A shared preference, not just a shared position: two people reading
    // different columns while pointing at the same tower is the confusion this
    // avoids. It does outlive the party, which is the honest cost of syncing a
    // stored preference at all.
    if (position.timingMode) setTimingModePreference(position.timingMode);
  }, []);

  const party = useWatchParty({
    raceId,
    durationsMs: durations.ms,
    readState: readPartyState,
    applyState: applyPartyState,
  });

  const { publish: publishParty } = party;

  /**
   * The URL the QR encodes: this race, plus the code, so the phone arrives
   * already on the right replay and joins itself.
   *
   * Prefers the party's own race id over this page's. They are the same on the
   * host, but the party is the authority on what is being watched together —
   * and a code shown on a page that later navigates would otherwise encode a
   * race nobody is in.
   */
  const pairUrl =
    origin && party.code
      ? `${origin}/watch/${party.partyRaceId ?? raceId}?pair=${encodeURIComponent(party.code)}`
      : null;

  /**
   * `?pair=CODE` — the deep link behind the QR code.
   *
   * The phone lands here already on the right race, so joining is the only
   * step left. Guarded by a ref rather than by `party.paired`, because `join`
   * is not instant and React can run this effect again before the paired state
   * lands — which would spend the code twice, and the second spend fails since
   * a code works exactly once.
   *
   * The parameter is stripped either way. It is single-use, so a bookmark, a
   * reload or a forwarded link containing it can only ever produce a confusing
   * "code not found" long after the pairing it describes has succeeded.
   */
  const autoJoinAttempted = useRef(false);
  const pairParam = searchParams.get("pair");
  useEffect(() => {
    if (!pairParam || autoJoinAttempted.current) return;
    autoJoinAttempted.current = true;
    void party.join(pairParam).then((view) => {
      // Opened from the callback, not the effect body: this is a response to
      // the join resolving, and a synchronous setState here would be a
      // cascading render.
      setPartyOpen(true);
      if (view?.race_id && view.race_id !== raceId) {
        router.replace(`/watch/${view.race_id}`);
        return;
      }
      router.replace(`/watch/${raceId}`, { scroll: false });
    });
  }, [pairParam, party, raceId, router]);

  /**
   * How long the displayed code has left.
   *
   * Presentation only, and deliberately not load-bearing: this is the *client's*
   * clock measured against a server deadline, so a device with a wrong clock
   * shows a wrong countdown. The server decides whether a code still works, and
   * a join refused for a code this counter thought was alive reads as an
   * ordinary "that code doesn't match" — which is the same message a mistype
   * gets, and the right one either way.
   */
  const [codeSecondsLeft, setCodeSecondsLeft] = useState<number | null>(null);
  useEffect(() => {
    const deadline = party.codeExpiresAt ? Date.parse(party.codeExpiresAt) : NaN;
    if (!Number.isFinite(deadline)) {
      setCodeSecondsLeft(null);
      return;
    }
    const tick = () =>
      setCodeSecondsLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, [party.codeExpiresAt]);

  const toggle = useCallback(() => {
    const clock = clockRef.current;
    if (!clock) return;
    clock.toggle();
    setLapIndex(clock.lapIndex);
    setPlaying(clock.playing);
    // Published from the handler, never from an effect watching `playing`. An
    // effect would fire again when a *remote* state was applied, and the two
    // devices would trade echoes for as long as the party lasted.
    publishParty();
  }, [publishParty]);

  /** The catch-up control. An instant snap, never a fast-forward: exactly one
   * clock runs, so it is never ambiguous whether what is on screen is real pace
   * or a scrub. */
  const jumpTo = useCallback(
    (index: number) => {
      const clock = clockRef.current;
      if (!clock) return;
      clock.jumpTo(index);
      setLapIndex(clock.lapIndex);
      // Drift correction is the interaction this mode exists for, so it is the
      // one that most needs to reach the other screen.
      publishParty();
    },
    [publishParty]
  );

  const restart = useCallback(() => {
    const clock = clockRef.current;
    if (!clock) return;
    clock.pause();
    clock.jumpTo(0);
    setLapIndex(0);
    setPlaying(false);
    publishParty();
  }, [publishParty]);

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
      // A focused button must keep Space for its own activation — otherwise
      // tabbing to "Go" and pressing Space both submits the jump and toggles
      // playback. Found by keyboard-driving the finished view rather than
      // reasoning about it.
      if (target && (target.tagName === "INPUT" || target.isContentEditable)) return;
      if (target?.tagName === "BUTTON" && event.key === " ") return;
      if (event.key === "Escape") {
        setPinnerOpen(false);
        setPartyOpen(false);
        return;
      }
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

  /**
   * The field, in the order it was actually running in at this instant.
   *
   * Composition, not replacement: the per-second track knows *position* and
   * *gaps*, and knows nothing about tyres, pit stops or retirement. Those come
   * from the lap row exactly as before. So a runner's identity and race state
   * are still the replay's, and only the ordering is the live feed's — which is
   * why a round with timing but no position feed can fall straight back to
   * `current.runners` without any other part of the row changing.
   *
   * A car in the live order with no lap row (and vice versa) is skipped rather
   * than synthesised: the two feeds disagree at the edges of a race — the live
   * order keeps reporting a car for a few samples after it has stopped — and
   * inventing a runner to satisfy an ordering would put a row on screen with no
   * tyre, no gap and no meaning.
   */
  const orderedRunners = useMemo<ReplayRunner[]>(() => {
    const runners = current?.runners ?? [];
    if (!liveOrder) return runners;
    const byNumber = new Map(runners.map((runner) => [runner.number, runner]));
    const ordered: ReplayRunner[] = [];
    for (const number of liveOrder) {
      const runner = byNumber.get(number);
      if (runner) {
        ordered.push(runner);
        byNumber.delete(number);
      }
    }
    // Anyone the live order does not mention keeps their lap-row order behind
    // the cars it does — a retired car is the usual case, and dropping them
    // would thin the field out, the exact failure PRs #72/#73 fixed.
    for (const runner of runners) {
      if (byNumber.has(runner.number)) ordered.push(runner);
    }
    return ordered;
  }, [current, liveOrder]);

  /** Per-lap deltas are the fallback; with a per-second track the markers come
   * from `liveDeltas`, computed over a fixed time window instead. */
  const lapDeltas = useMemo(
    () => positionDeltas(current, laps[lapIndex - 1]),
    [current, laps, lapIndex]
  );
  const deltas = perSecond ? liveDeltas : lapDeltas;

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

  /** The single line compact density has room for. */
  const latest = feed[0];

  const currentLapMs = durations.ms[lapIndex] ?? 0;
  const currentIsEstimated = durations.source[lapIndex] === "estimated";

  // Rows are sized off the measured tower box so a full field fills a landscape
  // screen instead of being sized for a desk. Measured rather than computed
  // from a viewport unit because the header and control bar wrap differently at
  // different widths, and guessing their height is how a tower ends up
  // scrolling on exactly one device. Width matters as much as height now: it is
  // what decides whether the field can be split into two columns.
  const towerRef = useRef<HTMLDivElement>(null);
  const [towerBox, setTowerBox] = useState({ width: 0, height: 0 });
  const runnerCount = current?.runners.length ?? 20;

  useEffect(() => {
    const node = towerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (height <= 0) return;
      setTowerBox((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height }
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () =>
      towerLayout({
        width: towerBox.width,
        height: towerBox.height || 400,
        rowCount: runnerCount,
        density,
      }),
    [towerBox, runnerCount, density]
  );

  /** Pinned drivers first, everyone else in position order. `positionOrder` is
   * carried through untouched so the row still knows its real place in the
   * field — pinning surfaces a driver, it never renumbers one. */
  const slots = useMemo(
    () => orderRunners(orderedRunners, pinned),
    [orderedRunners, pinned]
  );

  /**
   * What every cell reads before the first frame paints.
   *
   * **The row's order and the row's contents must come from the same source, or
   * they contradict each other on screen.** `liveOrder` is seeded from
   * `orderAt(timingIndex, 0)`, so the rows open in the starting-grid order; the
   * number and gap inside them used to render from the lap row, whose lap-1
   * entry is the state at the *end* of lap 1. The Australian GP opened with the
   * rows in grid order and Leclerc's row — sitting fourth — labelled **P1** and
   * **+0.0**, Russell's sitting first and labelled P2, Hamilton's sixth and
   * labelled P3. Every number was a real measurement; none of them described
   * the instant being shown.
   *
   * This is the other half of the fix that seeded `liveOrder`. That one made
   * the *ordering* correct before hydration and left the contents
   * correct-only-after-hydration, which is a state a viewer can see: the repaint
   * effect below runs after mount, so the contradiction is served in the HTML
   * and survives until React has hydrated and run effects.
   *
   * Computed with the same `orderAt` / `sampleAt` / `formatTimingValue` calls
   * the frame loop makes, so "before play" and "one frame after play" cannot
   * disagree by construction. `null` when there is no per-second track, where
   * the lap row genuinely is the best available answer and the old behaviour
   * stands.
   */
  const initialCells = useMemo(() => {
    if (!perSecond) return null;
    const order = orderAt(timingIndex, 0);
    const leader = order?.[0];
    const ranks = new Map<string, number>();
    order?.forEach((number, index) => ranks.set(number, index + 1));

    const cells = new Map<
      string,
      { position: string | null; primary: string; secondary: string }
    >();
    for (const number of timingIndex.drivers.keys()) {
      const snapshot = sampleAt(timingIndex, number, 0);
      const isLeader = number === leader;
      const primaryValue =
        timingMode === "interval" ? snapshot.interval : snapshot.gapToLeader;
      const secondaryValue =
        timingMode === "interval" ? snapshot.gapToLeader : snapshot.interval;
      const rank = ranks.get(number) ?? snapshot.position;
      cells.set(number, {
        position: rank === undefined || rank === null ? null : String(rank),
        primary: formatTimingValue(primaryValue, isLeader),
        secondary: isLeader ? "" : formatTimingValue(secondaryValue, false),
      });
    }
    return cells;
  }, [perSecond, timingIndex, timingMode]);

  /**
   * Repaint the timing cells outside the frame loop.
   *
   * The loop only runs while playing, so without this the tower would show
   * stale numbers in three ordinary situations: on first mount before play is
   * pressed, while paused, and immediately after toggling INT/GAP (where the
   * labels would keep the old mode's values until the clock next ticked). Reads
   * the clock rather than tracking a second copy of the time.
   */
  useEffect(() => {
    const clock = clockRef.current;
    if (!clock) return;
    paintRef.current(clock.lapIndex, clock.elapsedInLapMs);
    // `inPit` is in the list because a car leaving the pits re-mounts its timing
    // cell, and a freshly mounted cell holds React's initial (t=0) text until
    // something writes to it. Without this it would read the grid's gap until
    // the next frame — invisible while playing, permanent while paused.
    // Re-entering this effect cannot loop: `samePitSet` gates the state write.
  }, [timingMode, slots, density, perSecond, inPit]);

  /** The pinner lists the field in *running* order, not pin order: someone
   * reaching for it mid-race is looking for a driver they can see on the TV. */
  const pinnableDrivers = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ number: string; code: string; name: string; team: string | null }> = [];
    for (const runner of current?.runners ?? []) {
      if (seen.has(runner.number)) continue;
      seen.add(runner.number);
      const driver = replay.drivers[runner.number];
      list.push({
        number: runner.number,
        code: driver?.code ?? runner.number,
        name: driver?.name ?? runner.number,
        team: driver?.team ?? null,
      });
    }
    return list;
  }, [current, replay.drivers]);

  const rowTransitionMs = reduce ? 0 : 420;

  /* Compact's chrome trims, measured rather than guessed. On an 844x390 phone
   * CP77's chrome took 171 of the 390 available pixels — 44% of the screen, for
   * a header, a lap rail and a control bar — and every pixel of it is worth a
   * row of tower. These classes are written out in full at each use because
   * Tailwind scans source text for complete class names and would not emit one
   * assembled at runtime. They key on viewport *height*, since height is the
   * thing in short supply: an 844x390 phone is wide. */
  const compact = density === "compact";

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden bg-[#070605] text-on-background select-none">
      {/* Both halves of a successful pairing, announced on the screen that
          experienced it. See `WatchPairEvent`. */}
      <PairedToast event={party.pairEvent} onDone={party.clearPairEvent} />

      {/* Rendered unconditionally with a nullable clip rather than behind a
          guard: keeping one instance mounted for the life of the view means the
          `<audio>` element survives between clips, so a second message arriving
          mid-playback stops the first rather than orphaning it. */}
      <RadioPopup
        clip={radioCue?.clip ?? null}
        driver={
          radioCue ? replay.drivers[radioCue.clip.driver_number] ?? null : null
        }
        onDismiss={() => {
          radioCueIdRef.current = null;
          radioStateRef.current.current = null;
          setRadioCue(null);
        }}
      />

      {/* ------------------------------ header ------------------------------ */}
      <header
        className={`flex items-center gap-4 px-4 md:px-6 py-2.5 [@media(max-height:520px)]:py-1 border-b border-white/[0.07] flex-none ${
          compact ? "[@media(max-height:520px)]:py-0.5 [@media(max-height:520px)]:gap-2.5" : ""
        }`}
      >
        <Link
          href="/watch"
          aria-label="Leave watch mode"
          className="flex items-center justify-center w-9 h-9 rounded-xl text-warm-400 hover:text-on-background transition-colors flex-none"
        >
          <X size={18} />
        </Link>

        {/* On a short screen compact runs the title and the framing on one
            line instead of two. The framing itself is never dropped: this app
            has no live feed and the mode must never imply one, least of all on
            the propped-up phone it is built for. */}
        <div
          className={`min-w-0 ${
            compact
              ? "[@media(max-height:520px)]:flex [@media(max-height:520px)]:items-baseline [@media(max-height:520px)]:gap-2 [@media(max-height:520px)]:min-w-0"
              : ""
          }`}
        >
          <h1
            className={`font-[family-name:var(--font-headline)] font-extrabold text-lg md:text-2xl [@media(max-height:520px)]:text-base leading-none truncate ${
              compact ? "[@media(max-height:520px)]:flex-none" : ""
            }`}
          >
            {replay.race_name ?? `Round ${replay.round}`}
          </h1>
          <p
            className={`font-semibold text-[10px] md:text-[11px] tracking-[0.12em] uppercase text-warm-500 mt-1 truncate ${
              compact ? "[@media(max-height:520px)]:mt-0" : ""
            }`}
          >
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
            <span
              className={`font-semibold text-[9px] tracking-[0.12em] uppercase text-warm-500 ${
                compact ? "[@media(max-height:520px)]:hidden" : ""
              }`}
            >
              of {formatRaceClock(totalMs)}
            </span>
          </div>
          <div className="text-right">
            <span className="font-[family-name:var(--font-headline)] font-extrabold text-2xl md:text-4xl [@media(max-height:520px)]:text-xl tabular-nums leading-none block">
              {current?.lap ?? 0}
              <span className="text-warm-500 text-base md:text-2xl"> / {replay.total_laps}</span>
            </span>
            {/* "Lap" is the one label compact can afford to lose: the number is
                already followed by "/ 78". */}
            <span
              className={`font-semibold text-[9px] tracking-[0.12em] uppercase text-warm-500 ${
                compact ? "[@media(max-height:520px)]:hidden" : ""
              }`}
            >
              Lap
            </span>
          </div>
        </div>
      </header>

      {/* --------------------------- lap progress --------------------------- */}
      {/* Compact puts the readout and the rail on one line rather than two —
          the rail does not need its own row, and the row it was taking is a
          tower row per column. */}
      <div
        className={`flex-none px-4 md:px-6 pt-2.5 [@media(max-height:520px)]:pt-1 ${
          compact
            ? "[@media(max-height:520px)]:flex [@media(max-height:520px)]:items-center [@media(max-height:520px)]:gap-3 [@media(max-height:520px)]:pt-1.5"
            : ""
        }`}
      >
        <div
          className={`flex items-baseline gap-2 mb-1.5 ${
            compact
              ? "[@media(max-height:520px)]:mb-0 [@media(max-height:520px)]:flex-none"
              : ""
          }`}
        >
          <span className="font-bold text-[10px] tracking-[0.12em] uppercase text-flame">
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
          className={`h-1.5 rounded-full bg-white/[0.08] overflow-hidden ${
            compact ? "[@media(max-height:520px)]:flex-1" : ""
          }`}
          role="progressbar"
          aria-label="Progress through this lap"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`Lap ${current?.lap ?? 0} of ${formatLapDuration(currentLapMs)}`}
        >
          <div
            ref={lapFillRef}
            className="h-full rounded-full"
            style={{ width: "0%", background: "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))" }}
          />
        </div>
      </div>

      {/* ------------------------------ body ------------------------------ */}
      {/* Split on *orientation*, not width. A phone held landscape is 844x390:
          wide enough that a width breakpoint would stack race control on top
          of the tower and eat a quarter of the 390px the tower has to work
          with. Orientation is the property that actually decides whether there
          is room beside the tower or above it. */}
      <div
        className={`flex-1 min-h-0 flex flex-col gap-3 [@media(max-height:520px)]:gap-1.5 px-4 md:px-6 py-3 [@media(max-height:520px)]:py-1.5 ${
          // Compact keeps a column layout at every orientation: its race-control
          // line belongs *under* the tower, so the tower keeps the full width it
          // needs to split into two columns.
          compact ? "[@media(max-height:520px)]:py-1" : "landscape:flex-row"
        }`}
      >
        {/* Timing tower. Rows are absolutely positioned and moved with
            transform only — twenty rows reordering in the DOM every lap would
            thrash layout, and transform keeps the movement on the compositor.
            Same approach as race-replay.tsx, at watch-party scale. */}
        <div
          ref={towerRef}
          className="relative flex-1 min-h-0 overflow-hidden"
          aria-label={
            pinned.size > 0
              ? "Timing tower. Pinned drivers are shown first; each row states its real position."
              : "Timing tower, in position order"
          }
        >
          {slots.map(({ runner, positionOrder, slot, pinned: isPinned }) => {
            const driver = replay.drivers[runner.number];
            const color = getTeamColor(driver?.team ?? undefined);
            const compound = runner.compound
              ? COMPOUND_COLORS[runner.compound] ?? "var(--color-warm-400)"
              : "var(--color-warm-400)";
            const delta = deltas[runner.number] ?? 0;
            // Read from the time-driven set, never from `runner.pit` — that
            // flag is on the driver's own lap while this row is drawn from the
            // leader's. See `pitWindows` above.
            const inPitNow = inPit.has(runner.number);
            const column = Math.floor(slot / layout.rowsPerColumn);
            const rowInColumn = slot % layout.rowsPerColumn;
            const columnWidth = layout.columns > 1 ? towerBox.width / layout.columns : 0;
            return (
              <div
                key={runner.number}
                ref={registerCell(runner.number, "row")}
                // A stable hook for driving this route headlessly. The tower's
                // rows are absolutely positioned by transform, so their DOM
                // order is *not* their running order, and the position itself
                // is painted straight to a child node by the frame loop —
                // between them there is no way to read the running order out of
                // the markup by structure alone. Verifying the order against
                // the official record is the check that catches the class of
                // defect this view kept shipping, so it needs to be cheap.
                data-car={runner.number}
                className={`absolute left-0 flex items-center rounded-lg ${
                  // Compact keeps its small gaps at every width: a two-column
                  // tower on an 844px phone is still past the `md` breakpoint,
                  // and 16px gaps there are ~100px of a 400px column.
                  compact ? "gap-1.5 px-2" : "gap-2 md:gap-4 px-2 md:px-3"
                } ${layout.columns > 1 ? "" : "right-0"}`}
                style={{
                  height: layout.rowHeight - 3,
                  // A two-column tower places by x as well as y, and both move
                  // on the same transform so a driver crossing between columns
                  // slides rather than teleporting.
                  width: columnWidth > 0 ? columnWidth - 8 : undefined,
                  transform: `translate(${column * columnWidth}px, ${
                    rowInColumn * layout.rowHeight
                  }px)`,
                  transition: rowTransitionMs
                    ? `transform ${rowTransitionMs}ms ${EASE_OUT}, background-color 300ms ease, opacity 300ms ease, box-shadow 220ms ease`
                    : "background-color 300ms ease, opacity 300ms ease",
                  // The closing highlight. `--closing` is flipped between 0 and
                  // 1 by the frame loop, and the visual result is interpolated
                  // by CSS off that one number — so a car coming into range
                  // fades in over 220ms rather than snapping, without React
                  // re-rendering the row to do it. A custom property is used
                  // rather than a class because the frame loop already holds the
                  // node and toggling a class would fight Tailwind's own.
                  background: inPitNow
                    ? "rgb(var(--rgb-primary-container) / 0.16)"
                    : isPinned
                    ? "rgb(var(--rgb-flame-bright) / 0.13)"
                    : slot % 2 === 0
                    ? "rgba(255,255,255,0.025)"
                    : "transparent",
                  // Pinned rows sit out of position order by design, so they
                  // carry a standing marker rather than relying on the viewer
                  // remembering why row one isn't the leader — and it wins over
                  // the closing ring, since a pinned row must stay identifiable
                  // whatever the car is doing.
                  boxShadow: isPinned
                    ? "inset 3px 0 0 0 var(--color-flame)"
                    : "inset 0 0 0 calc(var(--closing, 0) * 1.5px) rgb(var(--rgb-flame-bright) / 0.6)",
                  // A retired car's row is carried forward from its last real
                  // lap, not live — dimmed so it never reads as a current gap.
                  opacity: runner.retired ? 0.42 : 1,
                  // Everything inside the row is sized in `em` off this, so
                  // one number scales the whole tower from a phone to a TV.
                  fontSize: layout.fontSize,
                }}
              >
                {isPinned && (
                  <Pin
                    size={Math.max(8, layout.fontSize * 0.62)}
                    className="flex-none"
                    style={{ color: "var(--color-flame)" }}
                    aria-label="Pinned"
                  />
                )}
                <span
                  ref={runner.retired ? undefined : registerCell(runner.number, "position")}
                  className="font-extrabold tabular-nums w-[1.6em] text-right flex-none"
                  style={{
                    color: runner.retired
                      ? "var(--color-warm-400)"
                      : positionOrder === 0
                      ? "var(--color-primary)"
                      : "var(--color-warm-100)",
                  }}
                >
                  {/* Initial value only — the frame loop overwrites it. It is
                      read from the timing index at t=0 rather than the lap row
                      wherever there is one, because the row's *order* comes from
                      that index too and the two must agree on the very first
                      paint, not merely once React has hydrated. See
                      `initialCells`. A retired car keeps its dash and is not
                      registered for painting: it sits behind the live order with
                      no live position to state. */}
                  {runner.retired
                    ? "—"
                    : initialCells?.get(runner.number)?.position ??
                      runner.position ??
                      "—"}
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
                  className="w-[4px] rounded-hairline flex-none"
                  style={{ background: color.hex, height: "1.3em" }}
                />

                <span className="font-extrabold flex-none w-[2.8em] tracking-[-0.01em]">
                  {driver?.code ?? runner.number}
                </span>

                {/* The full name is the first thing compact gives up: it is the
                    widest column and the least useful one, since the three-letter
                    code is what the broadcast shows too. */}
                {density === "expanded" && (
                  <span
                    className="font-semibold text-warm-300 truncate hidden md:block flex-1"
                    style={{ fontSize: "0.72em" }}
                  >
                    {driver?.name ?? ""}
                  </span>
                )}

                <span
                  className="font-bold tabular-nums px-1.5 py-0.5 rounded flex-none ml-auto"
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

                {/* Timing. Three mutually exclusive states, in priority order:
                    a retired car is OUT, a car in the pits is PIT, and anything
                    else shows its live reading.

                    The live reading's *text* is written by the frame loop, not
                    rendered by React — the children below are the initial
                    (server-rendered, pre-play) value. It comes from the timing
                    index at t=0 where there is one, so the pre-play tower states
                    the grid rather than the end of lap 1, and falls back to the
                    lap row otherwise, which keeps a round without a per-second
                    track at exactly its old behaviour. */}
                {runner.retired || inPitNow ? (
                  <span
                    className="font-bold tabular-nums text-right flex-none w-[4.6em]"
                    style={{ color: runner.retired ? "#c98a8a" : "#c9c0b4" }}
                    title={
                      runner.retired
                        ? undefined
                        : "Stationary in the pits. No gap is shown because there isn't a true one to show."
                    }
                  >
                    {runner.retired ? "OUT" : "PIT"}
                  </span>
                ) : (
                  <span className="flex flex-col items-end flex-none w-[4.6em] leading-none">
                    <span
                      ref={registerCell(runner.number, "primary")}
                      className="font-bold tabular-nums text-right"
                      style={{ color: "#c9c0b4" }}
                    >
                      {initialCells?.get(runner.number)?.primary ??
                        formatGap(runner.gap_seconds, positionOrder === 0)}
                    </span>
                    {/* The other mode's number, small, beneath the chosen one.
                        Expanded only: compact's rows are ~25px on the landscape
                        phone this mode targets, and `requiredRowWidth` is
                        measured tightly enough that a second reading there would
                        cost the tower a whole column. The toggle therefore
                        decides *emphasis* where there is room and
                        *availability* where there is not. */}
                    {density === "expanded" && perSecond && (
                      <span
                        ref={registerCell(runner.number, "secondary")}
                        className="font-semibold tabular-nums text-right text-warm-500 mt-[0.15em]"
                        style={{ fontSize: "0.62em" }}
                        aria-hidden
                      >
                        {initialCells?.get(runner.number)?.secondary ?? ""}
                      </span>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Race control. Expanded gives it a panel beside the tower (or below,
            on a phone held upright). Compact reduces it to the newest line —
            which is what actually buys the landscape phone its second tower
            column, since the panel was taking a third of the width. */}
        {density === "expanded" ? (
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
                            : "rgb(var(--rgb-flame-bright) / 0.5)"
                          : "rgba(255,255,255,0.07)"
                      }`,
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <Flag
                        size={12}
                        className="flex-none"
                        style={{ color: urgent ? "#FF6B6B" : "var(--color-primary)" }}
                      />
                      <span
                        className="font-extrabold text-[12px] md:text-[13px]"
                        style={{ color: urgent ? "#FF6B6B" : "var(--color-primary)" }}
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
                )
              })}
            </div>
          </aside>
        ) : (
          <div
            className="flex-none flex items-center gap-2 rounded-lg px-2.5 py-1 min-w-0"
            style={{
              background: latest && URGENT_EVENT_KINDS.has(latest.kind)
                ? "rgba(255,68,68,0.12)"
                : "rgba(255,255,255,0.035)",
            }}
            aria-live="off"
          >
            <Flag
              size={11}
              className="flex-none"
              style={{
                color: latest && URGENT_EVENT_KINDS.has(latest.kind) ? "#FF6B6B" : "var(--color-primary)",
              }}
            />
            {latest ? (
              <>
                <span className="font-bold text-[11px] tabular-nums text-warm-500 flex-none">
                  L{latest.lap}
                </span>
                <span
                  className="font-extrabold text-[11px] flex-none"
                  style={{
                    color: URGENT_EVENT_KINDS.has(latest.kind) ? "#FF6B6B" : "var(--color-primary)",
                  }}
                >
                  {eventLabel(latest.kind)}
                </span>
                <span className="font-medium text-[11px] text-warm-400 truncate min-w-0">
                  {latest.drivers.length > 0 ? `${latest.drivers.join(", ")} · ` : ""}
                  {latest.message}
                </span>
              </>
            ) : (
              <span className="font-semibold text-[11px] text-warm-600">
                Nothing reported yet this race.
              </span>
            )}
          </div>
        )}
      </div>

      {/* ----------------------------- controls ----------------------------- */}
      {/* `flex-wrap` is right on a tall screen and catastrophic on a short one.
          Measured at 844×390 (landscape phone) before this rule existed: the bar
          wrapped to **294px** of a 390px viewport, which squeezed the tower —
          the entire point of the mode — down to **12px** and pushed the bar's
          own bottom to 407px, past the root's `overflow-hidden`. The pinner
          popover rendering off-screen was a symptom of that, not its own bug.

          So below 520px of height the bar stops wrapping and scrolls sideways
          instead. A control that needs a swipe to reach is a far smaller cost
          than a timing tower with no room to exist. `min-w-0` lets the row
          actually shrink, and the tower keeps the height it needs. */}
      <footer
        className={`flex-none flex items-center gap-2 md:gap-3 px-4 md:px-6 py-2.5 flex-wrap [@media(max-height:520px)]:flex-nowrap [@media(max-height:520px)]:overflow-x-auto [@media(max-height:520px)]:min-w-0 [@media(max-height:520px)]:py-1.5 [@media(max-height:520px)]:gap-1.5 border-t border-white/[0.07] ${
          compact ? "[@media(max-height:520px)]:py-1" : ""
        }`}
      >
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play at race pace"}
          className="flex items-center justify-center w-11 h-11 [@media(max-height:520px)]:w-9 [@media(max-height:520px)]:h-9 rounded-xl text-[#1a1210] transition-transform duration-150 ease-out active:scale-[0.97] flex-none"
          style={{ background: "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))" }}
        >
          {playing ? <Pause size={19} /> : <Play size={19} />}
        </button>

        <button
          type="button"
          onClick={restart}
          aria-label="Back to lap 1"
          className="flex items-center justify-center w-11 h-11 [@media(max-height:520px)]:w-9 [@media(max-height:520px)]:h-9 rounded-xl apex-glass-soft text-warm-300 hover:text-primary transition-[color,transform] duration-150 active:scale-[0.97] flex-none"
        >
          <RotateCcw size={17} />
        </button>

        {/* Catch-up. Typed rather than scrubbed, because the number the viewer
            has is the one on their TV. */}
        <form
          className="flex items-center gap-2 flex-none"
          onSubmit={(event) => {
            event.preventDefault();
            // The empty field is the dangerous input, not a malformed one, and
            // it is the *normal* state: this handler clears `jumpValue` after
            // every jump, so a second Enter always submits nothing. `Number("")`
            // is `0` — finite, so the old guard let it through — and lap 0
            // clamps to index 0, silently restarting the race. That is the same
            // destructive action as the labelled "Back to lap 1" button,
            // reachable by an accidental double Enter, with no undo. A blank or
            // sub-1 lap is not a jump; it is a no-op.
            const raw = jumpValue.trim();
            if (raw === "") return;
            const target = Math.round(Number(raw));
            if (!Number.isFinite(target) || target < 1) return;
            const found = laps.findIndex((lap) => lap.lap === target);
            jumpTo(found >= 0 ? found : target - 1);
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
            /* Focus ring is an `outline`, deliberately, not Tailwind's `ring`.
               `ring-*` compiles to `box-shadow`, and `.apex-glass-soft`
               declares `box-shadow` while sitting *unlayered* in globals.css —
               unlayered rules beat `@layer utilities` no matter the
               specificity, so the ring was silently swallowed and this input
               (the one control here that also sets `outline-none`) had **no
               focus indicator at all** for keyboard users. `outline` is not a
               property any `apex-glass-*` class declares, so it survives.
               See the layering note in globals.css. */
            className="w-[74px] h-11 [@media(max-height:520px)]:h-9 rounded-xl apex-glass-soft px-3 font-bold text-sm tabular-nums text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
          />
          <button
            type="submit"
            className="h-11 [@media(max-height:520px)]:h-9 px-4 rounded-xl apex-glass-soft font-bold text-xs hover:border-flame-bright/50 transition-[border-color,transform] duration-150 active:scale-95"
          >
            Go
          </button>
        </form>

        {/* Copy carries the honest bits rather than a tooltip: what this clock
            is, and what it does when a lap has no recorded time. */}
        {/* Compact drops this prose on short screens — three wrapped lines of
            it is ~40px of footer, which is a whole tower row per column. The
            claims it carries are not lost: the header still says "replay, not
            live" and the current lap still wears its own "estimated" badge. */}
        {/* Split in two, because only half of it is disposable.
            The descriptive sentence goes at every density on a short screen,
            not just compact. Measured at 844x390 with the default (expanded)
            density: this paragraph occupied 220px and four wrapped lines of a
            931px control strip in an 844px viewport, which pushed the
            keep-awake and fullscreen buttons off the right edge entirely.
            Without it the strip comes to ~711px and fits. What it says is
            still said elsewhere — the header states "replay, not live" at
            every density, and the running lap wears its own "estimated" badge.

            The caveats below are NOT dropped with it. "This round has no
            recorded lap times at all, so the pacing is not real" is a claim
            about the honesty of what is on screen and is carried nowhere else;
            hiding it to save space would be trading a layout problem for a
            truthfulness one. They are also conditional, so on the ordinary
            round they cost nothing. */}
        <p className="font-medium text-[10px] md:text-[11px] text-warm-500 leading-snug flex-1 min-w-[220px] [@media(max-height:520px)]:hidden">
          Every lap runs for as long as it really did — safety-car laps take
          longer than green ones. Catching up jumps straight to the lap; nothing
          fast-forwards.
        </p>
        <p className="font-medium text-[10px] md:text-[11px] text-warm-500 leading-snug min-w-0 empty:hidden">
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

        {/* Pinning. A per-row star would be the obvious control and is the
            wrong one here: at compact density on a landscape phone a row is
            ~25px tall, so its star would be a ~12px touch target on the device
            this mode is built for. One list, full-size targets, and the rows
            stay pure readout. */}
        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => setPinnerOpen((open) => !open)}
            aria-expanded={pinnerOpen}
            aria-label={
              pinned.size > 0
                ? `Pinned drivers (${pinned.size}). Change`
                : "Pin drivers to the top of the tower"
            }
            className="flex items-center gap-1.5 h-11 [@media(max-height:520px)]:h-9 px-3 rounded-xl apex-glass-soft font-bold text-xs transition-[color,border-color,transform] duration-150 active:scale-[0.97]"
            style={{ color: pinned.size > 0 ? "var(--color-primary)" : undefined }}
          >
            <Pin size={15} />
            {pinned.size > 0 && <span className="tabular-nums">{pinned.size}</span>}
          </button>

          {pinnerOpen && createPortal(
            <>
              {/* Portalled to `document.body`, following the same pattern as
                  `pitwall-assistant-panel.tsx`. Rendered in place it was
                  measured off the right edge (right 950 in an 844 viewport)
                  and it sits inside a footer that becomes `overflow-x-auto` on
                  a short screen — a clipping context that would eventually cut
                  it off or scroll it away from its own button. Two rounds of
                  Tailwind anchor classes failed to place it reliably, so the
                  position is an inline style: a popover that can be pushed
                  off-screen by an unrelated layout change is not worth the
                  tidier class list.

                  A click anywhere else closes it — cheaper and more reliable on
                  touch than a document listener that has to not fire on the
                  opening tap. */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setPinnerOpen(false)}
                aria-hidden
              />
              <div
                /* Fixed to the viewport, not absolute to the button. Two
                   reasons, both measured rather than anticipated: anchored
                   left-0 it ran off the right edge once the footer became
                   horizontally scrollable (right edge 974 in an 844 viewport),
                   and an `overflow-x-auto` ancestor is a clipping context, so
                   a popover living inside the scroller is one layout change
                   away from being cut off or scrolling away from its own
                   button. Clamped to the viewport it cannot do either, at any
                   size, and it no longer depends on where the button drifted
                   to. `bottom` clears the controls bar; `max-h` leaves room
                   above so it never reaches the header. */
                className="z-50 apex-glass-strong rounded-2xl p-3 overflow-y-auto"
                style={{
                  // `position` is inline and NOT the `fixed` utility, which
                  // loses here: `.apex-glass-strong` declares `position:
                  // relative`, so the class was present and doing nothing.
                  //
                  // The cause is NOT specificity, which is what this comment
                  // originally claimed. `.apex-glass-*` is declared unlayered
                  // while Tailwind emits utilities in `@layer utilities`, and
                  // unlayered always beats layered — see the full note above
                  // the glass definitions in globals.css. The wrong diagnosis
                  // is why the same bug then reappeared on the jump-to-lap
                  // input's focus ring.
                  position: "fixed",
                  right: "0.75rem",
                  bottom: "max(4.25rem, env(safe-area-inset-bottom, 0px) + 4.25rem)",
                  width: "min(calc(100vw - 1.5rem), 420px)",
                  maxHeight: "min(52vh, calc(100dvh - 8rem))",
                }}
                role="group"
                aria-label="Pin drivers"
              >
                <div className="flex items-center gap-2 mb-2">
                  <p className="font-bold text-[10px] tracking-[0.14em] uppercase text-warm-500">
                    Pin to the top
                  </p>
                  {pinned.size > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setPinnedPreference([]);
                      }}
                      className="ml-auto font-bold text-[10px] tracking-[0.1em] uppercase text-warm-400 hover:text-primary transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
                  {pinnableDrivers.map((driver) => {
                    const isPinned = pinned.has(driver.number);
                    const color = getTeamColor(driver.team ?? undefined);
                    return (
                      <button
                        key={driver.number}
                        type="button"
                        onClick={() => togglePinned(driver.number)}
                        aria-pressed={isPinned}
                        title={driver.name}
                        className="flex items-center gap-1.5 h-10 px-2 rounded-lg font-extrabold text-xs transition-[background-color,transform] duration-150 active:scale-95"
                        style={{
                          background: isPinned
                            ? "rgb(var(--rgb-flame-bright) / 0.18)"
                            : "rgba(255,255,255,0.04)",
                          color: isPinned ? "var(--color-primary)" : "#c9c0b4",
                        }}
                      >
                        <span
                          className="w-[3px] h-[1.3em] rounded-hairline flex-none"
                          style={{ background: color.hex }}
                        />
                        {driver.code}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>,
            document.body
          )}
        </div>

        {/* Interval vs gap-to-leader. Only offered when there is a per-second
            track behind it: on a round without one the tower shows the same
            per-lap gap-to-leader it always did, and a toggle that silently does
            nothing is worse than no toggle. */}
        {perSecond && (
          <div
            className="flex-none flex items-center gap-1 p-1 rounded-xl apex-glass-soft"
            role="group"
            aria-label="Timing mode"
          >
            {(
              [
                ["interval", "Interval", "INT"],
                ["gap", "Gap to leader", "GAP"],
              ] as const
            ).map(([value, label, short]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setTimingModePreference(value);
                  // Passed explicitly: `timingMode` is read through
                  // `useSyncExternalStore` and still holds the old value in this
                  // tick, so publishing without the override would send the
                  // previous mode and land the other screen one press behind.
                  publishParty({ timing_mode: value });
                }}
                aria-pressed={timingMode === value}
                aria-label={label}
                title={
                  value === "interval"
                    ? "Gap to the car ahead — the number that moves when someone is closing"
                    : "Gap to the race leader"
                }
                className="flex items-center justify-center h-9 [@media(max-height:520px)]:h-9 px-2.5 rounded-control font-bold text-[11px] tracking-[0.08em] transition-colors duration-150"
                style={{
                  background:
                    timingMode === value ? "rgb(var(--rgb-primary-container) / 0.20)" : "transparent",
                  color: timingMode === value ? "var(--color-primary)" : "var(--color-warm-400)",
                }}
              >
                {short}
              </button>
            ))}
          </div>
        )}

        {/* Density. Two named states rather than a slider: the choice is
            "everything, comfortably" or "the whole field, as big as it will
            go", and there is nothing useful in between. */}
        <div
          className="flex-none flex items-center gap-1 p-1 rounded-xl apex-glass-soft"
          role="group"
          aria-label="Tower density"
        >
          {(
            [
              ["expanded", "Expanded", Rows2],
              ["compact", "Compact", Rows3],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setDensityPreference(value)}
              aria-pressed={density === value}
              aria-label={label}
              title={
                value === "compact"
                  ? "Whole field as large as it will go: no names, race control on one line, two columns when there is width for them"
                  : "Names, and race control in full"
              }
              className="flex items-center justify-center w-9 h-9 rounded-control transition-colors duration-150"
              style={{
                background: density === value ? "rgb(var(--rgb-primary-container) / 0.20)" : "transparent",
                color: density === value ? "var(--color-primary)" : "var(--color-warm-400)",
              }}
            >
              <Icon size={16} />
            </button>
          ))}
        </div>

        {/* ------------------------------ pairing ------------------------------ */}
        {/* The second screen proper. Sits beside the other mode controls rather
            than in the header because it is a control, not a status: the header
            is where this view states what it is, and it must keep saying
            "replay, not live" at every density. */}
        <div className="relative flex-none">
          <button
            type="button"
            onClick={() => setPartyOpen((open) => !open)}
            aria-expanded={partyOpen}
            aria-label={
              // Three states, not two. A host that has minted a code but has
              // nobody with it yet is `paired` (a session exists) while
              // `devices` is still 1, and the old two-branch label announced
              // that as "Paired with 1 screens" — wrong on the fact and wrong
              // on the grammar. Waiting is its own state and says so.
              !party.paired
                ? "Pair a second screen"
                : party.devices > 1
                  ? `Paired with ${party.devices} screens. Manage pairing`
                  : "Waiting for a second screen to pair. Manage pairing"
            }
            title={
              !party.paired
                ? "Show a code so a phone or another screen can follow this replay in step"
                : party.devices > 1
                  ? `${party.devices} screens are following this replay together`
                  : "Waiting for another screen to scan the code"
            }
            className="flex items-center gap-1.5 h-11 [@media(max-height:520px)]:h-9 px-3 rounded-xl apex-glass-soft font-bold text-xs transition-[color,border-color,transform] duration-150 active:scale-[0.97]"
            style={{ color: party.paired ? "var(--color-primary)" : undefined }}
          >
            <Smartphone size={15} />
            {/* The count, only once it counts something. A lone "1" beside a
                phone icon reads as "one phone is paired" when in fact nobody
                has joined yet; the orange tint already says a session is live. */}
            {party.devices > 1 && (
              <span className="tabular-nums">{party.devices}</span>
            )}
          </button>

          {partyOpen &&
            createPortal(
              <>
                {/* Same portal-and-backdrop treatment as the pinner, and for the
                    same measured reasons: the footer becomes `overflow-x-auto`
                    on a short screen, which is a clipping context, and a
                    popover living inside it is one layout change away from
                    being cut off or scrolling away from its own button. */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setPartyOpen(false)}
                  aria-hidden
                />
                <div
                  className="z-50 apex-glass-strong rounded-2xl p-4 overflow-y-auto"
                  style={{
                    // Inline `position`, not the `fixed` utility — see the
                    // layering note above the glass definitions in globals.css.
                    // `.apex-glass-strong` is unlayered and declares
                    // `position: relative`, so it beats a Tailwind utility
                    // regardless of specificity.
                    position: "fixed",
                    right: "0.75rem",
                    bottom: "max(4.25rem, env(safe-area-inset-bottom, 0px) + 4.25rem)",
                    width: "min(calc(100vw - 1.5rem), 400px)",
                    maxHeight: "min(70vh, calc(100dvh - 7rem))",
                    // Near-opaque, overriding `.apex-glass-strong`'s 0.62. The
                    // popover sits directly over the timing tower, and at 0.62
                    // twenty rows of moving numbers show through the panel that
                    // is meant to be read carefully — a pairing code is
                    // transcribed digit by digit, and a QR is a contrast target
                    // a camera has to lock onto. Inline because the glass
                    // classes are unlayered and beat any utility; see the note
                    // above the glass definitions in globals.css.
                    background: "linear-gradient(180deg,#241a13 0%,#191210 100%)",
                  }}
                  role="group"
                  aria-label="Second screen pairing"
                >
                  <div className="flex items-center gap-2">
                    <p className="font-bold text-[10px] tracking-[0.14em] uppercase text-warm-500">
                      Second screen
                    </p>
                    <button
                      type="button"
                      onClick={() => setPartyOpen(false)}
                      aria-label="Close"
                      className="ml-auto text-warm-400 hover:text-on-background transition-colors"
                    >
                      <X size={15} />
                    </button>
                  </div>

                  {/* What this actually does, in one line. Without it the code
                      is just a number on a screen — and the mode it enables is
                      not one people have seen before. */}
                  <p className="font-medium text-[11px] text-warm-400 mt-2 leading-relaxed">
                    Put a phone and this screen on the same replay. Either one can
                    play, pause or jump to a lap, and the other follows within a
                    second or so. Nothing is streamed — both devices already have
                    the race and run the same clock over it.
                  </p>

                  {party.error && (
                    <p
                      role="alert"
                      className="font-semibold text-[11px] mt-3 rounded-lg px-3 py-2"
                      style={{
                        background: "rgba(255,68,68,0.12)",
                        color: "#FF9B8F",
                      }}
                    >
                      {party.error.message}
                      {party.error.kind === "rate_limited" &&
                        party.error.retryAfter > 0 &&
                        ` Try again in ${party.error.retryAfter}s.`}
                    </p>
                  )}

                  {!party.paired ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          // The HOST offering a code, not a scan. A code shown
                          // and never scanned is exactly the finding this event
                          // exists to surface, so it has to be counted here.
                          track("watch_pair_qr");
                          void party.host();
                        }}
                        disabled={party.busy}
                        className="w-full h-11 mt-3 rounded-xl font-bold text-sm text-[#1a1210] transition-transform duration-150 active:scale-[0.98] disabled:opacity-60"
                        style={{ background: "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))" }}
                      >
                        {party.busy ? "Starting…" : "Show a pairing code"}
                      </button>

                      <div className="flex items-center gap-3 my-3">
                        <span className="h-px flex-1 bg-white/10" />
                        <span className="font-bold text-[9px] tracking-[0.14em] uppercase text-warm-600">
                          or
                        </span>
                        <span className="h-px flex-1 bg-white/10" />
                      </div>

                      <form
                        className="flex items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const entered = joinCode.trim();
                          if (!entered) return;
                          void party.join(entered).then((view) => {
                            if (!view) return;
                            setJoinCode("");
                            // A code typed from the wrong race page is an
                            // ordinary mistake, not an error: the party knows
                            // which round it is watching, so follow it there
                            // rather than refusing. The session id is already
                            // stored against the party's race, so it survives
                            // the navigation.
                            if (view.race_id && view.race_id !== raceId) {
                              router.push(`/watch/${view.race_id}`);
                            }
                          });
                        }}
                      >
                        <label htmlFor="watch-join-code" className="sr-only">
                          Pairing code from the other screen
                        </label>
                        <input
                          id="watch-join-code"
                          value={joinCode}
                          onChange={(event) => setJoinCode(event.target.value)}
                          placeholder="ABCD 2345"
                          maxLength={12}
                          autoComplete="off"
                          autoCapitalize="characters"
                          spellCheck={false}
                          /* `outline`, not Tailwind's `ring` — `ring-*` compiles
                             to `box-shadow`, which `.apex-glass-soft` also
                             declares while sitting unlayered, so a ring here
                             would be silently swallowed and this input would
                             have no focus indicator at all. Same trap as the
                             jump-to-lap field. */
                          className="flex-1 min-w-0 h-11 rounded-xl apex-glass-soft px-3 font-bold text-sm tracking-[0.16em] uppercase text-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
                        />
                        <button
                          type="submit"
                          disabled={party.busy || joinCode.trim().length === 0}
                          className="h-11 px-4 rounded-xl apex-glass-soft font-bold text-xs hover:border-flame-bright/50 transition-[border-color,transform] duration-150 active:scale-95 disabled:opacity-50"
                        >
                          Join
                        </button>
                      </form>
                    </>
                  ) : (
                    <>
                      {party.devices > 1 && (
                        // The persistent half of the confirmation. The toast
                        // above is transient by design; this is what the panel
                        // says when you open it ten minutes later to check.
                        <div
                          className="mt-3 flex items-center gap-2.5 rounded-xl px-3 py-2.5"
                          style={{
                            background: "rgb(var(--rgb-flame-bright) / 0.14)",
                            border: "1px solid rgb(var(--rgb-flame-bright) / 0.34)",
                          }}
                        >
                          <span
                            className="flex items-center justify-center w-6 h-6 rounded-full flex-none"
                            style={{
                              background: "linear-gradient(140deg,var(--color-primary),var(--color-primary-container))",
                              color: "#1a1210",
                            }}
                          >
                            <Check size={14} strokeWidth={3} />
                          </span>
                          <p className="font-bold text-[12px] text-primary">
                            Paired ·{" "}
                            <span className="tabular-nums">{party.devices}</span> screens
                            in step
                          </p>
                        </div>
                      )}

                      {party.code ? (
                        <div
                          className="mt-3 rounded-2xl px-4 py-4 text-center"
                          style={{
                            // Solid, not glass. The QR is the one element on
                            // this page a camera has to resolve, and a
                            // translucent surround puts a moving timing tower
                            // inside the frame the scanner is metering against.
                            // The plate is also the visual cue that the code is
                            // an object to point something at rather than
                            // another panel to read.
                            background: "#120d0a",
                            border: "1px solid rgb(var(--rgb-flame-bright) / 0.28)",
                            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)",
                          }}
                        >
                          {pairUrl && (
                            <div className="flex flex-col items-center gap-2 mb-3.5">
                              <PairQr value={pairUrl} />
                              <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-400">
                                Scan with a phone camera
                              </p>
                            </div>
                          )}
                          <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-400">
                            {pairUrl ? "or type this" : "Type this on the other screen"}
                          </p>
                          <p className="font-[family-name:var(--font-headline)] font-extrabold text-3xl tracking-[0.12em] mt-1.5 text-primary tabular-nums">
                            {groupCode(party.code)}
                          </p>
                          <p className="font-medium text-[10px] text-warm-500 mt-1.5">
                            {/* Both facts, because both surprise people: it dies
                                on first use, and it dies on a timer. */}
                            Works once
                            {codeSecondsLeft !== null &&
                              `, and for another ${Math.floor(codeSecondsLeft / 60)}:${String(
                                codeSecondsLeft % 60
                              ).padStart(2, "0")}`}
                          </p>
                        </div>
                      ) : (
                        <div
                          className="mt-3 rounded-2xl px-4 py-4"
                          style={{
                            background: "#120d0a",
                            border: "1px solid rgba(255,255,255,0.08)",
                          }}
                        >
                          <p className="font-medium text-[11px] text-warm-400 leading-relaxed">
                            {/* The device count is stated by the success block
                                above; repeating it here read as two different
                                facts. This box has one job now: say why there
                                is no code to look at.

                                Worded for both sides of a pairing. A device
                                that *joined* is never told the code it burned,
                                so it lands here too — and telling it "the code
                                has been used" describes something it never
                                saw. Either device can mint a new one. */}
                            No code is showing — a code works exactly once. Mint a
                            fresh one to add another screen, or to recover one
                            that reloaded.
                          </p>
                        </div>
                      )}

                      <div className="flex items-center gap-2 mt-3">
                        <button
                          type="button"
                          onClick={() => void party.refreshCode()}
                          disabled={party.busy}
                          className="flex-1 flex items-center justify-center gap-1.5 h-11 rounded-xl apex-glass-soft font-bold text-xs hover:border-flame-bright/50 transition-[border-color,transform] duration-150 active:scale-95 disabled:opacity-50"
                        >
                          <RefreshCw size={14} />
                          New code
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void party.leave();
                            setPartyOpen(false);
                          }}
                          className="flex-1 h-11 rounded-xl apex-glass-soft font-bold text-xs text-warm-300 hover:text-[#FF9B8F] hover:border-[rgba(255,107,107,0.5)] transition-[color,border-color,transform] duration-150 active:scale-95"
                        >
                          Unpair
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </>,
              document.body
            )}
        </div>

        {/* Only offered when there is radio to switch off. A dead toggle on a
            session F1 published nothing for would read as "the feature is
            broken" rather than "there is nothing to show". */}
        {radioClips.length > 0 && (
          <button
            type="button"
            onClick={() => setRadioCaptionsPreference(!radioCaptions)}
            aria-pressed={radioCaptions}
            title={
              radioCaptions
                ? `Team radio captions on — ${radioClips.length} in this race`
                : "Team radio captions off"
            }
            className="flex items-center justify-center w-11 h-11 [@media(max-height:520px)]:w-9 [@media(max-height:520px)]:h-9 rounded-xl apex-glass-soft transition-[color,transform] duration-150 active:scale-[0.97] flex-none"
            style={{ color: radioCaptions ? "var(--color-primary)" : "var(--color-warm-400)" }}
          >
            {radioCaptions ? <Radio size={17} /> : <RadioOff size={17} />}
          </button>
        )}

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
          style={{ color: keepAwake && wakeLockHeld ? "var(--color-primary)" : "var(--color-warm-400)" }}
        >
          {keepAwake && wakeLockHeld ? <Lightbulb size={17} /> : <LightbulbOff size={17} />}
        </button>

        <button
          type="button"
          onClick={() => void toggleFullscreen()}
          aria-label={fullscreen ? "Leave fullscreen" : "Go fullscreen"}
          className="flex items-center justify-center w-11 h-11 [@media(max-height:520px)]:w-9 [@media(max-height:520px)]:h-9 rounded-xl apex-glass-soft text-warm-300 hover:text-primary transition-[color,transform] duration-150 active:scale-[0.97] flex-none"
        >
          {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
      </footer>
    </div>
  );
}
