import { describe, expect, it } from "vitest";
import { buildProgressionRows } from "./championship-progression";

describe("buildProgressionRows", () => {
  it("accumulates points round over round per entity", () => {
    const rows = buildProgressionRows(["max", "lewis"], {
      max: {
        entries: [
          { round: 1, shortName: "Bahrain", points: 25, position: 1 },
          { round: 2, shortName: "Jeddah", points: 18, position: 2 },
        ],
      },
      lewis: {
        entries: [
          { round: 1, shortName: "Bahrain", points: 15, position: 3 },
          { round: 2, shortName: "Jeddah", points: 25, position: 1 },
        ],
      },
    });

    expect(rows).toEqual([
      {
        round: 1,
        shortName: "Bahrain",
        cumulative: { max: 25, lewis: 15 },
        gained: { max: 25, lewis: 15 },
        position: { max: 1, lewis: 3 },
        leaderPoints: 25,
      },
      {
        round: 2,
        shortName: "Jeddah",
        cumulative: { max: 43, lewis: 40 },
        gained: { max: 18, lewis: 25 },
        position: { max: 2, lewis: 1 },
        leaderPoints: 43,
      },
    ]);
  });

  it("treats a round an entity has no entry for as zero points gained, carrying the total forward", () => {
    const rows = buildProgressionRows(["max", "sub"], {
      max: { entries: [{ round: 1, shortName: "R1", points: 25, position: 1 }] },
      sub: { entries: [{ round: 2, shortName: "R2", points: 4, position: 8 }] },
    });

    expect(rows[0]).toEqual({
      round: 1,
      shortName: "R1",
      cumulative: { max: 25, sub: 0 },
      gained: { max: 25, sub: 0 },
      position: { max: 1, sub: null },
      leaderPoints: 25,
    });
    expect(rows[1].cumulative).toEqual({ max: 25, sub: 4 });
  });

  it("unions the round set across entities rather than requiring every entity to share every round", () => {
    const rows = buildProgressionRows(["a", "b"], {
      a: { entries: [{ round: 1, shortName: "R1", points: 10 }] },
      b: { entries: [{ round: 3, shortName: "R3", points: 5 }] },
    });

    expect(rows.map((r) => r.round)).toEqual([1, 3]);
  });

  it("defaults a missing position to null rather than omitting the key", () => {
    const rows = buildProgressionRows(["a"], {
      a: { entries: [{ round: 1, shortName: "R1", points: 10 }] },
    });

    expect(rows[0].position).toEqual({ a: null });
  });

  it("handles an entity absent from the log map entirely as scoring nothing", () => {
    const rows = buildProgressionRows(["a", "ghost"], {
      a: { entries: [{ round: 1, shortName: "R1", points: 10 }] },
    });

    expect(rows[0].cumulative).toEqual({ a: 10, ghost: 0 });
  });

  it("returns an empty array when no entity has any entries", () => {
    expect(buildProgressionRows(["a"], { a: { entries: [] } })).toEqual([]);
  });
});
