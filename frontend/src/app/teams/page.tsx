import {
  getActiveSeasonYear,
  getConstructorStandings,
} from "@/lib/api";

const teamMeta: Record<
  string,
  { color: string; glow: string; gradient: string }
> = {
  "Red Bull": {
    color: "border-blue-600",
    glow: "hover:shadow-[0_0_40px_rgba(37,99,235,0.2)]",
    gradient: "rgba(37,99,235,0.15)",
  },
  Ferrari: {
    color: "border-red-600",
    glow: "hover:shadow-[0_0_40px_rgba(220,38,38,0.2)]",
    gradient: "rgba(220,38,38,0.15)",
  },
  Mercedes: {
    color: "border-teal-500",
    glow: "hover:shadow-[0_0_40px_rgba(20,184,166,0.2)]",
    gradient: "rgba(20,184,166,0.15)",
  },
  McLaren: {
    color: "border-orange-500",
    glow: "hover:shadow-[0_0_40px_rgba(249,115,22,0.2)]",
    gradient: "rgba(249,115,22,0.15)",
  },
  "Aston Martin": {
    color: "border-green-600",
    glow: "hover:shadow-[0_0_40px_rgba(22,163,74,0.2)]",
    gradient: "rgba(22,163,74,0.15)",
  },
  Alpine: {
    color: "border-pink-500",
    glow: "hover:shadow-[0_0_40px_rgba(236,72,153,0.2)]",
    gradient: "rgba(236,72,153,0.15)",
  },
  Williams: {
    color: "border-blue-400",
    glow: "hover:shadow-[0_0_40px_rgba(96,165,250,0.2)]",
    gradient: "rgba(96,165,250,0.15)",
  },
  RB: {
    color: "border-blue-500",
    glow: "hover:shadow-[0_0_40px_rgba(59,130,246,0.2)]",
    gradient: "rgba(59,130,246,0.15)",
  },
  Sauber: {
    color: "border-green-500",
    glow: "hover:shadow-[0_0_40px_rgba(34,197,94,0.2)]",
    gradient: "rgba(34,197,94,0.15)",
  },
  Haas: {
    color: "border-neutral-400",
    glow: "hover:shadow-[0_0_40px_rgba(163,163,163,0.2)]",
    gradient: "rgba(163,163,163,0.15)",
  },
};

function getTeamMeta(name?: string) {
  if (!name)
    return {
      color: "border-primary-container",
      glow: "",
      gradient: "rgba(0,242,255,0.15)",
    };
  const key = Object.keys(teamMeta).find((k) =>
    name.toLowerCase().includes(k.toLowerCase())
  );
  return key
    ? teamMeta[key]
    : {
        color: "border-primary-container",
        glow: "",
        gradient: "rgba(0,242,255,0.15)",
      };
}

export default async function TeamsPage() {
  const year = getActiveSeasonYear();
  let constructors: Awaited<ReturnType<typeof getConstructorStandings>>["constructor_standings"] = [];
  try {
    const res = await getConstructorStandings(year);
    constructors = res.constructor_standings ?? [];
  } catch {
    // Backend offline
  }

  return (
    <>
      {/* Hero Section */}
      <header className="relative pt-8 pb-16 px-8 overflow-hidden">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-secondary-container/10 blur-[120px] rounded-full -translate-y-1/2 translate-x-1/4" />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-primary-container/5 blur-[100px] rounded-full translate-y-1/2 -translate-x-1/4" />
        <div className="max-w-7xl mx-auto relative">
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-8">
            <div>
              <span className="text-primary-container font-[family-name:var(--font-label)] text-xs uppercase tracking-[0.3em] block mb-4">
                Constructor Standings {year}
              </span>
              <h1 className="text-6xl md:text-8xl font-[family-name:var(--font-headline)] font-black italic skew-x-[-10deg] tracking-tighter leading-none text-on-background">
                TEAMS &amp;{" "}
                <br />
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-primary-container to-secondary-container">
                  CHASSIS
                </span>
              </h1>
            </div>
            <div className="bg-surface-container-low p-6 border-l-4 border-primary-container skew-x-[-5deg]">
              <p className="text-neutral-400 max-w-xs skew-x-[5deg]">
                Explore the engineering marvels and technical powerhouses
                defining the peak of automotive performance this season.
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* Teams Grid */}
      <main className="px-8 pb-32">
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-12">
          {constructors.map((team) => {
            const name = team.Constructor.name ?? "—";
            const meta = getTeamMeta(name);
            const nationality = team.Constructor.nationality ?? "";

            return (
              <div
                key={name}
                className={`group relative bg-surface-container-lowest glass-card rounded-xl overflow-hidden ${meta.color} border-t-2 transition-all ${meta.glow}`}
              >
                <div className="p-8">
                  {/* Team Header */}
                  <div className="flex justify-between items-start mb-12">
                    <div>
                      <h2 className="text-3xl font-[family-name:var(--font-headline)] font-black italic skew-x-[-10deg] text-on-background mb-1">
                        {name.toUpperCase()}
                      </h2>
                      <div className="flex gap-4 font-[family-name:var(--font-label)] text-[10px] uppercase tracking-widest text-neutral-500">
                        <span>{nationality}</span>
                      </div>
                    </div>
                    <div className="w-16 h-16 bg-white/10 p-2 rounded-lg backdrop-blur-md flex items-center justify-center">
                      <span className="material-symbols-outlined text-3xl text-on-surface">
                        directions_car
                      </span>
                    </div>
                  </div>

                  {/* Car Render Placeholder */}
                  <div className="relative h-48 mb-8">
                    <div
                      className="absolute inset-0 rounded-lg"
                      style={{
                        background: `radial-gradient(circle at center, ${meta.gradient}, transparent)`,
                      }}
                    />
                    <div className="w-full h-full flex items-center justify-center relative z-10">
                      <span className="material-symbols-outlined text-[120px] text-neutral-800 group-hover:text-neutral-700 transition-colors group-hover:scale-105 duration-700">
                        directions_car
                      </span>
                    </div>
                  </div>

                  {/* Stats */}
                  <div className="grid grid-cols-2 gap-8 items-end">
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="font-[family-name:var(--font-label)] text-[10px] uppercase tracking-tighter text-neutral-400">
                          Position: P{team.position}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 text-right">
                      <div>
                        <span className="block font-[family-name:var(--font-label)] text-[10px] text-neutral-500 uppercase">
                          Wins
                        </span>
                        <span className="font-[family-name:var(--font-headline)] font-bold text-2xl italic">
                          {team.wins}
                        </span>
                      </div>
                      <div>
                        <span className="block font-[family-name:var(--font-label)] text-[10px] text-neutral-500 uppercase">
                          Season Pts
                        </span>
                        <span className="font-[family-name:var(--font-headline)] font-bold text-2xl text-on-background italic">
                          {team.points}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </>
  );
}
