import type { Race } from "@/lib/api";
import {
  buildRaceSessionTimeline,
  type SessionTimelineItem,
} from "@/lib/sessions";

/**
 * How long after a weekend's last session the home page still treats it as
 * "this race week". Three days keeps the just-run race on the page through
 * Wednesday and stops well short of the next weekend's FP1 on Friday, so two
 * weekends can never both be current.
 */
export const RACE_WEEK_TAIL_MS = 3 * 24 * 60 * 60 * 1000;

export interface RaceWeek {
  race: Race;
  /** Every session of this weekend, earliest first. */
  sessions: SessionTimelineItem[];
  /** The session running right now, if one is. */
  live: SessionTimelineItem | null;
  /** Sessions that have already ended, MOST RECENT FIRST. */
  finished: SessionTimelineItem[];
}

/**
 * The race weekend the season is currently inside, or null between weekends.
 *
 * A weekend counts as current from the moment its first session starts until
 * `RACE_WEEK_TAIL_MS` after its last one ends. Deliberately keyed on session
 * times rather than the race date: a weekend is live on Friday morning, which
 * a date-only check would miss, and it stays interesting for a couple of days
 * after the flag drops.
 *
 * Windows cannot overlap given the tail above, but if the calendar ever put two
 * weekends close enough that they did, the later-starting one wins — that is
 * the one the viewer is heading into.
 */
export function getRaceWeek(races: Race[], nowMs: number): RaceWeek | null {
  let best: RaceWeek | null = null;
  let bestStart = -Infinity;

  for (const race of races) {
    const sessions = buildRaceSessionTimeline(race);
    if (sessions.length === 0) continue;

    const windowStart = sessions[0].startTimeMs;
    const windowEnd =
      Math.max(...sessions.map((s) => s.endTimeMs)) + RACE_WEEK_TAIL_MS;

    if (nowMs < windowStart || nowMs > windowEnd) continue;
    if (windowStart < bestStart) continue;

    bestStart = windowStart;
    best = {
      race,
      sessions,
      live:
        sessions.find(
          (s) => s.startTimeMs <= nowMs && nowMs < s.endTimeMs
        ) ?? null,
      finished: sessions
        .filter((s) => s.endTimeMs <= nowMs)
        .sort((a, b) => b.endTimeMs - a.endTimeMs),
    };
  }

  return best;
}
