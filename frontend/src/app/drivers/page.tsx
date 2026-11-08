import type { Metadata } from "next";
import { getActiveSeasonYear, getDriverStandings, getSeasonRaces, resolveSeasonYear, type Race } from "@/lib/api";
import { computeTitleDecider } from "@/lib/championship-math";
import DriversGrid from "@/components/drivers-grid";
import SeasonSelector from "@/components/season-selector";
import CompareDriversPanel from "@/components/compare-drivers-panel";
import DegradedBeacon from "@/components/degraded-beacon";
import { SpoilerBanner } from "@/components/spoiler-shield";
import { getSpoilerContext, getWindowHiddenRounds } from "@/lib/spoilers-server";
import { joinNames } from "@/lib/spoilers";

// Driver standings change after every race; render per request.
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
  const title = `${year} F1 Driver Grid · APEX`;
  const description = `Every driver on the ${year} Formula 1 grid — this season's points, wins and position, plus a career bio for each.`;
  return {
    title,
    description,
    openGraph: { title, description, url: `/drivers` },
    twitter: { title, description },
  };
}

export default async function DriversPage({ searchParams }: PageProps) {
  const { season } = await searchParams;
  const year = resolveSeasonYear(season);
  let drivers: Awaited<ReturnType<typeof getDriverStandings>>["driver_standings"] =
    [];
  let standingsRound: number | null = null;
  // The schedule is only needed to tell whether the title is decided; it is
  // fetched alongside the standings, never after them.
  const racesPromise: Promise<Race[]> = getSeasonRaces(year)
    .then((res) => res.races ?? [])
    .catch(() => []);
  try {
    const res = await getDriverStandings(year);
    drivers = res.driver_standings ?? [];
    standingsRound = res.round ?? null;
  } catch {
    // Backend offline
  }
  const races = await racesPromise;

  // Spoiler-free mode. The grid is still the grid, but its order, points,
  // wins and positions all include the hidden round. So the drivers are
  // re-sorted by surname and those three figures are blanked HERE, on the
  // server, rather than merely not drawn: the client grid and its modal never
  // receive them. The head-to-head panel compares season results, so it waits
  // too.
  //
  // Career totals in the profile modal are a separate question: they span
  // seasons, so they hide while a round of ANY season in the window is hidden
  // (a hidden 2026 finale still counts in a career viewed from 2027).
  const [spoilers, windowHidden] = await Promise.all([
    getSpoilerContext(year),
    getWindowHiddenRounds(),
  ]);
  const figuresHidden = spoilers.hidden.length > 0;
  const careerHidden = windowHidden.length > 0;
  const hiddenNames = spoilers.hidden.map((h) => h.raceName);
  const list = figuresHidden
    ? [...(drivers ?? [])]
        .sort((a, b) =>
          (a.Driver.familyName ?? "").localeCompare(b.Driver.familyName ?? "")
        )
        // `positionText` too: the API sends it alongside `position`, and a
        // spread would otherwise carry it straight into the client props.
        .map((d) => ({ ...d, position: "", positionText: "", points: "", wins: "" }))
    : drivers ?? [];

  // The champion, once the title is mathematically decided. A result like any
  // other, so spoiler mode withholds it with the rest of the season figures.
  const title =
    !figuresHidden && races.length > 0 && (drivers ?? []).length >= 2
      ? computeTitleDecider(
          (drivers ?? []).slice(0, 2).map((d) => ({
            name: `${d.Driver.givenName ?? ""} ${d.Driver.familyName ?? ""}`.trim(),
            points: Number(d.points) || 0,
          })),
          races,
          "driver",
          undefined,
          { season: year, standingsRound }
        )
      : null;
  const champion = title?.clinched ? (drivers ?? [])[0] : null;

  return (
    <div className="px-6 md:px-10 pt-11 pb-16">
      {list.length === 0 && <DegradedBeacon route="/drivers" />}
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 mb-7">
        <div>
          <span className="font-bold text-xs tracking-[0.18em] uppercase text-flame">
            {year} World Championship lineup
          </span>
          {/* An `h1`, not a styled div — see the note on the home page hero.
              Classes unchanged, so nothing moves. */}
          <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[52px] tracking-[-1.5px] mt-2">
            The Grid
          </h1>
          {champion && title && (
            <p className="mt-3 font-semibold text-sm text-warm-300">
              <span className="text-primary">
                {champion.Driver.givenName} {champion.Driver.familyName}
              </span>{" "}
              is the {year} World Champion
              {title.maxRemainingPoints > 0
                ? ` — ${title.gap} points clear with only ${title.maxRemainingPoints} left to win.`
                : "."}
            </p>
          )}
        </div>
        <SeasonSelector currentYear={year} maxYear={getActiveSeasonYear()} />
      </div>

      {list.length === 0 && (
        <div className="apex-glass-soft rounded-2xl px-6 py-12 text-center font-medium text-warm-400">
          Driver standings are unavailable right now.
        </div>
      )}

      {list.length > 0 && figuresHidden && (
        <SpoilerBanner
          className="mb-6"
          raceKey={spoilers.hidden.map((h) => h.raceKey)}
          raceName={hiddenNames}
          title={`Points and positions include the ${joinNames(hiddenNames)} ${hiddenNames.length > 1 ? "results" : "result"}`}
          description="Spoiler-free mode is on, so the grid is in surname order and season figures are hidden."
        />
      )}

      {list.length > 0 && !figuresHidden && (
        <CompareDriversPanel drivers={list} seasonYear={year} />
      )}

      <DriversGrid
        drivers={list}
        seasonFiguresHidden={figuresHidden}
        careerFiguresHidden={careerHidden}
        championId={champion?.Driver.driverId ?? null}
        seasonYear={year}
      />
    </div>
  );
}
