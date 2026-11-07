import type { CircuitDetail, ConstructorStanding, DriverStanding, Race } from "./api";

/** Everything the global search filters over, for one season. */
export interface SearchIndex {
  drivers: DriverStanding[];
  constructors: ConstructorStanding[];
  races: Race[];
  circuitDetails: CircuitDetail[];
  /** False when any list failed and fell back to empty; such loads are not cached. */
  complete: boolean;
}

export interface SearchIndexFetchers {
  driverStandings: (year: number) => Promise<{ driver_standings?: DriverStanding[] | null }>;
  constructorStandings: (
    year: number,
  ) => Promise<{ constructor_standings?: ConstructorStanding[] | null }>;
  seasonRaces: (year: number) => Promise<{ races?: Race[] | null }>;
  circuitDetails: (year: number) => Promise<CircuitDetail[]>;
}

/**
 * Builds a loader that fetches the search index lazily and at most once per
 * season.
 *
 * The search used to fetch all four lists in a mount effect, which meant every
 * page load paid for them (the nav search mounts with the layout) even though
 * almost nobody opens search. The component now calls the loader when the
 * field is first focused or typed into, and the cache means the nav and the
 * phone's More sheet (which mounts its own copy each time it opens) share one
 * request.
 *
 * Each list fails on its own and degrades to empty, as before, so one slow or
 * broken endpoint does not take the others down with it. A load in which ANY
 * list failed is not cached, so the next open retries rather than serving an
 * empty list for the rest of the session; the in-flight promise IS shared, so
 * concurrent callers never double-fetch.
 */
export function createSearchIndexLoader(fetchers: SearchIndexFetchers) {
  const cache = new Map<number, Promise<SearchIndex>>();

  return function loadSearchIndex(year: number): Promise<SearchIndex> {
    const hit = cache.get(year);
    if (hit) return hit;

    let failed = false;
    const settle = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
      p.catch(() => {
        failed = true;
        return fallback;
      });

    const pending = Promise.all([
      settle(
        fetchers.driverStandings(year).then((r) => r.driver_standings ?? []),
        [] as DriverStanding[],
      ),
      settle(
        fetchers.constructorStandings(year).then((r) => r.constructor_standings ?? []),
        [] as ConstructorStanding[],
      ),
      settle(
        fetchers.seasonRaces(year).then((r) => r.races ?? []),
        [] as Race[],
      ),
      settle(fetchers.circuitDetails(year), [] as CircuitDetail[]),
    ]).then(([drivers, constructors, races, circuitDetails]) => {
      if (failed) cache.delete(year);
      return { drivers, constructors, races, circuitDetails, complete: !failed };
    });

    cache.set(year, pending);
    return pending;
  };
}
