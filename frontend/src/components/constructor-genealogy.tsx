"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { getConstructorIdentity } from "@/lib/constructor-identity";
import type { HistoricalRace } from "@/lib/api";
import type { ResolvedLineage, ResolvedNode } from "@/lib/constructor-lineages";
import { EASE_OUT } from "./motion-primitives";

interface ConstructorGenealogyProps {
  /** Already narrowed to the current grid by the page — see
   * `filterToCurrentGrid` in constructor-lineages.ts. */
  lineages: ResolvedLineage[];
  /** The same `/api/historical_race_index` payload the barcode above uses,
   * so a hovered era can report its real race-win count. Optional: the
   * genealogy is driven by a different endpoint and still renders fully
   * (minus the wins line) if the race index is unavailable. */
  races?: HistoricalRace[];
}

// --- Layout constants --------------------------------------------------

const CHART_START_YEAR = 1950;
const CHART_END_YEAR = 2026;
const LEFT_LABEL_WIDTH = 176;
const RIGHT_PADDING = 24;
const CHART_WIDTH = 1200;
const PLOT_LEFT = LEFT_LABEL_WIDTH + 8;
const PLOT_WIDTH = CHART_WIDTH - PLOT_LEFT - RIGHT_PADDING;
const TOP_AXIS_HEIGHT = 34;
const BAND_HEIGHT = 26;
const ROW_GAP = 18;
const BOTTOM_PADDING = 16;
/** A single-season era (Brawn 2009, Spyker 2007, Audi 2026) is ~13px wide at
 * this scale; this keeps it from collapsing to a hairline. */
const MIN_BAND_WIDTH = 5;

const LABEL_FONT = 10;
const LABEL_PAD = 6;
const CALLOUT_FONT = 9.5;
/** Two stacked callout lanes above a row. Alternating consecutive callouts
 * between them is what stops the 2006→2007→2008 Midland/Spyker/Force India
 * pile-up from overlapping; the push pass below handles whatever's left. */
const CALLOUT_LANES = 2;
// Comfortably taller than a 9.5px line box: consecutive callouts land in
// different lanes precisely because they overlap horizontally, so the lanes
// have to clear each other vertically with room to spare.
const CALLOUT_LANE_H = 15;
const CALLOUT_GAP = 7;

const YEAR_TICKS = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020, 2026];

function xForYear(year: number): number {
  const t = (year - CHART_START_YEAR) / (CHART_END_YEAR - CHART_START_YEAR);
  return PLOT_LEFT + t * PLOT_WIDTH;
}

function resolveNodeColor(node: ResolvedNode): { hex: string; glow: string } {
  if (node.fallbackHex) {
    return { hex: node.fallbackHex, glow: `${node.fallbackHex}66` };
  }
  if (node.colorKey) {
    return getConstructorIdentity(node.colorKey).color;
  }
  return getConstructorIdentity(node.ergastIds[0]).color;
}

// --- Text fitting -------------------------------------------------------

// SVG has no way to know how wide a string will be until it's laid out, and
// measuring with getComputedTextLength would mean a second render pass plus
// a server/client mismatch on first paint. This approximates the advance
// width of the app's body face (Hanken Grotesk, semibold) from per-character
// classes instead — deterministic, SSR-safe, and deliberately biased ~6%
// wide so a label never overflows the band it was cleared for.
const NARROW_CHARS = new Set("iljtfIr.,:;'!|·-–()[]");
const WIDE_CHARS = new Set("MWmw@");

function estimateTextWidth(text: string, fontSize: number): number {
  let units = 0;
  for (const ch of text) {
    if (ch === " ") units += 0.28;
    else if (NARROW_CHARS.has(ch)) units += 0.34;
    else if (WIDE_CHARS.has(ch)) units += 0.88;
    else if (ch >= "A" && ch <= "Z") units += 0.68;
    else units += 0.55;
  }
  return units * fontSize * 1.06;
}

/** Black or warm-white body text, whichever the band's fill can actually
 * carry. Threshold is the WCAG break-even luminance between the two. */
