import { afterEach, describe, expect, it } from "vitest";
import type { Race } from "./api";
import {
  CATCH_UP_STORAGE_KEY,
  applyHiddenRounds,
  latestFinishedRoundKey,
  markCatchUpRead,
  parseCatchUpState,
  planCatchUp,
  readCatchUpState,
  stateForVisitWithoutCard,
  writeCatchUpState,
  type CatchUpState,
} from "./catch-up";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ms = (iso: string) => new Date(iso).getTime();

function race(round: number, date: string, time: string, sprint?: { date: string; time: string }): Race {
  return {
    season: "2026",
    round: String(round),
    raceName: `Round ${round} Grand Prix`,
    date,
    time,
    ...(sprint ? { Sprint: sprint } : {}),
  };
}

// A compact 2026: a sprint weekend at round 2, a Las Vegas-style late race at
// round 4 (Saturday night locally, Sunday 04:00 in UTC).
const RACES: Race[] = [
  race(1, "2026-03-08", "04:00:00Z"),
  race(2, "2026-03-15", "07:00:00Z", { date: "2026-03-14", time: "03:00:00Z" }),
  race(3, "2026-03-29", "05:00:00Z"),
  race(4, "2026-04-12", "04:00:00Z"),
  race(5, "2026-04-26", "13:00:00Z"),
];

// Nominal ends: Race +120 min, Sprint +60 min (lib/sessions.ts).
const R1_END = ms("2026-03-08T06:00:00Z");
const R2_SPRINT_END = ms("2026-03-14T04:00:00Z");
const R2_END = ms("2026-03-15T09:00:00Z");
const R3_END = ms("2026-03-29T07:00:00Z");
const R4_END = ms("2026-04-12T06:00:00Z");

const seen = (lastSeenAt: number, lastSeenRoundKey: string | null = null): CatchUpState => ({
  lastSeenAt,
  lastSeenRoundKey,
});

