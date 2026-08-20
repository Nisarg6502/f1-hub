import { getTeamColor } from "@/lib/team-colors";
import type { TeammateBattle } from "@/lib/season-results";

interface TeammateBattlePanelProps {
  battles: TeammateBattle[];
}

/**
 * Pure presentation. This used to fetch a season of race + qualifying results
 * from the browser in a `useEffect`, which meant it opened in a loading state
 * on every single mount and stayed there for ~24s (46 requests, none cached,
 * half of them for rounds that had not been run). The data is now derived on
 * the server in standings/page.tsx and arrives as a prop, so there is no
 * loading state left to render.
 */
export default function TeammateBattlePanel({ battles }: TeammateBattlePanelProps) {
  if (battles.length === 0) return null;

  return (
    <div
      data-teammate-battle
      className="apex-glass apex-sheen rounded-[20px] p-6 overflow-hidden"
    >
      <span className="font-bold text-xs tracking-[0.12em] uppercase text-[#FF7A3D]">
        Teammate battle
      </span>

      <div className="mt-5 flex flex-col gap-4">
        {battles.map((battle) => {
          const color = getTeamColor(battle.teamName);
          const total = battle.sharedRounds;
          const pctA = total > 0 ? (battle.aheadA / total) * 100 : 50;

          return (
            <div key={battle.teamName}>
              <div className="flex justify-between mb-[7px]">
                <span className="font-semibold text-[11px] tracking-[0.04em] uppercase text-warm-400 truncate">
                  {battle.teamName}
                </span>
                <span className="font-bold text-[11px] tabular-nums text-warm-300">
                  {total === 0
                    ? "No shared rounds yet"
                    : `${battle.aheadA}-${battle.aheadB}`}
                </span>
              </div>
              <div className="flex justify-between mb-[6px] text-[10px] font-semibold text-warm-500">
                <span className="truncate">{battle.driverAName}</span>
                <span className="truncate">{battle.driverBName}</span>
              </div>
              <div className="h-[7px] bg-white/[0.06] rounded overflow-hidden flex">
                <div
                  className="h-full anim-bar"
                  style={{ width: `${pctA}%`, background: color.hex }}
                />
                <div
                  className="h-full anim-bar"
                  style={{ width: `${100 - pctA}%`, background: `${color.hex}44` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
