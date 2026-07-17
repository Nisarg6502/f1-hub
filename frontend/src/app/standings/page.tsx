import {
  getConstructorStandings,
  getDriverStandings,
  getActiveSeasonYear,
} from "@/lib/api";
import StandingsView from "@/components/standings-view";

// Standings change after every race; render per request rather than serving a
// prerender captured at build time.
export const dynamic = "force-dynamic";

export default async function StandingsPage() {
  const year = getActiveSeasonYear();

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
    />
  );
}
