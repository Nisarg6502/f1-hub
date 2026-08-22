"use client";

/**
 * Where one driver's championship points actually came from.
 *
 * The standings table answers "how many" and nothing else. The interesting
 * question — *which weekends* — was only answerable by opening the schedule and
 * reading twenty-four result pages one at a time. This is that read, folded
 * into the row it belongs to.
 *
 * Two readings, deliberately, because people arrive wanting different things:
 *
 *   1. **The season at a glance.** A wrapping grid of one tile per round,
 *      colour-coded by outcome, with a points bar under each. Wins jump out,
 *      retirements jump out, and a barren run of midfield weekends reads as a
 *      block of grey without anyone having to compare numbers.
 *   2. **The specific weekend.** Each tile carries its round, the circuit, grid
 *      and finish, and the points, so the answer to "what happened in Baku" is
 *      in the tile rather than behind another click.
 *
 * A wrapping grid rather than a horizontal strip on purpose. A scroll container
 * hides its own tail — the reader cannot see that rounds 15-24 exist — and this
 * whole panel exists to stop information being hidden.
 */

import { motion, useReducedMotion } from "motion/react";
import type { DriverSeasonLog, DriverRoundEntry } from "@/lib/season-results";
import type { TeamColor } from "@/lib/team-colors";

/** A win is the yardstick every other result is drawn against. 25 rather than
 * 33 (a win plus a sprint win) because the sprint is the rare case, and scaling
 * every bar down by a quarter to leave room for it would flatten the whole
 * season. Bars are clamped, so a sprint-weekend win simply fills. */
const WIN_POINTS = 25;

type Outcome = "win" | "podium" | "points" | "classified" | "dnf";

function outcomeOf(entry: DriverRoundEntry): Outcome {
  if (!entry.finished) return "dnf";
  if (entry.position === 1) return "win";
  if (entry.position !== null && entry.position <= 3) return "podium";
  if (entry.points > 0) return "points";
  return "classified";
}

/**
 * Outcome is encoded by *label and position first*, colour second — the
 * position number is printed on every tile, so the palette is a scanning aid
 * rather than the only carrier of the fact. That is what keeps the grid
 * readable for a colour-blind reader, and it is why a retirement is also
 * spelled out — `DNF` in place of the position, or a `RET` tag beside it when
 * the car was classified anyway — instead of relying on being the red one.
 */
function tileStyle(outcome: Outcome, color: TeamColor): React.CSSProperties {
  switch (outcome) {
    case "win":
      return {
        background: "linear-gradient(160deg, rgba(255,174,106,0.30), rgba(255,90,31,0.16))",
        borderColor: "rgba(255,138,61,0.62)",
      };
    case "podium":
      return {
        background: "rgba(255,138,61,0.13)",
        borderColor: "rgba(255,138,61,0.34)",
      };
    case "points":
      return {
        background: `${color.hex}14`,
        borderColor: `${color.hex}44`,
      };
    case "dnf":
      return {
        background: "rgba(255,68,68,0.09)",
        borderColor: "rgba(255,107,107,0.30)",
      };
    default:
      return {
        background: "rgba(245,235,222,0.04)",
        borderColor: "rgba(255,255,255,0.08)",
      };
  }
}

/**
 * What the big line on a tile says. `positionText` carries Ergast's letters
 * for anyone not classified (`R`, `D`, `W`, `N`) and none of them mean anything
 * to a reader, so an unclassified round reads `DNF`.
 *
 * A car can also *retire and still be classified* — stop with two laps to go
 * having covered 90% of the distance, and the result sheet still gives it a
 * position. Antonelli's 2026 Barcelona (P16, status `Retired`) is exactly that.
 * Those keep their real position here and are tagged `RET` beside it: printing
 * `DNF` over a classified P16 would contradict the result, and printing a bare
 * P16 would contradict the tile's own colour.
 */
function finishLabel(entry: DriverRoundEntry): string {
  if (entry.position !== null) return `P${entry.position}`;
  if (!entry.finished) return "DNF";
  return entry.positionText || "—";
}

/** True for the retired-but-classified case above, where the position alone
 * would understate what happened. */
function retiredButClassified(entry: DriverRoundEntry): boolean {
  return !entry.finished && entry.position !== null;
}

function Chip({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg px-2.5 py-1.5 bg-[rgba(245,235,222,0.045)] border border-white/[0.06]">
      <div className="font-extrabold text-[13px] tabular-nums leading-none">{value}</div>
      <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500 mt-1">
        {label}
      </div>
    </div>
  );
}

function LegendKey({ outcome, label, color }: { outcome: Outcome; label: string; color: TeamColor }) {
  const style = tileStyle(outcome, color);
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="w-2.5 h-2.5 rounded-hairline border"
        style={{ background: style.background, borderColor: style.borderColor }}
      />
      <span className="font-semibold text-[9px] tracking-[0.08em] uppercase text-warm-500">
        {label}
      </span>
    </span>
  );
}

