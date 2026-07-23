import { notFound } from "next/navigation";
import Link from "next/link";
import { getRaceResults, getSeasonRaces } from "@/lib/api";
import { getSessionKeyByDate, getStints } from "@/lib/openf1";
import { getTeamColor } from "@/lib/team-colors";
import TireStintsChart from "@/components/tire-stints-chart";

interface PageProps {
  params: Promise<{
    season: string;
    round: string;
  }>;
}

export default async function PitwallPage({ params }: PageProps) {
  const { season, round } = await params;
  const seasonYear = Number(season);
  const roundNumber = Number(round);

  if (!Number.isFinite(seasonYear) || !Number.isFinite(roundNumber)) {
    notFound();
  }

  // Neither call depends on the other's result — only getSessionKeyByDate
  // (below) needs the race date, so fire both up front instead of serially.
  const [racesRes, resultsRes] = await Promise.all([
    getSeasonRaces(seasonYear),
    getRaceResults(seasonYear, roundNumber),
  ]);
  const race = (racesRes.races ?? []).find((r) => r.round === String(roundNumber));

  if (!race || !race.date) {
    notFound();
  }

  const results = resultsRes.results ?? [];

  const drivers = results
    .filter((r) => r.Driver && r.number)
    .map((r) => ({
      driverId: r.Driver!.driverId ?? "",
      number: r.number ?? "",
      code: r.Driver!.code ?? "",
      givenName: r.Driver!.givenName ?? "",
      familyName: r.Driver!.familyName ?? "",
      teamColor: getTeamColor(r.Constructor?.name).hex,
    }));

  const sessionKey = await getSessionKeyByDate(seasonYear, race.date);
  // Fetched server-side so the chart never re-fetches on the client — also
  // fixes the client fetch bypassing fetchOpenF1's auth header.
  const initialStints = sessionKey
    ? await getStints(
        sessionKey,
        drivers.map((d) => Number(d.number)).filter((n) => Number.isFinite(n))
      )
    : [];

  return (
    <div className="px-6 md:px-10 pt-8 pb-16">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-6">
        <div>
          <span className="font-bold text-xs tracking-[0.18em] uppercase text-[#FF7A3D]">
            Telemetry lab
          </span>
          <h1 className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[56px] tracking-[-1.5px] leading-none mt-2">
            Pitwall <span className="apex-flame-text">Strategy</span>
          </h1>
          <p className="font-semibold text-[13px] text-warm-400 mt-2">
            {race.raceName} · Round {race.round}
          </p>
        </div>
        <Link
          href={`/schedule/${season}/${round}`}
          className="font-bold text-xs px-5 h-[46px] rounded-[11px] apex-glass-soft flex items-center justify-center hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-95"
        >
          ← Back to race
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        {/* Sidebar */}
        <aside>
          <h3 className="font-bold text-[11px] tracking-[0.18em] uppercase text-warm-500 mb-4">
            Analysis modules
          </h3>
          <nav className="flex flex-col gap-2.5">
            <button className="flex items-center justify-between px-5 py-4 rounded-2xl border border-[rgba(255,90,31,0.35)] bg-[rgba(255,90,31,0.1)] text-[#FFAE6A] w-full text-left transition-colors">
              <span className="font-bold text-[15px]">Tire Stints</span>
              <span className="material-symbols-outlined text-lg">
                chevron_right
              </span>
            </button>
            {["Lap Telemetry", "Race Control"].map((label) => (
              <button
                key={label}
                disabled
                className="flex items-center justify-between px-5 py-4 rounded-2xl apex-glass-soft opacity-50 cursor-not-allowed w-full text-left"
              >
                <span className="font-bold text-[15px]">{label}</span>
                <span className="text-[10px] uppercase tracking-[0.1em] text-warm-500 font-bold rounded-md bg-[rgba(245,235,222,0.06)] px-2 py-1">
                  Soon
                </span>
              </button>
            ))}
          </nav>
        </aside>

        {/* Main Content Area */}
        <main>
          {sessionKey ? (
            <TireStintsChart sessionKey={sessionKey} drivers={drivers} initialStints={initialStints} />
          ) : (
            <div className="apex-glass-soft rounded-2xl p-12 flex flex-col items-center justify-center text-center min-h-[500px]">
              <div className="w-14 h-14 rounded-[14px] bg-[rgba(255,90,31,0.1)] border border-[rgba(255,90,31,0.25)] flex items-center justify-center mb-5">
                <span className="material-symbols-outlined text-[#FF7A3D] text-2xl">
                  lock
                </span>
              </div>
              <h3 className="font-[family-name:var(--font-headline)] font-bold text-2xl mb-2">
                Telemetry data unavailable
              </h3>
              <p className="font-medium text-sm text-warm-400 max-w-md mx-auto">
                Detailed stint & strategy data for the {seasonYear} season
                requires a premium OpenF1 subscription. Historical data is
                available for the 2023–2025 seasons.
              </p>
              <div className="mt-7 flex gap-3">
                <Link
                  href="/schedule"
                  className="font-bold text-xs uppercase tracking-[0.1em] px-6 py-2.5 rounded-[11px] apex-glass-soft hover:border-[rgba(255,138,61,0.5)] transition-colors"
                >
                  View schedule
                </Link>
                <a
                  href="https://openf1.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-bold text-xs uppercase tracking-[0.1em] px-6 py-2.5 rounded-[11px] bg-[rgba(255,90,31,0.16)] text-[#FFAE6A] hover:bg-[rgba(255,90,31,0.24)] transition-colors"
                >
                  OpenF1 website
                </a>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
