/**
 * The public origin to put in links that leave the site (calendar events,
 * reminder emails).
 *
 * `BETTER_AUTH_URL` first: production sets it to the canonical Cloud Run
 * hostname, and a link in an email must not depend on which of Cloud Run's
 * two hostnames — or which internal address, for the scheduler's request —
 * happened to deliver the request that generated it. The request's own
 * origin is the fallback for local development.
 */
export function publicSiteUrl(request?: Request, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BETTER_AUTH_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (request) {
    const url = new URL(request.url);
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (host) return `${proto || url.protocol.replace(/:$/, "")}://${host}`;
    return url.origin;
  }
  return "http://localhost:3105";
}
