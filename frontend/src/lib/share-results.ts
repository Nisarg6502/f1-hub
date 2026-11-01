/**
 * Shaping standings and race results into the rows a share card prints.
 *
 * Separate from the card markup so the decisions that can be wrong — which
 * rows count as classified, what a retirement is called, what "after round N"
 * means — are tested without rendering a PNG.
 */

import type { ConstructorStanding, DriverStanding, Race, RaceResult } from "./api";
import { getTeamColor } from "./team-colors";
import {
  DRIVER_PORTRAIT_SOURCE_HEIGHT,
  DRIVER_PORTRAIT_SOURCE_WIDTH,
  driverPortraitRowFraction,
  type DriverPortraitFrame,
} from "./driver-portrait";

/**
 * Pixel box for a driver cutout inside a `width × height` frame on a card.
 *
 * The same framing `driverPortraitFrameStyle` gives the page, in absolute
 * pixels, because Satori supports neither `aspect-ratio` nor percentage
 * `transform`. Derived from `driverPortraitRowFraction` rather than a second
 * copy of the band table, so a re-measured asset set moves both at once.
 */
export function sharePortraitBox(
  width: number,
  height: number,
  frame: DriverPortraitFrame
): { width: number; height: number; top: number; left: number } {
  const top = driverPortraitRowFraction(0, frame) * height;
  const imgHeight = (driverPortraitRowFraction(DRIVER_PORTRAIT_SOURCE_HEIGHT, frame) - driverPortraitRowFraction(0, frame)) * height;
  const imgWidth = (imgHeight * DRIVER_PORTRAIT_SOURCE_WIDTH) / DRIVER_PORTRAIT_SOURCE_HEIGHT;
  const r = (n: number) => Math.round(n * 10) / 10;
  return { width: r(imgWidth), height: r(imgHeight), top: r(top), left: r((width - imgWidth) / 2) };
}

/** `"Australian Grand Prix"` → `"Australian GP"`. The page header makes the same cut. */
export function shortRaceName(raceName: string): string {
  return raceName.replace(/\s*Grand Prix$/i, " GP").trim();
}

/* ==========================================================================
   Race results
   ========================================================================== */

/** How a classified row ended. Drives both the gap column and its colour. */
export type ResultKind = "finished" | "lapped" | "dnf" | "dsq" | "dns" | "nc" | "excluded";

/**
 * Ergast/Jolpica `positionText` codes for rows that did not finish normally.
 *
 * `positionText` is the authoritative signal where it exists — `status` is
 * free text ("Engine", "Collision damage", "Power Unit") and a list of every
 * retirement reason would never be complete. Not every round carries it,
 * though: the FastF1-sourced rounds in the backend have no `positionText` at
 * all, so `status` is the fallback below.
 */
const POSITION_TEXT_KIND: Record<string, ResultKind> = {
  R: "dnf",
  D: "dsq",
  W: "dns",
  N: "nc",
  E: "excluded",
  F: "dns",
};

export function resultKind(result: RaceResult): ResultKind {
  const code = result.positionText?.trim().toUpperCase();
  if (code && POSITION_TEXT_KIND[code]) return POSITION_TEXT_KIND[code];

  const status = (result.status ?? "").trim();
  if (status === "" || /^finished$/i.test(status)) return "finished";
  if (/^lapped$/i.test(status) || /^\+\d+\s+laps?$/i.test(status)) return "lapped";
  if (/disqualified/i.test(status)) return "dsq";
  if (/did not start|withdrew|not started/i.test(status)) return "dns";
  if (/not classified/i.test(status)) return "nc";
  if (/excluded/i.test(status)) return "excluded";
  // Anything else is a reason for stopping: "Engine", "Accident", "Retired".
  return "dnf";
}

const KIND_LABEL: Partial<Record<ResultKind, string>> = {
  dnf: "DNF",
  dsq: "DSQ",
  dns: "DNS",
  nc: "NC",
  excluded: "EXCL",
};

/**
 * Whether a session has a usable classification: at least one row with a
 * numeric position.
 *
 * Not "has rows". Some rounds in the backend come back with every driver
 * present and every `position` empty (2022 Bahrain, for one) — a card drawn
 * from that would be a podium of whoever happened to be first in the array,
 * stated as a result.
 */
