import { getActiveSeasonYear, getSeasonRaces } from "@/lib/api";

export default async function CircuitsPage() {
  const year = getActiveSeasonYear();
  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  try {
    const racesRes = await getSeasonRaces(year);
    races = racesRes.races ?? [];
  } catch {
    // Backend offline
  }

  // Use the first race as the featured track
  const featured = races[0];

  // Color accents for gallery cards
  const accentColors = [
    "bg-secondary-container",
    "bg-primary-container",
    "bg-tertiary-container",
    "bg-secondary-container",
  ];

  const cardIcons = ["polyline", "conversion_path", "gesture", "directions_run", "route", "fork_right", "alt_route", "moving"];

  return (
    <>
      {/* Hero Section */}
      <div className="pt-8 pb-12 px-8 max-w-[1920px] mx-auto">
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-20">
          {/* Main Featured Track */}
          <div className="lg:col-span-8 relative group">
            <div className="absolute -top-10 -left-10 w-64 h-64 bg-primary-container/10 blur-[120px] rounded-full" />
            <div className="glass-panel p-8 relative overflow-hidden h-[600px] flex flex-col justify-end">
              {/* Track Visualization */}
              <div className="absolute inset-0 flex items-center justify-center p-12">
                <div className="w-full h-full relative">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="material-symbols-outlined text-[400px] text-primary-container/40 neon-text-cyan opacity-80">
                      route
                    </span>
                    <div className="absolute top-1/4 left-1/2 w-32 h-2 bg-secondary-container neon-glow-primary rotate-45 blur-sm opacity-60" />
                    <div className="absolute bottom-1/3 right-1/4 w-48 h-2 bg-tertiary-container neon-glow-primary -rotate-12 blur-sm opacity-60" />
                  </div>
                </div>
              </div>

              <div className="relative z-10">
                <div className="flex items-center space-x-4 mb-4">
                  <span className="bg-tertiary-container text-on-tertiary px-3 py-1 text-[10px] font-black font-[family-name:var(--font-label)] tracking-[0.2em] uppercase">
                    FEATURED TRACK
                  </span>
                  {featured && (
                    <span className="text-primary-container font-[family-name:var(--font-label)] text-xs tracking-widest uppercase">
                      Round {featured.round}:{" "}
                      {featured.Circuit?.Location?.locality?.toUpperCase()}
                    </span>
                  )}
                </div>
                <h1 className="text-7xl font-black font-[family-name:var(--font-headline)] skew-heading leading-none uppercase mb-6 text-on-background tracking-tighter">
                  {featured?.Circuit?.circuitName?.toUpperCase() ??
                    "WORLD CIRCUITS"}
                </h1>
              </div>
            </div>
          </div>

          {/* Tech Specs Side Panel */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            <div className="glass-panel p-6 flex-1 border-l-4 border-primary-container">
              <h3 className="font-[family-name:var(--font-headline)] font-bold text-xl skew-heading uppercase mb-6 italic tracking-tight">
                Circuit DNA
              </h3>
              <div className="space-y-6">
                <div className="flex justify-between items-end border-b border-outline-variant pb-2">
                  <div>
                    <p className="text-outline font-[family-name:var(--font-label)] text-[10px] uppercase tracking-widest">
                      Total Circuits
                    </p>
                    <p className="font-[family-name:var(--font-headline)] font-bold text-2xl tracking-tighter italic">
                      {races.length}
                    </p>
                  </div>
                  <span className="material-symbols-outlined text-primary-container">
                    straighten
                  </span>
                </div>
                <div className="flex justify-between items-end border-b border-outline-variant pb-2">
                  <div>
                    <p className="text-outline font-[family-name:var(--font-label)] text-[10px] uppercase tracking-widest">
                      Season
                    </p>
                    <p className="font-[family-name:var(--font-headline)] font-bold text-2xl tracking-tighter italic">
                      {year}
                    </p>
                  </div>
                  <span className="material-symbols-outlined text-primary-container">
                    history
                  </span>
                </div>
                {featured && (
                  <>
                    <div className="flex justify-between items-end border-b border-outline-variant pb-2">
                      <div>
                        <p className="text-outline font-[family-name:var(--font-label)] text-[10px] uppercase tracking-widest">
                          First Race
                        </p>
                        <p className="font-[family-name:var(--font-headline)] font-bold text-xl tracking-tighter italic">
                          {featured.raceName}
                        </p>
                      </div>
                      <span className="material-symbols-outlined text-primary-container">
                        flag
                      </span>
                    </div>
                    <div className="flex justify-between items-end border-b border-outline-variant pb-2">
                      <div>
                        <p className="text-outline font-[family-name:var(--font-label)] text-[10px] uppercase tracking-widest">
                          Location
                        </p>
                        <p className="font-[family-name:var(--font-headline)] font-bold text-xl tracking-tighter italic">
                          {featured.Circuit?.Location?.country ?? "TBC"}
                        </p>
                      </div>
                      <span className="material-symbols-outlined text-primary-container">
                        location_on
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Circuit Gallery Title */}
        <div className="flex items-end justify-between mb-10">
          <div>
            <h2 className="text-5xl font-black font-[family-name:var(--font-headline)] skew-heading italic uppercase tracking-tighter">
              World Tour
            </h2>
            <p className="text-outline font-[family-name:var(--font-label)] text-xs tracking-widest uppercase mt-2">
              {races.length} Destinations of Peak Performance
            </p>
          </div>
        </div>

        {/* Gallery Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
          {races.map((race, idx) => {
            const accent = accentColors[idx % accentColors.length];
            const icon = cardIcons[idx % cardIcons.length];
            const location = race.Circuit?.Location;

            return (
              <div
                key={`${race.round}-${race.raceName}`}
                className="group relative bg-surface-container-low overflow-hidden transition-all hover:scale-[1.02] duration-500"
              >
                <div className={`absolute top-0 left-0 w-full h-1 ${accent}`} />
                <div className="p-6 h-[400px] flex flex-col justify-between">
                  <div>
                    <div className="flex justify-between items-start mb-6">
                      <span className="text-[10px] font-black font-[family-name:var(--font-label)] text-outline tracking-widest">
                        {location?.locality?.toUpperCase() ?? `ROUND ${race.round}`}
                      </span>
                      <div className="w-8 h-5 bg-neutral-800 border border-neutral-700 flex items-center justify-center">
                        <span className="material-symbols-outlined text-xs text-neutral-600">
                          flag
                        </span>
                      </div>
                    </div>
                    <h3 className="font-[family-name:var(--font-headline)] font-black text-3xl skew-heading uppercase italic tracking-tighter mb-4 group-hover:text-primary-container transition-colors line-clamp-2" title={race.Circuit?.circuitName ?? ""}>
                      {race.Circuit?.circuitName?.toUpperCase() ??
                        race.raceName.replace(" Grand Prix", "").toUpperCase()}
                    </h3>
                  </div>

                  <div className="relative flex-1 flex items-center justify-center">
                    <span className="material-symbols-outlined text-9xl text-white/5 absolute transition-all group-hover:scale-110 group-hover:text-primary-container/20">
                      {icon}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="bg-surface-container-lowest p-3">
                      <p className="text-[8px] text-outline uppercase tracking-widest mb-1">
                        Country
                      </p>
                      <p className="text-sm font-[family-name:var(--font-headline)] font-bold">
                        {location?.country ?? "TBC"}
                      </p>
                    </div>
                    <div className="bg-surface-container-lowest p-3">
                      <p className="text-[8px] text-outline uppercase tracking-widest mb-1">
                        Round
                      </p>
                      <p className="text-sm font-[family-name:var(--font-headline)] font-bold">
                        {race.round}
                      </p>
                    </div>
                  </div>
                </div>
                <div className="absolute bottom-0 left-0 w-0 h-[2px] bg-primary-container group-hover:w-full transition-all duration-700" />
              </div>
            );
          })}
        </div>

        {/* Bottom Bento Section */}
        <div className="mt-32 grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 glass-panel p-8 relative overflow-hidden flex items-center">
            <div className="relative z-10 w-full md:w-2/3">
              <h4 className="font-[family-name:var(--font-headline)] font-black text-4xl skew-heading italic uppercase tracking-tighter mb-4">
                G-Force Analysis
              </h4>
              <p className="text-on-surface-variant text-sm mb-6 leading-relaxed">
                Experience the crushing forces at every apex. Our technical
                analysis breaks down every turn into precise gravitational data
                points.
              </p>
              <button className="flex items-center text-primary-container font-[family-name:var(--font-label)] text-xs font-bold tracking-[0.2em] uppercase group">
                Enter Telemetry Lab
                <span className="material-symbols-outlined ml-2 group-hover:translate-x-2 transition-transform">
                  trending_up
                </span>
              </button>
            </div>
          </div>
          <div className="bg-secondary-container p-8 flex flex-col justify-between group cursor-pointer">
            <span className="material-symbols-outlined text-on-secondary text-5xl">
              cloud
            </span>
            <div>
              <h4 className="font-[family-name:var(--font-headline)] font-black text-3xl skew-heading italic uppercase tracking-tighter text-on-secondary mb-2">
                Live Weather
              </h4>
              <p className="text-on-secondary/80 text-sm">
                Real-time track conditions and probability of rain for upcoming
                sessions.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
