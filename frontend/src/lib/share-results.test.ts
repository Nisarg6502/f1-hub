import { describe, expect, it } from "vitest";
import type { RaceResult } from "./api";
import {
  constructorStandingRows,
  driverStandingRows,
  formatResultGap,
  hasClassification,
  isTiedOnPoints,
  lastScoredRound,
  podiumOrder,
  resultKind,
  resultRows,
  sharePortraitBox,
  shortRaceName,
  shortTeamLabel,
  topClassified,
} from "./share-results";
import {
  fixtureDriverStandings,
  fixtureLongConstructorStandings,
  fixtureRace,
  fixtureRaceResultsWithDnf,
} from "./share-fixtures";
import { driverPortraitRowFraction } from "./driver-portrait";

const row = (over: Partial<RaceResult>): RaceResult => ({ position: "5", status: "Finished", ...over });

describe("resultKind", () => {
  it("trusts positionText codes first", () => {
    expect(resultKind(row({ positionText: "R", status: "Finished" }))).toBe("dnf");
    expect(resultKind(row({ positionText: "D" }))).toBe("dsq");
    expect(resultKind(row({ positionText: "W" }))).toBe("dns");
    expect(resultKind(row({ positionText: "N" }))).toBe("nc");
    expect(resultKind(row({ positionText: "E" }))).toBe("excluded");
  });

  it("falls back to status where positionText is missing (the FastF1 rounds)", () => {
    expect(resultKind(row({ status: "Finished" }))).toBe("finished");
    expect(resultKind(row({ status: "" }))).toBe("finished");
    expect(resultKind(row({ status: "+1 Lap" }))).toBe("lapped");
    expect(resultKind(row({ status: "+3 Laps" }))).toBe("lapped");
    expect(resultKind(row({ status: "Lapped" }))).toBe("lapped");
    expect(resultKind(row({ status: "Disqualified" }))).toBe("dsq");
    expect(resultKind(row({ status: "Did not start" }))).toBe("dns");
    expect(resultKind(row({ status: "Engine" }))).toBe("dnf");
    expect(resultKind(row({ status: "Collision damage" }))).toBe("dnf");
  });
});

describe("formatResultGap", () => {
  const leader = row({ position: "1", Time: { time: "1:23:06.801" }, laps: "58" });

  it("gives the winner their race time", () => {
    expect(formatResultGap(leader, leader)).toBe("1:23:06.801");
    expect(formatResultGap(leader, null)).toBe("1:23:06.801");
  });

  it("normalises intervals to a leading +", () => {
    expect(formatResultGap(row({ Time: { time: "+1.747" } }), leader)).toBe("+1.747");
    expect(formatResultGap(row({ Time: { time: "1.747" } }), leader)).toBe("+1.747");
  });

  it("states laps down as laps, from status or computed from lap counts", () => {
    expect(formatResultGap(row({ status: "+1 Lap" }), leader)).toBe("+1 lap");
    expect(formatResultGap(row({ status: "+2 Laps" }), leader)).toBe("+2 laps");
    expect(formatResultGap(row({ status: "Lapped", laps: "56" }), leader)).toBe("+2 laps");
  });

  it("says Lapped rather than inventing a number it cannot compute", () => {
    expect(formatResultGap(row({ status: "Lapped" }), { ...leader, laps: undefined })).toBe("Lapped");
  });

  it("prints the code for anyone who did not finish, never a gap", () => {
    expect(formatResultGap(row({ positionText: "R", status: "Engine", Time: { time: "+9.1" } }), leader)).toBe("DNF");
    expect(formatResultGap(row({ positionText: "D", status: "Disqualified" }), leader)).toBe("DSQ");
  });

  it("falls back to an em dash", () => {
    expect(formatResultGap(row({}), leader)).toBe("—");
  });
});

describe("hasClassification / topClassified", () => {
  it("rejects a session whose rows all have empty positions", () => {
    // The real shape of 2022 Bahrain in the backend.
    expect(hasClassification([row({ position: "" }), row({ position: "" })])).toBe(false);
    expect(hasClassification([])).toBe(false);
    expect(hasClassification(null)).toBe(false);
    expect(hasClassification([row({ position: "" }), row({ position: "3" })])).toBe(true);
  });

  it("sorts by position and drops unpositioned rows", () => {
    const rows = [row({ position: "3" }), row({ position: "" }), row({ position: "1" }), row({ position: "2" })];
    expect(topClassified(rows).map((r) => r.position)).toEqual(["1", "2", "3"]);
  });

  it("caps at n", () => {
    expect(topClassified(fixtureRaceResultsWithDnf(), 10)).toHaveLength(10);
  });
});

