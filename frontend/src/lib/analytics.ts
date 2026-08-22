/**
 * Google Analytics 4 plumbing, kept free of React and of the DOM so a harness
 * can drive it.
 *
 * Three things live here: whether a visitor is in a jurisdiction that must be
 * asked before a cookie is set, what they answered, and a `track()` that is
 * safe to call from anywhere. None of it renders; `components/analytics.tsx`
 * and `components/consent-banner.tsx` do that.
 *
 * The storage arguments are not dependency-injection ceremony -- they are the
 * reason this file needs no jsdom to test. See `vitest.config.ts`.
 */

/**
 * Baked into the client bundle at build time by Next, so it must be written as
 * a full literal `process.env.NEXT_PUBLIC_...` expression. Next inlines the
 * text of that expression; a computed lookup would survive the build as an
 * undefined runtime read.
 *
 * Empty when unset, which is the whole of the "degrade quietly" story: every
 * consumer checks this and does nothing.
 */
export const MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID ?? "";

/** Namespaced to match `apex.watch.*` in `watch-preferences.ts`. */
export const CONSENT_KEY = "apex.consent.analytics";

export type ConsentChoice = "granted" | "denied";

/** Only the two methods this module uses, so a plain object satisfies it. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * EEA/EU/UK territories whose IANA zone does not sort under `Europe/`.
 *
 * Iceland and the Faroes are EEA; the Canaries (Spain), Madeira and the Azores
 * (Portugal) are EU outermost regions. `Atlantic/Bermuda` and
 * `Atlantic/South_Georgia` are deliberately absent -- British territories, but
 * not in the UK GDPR's territorial scope, and they are the reason this is an
 * explicit list rather than an `Atlantic/` prefix test.
 */
const EEA_OUTLIERS = new Set([
  "Atlantic/Reykjavik",
  "Atlantic/Faroe",
  "Atlantic/Canary",
  "Atlantic/Madeira",
  "Atlantic/Azores",
]);

/**
 * Whether a timezone belongs to a visitor who must be asked before `_ga` is
 * set.
 *
 * Timezone, not geo-IP, because the site is served from a bare `run.app` URL
 * with no load balancer in front of it and therefore has no geo headers, and
 * because a geo-IP lookup would mean disclosing a new third party on the very
 * page this change rewrites for honesty.
 *
 * It is over-inclusive at the margins -- a European on holiday in Singapore, a
 * VPN user -- and that is the safe direction. The failure mode is showing a
 * banner to someone who did not legally need one.
 */
export function isRegulatedRegion(timeZone: string): boolean {
  if (!timeZone) return false;
  // The trailing slash matters: "Europeans/Nowhere" is not Europe.
  if (timeZone.startsWith("Europe/")) return true;
  return EEA_OUTLIERS.has(timeZone);
}

/** The browser's IANA zone, or `""` where it cannot be determined. */
export function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  } catch {
    return "";
  }
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Safari in private mode, and any browser with storage disabled, throw on
    // access rather than returning null.
    return null;
  }
}

/**
 * The stored choice, or `null` for "never asked".
 *
 * Anything unrecognised reads as `null` rather than as consent. A corrupted or
 * hand-edited value must re-prompt, never silently grant.
 */
export function readConsent(
  storage: StorageLike | null = defaultStorage()
): ConsentChoice | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CONSENT_KEY);
    return raw === "granted" || raw === "denied" ? raw : null;
  } catch {
    return null;
  }
}

export function writeConsent(
  choice: ConsentChoice,
  storage: StorageLike | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(CONSENT_KEY, choice);
  } catch {
    // A visitor who declined and whose storage then failed simply gets asked
    // again next visit. Nothing here is worth throwing over.
  }
}

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

/**
 * Send one event, if there is anything to send it to.
 *
 * Returns whether it was actually sent, which is what makes it testable and
 * what lets a caller stay a bare one-liner everywhere else. Safe to call before
 * consent (gtag queues), with no measurement ID, and during SSR.
 *
 * Parameters must be enum-ish values only -- an entity kind, a circuit id, a
 * route. Never free text, never anything a user typed.
 */
export function track(
  event: string,
  params: Record<string, string | number> = {}
): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.gtag !== "function") return false;
  window.gtag("event", event, params);
  return true;
}
