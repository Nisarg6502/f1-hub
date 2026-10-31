import type { DriverStanding, Race, RaceResult } from "@/lib/api";
import { countRemainingRounds } from "@/lib/championship-math";
import { getCircuitImagePath } from "@/lib/circuit-images";
import { getRaceWeek } from "@/lib/race-week";
import { buildRaceSessionTimeline, getUpcomingSessions } from "@/lib/sessions";

/**
 * Everything the home widgets render from, computed once on the server.
 *
 * The page used to render its sections directly from `getSeasonRaces` and
 * `getDriverStandings`. Now the sections are client widgets (they have to be:
 * they drag, resize and re-order), so whatever they read crosses the server →
 * client boundary as serialised props. This object is that boundary, and it
 * is deliberately *slim*: derived numbers and the handful of fields each
 * widget draws, not the raw API payloads. The full race list alone would put
 * every session of every round into the HTML of every visit.
 *
 * It also carries everything the *optional* widgets need that the default
 * page already fetched — the top ten of the standings, the last race's
 * podium — so adding those widgets costs no request at all. The only widget
 * data not in here is the constructors' table, which the default page never
 * needed; those widgets fetch it client-side, and only when they are on the
 * layout.
 */
export interface HomeDriverRow {
  position: string;
  name: string;
  givenName: string;
  familyName: string;
  code: string;
  team: string;
  points: number;
  wins: number;
}

export interface HomePodiumRow {
  position: string;
  name: string;
  givenName: string;
  familyName: string;
  team: string;
  /** Race time for the winner, the gap (or laps down) for everyone else. */
  time: string;
}

export interface HomeSession {
  id: string;
  sessionLabel: string;
  startTimeMs: number;
}

export interface HomeData {
  seasonYear: number;
  nowMs: number;
  /** The `Race` itself, because `CountdownTimer` takes one. One object. */
  nextRace: Race | null;
  nextCircuit: {
    round: string | null;
    raceName: string;
    circuitName: string | null;
    locality: string | null;
    country: string | null;
    image: string | null;
    href: string;
    isSprint: boolean;
  };
  upcomingSessions: HomeSession[];
  season: {
    done: number;
    total: number;
    roundsLeft: number;
    elapsedPct: number;
    ptsGap: number;
    gapPct: number;
    leaderWins: string;
  };
  /** Top ten. Enough for the largest standings widget and the title fight. */
  drivers: HomeDriverRow[];
  /** Size of the full grid, for the explore tile ("22 drivers"). */
  driverCount: number;
  lastRace: {
    round: number;
    raceName: string;
    href: string;
    podium: HomePodiumRow[];
  } | null;
  /** Only the fields `computeTitleDecider` reads: date, time, Sprint. */
  titleRaces: Race[];
  remainingRaces: number;
  remainingSprints: number;
  /** Whether `RaceWeekGlimpse` will render anything. See `glimpseHasContent`. */
  raceWeekActive: boolean;
}

function parseRaceMs(date?: string, time?: string): number | null {
  if (!date) return null;
  const baseTime = time ?? "12:00:00Z";
  const iso = baseTime.endsWith("Z") ? `${date}T${baseTime}` : `${date}T${baseTime}Z`;
  const ts = new Date(iso).getTime();
  return Number.isNaN(ts) ? null : ts;
}

const fullName = (given?: string, family?: string) => `${given ?? ""} ${family ?? ""}`.trim();

/**
 * Mirrors the early returns in `components/race-week-glimpse.tsx`: no current
 * weekend, or a weekend where nothing has run and nothing is running, renders
 * nothing. The grid needs to know that *before* it renders, because in edit
 * mode an empty slot must become an honest placeholder rather than a
 * zero-height cell nobody can grab.
 *
 * Duplicating three conditions is the price of not editing that component; if
 * they drift, the worst case is a placeholder shown during a weekend whose
 * strip would have rendered — never a hidden strip.
 */
export function glimpseHasContent(races: Race[], nowMs: number): boolean {
  const week = getRaceWeek(races, nowMs);
  if (!week || !Number.isFinite(Number(week.race.round))) return false;
  return week.finished.length > 0 || week.live !== null;
}

