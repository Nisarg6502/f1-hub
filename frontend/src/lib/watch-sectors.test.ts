import { describe, expect, it } from "vitest";
import { formatSector, sectorFractions, sectorStates, sectorsForLap } from "./watch-sectors";

describe("sectorsForLap", () => {
  it("returns the lap's three sectors", () => {
    expect(sectorsForLap([[30_000, 30_000, 30_000]], 0)).toEqual([30_000, 30_000, 30_000]);
  });

  it("refuses a lap with a missing or non-positive sector", () => {
    expect(sectorsForLap([null], 0)).toBeNull();
    expect(sectorsForLap([[30_000, 0, 30_000]], 0)).toBeNull();
    expect(sectorsForLap([[30_000, 30_000]], 0)).toBeNull();
    expect(sectorsForLap(undefined, 0)).toBeNull();
    expect(sectorsForLap([[1, 1, 1]], 5)).toBeNull();
  });
});

describe("sectorFractions", () => {
  it("places the splits proportionally", () => {
    expect(sectorFractions([20_000, 40_000, 40_000])).toEqual([0.2, 0.6]);
  });
});

describe("sectorStates", () => {
  // Sectors sum to 90s, but the clock runs the lap for 99s (the official lap
  // time disagrees with OpenF1's sum). Readouts are scaled by 90/99.
  const sectors = [30_000, 30_000, 30_000] as const;

  it("starts with sector 1 running and the rest pending", () => {
    expect(sectorStates(sectors, 99_000, 0)).toEqual([
      { kind: "running", ms: 0 },
      { kind: "pending" },
      { kind: "pending" },
    ]);
  });

  it("lands on the real sector time exactly at the boundary", () => {
    // 33s of clock = 30s of sector time.
    const [s1, s2] = sectorStates(sectors, 99_000, 33_000);
    expect(s1).toEqual({ kind: "done", ms: 30_000 });
    expect(s2).toEqual({ kind: "running", ms: 0 });
  });

  it("scales the running sector's readout", () => {
    const [, s2] = sectorStates(sectors, 99_000, 49_500); // 45s of sector time
    expect(s2.kind).toBe("running");
    expect((s2 as { ms: number }).ms).toBeCloseTo(15_000);
  });

  it("marks every sector done at the end of the lap and past it", () => {
    for (const elapsed of [99_000, 120_000]) {
      expect(sectorStates(sectors, 99_000, elapsed).map((s) => s.kind)).toEqual([
        "done",
        "done",
        "done",
      ]);
    }
  });
});

describe("formatSector", () => {
  it("formats seconds with one decimal", () => {
    expect(formatSector(23_449)).toBe("23.4");
    expect(formatSector(9_960)).toBe("10.0");
  });

  it("adds minutes for a long sector without ever printing 60.0", () => {
    expect(formatSector(62_340)).toBe("1:02.3");
    expect(formatSector(59_970)).toBe("1:00.0");
  });
});
