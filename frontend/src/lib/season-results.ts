import {
  getQualifyingResults,
  getRaceResults,
  getSeasonRaces,
  type DriverStanding,
  type Race,
  type SeasonRoundResults,
} from "./api";
import { buildHeadToHead } from "./driver-compare";

/**
 * Season-wide result loading for the head-to-head surfaces.
 *
 * `getSeasonResultsByRound` in api.ts fans out one race-results *and* one
 * qualifying-results request per round in the calendar. Measured against the
 * deployed backend on 2026-08-18, that is 46 requests for a 23-round season,
 * and two things make it far worse than the comment there assumes:
 *
 *   1. Twenty-four of the 46 are for rounds that have not been run yet. Those
 *      are not Mongo-cached — there is nothing to cache — so each one falls
 *      through to the upstream provider and costs 0.5-1.1s, against 0.07s for
 *      a round that has actually happened.
 *   2. Nothing caches the answer on the client. `next: { revalidate }` is a
 *      server-only directive and is inert in the browser, and the backend
 *      sends no `Cache-Control` header at all, so every mount repeats the
 *      whole fan-out from scratch.
 *
 * This module fixes both: it never requests a round whose race date has not
 * passed, and it memoises the in-flight promise per season so a second caller
 * (a remount, a re-open of the compare modal, a client-side navigation back to
 * the page) joins the first request instead of starting another 46.
 */

/**
 * True once a round's race date has passed. The API gives a date and an
 * optional UTC time; with no time we take the end of that day, so a round is
 * only treated as run when it certainly is.
 */
export function hasRoundBeenRun(race: Race, now: Date = new Date()): boolean {
  if (!race.date) return false;
  const iso = race.time
    ? `${race.date}T${race.time.replace("Z", "")}Z`
    : `${race.date}T23:59:59Z`;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return false;
  return start.getTime() <= now.getTime();
}

export interface LoadSeasonResultsOptions {
  /** Fetch qualifying alongside race results. Halves the request count when off. */
  includeQualifying?: boolean;
}

/**
 * Uncached fetch of every *already-run* round. Use this on the server, where
 * Next's own fetch data cache (`revalidate: 300`, set in api.ts) does the
 * caching and a module-level memo would pin one season's data into the server
 * process forever. On the client use `loadSeasonResults` instead.
 */
export async function fetchSeasonResults(
  year: number,
  { includeQualifying = true }: LoadSeasonResultsOptions = {}
): Promise<SeasonRoundResults[]> {
  const { races } = await getSeasonRaces(year);
  const rounds = (races ?? []).filter((race) => hasRoundBeenRun(race));

  const settled = await Promise.allSettled(
    rounds.map(async (race): Promise<SeasonRoundResults> => {
      const roundNumber = Number(race.round);
      const [raceRes, qualiRes] = await Promise.allSettled([
        getRaceResults(year, roundNumber),
        includeQualifying
          ? getQualifyingResults(year, roundNumber)
          : Promise.resolve({ results: [] as SeasonRoundResults["qualifying"] }),
      ]);
      return {
        round: race.round,
        raceName: race.raceName,
        results: raceRes.status === "fulfilled" ? raceRes.value.results ?? [] : [],
        qualifying:
          qualiRes.status === "fulfilled" ? qualiRes.value.results ?? [] : [],
      };
    })
  );

  return settled
    .filter(
      (r): r is PromiseFulfilledResult<SeasonRoundResults> => r.status === "fulfilled"
    )
    .map((r) => r.value);
}

// Module-level, so it survives component unmounts and client-side navigation
// for as long as the tab lives. Keyed by season + whether qualifying was asked
// for, because a race-only load must not satisfy a caller that needs quali.
const inFlight = new Map<string, Promise<SeasonRoundResults[]>>();

export function loadSeasonResults(
  year: number,
  options: LoadSeasonResultsOptions = {}
): Promise<SeasonRoundResults[]> {
  const includeQualifying = options.includeQualifying !== false;
  const key = `${year}:${includeQualifying ? "rq" : "r"}`;
  const cached = inFlight.get(key);
  if (cached) return cached;

  const promise = fetchSeasonResults(year, { includeQualifying }).catch((err) => {
    // A failed load must not be cached, or the surface stays broken until
    // the tab is reloaded.
    inFlight.delete(key);
    throw err;
  });
  inFlight.set(key, promise);
  return promise;
}

export interface TeammateBattle {
  teamName: string;
  driverAName: string;
  driverBName: string;
  /** Rounds where both drivers were classified. */
  sharedRounds: number;
  aheadA: number;
  aheadB: number;
}

interface TeamPair {
  teamName: string;
  driverA: DriverStanding;
  driverB: DriverStanding;
}

// A constructor can show more than two rows in the standings if it changed
// drivers mid-season (a substitute who also scored points) -- comparing the
// two who actually scored the most for that team is the more meaningful
// "battle" than an arbitrary pair.
function buildTeamPairs(drivers: DriverStanding[]): TeamPair[] {
  const groups = new Map<string, DriverStanding[]>();
  for (const driver of drivers) {
    const constructorId = driver.Constructors?.[0]?.constructorId;
    if (!constructorId) continue;
    const list = groups.get(constructorId) ?? [];
    list.push(driver);
    groups.set(constructorId, list);
  }

  const pairs: TeamPair[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const [driverA, driverB] = list
      .slice()
      .sort((a, b) => Number(b.points) - Number(a.points));
    pairs.push({
      teamName: driverA.Constructors?.[0]?.name ?? "—",
      driverA,
      driverB,
    });
  }
  return pairs;
}

/** Race-finish head-to-head per constructor, ready to render with no fetching. */
export function buildTeammateBattles(
  drivers: DriverStanding[],
  rounds: SeasonRoundResults[]
): TeammateBattle[] {
  const battles: TeammateBattle[] = [];
  for (const pair of buildTeamPairs(drivers)) {
    const idA = pair.driverA.Driver.driverId;
    const idB = pair.driverB.Driver.driverId;
    if (!idA || !idB) continue;
    const summary = buildHeadToHead(rounds, idA, idB);
    battles.push({
      teamName: pair.teamName,
      driverAName: pair.driverA.Driver.familyName ?? idA,
      driverBName: pair.driverB.Driver.familyName ?? idB,
      sharedRounds: summary.raceCommonCount,
      aheadA: summary.raceAheadA,
      aheadB: summary.raceAheadB,
    });
  }
  return battles;
}
