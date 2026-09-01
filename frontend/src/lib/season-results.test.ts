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

function result(
  driverId: string,
  constructorId: string,
  points: string,
  extra: Partial<RaceResult> = {}
): RaceResult {
  return {
    Driver: { driverId, familyName: driverId, code: driverId.slice(0, 3).toUpperCase() },
    Constructor: { constructorId, name: constructorId },
    points,
    ...extra,
  };
}

/** A classified finisher. `position` alone is not enough -- `didFinish` reads
 * `positionText` and `status`, so a fixture without them is treated as a DNF
 * and every outcome assertion below would be testing the wrong branch. */
function finisher(
  driverId: string,
  constructorId: string,
  position: string,
  points: string,
  extra: Partial<RaceResult> = {}
): RaceResult {
  return result(driverId, constructorId, points, {
    position,
    positionText: position,
    status: "Finished",
    ...extra,
  });
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

    expect(logs.red_bull.entries).toHaveLength(1);
    expect(logs.red_bull.entries[0]).toMatchObject({
      round: 1,
      raceName: "Bahrain Grand Prix",
      shortName: "Bahrain",
      points: 43,
      racePoints: 43,
      sprintPoints: 0,
      scorers: 2,
    });
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

/**
 * The per-driver split is the whole reason the constructor log exists, so these
 * cover the cases that actually occur in a season rather than the happy path:
 * a mid-season change, a one-off stand-in, a round only one car scored in, a
 * round neither did, and sprint points landing on the right car.
 */
describe("buildConstructorSeasonLogs — per-driver breakdown", () => {
  const redBull = [constructorStanding("red_bull", "Red Bull")];

  it("splits a round's points by car, best haul first", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Bahrain Grand Prix",
        results: [
          finisher("perez", "red_bull", "2", "18"),
          finisher("max", "red_bull", "1", "25"),
        ],
        qualifying: [],
      },
    ];

    const [entry] = buildConstructorSeasonLogs(redBull, rounds).red_bull.entries;

    expect(entry.drivers.map((d) => d.driverId)).toEqual(["max", "perez"]);
    expect(entry.drivers[0]).toMatchObject({ position: 1, points: 25, finished: true });
    expect(entry.bestPosition).toBe(1);
    expect(entry.scorers).toBe(2);
  });

  it("keeps a non-scoring car in the round rather than dropping it", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Bahrain Grand Prix",
        results: [
          finisher("max", "red_bull", "1", "25"),
          finisher("perez", "red_bull", "16", "0"),
        ],
        qualifying: [],
      },
    ];

    const [entry] = buildConstructorSeasonLogs(redBull, rounds).red_bull.entries;

    expect(entry.drivers).toHaveLength(2);
    expect(entry.scorers).toBe(1);
    expect(buildConstructorSeasonLogs(redBull, rounds).red_bull.doubleScores).toBe(0);
  });

  it("counts a round where neither car scored as a blank, not a win", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Bahrain Grand Prix",
        results: [
          result("max", "red_bull", "0", { positionText: "R", status: "Engine" }),
          result("perez", "red_bull", "0", { positionText: "R", status: "Collision" }),
        ],
        qualifying: [],
      },
    ];

    const log = buildConstructorSeasonLogs(redBull, rounds).red_bull;

    expect(log.entries[0].points).toBe(0);
    expect(log.entries[0].bestPosition).toBeNull();
    expect(log.entries[0].drivers.every((d) => !d.finished)).toBe(true);
    expect(log.blanks).toBe(1);
    expect(log.bestRound).toBeNull();
  });

  it("attributes sprint points to the car that scored them", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Chinese Grand Prix",
        results: [
          finisher("max", "red_bull", "1", "25"),
          finisher("perez", "red_bull", "5", "10"),
        ],
        qualifying: [],
      },
    ];
    const sprints: SeasonSprintResults[] = [
      { round: "1", results: [finisher("perez", "red_bull", "1", "8")] },
    ];

    const [entry] = buildConstructorSeasonLogs(redBull, rounds, sprints).red_bull.entries;

    expect(entry.racePoints).toBe(35);
    expect(entry.sprintPoints).toBe(8);
    expect(entry.points).toBe(43);
    // Perez's 18 now outranks Max's 25? No -- 10 + 8 = 18, so Max stays first,
    // which is the ordering assertion that matters: the sort is on the combined
    // haul, not on the race result alone.
    expect(entry.drivers.map((d) => d.driverId)).toEqual(["max", "perez"]);
    const perez = entry.drivers.find((d) => d.driverId === "perez");
    expect(perez).toMatchObject({ racePoints: 10, sprintPoints: 8, points: 18 });
  });

  it("includes a car that appears only in the sprint classification", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Chinese Grand Prix",
        results: [finisher("max", "red_bull", "1", "25")],
        qualifying: [],
      },
    ];
    const sprints: SeasonSprintResults[] = [
      { round: "1", results: [finisher("perez", "red_bull", "3", "6")] },
    ];

    const [entry] = buildConstructorSeasonLogs(redBull, rounds, sprints).red_bull.entries;

    expect(entry.drivers).toHaveLength(2);
    const perez = entry.drivers.find((d) => d.driverId === "perez");
    // No race row, so no position and no finish -- but the 6 points are real.
    expect(perez).toMatchObject({ position: null, points: 6, finished: false });
    expect(entry.points).toBe(31);
  });

  it("builds a lineup that shows a mid-season driver change as a round range", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Round 1",
        results: [finisher("max", "red_bull", "1", "25"), finisher("perez", "red_bull", "2", "18")],
        qualifying: [],
      },
      {
        round: "2",
        raceName: "Round 2",
        results: [finisher("max", "red_bull", "1", "25"), finisher("perez", "red_bull", "4", "12")],
        qualifying: [],
      },
      {
        round: "3",
        raceName: "Round 3",
        results: [finisher("max", "red_bull", "1", "25"), finisher("lawson", "red_bull", "9", "2")],
        qualifying: [],
      },
    ];

    const log = buildConstructorSeasonLogs(redBull, rounds).red_bull;

    expect(log.totalPoints).toBe(107);
    expect(log.lineup.map((d) => d.driverId)).toEqual(["max", "perez", "lawson"]);
    expect(log.lineup[1]).toMatchObject({ rounds: 2, firstRound: 1, lastRound: 2, points: 30 });
    // The one-off stand-in: one round, and a range that collapses to a point.
    expect(log.lineup[2]).toMatchObject({ rounds: 1, firstRound: 3, lastRound: 3, points: 2 });
    expect(Math.round(log.lineup[0].share)).toBe(70);
    expect(log.wins).toBe(3);
    expect(log.doubleScores).toBe(3);
  });

  it("reports zero shares rather than NaN for a team that has never scored", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Round 1",
        results: [finisher("bortoleto", "sauber", "14", "0")],
        qualifying: [],
      },
    ];

    const log = buildConstructorSeasonLogs([constructorStanding("sauber", "Sauber")], rounds).sauber;

    expect(log.totalPoints).toBe(0);
    expect(log.lineup[0].share).toBe(0);
    expect(Number.isNaN(log.lineup[0].share)).toBe(false);
  });

  it("counts a 1-2 as two podiums but one win", () => {
    const rounds: SeasonRoundResults[] = [
      {
        round: "1",
        raceName: "Round 1",
        results: [finisher("max", "red_bull", "1", "25"), finisher("perez", "red_bull", "2", "18")],
        qualifying: [],
      },
    ];

    const log = buildConstructorSeasonLogs(redBull, rounds).red_bull;

    expect(log.wins).toBe(1);
    expect(log.podiums).toBe(2);
  });
});

