/**
 * When to offer Google One Tap.
 *
 * One Tap is the "Continue as <you>" prompt Google draws in the corner. It used
 * to fire on the first page of the first visit: before the visitor had seen
 * anything worth saving, and with nothing said about what an account is for. A
 * stranger asked for their identity in the first second learns that this site is
 * after something; it also logged FedCM errors in the console of every page.
 *
 * It is now earned, by either of:
 *
 *   - **A third visit on a third day.** Someone who has come back twice has an
 *     opinion about the site, and a prompt reads as an offer rather than a toll.
 *   - **A moment worth saving** this visit: they turned spoiler-free mode on,
 *     arranged their home page, or got an answer from the assistant. Each is
 *     something an account would keep for them, so each calls
 *     `signalAccountMoment()`.
 *
 * And it never appears over the things a person is concentrating on or has
 * already chosen: a replay, the sign-in page, the account page.
 *
 * Kept free of React and of `document` so every decision is a pure function the
 * node-only test runner can drive; the component (`google-one-tap.tsx`) wires it
 * to `localStorage` and to the event.
 */

export const VISIT_DAYS_KEY = "apex_visit_days";
/** Dispatched on `window` when the visitor does something an account would keep. */
export const ACCOUNT_MOMENT_EVENT = "apex:account-moment";
export const MIN_VISIT_DAYS = 3;

/** Enough to know "three or more" without keeping a browsing diary. */
const MAX_STORED_DAYS = 10;

/** A real calendar date: `new Date("2026-02-31")` would roll over to March. */
function isCalendarDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Note that the visitor is here today, and return how many distinct days they
 * have visited (including today, at most ten).
 *
 * Days are UTC dates, stored as a sorted JSON array. A missing, unreadable or
 * hostile value counts as no history and is overwritten; storage that throws
 * (private windows, blocked site data) counts as a first visit rather than an
 * error, which errs on the side of not interrupting anyone.
 */
export function recordVisitDay(
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  now: Date
): number {
  const today = now.toISOString().slice(0, 10);

  let days: string[] = [];
  if (storage) {
    try {
      const parsed: unknown = JSON.parse(storage.getItem(VISIT_DAYS_KEY) ?? "[]");
      if (Array.isArray(parsed)) days = parsed.filter(isCalendarDay);
    } catch {
      days = [];
    }
  }

  days = [...new Set([...days, today])].sort().slice(-MAX_STORED_DAYS);

  if (storage) {
    try {
      storage.setItem(VISIT_DAYS_KEY, JSON.stringify(days));
    } catch {
      // Over quota or blocked: the count is still right for this visit.
    }
  }
  return days.length;
}

/** Pages where a prompt is never right, whatever the visitor has done. */
const QUIET_PREFIXES = ["/signin", "/account", "/watch/"];

export function isQuietPath(pathname: string): boolean {
  return QUIET_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function shouldOfferOneTap(input: {
  visitDays: number;
  hadMoment: boolean;
  pathname: string;
}): boolean {
  if (isQuietPath(input.pathname)) return false;
  return input.hadMoment || input.visitDays >= MIN_VISIT_DAYS;
}

/** Tell the One Tap component the visitor just did something worth saving. */
export function signalAccountMoment(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ACCOUNT_MOMENT_EVENT));
}
