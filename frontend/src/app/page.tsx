import {
  getActiveSeasonYear,
  getDriverStandings,
  getSeasonRaces,
  getRaceResults,
  type DriverStanding,
  type Race,
  type RaceResult,
} from "@/lib/api";
import RaceWeekGlimpse from "@/components/race-week-glimpse";
import HomeGrid from "@/components/home/home-grid";
import { buildHomeData, latestCompletedRace } from "@/components/home/home-data";

// Rendered per request: the "next race" and "latest winner" depend on the
// current time, so a prerender goes stale the moment a race is run.
export const dynamic = "force-dynamic";

/**
 * The home page: a customisable grid of widgets (see
 * `components/home/home-grid.tsx`).
 *
 * This server component still does all the fetching the *default* layout
 * needs — the season's races, the drivers' standings, the last race's
 * results, and (inside `RaceWeekGlimpse`) the current weekend's sessions —
 * exactly the requests the fixed page made, and nothing more. A visitor on
 * the default layout therefore gets the same requests and the same
 * fully-rendered HTML as before. Widgets that are not on the default layout
 * either render from this same data or, for the one table the default never
 * needed (constructors), fetch it client-side only once they are added.
 *
 * The ~1,200-race historical index is deliberately not fetched here; it was
 * removed from home on purpose and no widget needs it.
 */
export default async function Home() {
  const seasonYear = getActiveSeasonYear();
  const nowMs = Date.now();

  let races: Race[] = [];
  let driverStandings: DriverStanding[] = [];
  try {
    const [racesRes, driverStandingsRes] = await Promise.all([
      getSeasonRaces(seasonYear),
      getDriverStandings(seasonYear),
    ]);
    races = racesRes.races ?? [];
    driverStandings = driverStandingsRes.driver_standings ?? [];
  } catch {
    // Backend offline — render with empty data
  }

  let lastRaceResults: RaceResult[] = [];
  const latest = latestCompletedRace(races, nowMs);
  if (latest) {
    try {
      lastRaceResults = (await getRaceResults(seasonYear, Number(latest.round))).results ?? [];
    } catch {
      // no results yet
    }
  }

  const data = buildHomeData({ seasonYear, nowMs, races, driverStandings, lastRaceResults });

  return (
    <HomeGrid
      data={data}
      // An async server component, so it is rendered here and handed to the
      // client grid as a node. Between weekends it renders nothing, which the
      // grid knows from `data.raceWeekActive`.
      raceWeek={<RaceWeekGlimpse races={races} seasonYear={seasonYear} nowMs={nowMs} />}
    />
  );
}
