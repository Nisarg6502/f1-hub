import type { Metadata } from "next";
import {
  getConstructorStandings,
  getDriverStandings,
  getActiveSeasonYear,
  resolveSeasonYear,
} from "@/lib/api";
import StandingsView from "@/components/standings-view";
import {
  buildDriverSeasonLogs,
  buildConstructorSeasonLogs,
  buildTeammateBattles,
  fetchSeasonResults,
  fetchSeasonSprints,
  type DriverSeasonLog,
  type ConstructorSeasonLog,
  type TeammateBattle,
} from "@/lib/season-results";
import DegradedBeacon from "@/components/degraded-beacon";

// Standings change after every race; render per request rather than serving a
// prerender captured at build time.
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ season?: string }>;
}

// Mirrors the ?season= resolution the page itself uses, so the <title> and
// description reflect whichever season is actually being viewed instead of
// the root layout's hardcoded fallback.
export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { season } = await searchParams;
  const year = resolveSeasonYear(season);
  return {
    title: `APEX | ${year} F1 Season Hub`,
    description: `APEX — a warm, high-clarity home for the ${year} Formula 1 season: schedule, standings, drivers, teams and circuits.`,
  };
}

export default async function StandingsPage({ searchParams }: PageProps) {
  const { season } = await searchParams;
  const year = resolveSeasonYear(season);

  let drivers: Awaited<ReturnType<typeof getDriverStandings>>["driver_standings"] = [];
  let constructors: Awaited<ReturnType<typeof getConstructorStandings>>["constructor_standings"] = [];

  try {
    const [driverRes, constructorRes] = await Promise.all([
      getDriverStandings(year),
      getConstructorStandings(year),
    ]);
    drivers = driverRes.driver_standings ?? [];
    constructors = constructorRes.constructor_standings ?? [];
  } catch {
    // Backend offline
  }

  // The teammate battle used to fetch a whole season of results from the
  // browser on every mount, which is why it showed a loading state every single
  // time the page was opened. It is derived data over results this server can
  // fetch once (and Next's fetch cache holds for 300s), so it ships with the
  // markup instead -- the panel now has no loading state to show.
  let teammateBattles: TeammateBattle[] = [];
  // The per-driver season logs behind each row's disclosure. Derived from the
  // same rounds the teammate battle already needed, so the extra surface costs
  // one additional fan-out (sprints only, on sprint weekends only) rather than
  // a second full season load — and nothing at all at expand time.
  let seasonLogs: Record<string, DriverSeasonLog> = {};
  let constructorLogs: Record<string, ConstructorSeasonLog> = {};
  if ((drivers ?? []).length > 0) {
    try {
      const [rounds, sprints] = await Promise.all([
        fetchSeasonResults(year, { includeQualifying: false }),
        // Settled separately: a sprint fetch that fails should cost the sprint
        // points, not the whole season log.
        fetchSeasonSprints(year).catch(() => []),
      ]);
      teammateBattles = buildTeammateBattles(drivers ?? [], rounds);
      seasonLogs = buildDriverSeasonLogs(drivers ?? [], rounds, sprints);
      constructorLogs = buildConstructorSeasonLogs(constructors ?? [], rounds, sprints);
    } catch {
      // Leave the panel empty rather than failing the page.
    }
  }

  // Both tables empty means the fetch above failed and the page is about to
  // render as a shell. That still returns HTTP 200, so the server sees a
  // healthy request; the beacon is the only way it gets counted.
  const degraded = (drivers ?? []).length === 0 && (constructors ?? []).length === 0;

  // A Server Component renders once per request with no re-render replay to
  // make this unstable — the purity rule guards Client Component render
  // bodies, which React Compiler can re-invoke; it has no such concern here.
  // eslint-disable-next-line react-hooks/purity
  const renderedAtMs = Date.now();

  return (
    <>
      {degraded && <DegradedBeacon route="/standings" />}
    <StandingsView
      drivers={drivers ?? []}
      constructors={constructors ?? []}
      teammateBattles={teammateBattles}
      seasonLogs={seasonLogs}
      constructorLogs={constructorLogs}
      year={year}
      maxYear={getActiveSeasonYear()}
      renderedAtMs={renderedAtMs}
    />
    </>
  );
}
