import { getTeamColor } from "@/lib/team-colors";
import TeamCar from "@/components/team-car";
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
      <span className="font-bold text-xs tracking-[0.12em] uppercase text-flame">
        Teammate battle
      </span>

      <div className="mt-5 flex flex-col gap-4">
        {battles.map((battle) => {
          const color = getTeamColor(battle.teamName);
          const total = battle.sharedRounds;
          const pctA = total > 0 ? (battle.aheadA / total) * 100 : 50;

          return (
            // `relative` + `isolate`: the car is absolutely positioned against
            // this row and must not escape into the one above.
            //
            // One car, not two facing each other. Nose-to-nose is the obvious
            // instinct for a head-to-head, but teammates share a chassis — two
            // mirrored copies of the same livery would draw a contest between
            // machines that are by definition identical. Equal machinery is the
            // whole premise of a teammate comparison, so the car sits *behind*
            // both drivers as the thing they have in common, and the split bar
            // in front carries the thing they don't. (The compare modal does
            // use two noses; there the cars can genuinely differ.)
            <div key={battle.teamName} className="relative isolate">
              {/* Sat on the split bar rather than spanning the row. The
                  sidebar is 340px, so a 4.5:1 car tall enough to fill the row
                  is wide enough to run straight through both driver names —
                  which are 10px and already dim, and were the first thing to
                  become unreadable. Dropping it to the bar's own height fixes
                  that and reads better anyway: the car sits on the bar like a
                  car on a track, and the bar is the thing being measured. */}
              <TeamCar
                team={battle.teamName}
                variant="ghost-right"
                opacity={0.17}
                sizes="200px"
                className="absolute -z-10 right-0 bottom-0 h-[32px] w-[56%]"
              />
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
