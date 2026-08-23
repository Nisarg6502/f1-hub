import {
  getQualifyingResults,
  getRaceResults,
  getSeasonRaces,
  getSprintResults,
  type ConstructorStanding,
  type DriverStanding,
  type Race,
  type RaceResult,
  type SeasonRoundResults,
} from "./api";
import { buildHeadToHead } from "./driver-compare";

export type { SeasonRoundResults } from "./api";

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

/* -------------------------------------------------------------------------- */
/* per-driver season logs                                                      */
/* -------------------------------------------------------------------------- */

/** One round's sprint classification. Only sprint weekends appear. */
export interface SeasonSprintResults {
  round: string;
  results: RaceResult[];
}

/**
 * Sprint classifications for every sprint weekend that has already run.
 *
 * Separate from `fetchSeasonResults` rather than folded into it because the
 * two have very different costs: a sprint exists on maybe six rounds of a
 * twenty-four-round season, so asking every round for one would triple the
 * request count of the caller that needs it and add nothing for the eighteen
 * rounds that never had a sprint. The schedule already says which weekends
 * have a `Sprint` session, so this only asks those.
 *
 * A season's points do not add up without these. A sprint is worth up to 8
 * points and they are not in the Grand Prix results, so a race-only log would
 * quietly disagree with the championship table it sits underneath — the exact
 * kind of near-miss that makes a reader distrust the whole page.
 */
export async function fetchSeasonSprints(
  year: number
): Promise<SeasonSprintResults[]> {
  const { races } = await getSeasonRaces(year);
  const sprintRounds = (races ?? []).filter(
    (race) => Boolean(race.Sprint) && hasRoundBeenRun(race)
  );

  const settled = await Promise.allSettled(
    sprintRounds.map(async (race): Promise<SeasonSprintResults> => {
      const res = await getSprintResults(year, Number(race.round));
      return { round: race.round, results: res.results ?? [] };
    })
  );

  return settled
    .filter(
      (r): r is PromiseFulfilledResult<SeasonSprintResults> => r.status === "fulfilled"
    )
    .map((r) => r.value);
}

/** One round from one driver's point of view. */
export interface DriverRoundEntry {
  round: number;
  raceName: string;
  /** `Bahrain Grand Prix` -> `Bahrain`, for a tile 76px wide. */
  shortName: string;
  /** Classified finishing position, or null when they were not classified. */
  position: number | null;
  /** Ergast's `positionText`: a number, or `R`/`D`/`W`/`N` for the rest. */
  positionText: string;
  grid: number | null;
  /** Grand Prix points only. */
  racePoints: number;
  sprintPosition: number | null;
  sprintPoints: number;
  /** Race + sprint, i.e. everything this round contributed. */
  points: number;
  status: string | null;
  /** Reached the flag, lapped or not. */
  finished: boolean;
}

export interface DriverSeasonLog {
  driverId: string;
  /** Ascending by round; only rounds this driver actually appeared in. */
  entries: DriverRoundEntry[];
  wins: number;
  podiums: number;
  /** Rounds that returned at least one point, sprint included. */
  pointsFinishes: number;
  dnfs: number;
  bestFinish: number | null;
  /** Summed from `entries`, so it is race + sprint over the rounds we could
   * load — not necessarily the championship total. See the note on the panel. */
  totalPoints: number;
  /** The single round that contributed the most. Null if nothing scored. */
  bestRound: DriverRoundEntry | null;
}

