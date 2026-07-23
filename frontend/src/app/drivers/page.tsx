import { getActiveSeasonYear, getDriverStandings, resolveSeasonYear } from "@/lib/api";
import DriversGrid from "@/components/drivers-grid";
import SeasonSelector from "@/components/season-selector";

// Driver standings change after every race; render per request.
export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ season?: string }>;
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
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-5 mb-7">
        <div>
          <span className="font-bold text-xs tracking-[0.18em] uppercase text-[#FF7A3D]">
            {year} World Championship lineup
          </span>
          <div className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[52px] tracking-[-1.5px] mt-2">
            The Grid
          </div>
        </div>
        <SeasonSelector currentYear={year} maxYear={getActiveSeasonYear()} />
      </div>

      {list.length === 0 && (
        <div className="apex-glass-soft rounded-2xl px-6 py-12 text-center font-medium text-warm-400">
          Driver standings are unavailable right now.
        </div>
      )}

      <DriversGrid drivers={list} />
    </div>
  );
}
