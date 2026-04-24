import Image from "next/image";
import { getActiveSeasonYear, getDriverStandings } from "@/lib/api";
import {
  getDriverImagePath,
  hasDriverImage,
} from "@/lib/driver-images";
import { getFlagPath } from "@/lib/flags";

const teamColors: Record<string, { border: string; bar: string; glow: string }> = {
  "Red Bull": { border: "border-blue-600", bar: "bg-blue-600", glow: "hover:shadow-[0_0_30px_rgba(37,99,235,0.15)]" },
  McLaren: { border: "border-orange-500", bar: "bg-orange-500", glow: "hover:shadow-[0_0_30px_rgba(249,115,22,0.15)]" },
  Ferrari: { border: "border-red-600", bar: "bg-red-600", glow: "hover:shadow-[0_0_30px_rgba(220,38,38,0.15)]" },
  Mercedes: { border: "border-teal-500", bar: "bg-teal-500", glow: "hover:shadow-[0_0_30px_rgba(20,184,166,0.15)]" },
  "Aston Martin": { border: "border-green-600", bar: "bg-green-600", glow: "hover:shadow-[0_0_30px_rgba(22,163,74,0.15)]" },
  Alpine: { border: "border-pink-500", bar: "bg-pink-500", glow: "hover:shadow-[0_0_30px_rgba(236,72,153,0.15)]" },
  Williams: { border: "border-blue-400", bar: "bg-blue-400", glow: "hover:shadow-[0_0_30px_rgba(96,165,250,0.15)]" },
  RB: { border: "border-blue-500", bar: "bg-blue-500", glow: "hover:shadow-[0_0_30px_rgba(59,130,246,0.15)]" },
  Sauber: { border: "border-green-500", bar: "bg-green-500", glow: "hover:shadow-[0_0_30px_rgba(34,197,94,0.15)]" },
  Haas: { border: "border-neutral-400", bar: "bg-neutral-400", glow: "hover:shadow-[0_0_30px_rgba(163,163,163,0.15)]" },
};

function getTeamStyle(teamName?: string) {
  if (!teamName) return { border: "border-primary-container", bar: "bg-primary-container", glow: "" };
  const key = Object.keys(teamColors).find((k) => teamName.toLowerCase().includes(k.toLowerCase()));
  return key ? teamColors[key] : { border: "border-primary-container", bar: "bg-primary-container", glow: "" };
}

