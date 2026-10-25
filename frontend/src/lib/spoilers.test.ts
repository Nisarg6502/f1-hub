import { describe, expect, it } from "vitest";
import type { Race } from "./api";
import {
  CORRUPT_SPOILER_PREFS,
  DEFAULT_SPOILER_PREFS,
  ENABLE_LOOKBACK_MS,
  MAX_REVEALED,
  describeRounds,
  findHiddenRound,
  firstResultSessionMs,
  hiddenRounds,
  isRoundHidden,
  joinNames,
  parseSpoilerCookie,
  raceKey,
  raceStartMs,
  redactWinners,
  seasonsInWindow,
  serializeSpoilerPrefs,
  withAutoRevealDays,
  withOn,
  withRevealed,
  type SpoilerPrefs,
} from "./spoilers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ms = (iso: string) => new Date(iso).getTime();

function prefs(overrides: Partial<SpoilerPrefs> = {}): SpoilerPrefs {
  return { on: true, autoRevealDays: 7, revealed: [], since: 0, ...overrides };
}

/** A conventional weekend: FP1-3 Fri/Sat, qualifying Saturday, race Sunday. */
function conventional(round: number, raceDate: string, raceName = `Round ${round} Grand Prix`): Race {
  const sunday = new Date(`${raceDate}T00:00:00Z`);
  const day = (offset: number) =>
    new Date(sunday.getTime() + offset * DAY).toISOString().slice(0, 10);
  return {
    season: "2026",
    round: String(round),
    raceName,
    date: raceDate,
    time: "14:00:00Z",
    FirstPractice: { date: day(-2), time: "11:30:00Z" },
    SecondPractice: { date: day(-2), time: "15:00:00Z" },
    ThirdPractice: { date: day(-1), time: "10:30:00Z" },
    Qualifying: { date: day(-1), time: "14:00:00Z" },
  };
}

/** A sprint weekend: FP1 + sprint qualifying Friday, sprint + qualifying Saturday. */
function sprint(round: number, raceDate: string, raceName = `Round ${round} Grand Prix`): Race {
  const sunday = new Date(`${raceDate}T00:00:00Z`);
  const day = (offset: number) =>
    new Date(sunday.getTime() + offset * DAY).toISOString().slice(0, 10);
  return {
    season: "2026",
    round: String(round),
    raceName,
    date: raceDate,
    time: "18:00:00Z",
    FirstPractice: { date: day(-2), time: "16:30:00Z" },
    SprintQualifying: { date: day(-2), time: "20:30:00Z" },
    Sprint: { date: day(-1), time: "16:00:00Z" },
    Qualifying: { date: day(-1), time: "20:00:00Z" },
  };
}

describe("raceKey", () => {
  it("normalises padded and string rounds to one key", () => {
    expect(raceKey(2026, 7)).toBe("2026-7");
    expect(raceKey("2026", "07")).toBe("2026-7");
  });
});

