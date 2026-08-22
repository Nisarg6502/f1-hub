import { describe, expect, it, afterEach } from "vitest";
import {
  CONSENT_KEY,
  isRegulatedRegion,
  readConsent,
  track,
  writeConsent,
} from "./analytics";

/** A localStorage stand-in, so these tests need no DOM. */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
    dump: () => ({ ...data }),
  };
}

describe("isRegulatedRegion", () => {
  it("treats every Europe/* zone as regulated", () => {
    expect(isRegulatedRegion("Europe/Berlin")).toBe(true);
    expect(isRegulatedRegion("Europe/London")).toBe(true);
    expect(isRegulatedRegion("Europe/Dublin")).toBe(true);
  });

  it("treats the EEA Atlantic outliers as regulated", () => {
    // EEA/EU territory that does not sort under Europe/.
    expect(isRegulatedRegion("Atlantic/Reykjavik")).toBe(true);
    expect(isRegulatedRegion("Atlantic/Canary")).toBe(true);
    expect(isRegulatedRegion("Atlantic/Madeira")).toBe(true);
    expect(isRegulatedRegion("Atlantic/Azores")).toBe(true);
    expect(isRegulatedRegion("Atlantic/Faroe")).toBe(true);
  });

  it("does not treat non-EEA zones as regulated", () => {
    expect(isRegulatedRegion("Asia/Kolkata")).toBe(false);
    expect(isRegulatedRegion("America/New_York")).toBe(false);
    expect(isRegulatedRegion("Australia/Melbourne")).toBe(false);
    // Atlantic, but not EEA.
    expect(isRegulatedRegion("Atlantic/Bermuda")).toBe(false);
  });

  it("is not fooled by a zone that merely starts with the same letters", () => {
    expect(isRegulatedRegion("Europeans/Nowhere")).toBe(false);
  });

  it("returns false for an empty zone", () => {
    expect(isRegulatedRegion("")).toBe(false);
  });
});

describe("consent persistence", () => {
  it("returns null when nothing has been stored", () => {
    expect(readConsent(fakeStorage())).toBeNull();
  });

  it("round-trips a granted choice", () => {
    const storage = fakeStorage();
    writeConsent("granted", storage);
    expect(storage.dump()[CONSENT_KEY]).toBe("granted");
    expect(readConsent(storage)).toBe("granted");
  });

  it("round-trips a denied choice", () => {
    const storage = fakeStorage();
    writeConsent("denied", storage);
    expect(readConsent(storage)).toBe("denied");
  });

  it("ignores a corrupted stored value rather than trusting it", () => {
    // A stray value must not read as consent. Anything unrecognised is treated
    // as "never asked", which re-prompts rather than assuming yes.
    expect(readConsent(fakeStorage({ [CONSENT_KEY]: "yes-please" }))).toBeNull();
  });

  it("returns null when there is no storage at all", () => {
    expect(readConsent(null)).toBeNull();
  });

  it("does not throw when writing with no storage", () => {
    expect(() => writeConsent("granted", null)).not.toThrow();
  });
});

describe("track", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it("no-ops and reports false when there is no window", () => {
    expect(track("pitwall_panel_open")).toBe(false);
  });

  it("no-ops and reports false when gtag is absent", () => {
    (globalThis as Record<string, unknown>).window = {};
    expect(track("pitwall_panel_open")).toBe(false);
  });

  it("forwards the event and params to gtag", () => {
    const calls: unknown[][] = [];
    (globalThis as Record<string, unknown>).window = {
      gtag: (...args: unknown[]) => calls.push(args),
    };
    expect(track("search_result_selected", { entity_kind: "driver" })).toBe(
      true
    );
    expect(calls).toEqual([
      ["event", "search_result_selected", { entity_kind: "driver" }],
    ]);
  });

  it("sends an empty params object when none is given", () => {
    const calls: unknown[][] = [];
    (globalThis as Record<string, unknown>).window = {
      gtag: (...args: unknown[]) => calls.push(args),
    };
    track("watch_pair_qr");
    expect(calls).toEqual([["event", "watch_pair_qr", {}]]);
  });
});
