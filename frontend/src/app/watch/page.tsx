import type { Metadata } from "next";
import Link from "next/link";
import { getActiveSeasonYear, getSeasonRaces, resolveSeasonYear } from "@/lib/api";
import { completedRacesNewestFirst, toRaceId } from "@/lib/watch-races";

export const metadata: Metadata = {
  title: "APEX | Watch party",
  description:
    "Replay a completed Formula 1 race at the pace it was actually run, full screen, for watching alongside a broadcast.",
};

// Which rounds have finished depends on the current time, and the round most
// people want is the one that just ran.
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ season?: string }>;
}

export default async function WatchIndexPage({ searchParams }: PageProps) {
  const { season: seasonParam } = await searchParams;
  const season = resolveSeasonYear(seasonParam);
  const activeSeason = getActiveSeasonYear();

  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  try {
    races = (await getSeasonRaces(season)).races ?? [];
  } catch {
    races = [];
  }

  const completed = completedRacesNewestFirst(races ?? []);

  // Deliberately *not* probed for sync status. Checking would mean pulling a
  // megabyte-scale replay payload per round just to grey out a card, and the
  // race page already turns an unprocessed round into an offer of one that
  // works — so nothing here can dead-end.
  const seasons = [activeSeason, activeSeason - 1, activeSeason - 2].filter(
    (year) => year >= 2018
  );

  return (
    <div className="px-6 md:px-10 pt-8 pb-16 max-w-[1100px] mx-auto">
      <div className="flex items-center gap-4 mb-7">
        <Link
          href="/"
          className="font-bold text-xs px-4 h-[40px] rounded-control apex-glass-soft flex items-center justify-center hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-95 flex-none"
        >
          ← APEX
        </Link>
        <div className="ml-auto flex items-center gap-1.5">
          {seasons.map((year) => (
            <Link
              key={year}
              href={`/watch?season=${year}`}
              aria-current={year === season ? "page" : undefined}
              className={`font-bold text-xs px-3.5 h-[40px] rounded-control flex items-center justify-center transition-colors duration-150 ${
                year === season
                  ? "bg-[rgba(255,90,31,0.18)] text-primary"
                  : "text-warm-400 hover:text-on-background"
              }`}
            >
              {year}
            </Link>
          ))}
        </div>
      </div>

      <p className="font-bold text-[10px] tracking-[0.14em] uppercase text-flame">
        Watch party
      </p>
      <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[52px] tracking-[-1.5px] leading-none mt-2">
        Watch a race at <span className="apex-flame-text">real pace</span>
      </h1>
      {/* The honest framing, up front and in the feature's own words. This app
          has no live feed and this page must never imply otherwise. */}
      <p className="font-medium text-sm md:text-[15px] text-warm-300 mt-4 max-w-2xl leading-relaxed">
        A full-screen timing tower that advances on each lap&apos;s own recorded
        duration — a safety-car lap takes as long here as it did on the day.
        It&apos;s a replay of stored timing data, not a live feed, so start it
        as the lights go out and use <span className="text-warm-100">Jump to lap</span> to
        line it back up with your TV whenever it drifts.
      </p>

      <h2 className="font-bold text-[11px] tracking-[0.14em] uppercase text-warm-500 mt-10 mb-3">
        {season} · completed rounds
      </h2>

      {completed.length === 0 ? (
        <div className="apex-glass-soft rounded-2xl px-6 py-14 text-center">
          <div className="font-[family-name:var(--font-headline)] font-bold text-xl">
            Nothing to watch yet
          </div>
          <p className="font-medium text-sm text-warm-400 mt-2">
            No round of the {season} season has been run.
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {completed.map((race) => (
            <Link
              key={race.round}
              href={`/watch/${toRaceId(season, race.round)}`}
              className="apex-glass-soft rounded-tile px-5 py-[18px] hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-[0.99] block"
            >
              <p className="font-semibold text-[10px] tracking-[0.12em] uppercase text-warm-500">
                Round {race.round}
              </p>
              <p className="font-[family-name:var(--font-headline)] font-extrabold text-lg mt-1 leading-tight">
                {race.raceName.replace(" Grand Prix", "")} GP
              </p>
              <p className="font-medium text-xs text-warm-400 mt-1.5 truncate">
                {race.Circuit?.circuitName ?? ""}
              </p>
              {race.winner && (
                <p className="font-semibold text-[11px] text-warm-300 mt-2">
                  Won by {race.winner.givenName} {race.winner.familyName}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
