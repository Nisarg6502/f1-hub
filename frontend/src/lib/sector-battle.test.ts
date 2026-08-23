import { describe, expect, it } from "vitest";
import { joinSectorRowsWithResults } from "./sector-battle";
import type { RaceResult, SessionSectorRow } from "./api";

function sectorRow(driverNumber: number): SessionSectorRow {
  return {
    driverNumber,
    lapNumber: 10,
    lapDurationSeconds: 87.0,
    sectors: {
      "1": { seconds: 28.0, classification: "purple" },
      "2": { seconds: 30.0, classification: "green" },
      "3": { seconds: 29.0, classification: "yellow" },
    },
  };
}

function result(number: string, code: string, teamName: string): RaceResult {
  return {
    number,
    Driver: { code, givenName: "Max", familyName: "Verstappen" },
    Constructor: { name: teamName },
  };
}

describe("joinSectorRowsWithResults", () => {
  it("attaches code, name and team color from the matching classification result", () => {
    const joined = joinSectorRowsWithResults(
      [sectorRow(1)],
      [result("1", "VER", "Red Bull")]
    );

    expect(joined).toHaveLength(1);
    expect(joined[0].code).toBe("VER");
    expect(joined[0].name).toBe("Max Verstappen");
    expect(joined[0].teamColorHex).toBe("#3671C6");
    expect(joined[0].driverNumber).toBe(1);
  });

  it("drops a sector row with no matching result rather than rendering blank identity", () => {
    const joined = joinSectorRowsWithResults([sectorRow(99)], [result("1", "VER", "Red Bull")]);

    expect(joined).toEqual([]);
  });

  it("falls back to the family name when no code is present", () => {
    const noCode: RaceResult = {
      number: "1",
      Driver: { familyName: "Verstappen" },
      Constructor: { name: "Red Bull" },
    };

    const joined = joinSectorRowsWithResults([sectorRow(1)], [noCode]);

    expect(joined[0].code).toBe("Verstappen");
  });

  it("preserves the input rows' order", () => {
    const joined = joinSectorRowsWithResults(
      [sectorRow(44), sectorRow(1)],
      [result("1", "VER", "Red Bull"), result("44", "HAM", "Mercedes")]
    );

    expect(joined.map((d) => d.driverNumber)).toEqual([44, 1]);
  });
});
