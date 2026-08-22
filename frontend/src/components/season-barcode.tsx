"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import type { HistoricalRace } from "@/lib/api";
import { getConstructorIdentity } from "@/lib/constructor-identity";

// The 75-Season Barcode (CP48) — every F1 championship race since 1950 as
// one thin vertical stripe, coloured by winning constructor. The SVG only
// draws rectangles: decade ticks and the hover tooltip are plain HTML
// overlays positioned by percentage, NOT SVG text, because the barcode uses
// `preserveAspectRatio="none"` (an intentional non-uniform stretch so ~1160
// 1-unit-wide stripes fill any container width with zero per-stripe layout
// math) — SVG text glyphs would stretch/skew under that same transform and
// read as broken. Rects have no such problem; a stretched rectangle is still
// a clean rectangle.

interface SeasonBarcodeProps {
  /** Real (non-ghost) races, already sorted by (season, round) ascending. */
  races: HistoricalRace[];
  /** Unraced rounds remaining in the active, in-progress season. */
  ghostSlots: number;
  activeSeason: number;
}

interface ActiveFilter {
  type: "constructor" | "indy";
  key: string;
}

const DECADE_START = 1950;
const DECADE_STEP = 10;

const STRIPE_TOP = 6;
const STRIPE_HEIGHT = 72;

const INDY_TOOLTIP =
  "The Indianapolis 500 counted toward the World Championship from 1950-1960, despite most F1 teams never entering it.";

function pct(index: number, total: number): number {
  if (total <= 0) return 0;
  return ((index + 0.5) / total) * 100;
}

