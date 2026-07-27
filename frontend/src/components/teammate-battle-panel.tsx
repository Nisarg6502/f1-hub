"use client";

import { useEffect, useState } from "react";
import type { DriverStanding } from "@/lib/api";
import { getSeasonResultsByRound, type SeasonRoundResults } from "@/lib/api";
import { buildHeadToHead } from "@/lib/driver-compare";
import { getTeamColor } from "@/lib/team-colors";

interface TeammateBattlePanelProps {
  drivers: DriverStanding[];
  year: number;
}

interface TeamPair {
  teamName: string;
  driverA: DriverStanding;
  driverB: DriverStanding;
}

// A constructor can show more than two rows in the standings if it changed
// drivers mid-season (a substitute who also scored points) -- comparing the
// two who actually scored the most for that team is the more meaningful
// "battle" than an arbitrary pair.
function buildTeamPairs(drivers: DriverStanding[]): TeamPair[] {
  const groups = new Map<string, DriverStanding[]>();
  for (const driver of drivers) {
    const constructorId = driver.Constructors?.[0]?.constructorId;
    if (!constructorId) continue;
    const list = groups.get(constructorId) ?? [];
    list.push(driver);
    groups.set(constructorId, list);
  }

  const pairs: TeamPair[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const [driverA, driverB] = list
      .slice()
      .sort((a, b) => Number(b.points) - Number(a.points));
    pairs.push({
      teamName: driverA.Constructors?.[0]?.name ?? "—",
      driverA,
      driverB,
    });
  }
  return pairs;
}

export default function TeammateBattlePanel({ drivers, year }: TeammateBattlePanelProps) {
  const [rounds, setRounds] = useState<SeasonRoundResults[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSeasonResultsByRound(year)
      .then((res) => {
        if (!cancelled) setRounds(res);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  const pairs = buildTeamPairs(drivers);
  if (pairs.length === 0) return null;

  return (
    <div className="apex-glass apex-sheen rounded-[20px] p-6 overflow-hidden">
      <span className="font-bold text-xs tracking-[0.12em] uppercase text-[#FF7A3D]">
        Teammate battle
      </span>

      {loading ? (
        <div className="mt-5 flex flex-col gap-[18px] animate-pulse">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[46px] rounded-xl bg-[rgba(245,235,222,0.05)]" />
          ))}
        </div>
      ) : failed || !rounds ? (
        <p className="mt-4 text-xs text-warm-400 font-medium">
          Teammate comparison unavailable right now.
        </p>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          {pairs.map((pair) => {
            const idA = pair.driverA.Driver.driverId;
            const idB = pair.driverB.Driver.driverId;
            if (!idA || !idB) return null;
            const summary = buildHeadToHead(rounds, idA, idB);
            const color = getTeamColor(pair.teamName);
            const total = summary.raceCommonCount;
            const pctA = total > 0 ? (summary.raceAheadA / total) * 100 : 50;

            return (
              <div key={pair.teamName}>
                <div className="flex justify-between mb-[7px]">
                  <span className="font-semibold text-[11px] tracking-[0.04em] uppercase text-warm-400 truncate">
                    {pair.teamName}
                  </span>
                  <span className="font-bold text-[11px] tabular-nums text-warm-300">
                    {total === 0
                      ? "No shared rounds yet"
                      : `${summary.raceAheadA}-${summary.raceAheadB}`}
                  </span>
                </div>
                <div className="flex justify-between mb-[6px] text-[10px] font-semibold text-warm-500">
                  <span className="truncate">{pair.driverA.Driver.familyName}</span>
                  <span className="truncate">{pair.driverB.Driver.familyName}</span>
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
      )}
    </div>
  );
}
