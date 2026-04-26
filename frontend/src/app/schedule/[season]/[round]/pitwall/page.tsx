import { notFound } from "next/navigation";
import Link from "next/link";
import { getRaceResults, getSeasonRaces } from "@/lib/api";
import { getSessionKeyByDate } from "@/lib/openf1";
import TireStintsChart from "@/components/tire-stints-chart";

interface PageProps {
  params: Promise<{
    season: string;
    round: string;
  }>;
}

const teamColorMap: Record<string, string> = {
  "red bull": "#1e41ff",
  mclaren: "#ff8000",
  ferrari: "#dc0000",
  mercedes: "#27f4d2",
  "aston martin": "#229971",
  alpine: "#ff87bc",
  williams: "#005aff",
  rb: "#6692ff",
  sauber: "#52e252",
  haas: "#b6babd",
};

function getTeamColor(teamName?: string) {
  if (!teamName) return "#ffffff";
  const lower = teamName.toLowerCase();
  const match = Object.keys(teamColorMap).find((k) => lower.includes(k));
  return match ? teamColorMap[match] : "#ffffff";
}

export default async function PitwallPage({ params }: PageProps) {
  const { season, round } = await params;
  const seasonYear = Number(season);
  const roundNumber = Number(round);

  if (!Number.isFinite(seasonYear) || !Number.isFinite(roundNumber)) {
    notFound();
  }

  // 1. Get Race Date from Ergast
  const racesRes = await getSeasonRaces(seasonYear);
  const race = (racesRes.races ?? []).find((r) => r.round === String(roundNumber));
  
  if (!race || !race.date) {
    notFound();
  }

  // 2. Get Drivers from Ergast
  const resultsRes = await getRaceResults(seasonYear, roundNumber);
  const results = resultsRes.results ?? [];
  
  const drivers = results
    .filter((r) => r.Driver && r.number)
    .map((r) => ({
      driverId: r.Driver!.driverId ?? "",
      number: r.number ?? "",
      code: r.Driver!.code ?? "",
      givenName: r.Driver!.givenName ?? "",
      familyName: r.Driver!.familyName ?? "",
      teamColor: getTeamColor(r.Constructor?.name),
    }));

  // 3. Get OpenF1 Session Key
  const sessionKey = await getSessionKeyByDate(seasonYear, race.date);

  return (
    <div className="px-6 lg:px-12 max-w-[1920px] mx-auto pt-4 pb-20">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-12 gap-6">
        <div className="space-y-2">
          <div className="flex items-center gap-3 mb-4">
            <span className="material-symbols-outlined text-primary-container text-4xl neon-text-cyan">
              analytics
            </span>
            <span className="text-primary-container font-[family-name:var(--font-label)] text-xs tracking-widest uppercase font-bold">
              Telemetry Lab
            </span>
          </div>
          <h1 className="text-5xl lg:text-7xl font-black font-[family-name:var(--font-headline)] italic skew-x-[-12deg] uppercase tracking-tighter leading-none">
            PITWALL <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary-container to-secondary-container">STRATEGY</span>
          </h1>
          <p className="text-neutral-500 font-[family-name:var(--font-label)] tracking-widest text-sm uppercase">
            {race.raceName} · Round {race.round}
          </p>
        </div>
        <Link
          href={`/schedule/${season}/${round}`}
          className="font-[family-name:var(--font-label)] text-xs uppercase tracking-widest text-neutral-400 hover:text-white flex items-center gap-2 transition-colors"
        >
          <span className="material-symbols-outlined text-sm">arrow_back</span>
          Back to Race
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Sidebar */}
        <aside className="lg:col-span-3 space-y-4">
          <h3 className="font-[family-name:var(--font-label)] text-xs font-bold text-neutral-500 tracking-widest uppercase mb-6">
            Analysis Modules
          </h3>
          <nav className="flex flex-col space-y-2">
            <button className="flex items-center justify-between p-5 bg-surface-container-high border-l-4 border-primary-container text-primary-container group transition-all duration-300 w-full text-left">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined">donut_large</span>
                <span className="font-[family-name:var(--font-headline)] font-bold text-xl italic tracking-tight">
                  Tire Stints
                </span>
              </div>
              <span className="material-symbols-outlined">chevron_right</span>
            </button>
            <button
              disabled
              className="flex items-center justify-between p-5 bg-surface-container opacity-50 cursor-not-allowed group transition-all duration-300 w-full text-left"
            >
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined">query_stats</span>
                <span className="font-[family-name:var(--font-headline)] font-bold text-xl italic tracking-tight">
                  Lap Telemetry
                </span>
              </div>
              <span className="text-[10px] uppercase tracking-widest text-neutral-500 font-bold border border-neutral-700 px-2 py-1">
                Soon
              </span>
            </button>
            <button
              disabled
              className="flex items-center justify-between p-5 bg-surface-container opacity-50 cursor-not-allowed group transition-all duration-300 w-full text-left"
            >
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined">flag</span>
                <span className="font-[family-name:var(--font-headline)] font-bold text-xl italic tracking-tight">
                  Race Control
                </span>
              </div>
              <span className="text-[10px] uppercase tracking-widest text-neutral-500 font-bold border border-neutral-700 px-2 py-1">
                Soon
              </span>
            </button>
          </nav>
        </aside>

        {/* Main Content Area */}
        <main className="lg:col-span-9">
          <TireStintsChart sessionKey={sessionKey} drivers={drivers} />
        </main>
      </div>
    </div>
  );
}
