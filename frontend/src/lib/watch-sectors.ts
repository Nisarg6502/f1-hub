/**
 * Sector splits for watch mode's "This lap" bar.
 *
 * The backend serves the race leader's three sector times per lap
 * (`RaceTiming.lap_sectors_ms`, OpenF1's `/laps`), index-aligned to `lap_ms`.
 * The bar itself runs on `lap_ms`, the official archive's lap time, and the
 * two sources disagree by a few hundredths. So the splits are placed on the
 * bar *proportionally* (sector / sum of sectors), and the running readout is
 * scaled back so that it lands exactly on each sector's real time as the clock
 * crosses its boundary. Nothing here invents a split: a lap without all three
 * sectors gets no split at all.
 *
 * Free of React and the DOM, like `watch-clock.ts`: it is called every frame.
 */

export type LapSectors = readonly [number, number, number];

/** A lap's sectors when all three are usable, else `null`. */
export function sectorsForLap(
  lapSectors: ReadonlyArray<ReadonlyArray<number> | null> | undefined,
  index: number
): LapSectors | null {
  const value = lapSectors?.[index];
  if (!value || value.length !== 3) return null;
  if (!value.every((ms) => Number.isFinite(ms) && ms > 0)) return null;
  return [value[0], value[1], value[2]];
}

/** Where sectors 1 and 2 end, as fractions (0-1) of the lap. */
export function sectorFractions(sectors: LapSectors): [number, number] {
  const sum = sectors[0] + sectors[1] + sectors[2];
  return [sectors[0] / sum, (sectors[0] + sectors[1]) / sum];
}

export type SectorState =
  | { kind: "done"; ms: number }
  | { kind: "running"; ms: number }
  | { kind: "pending" };

/**
 * Each sector's state `elapsedMs` into a lap that runs for `lapMs` on the
 * clock. A finished sector reads its real time. The running one reads its
 * elapsed time, scaled from clock time to sector time so that it reaches the
 * real value exactly at the boundary instead of jumping to it.
 */
export function sectorStates(
  sectors: LapSectors,
  lapMs: number,
  elapsedMs: number
): [SectorState, SectorState, SectorState] {
  const sum = sectors[0] + sectors[1] + sectors[2];
  const scale = lapMs > 0 ? sum / lapMs : 1;
  // Elapsed in sector time, clamped to the lap.
  const t = Math.min(sum, Math.max(0, elapsedMs * scale));
  let start = 0;
  return sectors.map((ms) => {
    const end = start + ms;
    const state: SectorState =
      t >= end
        ? { kind: "done", ms }
        : t >= start
          ? { kind: "running", ms: t - start }
          : { kind: "pending" };
    start = end;
    return state;
  }) as [SectorState, SectorState, SectorState];
}

/** `23.4`, or `1:02.3` for a sector over a minute (a safety-car sector can be). */
export function formatSector(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths - minutes * 600) / 10;
  return minutes > 0
    ? `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`
    : seconds.toFixed(1);
}
