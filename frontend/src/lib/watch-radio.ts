/**
 * The radio popup's scheduler: which clip, if any, should be on screen right now.
 *
 * Deliberately free of React and of the DOM, for the same reason `watch-clock`
 * is: the rules below are the difference between a broadcast-feeling caption and
 * an irritating one, and every one of them is a behaviour you would otherwise
 * have to verify by watching a screen for two hours.
 *
 * The whole module runs off one number — `raceMs`, elapsed race milliseconds —
 * which `watch-view` already computes on every frame
 * (`(cumulative[index] ?? 0) + elapsedMs`). A clip's `t_ms` is the same
 * quantity, measured against the same lights-out instant by `race_timing`, so
 * placing one against the other needs no conversion and no second source of
 * truth about when the race started.
 */

import type { RadioClip } from "./api";

/** Shortest a caption may sit. Below this it reads as a flicker, not a message. */
export const MIN_DWELL_MS = 4500;
/** Longest. Past this it is camping on the timing tower rather than informing. */
export const MAX_DWELL_MS = 9000;
/** Reading budget per word. ~170 wpm, the low end of comfortable silent reading,
 *  because the reader is watching a race rather than reading a page. */
const MS_PER_WORD = 350;

/**
 * How far past a clip's instant the playhead may be and still fire it.
 *
 * The clock is sampled per animation frame, so exact equality never happens;
 * some window is required. Two seconds is wide enough to survive a stutter or a
 * backgrounded tab's throttled frames, and narrow enough that it cannot be
 * confused with a deliberate jump.
 */
export const FIRE_WINDOW_MS = 2000;

/**
 * How long a queued clip waits for the screen before it is abandoned.
 *
 * Radio arrives in bursts — three clips inside two minutes reliably means
 * something is happening — and showing the third one ninety seconds after the
 * moment it belonged to is worse than not showing it. The scrub-bar marker
 * keeps it reachable either way, which is what makes dropping it acceptable:
 * nothing is silently lost, only deferred to a deliberate click.
 */
export const MAX_QUEUE_WAIT_MS = 15000;

export interface RadioCue {
  clip: RadioClip;
  /** When it went on screen, in `raceMs` — not wall-clock, so a pause pauses it. */
  shownAtMs: number;
  dwellMs: number;
}

export interface RadioSchedulerState {
  /** Ids already fired, so a clip cannot repeat when the clock jitters. */
  fired: Set<string>;
  queue: RadioClip[];
  /** `raceMs` at which each queued clip was enqueued, keyed by id. */
  queuedAtMs: Map<string, number>;
  current: RadioCue | null;
  /** Previous reading, to detect direction and jumps. */
  lastMs: number | null;
}

export function createRadioState(): RadioSchedulerState {
  return {
    fired: new Set(),
    queue: [],
    queuedAtMs: new Map(),
    current: null,
    lastMs: null,
  };
}

/**
 * Clips that can ever be scheduled: placed, inside the race, and with something
 * to say.
 *
 * A clip with no utterances is dropped **here** rather than rendered as an empty
 * box. It is still real — it is playable, and the Pitwall module lists it — but a
 * caption with no caption is not a caption, and an untranscribed session must
 * degrade to silence rather than to a run of blank rectangles.
 */
export function schedulableClips(clips: RadioClip[] | null | undefined): RadioClip[] {
  return (clips ?? [])
    .filter(
      (clip) =>
        typeof clip.t_ms === "number" &&
        clip.t_ms >= 0 &&
        clip.utterances.length > 0
    )
    .sort((a, b) => (a.t_ms as number) - (b.t_ms as number));
}

/** How long this clip's caption needs, clamped to the readable band. */
export function dwellFor(clip: RadioClip): number {
  const words = clip.utterances.reduce(
    (total, utterance) => total + utterance.text.trim().split(/\s+/).filter(Boolean).length,
    0
  );
  return Math.min(MAX_DWELL_MS, Math.max(MIN_DWELL_MS, words * MS_PER_WORD));
}

export interface AdvanceOptions {
  /** False while paused or scrubbing: nothing fires, nothing expires. */
  playing: boolean;
  /** False when the viewer has turned captions off. */
  enabled: boolean;
}

