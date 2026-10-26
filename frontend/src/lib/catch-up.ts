/**
 * "Catch me up": which rounds a returning visitor has missed.
 *
 * Pure logic, no React and no DOM. Storage is passed in (the same pattern as
 * `analytics.ts`), so the rules that decide whether the card appears can be
 * driven by a test without jsdom. `components/catch-up-card.tsx` does the
 * rendering and the fetching.
 *
 * The rules, and why each one is shaped the way it is:
 *
 * - **First-time visitors never see the card.** There is no "since your last
 *   visit" without a last visit. Their visit is recorded, and that is all.
 * - **The card appears only once a race or sprint has finished since the last
 *   visit.** "Finished" is the session's scheduled start plus its nominal
 *   length from `lib/sessions.ts`, so a race running right now is not counted:
 *   it would be reported with no result. If the result has not reached the
 *   backend yet, the server returns no rounds and the card stays hidden.
 * - **Everything is compared as epoch milliseconds.** Session times arrive as
 *   UTC (`date` + `time` ending in `Z`) and `lastSeenAt` is stored as a number,
 *   so no comparison here ever touches the visitor's timezone. A Las Vegas
 *   race that is Saturday night locally and Sunday morning in UTC is the same
 *   instant on both sides.
 * - **`afterRound` is the last Grand Prix that had finished at the last
 *   visit.** It is what the server takes, so its cache key
 *   `(season, after_round, latest_round)` is the same for every visitor who
 *   missed the same span. A sprint the visitor did see, on a weekend whose
 *   Grand Prix they missed, is listed in `seenSprintRoundKeys` so the card can
 *   leave it out.
 * - **A last visit in an earlier season is capped at this one.** Only the
 *   current season's schedule is to hand, so the card covers this season from
 *   its first round and says so (`fromPreviousSeason`).
 */

import type { Race } from "./api";
import { buildSeasonSessionTimeline } from "./sessions";

/** Namespaced to match `apex.consent.*` and `apex.watch.*`. Bump the suffix
 * if the stored shape ever changes incompatibly. */
export const CATCH_UP_STORAGE_KEY = "apex.catchUp.v1";

/** Visible, on screen, with the page in the foreground, for this long before
 * the card counts as read without a "Got it". Long enough to read the facts;
 * a tab opened and closed in a second never gets there. */
export const CATCH_UP_READ_MS = 8000;

export interface CatchUpState {
  /** Epoch ms of the visit (or the moment the card was marked read). */
  lastSeenAt: number;
  /** `${season}-${round}` of the last Grand Prix finished at that moment. */
  lastSeenRoundKey: string | null;
}

/** Only the two methods used here, so a plain object satisfies it. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function roundKey(season: number | string, round: number | string): string {
  return `${season}-${round}`;
}

/** `"2026-17"` -> `{ season: 2026, round: 17 }`, or null for anything else. */
export function parseRoundKey(key: string | null | undefined): { season: number; round: number } | null {
  const match = /^(\d{4})-(\d{1,2})$/.exec(key ?? "");
  return match ? { season: Number(match[1]), round: Number(match[2]) } : null;
}

export function parseCatchUpState(raw: string | null): CatchUpState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CatchUpState> | null;
    const lastSeenAt = value?.lastSeenAt;
    if (typeof lastSeenAt !== "number" || !Number.isFinite(lastSeenAt) || lastSeenAt <= 0) {
      return null;
    }
    const key = value?.lastSeenRoundKey;
    return {
      lastSeenAt,
      lastSeenRoundKey: typeof key === "string" && parseRoundKey(key) ? key : null,
    };
  } catch {
    return null;
  }
}

/**
 * The stored state, or null for a first visit. Unreadable storage (a private
 * window, blocked site data) and a corrupt value both read as a first visit:
 * the card then never shows, which is the safe way to be wrong.
 */