export default async function DriversPage() {
  const year = getActiveSeasonYear();
  let drivers: Awaited<ReturnType<typeof getDriverStandings>>["driver_standings"] = [];
  try {
    const res = await getDriverStandings(year);
    drivers = res.driver_standings ?? [];
  } catch {
    // Backend offline
  }

  const maxPoints = (drivers ?? []).length ? Number((drivers ?? [])[0].points) : 1;

  return (
    <div className="pt-8 pb-20 px-6 max-w-[1440px] mx-auto">
      {/* Header */}
      <header className="mb-16 relative">
        <div className="absolute -left-10 top-0 w-1 h-24 bg-primary-container shadow-[0_0_20px_#00f2ff]" />
        <h1 className="text-6xl md:text-8xl font-black font-[family-name:var(--font-headline)] skew-x-[-10deg] italic tracking-tighter uppercase mb-4">
          Grid <span className="text-primary-container">Command</span>
        </h1>
        <p className="font-[family-name:var(--font-label)] text-neutral-400 tracking-[0.2em] uppercase text-sm">
          {year} World Championship Lineup
        </p>
      </header>

      {/* Filters */}
      <div className="flex flex-wrap gap-4 mb-12 border-b border-outline-variant/30 pb-6">
        <button className="bg-surface-container-highest px-6 py-2 skew-x-[-10deg] border-l-2 border-primary-container transition-all hover:bg-primary-container hover:text-on-primary">
          <span className="skew-x-[10deg] inline-block font-[family-name:var(--font-label)] text-xs font-bold tracking-widest uppercase">
            All Drivers
          </span>
        </button>
        <button className="bg-surface-container-low px-6 py-2 skew-x-[-10deg] border-l-2 border-transparent transition-all hover:border-primary-container text-neutral-400 hover:text-on-background">
          <span className="skew-x-[10deg] inline-block font-[family-name:var(--font-label)] text-xs font-bold tracking-widest uppercase">
            Championship Top 10
          </span>
        </button>
      </div>

      {/* Drivers Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
        {(drivers ?? []).map((driver, idx) => {
          const givenName = driver.Driver.givenName ?? "";
          const familyName = driver.Driver.familyName ?? "";
          const name = `${givenName} ${familyName}`.trim();
          const teamName = driver.Constructors?.[0]?.name ?? "—";
          const style = getTeamStyle(teamName);
          const pts = Number(driver.points);
          const barWidth = maxPoints > 0 ? (pts / maxPoints) * 100 : 0;
          const number = driver.Driver.permanentNumber ?? String(idx + 1);
          const imgPath = getDriverImagePath(givenName, familyName);
          const hasImg = hasDriverImage(givenName, familyName);

          return (
            <div
              key={name || idx}
              className={`group relative overflow-hidden bg-surface-container-low ${style.border} border-t-2 shadow-2xl transition-all duration-500 hover:-translate-y-2 ${style.glow}`}
            >
              {/* Carbon pattern background */}
              <div className="absolute inset-0 carbon-pattern opacity-30 group-hover:opacity-50 transition-opacity" />

              {/* Large number background */}
              <div className="absolute top-4 right-4 z-[1] select-none pointer-events-none">
                <span className="text-[140px] font-black italic font-[family-name:var(--font-headline)] skew-x-[-10deg] leading-none text-white/[0.04] group-hover:text-white/[0.08] transition-all duration-700">
                  {number.padStart(2, "0")}
                </span>
              </div>

              <div className="relative p-6 flex flex-col h-full min-h-[420px]">
                {/* Header */}
                <div className="flex justify-between items-start mb-2 relative z-10">
                  <div>
                    <span className="font-[family-name:var(--font-label)] text-[10px] tracking-[0.3em] uppercase text-neutral-500 flex items-center gap-2">
                      {(() => {
                        const flagSrc = getFlagPath(driver.Driver.nationality);
                        return flagSrc ? (
                          <Image src={flagSrc} alt={driver.Driver.nationality ?? ""} width={16} height={11} className="object-contain opacity-70" />
                        ) : null;
                      })()}
                      {teamName}
                    </span>
                    <h2 className="text-2xl font-black font-[family-name:var(--font-headline)] skew-x-[-10deg] italic uppercase leading-tight">
                      <span className="text-neutral-400 block text-base font-semibold">
                        {givenName}
                      </span>
                      <span className="text-on-surface text-3xl">
                        {familyName.toUpperCase()}
                      </span>
                    </h2>
                  </div>
                </div>

                {/* Driver Image Area */}
                <div className="relative flex-1 flex items-end justify-center min-h-[200px]">
                  {hasImg && imgPath ? (
                    <div className="relative w-full h-[260px] flex items-end justify-center group-hover:scale-105 transition-transform duration-700 ease-out">
                      <Image
                        src={imgPath}
                        alt={name}
                        width={280}
                        height={280}
                        className="object-contain object-bottom drop-shadow-[0_10px_30px_rgba(0,0,0,0.8)]"
                        style={{ maxHeight: "100%" }}
                        priority={idx < 6}
                      />
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-[200px]">
                      <span className="material-symbols-outlined text-8xl text-neutral-800 group-hover:text-neutral-700 transition-colors">
                        person
                      </span>
                    </div>
                  )}
                </div>

                {/* Stats */}
                <div className="mt-4 space-y-3 relative z-20">
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-surface-container-highest/80 backdrop-blur-sm p-3 skew-x-[-10deg]">
                      <div className="skew-x-[10deg]">
                        <span className="block font-[family-name:var(--font-label)] text-[8px] uppercase text-neutral-500 tracking-tighter">
                          Wins
                        </span>
                        <span className="block text-xl font-bold font-[family-name:var(--font-headline)]">
                          {driver.wins}
                        </span>
                      </div>
                    </div>
                    <div className="bg-surface-container-highest/80 backdrop-blur-sm p-3 skew-x-[-10deg]">
                      <div className="skew-x-[10deg]">
                        <span className="block font-[family-name:var(--font-label)] text-[8px] uppercase text-neutral-500 tracking-tighter">
                          Points
                        </span>
                        <span className="block text-xl font-bold font-[family-name:var(--font-headline)]">
                          {driver.points}
                        </span>
                      </div>
                    </div>
                    <div className="bg-surface-container-highest/80 backdrop-blur-sm p-3 skew-x-[-10deg]">
                      <div className="skew-x-[10deg]">
                        <span className="block font-[family-name:var(--font-label)] text-[8px] uppercase text-neutral-500 tracking-tighter">
                          Pos
                        </span>
                        <span className="block text-xl font-bold font-[family-name:var(--font-headline)]">
                          P{driver.position}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="h-1 w-full bg-surface-variant overflow-hidden">
                    <div
                      className={`h-full ${style.bar}`}
                      style={{
                        width: `${barWidth}%`,
                        boxShadow: `0 0 10px currentColor`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
