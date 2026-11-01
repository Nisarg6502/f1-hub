/**
 * Geometry for the championship-progression share card.
 *
 * The page draws this chart with Recharts, which needs a DOM to measure into
 * and cannot run inside `next/og`. Satori does render inline `<svg>`, so the
 * card draws its own: this module turns `buildProgressionRows` output into
 * path strings, tick positions and end labels, and the card only paints them.
 *
 * Pure and deterministic — the same rows always produce the same `d`
 * attributes, which is what makes the card cacheable and these tests exact.
 */

import type { ProgressionRow } from "./championship-progression";

export interface ProgressionSeriesInput {
  id: string;
  label: string;
  colorHex: string;
}

export interface ChartBox {
  width: number;
  height: number;
  /** Room for the y-axis labels on the left and end labels on the right. */
  padLeft: number;
  padRight: number;
  padTop: number;
  padBottom: number;
}

export interface ChartPath {
  id: string;
  label: string;
  colorHex: string;
  /** Second entity to use its colour — drawn dashed, as the page chart does. */
  dashed: boolean;
  d: string;
  points: Array<{ x: number; y: number }>;
  endX: number;
  endY: number;
  /** Final cumulative total, printed beside the end label. */
  total: number;
}

export interface ChartGeometry {
  plot: { left: number; top: number; right: number; bottom: number };
  yTicks: Array<{ value: number; y: number }>;
  xLabels: Array<{ label: string; x: number }>;
  paths: ChartPath[];
  /** End labels after collision avoidance, keyed by series id. */
  labelY: Record<string, number>;
}

/**
 * The cap on how many lines a card draws.
 *
 * The page shows every driver because it can: a legend to toggle, a tooltip
 * to read. A PNG has neither, and twenty-two lines in eleven team colours —
 * half of them dashed duplicates — is a tangle nobody can read at thumbnail
 * size. Ten drivers keeps every title contender and the midfield fight; the
 * constructors' field is never more than eleven, so it is drawn whole.
 */
export function progressionSeriesLimit(kind: "drivers" | "constructors"): number {
  return kind === "drivers" ? 10 : 11;
}

/**
 * "Nice" axis ticks from zero: steps of 1, 2, 2.5 or 5 × 10ⁿ, ending at or
 * above `max`. `max <= 0` (no points scored yet) still yields a usable
 * 0…1 axis rather than a division by zero.
 */
export function niceTicks(max: number, target = 5): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const rough = max / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v < max + step * 0.0001; v += step) ticks.push(Number(v.toFixed(6)));
  if (ticks[ticks.length - 1] < max) ticks.push(Number((ticks[ticks.length - 1] + step).toFixed(6)));
  return ticks;
}

/**
 * Which round names to print on the x axis: always the first and the last
 * (the two that orient a reader), then evenly spaced ones between, never
 * more than `max`. The same rule the page's `preserveStartEnd` applies,
 * without a DOM to measure.
 */
export function pickLabelIndices(count: number, max: number): number[] {
  if (count <= 0) return [];
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  if (max <= 1) return [count - 1];
  const out = new Set<number>();
  for (let k = 0; k < max; k++) out.add(Math.round((k * (count - 1)) / (max - 1)));
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * Move end labels apart so none overlap, keeping each as close to its line
 * as possible.
 *
 * One pass down pushing each label below the one above it, then one pass up
 * if the stack ran off the bottom. Order is preserved, so a label never
 * crosses its neighbour — the leader's label is always on top.
 */
export function spreadLabels(
  items: ReadonlyArray<{ id: string; y: number }>,
  { gap, min, max }: { gap: number; min: number; max: number }
): Record<string, number> {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
  const ys = sorted.map((item) => Math.min(max, Math.max(min, item.y)));
  for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + gap);
  if (ys.length && ys[ys.length - 1] > max) {
    ys[ys.length - 1] = max;
    for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - gap);
  }
  const out: Record<string, number> = {};
  sorted.forEach((item, i) => {
    out[item.id] = Math.round(ys[i] * 10) / 10;
  });
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Everything the card needs to paint the chart.
 *
 * `series` arrives in standings order (the caller has already capped it), so
 * the dashed-second rule matches the page: the higher-placed driver of a
 * pair keeps the solid line.
 */
export function buildProgressionGeometry(
  rows: readonly ProgressionRow[],
  series: readonly ProgressionSeriesInput[],
  box: ChartBox,
  { maxXLabels = 6, labelGap = 22 }: { maxXLabels?: number; labelGap?: number } = {}
): ChartGeometry {
  const plot = {
    left: box.padLeft,
    top: box.padTop,
    right: box.width - box.padRight,
    bottom: box.height - box.padBottom,
  };
  const plotW = Math.max(1, plot.right - plot.left);
  const plotH = Math.max(1, plot.bottom - plot.top);

  const maxValue = Math.max(
    0,
    ...rows.flatMap((row) => series.map((s) => row.cumulative[s.id] ?? 0))
  );
  const ticks = niceTicks(maxValue);
  const top = ticks[ticks.length - 1] || 1;

  const x = (i: number) =>
    rows.length <= 1 ? plot.left + plotW / 2 : plot.left + (i * plotW) / (rows.length - 1);
  const y = (v: number) => plot.bottom - (v / top) * plotH;

  const seen = new Set<string>();
  const paths: ChartPath[] = series.map((s) => {
    const dashed = seen.has(s.colorHex);
    seen.add(s.colorHex);
    const points = rows.map((row, i) => ({ x: round1(x(i)), y: round1(y(row.cumulative[s.id] ?? 0)) }));
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
    const last = points[points.length - 1] ?? { x: plot.left, y: plot.bottom };
    return {
      id: s.id,
      label: s.label,
      colorHex: s.colorHex,
      dashed,
      d,
      points,
      endX: last.x,
      endY: last.y,
      total: rows.length ? (rows[rows.length - 1].cumulative[s.id] ?? 0) : 0,
    };
  });

  const labelY = spreadLabels(
    paths.map((p) => ({ id: p.id, y: p.endY })),
    { gap: labelGap, min: plot.top, max: plot.bottom }
  );

  return {
    plot,
    yTicks: ticks.map((value) => ({ value, y: round1(y(value)) })),
    xLabels: pickLabelIndices(rows.length, maxXLabels).map((i) => ({
      label: rows[i].shortName,
      x: round1(x(i)),
    })),
    paths,
    labelY,
  };
}
