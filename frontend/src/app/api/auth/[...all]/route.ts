import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { AUTH_COLLECTIONS, getAuthDb, isAuthConfigured } from "@/lib/auth-db";
import { hashMagicLinkToken, magicLinkIdentifier } from "@/lib/auth-magic-link";

/**
 * Better Auth's catch-all: sign-in, sign-out, session reads, the Google
 * callback, magic-link verification, profile updates and account linking all
 * arrive here under `/api/auth/*`.
 *
 * Two things are added in front of the library's handler.
 *
 * 1. An unconfigured deployment answers 404. Every account surface on the
 *    client reads `/api/auth/get-session` to decide whether to render, and a
 *    404 there is how a build without secrets stays the site it was before
 *    accounts existed, rather than showing a Sign-in button that cannot work.
 *
 * 2. Expired magic links are recognised before the library sees them. See
 *    `auth-magic-link.ts`: the library reports expired and already-used
 *    links identically, and they deserve different advice.
 */
export const dynamic = "force-dynamic";

function notConfigured() {
  return NextResponse.json({ error: "accounts_unavailable" }, { status: 404 });
}

async function redirectIfExpiredMagicLink(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/magic-link/verify")) return null;
  const token = url.searchParams.get("token");
  if (!token) return null;

  const identifier = magicLinkIdentifier(await hashMagicLinkToken(token));
  const verifications = getAuthDb().collection(AUTH_COLLECTIONS.verifications);
  const row = await verifications.findOne({ identifier });
  if (!row || !(row.expiresAt instanceof Date) || row.expiresAt.getTime() > Date.now()) {
    return null;
  }
  // Delete it as the library would, so the link cannot be retried into a
  // different answer later.
  await verifications.deleteOne({ _id: row._id });
  // Always our own page, never the link's `errorCallbackURL`: that value
  // came from the URL, and redirecting to it unchecked would be an open
  // redirect.
  return NextResponse.redirect(new URL("/signin?error=EXPIRED_TOKEN", process.env.BETTER_AUTH_URL || url.origin), 302);
}

async function handle(request: Request): Promise<Response> {
  if (!isAuthConfigured()) return notConfigured();
  if (request.method === "GET") {
    const expired = await redirectIfExpiredMagicLink(request);
    if (expired) return expired;
  }
  return getAuth().handler(request);
}

export const GET = handle;
export const POST = handle;
