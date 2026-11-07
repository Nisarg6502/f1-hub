import { describe, expect, it, vi } from "vitest";
import type { ConstructorStanding, DriverStanding } from "./api";
import { createSearchIndexLoader, type SearchIndexFetchers } from "./search-index";

const driver = { Driver: { givenName: "Lewis", familyName: "Hamilton" } } as DriverStanding;
const team = { Constructor: { name: "Ferrari" } } as unknown as ConstructorStanding;

function fakeFetchers(overrides: Partial<SearchIndexFetchers> = {}) {
  return {
    driverStandings: vi.fn(async () => ({ driver_standings: [driver] })),
    constructorStandings: vi.fn(async () => ({ constructor_standings: [team] })),
    seasonRaces: vi.fn(async () => ({ races: [] })),
    circuitDetails: vi.fn(async () => []),
    ...overrides,
  };
}

describe("createSearchIndexLoader", () => {
  it("fetches nothing until it is called", () => {
    const f = fakeFetchers();
    createSearchIndexLoader(f);
    expect(f.constructorStandings).not.toHaveBeenCalled();
    expect(f.driverStandings).not.toHaveBeenCalled();
  });

  it("loads every list for the season", async () => {
    const f = fakeFetchers();
    const index = await createSearchIndexLoader(f)(2026);
    expect(index).toEqual({
      drivers: [driver],
      constructors: [team],
      races: [],
      circuitDetails: [],
      complete: true,
    });
    expect(f.constructorStandings).toHaveBeenCalledWith(2026);
  });

  it("caches per season, including concurrent callers", async () => {
    const f = fakeFetchers();
    const load = createSearchIndexLoader(f);
    const [a, b] = await Promise.all([load(2026), load(2026)]);
    await load(2026);
    expect(a).toBe(b);
    expect(f.constructorStandings).toHaveBeenCalledTimes(1);
    await load(2025);
    expect(f.constructorStandings).toHaveBeenCalledTimes(2);
  });

  it("degrades a failed list to empty without losing the others, and retries it next time", async () => {
    let fail = true;
    const f = fakeFetchers({
      constructorStandings: vi.fn(async () => {
        if (fail) throw new Error("503");
        return { constructor_standings: [team] };
      }),
    });
    const load = createSearchIndexLoader(f);

    const first = await load(2026);
    expect(first.constructors).toEqual([]);
    expect(first.drivers).toEqual([driver]);
    expect(first.complete).toBe(false);

    fail = false;
    const second = await load(2026);
    expect(second.constructors).toEqual([team]);
    expect(second.complete).toBe(true);
    expect(f.constructorStandings).toHaveBeenCalledTimes(2);
  });

  it("treats a missing list in the payload as empty", async () => {
    const f = fakeFetchers({
      constructorStandings: vi.fn(async () => ({ constructor_standings: null })),
    });
    const index = await createSearchIndexLoader(f)(2026);
    expect(index.constructors).toEqual([]);
    expect(index.complete).toBe(true);
  });
});
