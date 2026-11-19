import { describe, expect, it } from "vitest";
import { fixtureRace } from "./share-fixtures";
import { raceDayLabel, withoutWinners } from "./watch-races";

describe("withoutWinners", () => {
  it("removes the winner and keeps everything else", () => {
    const [race] = withoutWinners([fixtureRace(5, "Canadian Grand Prix", { winner: true })]);

    expect(race.winner).toBeUndefined();
    expect("winner" in race).toBe(false);
    expect(race.raceName).toBe("Canadian Grand Prix");
    expect(race.round).toBe("5");
    expect(race.Circuit?.circuitName).toBe("Circuit");
  });

  it("does not touch the input", () => {
    const input = [fixtureRace(5, "Canadian Grand Prix", { winner: true })];

    withoutWinners(input);

    expect(input[0].winner?.familyName).toBe("Russell");
  });

  it("leaves a race that never had a winner alone", () => {
    const [race] = withoutWinners([fixtureRace(6, "Monaco Grand Prix")]);

    expect(race.raceName).toBe("Monaco Grand Prix");
    expect("winner" in race).toBe(false);
  });

  it("does not leak the winner into serialised page data", () => {
    const json = JSON.stringify(withoutWinners([fixtureRace(5, "Canadian Grand Prix", { winner: true })]));

    expect(json).not.toContain("Russell");
    expect(json).not.toContain("familyName");
  });
});

describe("raceDayLabel", () => {
  it("formats a UTC date as weekday, day and month", () => {
    expect(raceDayLabel("2026-11-08")).toBe("Sun 8 Nov");
    expect(raceDayLabel("2026-03-08")).toBe("Sun 8 Mar");
    // Some locales abbreviate September as "Sept"; this one must not.
    expect(raceDayLabel("2026-09-06")).toBe("Sun 6 Sep");
  });

  it("does not shift the day with the reader's time zone", () => {
    // A date-only string is read as UTC midnight; a local formatter in a
    // negative-offset zone would show the day before.
    expect(raceDayLabel("2026-01-01")).toBe("Thu 1 Jan");
  });

  it("is null for a missing or unreadable date", () => {
    expect(raceDayLabel(undefined)).toBeNull();
    expect(raceDayLabel("")).toBeNull();
    expect(raceDayLabel("garbage")).toBeNull();
    expect(raceDayLabel("2026-13-45")).toBeNull();
    // Would roll over to 3 March if parsed naively.
    expect(raceDayLabel("2026-02-31")).toBeNull();
  });
});