export function readCatchUpState(storage: StorageLike | null | undefined): CatchUpState | null {
  try {
    return parseCatchUpState(storage?.getItem(CATCH_UP_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

export function writeCatchUpState(storage: StorageLike | null | undefined, state: CatchUpState): void {
  try {
    storage?.setItem(CATCH_UP_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota or blocked storage: the visit simply is not remembered.
  }
}

interface FinishedSession {
  round: number;
  kind: "Sprint" | "Race";
  endTimeMs: number;
}

/** Every sprint and Grand Prix of `races`, with its nominal finish time. */
function pointsSessions(races: Race[]): FinishedSession[] {
  return buildSeasonSessionTimeline(races)
    .filter((s) => s.sessionField === "Race" || s.sessionField === "Sprint")
    .map((s) => ({
      round: Number(s.round),
      kind: s.sessionField as "Sprint" | "Race",
      endTimeMs: s.endTimeMs,
    }))
    .filter((s) => Number.isFinite(s.round));
}

/** Key of the last Grand Prix that had finished by `atMs`, or null. */
export function latestFinishedRoundKey(season: number, races: Race[], atMs: number): string | null {
  const finished = pointsSessions(races).filter((s) => s.kind === "Race" && s.endTimeMs <= atMs);
  if (finished.length === 0) return null;
  return roundKey(season, Math.max(...finished.map((s) => s.round)));
}

export interface CatchUpPlan {
  season: number;
  /** Last Grand Prix finished at the last visit; 0 if none this season. */
  afterRound: number;
  /** Rounds with a sprint or Grand Prix finished since the last visit. */
  missedRoundKeys: string[];
  /** Rounds whose sprint the visitor had already seen (only its GP is new). */
  seenSprintRoundKeys: string[];
  /** The last visit was in an earlier season; coverage starts at round 1. */
  fromPreviousSeason: boolean;
  lastSeenSeason: number;
  lastSeenAt: number;
  /** The moment this plan was made. Marking it read stores this, not the time
   * of the click, so a race that finishes while the card is open is not
   * swallowed by it. */
  nowMs: number;
  /** For the stored state once the card is read. */
  latestFinishedRoundKey: string | null;
}

/**
 * What the card should cover, or null when it should not appear at all: a
 * first visit, or nothing finished since the last one.
 */
export function planCatchUp(
  season: number,
  races: Race[],
  state: CatchUpState | null,
  nowMs: number
): CatchUpPlan | null {
  if (!state) return null;

  const sessions = pointsSessions(races);
  const newlyFinished = sessions.filter(
    (s) => s.endTimeMs <= nowMs && s.endTimeMs > state.lastSeenAt
  );
  if (newlyFinished.length === 0) return null;

  const seenRaces = sessions.filter((s) => s.kind === "Race" && s.endTimeMs <= state.lastSeenAt);
  const afterRound = seenRaces.length ? Math.max(...seenRaces.map((s) => s.round)) : 0;

  const missedRounds = Array.from(new Set(newlyFinished.map((s) => s.round))).sort((a, b) => a - b);
  const seenSprintRounds = sessions
    .filter(
      (s) =>
        s.kind === "Sprint" &&
        s.endTimeMs <= state.lastSeenAt &&
        s.round > afterRound &&
        missedRounds.includes(s.round)
    )
    .map((s) => s.round);

  const lastSeenSeason =
    parseRoundKey(state.lastSeenRoundKey)?.season ?? new Date(state.lastSeenAt).getUTCFullYear();

  return {
    season,
    afterRound,
    missedRoundKeys: missedRounds.map((r) => roundKey(season, r)),
    seenSprintRoundKeys: seenSprintRounds.map((r) => roundKey(season, r)),
    fromPreviousSeason: lastSeenSeason < season,
    lastSeenSeason,
    lastSeenAt: state.lastSeenAt,
    nowMs,
    latestFinishedRoundKey: latestFinishedRoundKey(season, races, nowMs),
  };
}

/**
 * The state to store when the card is not shown at all.
 *
 * A first visit records itself. A returning visit with nothing new moves
 * `lastSeenAt` forward to now: nothing finished in between, so nothing can be
 * lost by it, and a race finishing later in the day is still after it. A visit
 * that has a plan returns null: only "Got it" or a read (`markCatchUpRead`)
 * may move the marker past results the visitor has not been shown.
 */
export function stateForVisitWithoutCard(
  season: number,
  races: Race[],
  state: CatchUpState | null,
  plan: CatchUpPlan | null,
  nowMs: number
): CatchUpState | null {
  if (plan) return null;
  return {
    lastSeenAt: Math.max(nowMs, state?.lastSeenAt ?? 0),
    lastSeenRoundKey: latestFinishedRoundKey(season, races, nowMs) ?? state?.lastSeenRoundKey ?? null,
  };
}

/** The state to store once the visitor has read, or dismissed, the card. */
export function markCatchUpRead(plan: CatchUpPlan): CatchUpState {
  return { lastSeenAt: plan.nowMs, lastSeenRoundKey: plan.latestFinishedRoundKey };
}

/**
 * Splits the missed rounds into what may be shown and what spoiler-free mode
 * hides. Any hidden round also hides the championship facts and the
 * narrative, because both are computed across every missed round: a title gap
 * that moved by 25 points says who won the round it was meant to hide.
 */
export function applyHiddenRounds<T extends { round_key: string }>(
  rounds: T[],
  hiddenRoundKeys: readonly string[] | undefined
): { visible: T[]; anyHidden: boolean } {
  const hidden = new Set(hiddenRoundKeys ?? []);
  const visible = rounds.filter((r) => !hidden.has(r.round_key));
  return { visible, anyHidden: visible.length !== rounds.length };
}
