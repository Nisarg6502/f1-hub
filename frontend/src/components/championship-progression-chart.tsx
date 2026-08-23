"use client";

import { useMemo, useState } from "react";
import {
  Line,
  LineChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  buildProgressionRows,
  type ProgressionEntry,
  type ProgressionRow,
} from "@/lib/championship-progression";

export interface ProgressionEntity {
  id: string;
  name: string;
  colorHex: string;
}

interface ChampionshipProgressionChartProps {
  entities: ProgressionEntity[];
  logsByEntityId: Record<string, { entries: ProgressionEntry[] } | undefined>;
}

interface ProgressionTooltipProps {
  active?: boolean;
  payload?: { payload: ProgressionRow }[];
  entities: ProgressionEntity[];
  highlighted: Set<string>;
}

const TOOLTIP_MAX_UNFILTERED = 12;

function ProgressionTooltip({ active, payload, entities, highlighted }: ProgressionTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const filtered = entities.filter((e) => highlighted.size === 0 || highlighted.has(e.id));
  const sorted = filtered.slice().sort((a, b) => row.cumulative[b.id] - row.cumulative[a.id]);
  const visible = highlighted.size === 0 ? sorted.slice(0, TOOLTIP_MAX_UNFILTERED) : sorted;
  const hiddenCount = sorted.length - visible.length;

  return (
    <div className="rounded-xl bg-surface-container/95 border border-white/10 p-4 shadow-xl">
      <p className="font-[family-name:var(--font-headline)] font-bold text-lg mb-2">
        {row.shortName}
      </p>
      <div className="space-y-2">
        {visible.map((entity) => (
          <div key={entity.id} className="flex items-center gap-2 text-sm">
            <div
              className="w-3 h-3 rounded-full flex-none"
              style={{ backgroundColor: entity.colorHex }}
            />
            <span className="font-bold w-24 truncate">{entity.name}</span>
            <span className="tabular-nums font-bold">{row.cumulative[entity.id]} pts</span>
            <span className="text-xs text-warm-500 tabular-nums">
              +{row.gained[entity.id]}
            </span>
            {row.position[entity.id] !== null && (
              <span className="text-xs text-warm-500">P{row.position[entity.id]}</span>
            )}
            {row.cumulative[entity.id] < row.leaderPoints && (
              <span className="text-xs text-warm-500 tabular-nums">
                -{row.leaderPoints - row.cumulative[entity.id]}
              </span>
            )}
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <p className="text-xs text-warm-500 mt-2">+{hiddenCount} more</p>
      )}
    </div>
  );
}

export default function ChampionshipProgressionChart({
  entities,
  logsByEntityId,
}: ChampionshipProgressionChartProps) {
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());

  const rows = useMemo(
    () => buildProgressionRows(entities.map((e) => e.id), logsByEntityId),
    [entities, logsByEntityId]
  );

  const chartData = useMemo(
    () =>
      rows.map((row) => ({
        ...row,
        ...Object.fromEntries(entities.map((e) => [e.id, row.cumulative[e.id]])),
      })),
    [rows, entities]
  );

  const toggle = (id: string) => {
    setHighlighted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (rows.length === 0) {
    return (
      <div className="apex-glass-soft rounded-2xl p-8 text-center text-sm text-warm-400 font-medium">
        No rounds scored yet this season.
      </div>
    );
  }

  return (
    <div className="apex-glass-soft rounded-2xl p-6">
      <h3 className="font-bold text-[11px] tracking-[0.18em] uppercase text-warm-500 mb-4">
        Championship progression
      </h3>
      <ResponsiveContainer width="100%" height={360}>
        <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a231d" />
          <XAxis
            dataKey="shortName"
            stroke="#5c554b"
            tick={{ fill: "var(--color-warm-400)", fontSize: 11 }}
            interval={0}
          />
          <YAxis
            stroke="#5c554b"
            tick={{ fill: "var(--color-warm-400)", fontSize: 12 }}
            width={44}
          />
          <Tooltip
            cursor={{ stroke: "rgba(255,255,255,0.15)" }}
            content={<ProgressionTooltip entities={entities} highlighted={highlighted} />}
          />
          {entities.map((entity) => {
            const dimmed = highlighted.size > 0 && !highlighted.has(entity.id);
            return (
              <Line
                key={entity.id}
                type="monotone"
                dataKey={entity.id}
                stroke={entity.colorHex}
                strokeWidth={2}
                strokeOpacity={dimmed ? 0.15 : 1}
                dot={dimmed ? false : { r: 2, fill: entity.colorHex }}
                isAnimationActive={false}
              />
            );
          })}
        </LineChart>
      </ResponsiveContainer>

      <div className="flex flex-wrap gap-x-3 gap-y-2 mt-5">
        {entities.map((entity) => {
          const dimmed = highlighted.size > 0 && !highlighted.has(entity.id);
          return (
            <button
              key={entity.id}
              onClick={() => toggle(entity.id)}
              className={`flex items-center gap-1.5 text-[11px] font-bold px-2 py-1 rounded-md transition-opacity duration-150 ${
                dimmed ? "opacity-40" : "opacity-100"
              }`}
            >
              <div
                className="w-2.5 h-2.5 rounded-full flex-none"
                style={{ backgroundColor: entity.colorHex }}
              />
              {entity.name}
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-warm-500 mt-3">
        Totals reflect the rounds currently loaded and may lag the official standings by a round
        if a source temporarily failed.
      </p>
    </div>
  );
}
