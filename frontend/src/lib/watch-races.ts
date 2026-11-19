/**
 * Route-id plumbing and the "offer a synced race instead" search behind
 * watch-party mode.
 *
 * The route is `/watch/[raceId]` per the design note, but nothing else in this
 * app has a single-token race identifier — every other route addresses a race
 * as `season` + `round`. Rather than invent a new identifier scheme (and a
 * lookup table to resolve it), `raceId` is simply those two joined:
 * `2026-10`. A bare `10` is accepted too and read against the active season,
 * because a hand-typed URL will do that and failing on it would be pedantry.
 */

import { getActiveSeasonYear, getRaceReplay, getSeasonRaces, type Race } from "./api";

export interface ParsedRaceId {
  season: number;
  round: number;
}

export function toRaceId(season: number, round: number | string): string {
  return `${season}-${round}`;
}

export function parseRaceId(raceId: string): ParsedRaceId | null {
  const decoded = decodeURIComponent(raceId ?? "").trim();

  const paired = /^(\d{4})-(\d{1,2})$/.exec(decoded);
  if (paired) {
    return { season: Number(paired[1]), round: Number(paired[2]) };
  }

  const bare = /^(\d{1,2})$/.exec(decoded);
  if (bare) {
    return { season: getActiveSeasonYear(), round: Number(bare[1]) };
  }

  return null;
}

/** A race whose scheduled start is in the past. Watch mode is replay-only, so
 * a round that has not run yet has nothing to replay — that is a different
 * (and non-recoverable) case from one that has run but is not synced. */
export function hasStarted(race: Race, now = new Date()): boolean {
  if (!race.date) return false;
  const time = race.time ?? "12:00:00Z";
  const iso = time.endsWith("Z") ? `${race.date}T${time}` : `${race.date}T${time}Z`;
  const parsed = new Date(iso);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() < now.getTime();
}

/** Completed rounds, most recent first — the order a race picker wants, since
 * the round someone reaches for is almost always the one that just ran. */
export function completedRacesNewestFirst(races: Race[], now = new Date()): Race[] {
  return races
    .filter((race) => hasStarted(race, now))
    .sort((a, b) => Number(b.round) - Number(a.round));
}

/**
 * The calendar with every `winner` removed.
 *
 * The watch index exists to replay a race the reader has not seen, so it must
 * say nothing about how it ended. `/api/races` attaches each round's winner and
 * the list is passed whole to the page, so a winner left on the object would be
 * serialised into the page data even where nothing draws it. Unlike
 * `redactWinners`, this is not conditional on the spoiler preference: nobody
 * opening this page wants the result.
 */
export function withoutWinners<T extends Race>(races: T[]): T[] {
  return races.map((race) => {
    const copy = { ...race };
    delete copy.winner;
    return copy;
  });
}

/**
 * "Sun 8 Nov" for a race's UTC date, or null when it is missing or unreadable.
 *
 * Assembled from parts so no locale's punctuation or abbreviation quirks creep
 * in, and read in UTC so a reader west of Greenwich is not shown the day before.
 */
export function raceDayLabel(date: string | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  // `new Date("2026-02-31")` rolls over to March; a date that does not survive
  // the round trip was never a real one.
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).formatToParts(parsed);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  const weekday = part("weekday");
  const day = part("day");
  const month = part("month");
  return weekday && day && month ? `${weekday} ${day} ${month}` : null;
}

/** How far back to look for something watchable. Each probe pulls a full
 * replay payload (~1MB), so this is deliberately bounded: in practice the
 * immediately preceding round answers on the first try, and a season where six
 * consecutive rounds are unsynced has a sync problem that this page is not the
 * place to paper over. */
const FALLBACK_PROBE_LIMIT = 6;

/**
 * The most recently completed round *before* `beforeRound` that actually has a
 * replay.
 *
 * The likeliest moment to open watch mode is straight after a race — which is
 * exactly when the scheduled sync may not have run yet, and FastF1's
 * intermittent block from Cloud Run means "not yet" can last a while. So an
 * unsynced round offers the most recent synced one rather than dead-ending.
 *
 * It deliberately does **not** offer to trigger a sync. FastF1's livetiming
 * endpoint is intermittently IP-blocked from Cloud Run, so a "sync this round"
 * button would fail unpredictably and leave the user worse off than an honest
 * "not processed yet".
 *
 * Probes run one at a time, newest first, and stop at the first hit: firing six
 * megabyte-scale requests in parallel to use one of them is a lot of backend
 * work to throw away.
 */
export async function findWatchableFallback(
  season: number,
  beforeRound: number,
  races?: Race[]
): Promise<{ race: Race; totalLaps: number } | null> {
  let candidates = races;
  if (!candidates) {
    try {
      candidates = (await getSeasonRaces(season)).races ?? [];
    } catch {
      return null;
    }
  }

  const ordered = completedRacesNewestFirst(candidates)
    .filter((race) => Number(race.round) !== beforeRound)
    .slice(0, FALLBACK_PROBE_LIMIT);

  for (const race of ordered) {
    try {
      const replay = await getRaceReplay(season, Number(race.round));
      if (replay.synced && replay.laps.length > 0) {
        return { race, totalLaps: replay.total_laps };
      }
    } catch {
      // A backend hiccup on one round shouldn't stop the search for another.
    }
  }

  return null;
}
