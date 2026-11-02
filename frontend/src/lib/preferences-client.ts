"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  applyPreferencesPatch,
  type Favourites,
  type Preferences,
  type PreferencesPatch,
} from "./preferences";
import { useAccountState } from "./auth-client";

/**
 * `usePreferences()` — the signed-in user's preferences, with optimistic
 * writes. This is the hook the home-layout and spoiler-free branches wire
 * into after merge; they should not need to touch anything else.
 *
 * ONE STORE PER TAB, not one fetch per component. The header, the account
 * page and (later) the home page all read preferences; a hook that fetched
 * on mount would issue one GET per consumer and, worse, let a write in one
 * component leave the others showing the old value. A module-level store
 * read through `useSyncExternalStore` gives every consumer the same snapshot
 * and re-renders all of them on change.
 *
 * OPTIMISTIC: `update()` applies the patch locally at once (with the exact
 * merge rule the server uses, `applyPreferencesPatch`), then PUTs it. The
 * server's answer replaces the local copy; a failure rolls back to the
 * snapshot taken before the write and reports `false`, so the caller can say
 * so. Writes are serialised so a quick double change cannot have an older
 * response land after a newer one and win.
 *
 * GUESTS: status is `"guest"`, preferences are empty and `update()` returns
 * `false` without a request. Nothing here is required for the app to work;
 * the defaults it falls back to are the app as it is today.
 */

export type PreferencesStatus = "loading" | "guest" | "ready" | "error";

interface Snapshot {
  status: PreferencesStatus;
  preferences: Preferences;
}

let snapshot: Snapshot = { status: "loading", preferences: {} };
let loadedFor: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function setSnapshot(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => snapshot;
const SERVER_SNAPSHOT: Snapshot = { status: "loading", preferences: {} };
const getServerSnapshot = () => SERVER_SNAPSHOT;

async function load(userId: string) {
  loadedFor = userId;
  setSnapshot({ status: "loading", preferences: {} });
  try {
    const res = await fetch("/api/me/preferences", { cache: "no-store" });
    if (loadedFor !== userId) return;
    if (res.status === 401) return setSnapshot({ status: "guest", preferences: {} });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { preferences: Preferences };
    setSnapshot({ status: "ready", preferences: body.preferences ?? {} });
  } catch {
    if (loadedFor === userId) setSnapshot({ status: "error", preferences: {} });
  }
}

async function write(patch: PreferencesPatch): Promise<boolean> {
  if (snapshot.status !== "ready") return false;
  const before = snapshot.preferences;
  setSnapshot({ status: "ready", preferences: applyPreferencesPatch(before, patch) });

  const run = queue.then(async () => {
    try {
      const res = await fetch("/api/me/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { preferences: Preferences };
      setSnapshot({ status: "ready", preferences: body.preferences ?? {} });
      return true;
    } catch {
      setSnapshot({ status: "ready", preferences: before });
      return false;
    }
  });
  queue = run;
  return run;
}

export function usePreferences() {
  const account = useAccountState();
  const userId = account.status === "signed-in" ? account.user.id : null;
  const resolved = account.status !== "loading";

  useEffect(() => {
    if (!resolved) return;
    if (!userId) {
      loadedFor = null;
      if (snapshot.status !== "guest") setSnapshot({ status: "guest", preferences: {} });
      return;
    }
    if (loadedFor !== userId) void load(userId);
  }, [resolved, userId]);

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const update = useCallback((patch: PreferencesPatch) => write(patch), []);
  return { ...state, update };
}

const NO_FAVOURITES: Favourites = { driverId: null, teamId: null };

/** Convenience over `usePreferences()` for the favourites namespace. */
export function useFavourites() {
  const { status, preferences, update } = usePreferences();
  const favourites = preferences.favourites ?? NO_FAVOURITES;
  const setFavourites = useCallback(
    (next: Partial<Favourites>) => update({ favourites: { ...favourites, ...next } }),
    [favourites, update]
  );
  return { status, favourites, setFavourites };
}