export function buildHomeData({
  seasonYear,
  nowMs,
  races,
  driverStandings,
  lastRaceResults,
}: {
  seasonYear: number;
  nowMs: number;
  races: Race[];
  driverStandings: DriverStanding[];
  /** Results of the most recent completed race, if they could be fetched. */
  lastRaceResults: RaceResult[];
}): HomeData {
  const withTs = races
    .map((race) => ({ race, ts: parseRaceMs(race.date, race.time) }))
    .filter((r): r is { race: Race; ts: number } => r.ts !== null);

  const nextRace =
    withTs.filter((r) => r.ts > nowMs).sort((a, b) => a.ts - b.ts)[0]?.race ??
    races.find((r) => r.date) ??
    races.at(-1) ??
    null;

  const completed = withTs.filter((r) => r.ts <= nowMs).sort((a, b) => b.ts - a.ts);
  const latestCompletedRace = completed[0]?.race;

  const leader = driverStandings[0];
  const leaderPts = Number(leader?.points ?? 0);
  const secondPts = Number(driverStandings[1]?.points ?? 0);
  const ptsGap = Math.max(leaderPts - secondPts, 0);
  const total = races.length;
  const done = completed.length;

  const locality = nextRace?.Circuit?.Location?.locality ?? null;
  const circuitName = nextRace?.Circuit?.circuitName ?? null;
  const country = nextRace?.Circuit?.Location?.country ?? null;

  const { remainingRaces, remainingSprints } = countRemainingRounds(races, new Date(nowMs));

  return {
    seasonYear,
    nowMs,
    nextRace,
    nextCircuit: {
      round: nextRace?.round ?? null,
      raceName: nextRace?.raceName ?? "Next Grand Prix",
      circuitName,
      locality,
      country,
      image: getCircuitImagePath(country ?? "", locality ?? undefined, circuitName ?? undefined),
      href: nextRace ? `/schedule/${seasonYear}/${nextRace.round}` : "/circuits",
      isSprint: Boolean(nextRace?.Sprint),
    },
    upcomingSessions: getUpcomingSessions(buildRaceSessionTimeline(nextRace ?? undefined), nowMs, 4).map(
      (s) => ({ id: s.id, sessionLabel: s.sessionLabel, startTimeMs: s.startTimeMs })
    ),
    season: {
      done,
      total,
      roundsLeft: Math.max(total - done, 0),
      elapsedPct: total ? done / total : 0,
      ptsGap,
      gapPct: leaderPts > 0 ? Math.min(ptsGap / leaderPts, 1) : 0,
      leaderWins: leader?.wins ?? "0",
    },
    drivers: driverStandings.slice(0, 10).map((d, i) => ({
      position: d.position || String(i + 1),
      name: fullName(d.Driver.givenName, d.Driver.familyName),
      givenName: d.Driver.givenName ?? "",
      familyName: d.Driver.familyName ?? "",
      code: d.Driver.code ?? "",
      team: d.Constructors?.[0]?.name ?? "",
      points: Number(d.points) || 0,
      wins: Number(d.wins) || 0,
    })),
    driverCount: driverStandings.length,
    lastRace:
      latestCompletedRace && lastRaceResults.length > 0
        ? {
            round: Number(latestCompletedRace.round),
            raceName: latestCompletedRace.raceName,
            href: `/schedule/${seasonYear}/${latestCompletedRace.round}`,
            podium: lastRaceResults.slice(0, 3).map((r, i) => ({
              position: r.position || String(i + 1),
              name: fullName(r.Driver?.givenName, r.Driver?.familyName),
              givenName: r.Driver?.givenName ?? "",
              familyName: r.Driver?.familyName ?? "",
              team: r.Constructor?.name ?? "",
              time: r.Time?.time ?? r.status ?? "",
            })),
          }
        : null,
    titleRaces: races.map((r) => ({
      raceName: "",
      round: r.round,
      date: r.date,
      ...(r.time ? { time: r.time } : {}),
      ...(r.Sprint ? { Sprint: r.Sprint } : {}),
    })),
    remainingRaces,
    remainingSprints,
    raceWeekActive: glimpseHasContent(races, nowMs),
  };
}

/** The most recent completed race, so the page knows whose results to fetch. */
export function latestCompletedRace(races: Race[], nowMs: number): Race | undefined {
  return races
    .map((race) => ({ race, ts: parseRaceMs(race.date, race.time) }))
    .filter((r): r is { race: Race; ts: number } => r.ts !== null && r.ts <= nowMs)
    .sort((a, b) => b.ts - a.ts)[0]?.race;
}