/**
 * `didFinish` is not exported, so these drive it through the public builder.
 * They exist because the backend's status vocabulary is NOT Ergast's — see the
 * measurement recorded on `didFinish` itself.
 */
describe("classification status handling", () => {
  const redBull = [constructorStanding("red_bull", "Red Bull")];
  const roundWith = (r: RaceResult): SeasonRoundResults[] => [
    { round: "1", raceName: "Round 1", results: [r], qualifying: [] },
  ];

  it("treats this backend's `Lapped` as having reached the flag", () => {
    const [entry] = buildConstructorSeasonLogs(
      redBull,
      roundWith(result("max", "red_bull", "0", { positionText: "13", status: "Lapped" }))
    ).red_bull.entries;

    expect(entry.drivers[0].finished).toBe(true);
    // A quiet weekend, not a retirement: the round still has a classified car.
    expect(entry.drivers.every((d) => !d.finished)).toBe(false);
  });

  it("still accepts Ergast's `+1 Lap` form", () => {
    const [entry] = buildConstructorSeasonLogs(
      redBull,
      roundWith(result("max", "red_bull", "0", { positionText: "13", status: "+1 Lap" }))
    ).red_bull.entries;

    expect(entry.drivers[0].finished).toBe(true);
  });

  it("keeps a classified `Retired` car as a non-finish", () => {
    const [entry] = buildConstructorSeasonLogs(
      redBull,
      roundWith(result("max", "red_bull", "0", { positionText: "16", status: "Retired" }))
    ).red_bull.entries;

    // Position survives -- printing DNF over a classified P16 would contradict
    // the result sheet; the panels tag this `RET` instead.
    expect(entry.drivers[0]).toMatchObject({ position: 16, finished: false });
  });

  it("treats an unclassified car as a non-finish whatever the status says", () => {
    const [entry] = buildConstructorSeasonLogs(
      redBull,
      roundWith(result("max", "red_bull", "0", { positionText: "R", status: "Retired" }))
    ).red_bull.entries;

    expect(entry.drivers[0]).toMatchObject({ position: null, finished: false });
  });
});
