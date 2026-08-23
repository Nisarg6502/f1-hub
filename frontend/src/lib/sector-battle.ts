import type { RaceResult, SessionSectorRow } from "./api";
import { getTeamColor } from "./team-colors";

export interface SectorBattleDriver extends SessionSectorRow {
  code: string;
  name: string;
  teamColorHex: string;
}

/**
 * Attaches driver identity (code, name, team color) to each sector row by
 * car number -- the backend endpoint only knows OpenF1's `driver_number` and
 * has no reason to also carry Ergast driver metadata, since the session's
 * classification results (already fetched for the results table above this
 * panel) already have it.
 */
export function joinSectorRowsWithResults(
  rows: SessionSectorRow[],
  results: RaceResult[]
): SectorBattleDriver[] {
  const resultByNumber = new Map<string, RaceResult>();
  for (const result of results) {
    const number = result.number || result.Driver?.permanentNumber;
    if (number) resultByNumber.set(number, result);
  }

  const joined: SectorBattleDriver[] = [];
  for (const row of rows) {
    const result = resultByNumber.get(String(row.driverNumber));
    if (!result?.Driver) continue;

    const code = result.Driver.code || result.Driver.familyName || String(row.driverNumber);
    const name = `${result.Driver.givenName ?? ""} ${result.Driver.familyName ?? ""}`.trim();

    joined.push({
      ...row,
      code,
      name: name || code,
      teamColorHex: getTeamColor(result.Constructor?.name).hex,
    });
  }

  return joined;
}
