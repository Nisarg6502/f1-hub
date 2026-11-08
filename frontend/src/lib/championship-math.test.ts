import { describe, expect, it } from "vitest";
import type { Race } from "./api";
import { computeTitleDecider, countRemainingRounds, pointsCeilings } from "./championship-math";

const race = (round: number, date: string, sprint = false): Race => ({
  raceName: "",
  round: String(round),
  date,
  time: "17:00:00Z",
  ...(sprint ? { Sprint: { date } } : {}),
});

// 2026 rounds 18-23, run to just after round 19 (Mexico City).
const RACES = [
  race(18, "2026-10-25"),
  race(19, "2026-11-01"),
  race(20, "2026-11-08"),
  race(21, "2026-11-22"),
  race(22, "2026-11-29"),
  race(23, "2026-12-06"),
];
const NOW = new Date("2026-11-07T20:00:00Z");

describe("pointsCeilings", () => {
  it("has no fastest-lap point after 2024", () => {
    expect(pointsCeilings(2026, "driver")).toEqual({ race: 25, sprint: 8 });
    expect(pointsCeilings(2024, "driver")).toEqual({ race: 26, sprint: 8 });
    expect(pointsCeilings(2026, "constructor")).toEqual({ race: 43, sprint: 15 });
    expect(pointsCeilings(2021, "driver")).toEqual({ race: 26, sprint: 3 });
    expect(pointsCeilings(2009, "driver")).toBeNull();
  });
});

describe("countRemainingRounds", () => {
  it("counts by the clock without a standings round", () => {
    expect(countRemainingRounds(RACES, NOW)).toEqual({ remainingRaces: 4, remainingSprints: 0 });
  });

  it("counts from the standings round when known", () => {
    // Round 20 has started but its points are not in a round-19 table yet.
    const duringRace = new Date("2026-11-08T18:00:00Z");
    expect(countRemainingRounds(RACES, duringRace)).toEqual({ remainingRaces: 3, remainingSprints: 0 });
    expect(countRemainingRounds(RACES, duringRace, 19)).toEqual({ remainingRaces: 4, remainingSprints: 0 });
  });
});

describe("computeTitleDecider", () => {
  const standings = [
    { name: "Andrea Kimi Antonelli", points: 380 },
    { name: "Max Verstappen", points: 261 },
  ];

  it("calls the 2026 title after Mexico with a 100-point ceiling", () => {
    const result = computeTitleDecider(standings, RACES, "driver", NOW, { season: 2026, standingsRound: 19 })!;
    expect(result.maxRemainingPoints).toBe(100);
    expect(result.clinched).toBe(true);
  });

  it("does not clinch on a gap equal to the points left", () => {
    const tied = [{ name: "A", points: 200 }, { name: "B", points: 100 }];
    const result = computeTitleDecider(tied, RACES, "driver", NOW, { season: 2026, standingsRound: 19 })!;
    expect(result.clinched).toBe(false);
    expect(result.pointsToClinch).toBe(1);
  });

  it("returns null for unmodelled seasons", () => {
    expect(computeTitleDecider(standings, RACES, "driver", NOW, { season: 2005 })).toBeNull();
    // 2014's double-points finale is not modelled.
    expect(computeTitleDecider(standings, RACES, "driver", NOW, { season: 2014, standingsRound: 19 })).toBeNull();
  });

  it("returns null without a schedule rather than calling any lead decisive", () => {
    expect(computeTitleDecider(standings, [], "driver", NOW, { season: 2026, standingsRound: 19 })).toBeNull();
  });

  it("never claims a clinch mid-season when the standings' round is unknown", () => {
    // A clock count beside a stale table can miss whole rounds of points.
    const result = computeTitleDecider(standings, RACES, "driver", NOW, { season: 2026 })!;
    expect(result.gap).toBeGreaterThan(result.maxRemainingPoints);
    expect(result.clinched).toBe(false);
    expect(result.pointsToClinch).toBe(0);
  });

  it("does call it without a round once nothing is left to run", () => {
    const after = new Date("2026-12-31T00:00:00Z");
    expect(computeTitleDecider(standings, RACES, "driver", after, { season: 2026 })!.clinched).toBe(true);
  });
});
