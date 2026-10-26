"use client";

/**
 * Spoiler-free mode, client side: read and write the preference cookie.
 *
 * The cookie is the only store. Writing it and then calling
 * `router.refresh()` re-runs this route's server components with the new
 * value, so a reveal swaps the placeholder for the real content in place:
 * no full reload, no scroll jump, and client state elsewhere on the page
 * (an open accordion, the search field) survives.
 *
 * Reading goes through `useSyncExternalStore` with a server snapshot of
 * `null`. Client components rendered on the server therefore see "not known
 * yet" (`ready: false`) rather than a guessed default, and hydrate without a
 * mismatch. That is safe because no client component decides on its own
 * whether to show a result; the server already did that from the same
 * cookie. Client-side reads are for the controls: the eye icon, the settings
 * panel, and surfaces like search that fetch their data in the browser.
 */

import { useCallback, useEffect, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { track } from "./analytics";
import {
  DEFAULT_SPOILER_PREFS,
  SPOILER_COOKIE,
  SPOILER_COOKIE_MAX_AGE_S,
  parseSpoilerCookie,
  serializeSpoilerPrefs,
  withAutoRevealDays,
  withOn,
  withRevealed,
  type AutoRevealDays,
  type SpoilerPrefs,
} from "./spoilers";

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab may have changed the setting while this one was hidden.
  document.addEventListener("visibilitychange", listener);
  return () => {
    listeners.delete(listener);
    document.removeEventListener("visibilitychange", listener);
  };
}

/** The raw cookie value, `""` when absent. A string, so React can compare snapshots by value. */
function readRaw(): string {
  const prefix = `${SPOILER_COOKIE}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return "";
}

function serverSnapshot(): string | null {
  return null;
}

/** Write the cookie. Returns false when the browser refused it. */
export function writeSpoilerCookie(prefs: SpoilerPrefs): boolean {
  const value = serializeSpoilerPrefs(prefs);
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SPOILER_COOKIE}=${value}; Path=/; Max-Age=${SPOILER_COOKIE_MAX_AGE_S}; SameSite=Lax${secure}`;
  emit();
  return readRaw() === value;
}

/**
 * Re-render the server components when the cookie changed in ANOTHER tab.
 *
 * The external store above already re-reads the cookie on `visibilitychange`,
 * so the controls catch up on their own. The placeholders don't: they were
 * decided on the server from the cookie this tab sent at load time. Revealing
 * a round in tab A and switching back to tab B would leave B's placeholder
 * up (or, after turning the mode ON in A, B's result showing) until a reload.
 *
 * Mount this ONCE per page (the header toggle does). Every `useSpoilers()`
 * consumer subscribing would refresh once each.
 */
export function useSpoilerCrossTabSync() {
  const router = useRouter();
  useEffect(() => {
    let seenWhileVisible = readRaw();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        seenWhileVisible = readRaw();
        return;
      }
      const now = readRaw();
      if (now !== seenWhileVisible) {
        seenWhileVisible = now;
        router.refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [router]);
}

export interface UseSpoilers {
  /** The current preference. The default (off) until `ready`. */
  prefs: SpoilerPrefs;
  /** False during server rendering and hydration, when the cookie is not readable. */
  ready: boolean;
  /** True while the page is re-rendering on the server after a change. */
  pending: boolean;
  reveal: (raceKey: string) => void;
  revealMany: (raceKeys: string[]) => void;
  setOn: (on: boolean) => void;
  setAutoRevealDays: (days: AutoRevealDays) => void;
}

export function useSpoilers(): UseSpoilers {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const raw = useSyncExternalStore(subscribe, readRaw, serverSnapshot);
  const ready = raw !== null;
  const prefs = ready ? parseSpoilerCookie(raw) : DEFAULT_SPOILER_PREFS;

  const commit = useCallback(
    (update: (current: SpoilerPrefs) => SpoilerPrefs) => {
      // Read fresh rather than closing over `prefs`: two quick reveals from
      // different rows must not each overwrite the other's key.
      const next = update(parseSpoilerCookie(readRaw()));
      writeSpoilerCookie(next);
      startTransition(() => router.refresh());
    },
    [router]
  );

  const revealMany = useCallback(
    (keys: string[]) => {
      if (keys.length === 0) return;
      commit((current) => withRevealed(current, keys));
      // A count, never which round: event parameters stay content-free.
      track("spoiler_round_revealed", { rounds: keys.length });
    },
    [commit]
  );

  const reveal = useCallback((key: string) => revealMany([key]), [revealMany]);

  const setOn = useCallback(
    (on: boolean) => {
      commit((current) => withOn(current, on, Date.now()));
      track("spoiler_mode_toggled", { state: on ? "on" : "off" });
    },
    [commit]
  );

  const setAutoRevealDays = useCallback(
    (days: AutoRevealDays) => {
      commit((current) => withAutoRevealDays(current, days, Date.now()));
      track("spoiler_auto_reveal_set", { days: days ?? "never" });
    },
    [commit]
  );

  return { prefs, ready, pending, reveal, revealMany, setOn, setAutoRevealDays };
}
