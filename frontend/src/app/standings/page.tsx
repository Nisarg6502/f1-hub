import type { Metadata } from "next";
import {
  getConstructorStandings,
  getDriverStandings,
  getActiveSeasonYear,
  resolveSeasonYear,
} from "@/lib/api";
import StandingsView from "@/components/standings-view";

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

  return (
    <StandingsView
      drivers={drivers ?? []}
      constructors={constructors ?? []}
      year={year}
      maxYear={getActiveSeasonYear()}
    />
  );
}