export default function SeasonBarcode({ races, ghostSlots, activeSeason }: SeasonBarcodeProps) {
  const reduce = useReducedMotion();
  const containerRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState(() => !!reduce);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const [hoverFilter, setHoverFilter] = useState<ActiveFilter | null>(null);
  const [pinnedFilter, setPinnedFilter] = useState<ActiveFilter | null>(null);

  const total = races.length + ghostSlots;
  const activeIndex = hoveredIndex ?? pinnedIndex;
  const activeFilter = hoverFilter ?? pinnedFilter;

  useEffect(() => {
    if (reduce) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [reduce]);

  const decadeTicks = useMemo(() => {
    if (races.length === 0) return [];
    const lastSeason = races[races.length - 1].season;
    const ticks: { label: string; leftPct: number }[] = [];
    for (let decade = DECADE_START; decade <= lastSeason; decade += DECADE_STEP) {
      const idx = races.findIndex((r) => r.season >= decade);
      if (idx === -1) continue;
      ticks.push({ label: String(decade), leftPct: pct(idx, total) });
    }
    return ticks;
  }, [races, total]);

  // Top constructors by race-win count, for the legend — not all ~40 keys,
  // just the handful that make eras legible (Ferrari waves, the Mercedes
  // wall, Red Bull's rise, ...).
  const legendEntries = useMemo(() => {
    const counts = new Map<string, number>();
    let indyCount = 0;
    for (const race of races) {
      if (race.indy500) {
        indyCount += 1;
        continue;
      }
      counts.set(race.constructor_key, (counts.get(race.constructor_key) ?? 0) + 1);
    }
    const top: {
      type: "constructor" | "indy";
      key: string;
      wins: number;
      identity: ReturnType<typeof getConstructorIdentity>;
    }[] = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, wins]) => ({
        type: "constructor" as const,
        key,
        wins,
        identity: getConstructorIdentity(key),
      }));

    if (indyCount > 0) {
      top.push({
        type: "indy" as const,
        key: "__indy500__",
        wins: indyCount,
        identity: { name: "Indy 500 (1950-60)", color: { hex: "#9AA0A6", glow: "#9AA0A666" } },
      });
    }
    return top;
  }, [races]);

  function matchesFilter(race: HistoricalRace, filter: ActiveFilter): boolean {
    return filter.type === "indy" ? race.indy500 : race.constructor_key === filter.key;
  }

  function opacityFor(index: number, race: HistoricalRace): number {
    if (activeIndex !== null) return index === activeIndex ? 1 : 0.4;
    if (activeFilter) return matchesFilter(race, activeFilter) ? 1 : 0.15;
    return 1;
  }

  const activeRace = activeIndex !== null ? races[activeIndex] : null;
  const activeIsGhost = activeIndex !== null && activeIndex >= races.length;
  const tooltipLeftPct = activeIndex !== null ? pct(activeIndex, total) : 0;

  const activeSeasonRunRounds = useMemo(
    () => races.filter((r) => r.season === activeSeason).length,
    [races, activeSeason]
  );
  const ghostRoundNumber =
    activeIsGhost && activeIndex !== null ? activeSeasonRunRounds + (activeIndex - races.length) + 1 : null;

  return (
    <div>
      <div ref={containerRef} className="relative select-none">
        <svg
          viewBox={`0 0 ${Math.max(total, 1)} 100`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Barcode of ${races.length} Formula 1 championship races, ${races[0]?.season ?? ""}-${
            races[races.length - 1]?.season ?? ""
          }, one stripe per race coloured by winning constructor.`}
          className="w-full h-24 sm:h-28 block rounded-md overflow-visible"
          onMouseLeave={() => setHoveredIndex(null)}
        >
          <defs>
            <pattern id="barcode-ghost-hatch" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="3" height="3" fill="rgba(245,235,222,0.05)" />
              <line x1="0" y1="0" x2="0" y2="3" stroke="rgba(245,235,222,0.18)" strokeWidth="1.4" />
            </pattern>
          </defs>

          {races.map((race, index) => {
            const identity = getConstructorIdentity(race.constructor_key);
            const isIndy = race.indy500;
            const opacity = opacityFor(index, race);
            return (
              <rect
                key={`${race.season}-${race.round}`}
                x={index}
                y={STRIPE_TOP}
                width={1}
                height={STRIPE_HEIGHT}
                fill={identity.color.hex}
                opacity={opacity}
                stroke={isIndy ? "rgba(245,235,222,0.55)" : "none"}
                strokeWidth={isIndy ? 0.3 : 0}
                style={
                  reduce
                    ? undefined
                    : {
                        transformBox: "fill-box",
                        transformOrigin: "center",
                        transform: revealed ? "scaleY(1)" : "scaleY(0.02)",
                        transition: `transform 240ms cubic-bezier(0.23,1,0.32,1) ${
                          (index / Math.max(total, 1)) * 900
                        }ms, opacity 160ms ease-out`,
                      }
                }
                className="cursor-pointer"
                onMouseEnter={() => setHoveredIndex(index)}
                onClick={() => setPinnedIndex((v) => (v === index ? null : index))}
              />
            );
          })}

          {ghostSlots > 0 &&
            Array.from({ length: ghostSlots }).map((_, g) => {
              const index = races.length + g;
              const opacity = activeIndex !== null ? (index === activeIndex ? 1 : 0.4) : 1;
              return (
                <rect
                  key={`ghost-${g}`}
                  x={index}
                  y={STRIPE_TOP}
                  width={1}
                  height={STRIPE_HEIGHT}
                  fill="url(#barcode-ghost-hatch)"
                  opacity={opacity}
                  style={
                    reduce
                      ? undefined
                      : {
                          transformBox: "fill-box",
                          transformOrigin: "center",
                          transform: revealed ? "scaleY(1)" : "scaleY(0.02)",
                          transition: `transform 240ms cubic-bezier(0.23,1,0.32,1) ${
                            (index / Math.max(total, 1)) * 900
                          }ms, opacity 160ms ease-out`,
                        }
                  }
                  className="cursor-pointer"
                  onMouseEnter={() => setHoveredIndex(index)}
                  onClick={() => setPinnedIndex((v) => (v === index ? null : index))}
                />
              );
            })}

          {/* Highlight overlay: SVG has no z-index, so the "raised" stripe is
              redrawn as the very last child to sit visually above its
              neighbours instead of reordering the whole array on hover. */}
          {activeIndex !== null && (
            <rect
              x={activeIndex}
              y={STRIPE_TOP - 3}
              width={1}
              height={STRIPE_HEIGHT + 6}
              fill={
                activeIsGhost
                  ? "rgba(245,235,222,0.35)"
                  : getConstructorIdentity(races[activeIndex]?.constructor_key ?? "").color.hex
              }
              stroke="rgba(255,255,255,0.9)"
              strokeWidth={0.35}
              pointerEvents="none"
            />
          )}
        </svg>

        {/* Decade ticks — HTML, not SVG text (see file-top comment). */}
        <div className="relative h-4 mt-1.5">
          {decadeTicks.map((tick) => (
            <span
              key={tick.label}
              className="absolute -translate-x-1/2 font-semibold text-[10px] tracking-[0.04em] text-warm-500 tabular-nums"
              style={{ left: `${tick.leftPct}%` }}
            >
              {tick.label}
            </span>
          ))}
          {ghostSlots > 0 && (
            <span
              className="absolute -translate-x-1/2 font-semibold text-[10px] tracking-[0.04em] text-warm-500 tabular-nums"
              style={{ left: `${pct(total - 1, total)}%` }}
            >
              {activeSeason} →
            </span>
          )}
        </div>

        {/* Floating tooltip for the active (hovered/pinned) stripe. */}
        {activeIndex !== null && (
          <div
            role="tooltip"
            className="absolute z-20 bottom-[calc(100%+10px)] w-60 -translate-x-1/2 rounded-control bg-[rgba(20,16,13,0.97)] border border-white/10 px-3.5 py-2.5 text-xs font-medium leading-snug text-warm-200 shadow-xl pointer-events-none"
            style={{
              left: `clamp(120px, ${tooltipLeftPct}%, calc(100% - 120px))`,
            }}
          >
            {activeIsGhost ? (
              <>
                <div className="font-bold text-warm-100 mb-0.5">Not yet raced</div>
                <div>
                  Round {ghostRoundNumber} of the {activeSeason} season is still to come.
                </div>
              </>
            ) : activeRace ? (
              <>
                <div className="font-bold text-warm-100 mb-0.5">
                  {activeRace.race_name ?? "Grand Prix"} · {activeRace.season}
                </div>
                <div>
                  {activeRace.driver ?? "Unknown driver"} · {activeRace.constructor_name ?? activeRace.constructor_key}
                </div>
                {activeRace.indy500 && <div className="mt-1.5 text-warm-400">{INDY_TOOLTIP}</div>}
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* Legend — hover isolates a constructor's stripes across all 75
          years; click/tap pins the isolation (hover doesn't exist on touch). */}
      <div className="flex flex-wrap gap-x-4 gap-y-2.5 mt-5">
        {legendEntries.map((entry) => {
          const filter: ActiveFilter = { type: entry.type, key: entry.key };
          const isPinned =
            pinnedFilter?.type === entry.type && pinnedFilter?.key === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              className={`flex items-center gap-1.5 text-xs font-semibold px-1.5 py-1 rounded-md transition-colors ${
                isPinned ? "bg-[rgba(245,235,222,0.08)]" : "hover:bg-[rgba(245,235,222,0.05)]"
              }`}
              onMouseEnter={() => setHoverFilter(filter)}
              onMouseLeave={() => setHoverFilter(null)}
              onClick={() =>
                setPinnedFilter((v) => (v && v.key === entry.key && v.type === entry.type ? null : filter))
              }
            >
              <span
                className="w-2.5 h-2.5 rounded-hairline flex-none"
                style={{ backgroundColor: entry.identity.color.hex }}
              />
              <span className="text-warm-300">{entry.identity.name}</span>
              <span className="text-warm-600 tabular-nums">{entry.wins}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
