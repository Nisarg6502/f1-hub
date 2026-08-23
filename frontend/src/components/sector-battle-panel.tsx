"use client";

import { useEffect, useState } from "react";
import { getSessionSectors, type RaceResult } from "@/lib/api";
import { joinSectorRowsWithResults, type SectorBattleDriver } from "@/lib/sector-battle";

interface SectorBattlePanelProps {
  year: number;
  round: number;
  session: "FP1" | "FP2" | "FP3" | "Q" | "SQ";
  results: RaceResult[];
}

const CLASSIFICATION_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  purple: { bg: "rgba(174,59,255,0.18)", color: "#c99bff", label: "Purple" },
  green: { bg: "rgba(57,213,75,0.14)", color: "#6ee085", label: "Green" },
  yellow: { bg: "transparent", color: "var(--color-warm-300)", label: "" },
};

export default function SectorBattlePanel({ year, round, session, results }: SectorBattlePanelProps) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "unavailable" } | { status: "ready"; drivers: SectorBattleDriver[] }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    getSessionSectors(year, round, session)
      .then((data) => {
        if (cancelled) return;
        if (!data.available || data.rows.length === 0) {
          setState({ status: "unavailable" });
          return;
        }
        setState({ status: "ready", drivers: joinSectorRowsWithResults(data.rows, results) });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unavailable" });
      });

    return () => {
      cancelled = true;
    };
  }, [year, round, session, results]);

  if (state.status === "loading") {
    return (
      <div className="apex-glass-soft rounded-2xl p-6 mt-6 text-sm text-warm-400 font-medium">
        Loading sector times…
      </div>
    );
  }

  if (state.status === "unavailable") {
    return (
      <div className="apex-glass-soft rounded-2xl p-6 mt-6 text-sm text-warm-400 font-medium">
        Sector data isn&apos;t available for this session.
      </div>
    );
  }

  return (
    <div className="apex-glass-soft rounded-2xl p-6 mt-6">
      <div className="flex items-center justify-between mb-4">
        <h4 className="font-bold text-[11px] tracking-[0.18em] uppercase text-warm-400">
          Sector battle
        </h4>
        <div className="flex items-center gap-3 text-[10px] uppercase font-bold text-warm-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#ae3bff" }} />
            Purple
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#39d54b" }} />
            Personal best
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-[0.1em] text-warm-500">
              <th className="pb-2 pr-3">Driver</th>
              <th className="pb-2 px-3">S1</th>
              <th className="pb-2 px-3">S2</th>
              <th className="pb-2 px-3">S3</th>
              <th className="pb-2 pl-3 text-right">Lap</th>
            </tr>
          </thead>
          <tbody>
            {state.drivers.map((driver) => (
              <tr key={driver.driverNumber} className="border-t border-white/[0.06]">
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-1 h-4 rounded-hairline flex-none"
                      style={{ background: driver.teamColorHex }}
                    />
                    <span className="font-bold">{driver.code}</span>
                  </div>
                </td>
                {(["1", "2", "3"] as const).map((sector) => {
                  const style = CLASSIFICATION_STYLE[driver.sectors[sector].classification];
                  return (
                    <td key={sector} className="py-2 px-3">
                      <span
                        className="px-2 py-1 rounded-md tabular-nums font-semibold"
                        style={{ background: style.bg, color: style.color }}
                      >
                        {driver.sectors[sector].seconds.toFixed(3)}
                      </span>
                    </td>
                  );
                })}
                <td className="py-2 pl-3 text-right tabular-nums font-bold">
                  {driver.lapDurationSeconds.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