export function hasClassification(results: readonly RaceResult[] | null | undefined): boolean {
  return (results ?? []).some((r) => /^\d+$/.test(r.position ?? ""));
}

/**
 * The top `n` rows by classified position, ascending.
 *
 * Sorted rather than trusted, because the array order is the API's and not a
 * promise. Rows without a numeric position are left out rather than placed
 * last — there is no honest place on a podium for them.
 */
export function topClassified(results: readonly RaceResult[] | null | undefined, n = 10): RaceResult[] {
  return (results ?? [])
    .filter((r) => /^\d+$/.test(r.position ?? ""))
    .sort((a, b) => Number(a.position) - Number(b.position))
    .slice(0, n);
}

/**
 * The gap column: the winner's race time, everyone else's interval, laps
 * down for the lapped, and the code for anyone who did not finish.
 *
 * Laps down is stated as laps, never seconds (the rule `/watch` adopted in
 * #204) — and computed from the `laps` field where the status only says
 * "Lapped", which the FastF1-sourced rounds do. A lapped row whose lap count
 * is unknown says "Lapped" rather than inventing a number.
 *
 * Intervals are normalised to a leading `+`: the Ergast rounds send
 * `"+1.747"`, the FastF1 rounds send `"1.747"`, and one card mixing both
 * would look like two different kinds of number.
 */
export function formatResultGap(result: RaceResult, leader: RaceResult | null): string {
  const kind = resultKind(result);
  const label = KIND_LABEL[kind];
  if (label) return label;

  const isLeader = leader === null || leader === result;
  const time = result.Time?.time?.trim();
  if (isLeader) return time || "—";

  if (kind === "lapped") {
    const fromStatus = (result.status ?? "").match(/^\+(\d+)\s+laps?$/i);
    const down = fromStatus
      ? Number(fromStatus[1])
      : Number(leader.laps) - Number(result.laps);
    if (Number.isFinite(down) && down > 0) return `+${down} lap${down === 1 ? "" : "s"}`;
    return "Lapped";
  }

  if (time) return time.startsWith("+") ? time : `+${time}`;
  return "—";
}

export interface ResultRow {
  position: number;
  givenName: string;
  familyName: string;
  fullName: string;
  code: string;
  team: string;
  teamHex: string;
  gap: string;
  kind: ResultKind;
  points: number;
}

export function resultRows(results: readonly RaceResult[] | null | undefined, n = 10): ResultRow[] {
  const top = topClassified(results, n);
  const leader = top[0] ?? null;
  return top.map((r) => {
    const givenName = r.Driver?.givenName?.trim() ?? "";
    const familyName = r.Driver?.familyName?.trim() ?? "";
    const team = r.Constructor?.name?.trim() || "—";
    return {
      position: Number(r.position),
      givenName,
      familyName,
      fullName: `${givenName} ${familyName}`.trim() || "—",
      code: r.Driver?.code?.trim() || familyName.slice(0, 3).toUpperCase(),
      team,
      teamHex: getTeamColor(team).hex,
      gap: formatResultGap(r, leader),
      kind: resultKind(r),
      points: Number(r.points) || 0,
    };
  });
}

/**
 * Podium in the order it is drawn — second, first, third — so the winner
 * stands in the middle on the tallest step. Fewer than three classified rows
 * draws a shorter podium rather than an empty step.
 */
export function podiumOrder<T>(rows: readonly T[]): Array<{ row: T; place: 1 | 2 | 3 }> {
  const [p1, p2, p3] = rows;
  const out: Array<{ row: T; place: 1 | 2 | 3 }> = [];
  if (p2 !== undefined) out.push({ row: p2, place: 2 });
  if (p1 !== undefined) out.push({ row: p1, place: 1 });
  if (p3 !== undefined) out.push({ row: p3, place: 3 });
  return out;
}

/* ==========================================================================
   Standings
   ========================================================================== */

