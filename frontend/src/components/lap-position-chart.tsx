"use client";

import { useState } from "react";
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

interface ChartRow {
  lap: number;
  [driverCode: string]: number;
}

/** Declared outside the component so it isn't recreated (and remounted by
 * Recharts) on every render. */
function PositionTooltip({
  active,
  payload,
  label,
  driversByCode,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string; value?: number; color?: string }>;
  label?: number;
  driversByCode: Map<string, { givenName: string; familyName: string }>;
}) {
  if (!active || !payload || payload.length === 0) return null;

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
          return (
            <div key={code} className="flex items-center gap-2 text-xs">
              <span
                className="w-2 h-2 rounded-full flex-none"
                style={{ background: row.color }}
              />
              <span className="font-bold tabular-nums w-5">P{row.value}</span>
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

  const toggleDriver = (number: string) => {
    setSelectedDrivers((prev) =>
      prev.includes(number) ? prev.filter((n) => n !== number) : [...prev, number]
    );
  };

  const activeDrivers = drivers.filter((d) => selectedDrivers.includes(d.number));
  const driversByCode = new Map(
    drivers.map((d) => [d.code || d.familyName, { givenName: d.givenName, familyName: d.familyName }])
  );

  // Pivot the flat (driver_number, lap_number, position) rows into one row
  // per lap with one column per selected driver's code, which is the shape
  // Recharts' <Line dataKey> needs.
  const maxLap = laps.reduce((max, l) => Math.max(max, l.lap_number), 0);
  const chartData: ChartRow[] = Array.from({ length: maxLap }, (_, idx) => {
    const lapNumber = idx + 1;
    const row: ChartRow = { lap: lapNumber };
    for (const driver of activeDrivers) {
      const lapRow = laps.find(
        (l) => String(l.driver_number) === driver.number && l.lap_number === lapNumber
      );
      if (lapRow) {
        row[driver.code || driver.familyName] = lapRow.position;
      }
    }
    return row;
  });

  const maxPosition = activeDrivers.length
    ? laps
        .filter((l) => activeDrivers.some((d) => d.number === String(l.driver_number)))
        .reduce((max, l) => Math.max(max, l.position), 1)
    : 1;

  return (
    <div className="flex flex-col h-full gap-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-4 apex-glass-soft rounded-2xl p-4">
        <span className="text-xs uppercase tracking-[0.12em] text-warm-400 font-bold">
          Compare drivers
        </span>
        <div className="relative">
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
              {drivers.map((driver) => {
                const isSelected = selectedDrivers.includes(driver.number);
                return (
                  <div
                    key={driver.number}
                    onClick={() => toggleDriver(driver.number)}
                    className={`flex items-center px-3 py-2 rounded-lg cursor-pointer hover:bg-white/[0.05] transition-colors ${
                      isSelected ? "text-[#FFAE6A]" : "text-warm-300"
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
      </div>

      {/* Chart Area */}
      <div className="apex-glass-soft rounded-2xl flex-grow p-6 relative min-h-[500px]">
        {activeDrivers.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-warm-500 font-medium">
            Select at least one driver to view positions.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 20, right: 30, left: 10, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a231d" />
              <XAxis
                type="number"
                dataKey="lap"
                stroke="#5c554b"
                tick={{ fill: "#8f867a", fontSize: 12 }}
                domain={[1, "dataMax"]}
                label={{ value: "Lap number", position: "bottom", fill: "#6f665b", fontSize: 12, dy: 10 }}
              />
              <YAxis
                type="number"
                reversed
                domain={[1, maxPosition]}
                allowDecimals={false}
                stroke="#5c554b"
                tick={{ fill: "#8f867a", fontSize: 12 }}
                label={{ value: "Position", angle: -90, position: "insideLeft", fill: "#6f665b", fontSize: 12 }}
              />
              <Tooltip content={<PositionTooltip driversByCode={driversByCode} />} />
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
