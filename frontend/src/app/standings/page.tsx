import type { Metadata } from "next";
import {
  getConstructorStandings,
  getDriverStandings,
  getActiveSeasonYear,
  resolveSeasonYear,
} from "@/lib/api";
import StandingsView from "@/components/standings-view";
import {
  buildTeammateBattles,
  fetchSeasonResults,
  type TeammateBattle,
} from "@/lib/season-results";

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
  if ((drivers ?? []).length > 0) {
    try {
      const rounds = await fetchSeasonResults(year, { includeQualifying: false });
      teammateBattles = buildTeammateBattles(drivers ?? [], rounds);
    } catch {
      // Leave the panel empty rather than failing the page.
    }
  }

  return (
    <StandingsView
      drivers={drivers ?? []}
      constructors={constructors ?? []}
      teammateBattles={teammateBattles}
      year={year}
      maxYear={getActiveSeasonYear()}
    />
  );
}
