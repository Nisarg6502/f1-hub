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
import SeasonSelector from "@/components/season-selector";
import SpoilerShield from "@/components/spoiler-shield";
import { getSpoilerContext } from "@/lib/spoilers-server";
import { joinNames } from "@/lib/spoilers";

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
  const title = `${year} F1 Championship Standings · APEX`;
  const description = `Drivers' and constructors' standings for the ${year} Formula 1 season, with the title fight and every teammate head-to-head.`;
  return {
    title,
    description,
    openGraph: { title, description, url: `/standings` },
    twitter: { title, description },
  };
}

export default async function StandingsPage({ searchParams }: PageProps) {
  const { season } = await searchParams;
  const year = resolveSeasonYear(season);

  // Spoiler-free mode. Every number on this page (points, positions, the
  // title maths, the teammate scores, the progression chart) moved when the
  // hidden round was scored, so there is no honest partial view: the whole
  // body is shielded, and nothing behind it is even fetched.
  //
  // "Standings as of the last round you've revealed" would be the nicer
  // answer, and was considered. The backend serves only the current table
  // (no per-round standings endpoint), and rebuilding one from per-round
  // points would mean re-implementing countback tie-breaks and any official
  // points adjustments in the browser. A table that is subtly wrong is worse
  // than one that is honestly hidden.
  const spoilers = await getSpoilerContext(year);
  if (spoilers.hidden.length > 0) {
    const names = spoilers.hidden.map((h) => h.raceName);
    return (
      <div className="px-6 md:px-10 pt-11 pb-16">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-6 mb-7">
          <div>
            <span className="font-bold text-xs tracking-[0.18em] uppercase text-flame">
              Season {year} · Championship
            </span>
            <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[52px] tracking-[-1.5px] mt-2">
              Championship
            </h1>
          </div>
          <SeasonSelector currentYear={year} maxYear={getActiveSeasonYear()} />
        </div>
        <SpoilerShield
          hidden
          raceKey={spoilers.hidden.map((h) => h.raceKey)}
          raceName={names}
          title={`Standings include the ${joinNames(names)} ${names.length > 1 ? "results" : "result"}`}
          description="Points, positions and the title fight all changed with it. Reveal it to see the table."
          minHeight={560}
        />
      </div>
    );
  }

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
