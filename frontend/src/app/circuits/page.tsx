import Image from "next/image";
import { getActiveSeasonYear, getSeasonRaces, getCircuitDetails } from "@/lib/api";
import { getCircuitImagePath } from "@/lib/circuit-images";
import CircuitsGallery from "@/components/circuits-gallery";

// Circuit details are filled in by the sync job as the season runs, so this
// page must not be pinned to a build-time snapshot.
export const dynamic = "force-dynamic";

export default async function CircuitsPage() {
  const year = getActiveSeasonYear();
  let races: Awaited<ReturnType<typeof getSeasonRaces>>["races"] = [];
  let circuitDetails: Awaited<ReturnType<typeof getCircuitDetails>> = [];
  
  try {
    const [racesRes, details] = await Promise.all([
      getSeasonRaces(year),
      getCircuitDetails(year)
    ]);
    races = racesRes.races ?? [];
    circuitDetails = details ?? [];
  } catch {
    // Backend offline
  }

  // Use the first race as the featured track
  const featured = races[0];
  const featuredImagePath = featured ? getCircuitImagePath(featured.Circuit?.Location?.country, featured.Circuit?.Location?.locality, featured.Circuit?.circuitName) : null;

  return (
    <>
      {/* Hero Section */}
      <div className="pt-8 pb-12 px-8 max-w-[1920px] mx-auto">
        <section className="grid grid-cols-1 lg:grid-cols-12 gap-8 mb-20">
          {/* Main Featured Track */}
          <div className="lg:col-span-8 relative group">
            <div className="absolute -top-10 -left-10 w-64 h-64 bg-primary-container/10 blur-[120px] rounded-full" />
            <div className="glass-panel relative overflow-hidden h-[500px] lg:h-[600px] flex flex-col justify-end group">
              {/* Background Track Visualization */}
              <div className="absolute inset-y-12 right-0 left-0 lg:left-1/4 flex items-center justify-center pointer-events-none overflow-hidden">
                <div className="relative w-full h-full max-w-[800px]">
                  {featuredImagePath ? (
                    <Image 
                      src={featuredImagePath} 
                      alt="Featured Circuit Layout"
                      fill
                      className="object-contain object-right lg:object-center drop-shadow-[0_0_15px_rgba(255,255,255,0.05)] opacity-90 group-hover:opacity-100 group-hover:scale-[1.03] transition-all duration-700"
                      priority
                    />
                  ) : (
                    <span className="absolute inset-0 flex items-center justify-center material-symbols-outlined text-[300px] lg:text-[400px] text-primary-container/40 neon-text-cyan opacity-80">
                      route
                    </span>
                  )}
                </div>
              </div>

              {/* Text Gradient Overlay for Readability */}
              <div className="absolute inset-0 bg-gradient-to-t from-[#09090b] via-[#09090b]/60 to-transparent lg:bg-gradient-to-r lg:from-[#09090b] lg:via-[#09090b]/80 lg:to-transparent pointer-events-none" />

              {/* Text Section */}
              <div className="relative z-10 p-8 w-full lg:w-2/3 flex flex-col justify-end h-full">
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
                <h1 className="text-5xl lg:text-7xl font-black font-[family-name:var(--font-headline)] skew-heading leading-none uppercase text-on-background tracking-tighter">
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
        <CircuitsGallery races={races} circuitDetails={circuitDetails} />

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
