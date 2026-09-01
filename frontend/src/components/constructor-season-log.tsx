"use client";

/**
 * Where one constructor's championship points actually came from.
 *
 * The Drivers tab has had a round-by-round disclosure for a while; the
 * Constructors tab was a bar chart of totals and nothing else, so the only way
 * to find out whether a team's 340 points were two cars scoring steadily or one
 * car carrying a broken sister car all year was to open twenty-four result
 * pages. That distinction is the whole character of a constructor's season and
 * it was the one thing the tab could not say.
 *
 * So this panel is *not* the driver panel with a different noun. A driver's
 * round has one result; a constructor's round has two, and the second car is
 * the entire reason the view exists. Three things follow from that:
 *
 *   1. **Every tile shows both cars.** Not the total with the split hidden
 *      behind a hover — the split IS the content. A 43-point round renders as
 *      two named lines so "P1 and P2" and "P1 and P16" never look alike.
 *   2. **There is a season-long contribution bar.** One stacked bar over the
 *      whole season answers "who is actually scoring here" in one glance, which
 *      is the question the per-round grid can only answer by being read twenty
 *      times. It is also the one place a mid-season driver change becomes
 *      legible as a change rather than as a name you did not expect.
 *   3. **`Double points` is a headline stat.** Rounds where both cars scored is
 *      a constructor-only measure of a team's floor, and it has no meaning at
 *      all on the Drivers tab.
 *
 * The outcome palette, the legend and the label helpers come from
 * `season-log-primitives` so the two tabs' colour keys cannot drift apart. See
 * the note there for why the panels themselves stayed separate.
 */

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type {
  ConstructorSeasonLog,
  ConstructorRoundEntry,
  ConstructorDriverRound,
} from "@/lib/season-results";
import type { TeamColor } from "@/lib/team-colors";
import {
  Chip,
  LegendKey,
  finishLabel,
  gridLabelOf,
  outcomeStyle,
  placesGained,
  retiredButClassified,
  type Outcome,
} from "@/components/season-log-primitives";

/**
 * The yardstick every points bar is drawn against: a 1-2 finish, 43 points.
 *
 * Not 25 (the driver panel's win) — that would clamp every double podium to a
 * full bar and flatten exactly the difference this panel exists to show. Not 51
 * (a 1-2 plus both sprint podiums) either, because a sprint 1-2 is rare enough
 * that scaling the whole season down by a fifth to reserve room for it would
 * make an ordinary strong weekend look mediocre. Bars are clamped, so the rare
 * sprint-weekend 1-2 simply fills.
 */
const MAX_ROUND_POINTS = 43;

/** Shared with the accordion that owns this panel (`standings-view.tsx`) and
 * with `--ease-out-apex`, so the disclosure and its contents move as one. */
const EASE = [0.23, 1, 0.32, 1] as const;

/**
 * The band for a whole round, from the team's point of view.
 *
 * Order matters and is not the driver panel's order. A team whose lead car wins
 * while the other retires has had a *winning* weekend, so the best result wins
 * the tile — checking `dnf` first (as the driver version does, where there is
 * only one car and no ambiguity) would paint a victory red.
 *
 * `dnf` is therefore reserved for the genuinely bad round: the team scored
 * nothing AND no car reached the flag. A scoreless round where both cars
 * finished is `classified` — a quiet weekend, not a disaster — and the two look
 * different for the same reason they do on the Drivers tab.
 */
function constructorOutcomeOf(entry: ConstructorRoundEntry): Outcome {
  if (entry.bestPosition === 1) return "win";
  if (entry.bestPosition !== null && entry.bestPosition <= 3) return "podium";
  if (entry.points > 0) return "points";
  if (entry.drivers.every((d) => !d.finished)) return "dnf";
  return "classified";
}

/** `VER` where the feed carries a code, else the family name truncated by CSS.
 * The code is preferred because a tile row is ~52px wide and two names of
 * unequal length make the points column jump between rows. */
function shortDriverLabel(driver: ConstructorDriverRound): string {
  return driver.code || driver.name;
}