export interface StandingRow {
  /** As the API states it. Ties on points still have distinct positions — countback decides. */
  position: number;
  name: string;
  givenName: string;
  familyName: string;
  /** Team for a driver, nationality-free for a constructor (empty). */
  team: string;
  teamHex: string;
  points: number;
  wins: number;
  /** Points behind the leader; 0 for the leader and anyone level with them. */
  behind: number;
}

/**
 * Standings rows in the API's order, capped at `limit`.
 *
 * Never re-sorted by points. Two drivers on 7 points are not "joint 16th" in
 * the championship — the official order separates them on countback (best
 * results), which the API has already applied and this card has no way to
 * recompute. Re-sorting would at best reproduce it and at worst reorder a
 * tie the API got right.
 */
export function driverStandingRows(drivers: readonly DriverStanding[], limit: number): StandingRow[] {
  const leaderPoints = Number(drivers[0]?.points) || 0;
  return drivers.slice(0, limit).map((d, i) => {
    const givenName = d.Driver.givenName?.trim() ?? "";
    const familyName = d.Driver.familyName?.trim() ?? "";
    const team = d.Constructors?.[0]?.name?.trim() || "—";
    const points = Number(d.points) || 0;
    return {
      position: Number(d.position) || i + 1,
      name: `${givenName} ${familyName}`.trim() || "—",
      givenName,
      familyName,
      team,
      teamHex: getTeamColor(team).hex,
      points,
      wins: Number(d.wins) || 0,
      behind: Math.max(0, leaderPoints - points),
    };
  });
}

export function constructorStandingRows(
  constructors: readonly ConstructorStanding[],
  limit: number
): StandingRow[] {
  const leaderPoints = Number(constructors[0]?.points) || 0;
  return constructors.slice(0, limit).map((c, i) => {
    const name = c.Constructor.name?.trim() || "—";
    const points = Number(c.points) || 0;
    return {
      position: Number(c.position) || i + 1,
      name,
      givenName: "",
      familyName: name,
      team: "",
      teamHex: getTeamColor(name).hex,
      points,
      wins: Number(c.wins) || 0,
      behind: Math.max(0, leaderPoints - points),
    };
  });
}

/**
 * Whether `row` shares its points total with a neighbour. The card marks it,
 * because a reader seeing three drivers on 7 points in a row will otherwise
 * assume the order between them is a mistake.
 */
export function isTiedOnPoints(rows: readonly StandingRow[], index: number): boolean {
  const points = rows[index]?.points;
  if (points === undefined) return false;
  return rows[index - 1]?.points === points || rows[index + 1]?.points === points;
}

/**
 * The latest round whose result the backend has, which is the round the
 * standings reflect.
 *
 * Read from `winner`, which `/api/races` attaches only once a round's results
 * are cached — so this is "the last round we have results for", not "the
 * last round whose start time has passed". The two differ for up to an hour
 * after every race (the sync lag), and in that window a card saying "after
 * round 20" over round-19 standings would be wrong in exactly the moment it
 * is most likely to be shared.
 */
export function lastScoredRound(races: readonly Race[] | null | undefined): { round: number; raceName: string } | null {
  let best: { round: number; raceName: string } | null = null;
  for (const race of races ?? []) {
    if (!race.winner) continue;
    const round = Number(race.round);
    if (!Number.isFinite(round)) continue;
    if (!best || round > best.round) best = { round, raceName: race.raceName };
  }
  return best;
}

/**
 * A constructor name short enough for a chart's end label: the generic
 * "F1 Team" / "Formula One Team" / "Racing" suffix dropped, then capped at
 * `max` characters with an ellipsis.
 *
 * `"RB F1 Team"` → `"RB"`, `"Alpine F1 Team"` → `"Alpine"`,
 * `"Mercedes-AMG Petronas Formula One Team"` → `"Mercedes-AM…"`. The full
 * name is on the standings card; the chart only has to say whose line is
 * whose.
 */
export function shortTeamLabel(name: string, max = 12): string {
  const trimmed =
    name
      .trim()
      .replace(/\s+(F1|Formula\s*(One|1))(\s+Team)?$/i, "")
      .replace(/\s+Racing$/i, "")
      .trim() || name.trim();
  const chars = Array.from(trimmed);
  return chars.length <= max ? trimmed : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
