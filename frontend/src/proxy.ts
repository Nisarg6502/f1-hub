import { NextResponse, type NextRequest } from "next/server";
import { canonicalRedirectUrl } from "@/lib/canonical-host";

/**
 * Sends page requests on a non-canonical Cloud Run hostname to
 * `BETTER_AUTH_URL`'s host. See `lib/canonical-host.ts` for the rules and
 * why `/api/*` is exempt.
 *
 * Reads `BETTER_AUTH_URL` per request (Proxy runs on the Node.js runtime), so
 * the canonical host is the container's runtime value, not a build-time one.
 */
export function proxy(request: NextRequest) {
  const target = canonicalRedirectUrl(
    request.headers.get("host"),
    request.nextUrl.pathname + request.nextUrl.search,
    process.env.BETTER_AUTH_URL,
  );
  if (!target) return NextResponse.next();
  return NextResponse.redirect(target, 308);
}

export const config = {
  // Not the API (machine callers; see lib/canonical-host.ts) and not build
  // assets, which only a page already on this host would ask for.
  matcher: ["/((?!api(?:/|$)|_next/static|_next/image).*)"],
};