export default function DriverSeasonLog({
  log,
  color,
  championshipPoints,
  onOpenProfile,
}: {
  log: DriverSeasonLog | undefined;
  color: TeamColor;
  /** The total the standings row shows, for the reconciliation note below. */
  championshipPoints: number;
  onOpenProfile: () => void;
}) {
  const reduce = useReducedMotion();

  if (!log || log.entries.length === 0) {
    return (
      <p className="font-medium text-xs text-warm-400 px-1 py-2">
        No round-by-round results are available for this season yet.
      </p>
    );
  }

  // Sprints, race results and the championship table are three separate feeds
  // and any of them can be a round behind the others. Stating the difference is
  // the only honest option: silently showing a total that disagrees with the
  // number three inches above it is how a reader decides the whole page is
  // guesswork.
  const drift = Math.round((championshipPoints - log.totalPoints) * 10) / 10;

  return (
    <div className="px-1 pt-3 pb-1">
      {/* Summary. The row above already states wins and points, so these are
          the figures it does not: consistency, and its opposite. */}
      <div className="flex flex-wrap gap-2">
        <Chip label="Best" value={log.bestFinish !== null ? `P${log.bestFinish}` : "—"} />
        <Chip label="Podiums" value={log.podiums} />
        <Chip label="In points" value={`${log.pointsFinishes}/${log.entries.length}`} />
        <Chip label="Retired" value={log.dnfs} />
        {log.bestRound && (
          <Chip
            label="Best haul"
            value={`${log.bestRound.points} · ${log.bestRound.shortName}`}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-3.5 mb-2">
        <span className="font-bold text-[10px] tracking-[0.12em] uppercase text-flame">
          Round by round
        </span>
        <LegendKey outcome="win" label="Win" color={color} />
        <LegendKey outcome="podium" label="Podium" color={color} />
        <LegendKey outcome="points" label="Points" color={color} />
        <LegendKey outcome="classified" label="No points" color={color} />
        <LegendKey outcome="dnf" label="Retired" color={color} />
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(78px,1fr))] gap-1.5">
        {log.entries.map((entry) => {
          const outcome = outcomeOf(entry);
          const style = tileStyle(outcome, color);
          const barPct = Math.min(100, (entry.points / WIN_POINTS) * 100);
          const gridLabel = entry.grid !== null && entry.grid > 0 ? `P${entry.grid}` : "PL";
          return (
            <div
              key={entry.round}
              className="rounded-control border px-2 pt-1.5 pb-2 min-w-0"
              style={style}
              title={[
                `Round ${entry.round} — ${entry.raceName}`,
                `Started ${gridLabel}, finished ${finishLabel(entry)}`,
                entry.status && !entry.finished ? entry.status : null,
                entry.sprintPoints > 0
                  ? `${entry.racePoints} race + ${entry.sprintPoints} sprint points`
                  : `${entry.points} points`,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <div className="flex items-baseline justify-between gap-1">
                <span className="font-bold text-[9px] tabular-nums text-warm-500">
                  R{entry.round}
                </span>
                <span className="font-bold text-[9px] tabular-nums text-warm-500">
                  {gridLabel}
                  <span className="text-warm-600"> →</span>
                </span>
              </div>
              <div className="font-semibold text-[9px] tracking-[0.04em] uppercase text-warm-400 truncate mt-0.5">
                {entry.shortName}
              </div>
              <div className="flex items-baseline justify-between gap-1 mt-1">
                <span className="flex items-baseline gap-1 min-w-0">
                  <span
                    className={`font-[family-name:var(--font-headline)] font-extrabold text-[15px] leading-none tabular-nums ${
                      outcome === "win" || outcome === "podium"
                        ? "text-primary"
                        : outcome === "dnf"
                          ? "text-[#FF9B8F]"
                          : "text-warm-100"
                    }`}
                  >
                    {finishLabel(entry)}
                  </span>
                  {retiredButClassified(entry) && (
                    <span className="font-bold text-[8px] tracking-[0.08em] uppercase text-[#FF9B8F]">
                      ret
                    </span>
                  )}
                </span>
                <span className="font-bold text-[10px] tabular-nums text-warm-300">
                  {entry.points > 0 ? `+${entry.points}` : "0"}
                </span>
              </div>
              {/* The points bar. Its only job is to make a big weekend visible
                  without reading the number, so it is drawn at zero width too —
                  a missing track would make a pointless round look like a
                  different kind of row rather than an empty one. */}
              <div className="h-[3px] rounded-full mt-1.5 bg-white/[0.07] overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  style={{
                    background:
                      outcome === "win" || outcome === "podium"
                        ? "linear-gradient(90deg,var(--color-primary),var(--color-primary-container))"
                        : color.hex,
                  }}
                  initial={reduce ? false : { width: 0 }}
                  animate={{ width: `${barPct}%` }}
                  transition={{ duration: 0.45, ease: [0.23, 1, 0.32, 1] }}
                />
              </div>
              {entry.sprintPoints > 0 && (
                <div className="font-semibold text-[9px] tracking-[0.06em] uppercase text-warm-500 mt-1">
                  {entry.sprintPosition !== null ? `SPR P${entry.sprintPosition}` : "SPR"} ·
                  +{entry.sprintPoints}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
        <p className="font-medium text-[10px] text-warm-500">
          {log.entries.length} round{log.entries.length === 1 ? "" : "s"} ·{" "}
          <span className="tabular-nums">{log.totalPoints}</span>{" "}
          {log.totalPoints === 1 ? "point" : "points"} from race
          {log.entries.some((e) => e.sprintPoints > 0) ? " and sprint" : ""} results
          {drift !== 0 && (
            <>
              {" "}
              · <span className="tabular-nums">{drift > 0 ? `+${drift}` : drift}</span>{" "}
              not yet reflected in per-round results
            </>
          )}
        </p>
        <button
          type="button"
          onClick={onOpenProfile}
          className="font-bold text-[10px] tracking-[0.08em] uppercase px-3 py-1.5 rounded-lg apex-glass-soft text-warm-200 hover:text-primary transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
        >
          Full profile
        </button>
      </div>
    </div>
  );
}
