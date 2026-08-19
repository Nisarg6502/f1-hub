"use client";

import { useEffect, useMemo, useState } from "react";

interface LocalDateTimeProps {
  timestampMs: number;
  options?: Intl.DateTimeFormatOptions;
}

/** The locale for the pre-hydration pass only. Any fixed tag would do; the
 * requirement is that the server and the client agree on it, not that it suits
 * the reader — the effect below hands the reader their own within a frame. */
const STABLE_LOCALE = "en-GB";

const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

/**
 * A timestamp in the reader's own timezone.
 *
 * **The two-pass render is the fix for a hydration mismatch, not caution.**
 * This is a client component, but Next still renders it on the server, and
 * `toLocaleString(undefined, …)` resolves `undefined` to whatever locale and
 * timezone the *renderer* is in. On the server that is the container's — UTC on
 * Cloud Run; in the browser it is the viewer's. The two strings therefore
 * differed for every reader outside UTC, which React 19 reports as error #418
 * ("text content did not match") and resolves by throwing the mismatched
 * subtree away and re-rendering it. It was logged on `/`, `/drivers` and
 * `/watch` on every single page load in production.
 *
 * So the first render is made *deterministic* instead: an explicit locale and
 * an explicit `timeZone: "UTC"` produce the same string on the server and on
 * the client's hydration pass, which is what hydration actually requires —
 * agreement, not correctness. The effect then flips to the reader's real
 * locale and zone.
 *
 * **Both halves of that are load-bearing, and pinning only the timezone was not
 * enough.** With the zone fixed and the locale left to `undefined`, the same
 * instant still rendered as `Sun, Aug 23, 13:00` on the server and
 * `Sun, 23 Aug, 13:00` in the browser — month-first against day-first, because
 * `undefined` resolves the *locale* per renderer exactly as it resolves the
 * zone. That was measured, not predicted: the first version of this fix
 * cleared the error on two routes and left it standing on the home page.
 *
 * This does not add a flash; it removes one. The old code already went from a
 * UTC string to a local string, because the server *was* UTC — it just did so
 * via a caught error and a discarded subtree. The visible result is the same
 * and the console is clean.
 *
 * `suppressHydrationWarning` was the tempting one-word alternative and is the
 * wrong tool: it silences the warning while telling React to keep the server's
 * markup, which would leave a reader in Melbourne looking at a UTC time that
 * never corrects itself.
 */
export default function LocalDateTime({ timestampMs, options }: LocalDateTimeProps) {
  const [local, setLocal] = useState(false);
  useEffect(() => setLocal(true), []);

  const text = useMemo(() => {
    // When the caller passes options, treat them as authoritative so they can
    // drop the month/day and show, e.g., just "Fri 17:00".
    const chosen = options ?? DEFAULT_OPTIONS;
    return local
      ? new Date(timestampMs).toLocaleString(undefined, chosen)
      : new Date(timestampMs).toLocaleString(STABLE_LOCALE, {
          ...chosen,
          timeZone: "UTC",
        });
  }, [timestampMs, options, local]);

  return <>{text}</>;
}