describe("planCatchUp", () => {
  it("never shows for a first-time visitor", () => {
    expect(planCatchUp(2026, RACES, null, R4_END + DAY)).toBeNull();
  });

  it("does not show when nothing has finished since the last visit", () => {
    expect(planCatchUp(2026, RACES, seen(R3_END + HOUR), R3_END + 3 * DAY)).toBeNull();
  });

  it("reports one missed round", () => {
    const plan = planCatchUp(2026, RACES, seen(R2_END + DAY, "2026-2"), R3_END + DAY)!;
    expect(plan.afterRound).toBe(2);
    expect(plan.missedRoundKeys).toEqual(["2026-3"]);
    expect(plan.fromPreviousSeason).toBe(false);
    expect(plan.latestFinishedRoundKey).toBe("2026-3");
  });

  it("reports several missed rounds, about three weeks away", () => {
    const lastVisit = R1_END + DAY;
    const plan = planCatchUp(2026, RACES, seen(lastVisit, "2026-1"), lastVisit + 21 * DAY)!;
    expect(plan.afterRound).toBe(1);
    expect(plan.missedRoundKeys).toEqual(["2026-2", "2026-3"]);
  });

  it("does not count a race that is still running", () => {
    const midRace = ms("2026-03-29T06:00:00Z"); // R3 started at 05:00, ends 07:00
    const plan = planCatchUp(2026, RACES, seen(R2_END + DAY), midRace);
    expect(plan).toBeNull();
  });

  it("counts a race the moment its nominal finish passes, not before", () => {
    const state = seen(R2_END + DAY);
    expect(planCatchUp(2026, RACES, state, R3_END - 1)).toBeNull();
    expect(planCatchUp(2026, RACES, state, R3_END)!.missedRoundKeys).toEqual(["2026-3"]);
  });

  it("treats a visit at exactly a race's finish as having seen it", () => {
    expect(planCatchUp(2026, RACES, seen(R3_END), R3_END + DAY)).toBeNull();
  });

  it("counts a sprint on its own while the Grand Prix is still to come", () => {
    const friday = ms("2026-03-13T12:00:00Z");
    const plan = planCatchUp(2026, RACES, seen(friday), R2_SPRINT_END + HOUR)!;
    expect(plan.afterRound).toBe(1);
    expect(plan.missedRoundKeys).toEqual(["2026-2"]);
    expect(plan.seenSprintRoundKeys).toEqual([]);
  });

  it("leaves out a sprint the visitor already saw", () => {
    const saturdayEvening = R2_SPRINT_END + 6 * HOUR;
    const plan = planCatchUp(2026, RACES, seen(saturdayEvening), R2_END + DAY)!;
    expect(plan.afterRound).toBe(1);
    expect(plan.missedRoundKeys).toEqual(["2026-2"]);
    expect(plan.seenSprintRoundKeys).toEqual(["2026-2"]);
  });

  it("caps a last visit in the previous season at this season", () => {
    const lastSeason = ms("2025-11-20T12:00:00Z");
    const plan = planCatchUp(2026, RACES, seen(lastSeason, "2025-21"), R2_END + DAY)!;
    expect(plan.fromPreviousSeason).toBe(true);
    expect(plan.lastSeenSeason).toBe(2025);
    expect(plan.afterRound).toBe(0);
    expect(plan.missedRoundKeys).toEqual(["2026-1", "2026-2"]);
  });

  it("infers the season from the date when no round key was stored", () => {
    const plan = planCatchUp(2026, RACES, seen(ms("2025-12-31T23:30:00Z")), R1_END + DAY)!;
    expect(plan.fromPreviousSeason).toBe(true);
    // New Year's Day UTC is 2026 even where it is still 2025 locally.
    const plan2 = planCatchUp(2026, RACES, seen(ms("2026-01-01T00:30:00Z")), R1_END + DAY)!;
    expect(plan2.fromPreviousSeason).toBe(false);
  });

  it("handles a race that is Saturday night locally and Sunday in UTC", () => {
    // R4 runs 04:00-06:00Z Sunday = 21:00-23:00 Saturday in Las Vegas (UTC-7).
    const saturdayAfternoonVegas = ms("2026-04-11T22:00:00Z"); // 15:00 PDT
    const sundayMorningVegas = ms("2026-04-12T16:00:00Z"); // 09:00 PDT
    const plan = planCatchUp(2026, RACES, seen(saturdayAfternoonVegas), sundayMorningVegas)!;
    expect(plan.missedRoundKeys).toEqual(["2026-4"]);
    expect(plan.afterRound).toBe(3);
  });

  it("falls back to midday UTC for a race with no time", () => {
    const noTime: Race[] = [{ season: "2026", round: "1", raceName: "Old GP", date: "2026-03-08" }];
    // Midday + 120 min = 14:00Z.
    expect(planCatchUp(2026, noTime, seen(ms("2026-03-07T00:00:00Z")), ms("2026-03-08T13:59:00Z"))).toBeNull();
    expect(
      planCatchUp(2026, noTime, seen(ms("2026-03-07T00:00:00Z")), ms("2026-03-08T14:00:00Z"))!.missedRoundKeys
    ).toEqual(["2026-1"]);
  });

  describe("does not depend on the visitor's timezone", () => {
    const original = process.env.TZ;
    afterEach(() => {
      process.env.TZ = original;
    });

    for (const tz of ["UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Asia/Kolkata", "America/Los_Angeles"]) {
      it(`gives the same plan in ${tz}`, () => {
        process.env.TZ = tz;
        const plan = planCatchUp(2026, RACES, seen(R1_END + 2 * HOUR, "2026-1"), R4_END + 3 * HOUR)!;
        expect(plan.afterRound).toBe(1);
        expect(plan.missedRoundKeys).toEqual(["2026-2", "2026-3", "2026-4"]);
        expect(latestFinishedRoundKey(2026, RACES, R4_END + 3 * HOUR)).toBe("2026-4");
      });
    }
  });
});