describe("resultRows", () => {
  it("carries the DNF and DSQ in the top ten through to the card", () => {
    const rows = resultRows(fixtureRaceResultsWithDnf());
    expect(rows[7]).toMatchObject({ position: 8, gap: "DNF", kind: "dnf" });
    expect(rows[9]).toMatchObject({ position: 10, gap: "DSQ", kind: "dsq" });
    expect(rows[6]).toMatchObject({ gap: "+1 lap", kind: "lapped" });
    expect(rows[0].gap).toBe("1:23:06.801");
  });

  it("keeps full names and diacritics", () => {
    const rows = resultRows(fixtureRaceResultsWithDnf());
    expect(rows[0].fullName).toBe("Andrea Kimi Antonelli");
    expect(rows[6].familyName).toBe("Hülkenberg");
    expect(rows[7].familyName).toBe("Pérez");
  });
});

describe("podiumOrder", () => {
  it("draws second, first, third", () => {
    expect(podiumOrder(["A", "B", "C"])).toEqual([
      { row: "B", place: 2 },
      { row: "A", place: 1 },
      { row: "C", place: 3 },
    ]);
  });

  it("draws a shorter podium for fewer classified rows", () => {
    expect(podiumOrder(["A"])).toEqual([{ row: "A", place: 1 }]);
    expect(podiumOrder(["A", "B"]).map((p) => p.place)).toEqual([2, 1]);
    expect(podiumOrder([])).toEqual([]);
  });
});

describe("standings rows", () => {
  it("keeps the API order for ties instead of re-sorting by points", () => {
    const rows = driverStandingRows(fixtureDriverStandings(), 12);
    expect(rows.slice(7, 10).map((r) => [r.position, r.points])).toEqual([
      [8, 7],
      [9, 7],
      [10, 7],
    ]);
  });

  it("computes the gap to the leader", () => {
    const rows = driverStandingRows(fixtureDriverStandings(), 3);
    expect(rows.map((r) => r.behind)).toEqual([0, 102, 111]);
  });

  it("caps at the limit", () => {
    expect(driverStandingRows(fixtureDriverStandings(), 10)).toHaveLength(10);
    expect(constructorStandingRows(fixtureLongConstructorStandings(), 11)).toHaveLength(11);
  });

  it("is total on an empty table", () => {
    expect(driverStandingRows([], 10)).toEqual([]);
  });

  it("flags rows level on points with a neighbour", () => {
    const rows = driverStandingRows(fixtureDriverStandings(), 12);
    expect(isTiedOnPoints(rows, 6)).toBe(false); // 13 pts, alone
    expect(isTiedOnPoints(rows, 7)).toBe(true);
    expect(isTiedOnPoints(rows, 9)).toBe(true);
    expect(isTiedOnPoints(rows, 10)).toBe(true); // 0 pts, with 11
    expect(isTiedOnPoints(rows, 99)).toBe(false);
  });
});

describe("lastScoredRound", () => {
  it("is the highest round with a winner attached, not the latest date", () => {
    const races = [
      fixtureRace(1, "Australian Grand Prix", { winner: true }),
      fixtureRace(3, "Japanese Grand Prix"),
      fixtureRace(2, "Chinese Grand Prix", { winner: true }),
    ];
    expect(lastScoredRound(races)).toEqual({ round: 2, raceName: "Chinese Grand Prix" });
  });

  it("is null before any round has a result", () => {
    expect(lastScoredRound([fixtureRace(1, "Australian Grand Prix")])).toBeNull();
    expect(lastScoredRound(undefined)).toBeNull();
  });
});

describe("names", () => {
  it("shortens race names the way the page header does", () => {
    expect(shortRaceName("Australian Grand Prix")).toBe("Australian GP");
    expect(shortRaceName("Bahrain Grand Prix in Malaysia")).toBe("Bahrain Grand Prix in Malaysia");
  });

  it("shortens team labels for chart end labels", () => {
    expect(shortTeamLabel("RB F1 Team")).toBe("RB");
    expect(shortTeamLabel("Alpine F1 Team")).toBe("Alpine");
    expect(shortTeamLabel("Williams Racing")).toBe("Williams");
    expect(shortTeamLabel("Mercedes")).toBe("Mercedes");
    expect(shortTeamLabel("Mercedes-AMG Petronas Formula One Team")).toBe("Mercedes-AM…");
    expect(Array.from(shortTeamLabel("Visa Cash App Racing Bulls")).length).toBeLessThanOrEqual(12);
  });
});

describe("sharePortraitBox", () => {
  it("puts the head inside the frame for every frame the cards use", () => {
    for (const frame of ["bust", "figure"] as const) {
      const box = sharePortraitBox(200, 300, frame);
      // Source row 10 is the top of the head; it must land inside the box.
      const headY = box.top + (10 / 1265) * box.height;
      expect(headY).toBeGreaterThan(0);
      expect(headY).toBeLessThan(300 * 0.2);
      expect(box.top).toBeCloseTo(driverPortraitRowFraction(0, frame) * 300, 0);
    }
  });

  it("centres the image horizontally", () => {
    const box = sharePortraitBox(200, 300, "bust");
    expect(box.left + box.width / 2).toBeCloseTo(100, 0);
  });

  it("keeps the source aspect ratio", () => {
    const box = sharePortraitBox(150, 400, "figure");
    expect(box.width / box.height).toBeCloseTo(440 / 1265, 2);
  });
});
