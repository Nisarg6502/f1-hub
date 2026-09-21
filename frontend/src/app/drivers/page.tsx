import type { Metadata } from "next";
import { getActiveSeasonYear, getDriverStandings, resolveSeasonYear } from "@/lib/api";
import DriversGrid from "@/components/drivers-grid";
import SeasonSelector from "@/components/season-selector";
import CompareDriversPanel from "@/components/compare-drivers-panel";
import DegradedBeacon from "@/components/degraded-beacon";

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
  try {
    const res = await getDriverStandings(year);
    drivers = res.driver_standings ?? [];
  } catch {
    // Backend offline
  }

  const list = drivers ?? [];

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
        </div>
        <SeasonSelector currentYear={year} maxYear={getActiveSeasonYear()} />
      </div>

      {list.length === 0 && (
        <div className="apex-glass-soft rounded-2xl px-6 py-12 text-center font-medium text-warm-400">
          Driver standings are unavailable right now.
        </div>
      )}

      {list.length > 0 && <CompareDriversPanel drivers={list} seasonYear={year} />}

      <DriversGrid drivers={list} />
    </div>
  );
}
