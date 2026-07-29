import type { Metadata } from "next";
import { getHistoricalRaceIndex } from "@/lib/api";

// Historical data barely changes (see api.ts's 24h revalidate on this
// endpoint) but the current season's tail does, race by race — render per
// request rather than pinning to a build-time snapshot, matching every
// other data-backed page in the app.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "APEX | F1 Heritage — 75 Seasons",
  description:
    "Every Formula 1 championship race since 1950, and the constructor lineages that ran them — the 75-Season Barcode and Constructor Genealogy.",
};

export default async function HistoryPage() {
  let raceCount = 0;
  let firstSeason: number | null = null;
  let lastSeason: number | null = null;

  try {
    const { races } = await getHistoricalRaceIndex("compact");
    raceCount = races.length;
    if (races.length > 0) {
      firstSeason = races[0].season;
      lastSeason = races[races.length - 1].season;
    }
  } catch {
    // Backend offline — sections below render their own empty states.
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

      {/* The 75-Season Barcode — built in CP48 (season-barcode.tsx). */}
      <section className="apex-glass apex-sheen rounded-[22px] p-[26px] mb-8">
        <div className="font-[family-name:var(--font-headline)] font-bold text-[19px] mb-1">
          The 75-Season Barcode
        </div>
        <div className="font-medium text-[13px] text-warm-400 mb-[18px]">
          Every race, one stripe, coloured by winning constructor.
        </div>
        <div className="rounded-xl border border-white/10 bg-[rgba(255,255,255,0.03)] p-8 text-center text-warm-500 text-sm">
          {raceCount > 0 ? `${raceCount} races indexed — barcode coming in CP48.` : "Historical data unavailable."}
        </div>
      </section>

      {/* Constructor Genealogy — built in CP49 (constructor-genealogy.tsx). */}
      <section className="apex-glass apex-sheen rounded-[22px] p-[26px]">
        <div className="font-[family-name:var(--font-headline)] font-bold text-[19px] mb-1">
          Constructor Genealogy
        </div>
        <div className="font-medium text-[13px] text-warm-400 mb-[18px]">
          Tyrrell became BAR became Honda became Brawn became Mercedes —
          the family tree behind the grid.
        </div>
        <div className="rounded-xl border border-white/10 bg-[rgba(255,255,255,0.03)] p-8 text-center text-warm-500 text-sm">
          Genealogy tree coming in CP49.
        </div>
      </section>
    </div>
  );
}