/**
 * One car's line inside a round tile.
 *
 * The points figure is the emphasised element rather than the position,
 * inverting the driver tile: on the Drivers tab you already know whose points
 * they are and want to know where they finished, whereas here the question is
 * which car produced the round's number. A non-scoring car is dimmed rather
 * than hidden — "Hulkenberg scored nothing" is information, and a tile that
 * silently drops the second car would make a one-car round and a two-car round
 * look identical.
 */
function DriverLine({
  driver,
  color,
}: {
  driver: ConstructorDriverRound;
  color: TeamColor;
}) {
  const scored = driver.points > 0;
  return (
    <div className="flex items-baseline justify-between gap-1.5 min-w-0">
      <span className="flex items-baseline gap-1 min-w-0">
        <span
          aria-hidden
          className="w-[3px] h-[3px] rounded-full flex-none self-center"
          style={{ background: scored ? color.hex : "var(--color-warm-600)" }}
        />
        <span
          className={`font-bold text-[9px] tracking-[0.06em] uppercase truncate ${
            scored ? "text-warm-200" : "text-warm-500"
          }`}
        >
          {shortDriverLabel(driver)}
        </span>
        <span
          className="font-semibold text-[9px] tabular-nums flex-none"
          style={{
            color: driver.finished
              ? "var(--color-warm-400)"
              : "var(--color-error)",
          }}
        >
          {finishLabel(driver)}
        </span>
      </span>
      <span
        className={`font-bold text-[10px] tabular-nums flex-none ${
          scored ? "text-warm-100" : "text-warm-600"
        }`}
      >
        {scored ? `+${driver.points}` : "0"}
      </span>
    </div>
  );
}

/**
 * The season-long contribution bar.
 *
 * A stacked bar rather than two numbers because the thing being asked is a
 * *ratio* — "is this a two-car team or a one-car team" — and a ratio is what a
 * stacked bar states without arithmetic. Each segment is the same team colour at
 * a different opacity rather than two unrelated hues: the drivers are teammates,
 * not opponents, and giving the second car its own colour would have put a
 * fourth meaning into a panel whose palette already carries outcome.
 *
 * Rendered at all times, including for a team with one driver (one full-width
 * segment, which correctly says "all of it"), but suppressed when the team has
 * no points, where every share is 0 and the bar would be an empty track
 * pretending to be a measurement.
 */
