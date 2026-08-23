"use client";

/**
 * Where one driver's championship points actually came from.
 *
 * The standings table answers "how many" and nothing else. The interesting
 * question — *which weekends* — was only answerable by opening the schedule and
 * reading twenty-four result pages one at a time. This is that read, folded
 * into the row it belongs to.
 *
 * Three readings, because people arrive wanting different things:
 *
 *   1. **The season at a glance.** A wrapping grid of one tile per round,
 *      colour-coded by outcome, with a points bar under each. Wins jump out,
 *      retirements jump out, and a barren run of midfield weekends reads as a
 *      block of grey without anyone having to compare numbers.
 *   2. **The specific weekend.** Each tile carries its round, the circuit, grid
 *      and finish, and the points, so the answer to "what happened in Baku" is
 *      in the tile rather than behind another click.
 *   3. **The fuller story of one round.** Hovering or focusing a tile fills the
 *      readout below the grid with everything the tile had to truncate: the
 *      full race name, the grid-to-flag move as a signed delta, the retirement
 *      status in words, and the race/sprint split of the points. It rests on
 *      the driver's best weekend, so it is never empty and never a tooltip
 *      nobody discovers.
 *
 * A wrapping grid rather than a horizontal strip on purpose. A scroll container
 * hides its own tail — the reader cannot see that rounds 15-24 exist — and this
 * whole panel exists to stop information being hidden.
 */

