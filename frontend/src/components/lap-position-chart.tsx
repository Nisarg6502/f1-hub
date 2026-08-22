"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Check, ChevronsUpDown } from "lucide-react";
import type { RaceLap } from "@/lib/api";

interface LapPositionChartProps {
  drivers: {
    driverId: string;
    number: string;
    code: string;
    givenName: string;
    familyName: string;
    teamColor: string;
  }[];
  /** Laps fetched server-side by the pitwall page, which only renders this
   * chart once it has some — so there is no loading or empty state here. */
  initialLaps: RaceLap[];
}

type ChartMode = "position" | "gap";

interface ChartRow {
  lap: number;
  [driverCode: string]: number;
}

/** Declared outside the component so it isn't recreated (and remounted by
 * Recharts) on every render. Shared by both Position and Gap modes — only
 * the value formatting differs. */
function LapTooltip({
  active,
  payload,
  label,
  mode,
  driversByCode,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; value?: number; color?: string }>;
  label?: number;
  mode: ChartMode;
  driversByCode: Map<string, { givenName: string; familyName: string }>;
}) {
  if (!active || !payload || payload.length === 0) return null;

  // Ascending sort reads as "best first" in both modes: lower position and
  // smaller gap are both "better".
  const rows = payload
    .filter((p) => typeof p.value === "number")
    .sort((a, b) => (a.value ?? 0) - (b.value ?? 0));

  return (
    <div className="rounded-xl bg-[rgba(26,22,19,0.95)] border border-white/10 p-4 shadow-xl">
      <div className="font-bold text-xs text-warm-300 mb-2">Lap {label}</div>
      <div className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const code = row.dataKey as string;
          const driver = driversByCode.get(code);
          const value = row.value ?? 0;
          return (
            <div key={code} className="flex items-center gap-2 text-xs">
              <span
                className="w-2 h-2 rounded-full flex-none"
                style={{ background: row.color }}
              />
              <span className="font-bold tabular-nums w-12">
                {mode === "gap"
                  ? value <= 0
                    ? "Leader"
                    : `+${value.toFixed(1)}s`
                  : `P${value}`}
              </span>
              <span className="text-warm-300">
                {driver ? `${driver.givenName} ${driver.familyName}` : code}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function LapPositionChart({
  drivers,
  initialLaps: laps,
}: LapPositionChartProps) {
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>(() =>
    drivers.slice(0, 5).map((d) => d.number)
  );
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Gap-to-leader was added after the position chart shipped, so a round
  // that was synced (or cached) before then simply has no `gap_seconds` on
  // any of its rows. Rather than show a flat-zero or broken gap chart, the
  // toggle itself is disabled and the view is pinned to Position.
  const hasGapData = laps.some((l) => typeof l.gap_seconds === "number");
  const [mode, setMode] = useState<ChartMode>("position");
  const effectiveMode: ChartMode = hasGapData ? mode : "position";

  useEffect(() => {
    if (!dropdownOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDropdownOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dropdownOpen]);

  const toggleDriver = (number: string) => {
    setSelectedDrivers((prev) =>
      prev.includes(number) ? prev.filter((n) => n !== number) : [...prev, number]
    );
  };

  const activeDrivers = drivers.filter((d) => selectedDrivers.includes(d.number));
  const driversByCode = new Map(
    drivers.map((d) => [d.code || d.familyName, { givenName: d.givenName, familyName: d.familyName }])
  );

  // Pivot the flat (driver_number, lap_number, position, gap_seconds) rows
  // into one row per lap with one column per selected driver's code, which
  // is the shape Recharts' <Line dataKey> needs. Which field feeds the
  // column depends on the active mode.
  const maxLap = laps.reduce((max, l) => Math.max(max, l.lap_number), 0);
  const chartData: ChartRow[] = Array.from({ length: maxLap }, (_, idx) => {
    const lapNumber = idx + 1;
    const row: ChartRow = { lap: lapNumber };
    for (const driver of activeDrivers) {
      const lapRow = laps.find(
        (l) => String(l.driver_number) === driver.number && l.lap_number === lapNumber
      );
      if (!lapRow) continue;
      const value = effectiveMode === "gap" ? lapRow.gap_seconds : lapRow.position;
      if (typeof value === "number") {
        row[driver.code || driver.familyName] = value;
      }
    }
    return row;
  });

  const maxPosition = activeDrivers.length
    ? laps
        .filter((l) => activeDrivers.some((d) => d.number === String(l.driver_number)))
        .reduce((max, l) => Math.max(max, l.position), 1)
    : 1;

  const maxGap = activeDrivers.length
    ? laps
        .filter((l) => activeDrivers.some((d) => d.number === String(l.driver_number)))
        .reduce((max, l) => (typeof l.gap_seconds === "number" ? Math.max(max, l.gap_seconds) : max), 0)
    : 0;

  return (
    <div className="flex flex-col h-full gap-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4 apex-glass-soft rounded-2xl p-4">
        <span className="text-xs uppercase tracking-[0.12em] text-warm-400 font-bold">
          Compare drivers
        </span>
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center justify-between w-64 rounded-[10px] bg-[rgba(245,235,222,0.06)] border border-white/10 px-4 py-2 text-sm hover:border-[rgba(255,138,61,0.5)] transition-[border-color,transform] duration-150 active:scale-[0.98]"
          >
            <span className="truncate font-semibold">
              {selectedDrivers.length} drivers selected
            </span>
            <ChevronsUpDown className="w-4 h-4 text-warm-400" />
          </button>
          {dropdownOpen && (
            <div className="absolute top-full left-0 mt-1.5 w-64 rounded-xl bg-[rgba(26,22,19,0.98)] border border-white/10 shadow-2xl z-50 max-h-64 overflow-y-auto p-1">
              <div className="flex items-center gap-1 px-2 py-1.5 mb-1 border-b border-white/10">
                <button
                  onClick={() => setSelectedDrivers(drivers.map((d) => d.number))}
                  className="text-[11px] font-bold uppercase tracking-[0.08em] text-warm-400 hover:text-primary transition-[color,transform] duration-150 active:scale-[0.97] px-1.5 py-0.5"
                >
                  Select all
                </button>
                <span className="text-warm-600">·</span>
                <button
                  onClick={() => setSelectedDrivers([])}
                  className="text-[11px] font-bold uppercase tracking-[0.08em] text-warm-400 hover:text-primary transition-[color,transform] duration-150 active:scale-[0.97] px-1.5 py-0.5"
                >
                  Clear all
                </button>
              </div>
              {drivers.map((driver) => {
                const isSelected = selectedDrivers.includes(driver.number);
                return (
                  <div
                    key={driver.number}
                    onClick={() => toggleDriver(driver.number)}
                    className={`flex items-center px-3 py-2 rounded-lg cursor-pointer hover:bg-white/[0.05] transition-colors ${
                      isSelected ? "text-primary" : "text-warm-300"
                    }`}
                  >
                    <div className="w-4 h-4 rounded border border-warm-600 mr-3 flex items-center justify-center">
                      {isSelected && <Check className="w-3 h-3" />}
                    </div>
                    <div
                      className="w-1 h-4 mr-2 rounded-full"
                      style={{ backgroundColor: driver.teamColor }}
                    />
                    <span className="font-bold mr-2 w-6 tabular-nums">{driver.number}</span>
                    <span className="font-semibold">{driver.code || driver.familyName}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <div className="flex gap-1.5 apex-glass-soft rounded-xl p-[5px] w-fit">
            {(
              [
                ["position", "Position"],
                ["gap", "Gap to leader"],
              ] as const
            ).map(([key, label]) => {
              const disabled = key === "gap" && !hasGapData;
              return (
                <button
                  key={key}
                  onClick={() => !disabled && setMode(key)}
                  disabled={disabled}
                  title={disabled ? "Gap-to-leader data isn't available for this round yet" : undefined}
                  aria-disabled={disabled}
                  className={`relative text-xs px-4 py-[9px] rounded-lg transition-[color,transform] duration-150 ${
                    disabled
                      ? "font-semibold text-warm-600 cursor-not-allowed opacity-50"
                      : "active:scale-[0.97] " +
                        (effectiveMode === key
                          ? "font-bold text-primary"
                          : "font-semibold text-warm-300 hover:text-on-background")
                  }`}
                >
                  {effectiveMode === key && !disabled && (
                    <motion.span
                      layoutId="lap-chart-mode-pill"
                      className="absolute inset-0 rounded-lg bg-[rgba(255,90,31,0.18)]"
                      transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {!hasGapData && (
        <div className="flex items-center gap-2 -mt-4 px-1 text-[11px] text-warm-500">
          <span className="material-symbols-outlined text-sm text-flame">hourglass_empty</span>
          Gap-to-leader isn&apos;t available for this round yet — it needs a fresh sync. Position is
          shown instead.
        </div>
      )}

      {/* Chart Area */}
      <div className="apex-glass-soft rounded-2xl flex-grow p-6 relative min-h-[500px]">
        {activeDrivers.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-warm-500 font-medium">
            Select at least one driver to view {effectiveMode === "gap" ? "gaps" : "positions"}.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 20, right: 30, left: 10, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a231d" />
              <XAxis
                type="number"
                dataKey="lap"
                stroke="#5c554b"
                tick={{ fill: "var(--color-warm-400)", fontSize: 12 }}
                domain={[1, "dataMax"]}
                label={{ value: "Lap number", position: "bottom", fill: "#6f665b", fontSize: 12, dy: 10 }}
              />
              {effectiveMode === "gap" ? (
                <YAxis
                  type="number"
                  // Reversed for the same reason the position axis is: this
                  // keeps "better" (a smaller gap, with the leader at 0)
                  // higher up the chart, consistent with how the Position
                  // mode puts P1 at the top rather than the bottom.
                  reversed
                  domain={[0, maxGap || 1]}
                  stroke="#5c554b"
                  tick={{ fill: "var(--color-warm-400)", fontSize: 12 }}
                  tickFormatter={(value: number) => `+${value.toFixed(0)}s`}
                  label={{ value: "Gap to leader (s)", angle: -90, position: "insideLeft", fill: "#6f665b", fontSize: 12 }}
                />
              ) : (
                <YAxis
                  type="number"
                  reversed
                  domain={[1, maxPosition]}
                  allowDecimals={false}
                  stroke="#5c554b"
                  tick={{ fill: "var(--color-warm-400)", fontSize: 12 }}
                  label={{ value: "Position", angle: -90, position: "insideLeft", fill: "#6f665b", fontSize: 12 }}
                />
              )}
              <Tooltip content={<LapTooltip mode={effectiveMode} driversByCode={driversByCode} />} />
              {activeDrivers.map((driver) => (
                <Line
                  key={driver.number}
                  type="stepAfter"
                  dataKey={driver.code || driver.familyName}
                  stroke={driver.teamColor}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