function ContributionBar({
  log,
  color,
}: {
  log: ConstructorSeasonLog;
  color: TeamColor;
}) {
  const reduce = useReducedMotion();
  if (log.totalPoints <= 0 || log.lineup.length === 0) return null;

  return (
    <div className="mt-3.5">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="font-bold text-[10px] tracking-[0.12em] uppercase text-flame">
          Who scored it
        </span>
        <span className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-600">
          {log.lineup.length} driver{log.lineup.length === 1 ? "" : "s"} used
        </span>
      </div>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-white/[0.06]">
        {log.lineup.map((driver, i) => (
          <motion.div
            key={driver.driverId}
            className="h-full"
            style={{
              // Descending opacity down the (points-sorted) lineup, floored so
              // a third or fourth stand-in never fades to invisible.
              background: color.hex,
              opacity: Math.max(0.28, 1 - i * 0.28),
              // A hairline between segments, because two adjacent opacities of
              // one hue can otherwise read as a single gradient.
              boxShadow: i > 0 ? "inset 1px 0 0 rgba(0,0,0,0.45)" : undefined,
            }}
            initial={reduce ? false : { width: 0 }}
            animate={{ width: `${driver.share}%` }}
            transition={{ duration: 0.5, ease: EASE }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3.5 gap-y-1 mt-2">
        {log.lineup.map((driver, i) => (
          <span key={driver.driverId} className="flex items-baseline gap-1.5">
            <span
              aria-hidden
              className="w-2 h-2 rounded-[2px] self-center flex-none"
              style={{ background: color.hex, opacity: Math.max(0.28, 1 - i * 0.28) }}
            />
            <span className="font-bold text-[11px] text-warm-100">{driver.name}</span>
            <span className="font-semibold text-[10px] tabular-nums text-warm-300">
              {driver.points} pt{driver.points === 1 ? "" : "s"}
            </span>
            <span className="font-semibold text-[10px] tabular-nums text-warm-500">
              {Math.round(driver.share)}%
            </span>
            {/* The round range, and only when it is not the whole season. A
                driver who did every round needs no qualifier; a stand-in who
                did R7-R8, or a driver who left after R12, is otherwise an
                unexplained name with a small share — which reads as a bad
                driver rather than as an absent one. */}
            {driver.rounds < log.entries.length && (
              <span className="font-semibold text-[9px] tracking-[0.06em] uppercase text-warm-600">
                {driver.firstRound === driver.lastRound
                  ? `R${driver.firstRound}`
                  : `R${driver.firstRound}–R${driver.lastRound}`}
                {" · "}
                {driver.rounds} of {log.entries.length}
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The readout under the grid — everything the tile had to truncate, for
 * whichever round the pointer or the keyboard is on.
 *
 * Deliberately not a tooltip, for the reasons spelled out on the driver panel's
 * equivalent: a `title` cannot be reached by keyboard and never appears on
 * touch. This one carries a line per car, because the tile can only fit a code
 * and a position and the interesting part of a constructor's round — one car
 * charged forward, the other went out on lap 3 — lives in the difference.
 */
function RoundDetail({
  entry,
  isActive,
  color,
}: {
  entry: ConstructorRoundEntry;
  isActive: boolean;
  color: TeamColor;
}) {
  return (
    <div className="py-2">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="font-bold text-[10px] tabular-nums tracking-[0.1em] uppercase text-flame">
          R{entry.round}
        </span>
        <span className="font-bold text-[13px] text-warm-100">{entry.raceName}</span>
        <span className="font-semibold text-[11px] tabular-nums text-warm-200">
          {entry.sprintPoints > 0
            ? `${entry.racePoints} race + ${entry.sprintPoints} sprint`
            : `${entry.points}`}{" "}
          <span className="text-warm-500">
            {entry.points === 1 ? "point" : "points"}
          </span>
        </span>
        {/* Only when it is true of the round, so it reads as a fact about this
            weekend rather than as a permanent label. */}
        {entry.scorers >= 2 && (
          <span className="font-bold text-[9px] tracking-[0.1em] uppercase text-primary">
            both cars scored
          </span>
        )}
        {entry.points === 0 && (
          <span className="font-bold text-[9px] tracking-[0.1em] uppercase text-warm-500">
            blank weekend
          </span>
        )}
        <span className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-600 ml-auto">
          {isActive ? "This round" : "Best haul"}
        </span>
      </div>
      <div className="flex flex-col gap-1 mt-1.5">
        {entry.drivers.map((driver) => {
          const gained = placesGained(driver);
          return (
            <div
              key={driver.driverId}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
            >
              <span
                aria-hidden
                className="w-1 h-3 rounded-hairline self-center flex-none"
                style={{
                  background: driver.points > 0 ? color.hex : "var(--color-warm-700)",
                }}
              />
              <span className="font-bold text-[11px] text-warm-100 min-w-[86px]">
                {driver.name}
              </span>
              <span className="font-semibold text-[11px] tabular-nums text-warm-300">
                {gridLabelOf(driver)}
                <span className="text-warm-600"> → </span>
                {finishLabel(driver)}
              </span>
              {retiredButClassified(driver) && (
                <span className="font-bold text-[9px] tracking-[0.08em] uppercase text-error">
                  ret
                </span>
              )}
              {gained !== null && gained !== 0 && (
                <span
                  className="font-bold text-[10px] tabular-nums"
                  style={{
                    color: gained > 0 ? "var(--color-primary)" : "var(--color-error)",
                  }}
                >
                  {gained > 0 ? `+${gained}` : gained}
                </span>
              )}
              {!driver.finished && driver.status && (
                <span className="font-semibold text-[10px] uppercase tracking-[0.06em] text-error">
                  {driver.status}
                </span>
              )}
              <span className="font-semibold text-[11px] tabular-nums text-warm-200 ml-auto">
                {driver.sprintPoints > 0
                  ? `${driver.racePoints} + ${driver.sprintPoints} spr`
                  : driver.points}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ConstructorSeasonLogPanel({
  log,
  color,
  championshipPoints,
}: {
  log: ConstructorSeasonLog | undefined;
  color: TeamColor;
  /** The total the standings row shows, for the reconciliation note below. */
  championshipPoints: number;
}) {
  const reduce = useReducedMotion();

  /** Hover previews, a click pins. Same two-source arrangement as the driver
   * panel, and for the same reason: hover alone strands keyboard and touch. */
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);

  const entries = useMemo(() => log?.entries ?? [], [log]);
  const activeRound = hovered ?? pinned;
  const active = useMemo(
    () => entries.find((e) => e.round === activeRound) ?? null,
    [entries, activeRound]
  );
  const resting = log?.bestRound ?? entries[entries.length - 1] ?? null;
  const shown = active ?? resting;

  if (!log || entries.length === 0) {
    return (
      <p className="font-medium text-xs text-warm-400 px-1 py-2">
        No round-by-round results are available for this season yet.
      </p>
    );
  }

  // Sprints, race results and the championship table are three separate feeds
  // and any of them can be a round behind the others. Stating the difference is
  // the only honest option — see the identical note on the driver panel.
  const drift = Math.round((championshipPoints - log.totalPoints) * 10) / 10;

  return (
    <div className="px-1 pt-3 pb-1">
      {/* The row above already states wins and points, so these are the figures
          it does not — and `Double points` is the one no driver row can have. */}
      <div className="flex flex-wrap gap-2">
        <Chip label="Podiums" value={log.podiums} />
        <Chip
          label="Double points"
          value={`${log.doubleScores}/${entries.length}`}
        />
        <Chip label="Blanks" value={log.blanks} />
        {log.bestRound && (
          <Chip
            label="Best haul"
            value={`${log.bestRound.points} · ${log.bestRound.shortName}`}
          />
        )}
        {log.lineup[0] && (
          <Chip label="Top scorer" value={log.lineup[0].name} />
        )}
      </div>

      <ContributionBar log={log} color={color} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-3.5 mb-2">
        <span className="font-bold text-[10px] tracking-[0.12em] uppercase text-flame">
          Round by round
        </span>
        <LegendKey outcome="win" label="Win" color={color} />
        <LegendKey outcome="podium" label="Podium" color={color} />
        <LegendKey outcome="points" label="Points" color={color} />
        <LegendKey outcome="classified" label="No points" color={color} />
        <LegendKey outcome="dnf" label="No finish" color={color} />
      </div>

      {/* 132px minimum against the driver grid's 78px: these tiles carry two
          named lines rather than one position, and at 78px the second car's
          points column collided with its own driver code. */}
      <motion.div
        className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-1.5"
        initial={reduce ? false : "hidden"}
        animate="show"
        variants={{ show: { transition: { staggerChildren: reduce ? 0 : 0.018 } } }}
        onMouseLeave={() => setHovered(null)}
      >
        {entries.map((entry) => {
          const outcome = constructorOutcomeOf(entry);
          const s = outcomeStyle(outcome, color);
          const barPct = Math.min(100, (entry.points / MAX_ROUND_POINTS) * 100);
          const isShown = shown?.round === entry.round;
          const isPinned = pinned === entry.round;
          return (
            <motion.button
              key={entry.round}
              type="button"
              data-outcome={outcome}
              data-round={entry.round}
              variants={{
                hidden: { opacity: 0, y: 6 },
                show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE } },
              }}
              onMouseEnter={() => setHovered(entry.round)}
              onFocus={() => setHovered(entry.round)}
              onBlur={() => setHovered(null)}
              onClick={() =>
                setPinned((current) => (current === entry.round ? null : entry.round))
              }
              aria-pressed={isPinned}
              // The tile is a set of abbreviations; this is the sentence they
              // stand for, per car, for anyone who cannot see it.
              aria-label={[
                `Round ${entry.round}, ${entry.raceName}`,
                `${entry.points} points`,
                ...entry.drivers.map((d) =>
                  [
                    d.name,
                    `finished ${finishLabel(d)}`,
                    d.sprintPoints > 0
                      ? `${d.racePoints} race and ${d.sprintPoints} sprint points`
                      : `${d.points} points`,
                  ].join(" ")
                ),
              ].join(", ")}
              // `outline`, not `ring`: a ring compiles to `box-shadow`, and the
              // hover state below declares one. See the note in globals.css.
              className={`relative overflow-hidden text-left rounded-control border pl-[11px] pr-2 pt-1.5 pb-2 min-w-0 bg-background/90 cursor-pointer
                transition-[transform,box-shadow,filter] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]
                hover:-translate-y-[2px] hover:brightness-[1.16] hover:shadow-[0_6px_18px_-6px_rgba(0,0,0,0.75)]
                active:translate-y-0 active:scale-[0.985]
                focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame-bright
                motion-reduce:transition-none motion-reduce:hover:translate-y-0`}
              style={{
                backgroundImage: s.backgroundImage,
                borderColor: s.borderColor,
                boxShadow: isShown
                  ? `inset 0 0 0 1px ${s.rail}, 0 0 14px -4px ${s.rail}`
                  : undefined,
              }}
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ background: s.rail }}
              />
              <div className="flex items-baseline justify-between gap-1">
                <span className="font-bold text-[9px] tabular-nums text-warm-500">
                  R{entry.round}
                </span>
                <span
                  className="font-[family-name:var(--font-headline)] font-extrabold text-[15px] leading-none tabular-nums"
                  style={{ color: s.text }}
                >
                  {entry.points > 0 ? `+${entry.points}` : "0"}
                </span>
              </div>
              <div className="font-semibold text-[9px] tracking-[0.04em] uppercase text-warm-400 truncate mt-0.5 mb-1">
                {entry.shortName}
              </div>
              <div className="flex flex-col gap-[3px]">
                {entry.drivers.map((driver) => (
                  <DriverLine key={driver.driverId} driver={driver} color={color} />
                ))}
                {/* A round where the team fielded only one car is a real thing
                    (a withdrawn entry, a car that never made the grid). The
                    placeholder keeps every tile the same height so the grid
                    does not develop ragged rows, and says why rather than
                    leaving a gap the reader has to interpret. */}
                {entry.drivers.length === 1 && (
                  <div className="font-semibold text-[9px] tracking-[0.06em] uppercase text-warm-600">
                    one car only
                  </div>
                )}
              </div>
              {/* Drawn at zero width too — a missing track would make a
                  pointless round look like a different kind of tile rather
                  than an empty one. */}
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
                  transition={{ duration: 0.45, ease: EASE }}
                />
              </div>
              {entry.sprintPoints > 0 && (
                <div className="font-semibold text-[9px] tracking-[0.06em] uppercase text-warm-500 mt-1">
                  SPR · +{entry.sprintPoints}
                </div>
              )}
            </motion.button>
          );
        })}
      </motion.div>

      {shown && (
        <div
          className="mt-2 px-2.5 rounded-control bg-veil/[0.03] border border-white/[0.06]"
          aria-live="polite"
        >
          <motion.div
            key={shown.round}
            initial={reduce ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: EASE }}
          >
            <RoundDetail entry={shown} isActive={active !== null} color={color} />
          </motion.div>
        </div>
      )}

      <p className="font-medium text-[10px] text-warm-500 mt-3">
        {entries.length} round{entries.length === 1 ? "" : "s"} ·{" "}
        <span className="tabular-nums">{log.totalPoints}</span>{" "}
        {log.totalPoints === 1 ? "point" : "points"} from race
        {entries.some((e) => e.sprintPoints > 0) ? " and sprint" : ""} results
        {drift !== 0 && (
          <>
            {" "}
            · <span className="tabular-nums">{drift > 0 ? `+${drift}` : drift}</span>{" "}
            not yet reflected in per-round results
          </>
        )}
      </p>
    </div>
  );
}
