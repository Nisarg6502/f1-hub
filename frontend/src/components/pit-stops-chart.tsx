"use client";

import { useMemo, useState } from "react";
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
import { ArrowDown, ArrowUp, Flag } from "lucide-react";
import type { PitStop } from "@/lib/api";

interface PitStopsChartProps {
  drivers: {
    driverId: string;
    number: string;
    code: string;
    givenName: string;
    familyName: string;
    teamColor: string;
  }[];
  /** Stops fetched server-side by the pitwall page, which only renders this
   * panel once it has some — so there is no loading or empty state here. */
  stops: PitStop[];
}

/** Ergast reports *pit lane* time, not stationary time, so a car that sits in
 * the pits through a red flag is recorded as a single multi-minute "stop".
 * Those aren't crew work and one of them would flatten every real bar on the
 * chart, so they're kept out of the aggregates and marked in the table. */
const RED_FLAG_SECONDS = 120;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(3)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds - minutes * 60).toFixed(3).padStart(6, "0")}`;
}

interface DriverStops {
  driverId: string;
  code: string;
  fullName: string;
  teamColor: string;
  stops: PitStop[];
  totalSeconds: number;
  averageSeconds: number;
  bestSeconds: number;
}

/** One Recharts row per driver. Recharts addresses stacked bars by flat
 * `dataKey` strings, so each stop is spread across `stop<n>_len` keys rather
 * than nested under an array. */
type ChartRow = Record<string, string | number>;

interface PitTooltipProps {
  active?: boolean;
  payload?: { payload: ChartRow }[];
}

/** Declared outside the chart so it isn't recreated (and remounted) each render. */
function PitTooltip({ active, payload }: PitTooltipProps) {
  if (!active || !payload?.length) return null;

  const row = payload[0].payload;
  const segments = [];
  for (let idx = 0; row[`stop${idx}_len`] !== undefined; idx++) {
    segments.push({
      seconds: Number(row[`stop${idx}_len`]),
      lap: Number(row[`stop${idx}_lap`]),
    });
  }

  return (
    <div className="rounded-xl bg-surface-container/95 border border-white/10 p-4 shadow-xl">
      <p className="font-[family-name:var(--font-headline)] font-bold text-lg mb-2">
        {row.fullName}
      </p>
      <div className="space-y-1.5">
        {segments.map(({ seconds, lap }, idx) => (
          <div key={idx} className="flex items-center gap-2 text-sm">
            <div
              className="w-3 h-3 rounded-full"
              style={{
                backgroundColor: String(row.teamColor),
                opacity: 1 - idx * 0.18,
              }}
            />
            <span className="text-warm-300">Lap {lap}:</span>
            <span className="font-bold tabular-nums">
              {formatDuration(seconds)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2.5 pt-2.5 border-t border-white/10 flex gap-4 text-xs text-warm-400">
        <span>
          Total{" "}
          <span className="font-bold tabular-nums text-warm-200">
            {formatDuration(Number(row.total))}
          </span>
        </span>
        <span>
          Avg{" "}
          <span className="font-bold tabular-nums text-warm-200">
            {formatDuration(Number(row.average))}
          </span>
        </span>
      </div>
    </div>
  );
}

type SortKey = "lap" | "stop" | "driver" | "duration";

/** Declared outside the panel so React doesn't see a fresh component type on
 * every render (which would remount the header and lose focus mid-sort). */
function SortHeader({
  label,
  sortBy,
  sortKey,
  sortAsc,
  onSort,
  className,
}: {
  label: string;
  sortBy: SortKey;
  sortKey: SortKey;
  sortAsc: boolean;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const isActive = sortKey === sortBy;
  return (
    <button
      onClick={() => onSort(sortBy)}
      className={`flex items-center gap-1 uppercase tracking-[0.12em] font-bold text-[10px] transition-colors hover:text-primary ${
        isActive ? "text-primary" : "text-warm-500"
      } ${className ?? ""}`}
    >
      {label}
      {isActive &&
        (sortAsc ? (
          <ArrowUp className="w-3 h-3" />
        ) : (
          <ArrowDown className="w-3 h-3" />
        ))}
    </button>
  );
}

function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="apex-glass-soft rounded-2xl px-5 py-4">
      <div className="font-bold text-[10px] tracking-[0.16em] uppercase text-warm-500">
        {label}
      </div>
      <div className="font-[family-name:var(--font-headline)] font-extrabold text-2xl tabular-nums mt-1.5 apex-flame-text">
        {value}
      </div>
      {detail && (
        <div className="font-semibold text-[11px] text-warm-400 mt-0.5">
          {detail}
        </div>
      )}
    </div>
  );
}

export default function PitStopsChart({ drivers, stops }: PitStopsChartProps) {
  const [sortKey, setSortKey] = useState<SortKey>("lap");
  const [sortAsc, setSortAsc] = useState(true);

  const driverById = useMemo(
    () => new Map(drivers.map((d) => [d.driverId, d])),
    [drivers]
  );

  /** Stops a pit crew is actually accountable for. */
  const crewStops = useMemo(
    () => stops.filter((s) => s.duration_seconds < RED_FLAG_SECONDS),
    [stops]
  );
  const redFlagCount = stops.length - crewStops.length;

  const byDriver = useMemo(() => {
    const groups = new Map<string, PitStop[]>();
    for (const stop of crewStops) {
      const existing = groups.get(stop.driver_id);
      if (existing) existing.push(stop);
      else groups.set(stop.driver_id, [stop]);
    }

    const rows: DriverStops[] = [];
    for (const [driverId, driverStops] of groups) {
      const driver = driverById.get(driverId);
      // A stop belonging to a driver who isn't in the classification (a DNS
      // withdrawn after the entry list was published) has no name or colour to
      // plot, so it only appears in the table below.
      if (!driver) continue;

      const ordered = [...driverStops].sort((a, b) => a.stop - b.stop);
      const seconds = ordered.map((s) => s.duration_seconds);
      const total = seconds.reduce((sum, value) => sum + value, 0);

      rows.push({
        driverId,
        code: driver.code || driver.familyName,
        fullName: `${driver.givenName} ${driver.familyName}`.trim(),
        teamColor: driver.teamColor,
        stops: ordered,
        totalSeconds: total,
        averageSeconds: total / seconds.length,
        bestSeconds: Math.min(...seconds),
      });
    }

    return rows.sort((a, b) => a.totalSeconds - b.totalSeconds);
  }, [crewStops, driverById]);

  const chartData: ChartRow[] = byDriver.map((driver) => {
    const row: ChartRow = {
      name: driver.code,
      fullName: driver.fullName,
      teamColor: driver.teamColor,
      total: driver.totalSeconds,
      average: driver.averageSeconds,
    };
    driver.stops.forEach((stop, idx) => {
      row[`stop${idx}_len`] = stop.duration_seconds;
      row[`stop${idx}_lap`] = stop.lap;
    });
    return row;
  });

  const maxStops = byDriver.reduce(
    (max, driver) => Math.max(max, driver.stops.length),
    0
  );

  const fastest = crewStops.reduce<PitStop | null>(
    (best, stop) =>
      !best || stop.duration_seconds < best.duration_seconds ? stop : best,
    null
  );
  const slowest = crewStops.reduce<PitStop | null>(
    (worst, stop) =>
      !worst || stop.duration_seconds > worst.duration_seconds ? stop : worst,
    null
  );
  // The median resists the one botched stop that would drag a mean around.
  const median = (() => {
    if (!crewStops.length) return 0;
    const sorted = [...crewStops]
      .map((s) => s.duration_seconds)
      .sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  })();
  const bestCrew = byDriver.reduce<DriverStops | null>(
    (best, driver) =>
      !best || driver.averageSeconds < best.averageSeconds ? driver : best,
    null
  );

  const label = (driverId: string) => {
    const driver = driverById.get(driverId);
    return driver?.code || driver?.familyName || driverId;
  };

  const sortedStops = useMemo(() => {
    const direction = sortAsc ? 1 : -1;
    const name = (driverId: string) => {
      const driver = driverById.get(driverId);
      return driver?.code || driver?.familyName || driverId;
    };

    return [...stops].sort((a, b) => {
      if (sortKey === "duration") {
        return (a.duration_seconds - b.duration_seconds) * direction;
      }
      if (sortKey === "driver") {
        return name(a.driver_id).localeCompare(name(b.driver_id)) * direction;
      }
      if (sortKey === "stop") {
        return (a.stop - b.stop || a.lap - b.lap) * direction;
      }
      return (a.lap - b.lap || a.stop - b.stop) * direction;
    });
  }, [stops, sortKey, sortAsc, driverById]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((prev) => !prev);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const sortProps = { sortKey, sortAsc, onSort: toggleSort };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Fastest stop"
          value={fastest ? formatDuration(fastest.duration_seconds) : "—"}
          detail={
            fastest ? `${label(fastest.driver_id)} · lap ${fastest.lap}` : undefined
          }
        />
        <StatTile
          label="Median stop"
          value={median ? formatDuration(median) : "—"}
          detail={`${crewStops.length} stops`}
        />
        <StatTile
          label="Slowest stop"
          value={slowest ? formatDuration(slowest.duration_seconds) : "—"}
          detail={
            slowest ? `${label(slowest.driver_id)} · lap ${slowest.lap}` : undefined
          }
        />
        <StatTile
          label="Best crew avg"
          value={bestCrew ? formatDuration(bestCrew.averageSeconds) : "—"}
          detail={
            bestCrew
              ? `${bestCrew.code} · ${bestCrew.stops.length} stops`
              : undefined
          }
        />
      </div>

      <div className="apex-glass-soft rounded-2xl p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
          <h3 className="font-[family-name:var(--font-headline)] font-bold text-xl">
            Total pit-lane time
          </h3>
          <p className="font-medium text-[11px] text-warm-500">
            Entry to exit, stacked per stop · fastest crew first
          </p>
        </div>
        <div className="h-[420px] -ml-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 16, right: 24, left: 8, bottom: 24 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2a231d" horizontal={false} />
              <XAxis
                type="number"
                stroke="#5c554b"
                tick={{ fill: "var(--color-warm-400)", fontSize: 12 }}
                domain={[0, "dataMax"]}
                tickFormatter={(value: number) => `${Math.round(value)}s`}
                label={{
                  value: "Seconds in the pit lane",
                  position: "bottom",
                  fill: "#6f665b",
                  fontSize: 12,
                  dy: 10,
                }}
              />
              <YAxis
                type="category"
                dataKey="name"
                stroke="#5c554b"
                tick={{ fill: "var(--color-warm-100)", fontSize: 13, fontWeight: "bold" }}
                width={56}
              />
              <Tooltip
                cursor={{ fill: "rgba(255,255,255,0.05)" }}
                content={<PitTooltip />}
              />
              {Array.from({ length: maxStops }).map((_, idx) => (
                <Bar
                  key={idx}
                  dataKey={`stop${idx}_len`}
                  stackId="a"
                  isAnimationActive={false}
                >
                  {chartData.map((entry, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={String(entry.teamColor)}
                      // Successive stops fade so the segments of a single
                      // team-coloured bar stay tellable apart.
                      fillOpacity={1 - idx * 0.18}
                      stroke="#141110"
                      strokeWidth={1}
                    />
                  ))}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="apex-glass-soft rounded-2xl p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
          <h3 className="font-[family-name:var(--font-headline)] font-bold text-xl">
            Every stop
          </h3>
          {redFlagCount > 0 && (
            <p className="flex items-center gap-1.5 font-medium text-[11px] text-warm-500">
              <Flag className="w-3.5 h-3.5 text-flame" />
              {redFlagCount} suspension-length {redFlagCount === 1 ? "stop" : "stops"} excluded from the stats above
            </p>
          )}
        </div>

        <div className="grid grid-cols-[1fr_56px_56px_100px_84px] gap-3 px-4 pb-2.5 border-b border-white/10">
          <SortHeader label="Driver" sortBy="driver" {...sortProps} />
          <SortHeader label="Stop" sortBy="stop" className="justify-end" {...sortProps} />
          <SortHeader label="Lap" sortBy="lap" className="justify-end" {...sortProps} />
          <SortHeader
            label="Duration"
            sortBy="duration"
            className="justify-end"
            {...sortProps}
          />
          <span className="text-right uppercase tracking-[0.12em] font-bold text-[10px] text-warm-500">
            vs best
          </span>
        </div>

        <div className="max-h-[460px] overflow-y-auto">
          {sortedStops.map((stop) => {
            const driver = driverById.get(stop.driver_id);
            const isRedFlag = stop.duration_seconds >= RED_FLAG_SECONDS;
            const delta =
              fastest && !isRedFlag
                ? stop.duration_seconds - fastest.duration_seconds
                : null;

            return (
              <div
                key={`${stop.driver_id}-${stop.stop}`}
                className="grid grid-cols-[1fr_56px_56px_100px_84px] gap-3 items-center px-4 py-2.5 border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className="w-1 h-5 rounded-full shrink-0"
                    style={{ backgroundColor: driver?.teamColor ?? "#5c554b" }}
                  />
                  <span className="font-bold text-sm truncate">
                    {driver
                      ? `${driver.givenName} ${driver.familyName}`.trim()
                      : stop.driver_id}
                  </span>
                </div>
                <span className="text-right font-semibold text-sm tabular-nums text-warm-300">
                  {stop.stop}
                </span>
                <span className="text-right font-semibold text-sm tabular-nums text-warm-300">
                  {stop.lap}
                </span>
                <span
                  className={`text-right font-bold text-sm tabular-nums ${
                    isRedFlag
                      ? "text-warm-500"
                      : stop.duration_seconds === fastest?.duration_seconds
                        ? "text-primary"
                        : ""
                  }`}
                >
                  {formatDuration(stop.duration_seconds)}
                </span>
                <span className="text-right font-semibold text-xs tabular-nums text-warm-500">
                  {isRedFlag ? (
                    <Flag className="w-3.5 h-3.5 text-flame inline" />
                  ) : delta === 0 ? (
                    "—"
                  ) : delta == null ? (
                    /* An optional chain inside a template literal renders the
                       literal string "+undefined" rather than falling back --
                       `${undefined}` stringifies. Unreachable today, because
                       `delta` is only null when `fastest` is falsy and no rows
                       render in that case, but it is exactly the shape that
                       ships "+undefined" to the UI the first time the data
                       model shifts. */
                    "—"
                  ) : (
                    `+${delta.toFixed(3)}`
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
