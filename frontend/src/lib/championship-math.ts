import type { Race } from "./api";

/**
 * Championship clinch math. Mirrors `backend/app/title_clinch.py`, which
 * the catch-up card and the Pitwall Assistant use — keep the two in step.
 *
 * Race points P1-P10 have been 25-18-15-12-10-8-6-4-2-1 since 2010. The +1
 * fastest-lap point existed only from 2019 to 2024: counting it in 2026 put
 * the ceiling at 26 a race (104 over four races instead of 100). Sprint
 * points are 8-7-…-1 from 2022, 3-2-1 in 2021.
 */
export const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];

const FASTEST_LAP_FIRST = 2019;
const FASTEST_LAP_LAST = 2024;

export interface Ceilings {
  race: number;
  sprint: number;
}

/**
 * Most points one driver (or one team, via a one-two) can score per race and
 * per sprint in `season`. `null` before 2010: older points systems are not
 * modelled, and nothing is claimed for them.
 */
export function pointsCeilings(season: number, scope: "driver" | "constructor"): Ceilings | null {
  if (!Number.isFinite(season) || season < 2010) return null;
  const fastestLap = season >= FASTEST_LAP_FIRST && season <= FASTEST_LAP_LAST ? 1 : 0;
  const [sprintWin, sprintSecond] = season >= 2022 ? [8, 7] : season === 2021 ? [3, 2] : [0, 0];
  return scope === "constructor"
    ? { race: RACE_POINTS[0] + RACE_POINTS[1] + fastestLap, sprint: sprintWin + sprintSecond }
    : { race: RACE_POINTS[0] + fastestLap, sprint: sprintWin };
}

// Mirrors the date/time parsing used on the race-detail page — same
// UTC-assume-noon fallback, so "remaining" lines up with "upcoming" there.
function raceTimestampMs(race: Race): number | null {
  if (!race.date) return null;
  const baseTime = race.time ?? "12:00:00Z";
  const iso = baseTime.endsWith("Z")
    ? `${race.date}T${baseTime}`
    : `${race.date}T${baseTime}Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

export interface RemainingRoundsCount {
  remainingRaces: number;
  remainingSprints: number;
}

/**
 * Rounds still to score.
 *
 * With `standingsRound` (the round the standings table describes, from
 * `/api/driverstandings`), a round remains when it comes after that one.
 * That is the safe count: by the clock, a race that has started but whose
 * points are not in the table yet would already be "run", and a title fight
 * still live in that race could be called over. Without it, rounds whose
 * start is still in the future remain (the old behaviour).
 */
export function countRemainingRounds(
  races: Race[],
  now: Date = new Date(),
  standingsRound?: number | null
): RemainingRoundsCount {
  const nowMs = now.getTime();
  let remainingRaces = 0;
  let remainingSprints = 0;
  for (const race of races) {
    if (standingsRound != null && Number.isFinite(standingsRound)) {
      const round = Number(race.round);
      if (!Number.isFinite(round) || round <= standingsRound) continue;
    } else {
      const ts = raceTimestampMs(race);
      if (ts === null || ts <= nowMs) continue;
    }
    remainingRaces += 1;
    if (race.Sprint) remainingSprints += 1;
  }
  return { remainingRaces, remainingSprints };
}

export interface StandingEntry {
  name: string;
  points: number;
}

export interface TitleDeciderResult {
  leader: StandingEntry;
  runnerUp: StandingEntry;
  gap: number;
  maxRemainingPoints: number;
  remainingRaces: number;
  remainingSprints: number;
  /** True once the runner-up cannot catch the leader even by winning every
   * remaining round. Strict: a possible tie on points is not a clinch. */
  clinched: boolean;
  /** Extra points the leader needs on top of the current gap to guarantee
   * the title regardless of what the runner-up does. 0 once clinched. */
  pointsToClinch: number;
}

export interface TitleDeciderOptions {
  /** Season the standings belong to. Defaults to the first race's season,
   * then to `now`'s year. */
  season?: number;
  /** Round the standings describe; see `countRemainingRounds`. */
  standingsRound?: number | null;
}

function seasonOf(races: Race[], now: Date, explicit?: number): number {
  if (explicit && Number.isFinite(explicit)) return explicit;
  const fromRace = Number(races.find((r) => r.season)?.season ?? races[0]?.date?.slice(0, 4));
  return Number.isFinite(fromRace) && fromRace > 0 ? fromRace : now.getUTCFullYear();
}

/**
 * Clinch math for either standings table. `standings` must be sorted by
 * position. Only P1 v P2 matters: whoever is second has the most points of
 * anyone chasing, so if they cannot catch the leader, nobody can.
 */
export function computeTitleDecider(
  standings: StandingEntry[],
  races: Race[],
  scope: "driver" | "constructor",
  now: Date = new Date(),
  options: TitleDeciderOptions = {}
): TitleDeciderResult | null {
  if (standings.length < 2) return null;
  const ceilings = pointsCeilings(seasonOf(races, now, options.season), scope);
  if (!ceilings) return null;
  const [leader, runnerUp] = standings;
  const { remainingRaces, remainingSprints } = countRemainingRounds(
    races,
    now,
    options.standingsRound
  );

  const maxRemainingPoints = remainingRaces * ceilings.race + remainingSprints * ceilings.sprint;
  const gap = leader.points - runnerUp.points;
  const clinched = gap > maxRemainingPoints;
  const pointsToClinch = clinched ? 0 : maxRemainingPoints - gap + 1;

  return {
    leader,
    runnerUp,
    gap,
    maxRemainingPoints,
    remainingRaces,
    remainingSprints,
    clinched,
    pointsToClinch,
  };
}
