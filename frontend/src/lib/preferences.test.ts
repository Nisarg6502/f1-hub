import { describe, expect, it } from "vitest";
import {
  MAX_HOME_LAYOUT_BYTES,
  MAX_SPOILERS_BYTES,
  applyPreferencesPatch,
  pickPreferences,
  validatePreferencesPatch,
} from "./preferences";

describe("validatePreferencesPatch", () => {
  it("accepts every namespace at once", () => {
    const result = validatePreferencesPatch({
      favourites: { driverId: "max_verstappen", teamId: "red_bull" },
      homeLayout: { widgets: ["next-race", "standings"] },
      spoilers: { hideResults: true },
      clock: "24h",
    });
    expect(result).toEqual({
      ok: true,
      patch: {
        favourites: { driverId: "max_verstappen", teamId: "red_bull" },
        homeLayout: { widgets: ["next-race", "standings"] },
        spoilers: { hideResults: true },
        clock: "24h",
      },
    });
  });

  it("rejects non-objects", () => {
    for (const body of [null, [], "x", 3, true]) {
      expect(validatePreferencesPatch(body).ok).toBe(false);
    }
  });

  it("rejects unknown keys instead of silently dropping them", () => {
    const result = validatePreferencesPatch({ favorites: { driverId: "x" } });
    expect(result).toEqual({ ok: false, error: "Unknown preference key: favorites" });
  });

  it("normalises a partial favourites object to explicit nulls", () => {
    const result = validatePreferencesPatch({ favourites: { driverId: "norris" } });
    expect(result).toEqual({
      ok: true,
      patch: { favourites: { driverId: "norris", teamId: null } },
    });
  });

  it("rejects favourite ids that are not lower-case ids", () => {
    for (const driverId of ["Max", "max verstappen", "../etc", "", "a".repeat(65), 12]) {
      expect(validatePreferencesPatch({ favourites: { driverId } }).ok).toBe(false);
    }
  });

  it("rejects extra keys inside favourites", () => {
    expect(
      validatePreferencesPatch({ favourites: { driverId: "norris", circuit: "monza" } })
    ).toEqual({ ok: false, error: "Unknown favourites key: circuit" });
  });

  it("accepts only the three clock values", () => {
    for (const clock of ["12h", "24h", "auto"]) {
      expect(validatePreferencesPatch({ clock }).ok).toBe(true);
    }
    for (const clock of ["24", "AUTO", "", 24]) {
      expect(validatePreferencesPatch({ clock }).ok).toBe(false);
    }
  });

  it("treats null as a request to clear the namespace", () => {
    expect(
      validatePreferencesPatch({ favourites: null, clock: null, homeLayout: null, spoilers: null })
    ).toEqual({
      ok: true,
      patch: { favourites: null, clock: null, homeLayout: null, spoilers: null },
    });
  });

  it("enforces the home layout size limit in UTF-8 bytes", () => {
    // Each "é" is two bytes in UTF-8 but one UTF-16 code unit: a limit on
    // `.length` would let this through at roughly double the intended size.
    const overByBytes = "é".repeat(MAX_HOME_LAYOUT_BYTES / 2);
    expect(overByBytes.length).toBeLessThan(MAX_HOME_LAYOUT_BYTES);
    const result = validatePreferencesPatch({ homeLayout: overByBytes });
    expect(result.ok).toBe(false);

    const fits = "x".repeat(MAX_HOME_LAYOUT_BYTES - 2); // + 2 quote bytes
    expect(validatePreferencesPatch({ homeLayout: fits }).ok).toBe(true);
    expect(validatePreferencesPatch({ homeLayout: fits + "x" }).ok).toBe(false);
  });

  it("enforces the spoilers size limit", () => {
    const fits = "x".repeat(MAX_SPOILERS_BYTES - 2);
    expect(validatePreferencesPatch({ spoilers: fits }).ok).toBe(true);
    expect(validatePreferencesPatch({ spoilers: fits + "x" }).ok).toBe(false);
  });
});

describe("applyPreferencesPatch", () => {
  it("replaces namespaces wholesale and leaves absent ones alone", () => {
    const next = applyPreferencesPatch(
      { clock: "12h", homeLayout: { widgets: ["a", "b", "c"] } },
      { homeLayout: { widgets: ["a"] } }
    );
    // A deep merge would have kept "b" and "c".
    expect(next).toEqual({ clock: "12h", homeLayout: { widgets: ["a"] } });
  });

  it("deletes a namespace on null", () => {
    expect(applyPreferencesPatch({ clock: "12h" }, { clock: null })).toEqual({});
  });
});

describe("pickPreferences", () => {
  it("projects a stored document onto known namespaces only", () => {
    expect(
      pickPreferences({
        _id: "abc",
        userId: "u1",
        updatedAt: new Date(),
        clock: "auto",
        favourites: { driverId: null, teamId: "ferrari" },
        somethingElse: 1,
      })
    ).toEqual({ clock: "auto", favourites: { driverId: null, teamId: "ferrari" } });
  });

  it("returns an empty object for a missing document", () => {
    expect(pickPreferences(null)).toEqual({});
  });
});
