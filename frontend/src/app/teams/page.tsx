import { getActiveSeasonYear, getConstructorStandings } from "@/lib/api";
import { getEngineForTeam } from "@/lib/engines";
import { getTeamColor } from "@/lib/team-colors";
import TiltCard from "@/components/tilt-card";

// Constructor standings change after every race; render per request.
export const dynamic = "force-dynamic";

export default async function TeamsPage() {
  const year = getActiveSeasonYear();
  let constructors: Awaited<
    ReturnType<typeof getConstructorStandings>
  >["constructor_standings"] = [];
  try {
    const res = await getConstructorStandings(year);
    constructors = res.constructor_standings ?? [];
  } catch {
    // Backend offline
  }

  const list = constructors ?? [];

  // Group constructors by their power-unit supplier
  const engineGroups = new Map<string, string[]>();
  for (const t of list) {
    const name = t.Constructor.name ?? "";
    const engine = getEngineForTeam(name);
    if (!engine) continue;
    const arr = engineGroups.get(engine.name) ?? [];
    arr.push(name);
    engineGroups.set(engine.name, arr);
  }

  return (
    <div className="px-6 md:px-10 pt-11 pb-16">
      {/* Header */}
      <div className="mb-7">
        <span className="font-bold text-xs tracking-[0.18em] uppercase text-[#FF7A3D]">
          Constructor standings {year}
        </span>
        <div className="font-[family-name:var(--font-headline)] font-extrabold text-4xl md:text-[52px] tracking-[-1.5px] mt-2">
          Teams &amp; Chassis
        </div>
      </div>

      {list.length === 0 && (
        <div className="apex-glass-soft rounded-2xl px-6 py-12 text-center font-medium text-warm-400">
          Constructor standings are unavailable right now.
        </div>
      )}

      {/* Team cards */}
      <div className="grid md:grid-cols-2 gap-4 mb-10 [perspective:1400px]">
        {list.map((team, idx) => {
          const name = team.Constructor.name ?? "—";
          const color = getTeamColor(name);
          const engine = getEngineForTeam(name);
          const mono = name.slice(0, 2).toUpperCase();

          return (
            <TiltCard
              key={name || idx}
              className="apex-glass rounded-[20px] overflow-hidden p-[26px] min-h-[200px] anim-rise"
              style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}
              strength={5}
            >
              {/* corner wash + blurred blob */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  background: `radial-gradient(140% 90% at 100% 0%, ${color.hex}22, transparent 60%)`,
                }}
              />
              <div
                className="absolute -right-10 -top-5 w-[200px] h-[200px] rounded-full blur-[30px] opacity-[0.16] pointer-events-none"
                style={{ background: color.hex }}
              />

              <div className="relative flex items-start justify-between">
                <div className="min-w-0">
                  <div className="font-[family-name:var(--font-headline)] font-extrabold text-2xl md:text-[28px] tracking-[-0.5px] truncate">
                    {name}
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5 mt-2">
                    <span className="font-semibold text-[11px] tracking-[0.08em] uppercase text-warm-400">
                      {team.Constructor.nationality}
                    </span>
                    {engine && (
                      <span className="font-semibold text-[10px] tracking-[0.04em] uppercase px-2.5 py-[5px] rounded-[7px] bg-[rgba(245,235,222,0.06)] text-warm-200">
                        Power · {engine.name}
                      </span>
                    )}
                  </div>
                </div>
                <div
                  className="w-[54px] h-[54px] rounded-[14px] flex items-center justify-center font-[family-name:var(--font-headline)] font-extrabold text-xl flex-none"
                  style={{ background: color.hex, color: "#0a0908" }}
                >
                  {mono}
                </div>
              </div>

              <div className="relative mt-8 flex items-end justify-between">
                <div>
                  <div className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500">
                    Position
                  </div>
                  <div className="font-[family-name:var(--font-headline)] font-extrabold text-xl text-[#FFAE6A]">
                    P{team.position}
                  </div>
                </div>
                <div className="text-center">
                  <div className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500">
                    Wins
                  </div>
                  <div className="font-extrabold text-[22px] tabular-nums">
                    {team.wins}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-[10px] tracking-[0.1em] uppercase text-warm-500">
                    Season pts
                  </div>
                  <div className="font-extrabold text-[22px] tabular-nums">
                    {team.points}
                  </div>
                </div>
              </div>
            </TiltCard>
          );
        })}
      </div>

      {/* Power units */}
      {engineGroups.size > 0 && (
        <>
          <div className="font-[family-name:var(--font-headline)] font-bold text-[19px] mb-4">
            Power units
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
            {[...engineGroups.entries()].map(([engineName, teams]) => (
              <div
                key={engineName}
                className="apex-glass-soft rounded-[14px] px-5 py-[18px]"
              >
                <div className="font-bold text-sm">{engineName}</div>
                <div className="font-medium text-xs text-warm-400 mt-1.5">
                  {teams.join(" · ")}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