describe("cookie parse / serialize", () => {
  it("round-trips every field", () => {
    const original = prefs({
      on: true,
      autoRevealDays: 3,
      revealed: ["2026-21", "2026-20"],
      since: ms("2026-10-20T08:15:00Z"),
    });
    const raw = serializeSpoilerPrefs(original);
    expect(parseSpoilerCookie(raw)).toEqual(original);
  });

  it("encodes 'never' as 0 and back to null", () => {
    const raw = serializeSpoilerPrefs(prefs({ autoRevealDays: null }));
    expect(raw.split("|")[2]).toBe("0");
    expect(parseSpoilerCookie(raw).autoRevealDays).toBeNull();
  });

  it("uses only RFC 6265 cookie-octets, so no encoding step is needed", () => {
    const raw = serializeSpoilerPrefs(
      prefs({ revealed: Array.from({ length: 30 }, (_, i) => `2026-${i + 1}`), since: Date.now() })
    );
    // cookie-octet = %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E
    expect(raw).toMatch(/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/);
    expect(raw.length).toBeLessThan(300);
  });

  it("stores since at minute precision", () => {
    const since = ms("2026-10-20T08:15:42.123Z");
    expect(parseSpoilerCookie(serializeSpoilerPrefs(prefs({ since }))).since).toBe(
      ms("2026-10-20T08:15:00Z")
    );
  });

  it("reads absent or empty as the default: off", () => {
    expect(parseSpoilerCookie(undefined)).toEqual(DEFAULT_SPOILER_PREFS);
    expect(parseSpoilerCookie(null)).toEqual(DEFAULT_SPOILER_PREFS);
    expect(parseSpoilerCookie("")).toEqual(DEFAULT_SPOILER_PREFS);
    expect(DEFAULT_SPOILER_PREFS.on).toBe(false);
    expect(DEFAULT_SPOILER_PREFS.autoRevealDays).toBe(7);
  });

  it.each([
    ["garbage", "not-a-cookie"],
    ["JSON from some other version", '{"on":true}'],
    ["wrong version", "v9|1|7|0|"],
    ["too few fields", "v1|1|7"],
    ["too many fields", "v1|1|7|0|2026-1|extra"],
    ["bad on flag", "v1|yes|7|0|"],
    ["broken percent-encoding", "v1%E0%A4%A|1|7|0|"],
  ])("fails CLOSED on a corrupt cookie (%s)", (_label, raw) => {
    const parsed = parseSpoilerCookie(raw);
    expect(parsed).toEqual(CORRUPT_SPOILER_PREFS);
    expect(parsed.on).toBe(true);
  });

  it("repairs a damaged field without discarding the rest", () => {
    const parsed = parseSpoilerCookie("v1|1|42|!!|2026-21.bogus.2026-x.2026-20.2026-21");
    expect(parsed.on).toBe(true);
    expect(parsed.autoRevealDays).toBe(7);
    expect(parsed.since).toBe(0);
    expect(parsed.revealed).toEqual(["2026-21", "2026-20"]);
  });

  it("accepts a percent-encoded value", () => {
    const raw = serializeSpoilerPrefs(prefs({ revealed: ["2026-3"] }));
    expect(parseSpoilerCookie(encodeURIComponent(raw)).revealed).toEqual(["2026-3"]);
  });

  it("caps the revealed list when reading an oversized cookie", () => {
    const keys = Array.from({ length: 50 }, (_, i) => `2025-${i + 1}`).join(".");
    expect(parseSpoilerCookie(`v1|1|7|0|${keys}`).revealed).toHaveLength(MAX_REVEALED);
  });
});

describe("pref updates", () => {
  it("withRevealed puts the newest first, dedupes and keeps the 30 most recent", () => {
    let p = prefs();
    for (let round = 1; round <= 35; round++) p = withRevealed(p, `2025-${round}`);
    expect(p.revealed).toHaveLength(MAX_REVEALED);
    expect(p.revealed[0]).toBe("2025-35");
    expect(p.revealed).not.toContain("2025-5");
    expect(p.revealed).toContain("2025-6");

    const again = withRevealed(p, "2025-20");
    expect(again.revealed[0]).toBe("2025-20");
    expect(again.revealed.filter((k) => k === "2025-20")).toHaveLength(1);
    expect(again.revealed).toHaveLength(MAX_REVEALED);
  });

  it("withRevealed takes several keys and ignores malformed ones", () => {
    const p = withRevealed(prefs({ revealed: ["2026-1"] }), ["2026-3", "nope", "2026-2"]);
    expect(p.revealed).toEqual(["2026-3", "2026-2", "2026-1"]);
  });

  it("withOn stamps since when switching on, keeps it while already on", () => {
    const now = ms("2026-10-25T10:00:00Z");
    const on = withOn(prefs({ on: false, since: 0 }), true, now);
    expect(on).toMatchObject({ on: true, since: now });
    expect(withOn(on, true, now + DAY).since).toBe(now);
  });

  it("withOn(false) keeps the revealed list", () => {
    const off = withOn(prefs({ revealed: ["2026-20"] }), false, 0);
    expect(off).toMatchObject({ on: false, revealed: ["2026-20"] });
  });

  it("withAutoRevealDays repairs a missing since rather than unbounding 'never'", () => {
    const now = ms("2026-10-25T10:00:00Z");
    expect(withAutoRevealDays(CORRUPT_SPOILER_PREFS, null, now)).toMatchObject({
      autoRevealDays: null,
      since: now,
    });
    const kept = withAutoRevealDays(prefs({ since: 123_000 }), 3, now);
    expect(kept.since).toBe(123_000);
  });
});