import { useMemo, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { DriverSeasonLog, DriverRoundEntry } from "@/lib/season-results";
import type { TeamColor } from "@/lib/team-colors";

/** A win is the yardstick every other result is drawn against. 25 rather than
 * 33 (a win plus a sprint win) because the sprint is the rare case, and scaling
 * every bar down by a quarter to leave room for it would flatten the whole
 * season. Bars are clamped, so a sprint-weekend win simply fills. */
const WIN_POINTS = 25;

/** Shared with the accordion that owns this panel (`standings-view.tsx`) and
 * with `--ease-out-apex`, so the disclosure and its contents move as one. */
const EASE = [0.23, 1, 0.32, 1] as const;

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
 *
 * ---
 *
 * The five bands used to be five washes of the same warm hue laid at 4-13%
 * alpha over whatever the standings row happened to be painted, and that broke
 * the scale in three separate ways at once:
 *
 *   1. **The row bled through.** At 4-13% the fill is mostly parent, and the
 *      leader's row carries a `primary-container / 0.12` tint — so on the row
 *      people look at first, a *retirement* rendered orange. The bands were not
 *      subtly wrong there; they were wrong.
 *   2. **`points` was the team's colour, so the scale had no fixed key.** For a
 *      McLaren driver "in the points" was papaya at 8% sitting beside "podium"
 *      at flame 13% — the same swatch. For a Ferrari driver it collided with
 *      the red used for retirements instead. The legend swatch changed meaning
 *      from row to row, which is the one thing a legend must not do.
 *   3. **`points` and `classified` were four points of alpha apart** on a
 *      low-chroma colour, i.e. indistinguishable, which is exactly the
 *      distinction the panel exists to draw.
 *
 * So the scale now separates on three axes rather than one:
 *
 *   - **Opacity is ordinal.** Bright gradient (win) → solid warm (podium) →
 *     light neutral (points) → near-empty (no points).
 *   - **Hue is categorical and fixed.** Wins and podiums are the APEX accents;
 *     scoring and scoreless weekends are neutral `veil`; a retirement is
 *     `error`. None of them move with the team any more — team identity is
 *     still in the tile, in the points bar and the left rail, where it cannot
 *     be mistaken for an outcome.
 *   - **A retirement is also *textured*.** Diagonal stripes read instantly at
 *     tile size and survive both a colour-blind reader and a bad monitor, which
 *     no red-versus-orange pairing does in a warm-orange design system.
 *
 * Each tile is also composited over its own `bg-background/90` base (set as a
 * class on the element, so it is the token rather than a literal), which is
 * what stops (1) from coming back: the wash sits on a known dark ground instead
 * of on the row's mood.
 */
interface OutcomeStyle {
  /** `background-image` only — the base colour is a Tailwind token class. */
  backgroundImage: string;
  borderColor: string;
  /** The 3px left rail, and the legend's swatch. Carries the whole key. */
  rail: string;
  /** Colour for the big position figure. */
  text: string;
}

function outcomeStyle(outcome: Outcome, color: TeamColor): OutcomeStyle {
  switch (outcome) {
    // Win and podium are the pair that has to work hardest, because in a
    // warm-orange system they are both "orange" and a P1 next to a P3 is the
    // comparison the grid is scanned for. They are therefore split on *value*
    // as well as hue — `primary` (#ffae6a) is a light tint, `ember` (#e23a0e)
    // a dark shade, so a win reads as the bright tile and a podium as the deep
    // one even in a thumbnail. Two orange washes at the same lightness, which
    // is what this was, cannot be told apart at 78px however far their alphas
    // are pushed.
    case "win":
      return {
        backgroundImage:
          "linear-gradient(152deg, rgb(var(--rgb-primary) / 0.44), rgb(var(--rgb-primary-container) / 0.28))",
        borderColor: "rgb(var(--rgb-primary) / 0.85)",
        rail: "var(--color-primary)",
        // Near-white, not `primary`: primary-on-primary was the one band in
        // the set that missed WCAG AA (4.2:1 at the gradient's bright corner,
        // against 4.5 needed for 15px bold), and the brightest number on the
        // brightest tile is the right hierarchy anyway. `--color-flame-light`
        // is a literal alias of `--color-primary`, so using it for the podium
        // figure — as this did — printed the two in the same colour.
        text: "var(--color-warm-100)",
      };
    case "podium":
      return {
        backgroundImage:
          "linear-gradient(152deg, rgb(var(--rgb-ember) / 0.34), rgb(var(--rgb-ember) / 0.13))",
        borderColor: "rgb(var(--rgb-flame) / 0.55)",
        rail: "var(--color-flame)",
        text: "var(--color-primary)",
      };
    case "points":
      return {
        backgroundImage:
          "linear-gradient(152deg, rgb(var(--rgb-veil) / 0.13), rgb(var(--rgb-veil) / 0.06))",
        borderColor: "rgb(var(--rgb-veil) / 0.22)",
        // The one place the team still speaks, and it cannot be read as an
        // outcome because every other rail is an APEX accent or a neutral.
        rail: color.hex,
        text: "var(--color-warm-100)",
      };
    case "dnf":
      return {
        backgroundImage: [
          // Stripes first so they sit on top of the wash.
          "repeating-linear-gradient(135deg, rgb(var(--rgb-error) / 0.20) 0 5px, transparent 5px 11px)",
          "linear-gradient(152deg, rgb(var(--rgb-error) / 0.13), rgb(var(--rgb-error) / 0.05))",
        ].join(", "),
        borderColor: "rgb(var(--rgb-error) / 0.48)",
        rail: "var(--color-error)",
        text: "var(--color-error)",
      };
    default:
      return {
        backgroundImage:
          "linear-gradient(152deg, rgb(var(--rgb-veil) / 0.04), rgb(var(--rgb-veil) / 0.015))",
        borderColor: "rgb(var(--rgb-veil) / 0.09)",
        rail: "var(--color-warm-600)",
        text: "var(--color-warm-300)",
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

function gridLabelOf(entry: DriverRoundEntry): string {
  return entry.grid !== null && entry.grid > 0 ? `P${entry.grid}` : "PL";
}

/**
 * Places gained between the lights and the flag. Derived from `grid` and
 * `position`, both of which the tile already prints — this only does the
 * subtraction the reader was doing in their head, and it is the single most
 * asked thing about a round after "where did they finish".
 *
 * `null` whenever the arithmetic would be a lie: a pit-lane start has no grid
 * slot (`grid` is 0), and a car that was never classified has no finish.
 */
function placesGained(entry: DriverRoundEntry): number | null {
  if (entry.grid === null || entry.grid <= 0) return null;
  if (entry.position === null) return null;
  return entry.grid - entry.position;
}

function Chip({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg px-2.5 py-1.5 bg-veil/[0.045] border border-white/[0.06]">
      <div className="font-extrabold text-[13px] tabular-nums leading-none">{value}</div>
      <div className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-500 mt-1">
        {label}
      </div>
    </div>
  );
}

/** A miniature of the real tile — same fill, same border, same rail — so the
 * key cannot drift from the thing it keys. */
function LegendKey({
  outcome,
  label,
  color,
}: {
  outcome: Outcome;
  label: string;
  color: TeamColor;
}) {
  const s = outcomeStyle(outcome, color);
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="relative w-3.5 h-3 rounded-hairline border overflow-hidden bg-background/90"
        style={{ backgroundImage: s.backgroundImage, borderColor: s.borderColor }}
      >
        <span
          className="absolute inset-y-0 left-0 w-[2px]"
          style={{ background: s.rail }}
        />
      </span>
      <span className="font-semibold text-[9px] tracking-[0.08em] uppercase text-warm-500">
        {label}
      </span>
    </span>
  );
}

/**
 * The readout under the grid. Everything a 78px tile has to truncate, for
 * whichever round the pointer or the keyboard is on.
 *
 * Deliberately *not* a tooltip. A `title` attribute — which is what this
 * replaces — waits a second, renders in the OS's font over the OS's yellow,
 * cannot be reached by keyboard at all, and never appears on a touch screen.
 * A fixed strip in the panel's own type is readable by everyone, and because it
 * has a resting value it also works as a caption for the grid rather than as
 * something you have to go hunting for.
 */
function RoundDetail({ entry, isActive }: { entry: DriverRoundEntry; isActive: boolean }) {
  const gained = placesGained(entry);
  const outcome = outcomeOf(entry);
  return (
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 min-h-[34px] py-1.5">
      <span className="font-bold text-[10px] tabular-nums tracking-[0.1em] uppercase text-flame">
        R{entry.round}
      </span>
      <span className="font-bold text-[13px] text-warm-100">{entry.raceName}</span>
      <span className="font-semibold text-[11px] tabular-nums text-warm-300">
        {gridLabelOf(entry)}
        <span className="text-warm-600"> → </span>
        {finishLabel(entry)}
      </span>
      {gained !== null && gained !== 0 && (
        <span
          className="font-bold text-[10px] tabular-nums tracking-[0.04em]"
          style={{ color: gained > 0 ? "var(--color-primary)" : "var(--color-error)" }}
        >
          {gained > 0 ? `+${gained}` : gained} place{Math.abs(gained) === 1 ? "" : "s"}
        </span>
      )}
      {outcome === "dnf" && entry.status && (
        <span className="font-semibold text-[10px] uppercase tracking-[0.06em] text-error">
          {entry.status}
        </span>
      )}
      <span className="font-semibold text-[11px] tabular-nums text-warm-200">
        {entry.sprintPoints > 0
          ? `${entry.racePoints} race + ${entry.sprintPoints} sprint`
          : `${entry.points}`}{" "}
        <span className="text-warm-500">
          {entry.points === 1 ? "point" : "points"}
        </span>
      </span>
      {/* Says which of the two states the strip is in, so a resting caption is
          never mistaken for a reading of the tile under the pointer. */}
      <span className="font-semibold text-[9px] tracking-[0.1em] uppercase text-warm-600 ml-auto">
        {isActive ? "This round" : "Best haul"}
      </span>
    </div>
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

  /**
   * Which round the readout is showing.
   *
   * Two sources, because hover alone strands two groups of people: a keyboard
   * user (who never hovers) and a touch user (who has no hover at all). So
   * `hovered` previews and `pinned` — set by clicking or tapping a tile —
   * persists, and a pin doubles as the reason the tiles are buttons rather than
   * decorative divs. Hover wins while it lasts so the pointer always reads what
   * it is over.
   */
  const [hovered, setHovered] = useState<number | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);

  const entries = useMemo(() => log?.entries ?? [], [log]);
  const activeRound = hovered ?? pinned;
  const active = useMemo(
    () => entries.find((e) => e.round === activeRound) ?? null,
    [entries, activeRound]
  );
  /** The resting caption: the weekend that moved the championship most, or the
   * latest round for a driver who has never scored. */
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
        <Chip label="In points" value={`${log.pointsFinishes}/${entries.length}`} />
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

      {/* The tiles cascade in rather than appearing all at once, at 18ms apart:
          fast enough that the whole grid has settled inside a quarter of a
          second, slow enough that the eye is led left-to-right through the
          season instead of being handed a block. `animate` rather than
          `whileInView` — this only ever mounts because someone opened the row,
          so waiting for a viewport intersection would just add a beat. */}
      <motion.div
        className="grid grid-cols-[repeat(auto-fill,minmax(78px,1fr))] gap-1.5"
        initial={reduce ? false : "hidden"}
        animate="show"
        variants={{ show: { transition: { staggerChildren: reduce ? 0 : 0.018 } } }}
        onMouseLeave={() => setHovered(null)}
      >
        {entries.map((entry) => {
          const outcome = outcomeOf(entry);
          const s = outcomeStyle(outcome, color);
          const barPct = Math.min(100, (entry.points / WIN_POINTS) * 100);
          const gridLabel = gridLabelOf(entry);
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
              // The tile's own text is a set of abbreviations; this is the
              // sentence they stand for, for anyone who cannot see the tile.
              aria-label={[
                `Round ${entry.round}, ${entry.raceName}`,
                `started ${gridLabel}, finished ${finishLabel(entry)}`,
                outcome === "dnf" && entry.status ? entry.status : null,
                entry.sprintPoints > 0
                  ? `${entry.racePoints} race and ${entry.sprintPoints} sprint points`
                  : `${entry.points} points`,
              ]
                .filter(Boolean)
                .join(", ")}
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
                // The pinned/hovered tile is lifted out of the grid by an inset
                // halo rather than by moving, so the row it is in does not
                // reflow under the pointer.
                boxShadow: isShown
                  ? `inset 0 0 0 1px ${s.rail}, 0 0 14px -4px ${s.rail}`
                  : undefined,
              }}
            >
              {/* The rail. Three pixels of the outcome's own colour at full
                  strength, so the band survives a wash that has to stay
                  translucent enough to be glass. */}
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ background: s.rail }}
              />
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
                    className="font-[family-name:var(--font-headline)] font-extrabold text-[15px] leading-none tabular-nums"
                    style={{ color: s.text }}
                  >
                    {finishLabel(entry)}
                  </span>
                  {retiredButClassified(entry) && (
                    <span className="font-bold text-[8px] tracking-[0.08em] uppercase text-error">
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
                  transition={{ duration: 0.45, ease: EASE }}
                />
              </div>
              {entry.sprintPoints > 0 && (
                <div className="font-semibold text-[9px] tracking-[0.06em] uppercase text-warm-500 mt-1">
                  {entry.sprintPosition !== null ? `SPR P${entry.sprintPosition}` : "SPR"} ·
                  +{entry.sprintPoints}
                </div>
              )}
            </motion.button>
          );
        })}
      </motion.div>

      {/* `key` on the round so React remounts it and the new reading fades in
          rather than swapping mid-sentence. `aria-live="polite"`: a keyboard
          user arrowing through the tiles is moving focus, and the strip is the
          only part of the answer that is not on the tile they landed on. */}
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
            <RoundDetail entry={shown} isActive={active !== null} />
          </motion.div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
        <p className="font-medium text-[10px] text-warm-500">
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
