import { getActiveSeasonYear, getDriverStandings } from "@/lib/api";
import DriversGrid from "@/components/drivers-grid";

// Driver standings change after every race; render per request.
export const dynamic = "force-dynamic";

export default async function DriversPage() {
  const year = getActiveSeasonYear();
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
      <div className="mb-7">
        <span className="font-bold text-xs tracking-[0.18em] uppercase text-[#FF7A3D]">
          {year} World Championship lineup
        </span>
        <div className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[52px] tracking-[-1.5px] mt-2">
          The Grid
        </div>
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