describe("marking the card read", () => {
  it("stores the end of the latest session shown, not the moment of the click", () => {
    const plan = planCatchUp(2026, RACES, seen(R1_END + DAY), R3_END + HOUR)!;
    const read = markCatchUpRead(plan, RACES, { round: 3, raceClassified: true }, null);
    expect(read).toEqual({ lastSeenAt: R3_END, lastSeenRoundKey: "2026-3" });
    // A race finishing after that is still news next time.
    expect(planCatchUp(2026, RACES, read, R4_END + HOUR)!.missedRoundKeys).toEqual(["2026-4"]);
  });

  it("never skips a Grand Prix that finished but had not synced", () => {
    // R3 has finished by the schedule, but the server only had R2.
    const plan = planCatchUp(2026, RACES, seen(R1_END + DAY), R3_END + DAY)!;
    expect(plan.missedRoundKeys).toEqual(["2026-2", "2026-3"]);
    const read = markCatchUpRead(plan, RACES, { round: 2, raceClassified: true }, null);
    expect(read).toEqual({ lastSeenAt: R2_END, lastSeenRoundKey: "2026-2" });
    expect(planCatchUp(2026, RACES, read, R3_END + 2 * DAY)!.missedRoundKeys).toEqual(["2026-3"]);
  });

  it("stops at the sprint when only the sprint was classified", () => {
    const plan = planCatchUp(2026, RACES, seen(R1_END + DAY), R2_END + HOUR)!;
    const read = markCatchUpRead(plan, RACES, { round: 2, raceClassified: false }, null);
    expect(read.lastSeenAt).toBe(R2_SPRINT_END);
    expect(read.lastSeenRoundKey).toBe("2026-1");
    expect(planCatchUp(2026, RACES, read, R2_END + HOUR)!.missedRoundKeys).toEqual(["2026-2"]);
  });

  it("never moves the marker backwards past what is stored", () => {
    const plan = planCatchUp(2026, RACES, seen(R1_END + DAY), R3_END + HOUR)!;
    const newer = seen(R3_END + 30 * 60 * 1000, "2026-3");
    expect(markCatchUpRead(plan, RACES, { round: 2, raceClassified: true }, newer)).toEqual(newer);
  });

  it("does not move at all when nothing was classified", () => {
    const plan = planCatchUp(2026, RACES, seen(R1_END + DAY), R3_END + HOUR)!;
    expect(markCatchUpRead(plan, RACES, null, null).lastSeenAt).toBe(R1_END + DAY);
  });

  it("records a first visit without showing anything", () => {
    expect(stateForVisitWithoutCard(2026, RACES, null, null, R2_END + HOUR)).toEqual({
      lastSeenAt: R2_END + HOUR,
      lastSeenRoundKey: "2026-2",
    });
  });

  it("moves a visit with nothing new forward, since nothing can be lost", () => {
    const state = seen(R2_END + HOUR, "2026-2");
    const now = R2_END + 5 * DAY;
    expect(planCatchUp(2026, RACES, state, now)).toBeNull();
    expect(stateForVisitWithoutCard(2026, RACES, state, null, now)?.lastSeenAt).toBe(now);
  });

  it("never moves the marker past a card that has not been read", () => {
    const state = seen(R1_END + DAY);
    const plan = planCatchUp(2026, RACES, state, R3_END + DAY);
    expect(stateForVisitWithoutCard(2026, RACES, state, plan, R3_END + DAY)).toBeNull();
  });
});

describe("storage", () => {
  function memory(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
      data,
      getItem: (key: string) => data[key] ?? null,
      setItem: (key: string, value: string) => {
        data[key] = value;
      },
    };
  }

  it("round-trips the state", () => {
    const storage = memory();
    writeCatchUpState(storage, { lastSeenAt: 123, lastSeenRoundKey: "2026-7" });
    expect(readCatchUpState(storage)).toEqual({ lastSeenAt: 123, lastSeenRoundKey: "2026-7" });
    expect(Object.keys(storage.data)).toEqual([CATCH_UP_STORAGE_KEY]);
  });

  it("reads corrupt or foreign values as a first visit", () => {
    expect(parseCatchUpState("not json")).toBeNull();
    expect(parseCatchUpState(JSON.stringify({ lastSeenAt: "yesterday" }))).toBeNull();
    expect(parseCatchUpState(JSON.stringify({ lastSeenAt: -5 }))).toBeNull();
    expect(parseCatchUpState(JSON.stringify(null))).toBeNull();
    expect(parseCatchUpState(JSON.stringify({ lastSeenAt: 5, lastSeenRoundKey: "nope" }))).toEqual({
      lastSeenAt: 5,
      lastSeenRoundKey: null,
    });
  });

  it("survives storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(readCatchUpState(hostile)).toBeNull();
    expect(() => writeCatchUpState(hostile, { lastSeenAt: 1, lastSeenRoundKey: null })).not.toThrow();
    expect(readCatchUpState(null)).toBeNull();
  });
});

describe("applyHiddenRounds", () => {
  const rounds = [{ round_key: "2026-16" }, { round_key: "2026-17" }];

  it("shows everything when nothing is hidden", () => {
    expect(applyHiddenRounds(rounds, undefined)).toEqual({ visible: rounds, anyHidden: false });
  });

  it("drops hidden rounds and says so", () => {
    expect(applyHiddenRounds(rounds, ["2026-17"])).toEqual({
      visible: [{ round_key: "2026-16" }],
      anyHidden: true,
    });
  });

  it("can hide everything", () => {
    expect(applyHiddenRounds(rounds, ["2026-16", "2026-17"]).visible).toEqual([]);
  });
});