/**
 * Advance the scheduler to `raceMs` and return the cue that should be on screen.
 *
 * Mutates `state` deliberately — it is called once per animation frame from a
 * ref, where allocating a new state object sixty times a second would be the
 * expensive part of the feature.
 *
 * The rules, and why each exists:
 *
 * * **Forward crossing only.** A clip fires when the playhead passes its instant
 *   moving forward, within `FIRE_WINDOW_MS`. Anything further back was jumped
 *   over, and a viewer who scrubbed to lap 40 did not ask for the forty laps of
 *   radio they skipped. They are marked fired without being shown.
 * * **Nothing while paused.** A caption that appears on a stopped clock is not
 *   describing anything happening.
 * * **A backward jump forgets.** Scrubbing back re-arms every clip after the new
 *   position, because rewatching a moment should replay that moment.
 * * **One box at a time.** A second clip queues rather than stacking; two boxes
 *   fighting over one corner is worse than seeing one of them late.
 * * **Never the future.** Only clips at or behind the playhead are considered,
 *   which is the same rule the race-control feed already enforces — a paired
 *   second screen must not spoil the race it is following.
 */
export function advanceRadio(
  state: RadioSchedulerState,
  clips: RadioClip[],
  raceMs: number,
  { playing, enabled }: AdvanceOptions
): RadioCue | null {
  const previous = state.lastMs;
  state.lastMs = raceMs;

  if (!enabled) {
    state.current = null;
    state.queue = [];
    state.queuedAtMs.clear();
    return null;
  }

  // A jump backwards re-arms everything after the new position. Without this,
  // rewinding to watch a moment again replays the tower and the timing but not
  // the radio that made the moment worth rewinding to.
  if (previous !== null && raceMs < previous - FIRE_WINDOW_MS) {
    for (const clip of clips) {
      if ((clip.t_ms as number) >= raceMs) state.fired.delete(clip.id);
    }
    state.queue = state.queue.filter((clip) => (clip.t_ms as number) < raceMs);
    state.current = null;
  }

  if (!playing) return state.current;

  for (const clip of clips) {
    const at = clip.t_ms as number;
    if (at > raceMs) break; // sorted — everything after this is in the future
    if (state.fired.has(clip.id)) continue;

    state.fired.add(clip.id);
    // Behind the window means the playhead arrived here by a jump, not by
    // playing. Marked fired above so it does not ambush the viewer later.
    if (raceMs - at <= FIRE_WINDOW_MS) {
      state.queue.push(clip);
      state.queuedAtMs.set(clip.id, raceMs);
    }
  }

  // Abandon anything that waited too long for the screen.
  state.queue = state.queue.filter((clip) => {
    const queuedAt = state.queuedAtMs.get(clip.id);
    if (queuedAt === undefined) return true;
    if (raceMs - queuedAt <= MAX_QUEUE_WAIT_MS) return true;
    state.queuedAtMs.delete(clip.id);
    return false;
  });

  if (state.current && raceMs - state.current.shownAtMs >= state.current.dwellMs) {
    state.current = null;
  }

  if (!state.current && state.queue.length > 0) {
    const next = state.queue.shift() as RadioClip;
    state.queuedAtMs.delete(next.id);
    state.current = { clip: next, shownAtMs: raceMs, dwellMs: dwellFor(next) };
  }

  return state.current;
}

/**
 * The lines a popup shows, capped so a long clip cannot grow an unbounded box.
 *
 * The cap is not hypothetical: the longest clip measured in a 2026 race is 192
 * seconds — a channel left open — against a 9-second median. Truncating with an
 * explicit marker is honest; letting one clip render forty lines over the timing
 * tower is not.
 */
export const MAX_POPUP_LINES = 3;

export function popupLines(clip: RadioClip): {
  lines: RadioClip["utterances"];
  truncated: number;
} {
  const lines = clip.utterances.slice(0, MAX_POPUP_LINES);
  return { lines, truncated: Math.max(0, clip.utterances.length - lines.length) };
}

/** `9.2` -> `0:09`. Null duration renders as an em dash rather than `0:00`. */
export function formatClipDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
