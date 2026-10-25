/**
 * Spoiler-free mode, server side: the preference as this request carries it.
 *
 * Server components only. `cookies()` opts the calling route into dynamic
 * rendering, which every data page here already is (`force-dynamic`, see
 * the deploy notes); do not call this from a route that is meant to
 * prerender, and do not call it from the root layout, which would make every
 * static page in the app dynamic for the sake of one icon.
 *
 * The rules themselves live in `lib/spoilers.ts`; this file only answers
 * "what did the visitor choose" and "which rounds of this season does that
 * hide right now".
 */

import { cookies } from "next/headers";
import { getActiveSeasonYear, getSeasonRaces, type Race } from "./api";
import {
  SPOILER_COOKIE,
  findHiddenRound,
  hiddenRounds,
  parseSpoilerCookie,
  seasonsInWindow,
  type HiddenRound,
  type SpoilerPrefs,
} from "./spoilers";

/**
 * Every round hidden right now, across whichever seasons can hold one
 * (`seasonsInWindow`). Backs `/api/spoilers`, which feeds the settings panel's
 * "hidden right now" list.
 */
export async function getAllHiddenRounds(nowMs = Date.now()): Promise<HiddenRound[]> {
  const prefs = await getSpoilerPrefs();
  const seasons = seasonsInWindow(prefs, nowMs, getActiveSeasonYear());
  const contexts = await Promise.all(
    seasons.map((season) => getSpoilerContext(season, { nowMs }))
  );
  // An unreachable calendar must not read as "nothing hidden" in a list whose
  // whole job is to say what is hidden.
  if (contexts.some((ctx) => !ctx.calendarAvailable)) {
    throw new Error("calendar unavailable");
  }
  return contexts.flatMap((ctx) => ctx.hidden);
}

export async function getSpoilerPrefs(): Promise<SpoilerPrefs> {
  const store = await cookies();
  return parseSpoilerCookie(store.get(SPOILER_COOKIE)?.value);
}

export interface SpoilerContext {
  prefs: SpoilerPrefs;
  /** The instant every decision below was made at, so one page agrees with itself. */
  nowMs: number;
  /** Hidden rounds of the requested season, in round order. */
  hidden: HiddenRound[];
  /** The hidden entry for one round of that season, or null when it is visible. */
  round: (round: string | number) => HiddenRound | null;
  /** False when the mode is on but the season calendar could not be fetched. */
  calendarAvailable: boolean;
}

/**
 * Prefs plus the hidden rounds of one season.
 *
 * Pass `races` when the page already fetched the calendar (it is the same
 * cached call either way, but passing it keeps the decision on exactly the
 * data the page is about to render). With the mode off this does no fetching
 * at all.
 *
 * If the calendar cannot be fetched, nothing is reported hidden. That is the
 * fail-open direction, and it is acceptable only because the pages fetch
 * their results from the same backend: when the calendar is unreachable,
 * there are no results on the page to hide.
 */
export async function getSpoilerContext(
  season: number,
  options: { races?: Race[]; nowMs?: number } = {}
): Promise<SpoilerContext> {
  const prefs = await getSpoilerPrefs();
  const nowMs = options.nowMs ?? Date.now();

  let hidden: HiddenRound[] = [];
  let calendarAvailable = true;
  if (prefs.on) {
    let races = options.races;
    if (!races) {
      try {
        races = (await getSeasonRaces(season)).races ?? [];
      } catch {
        races = [];
        calendarAvailable = false;
      }
    }
    hidden = hiddenRounds(races, prefs, nowMs, season);
  }

  return {
    prefs,
    nowMs,
    hidden,
    round: (round) => findHiddenRound(hidden, season, round),
    calendarAvailable,
  };
}
