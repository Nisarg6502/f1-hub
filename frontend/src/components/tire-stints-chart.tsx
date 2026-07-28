"use client";

import { useEffect, useRef, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Check, ChevronsUpDown } from "lucide-react";
import type { RaceStint } from "@/lib/api";

interface TireStintsChartProps {
  drivers: {
    driverId: string;
    number: string;
    code: string;
    givenName: string;
    familyName: string;
    teamColor: string;
  }[];
  /** Stints fetched server-side by the pitwall page, which only renders this
   * chart once it has some — so there is no loading or empty state here. */
  initialStints: RaceStint[];
}

const COMPOUND_COLORS: Record<string, string> = {
  SOFT: "#FF3333",
  MEDIUM: "#FFE700",
  HARD: "#F0F0F0",
  INTERMEDIATE: "#39D54B",
  WET: "#0078FF",
  UNKNOWN: "#555555",
};

/** One Recharts row per driver.
 *
 * Recharts addresses stacked bars by flat `dataKey` strings, so each stint is
 * spread across `stint<n>_len` / `_compound` / `_age` keys rather than nested
 * under an array.
 */
type ChartRow = Record<string, string | number>;

interface StintTooltipProps {
  active?: boolean;
  payload?: { payload: ChartRow }[];
}

/** Declared outside the chart so it isn't recreated (and remounted) each render. */
function StintTooltip({ active, payload }: StintTooltipProps) {
  if (!active || !payload?.length) return null;

  const row = payload[0].payload;
  const stints = [];
  for (let idx = 0; row[`stint${idx}_len`] !== undefined; idx++) {
    stints.push({
      laps: Number(row[`stint${idx}_len`]),
      compound: String(row[`stint${idx}_compound`] ?? "UNKNOWN"),
    });
  }

  return (
    <div className="rounded-xl bg-[rgba(26,22,19,0.95)] border border-white/10 p-4 shadow-xl">
      <p className="font-[family-name:var(--font-headline)] font-bold text-lg mb-2">
        {row.fullName}
      </p>
      <div className="space-y-2">
        {stints.map(({ laps, compound }, idx) =>
          laps ? (
            <div key={idx} className="flex items-center gap-2 text-sm">
              <div
                className="w-3 h-3 rounded-full"
                style={{
                  backgroundColor:
                    COMPOUND_COLORS[compound] || COMPOUND_COLORS.UNKNOWN,
                }}
              />
              <span className="text-warm-300">Stint {idx + 1}:</span>
              <span className="font-bold tabular-nums">{laps} laps</span>
              <span className="text-xs text-warm-500">({compound})</span>
            </div>
          ) : null
        )}
      </div>
    </div>
  );
}

export default function TireStintsChart({
  drivers,
  initialStints: stints,
}: TireStintsChartProps) {
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>(() => {
    // Default to top 5 drivers
    return drivers.slice(0, 5).map((d) => d.number);
  });
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
      prev.includes(number)
        ? prev.filter((n) => n !== number)
        : [...prev, number]
    );
  };

  const activeDrivers = drivers.filter((d) => selectedDrivers.includes(d.number));

  // Prepare data for Recharts
  // We need an array where each object is a driver, and has keys for each stint length
  // e.g. { name: "VER", stint0_len: 15, stint0_compound: "SOFT", stint1_len: 20, stint1_compound: "HARD" }
  const stintsByDriver = activeDrivers.map((driver) => ({
    driver,
    driverStints: stints
      .filter((s) => String(s.driver_number) === driver.number)
      .sort((a, b) => a.stint_number - b.stint_number),
  }));

  // One <Bar> is rendered per stint index, so the chart needs the highest stint
  // count across the selected drivers before it can lay any of them out.
  const maxStints = stintsByDriver.reduce(
    (max, { driverStints }) => Math.max(max, driverStints.length),
    0
  );

  const chartData = stintsByDriver.map(({ driver, driverStints }) => {
    const row: ChartRow = {
      name: driver.code || driver.familyName,
      fullName: `${driver.givenName} ${driver.familyName}`,
      teamColor: driver.teamColor,
    };

    driverStints.forEach((stint, idx) => {
      // Calculate length
      const length = stint.lap_end - stint.lap_start + 1;
      row[`stint${idx}_len`] = length > 0 ? length : 0;
      row[`stint${idx}_compound`] = stint.compound;
      row[`stint${idx}_age`] = stint.tyre_age_at_start;
    });

    return row;
  });

  return (
    <div className="flex flex-col h-full gap-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 apex-glass-soft rounded-2xl p-4">
        <div className="flex items-center gap-4">
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
                    className="text-[11px] font-bold uppercase tracking-[0.08em] text-warm-400 hover:text-[#FFAE6A] transition-[color,transform] duration-150 active:scale-[0.97] px-1.5 py-0.5"
                  >
                    Select all
                  </button>
                  <span className="text-warm-600">·</span>
                  <button
                    onClick={() => setSelectedDrivers([])}
                    className="text-[11px] font-bold uppercase tracking-[0.08em] text-warm-400 hover:text-[#FFAE6A] transition-[color,transform] duration-150 active:scale-[0.97] px-1.5 py-0.5"
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
                      <span className="font-bold mr-2 w-6 tabular-nums">
                        {driver.number}
                      </span>
                      <span className="font-semibold">
                        {driver.code || driver.familyName}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3.5 text-[11px] uppercase tracking-[0.1em] font-bold text-warm-300">
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#FF3333]" /> Soft</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#FFE700]" /> Medium</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#F0F0F0]" /> Hard</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#39D54B]" /> Inter</div>
          <div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-[#0078FF]" /> Wet</div>
        </div>
      </div>

      {/* Chart Area */}
      <div className="apex-glass-soft rounded-2xl flex-grow p-6 relative min-h-[500px]">
        {activeDrivers.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-warm-500 font-medium">
            Select at least one driver to view stints.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2a231d" horizontal={false} />
              <XAxis
                type="number"
                stroke="#5c554b"
                tick={{ fill: "#8f867a", fontSize: 12 }}
                domain={[0, 'dataMax']}
                label={{ value: 'Lap number', position: 'bottom', fill: '#6f665b', fontSize: 12, dy: 10 }}
              />
              <YAxis
                type="category"
                dataKey="name"
                stroke="#5c554b"
                tick={{ fill: "#f6f1ea", fontSize: 14, fontWeight: "bold" }}
                width={60}
              />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<StintTooltip />} />
              
              {/* Render a Bar for each possible stint index */}
              {Array.from({ length: maxStints }).map((_, idx) => (
                <Bar key={idx} dataKey={`stint${idx}_len`} stackId="a" isAnimationActive={false}>
                  {chartData.map((entry, index) => {
                    const compound = entry[`stint${idx}_compound`];
                    const color = COMPOUND_COLORS[compound] || COMPOUND_COLORS.UNKNOWN;
                    return <Cell key={`cell-${index}`} fill={color} stroke="#111" strokeWidth={1} />;
                  })}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