describe("firstResultSessionMs", () => {
  it("is qualifying on a conventional weekend, not FP1", () => {
    const race = conventional(20, "2026-10-25");
    expect(firstResultSessionMs(race)).toBe(ms("2026-10-24T14:00:00Z"));
  });

  it("is sprint qualifying on a sprint weekend", () => {
    const race = sprint(19, "2026-10-18");
    expect(firstResultSessionMs(race)).toBe(ms("2026-10-16T20:30:00Z"));
  });

  it("falls back to the race when no other session is scheduled", () => {
    const race: Race = { round: "1", raceName: "X", date: "2026-03-08", time: "05:00:00Z" };
    expect(firstResultSessionMs(race)).toBe(ms("2026-03-08T05:00:00Z"));
  });

  it("reads a missing time as midnight UTC, the safe side for hiding", () => {
    const race: Race = { round: "1", raceName: "X", date: "2026-03-08" };
    expect(firstResultSessionMs(race)).toBe(ms("2026-03-08T00:00:00Z"));
    expect(raceStartMs(race)).toBe(ms("2026-03-08T12:00:00Z"));
  });

  it("is null for an unscheduled round", () => {
    expect(firstResultSessionMs({ round: "1", raceName: "X", date: "" })).toBeNull();
  });
});

describe("isRoundHidden", () => {
  const quali = ms("2026-10-24T14:00:00Z");
  const race = ms("2026-10-25T14:00:00Z");

  it("never hides anything while the mode is off", () => {
    expect(isRoundHidden(prefs({ on: false }), "2026-20", quali, race + HOUR, race)).toBe(false);
  });

  it("is visible one millisecond before the first result session and hidden from its start", () => {
    expect(isRoundHidden(prefs(), "2026-20", quali, quali - 1, race)).toBe(false);
    expect(isRoundHidden(prefs(), "2026-20", quali, quali, race)).toBe(true);
  });

  it("hides a round in progress (qualifying run, race not yet started)", () => {
    expect(isRoundHidden(prefs(), "2026-20", quali, quali + 3 * HOUR, race)).toBe(true);
  });

  it("stays visible once revealed", () => {
    expect(isRoundHidden(prefs({ revealed: ["2026-20"] }), "2026-20", quali, race + HOUR, race)).toBe(
      false
    );
  });

  it("auto-reveals exactly N days after the RACE start, not the first session", () => {
    const seven = prefs({ autoRevealDays: 7 });
    expect(isRoundHidden(seven, "2026-20", quali, race + 7 * DAY - 1, race)).toBe(true);
    expect(isRoundHidden(seven, "2026-20", quali, race + 7 * DAY, race)).toBe(false);

    const three = prefs({ autoRevealDays: 3 });
    // 3 days after qualifying would already be revealed; 3 days after the race is not.
    expect(isRoundHidden(three, "2026-20", quali, quali + 3 * DAY + HOUR, race)).toBe(true);
    expect(isRoundHidden(three, "2026-20", quali, race + 3 * DAY, race)).toBe(false);
  });

  it("counts from the first session when no race start is given", () => {
    expect(isRoundHidden(prefs({ autoRevealDays: 3 }), "k", quali, quali + 3 * DAY, undefined)).toBe(
      false
    );
  });

  it("never auto-reveals with 'never'", () => {
    const never = prefs({ autoRevealDays: null, since: quali });
    expect(isRoundHidden(never, "2026-20", quali, race + 400 * DAY, race)).toBe(true);
  });

  it("does not hide rounds from long before the mode was switched on", () => {
    const since = ms("2026-10-27T09:00:00Z");
    const never = prefs({ autoRevealDays: null, since });
    // The weekend just gone is inside the one-week lookback: hidden.
    expect(isRoundHidden(never, "2026-20", quali, since, race)).toBe(true);
    // A round from a month earlier is not.
    const old = quali - 30 * DAY;
    expect(isRoundHidden(never, "2026-17", old, since, old + DAY)).toBe(false);
    // Boundary: exactly at the lookback edge is still hidden.
    const edge = since - ENABLE_LOOKBACK_MS;
    expect(isRoundHidden(never, "2026-19", edge, since, edge)).toBe(true);
    expect(isRoundHidden(never, "2026-19", edge - 1, since, edge)).toBe(false);
  });

  it("treats an unscheduled round as visible", () => {
    expect(isRoundHidden(prefs(), "2026-24", null, Date.now())).toBe(false);
    expect(isRoundHidden(prefs(), "2026-24", NaN, Date.now())).toBe(false);
  });

  it("with a corrupt cookie hides the recent round but nothing old", () => {
    expect(isRoundHidden(CORRUPT_SPOILER_PREFS, "2026-20", quali, race + HOUR, race)).toBe(true);
    expect(isRoundHidden(CORRUPT_SPOILER_PREFS, "2026-20", quali, race + 8 * DAY, race)).toBe(false);
  });
});

