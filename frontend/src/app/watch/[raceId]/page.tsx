import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getRaceReplay, getSeasonRaces } from "@/lib/api";
import { findWatchableFallback, parseRaceId, toRaceId } from "@/lib/watch-races";
import WatchView from "@/components/watch-view";

interface PageProps {
  params: Promise<{ raceId: string }>;
}

// Whether a round is synced changes during the hours after a race — the very
// window this mode is most likely to be opened in — so this page is rendered
// per request rather than cached at build time. `getRaceReplay` still carries
// its own hour-long revalidate, so a synced round is not re-fetched per view.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { raceId } = await params;
  const parsed = parseRaceId(raceId);
  if (!parsed) return { title: "APEX | Watch" };
  return {
    // "Watch", never "live": this is a replay and the title bar is user-facing
    // copy like any other.
    title: `APEX | Watch ${parsed.season} round ${parsed.round}`,
    description:
      "A completed Formula 1 race replayed at the pace it was actually run, for watching alongside a broadcast.",
  };
}

export default async function WatchRacePage({ params }: PageProps) {
  const { raceId } = await params;
  const parsed = parseRaceId(raceId);
  if (!parsed) notFound();

  const { season, round } = parsed;

  let replay = null;
  try {
    replay = await getRaceReplay(season, round);
  } catch {
    // Backend unreachable is indistinguishable to the viewer from "not
    // processed", and both want the same answer: offer something that works.
    replay = null;
  }

  if (replay?.synced && replay.laps.length > 0) {
    return <WatchView replay={replay} />;
  }

  /* ------------------------- nothing to replay ------------------------- */

  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  try {
    races = (await getSeasonRaces(season)).races ?? [];
  } catch {
    races = [];
  }
  const requested = races?.find((race) => Number(race.round) === round);
  const fallback = await findWatchableFallback(season, round, races ?? []);

  return (
    <div className="min-h-[100dvh] flex items-center justify-center px-6 py-16">
      <div className="apex-glass-strong rounded-3xl px-7 py-9 md:px-10 md:py-11 max-w-xl w-full">
        <p className="font-bold text-[10px] tracking-[0.14em] uppercase text-[#FF7A3D]">
          Watch party
        </p>
        <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-2xl md:text-3xl mt-2 leading-tight">
          {requested?.raceName ?? `${season} round ${round}`} isn&apos;t processed yet
        </h1>
        {/* Deliberately no "sync this round" button. Lap data comes from
            FastF1, which is intermittently IP-blocked from the backend's host,
            so an on-demand sync would fail unpredictably — an offer that
            usually doesn't work is worse than an honest wait. */}
        <p className="font-medium text-sm text-warm-300 mt-3 leading-relaxed">
          Lap-by-lap timing arrives on a scheduled sync after the chequered
          flag, usually within a few hours. Watch mode replays that stored
          data — there&apos;s no live feed behind it — so there&apos;s nothing
          to play until the round lands.
        </p>

        {fallback ? (
          <div className="mt-7">
            <p className="font-semibold text-[11px] tracking-[0.12em] uppercase text-warm-500">
              Ready to watch now
            </p>
            <Link
              href={`/watch/${toRaceId(season, fallback.race.round)}`}
              className="mt-2.5 flex items-center gap-4 rounded-2xl px-5 py-4 apex-glass-soft hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-[0.99]"
            >
              <span className="font-[family-name:var(--font-headline)] font-extrabold text-lg flex-1">
                {fallback.race.raceName}
                <span className="block font-[family-name:var(--font-body)] font-semibold text-xs text-warm-400 mt-1">
                  Round {fallback.race.round} · {fallback.totalLaps} laps
                </span>
              </span>
              <span className="font-bold text-sm text-[#FFAE6A]">Watch →</span>
            </Link>
          </div>
        ) : (
          <p className="font-semibold text-xs text-warm-500 mt-7">
            No other round in {season} has lap data cached either.
          </p>
        )}

        <div className="flex flex-wrap gap-3 mt-7">
          <Link
            href="/watch"
            className="font-bold text-xs px-5 h-[46px] rounded-[11px] apex-glass-soft flex items-center justify-center hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-95"
          >
            All races
          </Link>
          <Link
            href={`/schedule/${season}/${round}`}
            className="font-bold text-xs px-5 h-[46px] rounded-[11px] apex-glass-soft flex items-center justify-center hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-95"
          >
            Round {round} results
          </Link>
        </div>
      </div>
    </div>
  );
}
