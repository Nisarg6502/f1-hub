import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_MOMENT_EVENT,
  MIN_VISIT_DAYS,
  VISIT_DAYS_KEY,
  isQuietPath,
  recordVisitDay,
  shouldOfferOneTap,
  signalAccountMoment,
} from "./one-tap";

function memoryStorage(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(VISIT_DAYS_KEY, initial);
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    read: () => data.get(VISIT_DAYS_KEY),
  };
}

const day = (iso: string) => new Date(`${iso}T15:30:00Z`);

describe("recordVisitDay", () => {
  it("counts the first visit as one", () => {
    expect(recordVisitDay(memoryStorage(), day("2026-11-19"))).toBe(1);
  });

  it("does not count the same day twice", () => {
    const storage = memoryStorage();

    recordVisitDay(storage, day("2026-11-19"));
    const count = recordVisitDay(storage, new Date("2026-11-19T23:59:00Z"));

    expect(count).toBe(1);
  });

  it("counts distinct days on consecutive visits", () => {
    const storage = memoryStorage();

    recordVisitDay(storage, day("2026-11-17"));
    recordVisitDay(storage, day("2026-11-18"));
    const count = recordVisitDay(storage, day("2026-11-19"));

    expect(count).toBe(3);
    expect(JSON.parse(storage.read() as string)).toEqual(["2026-11-17", "2026-11-18", "2026-11-19"]);
  });

  it("keeps stored days sorted oldest first, whatever order they were written in", () => {
    const storage = memoryStorage(JSON.stringify(["2026-11-19", "2026-11-17", "2026-11-18"]));

    const count = recordVisitDay(storage, day("2026-11-19"));

    expect(count).toBe(3);
    expect(JSON.parse(storage.read() as string)).toEqual(["2026-11-17", "2026-11-18", "2026-11-19"]);
  });

  it("keeps only the ten most recent days", () => {
    const storage = memoryStorage();
    let count = 0;
    for (let d = 1; d <= 12; d++) {
      count = recordVisitDay(storage, day(`2026-10-${String(d).padStart(2, "0")}`));
    }

    expect(count).toBe(10);
    const stored = JSON.parse(storage.read() as string) as string[];
    expect(stored).toHaveLength(10);
    expect(stored[0]).toBe("2026-10-03");
    expect(stored[9]).toBe("2026-10-12");
  });

  it("reads the day in UTC, not the reader's zone", () => {
    const storage = memoryStorage();

    recordVisitDay(storage, new Date("2026-11-19T23:30:00-08:00")); // 07:30Z on the 20th

    expect(JSON.parse(storage.read() as string)).toEqual(["2026-11-20"]);
  });

  it.each([["not json"], ["{}"], ['"2026-11-19"'], ["null"], ["42"]])(
    "treats a corrupt value (%s) as no history and rewrites it",
    (corrupt) => {
      const storage = memoryStorage(corrupt);

      const count = recordVisitDay(storage, day("2026-11-19"));

      expect(count).toBe(1);
      expect(JSON.parse(storage.read() as string)).toEqual(["2026-11-19"]);
    }
  );

  it("ignores entries that are not valid dates", () => {
    const storage = memoryStorage(JSON.stringify(["2026-11-17", 5, null, "tomorrow", "2026-13-40"]));

    const count = recordVisitDay(storage, day("2026-11-19"));

    expect(count).toBe(2);
  });

  it("ignores days later than today, from a clock that was once ahead", () => {
    // A future-dated entry would otherwise count as a visit day until the
    // calendar caught up with it, so a second real visit could count as the third.
    const storage = memoryStorage(JSON.stringify(["2026-11-17", "2026-11-25"]));

    const count = recordVisitDay(storage, day("2026-11-19"));

    expect(count).toBe(2);
    expect(JSON.parse(storage.read() as string)).toEqual(["2026-11-17", "2026-11-19"]);
  });

  it("is 1 when there is no storage", () => {
    expect(recordVisitDay(null, day("2026-11-19"))).toBe(1);
  });

  it("is 1 when reading storage throws (private windows, blocked site data)", () => {
    const storage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };

    expect(recordVisitDay(storage, day("2026-11-19"))).toBe(1);
  });

  it("still returns the count when only writing throws", () => {
    const stored = JSON.stringify(["2026-11-17", "2026-11-18"]);
    const storage = {
      getItem: () => stored,
      setItem: () => {
        throw new Error("quota");
      },
    };

    expect(recordVisitDay(storage, day("2026-11-19"))).toBe(3);
  });
});

describe("shouldOfferOneTap", () => {
  it("waits for the third visit", () => {
    expect(MIN_VISIT_DAYS).toBe(3);
    expect(shouldOfferOneTap({ visitDays: 1, hadMoment: false, pathname: "/" })).toBe(false);
    expect(shouldOfferOneTap({ visitDays: 2, hadMoment: false, pathname: "/" })).toBe(false);
    expect(shouldOfferOneTap({ visitDays: 3, hadMoment: false, pathname: "/" })).toBe(true);
  });

  it("offers straight away after something worth saving", () => {
    expect(shouldOfferOneTap({ visitDays: 1, hadMoment: true, pathname: "/standings" })).toBe(true);
  });

  it.each([
    ["a replay", "/watch/2026-20"],
    ["the sign-in page", "/signin"],
    ["the account page", "/account"],
  ])("never interrupts %s, however much it has earned", (_label, pathname) => {
    expect(shouldOfferOneTap({ visitDays: 9, hadMoment: true, pathname })).toBe(false);
  });

  it("is fine on the replay index, which is a menu, not a replay", () => {
    expect(shouldOfferOneTap({ visitDays: 3, hadMoment: false, pathname: "/watch" })).toBe(true);
  });
});

describe("isQuietPath", () => {
  it("is quiet on a replay, sign-in and account, and nowhere else", () => {
    expect(isQuietPath("/watch/2026-20")).toBe(true);
    expect(isQuietPath("/signin")).toBe(true);
    expect(isQuietPath("/signin?mode=signup")).toBe(true);
    expect(isQuietPath("/account")).toBe(true);
    expect(isQuietPath("/")).toBe(false);
    expect(isQuietPath("/watch")).toBe(false);
    expect(isQuietPath("/standings")).toBe(false);
  });
});

describe("signalAccountMoment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("dispatches the moment event on window", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });

    signalAccountMoment();

    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    expect((dispatchEvent.mock.calls[0][0] as Event).type).toBe(ACCOUNT_MOMENT_EVENT);
  });

  it("does nothing where there is no window", () => {
    expect(() => signalAccountMoment()).not.toThrow();
  });
});