describe("hiddenRounds", () => {
  const races: Race[] = [
    conventional(18, "2026-10-04", "Singapore Grand Prix"),
    sprint(19, "2026-10-18", "United States Grand Prix"),
    conventional(20, "2026-10-25", "Mexico City Grand Prix"),
    conventional(21, "2026-11-08", "São Paulo Grand Prix"),
  ];

  it("returns nothing when off", () => {
    expect(hiddenRounds(races, prefs({ on: false }), ms("2026-10-26T00:00:00Z"))).toEqual([]);
  });

  it("returns every unrevealed recent round, in round order", () => {
    const now = ms("2026-10-25T15:00:00Z");
    const hidden = hiddenRounds(races, prefs({ autoRevealDays: 7 }), now);
    expect(hidden.map((h) => h.raceKey)).toEqual(["2026-19", "2026-20"]);
    expect(hidden[1]).toMatchObject({
      season: 2026,
      round: 20,
      raceName: "Mexico City Grand Prix",
      shortName: "Mexico City GP",
      firstResultMs: ms("2026-10-24T14:00:00Z"),
    });
  });

  it("drops a round once revealed and leaves the other hidden", () => {
    const now = ms("2026-10-25T15:00:00Z");
    const hidden = hiddenRounds(races, prefs({ revealed: ["2026-20"] }), now);
    expect(hidden.map((h) => h.raceKey)).toEqual(["2026-19"]);
  });

  it("hides a sprint weekend from Friday's sprint qualifying", () => {
    const fridayNight = ms("2026-10-16T21:00:00Z");
    expect(hiddenRounds(races, prefs(), fridayNight).map((h) => h.raceKey)).toEqual(["2026-19"]);
    const fridayAfternoon = ms("2026-10-16T18:00:00Z"); // FP1 done, SQ not started
    expect(hiddenRounds(races, prefs(), fridayAfternoon)).toEqual([]);
  });

  it("uses the season argument when race documents lack one", () => {
    const bare = races.map((r) => ({ ...r, season: undefined }));
    const hidden = hiddenRounds(bare, prefs(), ms("2026-10-25T15:00:00Z"), 2026);
    expect(hidden.map((h) => h.raceKey)).toEqual(["2026-19", "2026-20"]);
  });

  it("findHiddenRound matches on normalised season and round", () => {
    const hidden = hiddenRounds(races, prefs(), ms("2026-10-25T15:00:00Z"));
    expect(findHiddenRound(hidden, "2026", "20")?.raceName).toBe("Mexico City Grand Prix");
    expect(findHiddenRound(hidden, 2026, 18)).toBeNull();
  });
});

describe("seasonsInWindow", () => {
  it("is empty when off and the active season mid-year", () => {
    expect(seasonsInWindow(prefs({ on: false }), ms("2026-10-25T00:00:00Z"), 2026)).toEqual([]);
    expect(seasonsInWindow(prefs({ since: ms("2026-10-12T00:00:00Z") }), ms("2026-10-25T00:00:00Z"), 2026)).toEqual([2026]);
  });

  it("includes last season across New Year", () => {
    const since = ms("2027-01-03T00:00:00Z"); // floor falls in late December
    expect(seasonsInWindow(prefs({ autoRevealDays: null, since }), since, 2027)).toEqual([2026, 2027]);
    const unknownSince = prefs({ since: 0, autoRevealDays: 7 });
    expect(seasonsInWindow(unknownSince, ms("2027-01-05T00:00:00Z"), 2027)).toEqual([2026, 2027]);
  });

  it("never spans more than two seasons", () => {
    expect(seasonsInWindow(prefs({ since: ms("2019-01-01T00:00:00Z") }), Date.now(), 2026)).toEqual([2025, 2026]);
  });
});

describe("redactWinners", () => {
  const winner = { givenName: "A", familyName: "Driver", code: "DRV" };
  const races: Race[] = [
    { ...conventional(19, "2026-10-18"), winner },
    { ...conventional(20, "2026-10-25"), winner },
  ];

  it("removes the winner from hidden rounds only, without mutating input", () => {
    const hidden = hiddenRounds(races, prefs({ revealed: ["2026-19"] }), ms("2026-10-25T15:00:00Z"));
    const out = redactWinners(races, hidden);
    expect(out[0].winner).toEqual(winner);
    expect(out[1].winner).toBeUndefined();
    expect(races[1].winner).toEqual(winner);
  });

  it("returns the same array when nothing is hidden", () => {
    expect(redactWinners(races, [])).toBe(races);
  });
});

describe("names", () => {
  it("joins one, two and three names", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
    expect(describeRounds(["Mexico City Grand Prix"])).toBe("the Mexico City Grand Prix");
  });
});
