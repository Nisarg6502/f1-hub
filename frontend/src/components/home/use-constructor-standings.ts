"use client";

import { useEffect, useState } from "react";
import { getConstructorStandings, type ConstructorStanding } from "@/lib/api";

/**
 * The constructors' table, fetched in the browser — the one piece of widget
 * data the default home never needed, so the server never fetches it.
 *
 * Only a widget that is actually on the layout (or previewed in the gallery,
 * which is an explicit request to see it) mounts this hook, so a default
 * visitor makes no extra request. Two widgets that both want the table — the
 * constructors' standings and the title fight's large size — share one
 * request through the module-level promise, and opening the gallery after
 * adding one of them reuses it rather than refetching.
 *
 * A failed request is forgotten rather than cached, so the next mount tries
 * again instead of showing the failure for the rest of the session.
 */
interface Loaded {
  data: ConstructorStanding[];
  /** Round this table describes; the drivers' table can be a round ahead. */
  round: number | null;
}

const cache = new Map<number, Promise<Loaded>>();

function load(year: number): Promise<Loaded> {
  let pending = cache.get(year);
  if (!pending) {
    pending = getConstructorStandings(year).then((res) => ({
      data: res.constructor_standings ?? [],
      round: res.round ?? null,
    }));
    pending.catch(() => cache.delete(year));
    cache.set(year, pending);
  }
  return pending;
}

export type Resource<T> =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: T; round?: number | null };

export function useConstructorStandings(year: number, enabled = true): Resource<ConstructorStanding[]> {
  const [state, setState] = useState<{ year: number; resource: Resource<ConstructorStanding[]> } | null>(
    null
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    load(year).then(
      ({ data, round }) =>
        !cancelled && setState({ year, resource: { status: "ready", data, round } }),
      () => !cancelled && setState({ year, resource: { status: "error" } })
    );
    return () => {
      cancelled = true;
    };
  }, [year, enabled]);

  // Keyed on the year so a stale table is never shown for a different season.
  return state && state.year === year ? state.resource : { status: "loading" };
}
