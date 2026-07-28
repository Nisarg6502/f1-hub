import type { Race } from "./api";

/**
 * Race points, P1-P10 (the scoring table in force since 2010, unchanged
 * through the 2026 season).
 *
 * FASTEST_LAP_BONUS models the real "+1 point for fastest lap, but only if
 * that driver finishes in the top 10" rule (in force since 2019). For a
 * *maximum possible points* ceiling -- which is all this calculator needs --
 * we fold the bonus straight into RACE_CEILING: a driver who wins every
 * remaining race and also sets the fastest lap every time tops out at 26,
 * not 25. This slightly overstates what's realistically in play (in
 * practice the bonus point is often scored by someone outside the top two),
 * but it keeps the "is the title still mathematically open" check honest --
 * understating the ceiling could call a title clinched before it actually is.
 */
export const RACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const FASTEST_LAP_BONUS = 1;
export const RACE_CEILING = RACE_POINTS[0] + FASTEST_LAP_BONUS; // 26

/** Sprint points, P1-P8. No fastest-lap bonus on sprint weekends. */
export const SPRINT_POINTS = [8, 7, 6, 5, 4, 3, 2, 1];
export const SPRINT_CEILING = SPRINT_POINTS[0]; // 8

/**
 * Constructors' points are the sum of both team-mates' finishes each round,
 * so a team's per-race ceiling is its two cars taking P1 and P2 (plus the
 * one fastest-lap point available on the grid, generously assumed to go to
 * one of that team's drivers). We do NOT model mid-season driver swaps or
 * which specific two drivers score for a team in a future round -- this is a
 * simplification on top of the drivers' calculation, same "don't understate
 * the ceiling" reasoning.
 */
export const CONSTRUCTOR_RACE_CEILING =
  RACE_POINTS[0] + RACE_POINTS[1] + FASTEST_LAP_BONUS; // 44
export const CONSTRUCTOR_SPRINT_CEILING = SPRINT_POINTS[0] + SPRINT_POINTS[1]; // 15

// Mirrors the date/time parsing already used on the race-detail page
// (frontend/src/app/schedule/[season]/[round]/page.tsx) to decide isPast /
// isNextRace -- same UTC-assume-noon fallback, so "remaining" here lines up
// with what that page calls "upcoming".
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

/** Remaining rounds = races whose date/time is still in the future. A round
 * counts as a "sprint" round when it carries a `Sprint` block, per the
 * `Race` type from `@/lib/api`. */
export function countRemainingRounds(
  races: Race[],
  now: Date = new Date()
): RemainingRoundsCount {
  const nowMs = now.getTime();
  let remainingRaces = 0;
  let remainingSprints = 0;
  for (const race of races) {
    const ts = raceTimestampMs(race);
    if (ts === null || ts <= nowMs) continue;
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
  /** True once the runner-up cannot catch the leader even by winning
   * (+ fastest lap / sprint-winning) every remaining round. */
  clinched: boolean;
  /** Extra points the leader needs on top of the current gap to guarantee
   * the title regardless of what the runner-up does. 0 once clinched. */
  pointsToClinch: number;
}

/**
 * Championship clinch math for either standings table.
 *
 * `standings` must already be sorted by position (both `/api/driverstandings`
 * and `/api/constructorstandings` are). We only ever look at the top two --
 * scope is deliberately P1 vs P2, not an N-way title fight.
 *
 * Clinch rule: the leader has mathematically secured the title once
 * `leader.points - runnerUp.points > maxRemainingPoints` -- i.e. the
 * runner-up cannot close the gap even by maxing out every remaining round.
 */
export function computeTitleDecider(
  standings: StandingEntry[],
  races: Race[],
  scope: "driver" | "constructor",
  now: Date = new Date()
): TitleDeciderResult | null {
  if (standings.length < 2) return null;
  const [leader, runnerUp] = standings;
  const { remainingRaces, remainingSprints } = countRemainingRounds(races, now);

  const raceCeiling = scope === "driver" ? RACE_CEILING : CONSTRUCTOR_RACE_CEILING;
  const sprintCeiling =
    scope === "driver" ? SPRINT_CEILING : CONSTRUCTOR_SPRINT_CEILING;
  const maxRemainingPoints =
    remainingRaces * raceCeiling + remainingSprints * sprintCeiling;

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
