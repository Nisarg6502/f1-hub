import type { Metadata } from "next";
import {
  getActiveSeasonYear,
  getHistoricalRaceIndex,
  getSeasonRaces,
  getConstructorSeasons,
} from "@/lib/api";
import {
  filterToCurrentGrid,
  getAllErgastIds,
  resolveLineages,
} from "@/lib/constructor-lineages";
import SeasonBarcode from "@/components/season-barcode";
import ConstructorGenealogy from "@/components/constructor-genealogy";

// Historical data barely changes (see api.ts's 24h revalidate on this
// endpoint) but the current season's tail does, race by race — render per
// request rather than pinning to a build-time snapshot, matching every
// other data-backed page in the app.
export const dynamic = "force-dynamic";

/**
 * Run an async map over `items` with at most `limit` in flight at once.
 *
 * The genealogy fetch below needs this: ~9 of its ~40 ids are for
 * still-active constructors, which the backend never caches and re-resolves
 * from Jolpica on every call (see historical_index.py). Firing all of them
 * through a flat Promise.all sends a burst of ~9 simultaneous live requests,
 * which reliably trips Jolpica's rate limiter for more than one of them at
 * once — confirmed by hand: the same id that fails inside the burst returns
 * correct data instantly on its own, sequential request. A per-id retry does
 * not fix a burst problem; capping how many are ever in flight together does.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

export const metadata: Metadata = {
  title: "APEX | F1 Heritage",
  description:
    "Every Formula 1 championship race since 1950, and the constructor lineages that ran them — the Season Barcode and Constructor Genealogy.",
};

export default async function HistoryPage() {
  let raceCount = 0;
  let firstSeason: number | null = null;
  let lastSeason: number | null = null;
  let fullRaces: Awaited<ReturnType<typeof getHistoricalRaceIndex>>["races"] = [];
  let ghostSlots = 0;

  const activeSeason = getActiveSeasonYear();

  try {
    const { races } = await getHistoricalRaceIndex("full");
    fullRaces = races;
    raceCount = races.length;
    if (races.length > 0) {
      firstSeason = races[0].season;
      lastSeason = races[races.length - 1].season;
    }
  } catch {
    // Backend offline — sections below render their own empty states.
  }

  // The active season is partial — figure out how many scheduled rounds
  // haven't been run yet so the barcode can render deliberate "ghost slots"
  // for them instead of just stopping abruptly.
  try {
    const { races: scheduled } = await getSeasonRaces(activeSeason);
    const runRounds = fullRaces.filter((r) => r.season === activeSeason).length;
    ghostSlots = Math.max((scheduled?.length ?? 0) - runRounds, 0);
  } catch {
    // Schedule unavailable — barcode just renders the races it has.
  }

  // Constructor Genealogy: resolve every curated lineage node's real
  // active-year span from /api/constructor_seasons, one call per unique raw
  // Ergast constructorId referenced anywhere in constructor-lineages.ts, so
  // the chart's geometry is always real data rather than hand-typed years.
  //
  // A handful of these ids (whichever are still active this season —
  // mercedes, aston_martin, alpine, red_bull, rb, audi, williams, ferrari,
  // mclaren) have a most-recent season equal to the current year, so the
  // backend never caches them in Mongo and live-fetches Jolpica on every
  // call instead (see historical_index.py's /constructor_seasons
  // docstring). The backend does not retry a Jolpica 429 itself — it fails
  // soft to 200 OK with empty `seasons`, indistinguishable at the HTTP level
  // from a real empty result — so all of the resilience has to live here.
  //
  // A flat Promise.all over all ~40 ids fires all ~9 "live" ones at once,
  // which reliably trips Jolpica's rate limiter for MULTIPLE of them
  // simultaneously, not just one: confirmed by hand, the same id that comes
  // back empty inside that burst returns correct data instantly on its own,
  // sequential request immediately afterward. A per-id retry cannot fix a
  // burst problem on its own, because a short fixed delay can land the retry
  // inside the same still-active rate-limit window as every other retry
  // firing at the same moment. So this both caps how many requests are ever
  // in flight together (mapWithConcurrency) AND backs off with increasing,
  // jittered delays per id — every id's real data was verified live against
  // /api/constructor_seasons before this file shipped, so an empty result
  // here is Jolpica's limiter, not a bad id.
  let genealogyLineages: ReturnType<typeof resolveLineages> = [];
  try {
    const ids = getAllErgastIds();
    const results = await mapWithConcurrency(ids, 4, async (id) => {
      const maxAttempts = 4;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const { seasons } = await getConstructorSeasons(id);
          if (seasons.length > 0 || attempt === maxAttempts - 1) {
            return [id, seasons] as const;
          }
        } catch {
          // fall through to retry / final empty result below
        }
        const backoffMs = 300 * 2 ** attempt + Math.random() * 200;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
      return [id, []] as const;
    });
    const seasonsById = Object.fromEntries(results);
    // Only the lineages that end on a constructor still racing this season —
    // "Sauber → BMW Sauber → Sauber → Alfa Romeo → Kick Sauber → Audi" earns
    // its row because Audi is on the grid; Vanwall and classic Lotus don't.
    // The test is `final era's endYear >= activeSeason` against real
    // /api/constructor_seasons data, not a hardcoded team list — see
    // filterToCurrentGrid. Cross-checked against
    // /api/constructorstandings?year=2026, which returns exactly the same
    // eleven constructors this leaves standing.
    genealogyLineages = filterToCurrentGrid(
      resolveLineages(seasonsById),
      activeSeason
    );
  } catch {
    // Backend offline — the genealogy section renders its own empty state.
  }

  return (
    <div className="px-6 md:px-10 pt-10 pb-16">
      <section className="mb-10">
        <span className="font-bold text-[10px] tracking-[0.12em] uppercase px-2.5 py-1.5 rounded-lg bg-[rgba(255,90,31,0.16)] text-[#FFAE6A]">
          F1 Heritage
        </span>
        <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[44px] tracking-[-1px] leading-[0.98] mt-3">
          {firstSeason && lastSeason
            ? `${lastSeason - firstSeason + 1} Seasons. One Story.`
            : "75 Seasons. One Story."}
        </h1>
        <p className="font-medium text-[13px] text-warm-400 mt-3 max-w-[640px]">
          {raceCount > 0
            ? `${raceCount} championship races, ${firstSeason}–${lastSeason}, every winning constructor colour-coded — plus the tangled family tree of team renames, mergers and revivals behind them.`
            : "Every Formula 1 championship race since 1950, and the constructor lineages that ran them."}
        </p>
      </section>

      {/* The Season Barcode — built in CP48 (season-barcode.tsx).
          The span is computed, not written down. It used to read "The
          75-Season Barcode" directly beneath an h1 that computed "77 Seasons",
          so the page contradicted itself on one screen — and it would have
          drifted by another year every December. */}
      <section className="apex-glass apex-sheen rounded-[22px] p-[26px] mb-8">
        <h2 className="font-[family-name:var(--font-headline)] font-bold text-[19px] mb-1">
          {firstSeason && lastSeason
            ? `The ${lastSeason - firstSeason + 1}-Season Barcode`
            : "The Season Barcode"}
        </h2>
        <div className="font-medium text-[13px] text-warm-400 mb-[18px]">
          Every race, one stripe, coloured by winning constructor.
        </div>
        {fullRaces.length > 0 ? (
          <SeasonBarcode races={fullRaces} ghostSlots={ghostSlots} activeSeason={activeSeason} />
        ) : (
          <div className="rounded-xl border border-white/10 bg-[rgba(255,255,255,0.03)] p-8 text-center text-warm-500 text-sm">
            Historical data unavailable.
          </div>
        )}
      </section>

      {/* Constructor Genealogy — built in CP49 (constructor-genealogy.tsx). */}
      <section className="apex-glass apex-sheen rounded-[22px] p-[26px]">
        <div className="font-[family-name:var(--font-headline)] font-bold text-[19px] mb-1">
          Constructor Genealogy
        </div>
        <div className="font-medium text-[13px] text-warm-400 mb-[18px]">
          Tyrrell became BAR became Honda became Brawn became Mercedes — every
          constructor on the {activeSeason} grid, traced back to the team it
          started life as.
        </div>
        {genealogyLineages.length > 0 ? (
          <ConstructorGenealogy
            lineages={genealogyLineages}
            races={fullRaces}
          />
        ) : (
          <div className="rounded-xl border border-white/10 bg-[rgba(255,255,255,0.03)] p-8 text-center text-warm-500 text-sm">
            Historical data unavailable.
          </div>
        )}
      </section>
    </div>
  );
}
