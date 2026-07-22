"use client";

import { useState, useEffect } from "react";
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
import { Check, ChevronsUpDown, AlertCircle } from "lucide-react";

interface TireStintsChartProps {
  sessionKey: number | null;
  drivers: {
    driverId: string;
    number: string;
    code: string;
    givenName: string;
    familyName: string;
    teamColor: string;
  }[];
}

const COMPOUND_COLORS: Record<string, string> = {
  SOFT: "#FF3333",
  MEDIUM: "#FFE700",
  HARD: "#F0F0F0",
  INTERMEDIATE: "#39D54B",
  WET: "#0078FF",
  UNKNOWN: "#555555",
};

export default function TireStintsChart({
  sessionKey,
  drivers,
}: TireStintsChartProps) {
  const [stints, setStints] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedDrivers, setSelectedDrivers] = useState<string[]>(() => {
    // Default to top 5 drivers
    return drivers.slice(0, 5).map((d) => d.number);
  });
  const [dropdownOpen, setDropdownOpen] = useState(false);

  useEffect(() => {
    if (!sessionKey) {
      setLoading(false);
      setError(true);
      return;
    }

    async function fetchStints() {
      try {
        const res = await fetch(
          `https://api.openf1.org/v1/stints?session_key=${sessionKey}`
        );
        if (res.status === 401) {
          setError(true);
          setLoading(false);
          return;
        }
        if (!res.ok) throw new Error("Failed to fetch");
        const data = await res.json();
        setStints(data);
      } catch (e) {
        console.error(e);
        setError(true);
      } finally {
        setLoading(false);
      }
    }

    fetchStints();
  }, [sessionKey]);

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
  let maxStints = 0;
  const chartData = activeDrivers.map((driver) => {
    const driverStints = stints
      .filter((s) => String(s.driver_number) === driver.number)
      .sort((a, b) => a.stint_number - b.stint_number);

    if (driverStints.length > maxStints) {
      maxStints = driverStints.length;
    }

    const row: any = {
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

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const driverData = payload[0].payload;
      return (
        <div className="rounded-xl bg-[rgba(26,22,19,0.95)] border border-white/10 p-4 shadow-xl">
          <p className="font-[family-name:var(--font-headline)] font-bold text-lg mb-2">
            {driverData.fullName}
          </p>
          <div className="space-y-2">
            {Array.from({ length: maxStints }).map((_, idx) => {
              const len = driverData[`stint${idx}_len`];
              const compound = driverData[`stint${idx}_compound`];
              if (!len) return null;
              return (
                <div key={idx} className="flex items-center gap-2 text-sm">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: COMPOUND_COLORS[compound] || COMPOUND_COLORS.UNKNOWN }}
                  />
                  <span className="text-warm-300">Stint {idx + 1}:</span>
                  <span className="font-bold tabular-nums">{len} laps</span>
                  <span className="text-xs text-warm-500">({compound})</span>
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col h-full gap-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 apex-glass-soft rounded-2xl p-4">
        <div className="flex items-center gap-4">
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
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[rgba(10,9,8,0.5)] backdrop-blur-sm z-10 rounded-2xl">
            <div className="w-12 h-12 border-4 border-[#FF5A1F] border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {error && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[rgba(10,9,8,0.5)] backdrop-blur-sm z-10 text-warm-400 rounded-2xl">
            <AlertCircle className="w-12 h-12 mb-4 text-[#FF7A3D]" />
            <p className="text-lg font-medium">
              No stint data available for this session.
            </p>
          </div>
        )}

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
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} content={<CustomTooltip />} />
              
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
