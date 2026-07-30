"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { getConstructorIdentity } from "@/lib/constructor-identity";
import type { ResolvedLineage, ResolvedNode } from "@/lib/constructor-lineages";

interface ConstructorGenealogyProps {
  lineages: ResolvedLineage[];
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
const ROW_HEIGHT = 22;
const ROW_GAP = 14;
const ROW_PITCH = ROW_HEIGHT + ROW_GAP;
const BOTTOM_PADDING = 16;

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

interface SelectedSegment {
  lineageId: string;
  lineageTitle: string;
  node: ResolvedNode;
  x: number;
  y: number;
}

export default function ConstructorGenealogy({
  lineages,
}: ConstructorGenealogyProps) {
  const reduce = useReducedMotion();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedSegment | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setSelected(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [selected]);

  const chartHeight =
    TOP_AXIS_HEIGHT + lineages.length * ROW_PITCH + BOTTOM_PADDING;

  const rows = useMemo(
    () =>
      lineages.map((lineage, index) => ({
        lineage,
        rowY: TOP_AXIS_HEIGHT + index * ROW_PITCH,
      })),
    [lineages]
  );

  return (
    <div ref={containerRef} className="relative">
      <div className="overflow-x-auto -mx-1 px-1">
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${chartHeight}`}
          width="100%"
          style={{ minWidth: 760, height: "auto", display: "block" }}
          role="img"
          aria-label="Constructor genealogy timeline, 1950 to 2026"
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
                  fill="var(--warm-500, #8a7d6f)"
                  className="tabular-nums"
                >
                  {year}
                </text>
              </g>
            ))}
          </g>

          {rows.map(({ lineage, rowY }, rowIndex) => {
            const isDimmed = hoveredId !== null && hoveredId !== lineage.id;
            return (
              <g
                key={lineage.id}
                style={{
                  opacity: isDimmed ? 0.15 : 1,
                  transition: "opacity 150ms ease",
                }}
                onMouseEnter={() => setHoveredId(lineage.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <text
                  x={LEFT_LABEL_WIDTH}
                  y={rowY + ROW_HEIGHT / 2 + 4}
                  fontSize={11}
                  fontWeight={700}
                  textAnchor="end"
                  fill="var(--warm-200, #e8ddcf)"
                >
                  {lineage.shortTitle}
                </text>

                {/* Draws in left-to-right on scroll into view. Deliberately
                 * transform/opacity only (no clip-path reveal): an animated
                 * SVG `clipPath` referenced via `url(#...)` from a sibling
                 * `<motion.rect>` proved unreliable across renderers during
                 * verification (the clip region didn't consistently track
                 * the animated child), so each node instead grows in place
                 * from its own left edge — same left-to-right read, without
                 * depending on clipPath/animated-child interaction. */}
                <g>
                  {lineage.nodes.map((node, nodeIndex) => {
                    if (node.invalid) {
                      // Curation error (typo'd id / bad yearRange) made
                      // visible rather than silently dropped — see the
                      // module docstring's "make curation errors visible"
                      // requirement.
                      return (
                        <text
                          key={nodeIndex}
                          x={PLOT_LEFT + 4}
                          y={rowY + ROW_HEIGHT / 2 + 4}
                          fontSize={10}
                          fill="#FF5A5A"
                        >
                          ⚠ no data for &quot;{node.ergastIds.join(", ")}&quot;
                        </text>
                      );
                    }

                    const startYear = node.startYear as number;
                    const endYear = node.endYear as number;
                    const x0 = xForYear(startYear);
                    // +1 so a single-season node (e.g. Brawn GP, 2009) still
                    // renders a visible sliver rather than a zero-width rect.
                    const x1 = Math.max(
                      xForYear(endYear + 1),
                      x0 + 4
                    );
                    const width = x1 - x0;
                    const color = resolveNodeColor(node);
                    const isFirst = nodeIndex === 0;
                    const isLast = nodeIndex === lineage.nodes.length - 1;

                    return (
                      <g key={nodeIndex}>
                        <motion.rect
                          x={x0}
                          y={rowY}
                          width={width}
                          height={ROW_HEIGHT}
                          rx={isFirst || isLast ? 4 : 0}
                          fill={color.hex}
                          style={{ cursor: "pointer", originX: 0 }}
                          initial={{ scaleX: reduce ? 1 : 0 }}
                          whileInView={{ scaleX: 1 }}
                          viewport={{ once: true, margin: "-60px" }}
                          transition={{
                            duration: reduce ? 0.01 : 0.5,
                            delay: reduce ? 0 : rowIndex * 0.05 + nodeIndex * 0.06,
                            ease: [0.23, 1, 0.32, 1],
                          }}
                          onClick={(e) => {
                            const containerRect =
                              containerRef.current?.getBoundingClientRect();
                            setSelected({
                              lineageId: lineage.id,
                              lineageTitle: lineage.title,
                              node,
                              x: containerRect
                                ? e.clientX - containerRect.left
                                : 0,
                              y: containerRect
                                ? e.clientY - containerRect.top
                                : 0,
                            });
                          }}
                        />
                        {/* Transition marker: a visible divider + year label
                         * at every rename boundary, per the CP49 brief — this
                         * is the one part of the feature no automated test
                         * can validate, so curation must be legible on the
                         * chart itself, not hidden behind a hover-only
                         * tooltip. */}
                        {!isFirst && (
                          <g>
                            <line
                              x1={x0}
                              x2={x0}
                              y1={rowY - 2}
                              y2={rowY + ROW_HEIGHT + 2}
                              stroke="rgba(20,16,14,0.85)"
                              strokeWidth={2}
                            />
                            <text
                              x={x0}
                              y={rowY - 5}
                              fontSize={8}
                              fontWeight={700}
                              textAnchor="middle"
                              fill="var(--warm-500, #8a7d6f)"
                              className="tabular-nums"
                            >
                              {startYear}
                            </text>
                          </g>
                        )}
                      </g>
                    );
                  })}
                </g>
              </g>
            );
          })}
        </svg>
      </div>

      {selected && (
        <motion.div
          ref={popoverRef}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: reduce ? 0.1 : 0.16, ease: [0.23, 1, 0.32, 1] }}
          style={{
            position: "absolute",
            left: Math.min(selected.x, CHART_WIDTH - 260),
            top: selected.y + 12,
            transformOrigin: "top left",
          }}
          className="w-64 rounded-xl bg-[rgba(26,22,19,0.98)] border border-white/10 shadow-2xl z-50 p-4"
        >
          <div className="flex items-center gap-2 mb-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full flex-none"
              style={{ background: resolveNodeColor(selected.node).hex }}
            />
            <span className="font-[family-name:var(--font-headline)] font-bold text-sm">
              {selected.node.label}
            </span>
          </div>
          <div className="text-[11px] font-bold tabular-nums text-warm-400 mb-2">
            {selected.node.startYear}–{selected.node.endYear}
          </div>
          <p className="text-xs text-warm-300 leading-relaxed">
            {selected.node.note}
          </p>
        </motion.div>
      )}
    </div>
  );
}
