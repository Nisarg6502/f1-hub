export interface ProgressionEntry {
  round: number;
  shortName: string;
  points: number;
  position?: number | null;
}

export interface ProgressionRow {
  round: number;
  shortName: string;
  cumulative: Record<string, number>;
  gained: Record<string, number>;
  position: Record<string, number | null>;
  leaderPoints: number;
}

/**
 * Reshapes per-entity round logs (driver or constructor) into one row per
 * round, each carrying every entity's running total -- the shape Recharts'
 * `data` prop and this feature's custom tooltip both need.
 *
 * A round an entity has no entry for (missed a race, hadn't started the
 * season yet) is treated as zero points gained rather than omitted, so the
 * entity's line stays flat instead of breaking -- `buildDriverSeasonLogs` and
 * `buildConstructorSeasonLogs` already chose not to insert a zero entry for
 * exactly this case, so the flattening happens here instead.
 */
export function buildProgressionRows(
  entityIds: string[],
  logsByEntityId: Record<string, { entries: ProgressionEntry[] } | undefined>
): ProgressionRow[] {
  const roundSet = new Set<number>();
  const shortNameByRound = new Map<number, string>();
  const entryByEntityRound = new Map<string, Map<number, ProgressionEntry>>();

  for (const id of entityIds) {
    const perRound = new Map<number, ProgressionEntry>();
    for (const entry of logsByEntityId[id]?.entries ?? []) {
      roundSet.add(entry.round);
      if (!shortNameByRound.has(entry.round)) {
        shortNameByRound.set(entry.round, entry.shortName);
      }
      perRound.set(entry.round, entry);
    }
    entryByEntityRound.set(id, perRound);
  }

  const rounds = Array.from(roundSet).sort((a, b) => a - b);
  const running: Record<string, number> = {};
  for (const id of entityIds) running[id] = 0;

  return rounds.map((round) => {
    const cumulative: Record<string, number> = {};
    const gained: Record<string, number> = {};
    const position: Record<string, number | null> = {};

    for (const id of entityIds) {
      const entry = entryByEntityRound.get(id)?.get(round);
      const points = entry?.points ?? 0;
      running[id] += points;
      cumulative[id] = running[id];
      gained[id] = points;
      position[id] = entry?.position ?? null;
    }

    const leaderPoints = Math.max(...entityIds.map((id) => cumulative[id]));

    return {
      round,
      shortName: shortNameByRound.get(round) ?? `R${round}`,
      cumulative,
      gained,
      position,
      leaderPoints,
    };
  });
}