/** Trims the boilerplate off a race name so it fits a tile. */
export function shortRaceName(raceName: string): string {
  return (
    raceName
      .replace(/\s*Grand Prix\s*/i, " ")
      .replace(/\s*\bGP\b\s*/i, " ")
      .trim() || raceName
  );
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Did this driver see the flag?
 *
 * `positionText` is the primary signal — Ergast gives a bare number for anyone
 * classified and a letter (`R` retired, `D` disqualified, `W` withdrawn, `N`
 * not classified) for everyone else. `status` is the tiebreak, because a car
 * can be *classified* having stopped near the end, in which case the position
 * is a number but the status says why it stopped. `Finished` and `+n Lap(s)`
 * are the only two statuses that mean the car was running at the end.
 */
function didFinish(result: RaceResult): boolean {
  const text = (result.positionText ?? result.position ?? "").trim();
  if (!/^\d+$/.test(text)) return false;
  const status = (result.status ?? "").trim();
  if (!status) return true;
  return /^finished$/i.test(status) || /^\+\d+\s+laps?$/i.test(status);
}

/**
 * Where every driver's points actually came from, round by round.
 *
 * Built on the server alongside the teammate battles, from the same already-
 * fetched rounds, so opening a driver's season log costs no request at all —
 * the alternative (fetch on expand) would put a spinner behind a disclosure
 * that is meant to feel like it was already there.
 */
export function buildDriverSeasonLogs(
  drivers: DriverStanding[],
  rounds: SeasonRoundResults[],
  sprints: SeasonSprintResults[] = []
): Record<string, DriverSeasonLog> {
  const sprintByRound = new Map<string, RaceResult[]>();
  for (const sprint of sprints) sprintByRound.set(String(sprint.round), sprint.results);

  // Ascending, because the API's round order is not guaranteed and a season
  // log read out of order is worse than no log.
  const ordered = [...rounds].sort((a, b) => Number(a.round) - Number(b.round));

  const logs: Record<string, DriverSeasonLog> = {};

  for (const driver of drivers) {
    const driverId = driver.Driver.driverId;
    if (!driverId) continue;

    const entries: DriverRoundEntry[] = [];
    for (const round of ordered) {
      const result = round.results.find((r) => r.Driver?.driverId === driverId);
      const sprintResult = sprintByRound
        .get(String(round.round))
        ?.find((r) => r.Driver?.driverId === driverId);

      // A round where the driver appears in neither classification is a round
      // they were not at (a mid-season replacement, an injury). Skipped rather
      // than shown as a zero, which would read as a bad weekend.
      if (!result && !sprintResult) continue;

      const racePoints = toNumber(result?.points) ?? 0;
      const sprintPoints = toNumber(sprintResult?.points) ?? 0;
      const positionText = (
        result?.positionText ??
        result?.position ??
        "—"
      ).trim();

      entries.push({
        round: Number(round.round),
        raceName: round.raceName,
        shortName: shortRaceName(round.raceName),
        position: /^\d+$/.test(positionText) ? Number(positionText) : null,
        positionText,
        grid: toNumber(result?.grid),
        racePoints,
        sprintPosition: toNumber(sprintResult?.position),
        sprintPoints,
        points: racePoints + sprintPoints,
        status: result?.status ?? null,
        finished: result ? didFinish(result) : false,
      });
    }

    let wins = 0;
    let podiums = 0;
    let pointsFinishes = 0;
    let dnfs = 0;
    let bestFinish: number | null = null;
    let totalPoints = 0;
    let bestRound: DriverRoundEntry | null = null;

    for (const entry of entries) {
      if (entry.position === 1) wins += 1;
      if (entry.position !== null && entry.position <= 3) podiums += 1;
      if (entry.points > 0) pointsFinishes += 1;
      if (!entry.finished) dnfs += 1;
      if (entry.position !== null && (bestFinish === null || entry.position < bestFinish)) {
        bestFinish = entry.position;
      }
      totalPoints += entry.points;
      if (entry.points > 0 && (!bestRound || entry.points > bestRound.points)) {
        bestRound = entry;
      }
    }

    logs[driverId] = {
      driverId,
      entries,
      wins,
      podiums,
      pointsFinishes,
      dnfs,
      bestFinish,
      totalPoints,
      bestRound,
    };
  }

  return logs;
}

export interface ConstructorRoundEntry {
  round: number;
  raceName: string;
  shortName: string;
  points: number;
}

export interface ConstructorSeasonLog {
  constructorId: string;
  entries: ConstructorRoundEntry[];
}

/**
 * Constructor points per round, summed across whichever drivers scored for
 * them that round -- built from the same rounds/sprints `buildDriverSeasonLogs`
 * already needs, so a mid-season driver swap still attributes points to the
 * team correctly without tracking driver-to-team history separately.
 */
export function buildConstructorSeasonLogs(
  constructors: ConstructorStanding[],
  rounds: SeasonRoundResults[],
  sprints: SeasonSprintResults[] = []
): Record<string, ConstructorSeasonLog> {
  const sprintByRound = new Map<string, RaceResult[]>();
  for (const sprint of sprints) sprintByRound.set(String(sprint.round), sprint.results);

  const ordered = [...rounds].sort((a, b) => Number(a.round) - Number(b.round));

  const logs: Record<string, ConstructorSeasonLog> = {};

  for (const constructor of constructors) {
    const constructorId = constructor.Constructor?.constructorId;
    if (!constructorId) continue;

    const entries: ConstructorRoundEntry[] = [];
    for (const round of ordered) {
      const raceResults = round.results.filter(
        (r) => r.Constructor?.constructorId === constructorId
      );
      const sprintResults = (sprintByRound.get(String(round.round)) ?? []).filter(
        (r) => r.Constructor?.constructorId === constructorId
      );

      if (raceResults.length === 0 && sprintResults.length === 0) continue;

      const points =
        raceResults.reduce((sum, r) => sum + (toNumber(r.points) ?? 0), 0) +
        sprintResults.reduce((sum, r) => sum + (toNumber(r.points) ?? 0), 0);

      entries.push({
        round: Number(round.round),
        raceName: round.raceName,
        shortName: shortRaceName(round.raceName),
        points,
      });
    }

    logs[constructorId] = { constructorId, entries };
  }

  return logs;
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
