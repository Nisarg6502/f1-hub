import { notFound } from "next/navigation";
import Link from "next/link";
import { getRaceResults, getSeasonRaces } from "@/lib/api";
import { getSessionKeyByDate, getStints, getRaceControl } from "@/lib/openf1";
import { getDriverImagePath } from "@/lib/driver-images";
import Image from "next/image";

interface PageProps {
  params: Promise<{
    season: string;
    round: string;
  }>;
}

const COMPOUND_COLORS: Record<string, string> = {
  SOFT: "bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.5)]",
  MEDIUM: "bg-yellow-400 shadow-[0_0_15px_rgba(250,204,21,0.5)]",
  HARD: "bg-white shadow-[0_0_15px_rgba(255,255,255,0.5)] text-black",
  INTERMEDIATE: "bg-green-500 shadow-[0_0_15px_rgba(34,197,94,0.5)]",
  WET: "bg-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]",
};

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

  // 2. Get Top 3 Drivers from Ergast
  const resultsRes = await getRaceResults(seasonYear, roundNumber);
  const results = resultsRes.results ?? [];
  const topDrivers = results.slice(0, 3);
  
  const driverNumbers = topDrivers
    .map(r => parseInt(r.Driver?.permanentNumber ?? "0", 10))
    .filter(n => n > 0);

  if (driverNumbers.length === 0) {
    return <div className="p-12 text-center text-neutral-400">No driver data available for this race yet.</div>;
  }

  // 3. Get OpenF1 Session Key
  const sessionKey = await getSessionKeyByDate(seasonYear, race.date);

  let stints: any[] = [];
  let raceControl: any[] = [];

  if (sessionKey) {
    [stints, raceControl] = await Promise.all([
      getStints(sessionKey, driverNumbers),
      getRaceControl(sessionKey)
    ]);
  }

  // Calculate total laps for scaling
  const totalLaps = Math.max(...stints.map(s => s.lap_end ?? 0), 1);

  // Filter Safety Cars
  const safetyCars = raceControl.filter(rc => rc.category === "SafetyCar" && rc.message?.includes("DEPLOYED"));
  const safetyCarEnding = raceControl.filter(rc => rc.category === "SafetyCar" && rc.message?.includes("IN THIS LAP"));

  return (
    <div className="px-6 lg:px-12 max-w-[1600px] mx-auto pt-4 pb-20">
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

      {!sessionKey ? (
        <div className="glass-panel p-12 text-center text-neutral-400 italic">
          Detailed telemetry not available for this session via OpenF1.
        </div>
      ) : (
        <div className="glass-panel p-8 md:p-12 relative overflow-hidden">
          <h3 className="font-[family-name:var(--font-headline)] font-bold text-2xl skew-heading uppercase italic tracking-tight mb-8 text-on-background">
            Tire Stint Analysis (Top 3)
          </h3>

          <div className="space-y-12 relative">
            {topDrivers.map(driverResult => {
              const driverNum = parseInt(driverResult.Driver?.permanentNumber ?? "0", 10);
              const driverStints = stints.filter(s => s.driver_number === driverNum).sort((a, b) => a.lap_start - b.lap_start);
              const imgPath = getDriverImagePath(driverResult.Driver?.givenName, driverResult.Driver?.familyName);

              return (
                <div key={driverNum} className="relative z-10">
                  <div className="flex items-center gap-4 mb-4">
                    <div className="text-3xl font-[family-name:var(--font-headline)] font-black italic skew-x-[-12deg] text-neutral-600">
                      P{driverResult.position}
                    </div>
                    {imgPath && (
                      <div className="w-10 h-10 rounded-full overflow-hidden bg-neutral-800/50 flex-shrink-0">
                        <Image src={imgPath} alt="Driver" width={40} height={40} className="object-cover object-top scale-125" />
                      </div>
                    )}
                    <div>
                      <h4 className="font-bold uppercase tracking-wide text-lg leading-tight">
                        {driverResult.Driver?.givenName} {driverResult.Driver?.familyName}
                      </h4>
                      <div className="text-[10px] text-neutral-500 uppercase tracking-widest">
                        {driverResult.Constructor?.name}
                      </div>
                    </div>
                  </div>

                  <div className="relative h-12 bg-surface-container-lowest/50 rounded-sm border border-outline-variant/30 overflow-hidden group">
                    {/* Tick marks for laps */}
                    <div className="absolute inset-0 flex justify-between pointer-events-none opacity-20">
                      {Array.from({ length: 10 }).map((_, i) => (
                        <div key={i} className="h-full border-l border-neutral-600 border-dashed" />
                      ))}
                    </div>

                    {/* Stints */}
                    {driverStints.map((stint, idx) => {
                      const startLap = stint.lap_start ?? 1;
                      const endLap = stint.lap_end ?? totalLaps;
                      const widthPct = ((endLap - startLap + 1) / totalLaps) * 100;
                      const leftPct = ((startLap - 1) / totalLaps) * 100;
                      const compound = stint.compound ?? "UNKNOWN";
                      const colorClass = COMPOUND_COLORS[compound] ?? "bg-neutral-600";

                      return (
                        <div
                          key={idx}
                          className={`absolute top-0 h-full ${colorClass} flex items-center justify-center border-r-2 border-[#09090b] transition-all hover:brightness-125`}
                          style={{ width: `${widthPct}%`, left: `${leftPct}%` }}
                          title={`Laps ${startLap}-${endLap} (${compound})`}
                        >
                          {widthPct > 5 && (
                            <span className="font-[family-name:var(--font-headline)] font-bold text-xs italic opacity-80 mix-blend-overlay px-1 truncate">
                              {compound}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Race Control Overlays */}
            {safetyCars.map((sc, i) => {
               // OpenF1 race control doesn't reliably give precise lap for SC in a simple way without joining laps, 
               // but we can just note it. Since mapping time to laps is complex without full lap data, 
               // we will render a global SC legend instead.
               return null;
            })}
          </div>

          <div className="mt-12 pt-6 border-t border-outline-variant/30 grid grid-cols-2 md:grid-cols-5 gap-4">
            {Object.entries(COMPOUND_COLORS).map(([name, cls]) => (
              <div key={name} className="flex items-center gap-2">
                <div className={`w-4 h-4 rounded-full ${cls}`} />
                <span className="text-[10px] uppercase tracking-widest text-neutral-400 font-bold">{name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
