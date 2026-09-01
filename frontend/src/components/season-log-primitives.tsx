"use client";

/**
 * The pieces the driver and constructor season logs genuinely share.
 *
 * Extracted rather than duplicated because these three are the panels' *key* —
 * if the outcome palette drifts between the Drivers tab and the Constructors
 * tab, the legend on one tab stops describing the tiles on the other, which is
 * the single worst failure this kind of colour scale can have. The two panels
 * are otherwise deliberately separate components: a driver's round is one
 * result and a constructor's is two, so the tile bodies, the summary stats and
 * the detail readout have almost nothing in common, and a shared component
 * parameterised over "one or many drivers" would have been a pile of branches
 * that made both harder to read. The scale is the part that must not diverge;
 * everything else is allowed to.
 */

import type { TeamColor } from "@/lib/team-colors";

export type Outcome = "win" | "podium" | "points" | "classified" | "dnf";

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
export interface OutcomeStyle {
  /** `background-image` only — the base colour is a Tailwind token class. */
  backgroundImage: string;
  borderColor: string;
  /** The 3px left rail, and the legend's swatch. Carries the whole key. */
  rail: string;
  /** Colour for the big position figure. */
  text: string;
}

export function outcomeStyle(outcome: Outcome, color: TeamColor): OutcomeStyle {
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

export function Chip({ label, value }: { label: string; value: string | number }) {
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
export function LegendKey({
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
 * The subset of a round both panels' label helpers need.
 *
 * Structural rather than a union of `DriverRoundEntry | ConstructorDriverRound`:
 * these four functions do not care which of the two they are handed, and a
 * union would have to be widened again the next time a third caller appears.
 */
export interface ResultLike {
  position: number | null;
  positionText: string;
  grid: number | null;
  finished: boolean;
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
export function finishLabel(entry: ResultLike): string {
  if (entry.position !== null) return `P${entry.position}`;
  if (!entry.finished) return "DNF";
  return entry.positionText || "—";
}

/** True for the retired-but-classified case above, where the position alone
 * would understate what happened. */
export function retiredButClassified(entry: ResultLike): boolean {
  return !entry.finished && entry.position !== null;
}

export function gridLabelOf(entry: ResultLike): string {
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
export function placesGained(entry: ResultLike): number | null {
  if (entry.grid === null || entry.grid <= 0) return null;
  if (entry.position === null) return null;
  return entry.grid - entry.position;
}
