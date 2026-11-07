/**
 * One public hostname for the whole site.
 *
 * Cloud Run answers on two URLs for the same service: the short hashed form
 * (`f1-frontend-<hash>-el.a.run.app`) and the project-number form
 * (`f1-frontend-<number>.<region>.run.app`). Only one of them is
 * `BETTER_AUTH_URL`, and Better Auth refuses to start a sign-in from any
 * other origin (403, "Invalid origin") — a visitor who arrived on the other
 * hostname saw "Google sign-in couldn't start" with nothing they could do
 * about it. The Google OAuth client, too, has exactly one registered origin.
 *
 * So every page request on a non-canonical Cloud Run hostname is sent, with
 * its path and query intact, to the canonical one. Rules:
 *
 *   - Driven only by `BETTER_AUTH_URL`; nothing here names a hostname, so
 *     switching the canonical address is an env change, not a code change.
 *   - Only `*.run.app` hosts are ever redirected. localhost, preview hosts and
 *     a future custom domain are left alone.
 *   - `/api/*` is never redirected. Every browser call to the API comes from a
 *     page that has already been moved to the canonical host, so the only
 *     callers left on the other hostname are machines — Cloud Scheduler on
 *     `/api/reminders/dispatch` (which signs its OIDC token for the URL it
 *     calls and does not follow redirects), calendar apps polling the `.ics`
 *     feed, and unsubscribe links in emails already sent. Changing what they
 *     get back would only break them.
 *   - 308, so a stray POST keeps its method and body.
 */

/** Paths that are left alone on every host. */
export function isExemptPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * The URL to redirect to, or `null` to serve the request as-is.
 *
 * `host` is the request's Host header (it may carry a port); `pathAndQuery`
 * is the path plus the search string, e.g. `/signin?mode=signup`.
 */
export function canonicalRedirectUrl(
  host: string | null | undefined,
  pathAndQuery: string,
  canonical: string | null | undefined,
): string | null {
  if (!host || !canonical?.trim()) return null;

  let target: URL;
  try {
    target = new URL(canonical.trim());
  } catch {
    return null;
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") return null;

  const requestHost = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!requestHost.endsWith(".run.app")) return null;
  if (requestHost === target.hostname.toLowerCase()) return null;

  const path = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  // Protocol-relative paths (`//evil.example`) must not become a new host.
  const safePath = path.replace(/^\/{2,}/, "/");
  if (isExemptPath(safePath.split("?")[0])) return null;

  return `${target.origin}${safePath}`;
}
