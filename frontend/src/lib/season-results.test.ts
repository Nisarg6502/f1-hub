import { describe, expect, it } from "vitest";
import {
  buildConstructorSeasonLogs,
  type SeasonRoundResults,
  type SeasonSprintResults,
} from "./season-results";
import type { ConstructorStanding, RaceResult } from "./api";

function constructorStanding(id: string, name: string): ConstructorStanding {
  return {
    position: "1",
    points: "0",
    wins: "0",
    Constructor: { constructorId: id, name, nationality: "—" },
  };
}

function result(driverId: string, constructorId: string, points: string): RaceResult {
  return {
    Driver: { driverId },
    Constructor: { constructorId, name: constructorId },
    points,
  };
}

describe("buildConstructorSeasonLogs", () => {
  it("sums both drivers' points into one entry per round", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Bahrain Grand Prix",
        results: [
          result("max", "red_bull", "25"),
          result("perez", "red_bull", "18"),
          result("hamilton", "mercedes", "15"),
        ],
        qualifying: [],
      },
    ];

    const logs = buildConstructorSeasonLogs(
      [constructorStanding("red_bull", "Red Bull"), constructorStanding("mercedes", "Mercedes")],
      rounds
    );

    expect(logs.red_bull.entries).toEqual([
      { round: 1, raceName: "Bahrain Grand Prix", shortName: "Bahrain", points: 43 },
    ]);
    expect(logs.mercedes.entries[0].points).toBe(15);
  });

  it("adds sprint points into the same round's entry", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Chinese Grand Prix",
        results: [result("max", "red_bull", "25")],
        qualifying: [],
      },
    ];
    const sprints: SeasonSprintResults[] = [
      { round: "1", results: [result("max", "red_bull", "8")] },
    ];

    const logs = buildConstructorSeasonLogs(
      [constructorStanding("red_bull", "Red Bull")],
      rounds,
      sprints
    );

    expect(logs.red_bull.entries[0].points).toBe(33);
  });

  it("skips a round with no results for that constructor rather than inserting a zero", () => {
    const rounds: SeasonRoundResults[] = [
      { round: "1", raceName: "Bahrain Grand Prix", results: [result("max", "red_bull", "25")], qualifying: [] },
      { round: "2", raceName: "Saudi Arabian Grand Prix", results: [], qualifying: [] },
    ];

    const logs = buildConstructorSeasonLogs([constructorStanding("red_bull", "Red Bull")], rounds);

    expect(logs.red_bull.entries).toHaveLength(1);
  });

  it("orders entries ascending by round regardless of input order", () => {
    const rounds: SeasonRoundResults[] = [
      { round: "3", raceName: "Round 3", results: [result("max", "red_bull", "10")], qualifying: [] },
      { round: "1", raceName: "Round 1", results: [result("max", "red_bull", "25")], qualifying: [] },
    ];

    const logs = buildConstructorSeasonLogs([constructorStanding("red_bull", "Red Bull")], rounds);

    expect(logs.red_bull.entries.map((e) => e.round)).toEqual([1, 3]);
  });

  it("skips a constructor with no constructorId", () => {
    const badConstructor: ConstructorStanding = {
      position: "1",
      points: "0",
      wins: "0",
      Constructor: { name: "Unknown" },
    };

    const logs = buildConstructorSeasonLogs([badConstructor], []);

    expect(Object.keys(logs)).toHaveLength(0);
  });
});
