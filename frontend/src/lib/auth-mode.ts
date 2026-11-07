/**
 * Small, DOM-free pieces of the /signin page, kept here so they can be unit
 * tested in the node test environment (see vitest.config.ts).
 */

export type AuthMode = "signin" | "signup";

export const AUTH_MODES: readonly AuthMode[] = ["signin", "signup"];

/** `?mode=signup` deep-links the "Create account" tab; anything else is sign-in. */
export function parseAuthMode(value: string | string[] | null | undefined): AuthMode {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.trim().toLowerCase() === "signup" ? "signup" : "signin";
}

/**
 * The `/signin` URL for a mode, keeping the other query parameters (`next`,
 * but not a stale `error`, which belongs to the attempt that produced it).
 */
export function authModeHref(mode: AuthMode, search: string): string {
  const params = new URLSearchParams(search);
  params.delete("error");
  if (mode === "signup") params.set("mode", "signup");
  else params.delete("mode");
  const query = params.toString();
  return `/signin${query ? `?${query}` : ""}`;
}

/**
 * Roving focus for a horizontal tablist (WAI-ARIA APG "Tabs"): Left/Right
 * wrap, Home/End jump. `null` for keys the tablist does not handle.
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Better Auth refuses a sign-in started from an origin it does not trust with
 * a 403 ("Invalid origin"). That is almost always "this page was opened on a
 * different hostname than the one sign-in is registered for" — say so, and
 * point at the address that works, instead of a generic "try again" that
 * fails identically every time.
 */
export function isOriginRejection(error: { status?: number; message?: string; code?: string } | null | undefined): boolean {
  if (!error || error.status !== 403) return false;
  const text = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  // Every 403 the sign-in endpoints return is an origin/CSRF refusal today;
  // match on the wording too so an unrelated future 403 is not mislabelled.
  return text.includes("origin") || text.includes("csrf") || text.trim() === "";
}

export function originRejectionMessage(canonicalUrl: string | null | undefined): string {
  const host = (() => {
    try {
      return canonicalUrl ? new URL(canonicalUrl).host : null;
    } catch {
      return null;
    }
  })();
  return host
    ? `Sign-in only works on APEX's main address, ${host}. This page was opened on a different one — open sign-in there and try again.`
    : "Sign-in was refused because this page was opened on an address APEX doesn't sign in from. Open the site's main address and try again.";
}