function readableTextOn(hex: string): string {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return "#f6f1ea";
  const channel = (offset: number) => {
    const c = parseInt(clean.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance =
    0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.179 ? "#100d0b" : "#f6f1ea";
}

/** "1970–98", "1993–2005", "2026" — compact enough to sit inside a band
 * next to the team name without eating the room the name needs. */
function eraYears(start: number, end: number): string {
  if (start === end) return String(start);
  const sameCentury = Math.floor(start / 100) === Math.floor(end / 100);
  return `${start}–${sameCentury ? String(end).slice(2) : end}`;
}

// --- Layout model -------------------------------------------------------

interface Callout {
  text: string;
  /** Final (de-collided) centre x of the label. */
  x: number;
  /** Centre x of the band it belongs to — where the leader line lands. */
  anchorX: number;
  lane: number;
}

interface Placement {
  node: ResolvedNode;
  nodeIndex: number;
  x0: number;
  x1: number;
  width: number;
  hex: string;
  textFill: string;
  /** Name (and years, when both fit) drawn inside the band itself. */
  inBand: { name: string; years: string | null } | null;
  /** Set instead of `inBand` when the band is too narrow for any label. */
  callout: Callout | null;
}

interface RowLayout {
  lineage: ResolvedLineage;
  bandY: number;
  laneCount: number;
  placements: Placement[];
  invalidNodes: ResolvedNode[];
}

interface HoverTarget {
  lineageId: string;
  nodeIndex: number;
  /** Container-relative anchor box of the hovered band. */
  x: number;
  top: number;
  bottom: number;
}

export default function ConstructorGenealogy({
  lineages,
  races = [],
}: ConstructorGenealogyProps) {
  const reduce = useReducedMotion();
  const [hovered, setHovered] = useState<HoverTarget | null>(null);
  const [pinned, setPinned] = useState<HoverTarget | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const active = hovered ?? pinned;

  useEffect(() => {
    if (!pinned) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setPinned(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [pinned]);

  // Race wins per era, from the race index the page already has in memory.
  // Scoped by the node's own resolved year range, which is what makes it
  // safe to match on `colorKey` as well as the raw Ergast ids: `colorKey` is
  // sometimes the backend's canonical key for an era Ergast files under a
  // reused raw id (`alfa` -> `alfa_sauber`), and sometimes a deliberate reuse
  // of a *different* era's key for colour only (Kick Sauber -> `bmw_sauber`)
  // — the year filter makes the second case contribute nothing.
  const winsByNode = useMemo(() => {
    const perKeySeason = new Map<string, number>();
    for (const race of races) {
      const key = `${race.constructor_key}|${race.season}`;
      perKeySeason.set(key, (perKeySeason.get(key) ?? 0) + 1);
    }
    const out = new Map<string, number>();
    for (const lineage of lineages) {
      lineage.nodes.forEach((node, index) => {
        if (node.invalid) return;
        const keys = new Set(node.ergastIds);
        if (node.colorKey) keys.add(node.colorKey);
        let wins = 0;
        const from = node.startYear as number;
        const to = node.endYear as number;
        for (let year = from; year <= to; year++) {
          for (const key of keys) wins += perKeySeason.get(`${key}|${year}`) ?? 0;
        }
        out.set(`${lineage.id}|${index}`, wins);
      });
    }
    return out;
  }, [lineages, races]);

  const { rows, chartHeight } = useMemo(() => {
    const laidOut: RowLayout[] = [];
    let cursor = TOP_AXIS_HEIGHT;

    for (const lineage of lineages) {
      const placements: Placement[] = [];
      const pending: { placement: Placement; width: number }[] = [];

      lineage.nodes.forEach((node, nodeIndex) => {
        if (node.invalid) return;
        const startYear = node.startYear as number;
        const endYear = node.endYear as number;
        const x0 = xForYear(startYear);
        // +1 so a single-season era still renders as a visible sliver
        // rather than a zero-width rect.
        const x1 = Math.max(xForYear(endYear + 1), x0 + MIN_BAND_WIDTH);
        const width = x1 - x0;
        const hex = resolveNodeColor(node).hex;
        const years = eraYears(startYear, endYear);
        const room = width - LABEL_PAD * 2;

        // Progressive disclosure, widest fit first: name + years, then name
        // alone, then a curated abbreviation, then nothing (-> callout).
        let inBand: Placement["inBand"] = null;
        if (estimateTextWidth(`${node.label}  ${years}`, LABEL_FONT) <= room) {
          inBand = { name: node.label, years };
        } else if (estimateTextWidth(node.label, LABEL_FONT) <= room) {
          inBand = { name: node.label, years: null };
        } else if (
          node.abbr &&
          estimateTextWidth(node.abbr, LABEL_FONT) <= room
        ) {
          inBand = { name: node.abbr, years: null };
        }

        const placement: Placement = {
          node,
          nodeIndex,
          x0,
          x1,
          width,
          hex,
          textFill: readableTextOn(hex),
          inBand,
          callout: null,
        };
        placements.push(placement);
        if (!inBand) {
          pending.push({
            placement,
            width: estimateTextWidth(node.label, CALLOUT_FONT),
          });
        }
      });

      // Callout placement: alternate lanes, clamp into the plot, then push
      // right off whatever the same lane already occupies.
      const laneCount = Math.min(pending.length, CALLOUT_LANES);
      const laneRight = new Array<number>(CALLOUT_LANES).fill(-Infinity);
      pending.forEach(({ placement, width }, index) => {
        const lane = laneCount > 1 ? index % CALLOUT_LANES : 0;
        const half = width / 2;
        const anchorX = (placement.x0 + placement.x1) / 2;
        let x = Math.min(
          Math.max(anchorX, PLOT_LEFT + half),
          CHART_WIDTH - 2 - half
        );
        if (x - half < laneRight[lane] + CALLOUT_GAP) {
          x = laneRight[lane] + CALLOUT_GAP + half;
        }
        laneRight[lane] = x + half;
        placement.callout = { text: placement.node.label, x, anchorX, lane };
      });

      const bandY = cursor + laneCount * CALLOUT_LANE_H;
      laidOut.push({
        lineage,
        bandY,
        laneCount,
        placements,
        invalidNodes: lineage.nodes.filter((node) => node.invalid),
      });
      cursor = bandY + BAND_HEIGHT + ROW_GAP;
    }

    return {
      rows: laidOut,
      chartHeight: cursor - ROW_GAP + BOTTOM_PADDING,
    };
  }, [lineages]);

  const activePlacement = useMemo(() => {
    if (!active) return null;
    const row = rows.find((r) => r.lineage.id === active.lineageId);
    if (!row) return null;
    const placement = row.placements.find(
      (p) => p.nodeIndex === active.nodeIndex
    );
    return placement ? { row, placement } : null;
  }, [active, rows]);

  function anchorFrom(
    element: SVGGraphicsElement,
    lineageId: string,
    nodeIndex: number
  ): HoverTarget | null {
    const container = containerRef.current?.getBoundingClientRect();
    if (!container) return null;
    const box = element.getBoundingClientRect();
    return {
      lineageId,
      nodeIndex,
      x: box.left + box.width / 2 - container.left,
      top: box.top - container.top,
      bottom: box.bottom - container.top,
    };
  }

  const activeNode = activePlacement?.placement.node ?? null;
  const activeWins = active
    ? winsByNode.get(`${active.lineageId}|${active.nodeIndex}`) ?? 0
    : 0;
  // Rows near the top of the chart get their tooltip below the band, so it
  // never escapes the panel and cover the section heading.
  const tooltipBelow = (active?.top ?? 0) < 96;

  return (
    <div ref={containerRef} className="relative">
      <div className="overflow-x-auto -mx-1 px-1">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${chartHeight}`}
          width="100%"
          style={{ minWidth: 860, height: "auto", display: "block" }}
          role="img"
          aria-label={`Constructor genealogy: every constructor on the current grid traced back to the team it began as, ${CHART_START_YEAR} to ${CHART_END_YEAR}.`}
          onMouseLeave={() => setHovered(null)}
        >
          {/* Year axis */}
          <g>
            {YEAR_TICKS.map((year) => (
              <g key={year}>
                <line
                  x1={xForYear(year)}
                  x2={xForYear(year)}
                  y1={TOP_AXIS_HEIGHT - 6}
                  y2={chartHeight - BOTTOM_PADDING}
                  stroke="rgba(255,255,255,0.06)"
                  strokeWidth={1}
                />
                <text
                  x={xForYear(year)}
                  y={TOP_AXIS_HEIGHT - 14}
                  fontSize={10}
                  fontWeight={700}
                  textAnchor="middle"
                  fill="#8f867a"
                  className="tabular-nums"
                >
                  {year}
                </text>
              </g>
            ))}
          </g>

          {rows.map((row, rowIndex) => {
            const { lineage, bandY, placements, invalidNodes } = row;
            const isDimmed = active !== null && active.lineageId !== lineage.id;
            return (
              <g
                key={lineage.id}
                style={{
                  opacity: isDimmed ? 0.18 : 1,
                  transition: "opacity 160ms ease",
                }}
              >
                <text
                  x={LEFT_LABEL_WIDTH}
                  y={bandY + BAND_HEIGHT / 2 + 4}
                  fontSize={11}
                  fontWeight={700}
                  textAnchor="end"
                  fill="#c9c0b4"
                >
                  {lineage.shortTitle}
                </text>

                {invalidNodes.length > 0 && (
                  // Curation error (typo'd id / bad yearRange) made visible
                  // rather than silently dropped — see the lineages module's
                  // "make curation errors visible" requirement.
                  <text
                    x={PLOT_LEFT + 4}
                    y={bandY + BAND_HEIGHT / 2 + 4}
                    fontSize={10}
                    fill="#FF5A5A"
                  >
                    ⚠ no data for &quot;
                    {invalidNodes
                      .flatMap((node) => node.ergastIds)
                      .join(", ")}
                    &quot;
                  </text>
                )}

                {/* Callout labels for eras too narrow to hold their own name,
                 * with a hairline leader down to the band they belong to. */}
                {placements.map((placement) => {
                  const callout = placement.callout;
                  if (!callout) return null;
                  const baseline =
                    bandY - 5 - callout.lane * CALLOUT_LANE_H;
                  const isActive =
                    active?.lineageId === lineage.id &&
                    active.nodeIndex === placement.nodeIndex;
                  return (
                    <g
                      key={`callout-${placement.nodeIndex}`}
                      style={{ pointerEvents: "none" }}
                    >
                      <line
                        x1={callout.anchorX}
                        y1={bandY - 1}
                        x2={callout.x}
                        y2={baseline + 2.5}
                        stroke={isActive ? placement.hex : "rgba(201,192,180,0.34)"}
                        strokeWidth={1}
                      />
                      <text
                        x={callout.x}
                        y={baseline}
                        fontSize={CALLOUT_FONT}
                        fontWeight={700}
                        textAnchor="middle"
                        fill={isActive ? "#f6f1ea" : "#a89e90"}
                      >
                        {callout.text}
                      </text>
                    </g>
                  );
                })}

                {/* Each era grows in place from its own left edge on scroll
                 * into view — transform/opacity only. An animated SVG
                 * `clipPath` reveal was tried first and proved unreliable
                 * across renderers (the clip region didn't consistently
                 * track the animated child). */}
                {placements.map((placement, index) => {
                  const { nodeIndex, x0, width, hex, inBand } = placement;
                  const isFirst = index === 0;
                  const isLast = index === placements.length - 1;
                  const isActive =
                    active?.lineageId === lineage.id &&
                    active.nodeIndex === nodeIndex;
                  const isMuted =
                    active?.lineageId === lineage.id && !isActive;

                  return (
                    <g
                      key={nodeIndex}
                      style={{
                        opacity: isMuted ? 0.5 : 1,
                        transition: "opacity 160ms ease",
                      }}
                    >
                      <motion.rect
                        x={x0}
                        y={bandY}
                        width={width}
                        height={BAND_HEIGHT}
                        rx={isFirst || isLast ? 4 : 0}
                        fill={hex}
                        style={{ cursor: "pointer", originX: 0 }}
                        initial={{ scaleX: reduce ? 1 : 0 }}
                        whileInView={{ scaleX: 1 }}
                        viewport={{ once: true, margin: "-60px" }}
                        transition={{
                          duration: reduce ? 0.01 : 0.5,
                          delay: reduce ? 0 : rowIndex * 0.05 + index * 0.06,
                          ease: EASE_OUT,
                        }}
                        onMouseEnter={(e) =>
                          setHovered(
                            anchorFrom(e.currentTarget, lineage.id, nodeIndex)
                          )
                        }
                        onClick={(e) =>
                          setPinned((current) =>
                            current?.lineageId === lineage.id &&
                            current.nodeIndex === nodeIndex
                              ? null
                              : anchorFrom(e.currentTarget, lineage.id, nodeIndex)
                          )
                        }
                      />
                      {/* The label fades in rather than riding the band's
                       * scaleX — a horizontally scaled <text> squashes its
                       * glyphs for the length of the reveal. */}
                      {inBand && (
                        <motion.text
                          x={x0 + LABEL_PAD}
                          y={bandY + BAND_HEIGHT / 2 + 3.5}
                          fontSize={LABEL_FONT}
                          fontWeight={700}
                          fill={placement.textFill}
                          style={{ pointerEvents: "none" }}
                          initial={{ opacity: reduce ? 1 : 0 }}
                          whileInView={{ opacity: 1 }}
                          viewport={{ once: true, margin: "-60px" }}
                          transition={{
                            duration: reduce ? 0.01 : 0.3,
                            delay: reduce
                              ? 0
                              : rowIndex * 0.05 + index * 0.06 + 0.28,
                            ease: EASE_OUT,
                          }}
                        >
                          {inBand.name}
                          {inBand.years && (
                            <tspan
                              dx={5}
                              opacity={0.62}
                              className="tabular-nums"
                              fontWeight={600}
                            >
                              {inBand.years}
                            </tspan>
                          )}
                        </motion.text>
                      )}

                      {/* Rename boundary: a hard divider at every era change,
                       * so a lineage always reads as a chain of distinct
                       * teams even where two consecutive eras resolve to
                       * near-identical colours (Kick Sauber / Audi). */}
                      {!isFirst && (
                        <line
                          x1={x0}
                          x2={x0}
                          y1={bandY - 2}
                          y2={bandY + BAND_HEIGHT + 2}
                          stroke="rgba(10,9,8,0.9)"
                          strokeWidth={2}
                          pointerEvents="none"
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* SVG has no z-index, so the focus ring for the active era is
              redrawn last rather than reordering the rows on hover. */}
          {activePlacement && (
            <rect
              x={activePlacement.placement.x0}
              y={activePlacement.row.bandY - 2}
              width={activePlacement.placement.width}
              height={BAND_HEIGHT + 4}
              rx={4}
              fill="none"
              stroke="rgba(246,241,234,0.9)"
              strokeWidth={1.5}
              pointerEvents="none"
            />
          )}
        </svg>
      </div>

      <div className="mt-3 text-[11px] font-medium text-warm-500">
        Hover an era for the story behind the rename — tap to pin it.
      </div>

      <AnimatePresence>
        {active && activeNode && (
          // Outer div owns the positioning transform; the inner motion.div
          // owns the enter/exit, because motion writes the whole `transform`
          // property and would otherwise clobber the translate.
          <div
            key="genealogy-tooltip"
            style={{
              position: "absolute",
              // clamp() keeps a centred tooltip inside the panel at both
              // ends of the timeline (Ferrari 1950, Audi 2026).
              left: `clamp(148px, ${active.x}px, calc(100% - 148px))`,
              top: tooltipBelow ? active.bottom + 10 : active.top - 10,
              transform: `translate(-50%, ${tooltipBelow ? "0" : "-100%"})`,
            }}
            className="z-50 pointer-events-none"
          >
          <motion.div
            role="tooltip"
            initial={{ opacity: 0, ...(reduce ? {} : { y: tooltipBelow ? -4 : 4 }) }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, ...(reduce ? {} : { y: tooltipBelow ? -4 : 4 }) }}
            transition={{ duration: reduce ? 0.1 : 0.16, ease: EASE_OUT }}
            className="w-72 max-w-[92vw] rounded-[10px] bg-[rgba(20,16,13,0.97)] border border-white/10 px-3.5 py-2.5 shadow-xl"
          >
            <div className="flex items-center gap-2">
              <span
                className="w-2.5 h-2.5 rounded-full flex-none"
                style={{ background: resolveNodeColor(activeNode).hex }}
              />
              <span className="font-[family-name:var(--font-headline)] font-bold text-[13px] text-warm-100">
                {activeNode.label}
              </span>
            </div>
            <div className="mt-1 text-[11px] font-bold tabular-nums text-warm-400">
              {activeNode.startYear === activeNode.endYear
                ? activeNode.startYear
                : `${activeNode.startYear}–${activeNode.endYear}`}
              <span className="text-warm-600"> · </span>
              {activeNode.seasonCount}{" "}
              {activeNode.seasonCount === 1 ? "season" : "seasons"}
              {races.length > 0 && (
                <>
                  <span className="text-warm-600"> · </span>
                  {activeWins === 0
                    ? "no wins"
                    : `${activeWins} ${activeWins === 1 ? "win" : "wins"}`}
                </>
              )}
            </div>
            <p className="mt-1.5 text-xs font-medium leading-snug text-warm-200">
              {activeNode.note}
            </p>
          </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
